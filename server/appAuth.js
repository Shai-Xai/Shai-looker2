// ─── Howler-app identity for Pulse's app-facing APIs ─────────────────────────────
// SHARED FACTORY (not a routes module — see CLAUDE.md architecture notes): the
// community feed (server/social.js) and event chat (server/chat.js) both verify
// the phone's Howler login JWT the same way. Pulse holds no signing secret, so
// it INTROSPECTS: asks the Howler GraphQL backend "who is this token?"
// ({ user { id } }) — production first, then staging (override the list via
// HOWLER_GRAPHQL_URLS) — and caches verdicts. The verified id is the ONLY
// identity ever used; caller-supplied user ids are never trusted.

const { HttpError } = require('./http');

const HOWLER_GQLS = (process.env.HOWLER_GRAPHQL_URLS
  || 'production=https://api.howlerapp.com/api/v6/graphql,staging=https://www.howlerstaging.co.za/api/v6/graphql')
  .split(',').map((s) => { const [source, ...u] = s.split('='); return { source: source.trim(), url: u.join('=').trim() }; });

async function gqlWithToken(url, token, query, signal) {
  const r = await fetch(url, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query }),
  });
  return ((await r.json()) || {}).data?.user || null;
}

async function introspectOnBackend(url, token) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    // `{ user { id } }` is THE verification; the display name is a separate
    // best-effort read (schema fields may differ per backend version) so a
    // name-query error can never fail a valid token.
    const user = await gqlWithToken(url, token, '{ user { id } }', ctrl.signal);
    const id = String(user?.id || '').split('/').pop(); // "gid://howler/User/661779"
    if (!/^\d+$/.test(id)) return null;
    let name = '';
    try {
      const named = await gqlWithToken(url, token, '{ user { firstName lastName } }', ctrl.signal);
      name = [named?.firstName, named?.lastName].filter(Boolean).join(' ').trim();
    } catch { /* cosmetic only */ }
    return { id, name };
  } finally { clearTimeout(t); }
}

// token → { user, at } (positive, 10 min) or { neg: true, at } (negative, 60 s).
const TOKEN_CACHE = new Map();
const TOKEN_TTL_POS = 10 * 60_000, TOKEN_TTL_NEG = 60_000, TOKEN_CACHE_MAX = 2000;
async function defaultVerifyAppToken(token) {
  const hit = TOKEN_CACHE.get(token);
  if (hit && Date.now() - hit.at < (hit.neg ? TOKEN_TTL_NEG : TOKEN_TTL_POS)) return hit.neg ? null : hit.user;
  let user = null, failures = 0, lastErr = null;
  for (const { url } of HOWLER_GQLS) {
    try { user = await introspectOnBackend(url, token); if (user) break; }
    catch (e) { failures += 1; lastErr = e; }
  }
  // Every backend unreachable → we cannot KNOW the token is bad; fail closed
  // with a retryable error rather than caching a false negative.
  if (!user && failures >= HOWLER_GQLS.length) throw lastErr || new Error('token introspection failed');
  if (TOKEN_CACHE.size >= TOKEN_CACHE_MAX) TOKEN_CACHE.delete(TOKEN_CACHE.keys().next().value);
  TOKEN_CACHE.set(token, user ? { user, at: Date.now() } : { neg: true, at: Date.now() });
  return user;
}

// Request helpers bound to a verifier (tests inject a stub verifier).
function helpers(verifyAppToken = defaultVerifyAppToken) {
  // Resolve the verified Howler user for a request, or throw. 401 = no/bad
  // token (log in again); 503 = the Howler backend couldn't be reached to
  // verify (retryable — never treated as "invalid token").
  async function requireAppUser(req) {
    const m = String(req.headers?.authorization || '').match(/^Bearer\s+(.+)$/i);
    if (!m) throw new HttpError(401, 'Log in to the Howler app to do this');
    let user;
    try { user = await verifyAppToken(m[1]); }
    catch { throw new HttpError(503, 'Couldn’t verify your session right now — try again in a moment'); }
    if (!user) throw new HttpError(401, 'Your session has expired — log in to the Howler app again');
    return user;
  }
  // Anonymous-friendly variant for public reads: a valid token enriches the
  // response; no/invalid token just reads anonymously.
  async function optionalAppUser(req) {
    if (!/^Bearer\s+/i.test(String(req.headers?.authorization || ''))) return null;
    try { return await requireAppUser(req); } catch { return null; }
  }
  return { requireAppUser, optionalAppUser };
}

module.exports = { defaultVerifyAppToken, helpers };
