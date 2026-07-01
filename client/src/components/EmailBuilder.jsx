import { useRef, useState } from 'react';
import { useIsMobile } from '../lib/useIsMobile.js';
import { api } from '../lib/api.js';
import { THEME_PRESETS, THEME_FONTS, THEME_SHAPES } from '../lib/emailTheme.js';

// Campaign email "theme" (Tier-1 visual design): a preset look + optional accent /
// font / button shape. Applied server-side; the live preview shows it. Collapsed by
// default to keep the builder tidy.
export function ThemePicker({ value, onChange }) {
  const t = value || { preset: 'clean' };
  const [open, setOpen] = useState(false);
  const set = (patch) => onChange({ ...t, ...patch });
  const swatch = (colors) => (
    <span style={{ display: 'inline-flex', borderRadius: 4, overflow: 'hidden', border: '1px solid var(--hairline)' }}>
      {colors.map((c, i) => <span key={i} style={{ width: 10, height: 14, background: c }} />)}
    </span>
  );
  return (
    <div style={{ border: '1px solid var(--hairline)', borderRadius: 10, padding: 10, marginBottom: 10, background: 'var(--card)' }}>
      <button type="button" onClick={() => setOpen((v) => !v)} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text)', padding: 0 }}>
        <span style={{ width: 12, fontSize: 10, transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}>▶</span>
        <span style={{ fontWeight: 700, fontSize: 13, flex: 1, textAlign: 'left' }}>🎨 Theme <span style={{ color: 'var(--muted)', fontWeight: 500 }}>· {(THEME_PRESETS.find((p) => p.key === t.preset) || THEME_PRESETS[0]).label}</span></span>
      </button>
      {open && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {THEME_PRESETS.map((p) => (
              <button key={p.key} type="button" onClick={() => set({ preset: p.key })}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderRadius: 8, cursor: 'pointer', fontSize: 12.5, fontWeight: 600, border: t.preset === p.key ? '1.5px solid var(--brand)' : '1px solid var(--hairline)', background: t.preset === p.key ? 'rgba(var(--brand-rgb,255,56,92),0.08)' : 'var(--card)', color: 'var(--text)' }}>
                {swatch(p.swatch)} {p.label}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--muted)' }}>
              Accent
              <input type="color" value={t.accent || '#000000'} onChange={(e) => set({ accent: e.target.value })} style={{ width: 34, height: 26, padding: 0, border: '1px solid var(--hairline)', borderRadius: 6, background: 'none', cursor: 'pointer' }} title="Button/link colour (defaults to the client brand colour)" />
              {t.accent && <button type="button" style={{ ...miniBtn, padding: '3px 8px' }} onClick={() => set({ accent: '' })}>Use brand</button>}
            </label>
            <label style={{ fontSize: 12.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>Font
              <select style={{ ...input, width: 'auto', padding: '5px 8px' }} value={t.font || 'system'} onChange={(e) => set({ font: e.target.value })}>{THEME_FONTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            </label>
            <label style={{ fontSize: 12.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>Buttons
              <select style={{ ...input, width: 'auto', padding: '5px 8px' }} value={t.radius || 'pill'} onChange={(e) => set({ radius: e.target.value })}>{THEME_SHAPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
            </label>
          </div>
          <div style={hint}>The theme sets the whole email’s look — accent defaults to the client’s brand colour. The Owl can pick a theme for you when it designs the email.</div>
        </div>
      )}
    </div>
  );
}

// ─── Email block builder (Mailchimp-style) ─────────────────────────────────────
// Stack content blocks — heading, text, image, button, video, social, columns,
// divider, spacer — for a campaign email. Reorder by DRAGGING the ⠿ handle (or the
// ↑/↓ buttons on touch), edit inline, delete. A `columns` block holds two nested
// lists (side-by-side on desktop, stacked on mobile). Edits the `blocks` array; the
// live email preview (rendered server-side) shows the result. Email-safe rendering
// happens on the server (server/emailBlocks.js) — keep the block shapes in sync.

const BASE_MENU = [
  { type: 'heading', label: 'Heading', icon: 'H' },
  { type: 'text', label: 'Text', icon: '¶' },
  { type: 'list', label: 'List', icon: '•' },
  { type: 'quote', label: 'Quote', icon: '❝' },
  { type: 'image', label: 'Image', icon: '🖼' },
  { type: 'button', label: 'Button', icon: '🔘' },
  { type: 'video', label: 'Video', icon: '▶' },
  { type: 'social', label: 'Social', icon: '🔗' },
  { type: 'menu', label: 'Menu links', icon: '☰' },
  { type: 'columns', label: 'Columns', icon: '▥' },
  { type: 'html', label: 'HTML', icon: '</>' },
  { type: 'divider', label: 'Divider', icon: '―' },
  { type: 'spacer', label: 'Spacer', icon: '↕' },
];
const SOCIAL_TYPES = ['instagram', 'facebook', 'x', 'tiktok', 'youtube', 'linkedin', 'website', 'email'];
const uid = () => (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `b${Date.now()}${Math.round(Math.random() * 1e6)}`);

function newBlock(type) {
  const base = { id: uid(), type };
  if (type === 'heading') return { ...base, text: 'Heading', level: 2, align: 'left' };
  if (type === 'text') return { ...base, text: '', align: 'left' };
  if (type === 'image') return { ...base, url: '', alt: '', href: '', width: 'full', align: 'center' };
  if (type === 'button') return { ...base, text: 'Buy tickets', href: '', align: 'center' };
  if (type === 'video') return { ...base, thumb: '', href: '', alt: '' };
  if (type === 'social') return { ...base, items: [] };
  if (type === 'menu') return { ...base, links: [], align: 'center' };
  if (type === 'quote') return { ...base, text: '', align: 'left' };
  if (type === 'list') return { ...base, text: '', ordered: false, align: 'left' };
  if (type === 'html') return { ...base, html: '' };
  if (type === 'columns') return { ...base, cols: [[], []] };
  if (type === 'spacer') return { ...base, size: 'md' };
  return base; // divider
}

export default function EmailBuilder({ value, onChange, entityId, eventSuiteId }) {
  // `design` lets an image block call the AI banner designer (Tier-2). Absent → no button.
  const design = entityId ? { entityId, eventSuiteId: eventSuiteId || '' } : null;
  return <BlockList blocks={Array.isArray(value) ? value : []} onChange={onChange} allowColumns design={design} />;
}

// A reusable, reorderable list of blocks — used at the top level AND inside each
// column of a `columns` block (allowColumns=false there, so columns can't nest).
function BlockList({ blocks, onChange, allowColumns = false, design = null }) {
  const [dragI, setDragI] = useState(null);
  const [overI, setOverI] = useState(null);
  const menu = allowColumns ? BASE_MENU : BASE_MENU.filter((m) => m.type !== 'columns');
  const set = (next) => onChange(next);
  const add = (type) => set([...blocks, newBlock(type)]);
  const update = (i, patch) => set(blocks.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  const remove = (i) => set(blocks.filter((_, j) => j !== i));
  const move = (i, dir) => { const j = i + dir; if (j < 0 || j >= blocks.length) return; const next = blocks.slice(); [next[i], next[j]] = [next[j], next[i]]; set(next); };
  const moveTo = (from, to) => { if (from === to || from == null) return; const next = blocks.slice(); const [b] = next.splice(from, 1); next.splice(to, 0, b); set(next); };

  return (
    <div>
      {blocks.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--muted)', padding: '8px 10px', border: '1px dashed var(--hairline)', borderRadius: 8, marginBottom: 8 }}>
          No blocks yet — add one below.
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {blocks.map((b, i) => (
          <div
            key={b.id}
            onDragOver={(e) => { if (dragI != null) { e.preventDefault(); if (overI !== i) setOverI(i); } }}
            onDrop={(e) => { e.preventDefault(); moveTo(dragI, i); setDragI(null); setOverI(null); }}
            style={{ ...card, borderTop: overI === i && dragI != null && dragI !== i ? '2px solid var(--brand)' : card.border, opacity: dragI === i ? 0.5 : 1 }}
          >
            <div style={cardHead}>
              <span
                draggable
                onDragStart={() => setDragI(i)}
                onDragEnd={() => { setDragI(null); setOverI(null); }}
                title="Drag to reorder"
                style={{ cursor: 'grab', color: 'var(--muted)', fontSize: 15, padding: '0 2px', userSelect: 'none' }}
              >⠿</span>
              <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', flex: 1 }}>
                {(BASE_MENU.find((m) => m.type === b.type) || {}).icon} {b.type}
              </span>
              <button type="button" style={iconBtn} onClick={() => move(i, -1)} disabled={i === 0} title="Move up">↑</button>
              <button type="button" style={iconBtn} onClick={() => move(i, 1)} disabled={i === blocks.length - 1} title="Move down">↓</button>
              <button type="button" style={{ ...iconBtn, color: 'var(--error,#ef4444)' }} onClick={() => remove(i)} title="Delete">✕</button>
            </div>
            <BlockEditor block={b} onChange={(patch) => update(i, patch)} design={design} />
          </div>
        ))}
      </div>

      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', marginBottom: 6 }}>Add a block</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {menu.map((m) => (
            <button key={m.type} type="button" style={addBtn} onClick={() => add(m.type)}>
              <span style={{ fontSize: 13 }}>{m.icon}</span> {m.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function BlockEditor({ block: b, onChange, design = null }) {
  const isMobile = useIsMobile();
  const set = (patch) => onChange(patch);
  switch (b.type) {
    case 'heading':
      return (
        <div style={col}>
          <input style={input} value={b.text} onChange={(e) => set({ text: e.target.value })} placeholder="Heading text" />
          <div style={row}>
            <Select value={b.level} onChange={(v) => set({ level: Number(v) })} options={[[1, 'Large (H1)'], [2, 'Medium (H2)'], [3, 'Small (H3)']]} />
            <AlignPicker value={b.align} onChange={(v) => set({ align: v })} />
          </div>
        </div>
      );
    case 'text':
      return (
        <div style={col}>
          <textarea style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }} rows={4} value={b.text} onChange={(e) => set({ text: e.target.value })} placeholder={'Your message… **bold**, *italic* and line breaks work. Tokens {{name}}, {{ticketType}} too.'} />
          <AlignPicker value={b.align} onChange={(v) => set({ align: v })} />
        </div>
      );
    case 'image':
      return (
        <div style={col}>
          <BlockImage value={b.url} onChange={(v) => set({ url: v })} design={design} />
          <input style={input} value={b.href} onChange={(e) => set({ href: e.target.value })} placeholder="Link when clicked (optional) — https://…" />
          <input style={input} value={b.alt} onChange={(e) => set({ alt: e.target.value })} placeholder="Alt text (accessibility)" />
          <div style={row}>
            <Select value={b.width} onChange={(v) => set({ width: v })} options={[['full', 'Full width'], ['half', 'Half'], ['third', 'Third']]} />
            <AlignPicker value={b.align} onChange={(v) => set({ align: v })} />
          </div>
        </div>
      );
    case 'button':
      return (
        <div style={col}>
          <input style={{ ...input, fontWeight: 700 }} value={b.text} onChange={(e) => set({ text: e.target.value })} placeholder="Button text" />
          <input style={input} value={b.href} onChange={(e) => set({ href: e.target.value })} placeholder="Link — https://… (clicks are tracked)" />
          <AlignPicker value={b.align} onChange={(v) => set({ align: v })} />
        </div>
      );
    case 'video':
      return (
        <div style={col}>
          <BlockImage value={b.thumb} onChange={(v) => set({ thumb: v })} label="Thumbnail" design={design} />
          <input style={input} value={b.href} onChange={(e) => set({ href: e.target.value })} placeholder="Video link — YouTube/Vimeo URL" />
          <div style={hint}>Emails can’t play video inline — this shows the thumbnail with a ▶ that opens the link.</div>
        </div>
      );
    case 'quote':
      return (
        <div style={col}>
          <textarea style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }} rows={3} value={b.text} onChange={(e) => set({ text: e.target.value })} placeholder="A quote or pull-out line…" />
          <AlignPicker value={b.align} onChange={(v) => set({ align: v })} />
        </div>
      );
    case 'list':
      return (
        <div style={col}>
          <textarea style={{ ...input, resize: 'vertical', fontFamily: 'inherit' }} rows={4} value={b.text} onChange={(e) => set({ text: e.target.value })} placeholder={'One item per line…\nDoors at 6pm\nBring your ticket QR'} />
          <div style={row}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}>
              <input type="checkbox" checked={!!b.ordered} onChange={(e) => set({ ordered: e.target.checked })} /> Numbered
            </label>
            <AlignPicker value={b.align} onChange={(v) => set({ align: v })} />
          </div>
        </div>
      );
    case 'social':
      return (
        <div style={col}>
          {(b.items || []).map((it, k) => (
            <div key={k} style={row}>
              <Select value={it.type} onChange={(v) => set({ items: b.items.map((x, j) => (j === k ? { ...x, type: v } : x)) })} options={SOCIAL_TYPES.map((t) => [t, t[0].toUpperCase() + t.slice(1)])} />
              <input style={{ ...input, flex: 2 }} value={it.url} onChange={(e) => set({ items: b.items.map((x, j) => (j === k ? { ...x, url: e.target.value } : x)) })} placeholder="https://…" />
              <button type="button" style={{ ...iconBtn, color: 'var(--error,#ef4444)' }} onClick={() => set({ items: b.items.filter((_, j) => j !== k) })}>✕</button>
            </div>
          ))}
          <button type="button" style={miniBtn} onClick={() => set({ items: [...(b.items || []), { type: 'instagram', url: '' }] })}>＋ Add link</button>
        </div>
      );
    case 'menu':
      return (
        <div style={col}>
          {(b.links || []).map((l, k) => (
            <div key={k} style={row}>
              <input style={{ ...input, flex: 1 }} value={l.label} onChange={(e) => set({ links: b.links.map((x, j) => (j === k ? { ...x, label: e.target.value } : x)) })} placeholder="Label" />
              <input style={{ ...input, flex: 2 }} value={l.url} onChange={(e) => set({ links: b.links.map((x, j) => (j === k ? { ...x, url: e.target.value } : x)) })} placeholder="https://…" />
              <button type="button" style={{ ...iconBtn, color: 'var(--error,#ef4444)' }} onClick={() => set({ links: b.links.filter((_, j) => j !== k) })}>✕</button>
            </div>
          ))}
          <div style={row}>
            <button type="button" style={miniBtn} onClick={() => set({ links: [...(b.links || []), { label: '', url: '' }] })}>＋ Add link</button>
            <AlignPicker value={b.align} onChange={(v) => set({ align: v })} />
          </div>
        </div>
      );
    case 'html':
      return (
        <div style={col}>
          <textarea style={{ ...input, resize: 'vertical', fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 12 }} rows={5} value={b.html} onChange={(e) => set({ html: e.target.value })} placeholder="<table>…your HTML…</table>" />
          <div style={hint}>Pasted HTML is inserted as-is (an escape hatch). Tokens {'{{name}}'} and tracked links still work.</div>
        </div>
      );
    case 'columns': {
      const cols = Array.isArray(b.cols) && b.cols.length ? b.cols : [[], []];
      const setCol = (ci, next) => set({ cols: cols.map((c, j) => (j === ci ? next : c)) });
      return (
        <div style={col}>
          <div style={{ display: 'flex', gap: 8, flexDirection: isMobile ? 'column' : 'row' }}>
            {cols.map((c, ci) => (
              <div key={ci} style={{ flex: 1, minWidth: 0, border: '1px dashed var(--hairline)', borderRadius: 8, padding: 8, background: 'rgba(128,128,128,0.03)' }}>
                <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', flex: 1 }}>Column {ci + 1}</span>
                  {cols.length > 1 && <button type="button" style={{ ...iconBtn, width: 24, height: 24, fontSize: 11, color: 'var(--error,#ef4444)' }} title="Remove column" onClick={() => set({ cols: cols.filter((_, j) => j !== ci) })}>✕</button>}
                </div>
                <BlockList blocks={c} allowColumns={false} design={design} onChange={(next) => setCol(ci, next)} />
              </div>
            ))}
          </div>
          {cols.length < 4 && <button type="button" style={miniBtn} onClick={() => set({ cols: [...cols, []] })}>＋ Add column ({cols.length}/4)</button>}
        </div>
      );
    }
    case 'spacer':
      return <Select value={b.size} onChange={(v) => set({ size: v })} options={[['sm', 'Small gap'], ['md', 'Medium gap'], ['lg', 'Large gap']]} />;
    case 'divider':
      return <div style={hint}>A thin horizontal line.</div>;
    default:
      return null;
  }
}

// Compact image uploader: downscales to ≤1000px JPEG (keeps the data-URL small
// enough for email), or paste a URL. Mirrors CampaignManager's ImageField.
function BlockImage({ value, onChange, label, design = null }) {
  const ref = useRef(null);
  const [briefing, setBriefing] = useState(false);
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false);
  const runDesign = async () => {
    setBusy(true);
    try {
      const r = await api.designImage(design.entityId, { brief, eventSuiteId: design.eventSuiteId || '', width: 600, height: label === 'Thumbnail' ? 340 : 240 });
      if (r.dataUrl) onChange(r.dataUrl);
      setBriefing(false); setBrief('');
    } catch (e) { alert('Design failed: ' + (e.message || e)); }
    finally { setBusy(false); }
  };
  const onFile = (e) => {
    const file = e.target.files?.[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 1000, scale = Math.min(1, max / img.width);
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        onChange(c.toDataURL('image/jpeg', 0.85));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };
  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <div style={{ width: 100, height: 50, border: '1px dashed var(--hairline)', borderRadius: 8, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff', flexShrink: 0 }}>
          {value ? <img src={value} alt="" style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'cover' }} /> : <span style={{ fontSize: 11, color: 'var(--muted)' }}>{label || 'None'}</span>}
        </div>
        <button type="button" style={miniBtn} onClick={() => ref.current?.click()}>Upload</button>
        {value && <button type="button" style={{ ...miniBtn, color: 'var(--error,#ef4444)' }} onClick={() => onChange('')}>Remove</button>}
        {design?.entityId && !briefing && <button type="button" style={{ ...miniBtn, borderColor: 'var(--brand)', color: 'var(--brand)' }} onClick={() => setBriefing(true)} title="Let the Owl design a banner">✨ Design with AI</button>}
        <input ref={ref} type="file" accept="image/*" style={{ display: 'none' }} onChange={onFile} />
      </div>
      {design?.entityId && briefing && (
        <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
          <input style={{ ...input, flex: 1, minWidth: 180 }} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="Describe the banner… e.g. 'sunset festival, headline Last chance'" onKeyDown={(e) => { if (e.key === 'Enter' && !busy) runDesign(); }} />
          <button type="button" style={{ ...miniBtn, borderColor: 'var(--brand)', color: 'var(--brand)' }} disabled={busy} onClick={runDesign}>{busy ? 'Designing…' : 'Generate'}</button>
          <button type="button" style={miniBtn} onClick={() => setBriefing(false)}>Cancel</button>
        </div>
      )}
      {!String(value || '').startsWith('data:') && <input value={value || ''} onChange={(e) => onChange(e.target.value)} placeholder="or paste an image URL" style={{ ...input, marginTop: 6 }} />}
    </div>
  );
}

function AlignPicker({ value, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {[['left', '⇤'], ['center', '↔'], ['right', '⇥']].map(([v, ic]) => (
        <button key={v} type="button" onClick={() => onChange(v)} title={v}
          style={{ ...iconBtn, background: value === v ? 'rgba(var(--brand-rgb,255,56,92),0.12)' : 'var(--card)', color: value === v ? 'var(--brand)' : 'var(--text)', borderColor: value === v ? 'var(--brand)' : 'var(--hairline)' }}>{ic}</button>
      ))}
    </div>
  );
}

function Select({ value, onChange, options }) {
  return (
    <select style={{ ...input, cursor: 'pointer' }} value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

const card = { border: '1px solid var(--hairline)', borderRadius: 10, background: 'var(--card)', padding: 10 };
const cardHead = { display: 'flex', alignItems: 'center', gap: 4, marginBottom: 8 };
const col = { display: 'flex', flexDirection: 'column', gap: 6 };
const row = { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' };
const input = { width: '100%', boxSizing: 'border-box', padding: '8px 10px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, outline: 'none', background: 'var(--card)', color: 'var(--text)' };
const iconBtn = { width: 30, height: 30, borderRadius: 7, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', cursor: 'pointer', fontSize: 13, flexShrink: 0 };
const miniBtn = { padding: '7px 12px', borderRadius: 8, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' };
const addBtn = { ...miniBtn, display: 'inline-flex', alignItems: 'center', gap: 6 };
const hint = { fontSize: 11.5, color: 'var(--muted)' };
