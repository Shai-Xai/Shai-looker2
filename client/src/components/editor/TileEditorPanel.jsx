import { useState } from 'react';
import { createPortal } from 'react-dom';
import ExploreBrowser from './ExploreBrowser.jsx';
import CaseBuilder, { parseCaseWhen, parseNumericCase } from './CaseBuilder.jsx';
import { useTileData, isRunnableQuery } from '../../lib/useTileData.js';

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
export default function TileEditorPanel({ tile, dashboardFilters, filterValues = {}, onChange, onClose }) {
  const [showResults, setShowResults] = useState(false);
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

  return (
    <div style={panel}>
      <div style={header}>
        <span style={{ fontWeight: 700, fontSize: 14, flex: 1 }}>Edit tile</span>
        {tile.type !== 'text' && isRunnableQuery(tile.query) && (
          <button style={resultsBtn} onClick={() => setShowResults(true)} title="See this tile's query results as a table">▦ Results</button>
        )}
        <button style={closeBtn} onClick={onClose}>✕</button>
      </div>
      {showResults && <TileResultsModal tile={tile} filterValues={filterValues} onClose={() => setShowResults(false)} />}

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
                <SortEditor query={tile.query} fields={selectedFields} onChange={patchQuery} />

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

            <TableCalcEditor query={tile.query} onChange={patchQuery} />

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

// Parse a Looker sort string ("view.field desc") into { field, dir }. Field
// names never contain spaces, so a trailing " asc"/" desc" is the direction;
// anything else defaults to ascending (Looker's implicit default).
function parseSort(s) {
  const str = String(s).trim();
  const m = str.match(/\s+(asc|desc)$/i);
  return m ? { field: str.slice(0, m.index).trim(), dir: m[1].toLowerCase() } : { field: str, dir: 'asc' };
}

// Multi-field sort editor for a tile. Sorts live on the query as an array of
// Looker sort strings in PRIORITY order — the first is the primary sort, so e.g.
// putting "start year" first groups every event in the same year together before
// a secondary sort orders within each group. Users can add fields, flip
// asc/desc, reorder priority, and remove any sort. It reuses the tile's existing
// query.sorts schema, so a saved sort matches any other tile edit and round-trips
// to Looker unchanged. (Replaces the old single-sort control that only exposed
// sorts[0] and dropped the rest — the read-only-sort problem this fixes.)
function SortEditor({ query, fields, onChange }) {
  // Only surface sorts whose field is still selected (a pruned field can leave a
  // stale sort string behind); those are ignored here and cleaned on next commit.
  const sorts = (query?.sorts || []).map(parseSort).filter((s) => fields.includes(s.field));
  const used = new Set(sorts.map((s) => s.field));
  const available = fields.filter((f) => !used.has(f));

  const commit = (next) => onChange({ sorts: next.length ? next.map((s) => `${s.field} ${s.dir}`) : null });
  const setField = (i, field) => commit(sorts.map((s, j) => (j === i ? { ...s, field } : s)));
  const setDir = (i, dir) => commit(sorts.map((s, j) => (j === i ? { ...s, dir } : s)));
  const remove = (i) => commit(sorts.filter((_, j) => j !== i));
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= sorts.length) return;
    const n = sorts.slice();
    [n[i], n[j]] = [n[j], n[i]];
    commit(n);
  };
  const add = () => { if (available.length) commit([...sorts, { field: available[0], dir: 'asc' }]); };

  return (
    <>
      <div style={divider} />
      <Label>Sort by</Label>
      {sorts.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>No sort — rows come back in the query's default order.</div>
      )}
      {sorts.map((s, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
          {sorts.length > 1 && (
            <span
              title={i === 0 ? 'Primary sort — groups rows by this field first' : `Sort priority ${i + 1}`}
              style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', minWidth: 14, textAlign: 'center' }}
            >{i + 1}</span>
          )}
          <select style={{ ...input, flex: 1, minWidth: 120 }} value={s.field} onChange={(e) => setField(i, e.target.value)}>
            {/* this row's field, plus any not already used on another row */}
            {[s.field, ...available].map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          <select style={{ ...input, width: 88 }} value={s.dir} onChange={(e) => setDir(i, e.target.value)}>
            <option value="asc">Asc</option>
            <option value="desc">Desc</option>
          </select>
          {sorts.length > 1 && (
            <>
              <SortIconBtn title="Move up (higher priority)" disabled={i === 0} onClick={() => move(i, -1)}>▲</SortIconBtn>
              <SortIconBtn title="Move down (lower priority)" disabled={i === sorts.length - 1} onClick={() => move(i, 1)}>▼</SortIconBtn>
            </>
          )}
          <SortIconBtn title="Remove this sort field" onClick={() => remove(i)} danger>✕</SortIconBtn>
        </div>
      ))}
      {available.length > 0 && (
        <button type="button" onClick={add} style={addSortBtn}>＋ Add sort field</button>
      )}
    </>
  );
}

