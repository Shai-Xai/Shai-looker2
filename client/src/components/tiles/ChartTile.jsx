import { useMemo, useRef, useState, useLayoutEffect } from 'react';
import ReactECharts from 'echarts-for-react';
import * as echarts from 'echarts';
import { cellText, formatNumber, formatAxis } from '../../lib/format.js';
import { useDrill } from '../../lib/DrillContext.jsx';
import { useTheme } from '../../lib/theme.jsx';
import { chartPalette, brandPrimary } from '../../lib/brand.js';

// Howler-branded chart renderer (Apache ECharts): gradient fills, rounded bars,
// staggered load animation, branded tooltips. Always uses the Howler palette
// (ignores Looker's colours by design). Supports column/bar/line/area/pie/
// doughnut/scatter, pivoted series, table calculations, and drill-down.

// Palette comes from the brand engine: Howler's hand-tuned palette by default,
// or one generated from a white-labelled client's primary+secondary pair.
const color = (i) => { const P = chartPalette(); return P[i % P.length]; };

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
  // Measure the available height so we can truncate rotated axis names to fit
  // the plot area (short tiles can't show a long vertical title).
  const boxRef = useRef(null);
  const [boxH, setBoxH] = useState(280);
  useLayoutEffect(() => {
    if (!boxRef.current) return;
    const el = boxRef.current;
    const ro = new ResizeObserver(() => setBoxH(el.clientHeight || 280));
    ro.observe(el);
    setBoxH(el.clientHeight || 280);
    return () => ro.disconnect();
  }, []);
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
  const { theme } = useTheme();
  // Rebuild colours when the white-label brand pair changes (palette is read
  // inside buildOption, so the brand version must be a dependency).
  const [brandV, setBrandV] = useState(0);
  useLayoutEffect(() => {
    const f = () => setBrandV((v) => v + 1);
    window.addEventListener('brand-changed', f);
    return () => window.removeEventListener('brand-changed', f);
  }, []);
  const { option, seriesMeta } = useMemo(
    () => buildOption({ rows, dimensions, measures, pivots, visType, stacked, visConfig, boxH }),
    [data, visType, stacked, boxH, theme, brandV]
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
    <div ref={boxRef} style={{ width: '100%', height: '100%', padding: 6 }}>
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

function buildOption({ rows, dimensions, measures, pivots, visType, stacked, visConfig = {}, boxH = 280 }) {
  const dark = typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark';
  const axisC = dark ? '#9a9aa3' : '#888';
  const nameC = dark ? '#8a8a92' : '#9a9a9a';
  const splitC = dark ? 'rgba(255,255,255,0.08)' : '#f2f2f2';
  const axisLineC = dark ? 'rgba(255,255,255,0.14)' : '#e6e6e6';
  const labelC = dark ? '#c0c0c9' : '#5a5a5a';
  const tip = dark
    ? { ...tooltipStyle, backgroundColor: 'rgba(28,28,34,0.97)', borderColor: 'rgba(255,255,255,0.12)', textStyle: { color: '#f3f3f6', fontSize: 12 } }
    : tooltipStyle;
  const isPie = visType === 'looker_pie' || visType === 'looker_donut_multiples';
  const isDonut = visType === 'looker_donut_multiples';
  const isBar = visType === 'looker_bar';       // horizontal
  const isArea = visType === 'looker_area';
  const isLine = visType === 'looker_line' || isArea;
  const isScatter = visType === 'looker_scatter';

  const primaryDim = dimensions[0];
  const labels = rows.map((r) => (primaryDim ? cellText(r[primaryDim.name]) : ''));
  const seriesMeta = [];

  // First paint: grow in with a per-point stagger. Updates (filter changes):
  // morph the existing shapes to their new values instead of redrawing.
  const baseAnim = {
    animationDuration: 800,
    animationEasing: 'cubicOut',
    animationDelay: (i) => i * 18,
    animationDurationUpdate: 420,
    animationEasingUpdate: 'cubicInOut',
    animationDelayUpdate: (i) => i * 6,
  };

  // ─── Pie / doughnut ──────────────────────────────────────────────────────────
  if (isPie) {
    const m = measures[0];
    const pieData = rows.map((r, i) => ({ name: labels[i], value: num(r[m?.name]?.value) }));
    seriesMeta[0] = { measure: m?.name, fmt: m?.value_format };
    return {
      seriesMeta,
      option: {
        ...baseAnim,
        color: chartPalette(),
        tooltip: {
          trigger: 'item',
          ...tip,
          formatter: (p) => `${p.marker} ${p.name}<b style="margin-left:10px">${formatNumber(p.value, m?.value_format)}</b> <span style="color:#999">(${p.percent}%)</span>`,
        },
        legend: { bottom: 0, type: 'scroll', textStyle: { fontSize: 11 }, icon: 'circle' },
        series: [{
          type: 'pie',
          radius: isDonut ? ['42%', '70%'] : '72%',
          center: ['50%', '46%'],
          data: pieData,
          itemStyle: { borderColor: dark ? '#1a1a1f' : '#fff', borderWidth: 2, borderRadius: 6 },
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
  // Looker "Values" data labels printed on each point/bar.
  const showLabels = visConfig.show_value_labels === true;

  // Combination charts: Looker's series_types overrides individual series to a
  // different type (e.g. a column chart where some years render as lines). Keys
  // are "<pivot value> - <measure name>" (pivoted) or "<measure name>".
  const baseFlags = { isBar, isLine, isArea, isScatter };
  const st = visConfig.series_types || {};
  const flagsFor = (type) => {
    switch (type) {
      case 'line': return { isBar: false, isLine: true, isArea: false, isScatter: false };
      case 'area': return { isBar: false, isLine: true, isArea: true, isScatter: false };
      case 'column':
      case 'bar': return { isBar: false, isLine: false, isArea: false, isScatter: false };
      case 'scatter': return { isBar: false, isLine: false, isArea: false, isScatter: true };
      default: return baseFlags;
    }
  };
  const typeFor = (pivotKey, mName) => {
    const key = pivotKey == null ? mName : `${pivotKey} - ${mName}`;
    if (st[key]) return st[key];
    if (pivotKey != null) {
      for (const [k, v] of Object.entries(st)) {
        const parts = k.split(' - ');
        if (parts.length >= 2 && parts[parts.length - 1] === mName && parts.slice(0, -1).join(' - ') === String(pivotKey)) return v;
      }
    }
    return null;
  };

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
        series.push(makeSeries(name, rows.map((r) => num(r[m.name]?.[pivot.key]?.value)), idx, { ...flagsFor(typeFor(pivot.key, m.name)), stacked, yAxisIndex: yIndexOf(m), showLabels, labelC, fmt: m.value_format }));
      });
    });
  } else {
    measures.forEach((m, i) => {
      seriesMeta[series.length] = { measure: m.name, fmt: m.value_format };
      series.push(makeSeries(m.label_short || m.label, rows.map((r) => num(r[m.name]?.value)), i, { ...flagsFor(typeFor(null, m.name)), stacked, yAxisIndex: yIndexOf(m), showLabels, labelC, fmt: m.value_format }));
    });
  }

  const fmtFor = (axisIdx) => (measures.find((m) => yIndexOf(m) === axisIdx) || measures[0])?.value_format;
  // Axis titles — match Looker: y_axes[].label (or the measure label), and
  // x_axis_label (or the dimension label).
  // Truncate rotated y-axis names to the available plot height (short tiles
  // can't fit a long vertical title) — ~5.6px per char at fontSize 10.
  const clip = (s, max) => (s && s.length > max ? s.slice(0, Math.max(1, max - 1)).trimEnd() + '…' : (s || ''));
  const yBudget = Math.max(8, Math.floor((boxH - 80) / 5.6));
  const yNameRaw = (axisIdx) => {
    const cfg = (visConfig.y_axes || []).find((ax) => (ax.orientation === 'right') === (axisIdx === 1));
    if (cfg && cfg.label) return cfg.label;
    const m = measures.find((mm) => yIndexOf(mm) === axisIdx);
    return m ? (m.label_short || m.label || '') : '';
  };
  const yName = (axisIdx) => clip(yNameRaw(axisIdx), yBudget);
  const xNameRaw = visConfig.show_x_axis_label === false ? '' : (visConfig.x_axis_label || primaryDim?.label || primaryDim?.label_short || '');
  const xName = isBar ? clip(xNameRaw, yBudget) : clip(xNameRaw, 70);

  const nameStyle = { fontSize: 10, color: nameC, fontWeight: 500 };
  const valueAxis = (axisIdx, position) => ({
    type: 'value', position,
    name: yName(axisIdx), nameLocation: 'middle', nameGap: 46, nameRotate: position === 'right' ? -90 : 90,
    nameTextStyle: nameStyle,
    axisLabel: { fontSize: 10, color: axisC, formatter: (v) => formatAxis(v, fmtFor(axisIdx)) },
    splitLine: { lineStyle: { color: splitC } },
    axisLine: { show: false }, axisTick: { show: false },
  });
  const catAxis = {
    type: 'category', data: labels, boundaryGap: true,
    name: isBar ? '' : xName, nameLocation: 'middle', nameGap: 28, nameTextStyle: nameStyle,
    axisLabel: { fontSize: 10, color: axisC, hideOverlap: true, rotate: labels.length > 8 && !isBar ? 35 : 0 },
    axisLine: { lineStyle: { color: axisLineC } }, axisTick: { show: false },
  };

  const xAxis = isBar ? valueAxis(0, 'bottom') : catAxis;
  const yAxis = isBar
    ? catAxis
    : (dual ? [valueAxis(0, 'left'), valueAxis(1, 'right')] : [valueAxis(0, 'left')]);

  const showLegend = series.length > 1;
  // Reserve room for rotated axis names so they aren't clipped at the edges
  // (containLabel fits tick labels but not the offset axis name).
  const leftName = isBar ? 0 : (yName(0) ? 20 : 0);
  const rightName = (!isBar && dual && yName(1)) ? 20 : 0;
  const xNameSpace = (isBar ? (yName(0) ? 18 : 0) : (xName ? 18 : 0));
  return {
    seriesMeta,
    option: {
      ...baseAnim,
      color: chartPalette(),
      grid: { left: 6 + leftName, right: (dual ? 6 : 14) + rightName, top: 12, bottom: (showLegend ? 34 : 18) + xNameSpace, containLabel: true },
      tooltip: {
        trigger: isScatter ? 'item' : 'axis',
        ...tip,
        axisPointer: { type: isBar ? 'line' : 'shadow', shadowStyle: { color: hexToRgba(brandPrimary(), 0.06) } },
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

function makeSeries(name, vals, idx, { isBar, isLine, isArea, isScatter, stacked, yAxisIndex = 0, showLabels = false, labelC = '#5a5a5a', fmt }) {
  const c = color(idx);
  // Value labels on each point/bar (Looker's show_value_labels). For dense
  // line/area/scatter series, thin the labels so a readable subset shows
  // (≈ Looker's label_density). Thin by non-null points — series are often
  // sparse (e.g. 7 values across a 30-day axis).
  const isPoint = isLine || isScatter;
  const nonNull = [];
  vals.forEach((v, i) => { if (v != null) nonNull.push(i); });
  const lstep = isPoint ? Math.max(1, Math.ceil(nonNull.length / 8)) : 1;
  const labelSet = new Set(nonNull.filter((_, k) => k % lstep === 0 || k === nonNull.length - 1));
  const label = showLabels ? {
    show: true, position: isBar ? 'right' : 'top', distance: 4,
    fontSize: 9, color: labelC, fontWeight: 500,
    formatter: (p) => {
      if (!labelSet.has(p.dataIndex)) return '';
      const v = Array.isArray(p.value) ? p.value[p.value.length - 1] : p.value;
      if (v == null) return '';
      // Abbreviate only wide labels (e.g. 24,114,666.98 → 24.1M) so big
      // numbers don't overlap, while short values stay exact.
      const full = formatNumber(v, fmt);
      return full.replace('-', '').length > 7 ? formatAxis(v, fmt) : full;
    },
  } : undefined;
  const labelLayout = showLabels && isBar ? { hideOverlap: true } : undefined;
  if (isScatter) {
    return { name, type: 'scatter', yAxisIndex, data: vals, symbolSize: 10, itemStyle: { color: hexToRgba(c, 0.8) }, label, labelLayout };
  }
  if (isLine) {
    return {
      // ECharts line labels only render at shown symbols, so reveal small
      // symbols when value labels are enabled.
      name, type: 'line', yAxisIndex, data: vals, smooth: true,
      showSymbol: showLabels, symbolSize: showLabels ? 4 : 6,
      lineStyle: { width: 3, color: c }, itemStyle: { color: c },
      areaStyle: isArea ? { color: areaGradient(c) } : undefined,
      stack: stacked ? 'total' : undefined,
      label, labelLayout,
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
    label, labelLayout,
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
