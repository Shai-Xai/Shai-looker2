// ─── App version — SELF-CONTAINED, DISPOSABLE MODULE ───────────────────────────
// One tiny endpoint telling the app what build it's running, shown in the
// bottom-left profile footer so support can always ask "what version are you on?".
// Resolved ONCE at boot: git commit (the deploy unit — Render deploys main) via the
// local repo, falling back to Render's RENDER_GIT_COMMIT env, else 'dev'. The label
// is date+hash (e.g. "2026.07.02 · c16feaa") — chronology at a glance, exactness
// when it matters. Remove the mount line + this file to uninstall.
const { execFileSync } = require('child_process');

function readGit(args) {
  try { return execFileSync('git', args, { encoding: 'utf8', timeout: 3000 }).trim(); } catch { return ''; }
}

function resolve() {
  const hash = readGit(['rev-parse', '--short=7', 'HEAD']) || String(process.env.RENDER_GIT_COMMIT || '').slice(0, 7) || 'dev';
  const commitIso = readGit(['show', '-s', '--format=%cI', 'HEAD']) || null;
  const when = commitIso ? new Date(commitIso) : new Date(); // env fallback: boot time ≈ deploy time
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${when.getUTCFullYear()}.${pad(when.getUTCMonth() + 1)}.${pad(when.getUTCDate())}`;
  return { version: `${stamp} · ${hash}`, commit: hash, committedAt: commitIso, startedAt: new Date().toISOString() };
}

function mount(app, { auth }) {
  const info = resolve(); // once at boot — the running process IS one build
  app.get('/api/version', auth.requireAuth, (_req, res) => res.json(info));
  console.log(`[version] ${info.version} mounted`);
  return info;
}

module.exports = { mount, resolve };
