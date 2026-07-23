// ─── GitHub issue bridge ───────────────────────────────────────────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Lets the app turn a product ticket into a
// GitHub issue in a configured repo, so build work is tracked where the code lives
// (and where Claude / CI can pick it up). Mounted from index.js with one line.
// To remove: delete this file + that line; the ticket link columns are harmless.
//
// The token is WRITE-ONLY (responses report set + a mask, never the value), like
// the other secrets. When it isn't configured the module still hands back a
// prefilled "new issue" URL so the browser (already logged into GitHub) can file
// one manually — the feature stays useful with zero server credentials.

const crypto = require('crypto');

const TOKEN_KEY = 'github_token';
const REPO_KEY = 'github_repo';
const WEBHOOK_KEY = 'github_webhook_secret';
const STAGING_KEY = 'github_staging_branch';
const STAGING_URL_KEY = 'github_staging_url';
const PROD_KEY = 'github_production_branch';
const REPO_RE = /^[^/\s]+\/[^/\s]+$/; // owner/name

function mount(app, { db, auth }) {
  const token = () => (db.getSetting(TOKEN_KEY, '') || process.env.GITHUB_TOKEN || '').trim();
  const repo = () => (db.getSetting(REPO_KEY, '') || process.env.GITHUB_REPO || '').trim();
  const isConfigured = () => !!token() && REPO_RE.test(repo());
  const mask = (t) => (t ? `${'•'.repeat(Math.min(8, Math.max(0, t.length - 4)))}${t.slice(-4)}` : '');
  // Two-environment deploy: the staging branch auto-deploys to the staging Render
  // service; the production branch (main) deploys to production. A ticket can be
  // built into either; "promote" opens a staging→production release PR. Both are
  // just branch names — override them here if the repo uses different conventions.
  const stagingBranch = () => (db.getSetting(STAGING_KEY, '') || 'staging').trim();
  const stagingUrl = () => (db.getSetting(STAGING_URL_KEY, '') || '').trim(); // the staging site — reporters test here
  const prodBranch = () => (db.getSetting(PROD_KEY, '') || 'main').trim();
  // Auto-dispatch: when on, issues Pulse creates include an @claude mention so the
  // Claude Code GitHub Action picks the ticket up and opens a PR. Off by default —
  // needs the Claude GitHub App + ANTHROPIC_API_KEY secret + the claude.yml workflow.
  const dispatchEnabled = () => db.getSetting('github_dispatch_claude', '0') === '1';
  // Webhook secret (write-only): lets Pulse verify GitHub PR events so a merged PR
  // can auto-Ship the linked ticket. Verified with HMAC-SHA256 over the raw body.
  const webhookSecret = () => (db.getSetting(WEBHOOK_KEY, '') || process.env.GITHUB_WEBHOOK_SECRET || '').trim();
  function verifyWebhook(rawBuf, signature) {
    const secret = webhookSecret();
    if (!secret || !signature) return false;
    const mac = `sha256=${crypto.createHmac('sha256', secret).update(rawBuf).digest('hex')}`;
    try { return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(String(signature))); } catch { return false; }
  }
  const config = () => ({ repo: repo(), tokenSet: !!token(), tokenMask: mask(token()), configured: isConfigured(), dispatchClaude: dispatchEnabled(), webhookSecretSet: !!webhookSecret(), stagingBranch: stagingBranch(), stagingUrl: stagingUrl(), prodBranch: prodBranch() });

  // Admin: read/write the connection (token is write-only — a blank token keeps the
  // existing one; { clearToken:true } removes it).
  app.get('/api/admin/github', auth.requireAdmin, (_req, res) => res.json(config()));
  app.put('/api/admin/github', auth.requireAdmin, (req, res) => {
    const b = req.body || {};
    if (b.repo !== undefined) db.setSetting(REPO_KEY, String(b.repo || '').trim());
    if (b.dispatchClaude !== undefined) db.setSetting('github_dispatch_claude', b.dispatchClaude ? '1' : '0');
    if (b.stagingBranch !== undefined) db.setSetting(STAGING_KEY, String(b.stagingBranch || '').trim());
    if (b.stagingUrl !== undefined) db.setSetting(STAGING_URL_KEY, String(b.stagingUrl || '').trim());
    if (b.prodBranch !== undefined) db.setSetting(PROD_KEY, String(b.prodBranch || '').trim());
    if (b.clearToken) db.setSetting(TOKEN_KEY, '');
    else if (b.token) db.setSetting(TOKEN_KEY, String(b.token).trim());
    if (b.clearWebhookSecret) db.setSetting(WEBHOOK_KEY, '');
    else if (b.webhookSecret) db.setSetting(WEBHOOK_KEY, String(b.webhookSecret).trim());
    res.json(config());
  });

  // One authenticated call to the repo's REST API. Never lets a stuck socket hang
  // the request path (15s abort). Returns the parsed Response for the caller to read.
  function ghFetch(pathname, { method = 'GET', payload } = {}) {
    return fetch(`https://api.github.com/repos/${repo()}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${token()}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'HowlerPulse',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
  }
  const needGithub = () => { if (!isConfigured()) { const e = new Error('GitHub is not configured (set a token + repo in Admin).'); e.code = 'NO_GITHUB'; throw e; } };

  // Create an issue in the configured repo. Returns { number, url }; throws on
  // misconfig (code NO_GITHUB) or an API error (message carries GitHub's reason).
  async function createIssue({ title, body, labels }) {
    needGithub();
    const resp = await ghFetch('/issues', { method: 'POST', payload: {
      title: String(title || 'Untitled ticket').slice(0, 250),
      body: String(body || ''),
      ...(Array.isArray(labels) && labels.length ? { labels } : {}),
    } });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`GitHub issue creation failed (${resp.status})${txt ? `: ${txt.slice(0, 200)}` : ''}`);
    }
    const data = await resp.json();
    return { number: data.number, url: data.html_url };
  }

  // Open (or reuse) the release PR that promotes everything on the staging branch
  // into production. Returns { number, url, created, nothingToPromote }. A 422 means
  // either the PR already exists (we look it up and return it) or there's no diff
  // (staging == production → nothing to promote). Never throws on those — they're
  // normal states the UI explains.
  async function openReleasePr({ title, body } = {}) {
    needGithub();
    const owner = repo().split('/')[0];
    const head = stagingBranch(), base = prodBranch();
    const resp = await ghFetch('/pulls', { method: 'POST', payload: {
      title: String(title || `Release: promote ${head} → ${base}`).slice(0, 250),
      body: String(body || ''), head, base,
    } });
    if (resp.ok) { const d = await resp.json(); return { number: d.number, url: d.html_url, created: true }; }
    if (resp.status === 422) {
      const ex = await ghFetch(`/pulls?state=open&head=${owner}:${head}&base=${base}`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
      if (Array.isArray(ex) && ex[0]) return { number: ex[0].number, url: ex[0].html_url, created: false };
      return { nothingToPromote: true }; // no commits between staging and production
    }
    const txt = await resp.text().catch(() => '');
    throw new Error(`Could not open release PR (${resp.status})${txt ? `: ${txt.slice(0, 200)}` : ''}`);
  }

  // Comment on an existing issue — the re-dispatch path: a sent-back ticket's
  // refreshed brief (+ @claude ask) rides an issue comment, so the Action picks
  // the rework up on the SAME issue instead of opening a duplicate.
  async function createIssueComment(issueNumber, body) {
    needGithub();
    const resp = await ghFetch(`/issues/${Number(issueNumber)}/comments`, { method: 'POST', payload: { body: String(body || '') } });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`GitHub comment failed (${resp.status})${txt ? `: ${txt.slice(0, 200)}` : ''}`);
    }
    return { url: (await resp.json()).html_url };
  }

  // A token-free prefilled "new issue" URL (opened in the user's browser). Empty
  // string when no repo is set — the caller then asks the admin to configure one.
  function newIssueUrl({ title, body }) {
    if (!REPO_RE.test(repo())) return '';
    const q = new URLSearchParams({ title: String(title || '').slice(0, 250), body: String(body || '').slice(0, 6000) });
    return `https://github.com/${repo()}/issues/new?${q.toString()}`;
  }

  // Recent commits from the GitHub API (newest first, merges skipped). This is the
  // release-notes drafter's source of truth: the deployed clone's git history is
  // SHALLOW at runtime, so a local `git log` sees almost nothing — the API always
  // has the full picture. Returns [{ sha, date: ISO, subject, body }].
  async function listCommits({ sinceIso, maxPages = 10 }) {
    if (!isConfigured()) { const e = new Error('GitHub is not configured (set a token + repo in Admin).'); e.code = 'NO_GITHUB'; throw e; }
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const q = new URLSearchParams({ since: sinceIso, per_page: '100', page: String(page) });
      const resp = await fetch(`https://api.github.com/repos/${repo()}/commits?${q.toString()}`, {
        headers: { Authorization: `Bearer ${token()}`, Accept: 'application/vnd.github+json', 'User-Agent': 'HowlerPulse', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) throw new Error(`GitHub commits read failed (${resp.status})`);
      const rows = await resp.json();
      if (!Array.isArray(rows)) break;
      for (const r of rows) {
        if ((r.parents || []).length > 1) continue; // merge commit
        const msg = String((r.commit && r.commit.message) || '');
        const nl = msg.indexOf('\n');
        out.push({
          sha: r.sha,
          date: (r.commit && ((r.commit.committer && r.commit.committer.date) || (r.commit.author && r.commit.author.date))) || '',
          subject: (nl === -1 ? msg : msg.slice(0, nl)).trim(),
          body: nl === -1 ? '' : msg.slice(nl + 1),
        });
      }
      if (rows.length < 100) break;
    }
    return out;
  }

  console.log('[github] issue bridge mounted', isConfigured() ? '(configured)' : '(needs token + repo)');
  // Read side for the Code health panel (server/codeHealth.js): find the rolling
  // review issue and pull its comments, so admins read the daily reports inside
  // Pulse instead of logging into GitHub.
  async function findOpenIssueByTitle(fragment) {
    const resp = await ghFetch('/issues?state=open&per_page=100');
    if (!resp.ok) throw new Error(`GitHub issues list failed (HTTP ${resp.status})`);
    const found = (await resp.json()).find((i) => !i.pull_request && String(i.title || '').includes(fragment));
    return found ? { number: found.number, title: found.title, url: found.html_url, body: found.body || '', updatedAt: found.updated_at } : null;
  }
  async function listIssueComments(issueNumber) {
    const resp = await ghFetch(`/issues/${Number(issueNumber)}/comments?per_page=100`);
    if (!resp.ok) throw new Error(`GitHub comments list failed (HTTP ${resp.status})`);
    return (await resp.json()).map((c) => ({ id: c.id, author: c.user?.login || '', body: c.body || '', url: c.html_url, createdAt: c.created_at }));
  }

  return { isConfigured, createIssue, createIssueComment, openReleasePr, newIssueUrl, listCommits, findOpenIssueByTitle, listIssueComments, repo, dispatchEnabled, verifyWebhook, stagingBranch, stagingUrl, prodBranch, webhookSecretSet: () => !!webhookSecret() };
}

module.exports = { mount };
