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

function FieldGroup({ title, items, selected, onToggle }) {
  if (!items.length) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <Label>{title}</Label>
      <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid #eee', borderRadius: 6 }}>
        {items.map((f) => (
          <label key={f.name} style={fieldRow} title={f.description || f.name}>
            <input type="checkbox" checked={selected.includes(f.name)} onChange={() => onToggle(f.name)} />
            <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {f.label_short || f.label}
            </span>
          </label>
        ))}
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

const select = { width: '100%', padding: '7px 10px', border: '1.5px solid #e0e0e0', borderRadius: 6, fontSize: 13, outline: 'none', background: '#fff' };
const fieldRow = { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', fontSize: 13, cursor: 'pointer', borderBottom: '1px solid #f5f5f5' };
