import { useState, useRef, useEffect } from 'react';
import { useIsMobile } from '../lib/useIsMobile.js';
import { useScope } from '../lib/ScopeContext.jsx';
import { useSheetDrag } from '../lib/useSheetDrag.js';
import { ANY_VALUE, ANY_VALUE_LABEL } from '../lib/filterConstants.js';

// Mobile filter bottom sheet: animated entrance + drag-to-dismiss via the grip.
function FilterSheet({ onClose, children }) {
  const drag = useSheetDrag(onClose);
  return (
    <div className="ai-overlay" style={sheetBackdrop} onClick={onClose}>
      <div className="ai-sheet" style={{ ...sheet, ...drag.style }} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" {...drag.handlers} />
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 14 }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, flex: 1 }}>Filters</h3>
          <button onClick={onClose} style={doneBtn}>Done</button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>{children}</div>
      </div>
    </div>
  );
}

// Counts the filters that currently have a value — used for the trigger badge.
export function activeFilterCount(filters, values) {
  return filters.filter(f => (values[f.name] ?? '') !== '').length;
}

// On desktop the trigger button lives in the page header (passed `open` /
// `onClose`); this component then renders only the panel of controls when open.
// On mobile it stays self-contained: a "Filters" trigger + bottom sheet, since
// the suite view hides its header there.
export default function FilterBar({ filters, values, onChange, locked = {}, open = false, onClose, viewActions = null, lockEdit = null }) {
  const isMobile = useIsMobile();

  // Per-filter admin lock editing: a locked filter is read-only until the admin
  // clicks its 🔒 (onUnlock) — then it's editable with a "🔒 Lock" button that
  // saves and re-locks. A free filter shows a "🔓 Lock here" to pin it.
  const controls = filters.map(filter => {
    const name = filter.name;
    const isLocked = !!locked[name];
    const adminEdit = !!lockEdit?.canEdit;
    const editingThis = adminEdit && lockEdit.isEditing(name);
    const showLocked = isLocked && !editingThis;
    const saving = adminEdit && lockEdit.savingName === name;
    return (
      <div key={filter.id} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
        <FilterControl
          filter={filter}
          value={values[name] ?? ''}
          onChange={val => onChange(name, val)}
          locked={showLocked}
          onLockClick={showLocked && adminEdit ? () => lockEdit.onUnlock(name) : null}
        />
        {adminEdit && !showLocked && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {isLocked ? (
              <>
                <button type="button" onClick={() => lockEdit.onRelock(name)} disabled={saving} style={lockActionBtn} title="Save this value and lock it on this dashboard">{saving ? 'Saving…' : '🔒 Lock'}</button>
                {lockEdit.hasOverride?.(name) && <button type="button" onClick={() => lockEdit.onInherit(name)} disabled={saving} style={lockLinkBtn} title="Drop this dashboard's override and follow the suite-wide lock">↺ Use suite lock</button>}
              </>
            ) : (
              <button type="button" onClick={() => lockEdit.onLockHere(name)} disabled={saving} style={lockLinkBtn} title="Lock this filter on this dashboard for this client">{saving ? 'Saving…' : '🔓 Lock here'}</button>
            )}
          </div>
        )}
      </div>
    );
  });

  // Mobile: the trigger now lives in the ☰ Menu bar (ViewPage drives `open`),
  // so here we only render the bottom sheet itself.
  if (isMobile) {
    return open ? <FilterSheet onClose={onClose}>{controls}<FilterViewFooter va={viewActions} lockStatus={lockEdit?.status} /></FilterSheet> : null;
  }

  // Desktop: the header owns the toggle. Render nothing until opened, then drop
  // down a panel of the filter controls.
  if (!open) return null;
  return (
    <div style={{ background: 'var(--card)', borderBottom: '1px solid var(--hairline)', padding: '14px 22px' }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', flex: 1 }}>Filters</h3>
        {onClose && <button onClick={onClose} style={doneBtn}>Done</button>}
      </div>
      {lockEdit?.canEdit && (
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: '0 0 12px' }}>🔒 = locked for this client. Click a lock to edit it on this dashboard, then lock it again to save.</p>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end' }}>
        {controls}
      </div>
      <FilterViewFooter va={viewActions} lockStatus={lockEdit?.status} />
    </div>
  );
}

