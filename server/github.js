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

const TOKEN_KEY = 'github_token';
const REPO_KEY = 'github_repo';
const REPO_RE = /^[^/\s]+\/[^/\s]+$/; // owner/name

function mount(app, { db, auth }) {
  const token = () => (db.getSetting(TOKEN_KEY, '') || process.env.GITHUB_TOKEN || '').trim();
  const repo = () => (db.getSetting(REPO_KEY, '') || process.env.GITHUB_REPO || '').trim();
  const isConfigured = () => !!token() && REPO_RE.test(repo());
  const mask = (t) => (t ? `${'•'.repeat(Math.min(8, Math.max(0, t.length - 4)))}${t.slice(-4)}` : '');
  // Auto-dispatch: when on, issues Pulse creates include an @claude mention so the
  // Claude Code GitHub Action picks the ticket up and opens a PR. Off by default —
  // needs the Claude GitHub App + ANTHROPIC_API_KEY secret + the claude.yml workflow.
  const dispatchEnabled = () => db.getSetting('github_dispatch_claude', '0') === '1';
  const config = () => ({ repo: repo(), tokenSet: !!token(), tokenMask: mask(token()), configured: isConfigured(), dispatchClaude: dispatchEnabled() });

  // Admin: read/write the connection (token is write-only — a blank token keeps the
  // existing one; { clearToken:true } removes it).
  app.get('/api/admin/github', auth.requireAdmin, (_req, res) => res.json(config()));
  app.put('/api/admin/github', auth.requireAdmin, (req, res) => {
    const b = req.body || {};
    if (b.repo !== undefined) db.setSetting(REPO_KEY, String(b.repo || '').trim());
    if (b.dispatchClaude !== undefined) db.setSetting('github_dispatch_claude', b.dispatchClaude ? '1' : '0');
    if (b.clearToken) db.setSetting(TOKEN_KEY, '');
    else if (b.token) db.setSetting(TOKEN_KEY, String(b.token).trim());
    res.json(config());
  });

  // Create an issue in the configured repo. Returns { number, url }; throws on
  // misconfig (code NO_GITHUB) or an API error (message carries GitHub's reason).
  async function createIssue({ title, body, labels }) {
    if (!isConfigured()) { const e = new Error('GitHub is not configured (set a token + repo in Admin).'); e.code = 'NO_GITHUB'; throw e; }
    const resp = await fetch(`https://api.github.com/repos/${repo()}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token()}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'HowlerPulse',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        title: String(title || 'Untitled ticket').slice(0, 250),
        body: String(body || ''),
        ...(Array.isArray(labels) && labels.length ? { labels } : {}),
      }),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`GitHub issue creation failed (${resp.status})${txt ? `: ${txt.slice(0, 200)}` : ''}`);
    }
    const data = await resp.json();
    return { number: data.number, url: data.html_url };
  }

  // A token-free prefilled "new issue" URL (opened in the user's browser). Empty
  // string when no repo is set — the caller then asks the admin to configure one.
  function newIssueUrl({ title, body }) {
    if (!REPO_RE.test(repo())) return '';
    const q = new URLSearchParams({ title: String(title || '').slice(0, 250), body: String(body || '').slice(0, 6000) });
    return `https://github.com/${repo()}/issues/new?${q.toString()}`;
  }

  console.log('[github] issue bridge mounted', isConfigured() ? '(configured)' : '(needs token + repo)');
  return { isConfigured, createIssue, newIssueUrl, repo, dispatchEnabled };
}

module.exports = { mount };
