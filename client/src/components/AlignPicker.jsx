// A tiny segmented control to align a heading left / center / right, drawn as
// three little bars so it reads at a glance. Shared by Carousel rows and grid
// Sections. `onMouseDown` stops propagation so clicking it never starts a drag.
export function AlignIcon({ dir }) {
  const rows = dir === 'center'
    ? [[2, 8], [3.5, 5], [2, 8]]
    : dir === 'right'
      ? [[3, 9], [6, 6], [3, 9]]
      : [[1, 9], [1, 6], [1, 9]];
  return (
    <svg width="13" height="11" viewBox="0 0 12 11" aria-hidden="true">
      {rows.map(([x, w], i) => <rect key={i} x={x} y={i * 4 + 1} width={w} height="2" rx="1" fill="currentColor" />)}
    </svg>
  );
}

export default function AlignPicker({ value = 'left', onChange }) {
  return (
    <span onMouseDown={(e) => e.stopPropagation()} style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
      {['left', 'center', 'right'].map((d) => (
        <button key={d} type="button" onClick={() => onChange(d)} title={`Align ${d}`} style={{ ...alignBtn, ...(value === d ? alignBtnOn : null) }}>
          <AlignIcon dir={d} />
        </button>
      ))}
    </span>
  );
}

const alignBtn = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, border: '1px solid var(--hairline)', borderRadius: 6, background: 'var(--card)', color: 'var(--muted)', cursor: 'pointer', padding: 0, flexShrink: 0 };
const alignBtnOn = { borderColor: 'var(--brand)', color: 'var(--brand)', background: 'rgba(var(--brand-rgb,255,56,92),0.08)' };