// Save/reset the current filter selection: a per-user "save my view" (re-opens
// with these next time), and — for admins — set them as the client's default.
function FilterViewFooter({ va, lockStatus }) {
  const hasVa = va && (va.onSave || va.hasSaved || va.canSetDefault || va.note || va.status);
  if (!hasVa && !lockStatus) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--hairline)' }}>
      {va?.onSave && <button onClick={va.onSave} style={saveViewBtn}>Save filters</button>}
      {va?.hasSaved && <button onClick={va.onReset} style={linkBtn}>Reset to default</button>}
      {va?.canSetDefault && <button onClick={va.onSetDefault} style={linkBtn} title="Make these the default for everyone on this client">Set as client default</button>}
      {va?.note && <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>{va.note}</span>}
      {(va?.status || lockStatus) && <span style={{ fontSize: 12.5, color: 'var(--muted)', marginLeft: 'auto' }}>{va?.status || lockStatus}</span>}
    </div>
  );
}

const filterTrigger = { display: 'inline-flex', alignItems: 'center', gap: 8, padding: '9px 16px', background: 'rgba(128,128,128,0.15)', color: 'var(--text)', border: 'none', borderRadius: 980, fontSize: 14, fontWeight: 600, cursor: 'pointer' };
const countPill = { background: 'var(--brand)', color: '#fff', fontSize: 11, fontWeight: 700, borderRadius: 980, minWidth: 18, height: 18, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 5px' };
const sheetBackdrop = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1000, display: 'flex', alignItems: 'flex-end' };
const sheet = { background: 'var(--card)', width: '100%', maxHeight: '80dvh', overflowY: 'auto', borderRadius: '18px 18px 0 0', padding: '18px 18px calc(18px + env(safe-area-inset-bottom))', boxShadow: '0 -4px 24px rgba(0,0,0,0.2)' };
const doneBtn = { padding: '7px 16px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const saveViewBtn = { minHeight: 40, padding: '8px 18px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 980, fontSize: 13.5, fontWeight: 600, cursor: 'pointer' };
const linkBtn = { minHeight: 40, padding: '8px 12px', background: 'transparent', color: 'var(--text)', border: 'none', borderRadius: 980, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const lockActionBtn = { alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 11px', borderRadius: 980, fontSize: 11.5, fontWeight: 700, cursor: 'pointer', border: '1px solid var(--brand)', color: '#fff', background: 'var(--brand)' };
const lockLinkBtn = { alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 9px', borderRadius: 980, fontSize: 11, fontWeight: 700, cursor: 'pointer', border: '1px solid var(--hairline)', color: 'var(--muted)', background: 'transparent' };

// A scoped, non-editable filter (the client's organiser/event). Shows the
// value with a lock so it's clear it's fixed to their account.
function LockedField({ filter, value, onLockClick }) {
  return (
    <div style={fieldStyle}>
      <label style={labelStyle}>{filter.title}</label>
      <div
        style={{ ...inputStyle, background: 'var(--elevated)', color: 'var(--muted-2)', display: 'flex', alignItems: 'center', gap: 6, cursor: onLockClick ? 'pointer' : 'not-allowed', ...(onLockClick ? { borderColor: 'var(--brand)' } : null) }}
        title={onLockClick ? 'Admin: click the lock to edit this filter on this dashboard' : 'Locked to your account'}
        onClick={onLockClick || undefined}
      >
        <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value || '—'}</span>
        <span style={{ fontSize: 12, color: onLockClick ? 'var(--brand)' : undefined }}>🔒</span>
      </div>
    </div>
  );
}

// Looker UI types that allow selecting several values at once.
const MULTI_TYPES = new Set(['checkboxes', 'tag_list', 'advanced']);

// Looker numeric range value, e.g. "[26,360]" / "(0,100)" — bracket = inclusive,
// paren = exclusive. Empty ends are allowed: "[26,]".
const RANGE_RE = /^\s*([[(])\s*(-?\d+(?:\.\d+)?)?\s*,\s*(-?\d+(?:\.\d+)?)?\s*([\])])\s*$/;

function FilterControl({ filter, value, onChange, locked, onLockClick }) {
  if (locked) return <LockedField filter={filter} value={value} onLockClick={onLockClick} />;
  const uiType = filter.ui_config?.type;
  const isDate = uiType === 'relative_timeframes' || uiType === 'date_range_picker' || filter.type === 'date_filter';
  const field = filter.field || filter.dimension;
  const opts = filter.ui_config?.options || {};
  // Numeric range (Looker "advanced" on a number field): a bracketed range, or
  // min/max bounds declared on the filter.
  const isRange = uiType === 'advanced' && (RANGE_RE.test(String(value || filter.default_value || '')) || opts.min != null || opts.max != null);
  const canSuggest = !isDate && !isRange && !!(filter.model && filter.explore && field);

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
      ) : isRange ? (
        <RangeFilter value={value || filter.default_value} onChange={onChange} opts={opts} />
      ) : canSuggest ? (
        <FilterDropdown filter={filter} value={value} onChange={onChange} multi={MULTI_TYPES.has(uiType)} />
      ) : (
        <input type="text" value={value} onChange={e => onChange(e.target.value)} placeholder="Filter value…" style={inputStyle} />
      )}
    </div>
  );
}

