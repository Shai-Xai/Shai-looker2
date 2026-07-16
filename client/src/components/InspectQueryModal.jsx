import { createPortal } from 'react-dom';
import { useIsMobile } from '../lib/useIsMobile.js';
import { useSheetDrag } from '../lib/useSheetDrag.js';
import { cellText } from '../lib/format.js';

// Read-only "Inspect query" — an EDIT-mode tool that recreates the feel of
// Looker's Explore view for one tile, without leaving Pulse: a fields-in-use
// rail, the filters in effect (tile-baked + dashboard, tagged by source), a
// bar visualization of the first measure, and the result grid that drove the
// number on screen. Pulse owns the interface (no Looker embed), so everything
// here is the tile's own Looker query definition + the field metadata and rows
// Looker returned with the last result — surfaced verbatim, never recomputed.
//
// `detailed` (staff) additionally shows raw internals: LookML field names,
// model + explore, sorts, pivots and the row limit. Read-only and mobile-first:
// desktop gets a wide Explore-style panel with a left rail; phones get a
// full-height bottom sheet with the same sections stacked.
export default function InspectQueryModal({ tile, data, filters, dashboardFields = [], detailed = false, onClose }) {
  const isMobile = useIsMobile();
  const drag = useSheetDrag(onClose);

  const q = tile.query || {};
  const pivotSet = new Set(q.pivots || []);
  // Prefer the field metadata Looker returned with the LAST result — it reflects
  // exactly what drove the currently displayed number. Fall back to the query's
  // raw field list (tile configured but not yet run / errored) so the panel still
  // has something to show.
  const dims = data?.fields?.dimensions?.length || data?.fields?.measures?.length
    ? (data.fields.dimensions || [])
    : queryFieldsAsMeta(q.fields, 'dimension');
  const measures = data?.fields?.measures || (data ? [] : queryFieldsAsMeta(q.fields, 'measure'));
  const tableCalcs = data?.fields?.table_calculations || [];
  const rows = data?.data || [];
  const pivots = data?.pivots || [];

  // Effective filters (tile-baked + active dashboard filters), keyed by field.
  const filterEntries = Object.entries(filters || {}).filter(([, v]) => v != null && String(v).trim() !== '');
  const dashSet = new Set(dashboardFields || []);
  const filteredFields = new Set(filterEntries.map(([f]) => f));
  // Label lookup: every field Looker described, so a filter on a selected field
  // shows its friendly label. Filters on non-selected fields humanise the name.
  const labelByName = {};
  for (const f of [...dims, ...measures, ...tableCalcs]) labelByName[f.name] = f.label_short || f.label || f.name;
  const labelOf = (name) => labelByName[name] || humaniseField(name);

  const rowLimit = Number(q.limit) || 500;
  const limitReached = rows.length >= rowLimit && rows.length > 0;

  const panelStyle = isMobile
    ? { ...panel, width: '100%', maxWidth: '100%', height: 'auto', maxHeight: '94dvh', borderRadius: '18px 18px 0 0', paddingBottom: 'env(safe-area-inset-bottom)' }
    : panel;

  const node = (
    <div className="ai-overlay" style={isMobile ? { ...overlay, alignItems: 'flex-end', justifyContent: 'center' } : overlay} onClick={onClose}>
      <div
        className={isMobile ? 'ai-sheet' : 'ai-panel'}
        style={isMobile ? { ...panelStyle, ...drag.style } : panelStyle}
        onClick={(e) => e.stopPropagation()}
      >
        {isMobile && <div className="sheet-grip" {...drag.handlers} style={{ marginTop: 8 }} />}

        {/* ── Explore-style header: title left, result meta right ── */}
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
          <button style={isMobile ? { ...closeBtn, fontSize: 22, padding: '6px 10px' } : closeBtn} onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>
          {/* ── Left rail (desktop): fields in use, grouped by view ── */}
          {!isMobile && (
            <div style={rail}>
              <div style={railTitle}>In use</div>
              <FieldsInUse dims={dims} measures={measures} tableCalcs={tableCalcs} pivotSet={pivotSet} filteredFields={filteredFields} detailed={detailed} />
              <div style={{ marginTop: 'auto', paddingTop: 10, fontSize: 10.5, color: 'var(--muted)' }}>
                {dims.length + measures.length + tableCalcs.length} fields in use
              </div>
            </div>
          )}

          {/* ── Main column: Filters / Visualization / Data, Explore-style ── */}
          <div style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
            <SectionBar label="Filters" />
            <div style={{ padding: '12px 14px' }}>
              {filterEntries.length ? filterEntries.map(([field, value], i) => (
                <FilterRow
                  key={field}
                  and={i > 0}
                  label={labelOf(field)}
                  field={field}
                  value={value}
                  source={dashSet.has(field) ? 'Dashboard' : 'Tile'}
                  detailed={detailed}
                  isMobile={isMobile}
                />
              )) : <Empty>No filters are narrowing this tile.</Empty>}
            </div>

            <SectionBar label="Visualization" />
            <div style={{ padding: '12px 14px' }}>
              <VizPreview dims={dims} measures={measures} rows={rows} pivots={pivots} />
            </div>

            <SectionBar label="Data" right={<span style={{ fontSize: 11, opacity: 0.85 }}>Results · Row limit {rowLimit}</span>} />
            {limitReached && (
              <div style={warnBanner}>⚠ Row limit reached. Results may be incomplete.</div>
            )}
            <div style={{ padding: '12px 14px' }}>
              <ResultsGrid dims={dims} measures={measures} tableCalcs={tableCalcs} rows={rows} pivots={pivots} filteredFields={filteredFields} />
            </div>

            {/* Mobile: the fields rail becomes a stacked section */}
            {isMobile && (
              <>
                <SectionBar label="Fields in use" right={<span style={{ fontSize: 11, opacity: 0.85 }}>{dims.length + measures.length + tableCalcs.length}</span>} />
                <div style={{ padding: '12px 14px' }}>
                  <FieldsInUse dims={dims} measures={measures} tableCalcs={tableCalcs} pivotSet={pivotSet} filteredFields={filteredFields} detailed={detailed} />
                </div>
              </>
            )}

            {detailed && (
              <>
                <SectionBar label="Source" right={<span style={{ fontSize: 11, opacity: 0.85 }}>staff only</span>} />
                <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <MetaRow label="Model" value={q.model} />
                  <MetaRow label="Explore" value={q.view} />
                  {q.sorts?.length > 0 && <MetaRow label="Sorts" value={q.sorts.join(', ')} />}
                  <MetaRow label="Row limit" value={String(rowLimit)} />
                  {(q.pivots?.length || 0) > 0 && <MetaRow label="Pivots" value={q.pivots.join(', ')} />}
                </div>
              </>
            )}
          </div>
        </div>

        <div style={{ padding: '10px 18px 14px', fontSize: 11, color: 'var(--muted)', borderTop: '1px solid var(--hairline)', flexShrink: 0 }}>
          Read-only. Reflects the parameters driving the number shown now, including any active filters.
          {detailed ? ' Staff view — includes raw query internals.' : ''}
        </div>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}

// ─── Fields-in-use rail: grouped by view, Looker Explore style ─────────────────
// Dimensions read plain; measures get the warm tint Looker uses; a ≡ marker on
// any field that a filter is narrowing; "pivot" chip on pivoted dimensions.
function FieldsInUse({ dims, measures, tableCalcs, pivotSet, filteredFields, detailed }) {
  const groups = {};
  const add = (f, kind) => {
    const view = String(f.name).includes('.') ? String(f.name).split('.')[0] : 'Fields';
    (groups[view] = groups[view] || []).push({ ...f, kind });
  };
  dims.forEach((f) => add(f, 'dimension'));
  measures.forEach((f) => add(f, 'measure'));
  tableCalcs.forEach((f) => add(f, 'calc'));
  const views = Object.keys(groups).sort();
  if (!views.length) return <Empty>No fields — this tile isn't configured yet.</Empty>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
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
                  {shortLabel(f)}
                </span>
                {pivotSet.has(f.name) && <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--brand)' }}>PIVOT</span>}
                {filteredFields.has(f.name) && <span title="A filter is narrowing this field" aria-label="Filtered" style={{ fontSize: 11, color: 'var(--brand)' }}>≡</span>}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── One filter row: label · condition · value chips · AND rail ────────────────
function FilterRow({ and, label, field, value, source, detailed, isMobile }) {
  const advanced = isAdvancedFilter(value);
  const chips = advanced ? [String(value)] : String(value).split(',').map((s) => s.trim()).filter(Boolean);
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 8 }}>
      <span style={{ width: 30, flexShrink: 0, fontSize: 9.5, fontWeight: 700, color: and ? 'var(--brand)' : 'transparent', paddingTop: 8, textAlign: 'center' }}>AND</span>
      <div style={{ flex: 1, minWidth: 0, border: '1px solid var(--hairline)', borderRadius: 10, background: 'var(--elevated)', padding: '8px 10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5, fontWeight: 600 }}>{label}</span>
          <span style={condBox}>{advanced ? 'matches (advanced)' : 'is'}</span>
          <span style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', color: source === 'Dashboard' ? 'var(--brand)' : 'var(--muted)' }}>{source}</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 6 }}>
          {chips.map((c, i) => (
            <span key={i} style={{
              fontSize: isMobile ? 12 : 11.5, fontWeight: 600, padding: '2px 9px', borderRadius: 6,
              background: 'var(--brand-tint, rgba(80,120,220,0.14))', color: 'var(--text)', border: '1px solid var(--hairline)',
              fontFamily: advanced ? 'var(--mono, ui-monospace, monospace)' : undefined, wordBreak: 'break-word',
            }}>{c}</span>
          ))}
        </div>
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
function VizPreview({ dims, measures, rows, pivots }) {
  const m = measures[0];
  if (!rows.length || !m) return <Empty>No result to visualize yet.</Empty>;
  if (pivots.length > 0) return <Empty>Pivoted result — see the grid below for the pivot columns.</Empty>;
  if (!dims.length) {
    return <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-0.02em' }}>{cellText(rows[0][m.name])}</div>;
  }
  const vals = rows.map((r) => Math.abs(Number(r[m.name]?.value)) || 0);
  const max = Math.max(...vals.slice(0, VIZ_ROWS), 0);
  const shown = rows.slice(0, VIZ_ROWS);
  return (
    <div style={{ overflowX: 'auto' }}>
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
      {rows.length > VIZ_ROWS && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>Showing the first {VIZ_ROWS} of {rows.length} rows ({shortLabel(m)}).</div>}
    </div>
  );
}

// ─── Results grid: the raw rows behind the tile, Looker column styling ─────────
// Dimension headers grey, measure headers warm-tinted (like Looker's Explore
// data grid). Pivoted queries expand into pivot × measure column groups.
const GRID_ROWS = 50;
function ResultsGrid({ dims, measures, tableCalcs, rows, pivots, filteredFields }) {
  if (!rows.length) return <Empty>No result rows — the tile hasn't returned data yet.</Empty>;
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
// comma list reads as "is" with one chip per value — same as Explore shows them.
function isAdvancedFilter(value) {
  const v = String(value).trim();
  return /[%<>=*^]/.test(v) || /^-/.test(v) || /\b(to|days?|weeks?|months?|quarters?|years?|ago|yesterday|today|tomorrow|null|not)\b/i.test(v);
}

function shortLabel(f) { return f.label_short || f.label || humaniseField(f.name); }

// Turn a bare query field list into pseudo-metadata when we have no live result
// to describe them. Heuristic split: a measure name usually ends in a
// count/sum/total-ish word; everything else reads as a dimension. Only used as a
// fallback — a run tile uses Looker's real dimension/measure classification.
function queryFieldsAsMeta(fields, kind) {
  const isMeasure = (n) => /(count|sum|total|average|avg|median|min|max|number|amount|revenue|rate|percent)$/i.test(String(n).split('.').pop() || '');
  return (fields || [])
    .filter((n) => (kind === 'measure' ? isMeasure(n) : !isMeasure(n)))
    .map((name) => ({ name, label: humaniseField(name) }));
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
const header = { display: 'flex', alignItems: 'center', gap: 12, padding: '14px 18px', borderBottom: '1px solid var(--border)', flexShrink: 0 };
const rail = { width: 210, flexShrink: 0, borderRight: '1px solid var(--border)', padding: '12px 12px 14px', overflowY: 'auto', display: 'flex', flexDirection: 'column' };
const railTitle = { fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', marginBottom: 10 };
const condBox = { fontSize: 11, fontWeight: 600, color: 'var(--muted)', border: '1px solid var(--hairline)', borderRadius: 6, padding: '2px 8px', background: 'var(--card)' };
const warnBanner = { background: 'rgba(240,180,40,0.18)', borderTop: '1px solid rgba(200,150,30,0.35)', borderBottom: '1px solid rgba(200,150,30,0.35)', color: 'var(--text)', fontSize: 12, padding: '7px 14px' };
const closeBtn = { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 17, color: '#888' };
