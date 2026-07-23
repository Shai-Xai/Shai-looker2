import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

// ─── Owl Guidance editor — the no-code fine-tuning dial ───────────────────────
// Plain-text steering the Owl follows when answering, editable without a deploy.
// One component, three surfaces (dual-surface rule):
//   scope='global'       → Admin → AI: house rules for every answer
//   scope='admin-client' → Admin → a client's tab: rules for that client
//   scope='my'           → client self-service: rules for their own data
// Saves to server/owlGuidance.js; injected into the Owl per request.
const EXAMPLES = [
  'Always split entry tickets vs add-ons (is_addonable) and report them on separate lines.',
  "“Revenue” means gross including fees unless I ask for net.",
  "Treat “today” / “this week” as the purchase date, not the event date.",
  'For ticket-type breakdowns, use Tickets Sold (count of tickets) — never a count of ticket types.',
];

export default function OwlGuidanceEditor({ scope = 'global', entityId = '' }) {
  const [text, setText] = useState('');
  const [houseRules, setHouseRules] = useState(''); // 'my' scope: read-only global context
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let on = true;
    const get = scope === 'global' ? api.owlGuidanceGlobal()
      : scope === 'admin-client' ? api.owlGuidanceEntity(entityId)
        : api.myOwlGuidance();
    get.then((r) => { if (!on) return; setText(r.guidance || ''); if (r.houseRules != null) setHouseRules(r.houseRules); })
      .catch(() => {}).finally(() => { if (on) setLoading(false); });
    return () => { on = false; };
  }, [scope, entityId]);

  const save = async () => {
    setBusy(true);
    try {
      if (scope === 'global') await api.setOwlGuidanceGlobal(text);
      else if (scope === 'admin-client') await api.setOwlGuidanceEntity(entityId, text);
      else await api.setMyOwlGuidance(text);
      setSaved(true); setTimeout(() => setSaved(false), 1600);
    } catch { /* ignore */ }
    setBusy(false);
  };

  const title = scope === 'global' ? 'Owl guidance — house rules (all clients)'
    : scope === 'admin-client' ? 'Owl guidance for this client'
      : 'Owl guidance';
  const help = scope === 'global'
    ? 'Plain-English rules the Owl follows on every answer, on top of its built-in data catalogue. Edit anytime — no deploy needed.'
    : scope === 'admin-client'
      ? "Rules just for this client's Owl answers — layered on top of the house rules (and they win on conflict)."
      : 'Tell the Owl how to read your data — e.g. what "revenue" means, or to always split add-ons. Applies to your Owl answers.';
  const lbl = { display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--muted)', margin: '0 0 4px' };

  return (
    <div style={{ marginTop: 12 }}>
      <span style={lbl}>{title}</span>
      <div style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 6px' }}>{help}</div>
      {scope === 'my' && houseRules && (
        <div style={{ fontSize: 12, color: 'var(--muted)', background: 'var(--elevated, rgba(128,128,128,0.08))', borderRadius: 8, padding: '8px 10px', margin: '0 0 6px', whiteSpace: 'pre-wrap' }}>
          <b style={{ color: 'var(--text)' }}>House rules (set by Howler):</b>{'\n'}{houseRules}
        </div>
      )}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        disabled={loading}
        placeholder={loading ? 'Loading…' : `One rule per line, e.g.\n• ${EXAMPLES.join('\n• ')}`}
        style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, outline: 'none', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5, background: 'var(--card)', color: 'var(--text)' }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
        <button onClick={save} disabled={busy || loading} style={{ border: 'none', background: 'var(--brand)', color: '#fff', borderRadius: 8, padding: '7px 16px', fontSize: 13, fontWeight: 600, cursor: busy || loading ? 'default' : 'pointer', opacity: busy || loading ? 0.6 : 1 }}>{busy ? 'Saving…' : 'Save guidance'}</button>
        {saved && <span style={{ fontSize: 12.5, color: '#34c759', fontWeight: 600 }}>Saved ✓</span>}
      </div>
    </div>
  );
}
