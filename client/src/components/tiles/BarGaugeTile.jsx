import { cellText, formatNumber } from '../../lib/format.js';
import { useDrill } from '../../lib/DrillContext.jsx';
import AutoFitText from '../AutoFitText.jsx';

// Horizontal bar gauge — mirrors the Looker marketplace "bar_gauge" viz in
// its horizontal style: a track from range_min→range_max, a coloured fill for
// the current value, and an optional target marker with a label.
export default function BarGaugeTile({ data, visConfig = {} }) {
  const { openDrill, canDrill } = useDrill();
  const fields = data.fields || {};
  const rows = data.data || [];
  const measures = [...(fields.measures || []), ...(fields.table_calculations || [])];
  const measure = measures[0];
  if (!rows.length || !measure) return <Empty />;

  const cell = rows[0][measure.name];
  const value = Number(cell?.value);
  const fmt = measure.value_format;

  // Range + colours (prefer the bar_* keys used by the horizontal style).
  const min = num(visConfig.bar_range_min ?? visConfig.range_min, 0);
  const max = num(visConfig.bar_range_max ?? visConfig.range_max, value || 100);
  const fillColor = visConfig.bar_fill_color || '#1f77b4';
  const bgColor = visConfig.bar_background_color || '#e6e6e6';
  const targetColor = visConfig.bar_spinner_color || visConfig.bar_range_color || '#282828';

  const pct = clampPct(value, min, max);

  // Target: explicit override, else a second measure if present.
  let target = null;
  if ((visConfig.bar_target_source || visConfig.target_source) === 'override') {
    const t = Number(visConfig.bar_target_value_override ?? visConfig.target_value_override);
    if (!Number.isNaN(t)) target = t;
  } else if (measures[1]) {
    const t = Number(rows[0][measures[1].name]?.value);
    if (!Number.isNaN(t)) target = t;
  }
  const targetPct = target != null ? clampPct(target, min, max) : null;
  const targetLabel = visConfig.bar_target_label_override || visConfig.target_label_override
    || (target != null ? formatNumber(target, fmt) : '');

  const valueLabel = cellText(cell);
  const drillable = canDrill(cell?.links);

  return (
    <div style={wrap}>
      <AutoFitText
        max={30}
        min={12}
        style={{ height: 40 }}
        onClick={drillable ? () => openDrill(cell.links, measure.label_short || measure.label) : undefined}
        spanStyle={{
          fontWeight: 700, color: '#222', letterSpacing: '-0.4px',
          ...(drillable ? { textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 4 } : null),
        }}
      >
        {valueLabel}
      </AutoFitText>

      {/* Track */}
      <div style={{ position: 'relative', width: '100%', height: 22, background: bgColor, borderRadius: 4, marginTop: 14 }}>
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct}%`, background: fillColor, borderRadius: 4, transition: 'width .3s' }} />
        {targetPct != null && (
          <div style={{ position: 'absolute', top: -4, bottom: -4, left: `${targetPct}%`, width: 2, background: targetColor }} />
        )}
      </div>

      {/* Min / target / max labels */}
      <div style={{ position: 'relative', width: '100%', marginTop: 5, height: 16, fontSize: 10, color: 'var(--muted)' }}>
        <span style={{ position: 'absolute', left: 0 }}>{formatNumber(min, fmt)}</span>
        <span style={{ position: 'absolute', right: 0 }}>{formatNumber(max, fmt)}</span>
        {targetPct != null && targetLabel && (
          <span style={{ position: 'absolute', left: `${targetPct}%`, transform: 'translateX(-50%)', color: targetColor, fontWeight: 600, whiteSpace: 'nowrap', top: 0 }}>
            ▼ {targetLabel}
          </span>
        )}
      </div>
    </div>
  );
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isNaN(n) ? fallback : n;
}
function clampPct(value, min, max) {
  if (max === min || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
}

const wrap = { display: 'flex', flexDirection: 'column', justifyContent: 'center', height: '100%', padding: '12px 18px' };

function Empty() {
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#ccc', fontSize: 12 }}>No data</div>;
}