// Looker-style "is in range" control: two editable number inputs, writing back
// the bracketed range expression (preserving inclusive/exclusive brackets).
function RangeFilter({ value, onChange, opts }) {
  const m = RANGE_RE.exec(String(value || ''));
  const lb = m ? m[1] : '[';
  const rb = m ? m[4] : ']';
  const lo = m ? (m[2] ?? '') : '';
  const hi = m ? (m[3] ?? '') : '';
  const write = (nlo, nhi) => onChange(`${lb}${nlo === '' ? '' : nlo},${nhi === '' ? '' : nhi}${rb}`);
  return (
    <div style={rangeWrap}>
      <span style={rangeOp}>is in range</span>
      <input type="number" value={lo} min={opts.min} max={opts.max} onChange={(e) => write(e.target.value, hi)} style={rangeInput} aria-label="from" />
      <span style={{ color: 'var(--muted)', fontSize: 12 }}>to</span>
      <input type="number" value={hi} min={opts.min} max={opts.max} onChange={(e) => write(lo, e.target.value)} style={rangeInput} aria-label="to" />
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

  const isAny = value === ANY_VALUE;
  const selected = multi && !isAny ? String(value || '').split(',').map(s => s.trim()).filter(Boolean) : [];

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
      // Suggestions are either plain strings or { value, label } objects (e.g.
      // events that show their start date). Normalise to objects so the list
      // logic below is uniform; `value` is always what gets selected.
      setAll((data.suggestions || []).map((s) => (
        typeof s === 'string' ? { value: s, label: s } : { value: String(s.value), label: s.label || String(s.value) }
      )));
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

  const ql = query.toLowerCase();
  const filtered = query ? all.filter(o => o.label.toLowerCase().includes(ql) || o.value.toLowerCase().includes(ql)) : all;

  // Single-select: pick replaces value and closes. Multi-select: toggle the
  // value in/out and keep the list open so several can be chosen.
  const pickSingle = (s) => { onChange(s); setOpen(false); setQuery(''); };
  const toggleMulti = (s) => {
    const next = selected.includes(s) ? selected.filter(x => x !== s) : [...selected, s];
    onChange(next.join(','));
  };

  const summary = isAny
    ? ANY_VALUE_LABEL
    : multi
      ? (selected.length === 0 ? '' : selected.length === 1 ? selected[0] : `${selected.length} selected`)
      : value;
  const placeholder = isAny
    ? ANY_VALUE_LABEL
    : multi
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
          {/* "Any value" overrides the tile's own default to show every value —
              distinct from Clear, which reverts to that default. */}
          <li
            onMouseDown={(e) => { e.preventDefault(); onChange(ANY_VALUE); setOpen(false); setQuery(''); }}
            style={{ ...optStyle, display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, ...(isAny ? { background: 'rgba(var(--brand-rgb), 0.15)', color: 'var(--brand)' } : null) }}
            onMouseEnter={e => { if (!isAny) e.currentTarget.style.background = 'rgba(128,128,128,0.12)'; }}
            onMouseLeave={e => { if (!isAny) e.currentTarget.style.background = 'transparent'; }}
          >
            <span>✲</span><span>{ANY_VALUE_LABEL}</span><span style={{ color: 'var(--muted)', fontWeight: 400 }}>· show all</span>
          </li>
          {(isAny || (multi ? selected.length > 0 : !!value)) && (
            <li onMouseDown={() => { onChange(''); if (!multi) setOpen(false); }} style={{ ...optStyle, color: 'var(--muted)' }}>
              ✕ Clear{multi && selected.length > 1 ? ' all' : ''}
            </li>
          )}
          {loading ? (
            <li style={optMuted}>Loading…</li>
          ) : filtered.length === 0 ? (
            <li style={optMuted}>{query ? 'No matches' : 'No options'}</li>
          ) : (
            filtered.slice(0, 300).map((o, i) => {
              const isSel = multi ? selected.includes(o.value) : o.value === value;
              return (
                <li
                  key={i}
                  onMouseDown={(e) => { e.preventDefault(); multi ? toggleMulti(o.value) : pickSingle(o.value); }}
                  style={{ ...optStyle, display: 'flex', alignItems: 'flex-start', gap: 8, ...(isSel ? { background: 'rgba(var(--brand-rgb), 0.15)', fontWeight: 600 } : null) }}
                  onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = 'rgba(128,128,128,0.12)'; }}
                  onMouseLeave={e => { if (!isSel) e.currentTarget.style.background = 'transparent'; }}
                >
                  {multi && <span style={{ color: isSel ? 'var(--brand)' : '#bbb', flexShrink: 0 }}>{isSel ? '☑' : '☐'}</span>}
                  <span style={{ minWidth: 0 }} title={o.label}>{o.label}</span>
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
const inputStyle = { padding: '9px 12px', border: '1px solid var(--hairline)', borderRadius: 10, fontSize: 13, outline: 'none', width: '100%', background: 'var(--card)', boxSizing: 'border-box' };
const rangeWrap = { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', border: '1px solid var(--hairline)', borderRadius: 10, background: 'var(--card)' };
const rangeOp = { fontSize: 12, color: 'var(--muted-2)', fontWeight: 600, whiteSpace: 'nowrap' };
const rangeInput = { width: 64, padding: '6px 8px', border: '1px solid var(--hairline)', borderRadius: 8, fontSize: 13, outline: 'none', textAlign: 'center', background: 'var(--card)', boxSizing: 'border-box' };
const caretStyle = { position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 11, color: '#888', pointerEvents: 'auto', cursor: 'pointer' };
// The panel may grow WIDER than its input (long event names) and long labels
// wrap to a second line — options were ellipsizing into five identical
// "Kappa FuturFestiva…" rows you couldn't tell apart.
const dropdownList = {
  position: 'absolute', top: '100%', left: 0, zIndex: 100, marginTop: 4,
  minWidth: '100%', width: 'max-content', maxWidth: 'min(440px, calc(100vw - 40px))',
  background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 10,
  boxShadow: '0 6px 20px rgba(0,0,0,0.12)', maxHeight: 280, overflowY: 'auto',
  listStyle: 'none', margin: 0, padding: '4px 0',
};
const optStyle = { padding: '9px 12px', cursor: 'pointer', fontSize: 13, whiteSpace: 'normal', wordBreak: 'break-word', lineHeight: 1.35 };
const optMuted = { padding: '9px 12px', fontSize: 13, color: 'var(--muted)' };
