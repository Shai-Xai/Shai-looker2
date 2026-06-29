// ─── Owl chart → PNG for WhatsApp — disposable helper ─────────────────────────
// Render one chartable Owl answer (an askData/queryDashboard result from the loop's
// trail: a category dimension + a numeric measure over >1 row) to a PNG, server-side
// (ECharts SSR → resvg, the same headless pipeline as tileimg.js). Used by owlWhatsapp
// when the customer's question implies a visual. No browser, no public image hosting —
// the bytes are uploaded straight to Clickatell's media endpoint.
const echarts = require('echarts');
const { Resvg } = require('@resvg/resvg-js');

// Tolerant number: raw numbers and formatted strings ("1,234", "R 1 234").
const num = (v) => {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// Does the customer's question ask for a visual? Charts on WhatsApp are opt-in (we
// keep replies lean), so only render when they clearly want to see one.
function wantsChart(q) {
  return /\b(chart|graph|plot|trend|trends|visual|visualise|visualize|histogram|pie|bar ?chart|line ?chart|break ?down|over time|by (day|week|month|year|event|city|type|category))\b/i.test(String(q || ''));
}

// Pick the richest chartable source from a runOwlLoop trail and normalise it to
// { title, cats, data, type }. Returns null if nothing in the answer is chartable
// (single scalar, no breakdown, or one row). opts.label/opts.dimType resolve friendly
// names + a date dimension (→ line). Rows are flat { field: rawValue } objects.
function chartFromTrail(trail, opts = {}) {
  const cands = (trail || [])
    .filter((t) => (t.name === 'askData' || t.name === 'queryDashboard') && t.result && t.result.ok)
    .map((t) => ({ dims: t.input.dimensions || [], rows: t.result.rows || [], m: t.input.measure }))
    .filter((c) => c.dims.length >= 1 && c.rows.length > 1 && c.m);
  if (!cands.length) return null;
  cands.sort((a, b) => b.rows.length - a.rows.length); // richest breakdown wins
  const { dims, rows, m } = cands[0];
  const dim = dims[0];
  const label = (f) => (opts.label && opts.label(f)) || String(f).split('.').pop().replace(/_/g, ' ');
  const isDate = /date|time|day|week|month|year/i.test((opts.dimType && opts.dimType(dim)) || dim);
  const type = isDate ? 'line' : 'bar';
  const used = rows.slice(0, type === 'line' ? 400 : 24);
  const cats = used.map((r) => String(r[dim] != null ? r[dim] : '—'));
  const data = used.map((r) => num(r[m]));
  if (!data.some((v) => v != null)) return null;
  return { title: `${label(m)} by ${label(dim)}`, cats, data, type };
}

// Rasterise a normalised chart to a PNG Buffer (2× for a crisp phone display).
function renderPng({ title, cats, data, type }, branding = {}) {
  try {
    const palette = [branding.brandColor || '#FF2D55', '#FF6B35', '#FFB020', '#06B6D4', '#7C3AED'];
    const option = {
      animation: false, color: palette,
      title: { text: title || '', left: 'left', top: 8, textStyle: { fontSize: 16, fontWeight: 700, color: '#111' } },
      grid: { left: 8, right: 18, top: 44, bottom: 30, containLabel: true },
      xAxis: { type: 'category', data: cats, axisLabel: { fontSize: 12, color: '#666', hideOverlap: true, rotate: cats.length > 8 ? 30 : 0 }, axisLine: { lineStyle: { color: '#ddd' } } },
      yAxis: { type: 'value', axisLabel: { fontSize: 12, color: '#999' }, splitLine: { lineStyle: { color: '#f0f0f0' } } },
      series: [{
        type: type === 'line' ? 'line' : 'bar', data,
        smooth: type === 'line', showSymbol: cats.length <= 24, symbol: 'circle', symbolSize: 5,
        itemStyle: { color: palette[0], borderRadius: type === 'line' ? 0 : [3, 3, 0, 0] },
        lineStyle: type === 'line' ? { width: 2.5 } : undefined, connectNulls: true,
      }],
    };
    const W = 660, H = 380;
    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: W, height: H });
    chart.setOption(option);
    const svg = chart.renderToSVGString();
    chart.dispose();
    return new Resvg(svg, { fitTo: { mode: 'width', value: W * 2 }, background: 'white' }).render().asPng();
  } catch (e) { console.error('[owlChartImg] render failed:', e.message); return null; }
}

module.exports = { wantsChart, chartFromTrail, renderPng };
