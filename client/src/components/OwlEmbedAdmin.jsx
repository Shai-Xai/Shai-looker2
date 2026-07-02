import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

// ─── Organizer portal Owl (pilot) admin ───────────────────────────────────────
// Configure embedding the Owl inside the Howler organizer portal: the shared
// secret the portal's backend authenticates with, and the org → Pulse client
// links that decide which organizations get the Owl (and whose data it answers
// with). Server side: server/owlEmbed.js; integration guide: docs/OWL_EMBED.md.
export default function OwlEmbedAdmin() {
  const [cfg, setCfg] = useState(null);
  const [ents, setEnts] = useState([]);
  const [secret, setSecret] = useState('');
  const [saved, setSaved] = useState(false);
  const [saveErr, setSaveErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getOwlEmbed().then(setCfg).catch(() => setCfg({ enabled: false, secretSet: false, links: [] }));
    api.adminListEntities().then((r) => setEnts(Array.isArray(r) ? r : (r.entities || []))).catch(() => setEnts([]));
  }, []);
  if (!cfg) return <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p>;

  const setLink = (i, patch) => setCfg((c) => ({ ...c, links: c.links.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const addLink = () => setCfg((c) => ({ ...c, links: [...(c.links || []), { orgId: '', entityId: '' }] }));
  const delLink = (i) => setCfg((c) => ({ ...c, links: c.links.filter((_, j) => j !== i) }));

  const save = async () => {
    setBusy(true); setSaveErr(''); setSaved(false);
    try {
      const fresh = await api.saveOwlEmbed({
        enabled: !!cfg.enabled,
        links: (cfg.links || []).filter((l) => l.orgId && l.entityId).map((l) => ({ orgId: l.orgId, entityId: l.entityId })),
        ...(secret.trim() ? { secret: secret.trim() } : {}),
      });
      setCfg(fresh);
      setSecret('');
      setSaved(true); setTimeout(() => setSaved(false), 2500);
    } catch (e) { setSaveErr((e && e.message) || 'Save failed — your changes were NOT saved.'); }
    setBusy(false);
  };

  const fld = { padding: '6px 9px', borderRadius: 7, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 13, fontFamily: 'inherit' };
  const lbl = { display: 'block', fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--muted)', margin: '10px 0 2px' };
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const sessionUrl = `${origin}${cfg.sessionPath || '/api/embed/owl/session'}`;

  return (
    <div>
      <p style={{ fontSize: 12.5, color: 'var(--muted)', margin: '0 0 8px' }}>
        Embed the Owl inside the Howler organizer portal (the Inventive pattern, inverted — Pulse is the guest).
        The portal’s backend calls the session endpoint below with an organizer’s email + Howler organization id;
        Pulse creates/reuses an entity-scoped shadow login and returns a short-lived iframe URL. Only organizations
        linked to a Pulse client here get the Owl — everything stays scoped to that client’s data.
      </p>

      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13.5, fontWeight: 600, cursor: 'pointer' }}>
        <input type="checkbox" checked={!!cfg.enabled} onChange={(e) => setCfg((c) => ({ ...c, enabled: e.target.checked }))} style={{ width: 16, height: 16 }} />
        Enable the organizer-portal Owl embed
      </label>

      <span style={lbl}>1 · Session endpoint (the portal’s backend POSTs here, server-to-server)</span>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <code style={{ ...fld, flex: 1, overflow: 'auto', whiteSpace: 'nowrap' }}>{sessionUrl}</code>
        <button onClick={() => navigator.clipboard && navigator.clipboard.writeText(sessionUrl)} style={{ ...fld, cursor: 'pointer' }}>Copy</button>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>Full request/response contract for the portal team: <code>docs/OWL_EMBED.md</code>.</div>

      <span style={lbl}>2 · Shared secret {cfg.secretSet ? `(set ${cfg.secretHint || ''} — enter a new value to rotate)` : '(give this to the portal team; they send it as Authorization: Bearer …)'}</span>
      <input value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={cfg.secretSet ? '•••••• (unchanged)' : 'paste a strong random secret'} style={{ ...fld, width: 340 }} />

      <span style={lbl}>3 · Organization → client links (which Howler orgs get the Owl, and whose data they see)</span>
      {(cfg.links || []).map((l, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
          <input value={l.orgId} onChange={(e) => setLink(i, { orgId: e.target.value })} placeholder="Howler organization id" style={{ ...fld, width: 220 }} />
          <span style={{ color: 'var(--muted)' }}>→</span>
          <select value={l.entityId} onChange={(e) => setLink(i, { entityId: e.target.value })} style={{ ...fld, minWidth: 200 }}>
            <option value="">Pick a Pulse client…</option>
            {ents.map((en) => <option key={en.id} value={en.id}>{en.name}</option>)}
          </select>
          <button onClick={() => delLink(i)} title="Remove" style={{ ...fld, cursor: 'pointer' }}>🗑</button>
        </div>
      ))}
      <button onClick={addLink} style={{ ...fld, cursor: 'pointer' }}>＋ Add link</button>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 14 }}>
        <button onClick={save} disabled={busy} style={{ border: 'none', background: 'var(--brand)', color: '#fff', borderRadius: 8, padding: '8px 18px', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', opacity: busy ? 0.7 : 1 }}>{busy ? 'Saving…' : 'Save'}</button>
        {saved && <span style={{ color: 'var(--success, #16a34a)', fontSize: 13 }}>✓ Saved</span>}
        {saveErr && <span style={{ color: 'var(--error, #dc2626)', fontSize: 13 }}>⚠ {saveErr}</span>}
      </div>
    </div>
  );
}
