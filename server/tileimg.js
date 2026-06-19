// Server-side tile → PNG renderer for emails (digests). Email clients can't run
// our React tiles and don't reliably show SVG, so we render an ECharts chart
// headlessly to SVG (pure JS, no browser) and rasterise it to PNG with resvg.
// Used by the digest "followed tiles as charts" option — the bytes are stored as
// a mail asset and embedded with <img>. Single-value/table tiles aren't charts;
// the caller shows those as metric chips instead (see isChartTile).
const echarts = require('echarts');
const { Resvg } = require('@resvg/resvg-js');

// json_detail cell → raw number / display string.
const cellVal = (cell) => (cell == null ? null : (cell.value != null ? cell.value : cell.rendered));
const cellLabel = (cell) => (cell == null ? '' : String(cell.rendered != null ? cell.rendered : (cell.value != null ? cell.value : '')));
// Tolerant number: handles raw numbers and formatted strings ("1,234", "R 1 234").
const num = (v) => {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
// A measure value for a row, resolving a pivot column when present. Mirrors the
// client ChartTile: pivoted cells are keyed by the pivot's key under the measure.
const measureValue = (row, measureName, pivotKey) => {
  const cell = row?.[measureName];
  if (cell == null) return null;
  if (pivotKey != null) return num(cell?.[pivotKey]?.value);
  return num(cell.value != null ? cell.value : cell.rendered);
};

// Which Looker vis types are worth drawing as a chart. Single-value, table and
// text tiles are better as a metric chip, so they return false here.
function isChartTile(tile, fact) {
  const t = String(tile?.vis?.type || fact?.visType || '').toLowerCase();
  if (/single|table|text|^looker_single/.test(t)) return false;
  const dims = fact?.fields?.dimensions || [];
  const meas = [...(fact?.fields?.measures || []), ...(fact?.fields?.table_calculations || [])];
  // Need at least one category dimension and one numeric series, and >1 row to
  // be a meaningful chart.
  return dims.length >= 1 && meas.length >= 1 && (fact?.rows || []).length >= 2;
}

// Build an ECharts option from a tile's json_detail data. Mirrors the gist of
// the client ChartTile mapping (first dimension = category axis, measures =
// series) — kept deliberately simple for an email thumbnail.
function optionFor(tile, fact, palette) {
  const dims = fact.fields?.dimensions || [];
  const meas = [...(fact.fields?.measures || []), ...(fact.fields?.table_calculations || [])];
  if (!dims.length || !meas.length) return null;
  const t = String(tile?.vis?.type || fact?.visType || '').toLowerCase();
  const isPie = /pie|donut/.test(t);
  const isLine = /line|area/.test(t);
  const isArea = /area/.test(t);
  // Row cap: line/area are time-series (e.g. cumulative "days before event") — keep
  // the whole curve, else truncating to the first few points shows only the flat
  // near-zero start and the chart looks empty. Bars/pie get fewer (many bars/slices
  // are unreadable in a small email image).
  const cap = isPie ? 12 : (isLine ? 400 : 20);
  const rows = (fact.rows || []).slice(0, cap);
  const dimName = dims[0].name;
  const cats = rows.map((r) => cellLabel(r[dimName]) || '—');

  // Pivot labels from the query meta (key → friendly label), but the KEYS we use
  // are read straight from the data cells below — so this works even if the
  // reported pivot keys don't line up exactly with the cell keys.
  const pivotLabels = {};
  for (const p of (fact.pivots || [])) pivotLabels[p.key] = p.data ? Object.values(p.data).join(' / ') : p.key;
  // Inspect a measure's first non-null cell to see whether it's pivoted. A flat
  // cell has value/rendered directly; a pivoted cell is keyed by pivot value
  // (each holding its own {value,rendered}). Returns the pivot keys, or null.
  const pivotKeysOf = (mName) => {
    const sample = rows.find((r) => r[mName] != null)?.[mName];
    if (!sample || typeof sample !== 'object') return null;
    if ('value' in sample || 'rendered' in sample) return null; // flat measure
    const keys = Object.keys(sample);
    return keys.length ? keys : null;
  };
  const valAt = (row, mName, key) => {
    const cell = row?.[mName];
    if (cell == null) return null;
    const c = key == null ? cell : cell[key];
    if (c == null) return null;
    return num(c.value != null ? c.value : c.rendered);
  };

  if (isPie) {
    const m = meas[0];
    const key = (pivotKeysOf(m.name) || [null])[0];
    const data = rows.map((r, i) => ({ name: cats[i], value: valAt(r, m.name, key) ?? 0 }));
    return {
      animation: false, color: palette,
      series: [{ type: 'pie', radius: /donut/.test(t) ? ['42%', '70%'] : '70%', center: ['50%', '54%'],
        data, label: { fontSize: 12 } }],
      title: { text: tile.title || '', left: 'center', top: 6, textStyle: { fontSize: 14, fontWeight: 700, color: '#111' } },
    };
  }

  const manyPoints = rows.length > 24;
  const mkSeries = (name, data, idx) => ({
    name,
    type: isLine ? 'line' : 'bar',
    data,
    smooth: isLine, areaStyle: isArea ? {} : undefined,
    itemStyle: { color: palette[idx % palette.length], borderRadius: isLine ? 0 : [3, 3, 0, 0] },
    lineStyle: isLine ? { width: 2.5 } : undefined,
    showSymbol: isLine ? !manyPoints : undefined, // dots clutter a long line
    symbol: 'circle', symbolSize: 5,
    connectNulls: true,
  });
  // One series per measure × (detected) pivot key. Pivot keys come from the cells
  // themselves, so a YoY tile (pivoted on event/year) renders a line per event.
  const multiMeas = meas.length > 1;
  let series = [];
  for (const m of meas) {
    const keys = pivotKeysOf(m.name);
    if (keys) {
      for (const key of keys) {
        const label = pivotLabels[key] || key;
        series.push(mkSeries(multiMeas ? `${label} — ${m.label || m.name}` : label, rows.map((r) => valAt(r, m.name, key)), series.length));
      }
    } else {
      series.push(mkSeries(m.label || m.name, rows.map((r) => valAt(r, m.name, null)), series.length));
    }
  }
  // Drop series with no data; if nothing has data, bail (caller shows a metric).
  series = series.filter((s) => s.data.some((v) => v != null)).slice(0, 8);
  if (!series.length) return null;
  const hasLegend = series.length > 1;
  return {
    animation: false, color: palette,
    title: { text: tile.title || '', left: 'left', top: 4, textStyle: { fontSize: 14, fontWeight: 700, color: '#111' } },
    grid: { left: 8, right: 16, top: hasLegend ? 44 : 30, bottom: 24, containLabel: true },
    legend: hasLegend ? { top: 24, left: 'left', textStyle: { fontSize: 11, color: '#555' }, itemHeight: 8, itemWidth: 14 } : undefined,
    xAxis: { type: 'category', data: cats, axisLabel: { fontSize: 11, color: '#666', hideOverlap: true }, axisLine: { lineStyle: { color: '#ddd' } } },
    yAxis: { type: 'value', axisLabel: { fontSize: 11, color: '#999' }, splitLine: { lineStyle: { color: '#f0f0f0' } } },
    series,
  };
}

// Render a tile to PNG (Buffer) at 2× for crisp display. Returns null if the
// tile isn't chartable or rendering fails (caller falls back to a metric chip).
function renderTilePng(tile, fact, branding = {}) {
  try {
    if (!isChartTile(tile, fact)) return null;
    const palette = [branding.brandColor || '#FF2D55', branding.secondaryColor || '#FF6B35', '#FFB020', '#06B6D4', '#7C3AED'];
    const option = optionFor(tile, fact, palette);
    if (!option) {
      // Couldn't extract any series — log the data shape so the real json_detail
      // structure is visible (otherwise an empty chart is a black box).
      const sampleRow = (fact.rows || [])[0] || {};
      const sampleCell = fact.fields?.measures?.[0]?.name ? sampleRow[fact.fields.measures[0].name] : undefined;
      console.warn(`[tileimg] no series for "${fact.title}": fields=${JSON.stringify({ d: (fact.fields?.dimensions || []).map((x) => x.name), m: (fact.fields?.measures || []).map((x) => x.name), tc: (fact.fields?.table_calculations || []).map((x) => x.name) })} pivots=${JSON.stringify((fact.pivots || []).map((p) => p.key))} sampleCell=${JSON.stringify(sampleCell)?.slice(0, 300)}`);
      return null;
    }
    const W = 520, H = 300;
    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: W, height: H });
    chart.setOption(option);
    const svg = chart.renderToSVGString();
    chart.dispose();
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: W * 2 }, background: 'white' }).render().asPng();
    return png;
  } catch (e) {
    console.error('[tileimg] render failed:', e.message);
    return null;
  }
}

module.exports = { isChartTile, renderTilePng };
