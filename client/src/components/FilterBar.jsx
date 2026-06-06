import { useState } from 'react';

export default function FilterBar({ filters, values, onChange }) {
  return (
    <div style={{
      background: '#fff',
      borderBottom: '1px solid #e0e0e0',
      padding: '12px 24px',
      display: 'flex',
      flexWrap: 'wrap',
      gap: 12,
      alignItems: 'flex-end',
    }}>
      {filters.map(filter => (
        <FilterControl
          key={filter.id}
          filter={filter}
          value={values[filter.name] ?? ''}
          onChange={val => onChange(filter.name, val)}
        />
      ))}
    </div>
  );
}

function FilterControl({ filter, value, onChange }) {
  const uiType = filter.ui_config?.type;

  // Date range picker
  if (uiType === 'relative_timeframes' || uiType === 'date_range_picker' || filter.type === 'date_filter') {
    return (
      <div style={fieldStyle}>
        <label style={labelStyle}>{filter.title}</label>
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="e.g. 7 days ago for now"
          style={inputStyle}
          title="Looker date filter expression"
        />
      </div>
    );
  }

  // Dropdown (tag_list / button_group / checkboxes with options)
  if (uiType === 'tag_list' || uiType === 'button_group' || uiType === 'checkboxes') {
    return (
      <div style={fieldStyle}>
        <label style={labelStyle}>{filter.title}</label>
        <FilterAutocomplete filter={filter} value={value} onChange={onChange} />
      </div>
    );
  }

  // Default: text input
  return (
    <div style={fieldStyle}>
      <label style={labelStyle}>{filter.title}</label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="Filter value…"
        style={inputStyle}
      />
    </div>
  );
}

// Text input with a small suggestion list fetched from Looker suggest API
function FilterAutocomplete({ filter, value, onChange }) {
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const [fetching, setFetching] = useState(false);

  async function loadSuggestions() {
    if (suggestions.length > 0 || fetching) { setOpen(true); return; }
    const field = filter.field || filter.dimension;
    if (!filter.model || !filter.explore || !field) { setOpen(true); return; }
    setFetching(true);
    try {
      const res = await fetch('/api/filter-suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: filter.model, explore: filter.explore, field }),
      });
      const data = await res.json();
      setSuggestions(data.suggestions || []);
    } catch (_) {
      // silently ignore — still usable as plain text input
    } finally {
      setFetching(false);
      setOpen(true);
    }
  }

  return (
    <div style={{ position: 'relative' }}>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        onFocus={loadSuggestions}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Filter value…"
        style={inputStyle}
      />
      {open && suggestions.length > 0 && (
        <ul style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100,
          background: '#fff', border: '1px solid #e0e0e0', borderRadius: 6,
          boxShadow: '0 4px 12px rgba(0,0,0,0.1)', maxHeight: 200, overflowY: 'auto',
          listStyle: 'none', margin: 0, padding: '4px 0',
        }}>
          {suggestions.map((s, i) => (
            <li
              key={i}
              onMouseDown={() => { onChange(s); setOpen(false); }}
              style={{ padding: '8px 12px', cursor: 'pointer', fontSize: 13 }}
              onMouseEnter={e => e.target.style.background = '#f7f7f7'}
              onMouseLeave={e => e.target.style.background = 'transparent'}
            >{s}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

const fieldStyle = { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 180 };
const labelStyle = { fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.05em' };
const inputStyle = { padding: '7px 10px', border: '1.5px solid #e0e0e0', borderRadius: 6, fontSize: 13, outline: 'none', width: '100%' };
