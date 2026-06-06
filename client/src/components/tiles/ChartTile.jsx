import { useRef, useEffect } from 'react';
import {
  Chart,
  BarController, LineController, PieController, DoughnutController,
  CategoryScale, LinearScale, BarElement, LineElement, PointElement, ArcElement,
  Tooltip, Legend, Filler,
} from 'chart.js';
import { cellText, formatNumber, formatAxis } from '../../lib/format.js';

Chart.register(
  BarController, LineController, PieController, DoughnutController,
  CategoryScale, LinearScale, BarElement, LineElement, PointElement, ArcElement,
  Tooltip, Legend, Filler,
);

const PALETTE = [
  '#ff385c', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
];

function hexToRgba(hex, alpha) {
  const h = hex.replace('#', '');
  if (h.length !== 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export default function ChartTile({ data, visConfig = {} }) {
  const canvasRef = useRef(null);
  const chartRef = useRef(null);

  const fields = data.fields || {};
  const rows = data.data || [];
  const dimensions = fields.dimensions || [];
  // Table calculations (running totals, % change, etc.) are plottable series too.
  const measures = [...(fields.measures || []), ...(fields.table_calculations || [])];
  const pivots = data.pivots || [];
  const visType = visConfig?.type || 'looker_column';

  useEffect(() => {
    if (!canvasRef.current || !rows.length) return;

    const isPie = visType === 'looker_pie' || visType === 'looker_donut_multiples';
    const isBar = visType === 'looker_bar'; // horizontal
    const isArea = visType === 'looker_area';
    const stacked = visConfig.stacking === 'normal' || visConfig.stacking === 'percent';

    // Resolve a series colour: Looker series_colors map → colors array → palette.
    const seriesColors = visConfig.series_colors || {};
    const colorsCfg = Array.isArray(visConfig.colors) ? visConfig.colors : null;
    const colorFor = (label, i, alpha = 1) => {
      const c = seriesColors[label] || (colorsCfg && colorsCfg[i]) || PALETTE[i % PALETTE.length];
      return alpha === 1 || !String(c).startsWith('#') ? c : hexToRgba(c, alpha);
    };

    const primaryDim = dimensions[0];
    const labels = rows.map((row) => (primaryDim ? cellText(row[primaryDim.name]) : ''));

    const num = (v) => (v == null || v === '' ? null : Number(v));

    let datasets;
    if (pivots.length > 0) {
      // Pivoted: measure values are nested by pivot key →
      // row[measureName][pivot.key].value
      datasets = [];
      const multiMeasure = measures.length > 1;
      pivots.forEach((pivot, pi) => {
        const plabel = pivot.data ? Object.values(pivot.data).join(' / ') : pivot.key;
        measures.forEach((measure, mi) => {
          const idx = pi * measures.length + mi;
          const label = multiMeasure ? `${plabel} — ${measure.label_short || measure.label}` : plabel;
          datasets.push({
            label,
            _fmt: measure.value_format,
            data: rows.map((row) => num(row[measure.name]?.[pivot.key]?.value)),
            backgroundColor: colorFor(label, idx, isPie ? 0.85 : 0.78),
            borderColor: colorFor(label, idx, 1),
            borderWidth: 1.5,
            fill: isArea,
            tension: 0.3,
          });
        });
      });
    } else if (isPie) {
      const measure = measures[0];
      datasets = [{
        _fmt: measure?.value_format,
        data: rows.map((row) => row[measure?.name]?.value ?? null),
        backgroundColor: labels.map((_, i) => colorFor(labels[i], i, 0.85)),
        borderColor: '#fff',
        borderWidth: 1.5,
      }];
    } else {
      datasets = measures.map((measure, i) => ({
        label: measure.label_short || measure.label,
        _fmt: measure.value_format,
        data: rows.map((row) => row[measure.name]?.value ?? null),
        backgroundColor: colorFor(measure.label_short || measure.label, i, isArea ? 0.25 : 0.78),
        borderColor: colorFor(measure.label_short || measure.label, i, 1),
        borderWidth: 1.5,
        fill: isArea,
        tension: 0.3,
      }));
    }

    const chartType = isPie ? (visType === 'looker_donut_multiples' ? 'doughnut' : 'pie')
      : (visType === 'looker_line' || isArea) ? 'line'
      : 'bar';

    const config = {
      type: chartType,
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: isBar ? 'y' : 'x',
        plugins: {
          legend: {
            display: datasets.length > 1 || isPie,
            position: 'bottom',
            labels: { boxWidth: 12, font: { size: 11 }, usePointStyle: true },
          },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const raw = ctx.parsed.y ?? ctx.parsed.x ?? ctx.parsed;
                const formatted = formatNumber(raw, ctx.dataset._fmt);
                const name = ctx.dataset.label || ctx.label;
                return name ? ` ${name}: ${formatted}` : ` ${formatted}`;
              },
            },
          },
        },
        scales: isPie ? {} : {
          x: {
            stacked,
            ticks: { font: { size: 10 }, maxRotation: 45, autoSkip: true,
              callback: isBar ? (v) => formatAxis(v, datasets[0]?._fmt) : undefined },
            grid: { color: '#f2f2f2' },
          },
          y: {
            stacked,
            ticks: { font: { size: 10 },
              callback: isBar ? undefined : (v) => formatAxis(v, datasets[0]?._fmt) },
            grid: { color: '#f2f2f2' },
          },
        },
        animation: { duration: 300 },
      },
    };

    if (chartRef.current) chartRef.current.destroy();
    chartRef.current = new Chart(canvasRef.current, config);

    return () => {
      if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; }
    };
  }, [data, visConfig]);

  if (!rows.length) return <Empty />;

  return (
    <div style={{ width: '100%', height: '100%', padding: '8px 12px' }}>
      <canvas ref={canvasRef} />
    </div>
  );
}

function Empty() {
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#ccc', fontSize: 12 }}>No data</div>;
}
