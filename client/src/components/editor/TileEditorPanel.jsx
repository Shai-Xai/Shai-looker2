import ExploreBrowser from './ExploreBrowser.jsx';

const VIS_TYPES = [
  { value: 'single_value', label: 'Metric / KPI card' },
  { value: 'looker_grid', label: 'Table' },
  { value: 'looker_column', label: 'Column chart' },
  { value: 'looker_bar', label: 'Bar chart' },
  { value: 'looker_line', label: 'Line chart' },
  { value: 'looker_area', label: 'Area chart' },
  { value: 'looker_pie', label: 'Pie chart' },
  { value: 'bar_gauge', label: 'Bar gauge' },
];

// Configuration panel for a single tile. Mutations are applied immutably and
// passed back via onChange — the live preview re-runs the query automatically.
export default function TileEditorPanel({ tile, dashboardFilters, onChange, onClose }) {
  function patch(updates) {
    onChange({ ...tile, ...updates });
  }
  function patchQuery(updates) {
    patch({ query: { ...(tile.query || {}), ...updates } });
  }

  // ExploreBrowser change: replace model/view/fields, prune stale sorts & wiring.
  function handleExploreChange(next) {
    const fields = next.fields || [];
    const sorts = (tile.query?.sorts || []).filter((s) => fields.some((f) => s.startsWith(f)));
    const listenTo = Object.fromEntries(
      Object.entries(tile.listenTo || {}).filter(([, field]) => fields.includes(field))
    );
    patch({
      query: {
        ...(tile.query || {}),
        model: next.model,
        view: next.view,
        fields,
        sorts: sorts.length ? sorts : null,
        limit: tile.query?.limit || '500',
      },
      listenTo,
    });
  }

  const selectedFields = tile.query?.fields || [];
  const sort = (tile.query?.sorts || [])[0] || '';
  const sortField = sort.split(' ')[0] || '';
  const sortDir = sort.includes(' desc') ? 'desc' : 'asc';

  function setSort(field, dir) {
    if (!field) return patchQuery({ sorts: null });
    patchQuery({ sorts: [`${field} ${dir}`] });
  }

  return (
    <div style={panel}>
      <div style={header}>
        <span style={{ fontWeight: 700, fontSize: 14, flex: 1 }}>Edit tile</span>
        <button style={closeBtn} onClick={onClose}>✕</button>
      </div>

      <div style={body}>
        {/* Type */}
        <Label>Tile type</Label>
        <div style={{ display: 'flex', gap: 8 }}>
          <Toggle active={tile.type !== 'text'} onClick={() => patch({ type: 'vis' })}>Visualization</Toggle>
          <Toggle active={tile.type === 'text'} onClick={() => patch({ type: 'text' })}>Text</Toggle>
        </div>

        <Label>Title</Label>
        <input style={input} value={tile.title || ''} onChange={(e) => patch({ title: e.target.value })} placeholder="Tile title" />

        {tile.type === 'text' ? (
          <>
            <Label>Body (markdown)</Label>
            <textarea
              style={{ ...input, minHeight: 140, fontFamily: 'inherit', resize: 'vertical' }}
              value={tile.body_text || ''}
              onChange={(e) => patch({ body_text: e.target.value })}
              placeholder="**Bold**, *italic*, [links](https://…)"
            />
          </>
        ) : (
          <>
            <div style={divider} />
            <Label>Visualization</Label>
            <select style={input} value={tile.vis?.type || 'looker_column'} onChange={(e) => patch({ vis: { ...(tile.vis || {}), type: e.target.value } })}>
              {VIS_TYPES.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
            </select>

            <div style={divider} />
            <SectionTitle>Data</SectionTitle>
            <ExploreBrowser query={tile.query} onChange={handleExploreChange} />

            {selectedFields.length > 0 && (
              <>
                <div style={divider} />
                <Label>Sort by</Label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <select style={{ ...input, flex: 1 }} value={sortField} onChange={(e) => setSort(e.target.value, sortDir)}>
                    <option value="">No sort</option>
                    {selectedFields.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                  <select style={{ ...input, width: 100 }} value={sortDir} onChange={(e) => setSort(sortField, e.target.value)} disabled={!sortField}>
                    <option value="desc">Desc</option>
                    <option value="asc">Asc</option>
                  </select>
                </div>

                <Label>Row limit</Label>
                <input style={input} type="number" min="1" value={tile.query?.limit || '500'} onChange={(e) => patchQuery({ limit: String(e.target.value) })} />

                {dashboardFilters?.length > 0 && (
                  <>
                    <div style={divider} />
                    <SectionTitle>Respond to filters</SectionTitle>
                    {dashboardFilters.map((f) => (
                      <div key={f.id} style={{ marginBottom: 8 }}>
                        <Label>{f.title || f.name}</Label>
                        <select
                          style={input}
                          value={tile.listenTo?.[f.name] || ''}
                          onChange={(e) => {
                            const next = { ...(tile.listenTo || {}) };
                            if (e.target.value) next[f.name] = e.target.value;
                            else delete next[f.name];
                            patch({ listenTo: next });
                          }}
                        >
                          <option value="">— not linked —</option>
                          {selectedFields.map((field) => <option key={field} value={field}>{field}</option>)}
                        </select>
                      </div>
                    ))}
                  </>
                )}
              </>
            )}

            <div style={divider} />
            <Label>AI context (for insights)</Label>
            <textarea
              style={{ ...input, minHeight: 70, fontFamily: 'inherit', resize: 'vertical' }}
              value={tile.aiContext || ''}
              onChange={(e) => patch({ aiContext: e.target.value })}
              placeholder="What this tile means, how to read it, caveats — used by AI insights & the dashboard summary."
            />
          </>
        )}
      </div>
    </div>
  );
}

function Label({ children }) {
  return <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', margin: '14px 0 5px' }}>{children}</div>;
}
function SectionTitle({ children }) {
  return <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text)' }}>{children}</div>;
}
function Toggle({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1, padding: '8px 10px', fontSize: 13, fontWeight: 600, cursor: 'pointer', borderRadius: 6,
        border: active ? '1.5px solid var(--brand)' : '1.5px solid #e0e0e0',
        background: active ? 'var(--brand)' : '#fff',
        color: active ? '#fff' : 'var(--text)',
      }}
    >{children}</button>
  );
}

const panel = { width: 320, flexShrink: 0, background: '#fff', borderLeft: '1px solid #e0e0e0', display: 'flex', flexDirection: 'column', height: '100%' };
const header = { display: 'flex', alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid #e0e0e0' };
const body = { flex: 1, overflowY: 'auto', padding: '4px 16px 24px' };
const closeBtn = { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 15, color: '#888' };
const input = { width: '100%', padding: '8px 10px', border: '1.5px solid #e0e0e0', borderRadius: 6, fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const divider = { borderTop: '1px solid #eee', margin: '16px 0 0' };