function SortIconBtn({ children, onClick, title, disabled, danger }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      style={{
        border: '1px solid var(--hairline)', background: 'var(--card)',
        cursor: disabled ? 'default' : 'pointer',
        color: disabled ? 'var(--hairline)' : danger ? 'var(--error)' : 'var(--muted)',
        borderRadius: 6, minWidth: 34, height: 34, fontSize: 12, lineHeight: 1, padding: 0, flexShrink: 0,
      }}
    >{children}</button>
  );
}

// Surface Looker table calculations (the query's dynamic_fields) so their
// expressions can be read and fixed in-app — e.g. correcting a change formula's
// operand order ("${past} - ${current}" → "${current} - ${past}").
function TableCalcEditor({ query, onChange }) {
  const [rawMode, setRawMode] = useState({}); // calc idx -> show raw expression
  const raw = query?.dynamic_fields;
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'string' && raw.trim()) {
    try { const p = JSON.parse(raw); if (Array.isArray(p)) list = p; } catch { /* leave empty */ }
  }
  const calcs = list.filter((d) => d && typeof d.expression === 'string');
  if (!calcs.length) return null;
  const setExpr = (idx, expr) => {
    const next = list.map((d, i) => (i === idx ? { ...d, expression: expr } : d));
    // Looker expects dynamic_fields as a JSON string; keep that form so the
    // preview's query (and a later sync) stay valid.
    onChange({ dynamic_fields: JSON.stringify(next) });
  };
  return (
    <>
      <div style={divider} />
      <SectionTitle>Table calculations</SectionTitle>
      <div style={{ fontSize: 11.5, color: 'var(--muted)', margin: '5px 0 2px', lineHeight: 1.45 }}>
        Formulas computed on the results (e.g. a change, or buckets like “Local vs International”). Editing re-runs the preview.
      </div>
      {calcs.map((c) => {
        const idx = list.indexOf(c);
        const name = c.label || c.table_calculation || c.measure || c.dimension || `Calculation ${idx + 1}`;
        // A bucketing case/when can be edited with the no-code builder; anything
        // else (or when the user flips to "Expression") shows the raw formula.
        const buildable = !!(parseCaseWhen(c.expression) || parseNumericCase(c.expression));
        const showRaw = rawMode[idx] || !buildable;
        return (
          <div key={idx} style={{ marginTop: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Label>{name}</Label>
              {buildable && (
                <button
                  onClick={() => setRawMode((m) => ({ ...m, [idx]: !m[idx] }))}
                  style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 600, color: 'var(--brand)', background: 'transparent', border: 'none', cursor: 'pointer', padding: '0 0 4px' }}
                >{showRaw ? '◧ Builder' : '✎ Expression'}</button>
              )}
            </div>
            {showRaw ? (
              <textarea
                style={{ ...input, minHeight: 54, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, resize: 'vertical', whiteSpace: 'pre-wrap' }}
                value={c.expression}
                spellCheck={false}
                onChange={(e) => setExpr(idx, e.target.value)}
              />
            ) : (
              <CaseBuilder expression={c.expression} fields={query?.fields || []} onChange={(expr) => setExpr(idx, expr)} />
            )}
          </div>
        );
      })}
    </>
  );
}

