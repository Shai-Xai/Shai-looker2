import { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useIsMobile } from '../lib/useIsMobile.js';
import { useSheetDrag } from '../lib/useSheetDrag.js';
import { useScope } from '../lib/ScopeContext.jsx';
import { cellText } from '../lib/format.js';
import { api } from '../lib/api.js';

// "Inspect query" — an EDIT-mode mini-Explore for one tile, styled after
// Looker's Explore view: a fields-in-use rail, the filters in effect, a bar
// visualization and the result grid. It opens showing exactly what drove the
// number on screen, and the controls are LIVE: edit filter values, add/remove
// filters and fields, change the row limit, then ▶ Run to re-query and watch
// the bars + grid update. ▶ Run is a SANDBOX (only the preview changes; Reset
// returns to the tile's real query); ✓ Apply to tile (when the editor wires
// `onApply`) writes the draft query onto the tile in the editor's local draft,
// which the dashboard's Save then publishes. Queries still run through
// /api/run-query, so the server's tenant scoping applies to every run.
//
// The add-field/add-filter pickers come from the explore's field catalogue
// (admin-only endpoint); if it can't load, editing degrades gracefully to the
// fields/filters already on the tile. `detailed` (staff) shows raw internals.
export default function InspectQueryModal({ tile, data, filters, dashboardFields = [], detailed = false, onApply, onClose }) {
  const isMobile = useIsMobile();
  const drag = useSheetDrag(onClose);
  const { suiteId } = useScope();

  const q = useMemo(() => tile.query || {}, [tile.query]);
  const pivotSet = new Set(q.pivots || []);

  // ── Sandbox state: the draft query + the result it produced ────────────────
  const [draftFields, setDraftFields] = useState(() => q.fields || []);
  const [draftFilters, setDraftFilters] = useState(() => Object.entries(filters || {})
    .filter(([, v]) => v != null && String(v).trim() !== '')
    .map(([field, value]) => ({ field, value: String(value) })));
  const [draftLimit, setDraftLimit] = useState(() => Number(q.limit) || 500);
  const [result, setResult] = useState(data);
  const [running, setRunning] = useState(false);
  const [runErr, setRunErr] = useState('');

  // The explore's full field catalogue — powers the add-field / add-filter
  // pickers and labels for fields with no result metadata yet. Admin-gated
  // server-side; a 403 just means no pickers.
  const [catalogue, setCatalogue] = useState(null);
  useEffect(() => {
    if (!q.model || !q.view) return;
    let alive = true;
    api.getExploreFields(q.model, q.view).then((c) => { if (alive) setCatalogue(c); }).catch(() => {});
    return () => { alive = false; };
  }, [q.model, q.view]);

  // Field metadata lookup: catalogue first, then the last result, then heuristic.
  const metaByName = useMemo(() => {
    const m = {};
    for (const f of result?.fields?.dimensions || []) m[f.name] = { ...f, kind: 'dimension' };
    for (const f of result?.fields?.measures || []) m[f.name] = { ...f, kind: 'measure' };
    for (const f of result?.fields?.table_calculations || []) m[f.name] = { ...f, kind: 'calc' };
    for (const f of catalogue?.dimensions || []) m[f.name] = { ...m[f.name], ...f, kind: 'dimension' };
    for (const f of catalogue?.measures || []) m[f.name] = { ...m[f.name], ...f, kind: 'measure' };
    return m;
  }, [result, catalogue]);
  const metaOf = (name) => metaByName[name] || { name, label: humaniseField(name), kind: guessKind(name) };
  const labelOf = (name) => { const f = metaOf(name); return f.label_short || f.label || humaniseField(name); };

  // What the viz + grid render: the LAST RESULT's own field classification —
  // it always matches the rows' keys, even mid-edit before the next Run.
  const dims = result?.fields?.dimensions || [];
  const measures = result?.fields?.measures || [];
  const tableCalcs = result?.fields?.table_calculations || [];
  const rows = result?.data || [];
  const pivots = result?.pivots || [];

  const dashSet = new Set(dashboardFields || []);
  const tileSet = new Set(Object.keys(q.filters || {}));
  const filteredFields = new Set(draftFilters.filter((f) => String(f.value).trim() !== '').map((f) => f.field));
  const limitReached = rows.length >= draftLimit && rows.length > 0;

  const dirty = useMemo(() => JSON.stringify({ f: draftFields, fl: draftFilters, l: draftLimit })
    !== JSON.stringify({
      f: q.fields || [],
      fl: Object.entries(filters || {}).filter(([, v]) => v != null && String(v).trim() !== '').map(([field, value]) => ({ field, value: String(value) })),
      l: Number(q.limit) || 500,
    }), [draftFields, draftFilters, draftLimit, q, filters]);

  // ── Run the sandbox query (server-scoped like any tile query) ──────────────
  const buildQuery = (filterRows) => {
    const stripDesc = (s) => String(s).replace(/\s+desc$/i, '');
    return {
      ...q,
      fields: draftFields,
      filters: Object.fromEntries(filterRows.filter((f) => f.field && String(f.value).trim() !== '').map((f) => [f.field, f.value])),
      limit: draftLimit,
      sorts: (q.sorts || []).filter((s) => draftFields.includes(stripDesc(s))),
      pivots: (q.pivots || []).filter((p) => draftFields.includes(p)),
    };
  };
  const run = () => {
    if (!draftFields.length || running) return;
    setRunning(true); setRunErr('');
    api.runQuery(buildQuery(draftFilters), {}, undefined, suiteId)
      .then((r) => setResult(r))
      .catch((e) => setRunErr(e.message || 'Query failed'))
      .finally(() => setRunning(false));
  };
  // Write the sandbox back onto the tile (the editor's local draft — the
  // dashboard's Save publishes it). Filters that are just the CURRENT dashboard
  // filter values riding in unchanged stay OUT of the tile's baked query — they
  // keep flowing live via the dashboard's filter wiring; an edited or added
  // value is deliberate, so it bakes in.
  const apply = () => {
    if (!onApply || !draftFields.length) return;
    const rows = draftFilters.filter((f) => !(dashSet.has(f.field) && String(f.value) === String(filters?.[f.field] ?? '')));
    onApply(buildQuery(rows));
    onClose();
  };
  const reset = () => {
    setDraftFields(q.fields || []);
    setDraftFilters(Object.entries(filters || {}).filter(([, v]) => v != null && String(v).trim() !== '').map(([field, value]) => ({ field, value: String(value) })));
    setDraftLimit(Number(q.limit) || 500);
    setResult(data); setRunErr('');
  };

  // Edit helpers.
  const setFilterValue = (i, value) => setDraftFilters((fs) => fs.map((f, j) => (j === i ? { ...f, value } : f)));
  const removeFilter = (i) => setDraftFilters((fs) => fs.filter((_, j) => j !== i));
  const addFilter = (field) => setDraftFilters((fs) => (fs.some((f) => f.field === field) ? fs : [...fs, { field, value: '' }]));
  const removeField = (name) => setDraftFields((fs) => fs.filter((f) => f !== name));
  const addField = (name) => setDraftFields((fs) => (fs.includes(name) ? fs : [...fs, name]));

  // Every field the pickers can offer (catalogue if we have it, else in-use).
  const pickable = useMemo(() => {
    const all = catalogue ? [...(catalogue.dimensions || []), ...(catalogue.measures || [])] : Object.values(metaByName);
    return all.map((f) => ({ name: f.name, label: f.label_short || f.label || f.name }));
  }, [catalogue, metaByName]);

  const sourceOf = (field) => (dashSet.has(field) ? 'Dashboard' : tileSet.has(field) ? 'Tile' : 'Added');

  const panelStyle = isMobile
    ? { ...panel, width: '100%', maxWidth: '100%', height: 'auto', maxHeight: '94dvh', borderRadius: '18px 18px 0 0', paddingBottom: 'env(safe-area-inset-bottom)' }
    : panel;

  const fieldsRail = (
    <FieldsInUse
      names={draftFields} metaOf={metaOf} pivotSet={pivotSet} filteredFields={filteredFields}
      detailed={detailed} onRemove={draftFields.length > 1 ? removeField : null}
      addChoices={pickable.filter((f) => !draftFields.includes(f.name))} onAdd={addField}
    />
  );

  const node = (
    <div className="ai-overlay" style={isMobile ? { ...overlay, alignItems: 'flex-end', justifyContent: 'center' } : overlay} onClick={onClose}>
      <div
        className={isMobile ? 'ai-sheet' : 'ai-panel'}
        style={isMobile ? { ...panelStyle, ...drag.style } : panelStyle}
        onClick={(e) => e.stopPropagation()}
      >
        {isMobile && <div className="sheet-grip" {...drag.handlers} style={{ marginTop: 8 }} />}

        {/* ── Explore-style header: title · result meta · Reset / Run ── */}
        <div style={header}>
          <span style={{ fontSize: 20, lineHeight: 1 }} aria-hidden>🔍</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)' }}>Inspect query</div>
            <div style={{ fontSize: 15, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{tile.title || 'This tile'}</div>
          </div>
          {!isMobile && (
            <div style={{ fontSize: 11.5, color: 'var(--muted)', textAlign: 'right', whiteSpace: 'nowrap' }}>
              {rows.length > 0 && <span>{rows.length}{limitReached ? '+' : ''} row{rows.length === 1 ? '' : 's'}</span>}
              {detailed && q.model && <span> · {q.model}::{q.view}</span>}
            </div>
          )}
          {dirty && <button style={ghostBtn} onClick={reset} title="Back to the tile's real query">Reset</button>}
          {onApply && dirty && (
            <button style={{ ...ghostBtn, color: 'var(--brand)', borderColor: 'var(--brand)' }} onClick={apply} disabled={!draftFields.length}
              title="Write this query onto the tile (the dashboard's Save then publishes it)">
              ✓ Apply to tile
            </button>
          )}
          <button style={runBtn(running || !draftFields.length)} onClick={run} disabled={running || !draftFields.length} title="Re-run the preview with your changes (the tile itself is untouched)">
            {running ? 'Running…' : '▶ Run'}
          </button>
          <button style={isMobile ? { ...closeBtn, fontSize: 22, padding: '6px 10px' } : closeBtn} onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
          {/* ── Left rail (desktop): fields in use, editable ── */}
          {!isMobile && (
            <div style={rail}>
              <div style={railTitle}>In use</div>
              {fieldsRail}
              <div style={{ marginTop: 'auto', paddingTop: 10, fontSize: 10.5, color: 'var(--muted)' }}>
                {draftFields.length} field{draftFields.length === 1 ? '' : 's'} in use
              </div>
            </div>
          )}

          {/* ── Main column: Filters / Visualization / Data ── */}
          <div style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
            <SectionBar label="Filters" right={<AddPicker placeholder="+ Filter" choices={pickable} onPick={addFilter} dark />} />
            <div style={{ padding: '12px 14px' }}>
              {draftFilters.length ? draftFilters.map((f, i) => (
                <FilterRow
                  key={`${f.field}-${i}`}
                  and={i > 0}
                  label={labelOf(f.field)}
                  field={f.field}
                  value={f.value}
                  source={sourceOf(f.field)}
                  detailed={detailed}
                  isMobile={isMobile}
                  onChange={(v) => setFilterValue(i, v)}
                  onRemove={() => removeFilter(i)}
                  onEnter={run}
                />
              )) : <Empty>No filters — add one with “+ Filter” above, then Run.</Empty>}
            </div>

            <SectionBar label="Visualization" />
            <div style={{ padding: '12px 14px' }}>
              {runErr
                ? <div style={{ fontSize: 12.5, color: 'var(--error, #c33)' }}>⚠ {runErr}</div>
                : <VizPreview dims={dims} measures={measures} rows={rows} pivots={pivots} running={running} />}
            </div>

            <SectionBar
              label="Data"
              right={(
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, opacity: 0.95 }}>
                  Results · Row limit
                  <input
                    type="number" min={1} max={5000} value={draftLimit}
                    onChange={(e) => setDraftLimit(Math.max(1, Math.min(5000, Number(e.target.value) || 1)))}
                    onKeyDown={(e) => { if (e.key === 'Enter') run(); }}
                    style={{ width: 62, fontSize: 11, padding: '2px 6px', borderRadius: 6, border: 'none', background: 'rgba(255,255,255,0.14)', color: '#fff' }}
                    aria-label="Row limit"
                  />
                </span>
              )}
            />
            {limitReached && (
              <div style={warnBanner}>⚠ Row limit reached. Results may be incomplete.</div>
            )}
            <div style={{ padding: '12px 14px', opacity: running ? 0.5 : 1, transition: 'opacity .15s' }}>
              <ResultsGrid dims={dims} measures={measures} tableCalcs={tableCalcs} rows={rows} pivots={pivots} filteredFields={filteredFields} />
            </div>

            {/* Mobile: the fields rail becomes a stacked section */}
            {isMobile && (
              <>
                <SectionBar label="Fields in use" right={<span style={{ fontSize: 11, opacity: 0.85 }}>{draftFields.length}</span>} />
                <div style={{ padding: '12px 14px' }}>{fieldsRail}</div>
              </>
            )}

            {detailed && (
              <>
                <SectionBar label="Source" right={<span style={{ fontSize: 11, opacity: 0.85 }}>staff only</span>} />
                <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <MetaRow label="Model" value={q.model} />
                  <MetaRow label="Explore" value={q.view} />
                  {q.sorts?.length > 0 && <MetaRow label="Sorts" value={q.sorts.join(', ')} />}
                  {(q.pivots?.length || 0) > 0 && <MetaRow label="Pivots" value={q.pivots.join(', ')} />}
                </div>
              </>
            )}
          </div>
        </div>

        <div style={{ padding: '10px 18px 14px', fontSize: 11, color: 'var(--muted)', borderTop: '1px solid var(--hairline)', flexShrink: 0 }}>
          Sandbox — edit the filters, fields or row limit and hit <b>Run</b> to re-query; only this preview changes.
          {onApply ? <> Happy with it? <b>✓ Apply to tile</b> writes it onto the tile — the dashboard's Save publishes it.</> : ' The tile keeps its saved query.'}
          {detailed ? ' Staff view — includes raw query internals.' : ''}
        </div>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}

// ─── Fields-in-use rail: grouped by view, Looker Explore style, editable ──────
// Dimensions read plain; measures get the warm tint Looker uses; ≡ marks a
// filtered field, ✕ removes it from the draft, and the search box below adds
// any field from the explore's catalogue.
function FieldsInUse({ names, metaOf, pivotSet, filteredFields, detailed, onRemove, addChoices, onAdd }) {
  const groups = {};
  for (const name of names) {
    const f = metaOf(name);
    const view = String(name).includes('.') ? String(name).split('.')[0] : 'Fields';
    (groups[view] = groups[view] || []).push(f);
  }
  const views = Object.keys(groups).sort();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {views.length === 0 && <Empty>No fields — add one below, then Run.</Empty>}
      {views.map((view) => (
        <div key={view}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>{view === 'Fields' ? 'Fields' : humanise(view)}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {groups[view].map((f) => (
              <div key={f.name} title={detailed ? f.name : undefined} style={{
                display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '3px 8px', borderRadius: 6,
                background: f.kind === 'dimension' ? 'var(--elevated)' : 'var(--warn-tint, rgba(230,150,50,0.14))',
                color: 'var(--text)',
              }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {f.label_short || f.label || humaniseField(f.name)}
                </span>
                {pivotSet.has(f.name) && <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--brand)' }}>PIVOT</span>}
                {filteredFields.has(f.name) && <span title="A filter is narrowing this field" aria-label="Filtered" style={{ fontSize: 11, color: 'var(--brand)' }}>≡</span>}
                {onRemove && (
                  <button onClick={() => onRemove(f.name)} title="Remove this field (then Run)" aria-label={`Remove ${f.name}`}
                    style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--muted)', fontSize: 11, padding: '0 2px', lineHeight: 1 }}>✕</button>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
      {addChoices.length > 0 && <AddPicker placeholder="+ Add field…" choices={addChoices} onPick={onAdd} />}
    </div>
  );
}

// Search-and-pick dropdown (add a field / add a filter). Type to filter the
// explore's catalogue; mousedown picks before blur closes it.
function AddPicker({ placeholder, choices, onPick, dark }) {
  const [qs, setQs] = useState('');
  const [open, setOpen] = useState(false);
  if (!choices.length) return null;
  const ql = qs.trim().toLowerCase();
  const matches = (ql ? choices.filter((f) => f.label.toLowerCase().includes(ql) || f.name.toLowerCase().includes(ql)) : choices).slice(0, 60);
  return (
    <span style={{ position: 'relative', display: 'inline-block', minWidth: dark ? 110 : undefined, width: dark ? undefined : '100%' }}>
      <input
        value={qs}
        onChange={(e) => { setQs(e.target.value); if (!open) setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        aria-label={placeholder}
        style={dark
          ? { width: 120, fontSize: 11, padding: '3px 8px', borderRadius: 6, border: 'none', background: 'rgba(255,255,255,0.14)', color: '#fff' }
          : { width: '100%', boxSizing: 'border-box', fontSize: 12, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)' }}
      />
      {open && (
        <ul style={{ ...ddList, right: dark ? 0 : undefined, left: dark ? undefined : 0 }}>
          {matches.length === 0
            ? <li style={ddMuted}>No matches</li>
            : matches.map((f) => (
              <li key={f.name} style={ddItem} title={f.name}
                onMouseDown={(e) => { e.preventDefault(); onPick(f.name); setQs(''); setOpen(false); }}>
                {f.label}
              </li>
            ))}
        </ul>
      )}
    </span>
  );
}

// ─── One filter row: label · condition · editable value · AND rail ────────────
function FilterRow({ and, label, field, value, source, detailed, isMobile, onChange, onRemove, onEnter }) {
  const advanced = isAdvancedFilter(value);
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 8 }}>
      <span style={{ width: 30, flexShrink: 0, fontSize: 9.5, fontWeight: 700, color: and ? 'var(--brand)' : 'transparent', paddingTop: 8, textAlign: 'center' }}>AND</span>
      <div style={{ flex: 1, minWidth: 0, border: '1px solid var(--hairline)', borderRadius: 10, background: 'var(--elevated)', padding: '8px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>{label}</span>
          <span style={condBox}>{String(value).trim() === '' ? 'is' : advanced ? 'matches (advanced)' : 'is'}</span>
          <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', color: source === 'Dashboard' ? 'var(--brand)' : 'var(--muted)' }}>{source}</span>
          <span style={{ flex: 1 }} />
          <button onClick={onRemove} title="Remove this filter (then Run)" aria-label={`Remove filter on ${field}`}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--muted)', fontSize: 12, padding: 0, lineHeight: 1 }}>✕</button>
        </div>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onEnter?.(); }}
          placeholder="value — e.g. ZAR,NAD · yesterday · >100 · NOT NULL"
          aria-label={`Filter value for ${label}`}
          style={{
            width: '100%', boxSizing: 'border-box', marginTop: 6,
            fontSize: isMobile ? 13 : 12.5, padding: '5px 9px', borderRadius: 7,
            border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)',
            fontFamily: 'var(--mono, ui-monospace, monospace)',
          }}
        />
        {detailed && <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 5, fontFamily: 'var(--mono, ui-monospace, monospace)', wordBreak: 'break-all' }}>{field}</div>}
      </div>
    </div>
  );
}

// ─── Visualization: dimensions + an inline bar for the first measure ───────────
// Mirrors the bar-table Looker's Explore shows. Pivoted queries skip the bars
// (the grid below carries the pivot columns); a single-value tile shows the
// number big instead of a one-bar chart.
const VIZ_ROWS = 12;
function VizPreview({ dims, measures, rows, pivots, running }) {
  const m = measures[0];
  if (!rows.length || !m) return <Empty>{running ? 'Running…' : 'No result to visualize — hit Run.'}</Empty>;
  if (pivots.length > 0) return <Empty>Pivoted result — see the grid below for the pivot columns.</Empty>;
  if (!dims.length) {
    return <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-0.02em', opacity: running ? 0.5 : 1 }}>{cellText(rows[0][m.name])}</div>;
  }
  const vals = rows.map((r) => Math.abs(Number(r[m.name]?.value)) || 0);
  const max = Math.max(...vals.slice(0, VIZ_ROWS), 0);
  const shown = rows.slice(0, VIZ_ROWS);
  return (
    <div style={{ overflowX: 'auto', opacity: running ? 0.5 : 1, transition: 'opacity .15s' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
        <tbody>
          {shown.map((row, i) => (
            <tr key={i} style={{ background: i % 2 ? 'var(--elevated)' : 'transparent' }}>
              <td style={{ padding: '4px 8px', color: 'var(--muted)', width: 24, textAlign: 'right' }}>{i + 1}</td>
              {dims.map((d) => (
                <td key={d.name} style={{ padding: '4px 10px', whiteSpace: 'nowrap', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>{cellText(row[d.name])}</td>
              ))}
              <td style={{ padding: '4px 10px', width: '40%', minWidth: 140 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1, height: 14, background: 'var(--elevated)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ width: `${max > 0 ? (vals[i] / max) * 100 : 0}%`, height: '100%', background: 'var(--brand)', borderRadius: 3, minWidth: vals[i] > 0 ? 2 : 0 }} />
                  </div>
                  <span style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{cellText(row[m.name])}</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > VIZ_ROWS && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>Showing the first {VIZ_ROWS} of {rows.length} rows ({m.label_short || m.label || m.name}).</div>}
    </div>
  );
}

// ─── Results grid: the raw rows behind the tile, Looker column styling ─────────
// Dimension headers grey, measure headers warm-tinted (like Looker's Explore
// data grid). Pivoted queries expand into pivot × measure column groups.
const GRID_ROWS = 50;
function ResultsGrid({ dims, measures, tableCalcs, rows, pivots, filteredFields }) {
  if (!rows.length) return <Empty>No result rows — adjust the query and hit Run.</Empty>;
  const ms = [...measures, ...tableCalcs];
  const pivoted = pivots.length > 0 && ms.length > 0;
  const pLabel = (p) => (p.data ? Object.values(p.data).join(' / ') : p.key);
  const shown = rows.slice(0, GRID_ROWS);
  const th = (warm) => ({
    padding: '6px 10px', textAlign: 'left', fontWeight: 700, fontSize: 11.5, whiteSpace: 'nowrap',
    background: warm ? 'var(--warn-tint, rgba(230,150,50,0.14))' : 'var(--elevated)',
    borderBottom: '2px solid var(--border)', position: 'sticky', top: 0,
  });
  const td = { padding: '5px 10px', whiteSpace: 'nowrap', maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', borderBottom: '1px solid var(--hairline)' };
  const num = { ...td, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
  const shortLabel = (f) => f.label_short || f.label || humaniseField(f.name);
  return (
    <div style={{ overflowX: 'auto', maxHeight: 340, overflowY: 'auto', border: '1px solid var(--hairline)', borderRadius: 8 }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
        <thead>
          <tr>
            <th style={{ ...th(false), width: 24 }} aria-label="Row" />
            {dims.map((d) => (
              <th key={d.name} style={th(false)}>{shortLabel(d)}{filteredFields.has(d.name) ? ' ≡' : ''}</th>
            ))}
            {pivoted
              ? pivots.flatMap((p) => ms.map((m) => <th key={`${p.key}.${m.name}`} style={th(true)}>{pLabel(p)} — {shortLabel(m)}</th>))
              : ms.map((m) => <th key={m.name} style={th(true)}>{shortLabel(m)}{filteredFields.has(m.name) ? ' ≡' : ''}</th>)}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, i) => (
            <tr key={i} style={{ background: i % 2 ? 'var(--elevated)' : 'transparent' }}>
              <td style={{ ...td, color: 'var(--muted)', textAlign: 'right' }}>{i + 1}</td>
              {dims.map((d) => <td key={d.name} style={td}>{cellText(row[d.name])}</td>)}
              {pivoted
                ? pivots.flatMap((p) => ms.map((m) => <td key={`${p.key}.${m.name}`} style={num}>{cellText(row[m.name]?.[p.key])}</td>))
                : ms.map((m) => <td key={m.name} style={num}>{cellText(row[m.name])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > GRID_ROWS && <div style={{ fontSize: 11, color: 'var(--muted)', padding: '6px 10px' }}>Showing the first {GRID_ROWS} of {rows.length} rows.</div>}
    </div>
  );
}

// Looker filter expressions ("yesterday", "last 7 days", "&gt;100", "NOT NULL",
// "2026-01-01 to 2026-02-01") read as "matches (advanced)"; a plain value or
// comma list reads as "is" — same as Explore shows them.
function isAdvancedFilter(value) {
  const v = String(value).trim();
  return /[%<>=*^]/.test(v) || /^-/.test(v) || /\b(to|days?|weeks?|months?|quarters?|years?|ago|yesterday|today|tomorrow|null|not)\b/i.test(v);
}

// Fallback classification when a field has no catalogue/result metadata yet.
function guessKind(name) {
  return /(count|sum|total|average|avg|median|min|max|number|amount|revenue|rate|percent)$/i.test(String(name).split('.').pop() || '') ? 'measure' : 'dimension';
}

function humanise(s) { return String(s).replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\w/, (c) => c.toUpperCase()); }

// "orders.created_date" → "Orders · Created date". Best-effort humanising for
// fields Looker didn't hand us a label for (fallback path only).
function humaniseField(name) {
  const parts = String(name).split('.');
  if (parts.length === 2) return `${humanise(parts[0])} · ${humanise(parts[1])}`;
  return humanise(name);
}

// Dark Explore-style section strip (the "Filters / Visualization / Data" bars).
function SectionBar({ label, right }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '7px 14px',
      background: 'var(--inverse, #2b3137)', color: '#fff', position: 'sticky', top: 0, zIndex: 2,
    }}>
      <span aria-hidden style={{ fontSize: 9 }}>▾</span>
      <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.01em', flex: 1 }}>{label}</span>
      {right}
    </div>
  );
}

function MetaRow({ label, value }) {
  if (!value) return null;
  return (
    <div style={{ border: '1px solid var(--hairline)', borderRadius: 10, padding: '9px 12px', background: 'var(--elevated)', display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' }}>
      <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>{label}</span>
      <span style={{ fontSize: 12.5, color: 'var(--text)', fontFamily: 'var(--mono, ui-monospace, monospace)', wordBreak: 'break-all', textAlign: 'right' }}>{value}</span>
    </div>
  );
}

function Empty({ children }) {
  return <div style={{ fontSize: 12.5, color: 'var(--muted)', fontStyle: 'italic', lineHeight: 1.5 }}>{children}</div>;
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 400 };
const panel = { width: 'min(1080px, 96vw)', height: 'min(760px, 92vh)', background: 'var(--card)', borderRadius: 14, boxShadow: '0 12px 48px rgba(0,0,0,0.28)', display: 'flex', flexDirection: 'column', overflow: 'hidden' };
const header = { display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px', borderBottom: '1px solid var(--border)', flexShrink: 0 };
const rail = { width: 220, flexShrink: 0, borderRight: '1px solid var(--border)', padding: '12px 12px 14px', overflowY: 'auto', display: 'flex', flexDirection: 'column' };
const railTitle = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', marginBottom: 10 };
const condBox = { fontSize: 11, fontWeight: 600, color: 'var(--muted)', border: '1px solid var(--hairline)', borderRadius: 6, padding: '2px 8px', background: 'var(--card)' };
const warnBanner = { background: 'rgba(240,180,40,0.18)', borderTop: '1px solid rgba(200,150,30,0.35)', borderBottom: '1px solid rgba(200,150,30,0.35)', color: 'var(--text)', fontSize: 12, padding: '7px 14px' };
const closeBtn = { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 17, color: '#888' };
const ghostBtn = { border: '1px solid var(--hairline)', background: 'transparent', color: 'var(--muted)', borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' };
const runBtn = (disabled) => ({ border: 'none', background: disabled ? 'var(--elevated)' : 'var(--brand)', color: disabled ? 'var(--muted)' : '#fff', borderRadius: 8, padding: '7px 14px', fontSize: 12.5, fontWeight: 700, cursor: disabled ? 'default' : 'pointer' });
const ddList = { position: 'absolute', top: '100%', zIndex: 60, marginTop: 4, minWidth: 230, background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 8, boxShadow: '0 6px 20px rgba(0,0,0,0.18)', maxHeight: 240, overflowY: 'auto', listStyle: 'none', margin: 0, padding: '4px 0' };
const ddItem = { padding: '7px 11px', cursor: 'pointer', fontSize: 12.5, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };
const ddMuted = { padding: '7px 11px', fontSize: 12.5, color: 'var(--muted)' };
