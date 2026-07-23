import { useState, useRef, useEffect, useMemo, useId } from 'react';

// A type-to-search replacement for a native <select> over long option lists
// (e.g. every available Looker dimension). Mobile-first: a full-width tap
// target opens a panel with a search box + filtered, grouped list. Matches on
// each option's visible label AND its `keywords` (pass the underlying field key
// there so admins can search by either). Behaviour mirrors a select — one value
// in, one value out — so it drops in wherever a <select> lived.
//
// options: [{ value, label, group?, keywords? }]  (group = optgroup heading)
export default function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = 'Choose…',
  emptyLabel = null, // extra "clear"/none row rendered at the top (value '')
  minWidth = 240,
  ariaLabel,
  disabled = false,
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const listId = useId();

  const selected = options.find((o) => o.value === value);
  const buttonLabel = selected ? selected.label : (placeholder);

  const ql = q.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (!ql) return options;
    return options.filter((o) =>
      String(o.label || '').toLowerCase().includes(ql) ||
      String(o.keywords || '').toLowerCase().includes(ql) ||
      String(o.value || '').toLowerCase().includes(ql));
  }, [ql, options]);

  // Preserve incoming order while collecting group headings.
  const groups = useMemo(() => {
    const order = [];
    const byGroup = new Map();
    for (const o of filtered) {
      const g = o.group || '';
      if (!byGroup.has(g)) { byGroup.set(g, []); order.push(g); }
      byGroup.get(g).push(o);
    }
    return order.map((g) => ({ label: g, items: byGroup.get(g) }));
  }, [filtered]);

  // Close on outside click; focus the search box when opening.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('touchstart', onDown); clearTimeout(t); };
  }, [open]);

  const choose = (v) => { onChange(v); setOpen(false); setQ(''); };

  return (
    <div ref={wrapRef} style={{ position: 'relative', minWidth, flex: '0 1 auto' }}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        style={{ ...triggerBtn, minWidth, color: selected ? 'var(--text)' : 'var(--muted)', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1 }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{buttonLabel}</span>
        <span aria-hidden style={{ flexShrink: 0, opacity: 0.6, fontSize: 10 }}>▾</span>
      </button>
      {open && (
        <div style={panel}>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setOpen(false); setQ(''); }
              else if (e.key === 'Enter' && filtered.length === 1) { e.preventDefault(); choose(filtered[0].value); }
            }}
            placeholder="Type to search…"
            aria-label="Search fields"
            style={searchInput}
          />
          <ul id={listId} role="listbox" style={list}>
            {emptyLabel != null && !ql && (
              <li role="option" aria-selected={!value} style={{ ...item, color: 'var(--muted)' }} onMouseDown={(e) => { e.preventDefault(); choose(''); }}>{emptyLabel}</li>
            )}
            {filtered.length === 0 ? (
              <li style={muted}>No fields match “{q}”</li>
            ) : (
              groups.map((g) => (
                <li key={g.label} style={{ listStyle: 'none' }}>
                  {g.label && <div style={groupHead}>{g.label}</div>}
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                    {g.items.map((o) => {
                      const on = o.value === value;
                      return (
                        <li
                          key={o.value}
                          role="option"
                          aria-selected={on}
                          onMouseDown={(e) => { e.preventDefault(); choose(o.value); }}
                          style={{ ...item, background: on ? 'var(--elevated)' : 'transparent', fontWeight: on ? 700 : 500 }}
                        >
                          {o.label}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

const triggerBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, width: '100%', padding: '8px 10px', border: '1.5px solid var(--hairline)', borderRadius: 7, fontSize: 13, background: 'var(--card)', textAlign: 'left', boxSizing: 'border-box' };
const panel = { position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 60, marginTop: 4, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 6px 20px rgba(0,0,0,0.12)', minWidth: 240, overflow: 'hidden' };
const searchInput = { width: '100%', padding: '9px 12px', border: 'none', borderBottom: '1px solid var(--hairline)', fontSize: 14, outline: 'none', background: 'transparent', color: 'var(--text)', boxSizing: 'border-box' };
const list = { listStyle: 'none', margin: 0, padding: '4px 0', maxHeight: 260, overflowY: 'auto' };
const item = { padding: '8px 12px', fontSize: 13, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const muted = { padding: '10px 12px', fontSize: 13, color: 'var(--muted)' };
const groupHead = { padding: '6px 12px 2px', fontSize: 10.5, fontWeight: 800, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--muted)' };
