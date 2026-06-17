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
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

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
  const rows = (fact.rows || []).slice(0, 12);
  const dimName = dims[0].name;
  const cats = rows.map((r) => cellLabel(r[dimName]) || '—');
  const t = String(tile?.vis?.type || fact?.visType || '').toLowerCase();
  const isPie = /pie|donut/.test(t);
  const isLine = /line|area/.test(t);
  const isArea = /area/.test(t);

  if (isPie) {
    const m = meas[0];
    const data = rows.map((r, i) => ({ name: cats[i], value: num(cellVal(r[m.name])) ?? 0 }));
    return {
      animation: false, color: palette,
      series: [{ type: 'pie', radius: /donut/.test(t) ? ['42%', '70%'] : '70%', center: ['50%', '54%'],
        data, label: { fontSize: 12 } }],
      title: { text: tile.title || '', left: 'center', top: 6, textStyle: { fontSize: 14, fontWeight: 700, color: '#111' } },
    };
  }

  const series = meas.slice(0, 5).map((m, idx) => ({
    name: m.label || m.name,
    type: isLine ? 'line' : 'bar',
    data: rows.map((r) => num(cellVal(r[m.name]))),
    smooth: isLine, areaStyle: isArea ? {} : undefined,
    itemStyle: { color: palette[idx % palette.length], borderRadius: isLine ? 0 : [3, 3, 0, 0] },
    lineStyle: isLine ? { width: 2.5 } : undefined,
    symbol: isLine ? 'circle' : undefined, symbolSize: 5,
  }));
  return {
    animation: false, color: palette,
    title: { text: tile.title || '', left: 'left', top: 4, textStyle: { fontSize: 14, fontWeight: 700, color: '#111' } },
    grid: { left: 8, right: 16, top: 44, bottom: 24, containLabel: true },
    legend: meas.length > 1 ? { top: 24, left: 'left', textStyle: { fontSize: 11, color: '#555' }, itemHeight: 8, itemWidth: 14 } : undefined,
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
    if (!option) return null;
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
