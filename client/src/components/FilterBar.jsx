import { useState, useRef, useEffect } from 'react';
import { useIsMobile } from '../lib/useIsMobile.js';
import { useScope } from '../lib/ScopeContext.jsx';

export default function FilterBar({ filters, values, onChange, locked = {} }) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);

  const controls = filters.map(filter => (
    <FilterControl
      key={filter.id}
      filter={filter}
      value={values[filter.name] ?? ''}
      onChange={val => onChange(filter.name, val)}
      locked={!!locked[filter.name]}
    />
  ));

  // Mobile: a compact "Filters" trigger that opens a bottom sheet, so filters
  // don't eat half the screen above the dashboard.
  if (isMobile) {
    const activeCount = filters.filter(f => (values[f.name] ?? '') !== '').length;
    return (
      <>
        <div style={{ background: 'var(--card)', borderBottom: '1px solid var(--hairline)', padding: '10px 14px', display: 'flex' }}>
          <button onClick={() => setOpen(true)} style={filterTrigger}>
            <span>⚲ Filters</span>
            {activeCount > 0 && <span style={countPill}>{activeCount}</span>}
          </button>
        </div>
        {open && (
          <div style={sheetBackdrop} onClick={() => setOpen(false)}>
            <div style={sheet} onClick={e => e.stopPropagation()}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
                <h3 style={{ fontSize: 16, fontWeight: 700, flex: 1 }}>Filters</h3>
                <button onClick={() => setOpen(false)} style={doneBtn}>Done</button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>{controls}</div>
            </div>
          </div>
        )}
      </>
    );
  }

  // Desktop: collapsed by default behind a "Filters" toggle, with a summary of
  // what's currently applied so it's clear without expanding.
  const activeCount = filters.filter(f => (values[f.name] ?? '') !== '').length;
  const summary = filters
    .filter(f => (values[f.name] ?? '') !== '')
    .map(f => `${f.title}: ${values[f.name]}`)
    .join('   ·   ');

  return (
    <div style={{ background: 'var(--card)', borderBottom: '1px solid var(--hairline)', padding: '12px 22px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
        <button onClick={() => setOpen(v => !v)} style={filterTrigger}>
          <span>⚲ Filters</span>
          {activeCount > 0 && <span style={countPill}>{activeCount}</span>}
          <span style={{ fontSize: 11, color: '#888' }}>{open ? '▴' : '▾'}</span>
        </button>
        {!open && summary && (
          <span style={{ fontSize: 13, color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={summary}>
            {summary}
          </span>
        )}
      </div>
      {open && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end', marginTop: 14 }}>
          {controls}
        </div>
      )}
    </div>
  );
}

const filterTrigger = { display: 'inline-flex', alignItems: 'center', gap: 8, padding: '9px 16px', background: 'rgba(0,0,0,0.05)', color: 'var(--text)', border: 'none', borderRadius: 980, fontSize: 14, fontWeight: 600, cursor: 'pointer' };
const countPill = { background: 'var(--brand)', color: '#fff', fontSize: 11, fontWeight: 700, borderRadius: 980, minWidth: 18, height: 18, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 5px' };
const sheetBackdrop = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1000, display: 'flex', alignItems: 'flex-end' };
const sheet = { background: '#fff', width: '100%', maxHeight: '80dvh', overflowY: 'auto', borderRadius: '18px 18px 0 0', padding: '18px 18px calc(18px + env(safe-area-inset-bottom))', boxShadow: '0 -4px 24px rgba(0,0,0,0.2)' };
const doneBtn = { padding: '7px 16px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };

// A scoped, non-editable filter (the client's organiser/event). Shows the
// value with a lock so it's clear it's fixed to their account.
function LockedField({ filter, value }) {
  return (
    <div style={fieldStyle}>
      <label style={labelStyle}>{filter.title}</label>
      <div style={{ ...inputStyle, background: '#f3f4f6', color: '#555', display: 'flex', alignItems: 'center', gap: 6, cursor: 'not-allowed' }} title="Locked to your account">
        <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value || '—'}</span>
        <span style={{ fontSize: 12 }}>🔒</span>
      </div>
    </div>
  );
}

// Looker UI types that allow selecting several values at once.
const MULTI_TYPES = new Set(['checkboxes', 'tag_list', 'advanced']);

function FilterControl({ filter, value, onChange, locked }) {
  if (locked) return <LockedField filter={filter} value={value} />;
  const uiType = filter.ui_config?.type;
  const isDate = uiType === 'relative_timeframes' || uiType === 'date_range_picker' || filter.type === 'date_filter';
  const field = filter.field || filter.dimension;
  const canSuggest = !isDate && !!(filter.model && filter.explore && field);

  return (
    <div style={fieldStyle}>
      <label style={labelStyle}>{filter.title}</label>
      {isDate ? (
        <input
          type="text"
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="e.g. 7 days ago for now"
          style={inputStyle}
          title="Looker date filter expression"
        />
      ) : canSuggest ? (
        <FilterDropdown filter={filter} value={value} onChange={onChange} multi={MULTI_TYPES.has(uiType)} />
      ) : (
        <input type="text" value={value} onChange={e => onChange(e.target.value)} placeholder="Filter value…" style={inputStyle} />
      )}
    </div>
  );
}

// A searchable dropdown of a dimension's values (fetched from Looker on open).
// Type to filter the list; click to select. In multi mode several values can
// be picked (stored as a comma-separated string, the way Looker expects).
function FilterDropdown({ filter, value, onChange, multi = false }) {
  const { suiteId } = useScope();
  const [all, setAll] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState('');
  const boxRef = useRef(null);

  const selected = multi ? String(value || '').split(',').map(s => s.trim()).filter(Boolean) : [];

  async function load() {
    if (loaded || loading) return;
    setLoading(true);
    try {
      const res = await fetch('/api/filter-suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: filter.model, explore: filter.explore, field: filter.field || filter.dimension, suiteId }),
      });
      const data = await res.json();
      setAll(data.suggestions || []);
    } catch (_) {
      setAll([]);
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  }

  function openList() { setOpen(true); load(); }

  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) { setOpen(false); setQuery(''); } };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const filtered = query ? all.filter(s => s.toLowerCase().includes(query.toLowerCase())) : all;

  // Single-select: pick replaces value and closes. Multi-select: toggle the
  // value in/out and keep the list open so several can be chosen.
  const pickSingle = (s) => { onChange(s); setOpen(false); setQuery(''); };
  const toggleMulti = (s) => {
    const next = selected.includes(s) ? selected.filter(x => x !== s) : [...selected, s];
    onChange(next.join(','));
  };

  const summary = multi
    ? (selected.length === 0 ? '' : selected.length === 1 ? selected[0] : `${selected.length} selected`)
    : value;
  const placeholder = multi
    ? (selected.length ? `${selected.length} selected` : 'Select…')
    : (value || 'Select…');

  return (
    <div ref={boxRef} style={{ position: 'relative' }}>
      <input
        type="text"
        value={open ? query : summary}
        onChange={e => { setQuery(e.target.value); if (!open) setOpen(true); }}
        onFocus={openList}
        placeholder={placeholder}
        style={{ ...inputStyle, paddingRight: 28 }}
      />
      <span
        onMouseDown={(e) => { e.preventDefault(); open ? (setOpen(false), setQuery('')) : openList(); }}
        style={caretStyle}
      >▾</span>
      {open && (
        <ul style={dropdownList}>
          {(multi ? selected.length > 0 : !!value) && (
            <li onMouseDown={() => { onChange(''); if (!multi) setOpen(false); }} style={{ ...optStyle, color: 'var(--muted)' }}>
              ✕ Clear{multi && selected.length > 1 ? ' all' : ''}
            </li>
          )}
          {loading ? (
            <li style={optMuted}>Loading…</li>
          ) : filtered.length === 0 ? (
            <li style={optMuted}>{query ? 'No matches' : 'No options'}</li>
          ) : (
            filtered.slice(0, 300).map((s, i) => {
              const isSel = multi ? selected.includes(s) : s === value;
              return (
                <li
                  key={i}
                  onMouseDown={(e) => { e.preventDefault(); multi ? toggleMulti(s) : pickSingle(s); }}
                  style={{ ...optStyle, display: 'flex', alignItems: 'center', gap: 8, ...(isSel ? { background: '#fff0f3', fontWeight: 600 } : null) }}
                  onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = '#f7f7f7'; }}
                  onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = 'transparent'; }}
                >
                  {multi && <span style={{ color: isSel ? 'var(--brand)' : '#bbb' }}>{isSel ? '☑' : '☐'}</span>}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{s}</span>
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}

const fieldStyle = { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 180 };
const labelStyle = { fontSize: 11, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' };
const inputStyle = { padding: '9px 12px', border: '1px solid var(--hairline)', borderRadius: 10, fontSize: 13, outline: 'none', width: '100%', background: '#fff', boxSizing: 'border-box' };
const caretStyle = { position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 11, color: '#888', pointerEvents: 'auto', cursor: 'pointer' };
const dropdownList = {
  position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100, marginTop: 4,
  background: '#fff', border: '1px solid #e0e0e0', borderRadius: 10,
  boxShadow: '0 6px 20px rgba(0,0,0,0.12)', maxHeight: 240, overflowY: 'auto',
  listStyle: 'none', margin: 0, padding: '4px 0',
};
const optStyle = { padding: '9px 12px', cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const optMuted = { padding: '9px 12px', fontSize: 13, color: 'var(--muted)' };
