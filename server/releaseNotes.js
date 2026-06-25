// ─── Release notes: daily product changelog (Admin → Product) ──────────────────
// Disposable routes-module: owns its /api/admin/release-notes routes, the
// git-history reader, the AI draft generator, and the hourly auto-draft tick
// (kill switch: settings key 'release_notes_auto'). Pairs with
// server/releaseNotesSeed.js. Remove the mount() line in index.js + this file to
// uninstall. Lifted VERBATIM out of index.js — db/auth/insights and the admin AI
// key arrive as injected deps instead of module-level references.
const path = require('path');
const { execFile } = require('child_process');

module.exports.mount = function mountReleaseNotes(app, { db, auth, insights, adminAnthropicKey }) {
  app.get('/api/admin/release-notes', auth.requireAdmin, (_req, res) => res.json(db.listReleaseNotes()));
  app.post('/api/admin/release-notes', auth.requireAdmin, (req, res) => res.status(201).json(db.createReleaseNote(req.body || {})));
  app.put('/api/admin/release-notes/:id', auth.requireAdmin, (req, res) => {
    const n = db.updateReleaseNote(req.params.id, req.body || {});
    if (!n) return res.status(404).json({ error: 'Release note not found' });
    res.json(n);
  });
  app.delete('/api/admin/release-notes/:id', auth.requireAdmin, (req, res) => { db.deleteReleaseNote(req.params.id); res.status(204).end(); });

  // Read recent commits grouped by calendar day (most recent day first). Returns
  // [{ date, sha (newest that day), commits: [subject + any how-to:/link: trailers] }].
  // Skips merge commits.
  const REPO_ROOT = path.join(__dirname, '..');
  function recentCommitsByDay(days = 14) {
    return new Promise((resolve, reject) => {
      const since = `${Math.max(1, Math.min(90, days))} days ago`;
      // %x1e (record sep) starts each commit; %x1f (unit sep) splits fields; %b is the body,
      // mined for "how-to:" / "link:" trailers that ground the client how-to + deep link.
      const args = ['log', '--no-merges', `--since=${since}`, '--date=short', '--pretty=format:%x1e%cd%x1f%h%x1f%s%x1f%b'];
      execFile('git', args, { cwd: REPO_ROOT, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(new Error('Could not read git history in this environment.'));
        const byDay = new Map(); // date -> { date, sha, commits[] }
        for (const rec of String(stdout || '').split('\x1e')) {
          if (!rec.trim()) continue;
          const [date, sha, subject, body = ''] = rec.split('\x1f');
          if (!date || !subject) continue;
          // Surface any "how-to:" / "link:" trailer to the model, inline under the subject.
          const trailers = body.split('\n').map((l) => l.trim()).filter((l) => /^(how-to|link)\s*:/i.test(l));
          const line = subject.trim() + trailers.map((t) => `\n  ${t}`).join('');
          if (!byDay.has(date)) byDay.set(date, { date, sha, commits: [] }); // first record of a day = newest sha
          byDay.get(date).commits.push(line);
        }
        resolve([...byDay.values()]); // git log is newest-first, so insertion order = newest day first
      });
    });
  }

  // Auto-populate: summarise the last N days of commits into draft release notes.
  // Only fills days that don't already have a note (manual or auto) — never
  // clobbers edits. New entries are drafts (three lenses) for an admin to review.
  // Shared by the manual "Generate" button and the daily tick below.
  async function generateReleaseNoteDrafts(days = 14) {
    const apiKey = adminAnthropicKey();
    if (!insights.isConfigured(apiKey)) return { created: 0, items: [], message: 'AI not configured.' };
    const commitDays = await recentCommitsByDay(days);
    const have = new Set(db.listReleaseNotes().map((n) => n.date));
    const todo = commitDays.filter((d) => !have.has(d.date));
    if (todo.length === 0) {
      return { created: 0, items: [], message: commitDays.length ? 'Release notes already cover every day with commits.' : 'No recent commits found.' };
    }
    const summaries = await insights.summariseReleaseNotes({ days: todo, apiKey, instructions: db.getSetting('ai_instructions'), featureMap: db.getSetting('release_feature_map') });
    const shaForDate = Object.fromEntries(todo.map((d) => [d.date, d.sha]));
    const created = [];
    for (const s of summaries) {
      if (!s?.date || have.has(s.date)) continue; // guard against the model echoing a covered day
      created.push(db.createReleaseNote({
        date: s.date,
        title: s.title || '',
        body: s.summary || s.body || '', // `summary` is the end-user lens; fall back to `body` for resilience
        howTo: s.howTo || '',
        bodyDev: s.dev || '',
        deepLink: s.deepLink || '',
        published: false, source: 'auto', lastSha: shaForDate[s.date] || '',
      }));
    }
    return { created: created.length, items: created };
  }
  app.post('/api/admin/release-notes/generate', auth.requireAdmin, async (req, res) => {
    if (!insights.isConfigured(adminAnthropicKey())) return res.status(400).json({ error: 'Set an Anthropic API key in Admin → Integrations to auto-generate release notes.' });
    try {
      res.json(await generateReleaseNoteDrafts(Number(req.body?.days) || 14));
    } catch (err) {
      console.error('[release-notes/generate]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // "After each day": a once-per-local-day tick that auto-drafts notes for any
  // uncovered recent day, so generation no longer needs a button press. Drafts
  // only — an admin still reviews + publishes (governance, see the spec). The tick
  // fires hourly and self-guards via the `release_notes_last_auto` date marker.
  // Kill switch: settings key `release_notes_auto` ('0' disables it).
  const RELEASE_TZ = 'Africa/Johannesburg'; // GMT+2, matches the scheduler's default
  const localDateStr = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  async function dailyReleaseNotesTick() {
    try {
      if (db.getSetting('release_notes_auto', '1') === '0') return;          // disabled
      if (!insights.isConfigured(adminAnthropicKey())) return;              // needs AI
      const todayLocal = localDateStr(RELEASE_TZ);
      if (db.getSetting('release_notes_last_auto', '') === todayLocal) return; // already ran today
      const r = await generateReleaseNoteDrafts(7);
      db.setSetting('release_notes_last_auto', todayLocal);
      if (r.created) console.log(`[release-notes] auto-drafted ${r.created} day(s) — awaiting review`);
    } catch (e) { console.error('[release-notes] daily tick failed:', e.message); }
  }
  const releaseNotesTimer = setInterval(() => dailyReleaseNotesTick().catch(() => {}), 60 * 60 * 1000); // hourly
  if (releaseNotesTimer.unref) releaseNotesTimer.unref();
  setTimeout(() => dailyReleaseNotesTick().catch(() => {}), 15000); // shortly after boot
};
