import { useEffect, useState } from 'react';
import OwlChat from '../components/OwlChat.jsx';
import { api } from '../lib/api.js';

// ─── /embed/owl — the chromeless Owl for the Howler organizer portal ──────────
// Served inside an iframe on the portal (docs/OWL_EMBED.md). There is NO cookie
// session here — inside a cross-site iframe the sameSite session cookie is never
// sent — so the short-lived token minted by POST /api/embed/owl/session arrives
// in the URL fragment (#token=…, never sent to servers/logs) and is attached to
// every API call as an Authorization header by the fetch patch below. The rest
// of api.js then works completely unchanged.
//
// Mobile-first by construction: the portal's panel/iframe is the viewport, and
// OwlChat's embed mode renders one full-bleed column.

const TOKEN_KEY = 'howler_owl_embed_token';
let patched = false;
function installEmbedAuth(token) {
  try { sessionStorage.setItem(TOKEN_KEY, token); } catch { /* storage blocked — the in-memory patch below still works */ }
  installEmbedAuth.token = token;
  if (patched) return;
  patched = true;
  const orig = window.fetch.bind(window);
  window.fetch = (url, opts = {}) => {
    const u = typeof url === 'string' ? url : (url && url.url) || '';
    if (u.startsWith('/api/')) {
      let t = installEmbedAuth.token;
      try { t = sessionStorage.getItem(TOKEN_KEY) || t; } catch { /* use in-memory */ }
      if (t) opts = { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${t}` } };
    }
    return orig(url, opts);
  };
}

const EXPIRED = 'This Owl session has expired — close and reopen it from the Howler portal.';

export default function OwlEmbedPage() {
  const [state, setState] = useState({ loading: true, error: '', me: null, events: [] });

  useEffect(() => {
    const m = /[#&]token=([^&]+)/.exec(window.location.hash || '');
    let token = m ? decodeURIComponent(m[1]) : '';
    if (!token) { try { token = sessionStorage.getItem(TOKEN_KEY) || ''; } catch { /* ignore */ } }
    if (!token) { setState({ loading: false, error: 'No session — open the Owl from the Howler portal.' }); return; }
    // Drop the fragment from the address bar (cosmetic; the iframe src still holds it for reloads).
    if (m) { try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch { /* ignore */ } }
    installEmbedAuth(token);
    (async () => {
      try {
        const r = await api.me();
        if (!r || !r.user) throw new Error('expired');
        let events = [];
        try {
          const suites = await api.mySuites();
          events = (Array.isArray(suites) ? suites : suites.suites || []).map((s) => ({ id: s.id, name: s.name, entityId: s.entityId, onSale: !!s.onSale, hasGoals: !!s.hasGoals }));
        } catch { /* the event picker just stays empty */ }
        setState({ loading: false, error: '', me: r.user, events });
      } catch {
        setState({ loading: false, error: EXPIRED, me: null, events: [] });
      }
    })();
    // The mint-side TTL is fixed (2h) — swap to the friendly expiry note when it lapses,
    // rather than letting the next question fail with a raw 401.
    const expiry = setTimeout(() => setState((s) => (s.me ? { ...s, me: null, error: EXPIRED } : s)), 2 * 60 * 60 * 1000);
    return () => clearTimeout(expiry);
  }, []);

  if (state.loading) {
    return <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: 14 }}>🦉 Waking the Owl…</div>;
  }
  if (state.error || !state.me) {
    return (
      <div style={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24, textAlign: 'center' }}>
        <span style={{ fontSize: 34 }}>🦉</span>
        <p style={{ margin: 0, color: 'var(--text)', fontSize: 14.5, maxWidth: 420, lineHeight: 1.5 }}>{state.error || EXPIRED}</p>
      </div>
    );
  }

  const entity = (state.me.entities || [])[0];
  return (
    <OwlChat
      embed
      open
      onClose={() => {}}
      entityId={entity ? entity.id : ''}
      clients={entity ? [{ id: entity.id, name: entity.name }] : []}
      events={state.events}
      isAdmin={false}
    />
  );
}
