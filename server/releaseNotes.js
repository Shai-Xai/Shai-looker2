// ─── Release notes: daily product changelog (Admin → Product) ──────────────────
// Disposable routes-module: owns its /api/admin/release-notes routes, the
// commit-history reader, the AI draft generator, and the hourly auto-draft tick
// (kill switch: settings key 'release_notes_auto'). Pairs with
// server/releaseNotesSeed.js. Remove the mount() line in index.js + this file to
// uninstall.
//
// COMMIT SOURCE: the GitHub API (via server/github.js — same token as the ticket
// bridge) is the source of truth. The deployed clone's git history is SHALLOW at
// runtime on Render, so a local `git log` sees only a commit or two — that's how
// early drafts ended up covering one commit out of a 190-commit day. Local git
// remains the fallback for environments without a GitHub token (e.g. local dev).
//
// DRAFTS REFRESH THEMSELVES: an UNPUBLISHED, UNEDITED auto-draft whose day has
// since gained commits (newest sha moved) is re-drafted on the hourly tick, so
// today's note stays current until someone publishes it. Publishing a note — or
// editing it (content edits flip source to 'manual') — freezes it forever; the
// generator never touches published or human-edited notes.
const { serverError } = require('./http'); // sanitized 500s: logs full detail, client gets a generic message
const path = require('path');
const { execFile } = require('child_process');

const RELEASE_TZ = 'Africa/Johannesburg'; // GMT+2, matches the scheduler's default
const dayInTz = (iso, tz = RELEASE_TZ) => {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(iso ? new Date(iso) : new Date()); } catch { return String(iso || '').slice(0, 10); }
};

// Surface any "how-to:" / "link:" trailer to the model, inline under the subject.
const withTrailers = (subject, body) => {
  const trailers = String(body || '').split('\n').map((l) => l.trim()).filter((l) => /^(how-to|link)\s*:/i.test(l));
  return String(subject || '').trim() + trailers.map((t) => `\n  ${t}`).join('');
};

// Group API commits (newest first) into calendar days in the release timezone.
// Returns [{ date, sha (newest that day), commits: [subject + trailers] }].
function groupCommitsByDay(commits, tz = RELEASE_TZ) {
  const byDay = new Map();
  for (const c of commits || []) {
    if (!c || !c.subject) continue;
    const date = dayInTz(c.date, tz);
    if (!byDay.has(date)) byDay.set(date, { date, sha: c.sha, commits: [] }); // first seen = newest that day
    byDay.get(date).commits.push(withTrailers(c.subject, c.body));
  }
  return [...byDay.values()];
}

// Decide what the generator should do for each commit-day, given the existing
// notes. Pure (unit-tested). A day with NO note → create. A day whose note is
// an UNPUBLISHED auto-draft with a MOVED newest-sha → refresh, unless the note
// was touched within `minAgeMs` (deploy-storm damper) — published or manually
// edited notes are never touched.
function planDrafts({ commitDays, notes, minAgeMs = 0, now = Date.now() }) {
  const byDate = new Map((notes || []).map((n) => [n.date, n]));
  const create = []; const refresh = [];
  for (const d of commitDays || []) {
    const n = byDate.get(d.date);
    if (!n) { create.push(d); continue; }
    if (n.published || n.source !== 'auto' || !d.sha || n.lastSha === d.sha) continue;
    const touched = Date.parse(n.updatedAt || n.createdAt || 0) || 0;
    if (now - touched < minAgeMs) continue;
    refresh.push({ day: d, note: n });
  }
  return { create, refresh };
}

