import { useState } from 'react';
import { api } from '../lib/api.js';

// "Refine with AI" — sharpens a short instruction/briefing note in place. Takes
// the current `text`, sends it to the AI, and calls onRefined(newText). Used by
// the briefing tuner and the digest editor. Shows a one-tap undo so a user can
// revert if they prefer their original wording.
export default function RefineButton({ text, onRefined, purpose, entityId, style }) {
  const [busy, setBusy] = useState(false);
  const [prev, setPrev] = useState(null); // last text before refine (for undo)
  const [err, setErr] = useState('');

  const refine = async () => {
    const t = (text || '').trim();
    if (!t) { setErr('Write a note first.'); setTimeout(() => setErr(''), 2500); return; }
    setBusy(true); setErr('');
    try {
      const r = await api.refineText({ text: t, purpose, entityId });
      if (r?.text) { setPrev(text); onRefined(r.text); }
    } catch (e) { setErr(e.message || 'Could not refine'); setTimeout(() => setErr(''), 3000); }
    finally { setBusy(false); }
  };
  const undo = () => { onRefined(prev); setPrev(null); };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6, flexWrap: 'wrap', ...style }}>
      <button type="button" onClick={refine} disabled={busy} style={btn} title="Sharpen this note with AI">
        {busy ? '✨ Refining…' : '✨ Refine with AI'}
      </button>
      {prev != null && !busy && <button type="button" onClick={undo} style={undoBtn} title="Revert to your wording">Undo</button>}
      {err && <span style={{ fontSize: 12, color: 'var(--error,#ef4444)' }}>{err}</span>}
    </div>
  );
}

const btn = { display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--ai, #7c3aed)', borderRadius: 980, padding: '5px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' };
const undoBtn = { border: 'none', background: 'transparent', color: 'var(--muted)', fontSize: 12, fontWeight: 600, cursor: 'pointer', padding: '5px 4px' };
