// ─── Lineup: artist/set-schedule overlay for the Rhythm view ─────────────────
// Self-contained. Talks to server/lineup.js (/api/*/lineup/:suiteId). Exposes:
//   useLineup(apiBase, suiteId) → { sets, setSets, reload, save }
//   parseCsv(text) → sets[]              (Day, Stage, Artist, Start, End)
//   bandsFor(sets, hours) → positioned bands + per-set impact vs the hour before
//   <LineupBands> — coloured set bands laid over the Rhythm hour chart
//   <SetImpact>   — "which artist drove the most" ranked list
//   <LineupEditor>— paste-a-CSV modal (admin + client, scope from apiBase)
// Set times are entered in EVENT-LOCAL time; Pulse assumes +02:00 (CEST/SAST)
// everywhere, so we convert to UTC with that offset to line up with the data axis.

import React, { useState, useEffect, useCallback } from 'react';

const TZ_MIN = 120; // +02:00 — the offset the rest of Pulse already assumes for this data
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const lineupScope = (apiBase) => (apiBase && apiBase.indexOf('/api/admin') === 0 ? '/api/admin' : '/api/my');

// Stage → a stable colour (so bands + list agree). Hash the stage name into a hue.
const STAGE_HUES = [265, 199, 24, 150, 330, 45, 0, 220];
export function stageColor(stage) {
  const s = String(stage || '');
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `hsl(${STAGE_HUES[h % STAGE_HUES.length]} 74% 58%)`;
}

// A set's start/end as UTC epoch ms. end < start ⇒ the set runs past midnight.
export function setEpochs(s) {
  if (!s || !s.day || !HHMM.test(s.start || '')) return null;
  const at = (hhmm) => Date.parse(`${s.day}T${hhmm}:00Z`) - TZ_MIN * 60000; // local→UTC
  const start = at(s.start);
  let end = HHMM.test(s.end || '') ? at(s.end) : start + 90 * 60000; // default 90-min set
  if (end <= start) end += 24 * 3600000; // crosses midnight
  return { start, end };
}

// Paste-friendly CSV/TSV → sets. Optional header row (detected by the word "artist").
// Column order without a header: Day, Stage, Artist, Start, End.
export function parseCsv(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const split = (l) => l.split(l.indexOf('\t') >= 0 ? '\t' : l.indexOf(';') >= 0 ? ';' : ',').map((c) => c.trim());
  let idx = { day: 0, stage: 1, artist: 2, start: 3, end: 4 };
  let start = 0;
  const head = split(lines[0]).map((c) => c.toLowerCase());
  if (head.some((c) => /artist|act|dj/.test(c))) {
    const find = (re, d) => { const i = head.findIndex((c) => re.test(c)); return i >= 0 ? i : d; };
    idx = { day: find(/day|date/, 0), stage: find(/stage|room|area/, 1), artist: find(/artist|act|dj|name/, 2), start: find(/start|from|on/, 3), end: find(/end|to|off|until/, 4) };
    start = 1;
  }
  const norm = (t) => { const m = String(t || '').match(/(\d{1,2})[:h.](\d{2})/); return m ? `${m[1].padStart(2, '0')}:${m[2]}` : ''; };
  const out = [];
  for (const l of lines.slice(start)) {
    const c = split(l);
    const artist = (c[idx.artist] || '').slice(0, 120);
    const st = norm(c[idx.start]);
    if (!artist || !HHMM.test(st)) continue;
    out.push({ day: (c[idx.day] || '').slice(0, 40), stage: (c[idx.stage] || '').slice(0, 80), artist, start: st, end: norm(c[idx.end]) });
  }
  return out;
}