module.exports.mount = function mountReleaseNotes(app, { db, auth, insights, adminAnthropicKey, getGithub }) {
  app.get('/api/admin/release-notes', auth.requireAdmin, (_req, res) => res.json(db.listReleaseNotes()));
  app.post('/api/admin/release-notes', auth.requireAdmin, (req, res) => res.status(201).json(db.createReleaseNote(req.body || {})));
  app.put('/api/admin/release-notes/:id', auth.requireAdmin, (req, res) => {
    const b = req.body || {};
    const n = db.updateReleaseNote(req.params.id, b);
    if (!n) return res.status(404).json({ error: 'Release note not found' });
    // A content edit makes the note human-owned: flip source to 'manual' so the
    // auto-refresher never overwrites an admin's wording. (A bare publish/unpublish
    // toggle doesn't count — that's governance, not authorship.)
    if (['title', 'body', 'howTo', 'bodyDev', 'deepLink', 'date'].some((k) => b[k] !== undefined) && n.source === 'auto') {
      db.db.prepare(`UPDATE release_notes SET source='manual' WHERE id=?`).run(n.id);
      return res.json(db.getReleaseNote(n.id));
    }
    res.json(n);
  });
  app.delete('/api/admin/release-notes/:id', auth.requireAdmin, (req, res) => { db.deleteReleaseNote(req.params.id); res.status(204).end(); });

  // Local-git fallback reader (dev machines with a real clone). Same shape as
  // groupCommitsByDay. Skips merge commits.
  const REPO_ROOT = path.join(__dirname, '..');
  function localCommitsByDay(days) {
    return new Promise((resolve, reject) => {
      const since = `${Math.max(1, Math.min(90, days))} days ago`;
      // %x1e (record sep) starts each commit; %x1f (unit sep) splits fields; %b is the body.
      const args = ['log', '--no-merges', `--since=${since}`, '--date=short', '--pretty=format:%x1e%cd%x1f%h%x1f%s%x1f%b'];
      execFile('git', args, { cwd: REPO_ROOT, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(new Error('Could not read git history in this environment.'));
        const byDay = new Map();
        for (const rec of String(stdout || '').split('\x1e')) {
          if (!rec.trim()) continue;
          const [date, sha, subject, body = ''] = rec.split('\x1f');
          if (!date || !subject) continue;
          if (!byDay.has(date)) byDay.set(date, { date, sha, commits: [] });
          byDay.get(date).commits.push(withTrailers(subject, body));
        }
        resolve([...byDay.values()]);
      });
    });
  }

  // Read recent commits grouped by calendar day (most recent day first) — GitHub
  // API first (complete + current), local git as the fallback.
  async function recentCommitsByDay(days = 14) {
    const n = Math.max(1, Math.min(90, Number(days) || 14));
    const gh = getGithub && getGithub();
    if (gh && gh.isConfigured()) {
      const sinceIso = new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
      return groupCommitsByDay(await gh.listCommits({ sinceIso }));
    }
    return localCommitsByDay(n);
  }

  // Draft/refresh release notes from the recent commits. Each day gets its OWN
  // model call (a 190-commit day deserves its own token budget, and most runs
  // only have one day to do). New notes are unpublished drafts; refreshes only
  // ever touch unpublished, unedited auto-drafts (see planDrafts). `force`
  // (the admin Generate button) ignores the deploy-storm age damper.
  async function generateReleaseNoteDrafts(days = 14, { force = false } = {}) {
    const apiKey = adminAnthropicKey();
    if (!insights.isConfigured(apiKey)) return { created: 0, refreshed: 0, items: [], message: 'AI not configured.' };
    const commitDays = await recentCommitsByDay(days);
    const plan = planDrafts({ commitDays, notes: db.listReleaseNotes(), minAgeMs: force ? 0 : 45 * 60 * 1000 });
    if (!plan.create.length && !plan.refresh.length) {
      return { created: 0, refreshed: 0, items: [], message: commitDays.length ? 'Release notes already cover every day with commits.' : 'No recent commits found.' };
    }
    const summariseDay = async (d) => {
      const out = await insights.summariseReleaseNotes({ days: [d], apiKey, instructions: db.getSetting('ai_instructions'), featureMap: db.getSetting('release_feature_map') });
      return (out || []).find((s) => s && s.date === d.date) || (out || [])[0] || null;
    };
    const created = []; let refreshed = 0;
    for (const d of plan.create) {
      const s = await summariseDay(d);
      if (!s) continue;
      created.push(db.createReleaseNote({
        date: d.date, title: s.title || '', body: s.summary || s.body || '', howTo: s.howTo || '',
        bodyDev: s.dev || '', deepLink: s.deepLink || '', published: false, source: 'auto', lastSha: d.sha || '',
      }));
    }
    const upd = db.db.prepare(`UPDATE release_notes SET title=?, body=?, how_to=?, body_dev=?, deep_link=?, last_sha=?, updated_at=? WHERE id=? AND published=0 AND source='auto'`);
    for (const { day, note } of plan.refresh) {
      const s = await summariseDay(day);
      if (!s) continue;
      refreshed += upd.run(s.title || '', s.summary || s.body || '', s.howTo || '', s.dev || '', s.deepLink || '', day.sha || '', new Date().toISOString(), note.id).changes;
    }
    return { created: created.length, refreshed, items: created };
  }
  app.post('/api/admin/release-notes/generate', auth.requireAdmin, async (req, res) => {
    if (!insights.isConfigured(adminAnthropicKey())) return res.status(400).json({ error: 'Set an Anthropic API key in Admin → Integrations to auto-generate release notes.' });
    try {
      res.json(await generateReleaseNoteDrafts(Number(req.body?.days) || 14, { force: true }));
    } catch (err) {
      console.error('[release-notes/generate]', err.message);
      serverError(res, err);
    }
  });

  // The hourly tick: keeps drafts existing AND current with no button press —
  // today's draft appears once today has commits and re-drafts itself as more
  // land (never after it's published or edited; 45-min damper between refreshes
  // of the same note so deploy storms don't churn AI calls). Drafts only — an
  // admin still reviews + publishes (governance, see the spec).
  // Kill switch: settings key `release_notes_auto` ('0' disables it).
  async function releaseNotesTick() {
    try {
      if (db.getSetting('release_notes_auto', '1') === '0') return; // disabled
      if (!insights.isConfigured(adminAnthropicKey())) return;      // needs AI
      const r = await generateReleaseNoteDrafts(7);
      if (r.created || r.refreshed) console.log(`[release-notes] auto-draft: ${r.created} new, ${r.refreshed} refreshed — awaiting review`);
    } catch (e) { console.error('[release-notes] tick failed:', e.message); }
  }
  const releaseNotesTimer = setInterval(() => releaseNotesTick().catch(() => {}), 60 * 60 * 1000); // hourly
  if (releaseNotesTimer.unref) releaseNotesTimer.unref();
  setTimeout(() => releaseNotesTick().catch(() => {}), 15000); // shortly after boot
};

// Pure helpers exposed for tests.
module.exports.groupCommitsByDay = groupCommitsByDay;
module.exports.planDrafts = planDrafts;
