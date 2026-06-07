import { useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import * as echarts from 'echarts';
import { cellText, formatNumber, formatAxis } from '../../lib/format.js';
import { useDrill } from '../../lib/DrillContext.jsx';

// Howler-branded chart renderer (Apache ECharts): gradient fills, rounded bars,
// staggered load animation, branded tooltips. Always uses the Howler palette
// (ignores Looker's colours by design). Supports column/bar/line/area/pie/
// doughnut/scatter, pivoted series, table calculations, and drill-down.

const HOWLER = ['#FF385C', '#FF6B35', '#FFB020', '#06B6D4', '#7C3AED', '#10B981', '#EC4899', '#3B82F6', '#F97316', '#14B8A6'];
const color = (i) => HOWLER[i % HOWLER.length];

function hexToRgba(hex, a) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
const num = (v) => (v == null || v === '' ? null : Number(v));

// Vertical (or horizontal) gradient for bars.
function barGradient(c, horizontal) {
  const stops = [{ offset: 0, color: c }, { offset: 1, color: hexToRgba(c, 0.6) }];
  return horizontal
    ? new echarts.graphic.LinearGradient(0, 0, 1, 0, stops)
    : new echarts.graphic.LinearGradient(0, 0, 0, 1, stops);
}
// Soft area gradient for line/area fills.
function areaGradient(c) {
  return new echarts.graphic.LinearGradient(0, 0, 0, 1, [
    { offset: 0, color: hexToRgba(c, 0.45) },
    { offset: 1, color: hexToRgba(c, 0.02) },
  ]);
}

export default function ChartTile({ data, visConfig = {} }) {
  const { openDrill } = useDrill();
  const fields = data.fields || {};
  const rows = data.data || [];
  const dimensions = fields.dimensions || [];
  // Honour Looker's hidden fields (e.g. a raw measure hidden in favour of a
  // running-total / % change calc) — otherwise extra squashed series appear.
  const hidden = new Set(visConfig.hidden_fields || []);
  const measures = [...(fields.measures || []), ...(fields.table_calculations || [])].filter((m) => !hidden.has(m.name));
  const pivots = data.pivots || [];
  const visType = visConfig?.type || 'looker_column';

  // seriesMeta[seriesIndex] = { measure, pivotKey, fmt } for tooltip + drill.
  const stacked = visConfig.stacking === 'normal' || visConfig.stacking === 'percent';
  const { option, seriesMeta } = useMemo(
    () => buildOption({ rows, dimensions, measures, pivots, visType, stacked, visConfig }),
    [data, visType, stacked]
  );

  if (!rows.length || !measures.length) return <Empty />;

  const onClick = (params) => {
    const row = rows[params.dataIndex];
    if (!row) return;
    const meta = visType.includes('pie') || visType.includes('donut')
      ? { measure: measures[0]?.name }
      : seriesMeta[params.seriesIndex];
    if (!meta?.measure) return;
    const cell = meta.pivotKey ? row[meta.measure]?.[meta.pivotKey] : row[meta.measure];
    const links = cell?.links;
    if (links?.length) {
      const dim = dimensions[0] ? cellText(row[dimensions[0].name]) : '';
      openDrill(links, [dim, params.seriesName].filter(Boolean).join(' · '));
    }
  };

  return (
    <div style={{ width: '100%', height: '100%', padding: 6 }}>
      <ReactECharts
        option={option}
        notMerge
        style={{ width: '100%', height: '100%' }}
        opts={{ renderer: 'canvas' }}
        onEvents={{ click: onClick }}
      />
    </div>
  );
}

function buildOption({ rows, dimensions, measures, pivots, visType, stacked, visConfig = {} }) {
  const isPie = visType === 'looker_pie' || visType === 'looker_donut_multiples';
  const isDonut = visType === 'looker_donut_multiples';
  const isBar = visType === 'looker_bar';       // horizontal
  const isArea = visType === 'looker_area';
  const isLine = visType === 'looker_line' || isArea;
  const isScatter = visType === 'looker_scatter';

  const primaryDim = dimensions[0];
  const labels = rows.map((r) => (primaryDim ? cellText(r[primaryDim.name]) : ''));
  const seriesMeta = [];

  const baseAnim = { animationDuration: 800, animationEasing: 'cubicOut', animationDelay: (i) => i * 18 };

  // ─── Pie / doughnut ──────────────────────────────────────────────────────────
  if (isPie) {
    const m = measures[0];
    const pieData = rows.map((r, i) => ({ name: labels[i], value: num(r[m?.name]?.value) }));
    seriesMeta[0] = { measure: m?.name, fmt: m?.value_format };
    return {
      seriesMeta,
      option: {
        ...baseAnim,
        color: HOWLER,
        tooltip: {
          trigger: 'item',
          ...tooltipStyle,
          formatter: (p) => `${p.marker} ${p.name}<b style="margin-left:10px">${formatNumber(p.value, m?.value_format)}</b> <span style="color:#999">(${p.percent}%)</span>`,
        },
        legend: { bottom: 0, type: 'scroll', textStyle: { fontSize: 11 }, icon: 'circle' },
        series: [{
          type: 'pie',
          radius: isDonut ? ['42%', '70%'] : '72%',
          center: ['50%', '46%'],
          data: pieData,
          itemStyle: { borderColor: '#fff', borderWidth: 2, borderRadius: 6 },
          label: { show: false },
          emphasis: { scale: true, scaleSize: 6, itemStyle: { shadowBlur: 12, shadowColor: 'rgba(0,0,0,0.2)' } },
        }],
      },
    };
  }

  // ─── Bars / lines / area / scatter ───────────────────────────────────────────
  // Dual y-axis: Looker's y_axes maps each measure (axisId) to a left/right
  // axis. Only use two axes when visible measures actually span both sides.
  const yMap = {};
  for (const ax of (visConfig.y_axes || [])) for (const s of (ax.series || [])) if (s.axisId) yMap[s.axisId] = ax.orientation;
  const orientationOf = (m) => yMap[m.name] || 'left';
  const hasRight = !isBar && measures.some((m) => orientationOf(m) === 'right');
  const hasLeft = measures.some((m) => orientationOf(m) !== 'right');
  const dual = hasRight && hasLeft;
  const yIndexOf = (m) => (dual && orientationOf(m) === 'right' ? 1 : 0);
  const hp = visConfig.hidden_pivots || {};

  let series = [];
  if (pivots.length > 0) {
    const multi = measures.length > 1;
    pivots.forEach((pivot, pi) => {
      const plabel = pivot.data ? Object.values(pivot.data).join(' / ') : pivot.key;
      measures.forEach((m, mi) => {
        if ((hp[pivot.key]?.measure_names || []).includes(m.name)) return; // hidden per-pivot
        const idx = pi * measures.length + mi;
        const name = multi ? `${plabel} — ${m.label_short || m.label}` : plabel;
        seriesMeta[series.length] = { measure: m.name, pivotKey: pivot.key, fmt: m.value_format };
        series.push(makeSeries(name, rows.map((r) => num(r[m.name]?.[pivot.key]?.value)), idx, { isBar, isLine, isArea, isScatter, stacked, yAxisIndex: yIndexOf(m) }));
      });
    });
  } else {
    measures.forEach((m, i) => {
      seriesMeta[series.length] = { measure: m.name, fmt: m.value_format };
      series.push(makeSeries(m.label_short || m.label, rows.map((r) => num(r[m.name]?.value)), i, { isBar, isLine, isArea, isScatter, stacked, yAxisIndex: yIndexOf(m) }));
    });
  }

  const fmtFor = (axisIdx) => (measures.find((m) => yIndexOf(m) === axisIdx) || measures[0])?.value_format;
  const valueAxis = (axisIdx, position) => ({
    type: 'value', position,
    axisLabel: { fontSize: 10, color: '#888', formatter: (v) => formatAxis(v, fmtFor(axisIdx)) },
    splitLine: { lineStyle: { color: '#f2f2f2' } },
    axisLine: { show: false }, axisTick: { show: false },
  });
  const catAxis = {
    type: 'category', data: labels, boundaryGap: true,
    axisLabel: { fontSize: 10, color: '#888', hideOverlap: true, rotate: labels.length > 8 && !isBar ? 35 : 0 },
    axisLine: { lineStyle: { color: '#e6e6e6' } }, axisTick: { show: false },
  };

  const xAxis = isBar ? valueAxis(0, 'bottom') : catAxis;
  const yAxis = isBar
    ? catAxis
    : (dual ? [valueAxis(0, 'left'), valueAxis(1, 'right')] : [valueAxis(0, 'left')]);

  const showLegend = series.length > 1;
  return {
    seriesMeta,
    option: {
      ...baseAnim,
      color: HOWLER,
      grid: { left: 6, right: dual ? 6 : 14, top: 12, bottom: showLegend ? 34 : 18, containLabel: true },
      tooltip: {
        trigger: isScatter ? 'item' : 'axis',
        ...tooltipStyle,
        axisPointer: { type: isBar ? 'line' : 'shadow', shadowStyle: { color: 'rgba(255,56,92,0.06)' } },
        formatter: (params) => {
          const arr = Array.isArray(params) ? params : [params];
          const title = arr[0]?.axisValueLabel ?? arr[0]?.name ?? '';
          let s = `<div style="font-weight:700;margin-bottom:4px">${title}</div>`;
          for (const p of arr) {
            const fmt = seriesMeta[p.seriesIndex]?.fmt;
            const raw = Array.isArray(p.value) ? p.value[isBar ? 0 : 1] : p.value;
            s += `<div style="display:flex;gap:14px;align-items:center"><span>${p.marker} ${p.seriesName}</span><b style="margin-left:auto">${formatNumber(raw, fmt)}</b></div>`;
          }
          return s;
        },
      },
      legend: showLegend ? { bottom: 0, type: 'scroll', textStyle: { fontSize: 11 }, icon: 'roundRect' } : undefined,
      xAxis,
      yAxis,
      series,
    },
  };
}

function makeSeries(name, vals, idx, { isBar, isLine, isArea, isScatter, stacked, yAxisIndex = 0 }) {
  const c = color(idx);
  if (isScatter) {
    return { name, type: 'scatter', yAxisIndex, data: vals, symbolSize: 10, itemStyle: { color: hexToRgba(c, 0.8) } };
  }
  if (isLine) {
    return {
      name, type: 'line', yAxisIndex, data: vals, smooth: true, showSymbol: false,
      lineStyle: { width: 3, color: c }, itemStyle: { color: c },
      areaStyle: isArea ? { color: areaGradient(c) } : undefined,
      stack: stacked ? 'total' : undefined,
      emphasis: { focus: 'series' },
    };
  }
  // bar (vertical column or horizontal bar)
  return {
    name, type: 'bar', yAxisIndex, data: vals,
    barMaxWidth: 38,
    itemStyle: {
      color: barGradient(c, isBar),
      borderRadius: isBar ? [0, 6, 6, 0] : [6, 6, 0, 0],
    },
    stack: stacked ? 'total' : undefined,
    emphasis: { focus: 'series', itemStyle: { shadowBlur: 10, shadowColor: hexToRgba(c, 0.4) } },
  };
}

const tooltipStyle = {
  backgroundColor: '#fff',
  borderColor: '#eee',
  borderWidth: 1,
  padding: [8, 12],
  textStyle: { color: '#222', fontSize: 12 },
  extraCssText: 'border-radius:8px; box-shadow:0 4px 16px rgba(0,0,0,0.12);',
};

function Empty() {
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#ccc', fontSize: 12 }}>No data</div>;
}