// A Looker-style "Results" grid for the tile being edited: runs the tile's own
// query (scoped + filtered exactly as it renders) and shows the rows as a table.
function TileResultsModal({ tile, filterValues, onClose }) {
  const { data, loading, error } = useTileData(tile, filterValues);
  const fields = data?.fields || {};
  const hidden = new Set((tile.vis || {}).hidden_fields || []);
  const cols = [...(fields.dimensions || []), ...(fields.measures || []), ...(fields.table_calculations || [])].filter((f) => !hidden.has(f.name));
  const rows = data?.data || [];
  const cell = (row, f) => { const c = row[f.name]; return c == null ? '' : (c.rendered != null && c.rendered !== '' ? c.rendered : (c.value ?? '')); };
  return createPortal(
    <div style={resOverlay} onClick={onClose}>
      <div style={resCard} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <span style={{ fontSize: 15, fontWeight: 700, flex: 1 }}>Results — {tile.title || 'tile'}</span>
          {!loading && !error && <span style={{ fontSize: 12, color: 'var(--muted)' }}>{rows.length} row{rows.length === 1 ? '' : 's'}</span>}
          <button style={closeBtn} onClick={onClose}>✕</button>
        </div>
        {loading ? (
          <div style={{ padding: 24, color: 'var(--muted)', fontSize: 13 }}>Running query…</div>
        ) : error ? (
          <div style={{ padding: 24, color: 'var(--error)', fontSize: 13 }}>⚠ {error}</div>
        ) : cols.length === 0 ? (
          <div style={{ padding: 24, color: 'var(--muted)', fontSize: 13 }}>No results.</div>
        ) : (
          <div style={{ overflow: 'auto', border: '1px solid var(--hairline)', borderRadius: 8 }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12.5 }}>
              <thead>
                <tr>{cols.map((f) => <th key={f.name} style={resTh}>{f.label_short || f.label || f.name}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr key={i} style={{ background: i % 2 ? 'rgba(128,128,128,0.04)' : 'transparent' }}>
                    {cols.map((f) => <td key={f.name} style={resTd}>{String(cell(row, f))}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>,
    document.body,
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
        border: active ? '1.5px solid var(--brand)' : '1.5px solid var(--hairline)',
        background: active ? 'var(--brand)' : 'var(--card)',
        color: active ? '#fff' : 'var(--text)',
      }}
    >{children}</button>
  );
}

const panel = { width: 320, flexShrink: 0, background: 'var(--card)', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', height: '100%' };
const header = { display: 'flex', alignItems: 'center', padding: '14px 16px', borderBottom: '1px solid var(--border)' };
const body = { flex: 1, overflowY: 'auto', padding: '4px 16px 24px' };
const closeBtn = { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 15, color: '#888' };
const resultsBtn = { border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', cursor: 'pointer', fontSize: 12, fontWeight: 600, borderRadius: 980, padding: '4px 11px', marginRight: 8 };
const resOverlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 600, padding: 24 };
const resCard = { width: 'min(900px, 96vw)', maxHeight: '85vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: 'var(--card)', borderRadius: 14, boxShadow: '0 12px 48px rgba(0,0,0,0.25)', padding: 18 };
const resTh = { textAlign: 'left', padding: '8px 12px', borderBottom: '2px solid var(--hairline)', fontWeight: 700, whiteSpace: 'nowrap', position: 'sticky', top: 0, background: 'var(--card)' };
const resTd = { padding: '7px 12px', borderBottom: '1px solid var(--hairline)', whiteSpace: 'nowrap' };
const input = { width: '100%', padding: '8px 10px', border: '1.5px solid var(--hairline)', borderRadius: 6, fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const addSortBtn = { marginTop: 2, border: '1px dashed var(--hairline)', background: 'transparent', color: 'var(--brand)', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, borderRadius: 6, padding: '8px 12px' };
const divider = { borderTop: '1px solid var(--hairline)', margin: '16px 0 0' };
