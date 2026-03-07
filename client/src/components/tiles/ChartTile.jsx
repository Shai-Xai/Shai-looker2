import { useRef, useEffect } from 'react';
import {
  Chart,
  CategoryScale, LinearScale, BarElement, LineElement, PointElement, ArcElement,
  Tooltip, Legend, Filler,
} from 'chart.js';

Chart.register(CategoryScale, LinearScale, BarElement, LineElement, PointElement, ArcElement, Tooltip, Legend, Filler);

// Colour palette for datasets
const PALETTE = [
  '#ff385c', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#6366f1',
];

function getColor(i, alpha = 1) {
  const hex = PALETTE[i % PALETTE.length];
  if (alpha === 1) return hex;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export default function ChartTile({ data, visConfig }) {
  const canvasRef = useRef(null);
  const chartRef = useRef(null);

  const fields = data.fields || {};
  const rows = data.data || [];
  const dimensions = fields.dimensions || [];
  const measures = fields.measures || [];
  const pivots = data.pivots || [];
  const visType = visConfig?.type || 'looker_column';

  useEffect(() => {
    if (!canvasRef.current || !rows.length) return;

    const isPie = visType === 'looker_pie' || visType === 'looker_donut_multiples';
    const isBar = visType === 'looker_bar'; // horizontal
    const isArea = visType === 'looker_area';

    // Labels from first dimension
    const primaryDim = dimensions[0];
    const labels = rows.map(row => {
      if (!primaryDim) return '';
      const cell = row[primaryDim.name];
      return cell?.rendered ?? cell?.value ?? '';
    });

    let datasets;

    if (pivots.length > 0) {
      // Pivoted data: one dataset per pivot value × measure
      datasets = [];
      pivots.forEach((pivot, pi) => {
        const pivotKey = Object.values(pivot.data || pivot).join(' | ');
        measures.forEach((measure, mi) => {
          const key = `${pivotKey}|${measure.name}`;
          datasets.push({
            label: `${pivotKey} — ${measure.label_short || measure.label}`,
            data: rows.map(row => row[key]?.value ?? row[`${measure.name}_${pi}`]?.value ?? null),
            backgroundColor: getColor(pi * measures.length + mi, isPie ? 0.8 : 0.75),
            borderColor: getColor(pi * measures.length + mi, 1),
            borderWidth: 1.5,
            fill: isArea,
            tension: 0.3,
          });
        });
      });
    } else if (isPie) {
      const measure = measures[0];
      datasets = [{
        data: rows.map(row => row[measure?.name]?.value ?? null),
        backgroundColor: labels.map((_, i) => getColor(i, 0.8)),
        borderColor: labels.map((_, i) => getColor(i, 1)),
        borderWidth: 1,
      }];
    } else {
      datasets = measures.map((measure, i) => ({
        label: measure.label_short || measure.label,
        data: rows.map(row => row[measure.name]?.value ?? null),
        backgroundColor: getColor(i, isArea ? 0.2 : 0.75),
        borderColor: getColor(i, 1),
        borderWidth: 1.5,
        fill: isArea,
        tension: 0.3,
      }));
    }

    const chartType = isPie ? 'pie'
      : visType === 'looker_line' || isArea ? 'line'
      : 'bar'; // covers column + bar

    const config = {
      type: chartType,
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: isBar ? 'y' : 'x',
        plugins: {
          legend: { display: datasets.length > 1, position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
          tooltip: {
            callbacks: {
              label: ctx => {
                const measure = measures[ctx.datasetIndex];
                const val = ctx.parsed.y ?? ctx.parsed;
                if (measure?.value_format) return ` ${fmtValue(val, measure.value_format)}`;
                return ` ${typeof val === 'number' ? val.toLocaleString() : val}`;
              },
            },
          },
        },
        scales: isPie ? {} : {
          x: { ticks: { font: { size: 10 }, maxRotation: 45 }, grid: { color: '#f0f0f0' } },
          y: { ticks: { font: { size: 10 } }, grid: { color: '#f0f0f0' } },
        },
        animation: { duration: 300 },
      },
    };

    // Destroy existing chart before re-creating
    if (chartRef.current) {
      chartRef.current.destroy();
    }
    chartRef.current = new Chart(canvasRef.current, config);

    return () => {
      if (chartRef.current) {
        chartRef.current.destroy();
        chartRef.current = null;
      }
    };
  }, [data, visConfig]);

  if (!rows.length) {
    return <Empty />;
  }

  return (
    <div style={{ width: '100%', height: '100%', padding: '8px 12px' }}>
      <canvas ref={canvasRef} />
    </div>
  );
}

// Very basic Looker value_format renderer
function fmtValue(val, fmt) {
  if (!fmt || val == null) return val?.toLocaleString() ?? '—';
  if (fmt.includes('%')) return (val * 100).toFixed(1) + '%';
  if (fmt.includes('€') || fmt.includes('£') || fmt.includes('$')) {
    const sym = fmt.match(/[€£$]/)?.[0] || '';
    return sym + Number(val).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }
  return Number(val).toLocaleString();
}

function Empty() {
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#ccc', fontSize: 12 }}>No data</div>;
}