export function useLineup(apiBase, suiteId) {
  const [sets, setSets] = useState([]);
  const scope = lineupScope(apiBase);
  const reload = useCallback(() => {
    if (!suiteId) return;
    fetch(`${scope}/lineup/${encodeURIComponent(suiteId)}`).then((r) => r.json())
      .then((d) => { if (d && Array.isArray(d.sets)) setSets(d.sets); }).catch(() => {});
  }, [scope, suiteId]);
  useEffect(() => { reload(); }, [reload]);
  const save = useCallback((next) => fetch(`${scope}/lineup/${encodeURIComponent(suiteId)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sets: next }),
  }).then((r) => r.json()).then((d) => { if (d && Array.isArray(d.sets)) setSets(d.sets); return d; }), [scope, suiteId]);
  return { sets, setSets, reload, save };
}

// Map sets onto the Rhythm hour axis (array of 'YYYY-MM-DDTHH' UTC strings, 1h cols)
// and, given the per-hour transaction totals, compute each set's footprint + uplift
// vs the equal-length window immediately before it.
export function bandsFor(sets, hours, hourTx) {
  if (!hours || !hours.length) return [];
  const axis0 = Date.parse(`${hours[0]}:00:00Z`); const nCols = hours.length;
  const frac = (ms) => (ms - axis0) / 3600000;
  const winSum = (a, b) => { // sum hourTx across fractional columns [a,b)
    let s = 0; for (let i = Math.floor(a); i < Math.ceil(b); i++) { if (i < 0 || i >= (hourTx || []).length) continue; const lo = Math.max(a, i), hi = Math.min(b, i + 1); if (hi > lo) s += (hourTx[i] || 0) * (hi - lo); } return s;
  };
  return sets.map((s) => {
    const e = setEpochs(s); if (!e) return null;
    const fs = frac(e.start), fe = frac(e.end); const dur = Math.max(0.25, fe - fs);
    const vis = fe > 0 && fs < nCols; // any overlap with the visible axis
    const tx = hourTx ? Math.round(winSum(Math.max(0, fs), Math.min(nCols, fe))) : null;
    const base = hourTx ? Math.round(winSum(fs - dur, fs)) : null;
    const uplift = base ? Math.round(((tx - base) / base) * 100) : null;
    return {
      ...s, dur, vis, tx, base, uplift,
      left: Math.max(0, (fs / nCols) * 100),
      width: Math.max(1.5, ((Math.min(nCols, fe) - Math.max(0, fs)) / nCols) * 100),
      color: stageColor(s.stage),
    };
  }).filter((b) => b && b.vis);
}

// Coloured bands laid over the Rhythm "whole site · per hour" bar chart.
export function LineupBands({ bands }) {
  if (!bands || !bands.length) return null;
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {bands.map((b, i) => (
        <div key={b.artist + i} title={`${b.artist}${b.stage ? ' · ' + b.stage : ''} · ${b.start}${b.end ? '–' + b.end : ''}${b.tx != null ? ' · ' + b.tx.toLocaleString('en-ZA') + ' txns' : ''}`}
          style={{ position: 'absolute', top: 0, bottom: 0, left: `${b.left}%`, width: `${b.width}%`, background: b.color, opacity: 0.14, borderLeft: `2px solid ${b.color}`, boxSizing: 'border-box' }}>
          <span style={{ position: 'absolute', top: 1, left: 3, fontSize: 8.5, fontWeight: 800, color: b.color, whiteSpace: 'nowrap', textShadow: '0 1px 2px var(--card)' }}>{b.artist}</span>
        </div>
      ))}
    </div>
  );
}

// "Which artist drove the most" — ranked by transactions during the set, with the
// honest caveat that sales lead/lag a set and a headliner lifts the whole venue.
export function SetImpact({ bands, onEdit, canEdit }) {
  const ranked = [...(bands || [])].filter((b) => b.tx != null).sort((a, b) => b.tx - a.tx);
  const max = ranked.length ? Math.max(1, ranked[0].tx) : 1;
  const card = { background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 12, padding: '10px 12px', marginTop: 8 };
  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: ranked.length ? 8 : 0 }}>
        <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--muted)' }}>🎤 Set impact</span>
        <span style={{ fontSize: 10.5, color: 'var(--faint)' }}>transactions while each act played</span>
        {canEdit && <button onClick={onEdit} style={{ marginLeft: 'auto', border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 8, padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>✏️ {bands && bands.length ? 'Edit' : 'Add'} lineup</button>}
      </div>
      {!ranked.length
        ? <div style={{ fontSize: 12, color: 'var(--muted)' }}>{canEdit ? 'No lineup yet — add the set times to see each artist’s sales footprint.' : 'No lineup for this event yet.'}</div>
        : <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {ranked.map((b, i) => (
              <div key={b.artist + i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 10.5, fontWeight: 800, color: 'var(--faint)', width: 16, textAlign: 'right' }}>{i + 1}</span>
                <span style={{ width: 9, height: 9, borderRadius: '50%', background: b.color, flexShrink: 0 }} />
                <span style={{ flex: '0 0 34%', fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{b.artist}<span style={{ color: 'var(--faint)', fontWeight: 400, fontSize: 10 }}> {b.start}</span></span>
                <span style={{ flex: 1, height: 8, borderRadius: 4, background: 'var(--hairline)', overflow: 'hidden' }}>
                  <span style={{ display: 'block', height: '100%', width: `${Math.max(4, (b.tx / max) * 100)}%`, background: b.color, borderRadius: 4 }} />
                </span>
                {b.uplift != null && <span title="vs the same length window just before the set" style={{ width: 46, textAlign: 'right', fontSize: 11, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: b.uplift > 0 ? 'var(--good, #16a34a)' : b.uplift < 0 ? 'var(--bad, #dc2626)' : 'var(--muted)' }}>{b.uplift > 0 ? '+' : ''}{b.uplift}%</span>}
                <span style={{ width: 52, textAlign: 'right', fontSize: 12, fontWeight: 800, fontVariantNumeric: 'tabular-nums', color: b.color }}>{b.tx.toLocaleString('en-ZA')}</span>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 10, color: 'var(--faint)', marginTop: 7 }}>Correlation, not proof: bar sales lead &amp; lag a set (pre-buying, queues), and a headliner lifts the whole venue. % = sales rate vs the same-length window just before.</div>
        </>}
    </div>
  );
}

// Paste-a-CSV modal, with an editable row grid. Works for admin (any event) and
// client self-service (own event) — the scope rides on apiBase.
export function LineupEditor({ apiBase, suiteId, sets, onClose, onSaved }) {
  const [rows, setRows] = useState(() => (sets && sets.length ? sets : []));
  const [raw, setRaw] = useState('');
  const [saving, setSaving] = useState(false);
  const scope = lineupScope(apiBase);
  const add = () => setRows((r) => [...r, { day: (r[r.length - 1] || {}).day || '', stage: '', artist: '', start: '', end: '' }]);
  const set = (i, k, v) => setRows((r) => r.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const del = (i) => setRows((r) => r.filter((_, j) => j !== i));
  const importCsv = () => { const p = parseCsv(raw); if (p.length) { setRows((r) => [...r, ...p]); setRaw(''); } };
  const save = () => {
    setSaving(true);
    fetch(`${scope}/lineup/${encodeURIComponent(suiteId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sets: rows }) })
      .then((r) => r.json()).then((d) => { if (d && Array.isArray(d.sets)) { onSaved && onSaved(d.sets); onClose(); } })
      .finally(() => setSaving(false));
  };
  const inp = { border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 7, padding: '6px 8px', fontSize: 12.5, fontFamily: 'inherit', minHeight: 34, minWidth: 0 };
  const btn = (primary) => ({ border: `1px solid ${primary ? 'var(--brand)' : 'var(--hairline)'}`, background: primary ? 'var(--brand)' : 'var(--card)', color: primary ? '#fff' : 'var(--text)', borderRadius: 8, padding: '7px 13px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' });
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1400, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: 'var(--bg)', width: '100%', maxWidth: 640, maxHeight: '92dvh', overflowY: 'auto', borderRadius: '16px 16px 0 0', padding: 16, boxShadow: '0 -8px 30px rgba(0,0,0,0.3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span style={{ fontSize: 15, fontWeight: 800 }}>🎤 Lineup</span>
          <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{rows.length} set{rows.length === 1 ? '' : 's'}</span>
          <button onClick={onClose} style={{ marginLeft: 'auto', ...btn(false) }}>Close</button>
        </div>
        <div style={{ background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 10, padding: 10, marginBottom: 12 }}>
          <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--muted)', marginBottom: 6 }}>Paste a schedule</div>
          <textarea value={raw} onChange={(e) => setRaw(e.target.value)} rows={3} placeholder={'Day, Stage, Artist, Start, End\n2026-07-05, Main, Charlotte de Witte, 23:00, 00:30\n2026-07-05, Solar, Amelie Lens, 21:00, 23:00'}
            style={{ ...inp, width: '100%', resize: 'vertical', fontFamily: 'ui-monospace, monospace', fontSize: 12 }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }}>
            <button onClick={importCsv} disabled={!raw.trim()} style={btn(false)}>Add rows from paste</button>
            <span style={{ fontSize: 10.5, color: 'var(--faint)' }}>Times in event-local (24h). After-midnight sets: end &lt; start is fine.</span>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((r, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 2fr 0.9fr 0.9fr auto', gap: 5, alignItems: 'center' }}>
              <input value={r.day} onChange={(e) => set(i, 'day', e.target.value)} placeholder="YYYY-MM-DD" style={inp} />
              <input value={r.stage} onChange={(e) => set(i, 'stage', e.target.value)} placeholder="Stage" style={inp} />
              <input value={r.artist} onChange={(e) => set(i, 'artist', e.target.value)} placeholder="Artist" style={inp} />
              <input value={r.start} onChange={(e) => set(i, 'start', e.target.value)} placeholder="23:00" style={inp} />
              <input value={r.end} onChange={(e) => set(i, 'end', e.target.value)} placeholder="00:30" style={inp} />
              <button onClick={() => del(i)} title="Remove" style={{ ...btn(false), padding: '6px 9px' }}>✕</button>
            </div>
          ))}
          <button onClick={add} style={{ ...btn(false), alignSelf: 'flex-start' }}>+ Add a set</button>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14, position: 'sticky', bottom: 0, background: 'var(--bg)', paddingTop: 8 }}>
          <button onClick={save} disabled={saving} style={{ ...btn(true), flex: 1 }}>{saving ? 'Saving…' : `💾 Save lineup (${rows.length})`}</button>
        </div>
      </div>
    </div>
  );
}
