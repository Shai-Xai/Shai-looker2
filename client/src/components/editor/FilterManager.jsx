// Lightweight dashboard-filter manager. Filters are referenced by `name`;
// tiles wire their own query field to a filter via the tile editor. The
// model/explore/field here only power value suggestions in the filter bar.
export default function FilterManager({ filters, onChange, onClose }) {
  function update(idx, updates) {
    onChange(filters.map((f, i) => (i === idx ? { ...f, ...updates } : f)));
  }
  function add() {
    onChange([
      ...filters,
      {
        id: crypto.randomUUID(),
        name: `filter_${filters.length + 1}`,
        title: 'New filter',
        type: 'field_filter',
        default_value: '',
        model: null,
        explore: null,
        field: null,
        ui_config: { type: 'tag_list' },
      },
    ]);
  }
  function remove(idx) {
    onChange(filters.filter((_, i) => i !== idx));
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <div style={head}>
          <span style={{ fontWeight: 700, fontSize: 15, flex: 1 }}>Dashboard filters</span>
          <button style={closeBtn} onClick={onClose}>✕</button>
        </div>
        <div style={{ padding: 16, overflowY: 'auto' }}>
          {filters.length === 0 && <p style={{ color: 'var(--muted)', fontSize: 13 }}>No filters yet.</p>}
          {filters.map((f, i) => (
            <div key={f.id} style={row}>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <L>
                  Title
                  <input style={inp} value={f.title} onChange={(e) => update(i, { title: e.target.value })} />
                </L>
                <L>
                  Name (key)
                  <input style={inp} value={f.name} onChange={(e) => update(i, { name: e.target.value.replace(/\s+/g, '_') })} />
                </L>
                <button style={del} title="Remove" onClick={() => remove(i)}>✕</button>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <L>
                  Default value
                  <input style={inp} value={f.default_value} onChange={(e) => update(i, { default_value: e.target.value })} placeholder="optional" />
                </L>
                <L>
                  Suggest field
                  <input style={inp} value={f.field || ''} onChange={(e) => update(i, { field: e.target.value || null })} placeholder="e.g. orders.status" />
                </L>
              </div>
            </div>
          ))}
          <button style={addBtn} onClick={add}>+ Add filter</button>
        </div>
        <div style={{ padding: '12px 16px', borderTop: '1px solid #e0e0e0', textAlign: 'right' }}>
          <button style={doneBtn} onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

function L({ children }) {
  const [label, control] = Array.isArray(children) ? children : [null, children];
  return (
    <label style={{ flex: 1, fontSize: 11, fontWeight: 600, color: 'var(--muted)' }}>
      {label}
      {control}
    </label>
  );
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 };
const modal = { background: '#fff', borderRadius: 12, width: 560, maxWidth: '92vw', maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 40px rgba(0,0,0,0.2)' };
const head = { display: 'flex', alignItems: 'center', padding: '16px 18px', borderBottom: '1px solid #e0e0e0' };
const row = { border: '1px solid #eee', borderRadius: 8, padding: 12, marginBottom: 10 };
const inp = { width: '100%', padding: '6px 9px', border: '1.5px solid #e0e0e0', borderRadius: 6, fontSize: 13, outline: 'none', marginTop: 3, boxSizing: 'border-box', fontWeight: 400 };
const closeBtn = { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 16, color: '#888' };
const del = { border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--error)', fontSize: 14, alignSelf: 'flex-end', paddingBottom: 8 };
const addBtn = { padding: '8px 14px', background: '#f7f7f7', border: '1.5px solid #e0e0e0', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const doneBtn = { padding: '8px 18px', background: 'var(--brand)', color: '#fff', border: 'none', borderRadius: 7, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
