import { useState, useEffect } from 'react';
import { api } from '../../lib/api.js';

// Browse Looker models → explores → fields and select dimensions/measures.
// Emits the chosen { model, view, fields } plus the field metadata so the
// parent can drive sorts, filter wiring, etc.
export default function ExploreBrowser({ query, onChange }) {
  const [models, setModels] = useState([]);
  const [fields, setFields] = useState({ dimensions: [], measures: [] });
  const [loadingModels, setLoadingModels] = useState(true);
  const [loadingFields, setLoadingFields] = useState(false);
  const [err, setErr] = useState(null);

  const model = query?.model || '';
  const explore = query?.view || '';
  const selected = query?.fields || [];

  useEffect(() => {
    api.listModels()
      .then(setModels)
      .catch((e) => setErr(e.message))
      .finally(() => setLoadingModels(false));
  }, []);

  // Load fields whenever model+explore are set.
  useEffect(() => {
    if (!model || !explore) {
      setFields({ dimensions: [], measures: [] });
      return;
    }
    setLoadingFields(true);
    setErr(null);
    api.getExploreFields(model, explore)
      .then(setFields)
      .catch((e) => setErr(e.message))
      .finally(() => setLoadingFields(false));
  }, [model, explore]);

  const explores = models.find((m) => m.name === model)?.explores || [];

  function setModel(m) {
    onChange({ model: m, view: '', fields: [] });
  }
  function setExplore(e) {
    onChange({ model, view: e, fields: [] });
  }
  function toggleField(name) {
    const next = selected.includes(name)
      ? selected.filter((f) => f !== name)
      : [...selected, name];
    onChange({ model, view: explore, fields: next }, fields);
  }

  return (
    <div>
      <Label>Model</Label>
      {loadingModels ? (
        <Hint>Loading models…</Hint>
      ) : (
        <select style={select} value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="">Select a model…</option>
          {models.filter((m) => m.explores.length > 0).map((m) => (
            <option key={m.name} value={m.name}>{m.label}</option>
          ))}
        </select>
      )}

      {model && (
        <>
          <Label>Explore</Label>
          <select style={select} value={explore} onChange={(e) => setExplore(e.target.value)}>
            <option value="">Select an explore…</option>
            {explores.map((e) => (
              <option key={e.name} value={e.name}>{e.label}</option>
            ))}
          </select>
        </>
      )}

      {err && <Hint error>{err}</Hint>}

      {explore && (
        loadingFields ? (
          <Hint>Loading fields…</Hint>
        ) : (
          <>
            <FieldGroup title="Dimensions" items={fields.dimensions} selected={selected} onToggle={toggleField} />
            <FieldGroup title="Measures" items={fields.measures} selected={selected} onToggle={toggleField} />
          </>
        )
      )}
    </div>
  );
}

// Shows the SELECTED fields as removable chips, then a search box that drops
// down the remaining (unselected) fields to add — so you're not scrolling a wall
// of every dimension/measure to find the few you want.
function FieldGroup({ title, items, selected, onToggle }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  if (!items.length) return null;
  const label = (f) => f.label_short || f.label || f.name;
  const sel = items.filter((f) => selected.includes(f.name));
  const unsel = items.filter((f) => !selected.includes(f.name));
  const ql = q.trim().toLowerCase();
  const filtered = ql ? unsel.filter((f) => label(f).toLowerCase().includes(ql) || f.name.toLowerCase().includes(ql)) : unsel;
  return (
    <div style={{ marginTop: 12 }}>
      <Label>{title}{sel.length ? ` · ${sel.length} selected` : ''}</Label>
      {sel.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
          {sel.map((f) => (
            <span key={f.name} style={chip} title={f.name}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 200 }}>{label(f)}</span>
              <span style={chipX} title="Remove" onClick={() => onToggle(f.name)}>✕</span>
            </span>
          ))}
        </div>
      )}
      <div style={{ position: 'relative' }}>
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); if (!open) setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder={`+ Add ${title.toLowerCase()}${unsel.length ? ` (${unsel.length})` : ''}…`}
          style={addInput}
        />
        {open && (
          <ul style={ddList}>
            {filtered.length === 0 ? (
              <li style={ddMuted}>{ql ? 'No matches' : 'All added'}</li>
            ) : (
              filtered.slice(0, 200).map((f) => (
                <li key={f.name} style={ddItem} title={f.description || f.name}
                  onMouseDown={(e) => { e.preventDefault(); onToggle(f.name); }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(128,128,128,0.12)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}>
                  {label(f)}
                </li>
              ))
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

function Label({ children }) {
  return <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', margin: '12px 0 5px' }}>{children}</div>;
}
function Hint({ children, error }) {
  return <div style={{ fontSize: 12, color: error ? 'var(--error)' : 'var(--muted)', padding: '4px 0' }}>{children}</div>;
}

const select = { width: '100%', padding: '7px 10px', border: '1.5px solid var(--hairline)', borderRadius: 6, fontSize: 13, outline: 'none', background: 'var(--card)' };
const addInput = { width: '100%', boxSizing: 'border-box', padding: '7px 10px', border: '1.5px solid var(--hairline)', borderRadius: 6, fontSize: 13, outline: 'none', background: 'var(--card)', color: 'var(--text)' };
const chip = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 6px 3px 9px', borderRadius: 980, fontSize: 12.5, fontWeight: 600, background: 'rgba(var(--brand-rgb,255,56,92),0.10)', color: 'var(--brand)', border: '1px solid rgba(var(--brand-rgb,255,56,92),0.30)' };
const chipX = { cursor: 'pointer', fontWeight: 700, fontSize: 11, opacity: 0.8 };
const ddList = { position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50, marginTop: 4, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 6px 20px rgba(0,0,0,0.12)', maxHeight: 240, overflowY: 'auto', listStyle: 'none', margin: 0, padding: '4px 0' };
const ddItem = { padding: '7px 11px', cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const ddMuted = { padding: '7px 11px', fontSize: 13, color: 'var(--muted)' };
