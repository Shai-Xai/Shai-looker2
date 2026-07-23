// ─── Email content blocks → email-safe HTML ────────────────────────────────────
// A Mailchimp-style block builder for campaign emails: the author stacks blocks
// (heading, text, image, button, divider, spacer, video, social) and this renders
// them to table-based, inline-styled HTML that survives Gmail/Outlook. PURE module
// (no db, no Looker, no tokens/tracking) — the caller wraps the output in the branded
// shell and runs the SAME merge-token + link-tracking pass it uses for custom HTML.
//
// The mirror preview lives in client/src/components/EmailBuilder.jsx — keep the block
// types + shapes in sync. Data-URL images are swapped for hosted URLs by the caller
// (email clients strip data: images), so this uses block.url verbatim.

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Minimal inline formatting for author text: **bold**, *italic* (no line breaks).
const fmtInline = (s) => esc(s)
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
// …plus newlines → <br> for multi-line text/headings.
const fmt = (s) => fmtInline(s).replace(/\n/g, '<br>');

const ALIGN = (a) => (['left', 'center', 'right'].includes(a) ? a : 'left');
const SPACER = { sm: 12, md: 24, lg: 40 };
// Social glyphs (text marks — image icons can't be bundled reliably across clients).
const SOCIAL = { instagram: 'Instagram', facebook: 'Facebook', x: 'X', twitter: 'X', tiktok: 'TikTok', youtube: 'YouTube', linkedin: 'LinkedIn', website: 'Website', email: 'Email' };

// Style tokens the blocks paint with. Derived from a resolved theme (emailTheme.js)
// or, when none is given, from a plain accent colour (back-compat with { brand }).
function ctxFrom(opts = {}) {
  const t = opts.theme;
  if (t) return { accent: t.accent, text: t.text, heading: t.heading, radius: t.radiusPx };
  const accent = opts.brand || '#111111';
  return { accent, text: '#3a3a3c', heading: '#111111', radius: '980px' };
}

// One block → HTML. `ctx` = { accent, text, heading, radius }. Empty blocks render ''.
function blockHtml(block, ctx) {
  const b = block || {};
  const { accent, text: textCol, heading: headCol, radius } = ctx;
  switch (b.type) {
    case 'heading': {
      if (!String(b.text || '').trim()) return '';
      const size = b.level === 3 ? 17 : b.level === 2 ? 21 : 26;
      return `<div style="font-size:${size}px;font-weight:800;color:${esc(headCol)};line-height:1.3;letter-spacing:-0.01em;text-align:${ALIGN(b.align)};margin:0 0 6px;">${fmt(b.text)}</div>`;
    }
    case 'text': {
      if (!String(b.text || '').trim()) return '';
      return `<div style="font-size:14.5px;line-height:1.65;color:${esc(textCol)};text-align:${ALIGN(b.align)};">${fmt(b.text)}</div>`;
    }
    case 'image': {
      if (!String(b.url || '').trim()) return '';
      const width = b.width === 'half' ? '50%' : b.width === 'third' ? '33%' : '100%';
      const img = `<img src="${esc(b.url)}" alt="${esc(b.alt)}" style="width:${width};max-width:100%;border-radius:10px;display:block;margin:${ALIGN(b.align) === 'center' ? '0 auto' : ALIGN(b.align) === 'right' ? '0 0 0 auto' : '0'};" />`;
      return b.href ? `<a href="${esc(b.href)}" style="text-decoration:none;">${img}</a>` : img;
    }
    case 'button': {
      if (!String(b.text || '').trim()) return '';
      const href = String(b.href || '#');
      // Bulletproof table button (survives Outlook), wrapped for alignment.
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:${ALIGN(b.align) === 'center' ? '0 auto' : ALIGN(b.align) === 'right' ? '0 0 0 auto' : '0'};"><tr><td align="center" style="border-radius:${esc(radius)};background:${esc(accent)};"><a href="${esc(href)}" style="display:inline-block;padding:12px 26px;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:${esc(radius)};">${esc(b.text)}</a></td></tr></table>`;
    }
    case 'divider':
      return `<div style="border-top:1px solid #e8e8ec;line-height:0;font-size:0;">&nbsp;</div>`;
    case 'spacer':
      return `<div style="height:${SPACER[b.size] || SPACER.md}px;line-height:0;font-size:0;">&nbsp;</div>`;
    case 'video': {
      // Email can't embed video — show a thumbnail with a ▶ overlay linking out.
      if (!String(b.href || '').trim()) return '';
      const thumb = b.thumb
        ? `<img src="${esc(b.thumb)}" alt="${esc(b.alt || 'Watch the video')}" style="width:100%;max-width:100%;border-radius:10px;display:block;" />`
        : `<div style="width:100%;height:220px;background:#111;border-radius:10px;"></div>`;
      return `<a href="${esc(b.href)}" style="display:block;position:relative;text-decoration:none;">${thumb}<div style="text-align:center;margin-top:8px;font-size:13px;font-weight:700;color:${esc(accent)};">▶ Watch the video</div></a>`;
    }
    case 'social': {
      const items = (b.items || []).filter((it) => it && it.url);
      if (!items.length) return '';
      const links = items.map((it) => `<a href="${esc(it.url)}" style="display:inline-block;margin:0 8px;font-size:12.5px;font-weight:700;color:${esc(accent)};text-decoration:none;">${esc(SOCIAL[it.type] || it.type || 'Link')}</a>`).join('');
      return `<div style="text-align:center;">${links}</div>`;
    }
    case 'quote': {
      if (!String(b.text || '').trim()) return '';
      return `<div style="border-left:3px solid ${esc(accent)};margin:0;padding:4px 0 4px 14px;font-size:15px;font-style:italic;color:${esc(textCol)};line-height:1.6;text-align:${ALIGN(b.align)};">${fmt(b.text)}</div>`;
    }
    case 'list': {
      const lines = String(b.text || '').split('\n').map((s) => s.trim()).filter(Boolean);
      if (!lines.length) return '';
      const tag = b.ordered ? 'ol' : 'ul';
      const lis = lines.map((l) => `<li style="margin:0 0 4px;">${fmtInline(l)}</li>`).join('');
      return `<${tag} style="margin:0;padding-left:22px;font-size:14.5px;color:${esc(textCol)};line-height:1.6;text-align:${ALIGN(b.align)};">${lis}</${tag}>`;
    }
    case 'menu': {
      const links = (b.links || []).filter((l) => l && l.label && l.url);
      if (!links.length) return '';
      const a = links.map((l) => `<a href="${esc(l.url)}" style="display:inline-block;margin:0 10px;font-size:13px;font-weight:600;color:${esc(accent)};text-decoration:none;">${esc(l.label)}</a>`).join('');
      return `<div style="text-align:${ALIGN(b.align) === 'left' ? 'center' : ALIGN(b.align)};">${a}</div>`;
    }
    case 'html':
      // Raw author HTML (an escape hatch, like a Mailchimp code block). It rides the
      // SAME campaign-level token + link-tracking + unsubscribe pass as custom HTML.
      return String(b.html || '').trim();
    case 'columns': {
      // Fluid-hybrid columns: each is width:100% with a max-width sized to fit N
      // across on a wide screen; on a narrow screen the 100% forces them to stack —
      // no media queries (which many clients strip). font-size:0 kills inline gaps.
      const cols = (Array.isArray(b.cols) ? b.cols : []).slice(0, 4).map((c) => renderList(c, ctx).html.trim()).filter(Boolean);
      if (!cols.length) return '';
      if (cols.length === 1) return cols[0];
      const maxW = Math.max(90, Math.floor(548 / cols.length) - 12); // card ≈548px wide, 12px inter-col padding
      const cell = (h) => `<div style="display:inline-block;width:100%;max-width:${maxW}px;vertical-align:top;text-align:left;padding:0 6px;box-sizing:border-box;">${h}</div>`;
      return `<div style="font-size:0;text-align:center;">${cols.map(cell).join('')}</div>`;
    }
    default:
      return '';
  }
}

// Plain-text fallback for one block (for the email's text/plain part).
function blockText(block) {
  const b = block || {};
  const strip = (s) => String(s || '').replace(/\*\*/g, '').replace(/\*/g, '').trim();
  switch (b.type) {
    case 'heading': return strip(b.text);
    case 'text': return strip(b.text);
    case 'button': return b.text ? `${strip(b.text)}: ${b.href || ''}` : '';
    case 'image': return b.href ? b.href : '';
    case 'video': return b.href ? `Watch: ${b.href}` : '';
    case 'social': return (b.items || []).filter((it) => it && it.url).map((it) => `${SOCIAL[it.type] || it.type}: ${it.url}`).join('  ');
    case 'quote': return strip(b.text);
    case 'list': return String(b.text || '').split('\n').map((s) => s.trim()).filter(Boolean).map((l) => `• ${strip(l)}`).join('\n');
    case 'menu': return (b.links || []).filter((l) => l && l.label && l.url).map((l) => `${l.label}: ${l.url}`).join('  ');
    case 'html': return String(b.html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
    case 'columns': return (Array.isArray(b.cols) ? b.cols : []).map((c) => render(c).text).filter(Boolean).join('\n\n');
    case 'divider': return '—';
    default: return '';
  }
}

// Render a block list against pre-resolved style tokens (`ctx`). Each block gets
// consistent vertical rhythm (tighter for spacers/dividers). Used by render() and
// recursively by the columns block.
function renderList(blocks, ctx) {
  const list = Array.isArray(blocks) ? blocks : [];
  const parts = [];
  for (const b of list) {
    const inner = blockHtml(b, ctx);
    if (!inner) continue;
    const gap = (b.type === 'spacer' || b.type === 'divider') ? 8 : 16;
    parts.push(`<div style="margin-bottom:${gap}px;">${inner}</div>`);
  }
  const html = parts.join('\n');
  const text = list.map(blockText).filter(Boolean).join('\n\n');
  return { html, text };
}

// Public entry. opts: { brand } (an accent colour, back-compat) OR { theme } (a
// resolved theme from emailTheme.resolve). Returns { html, text }.
function render(blocks, opts = {}) {
  return renderList(blocks, ctxFrom(opts));
}

// Swap each image/video/thumb data-URL for a hosted URL via hostFor(block, key) →
// URL (or null to leave as-is). Used on real sends so clients don't strip data:.
// Recurses into column children. Returns a NEW blocks array (never mutates config).
function hostImages(blocks, hostFor) {
  const list = Array.isArray(blocks) ? blocks : [];
  return list.map((b) => {
    if (!b) return b;
    const out = { ...b };
    if (b.type === 'image' && /^data:/.test(b.url || '')) { const u = hostFor(b, 'url'); if (u) out.url = u; }
    if (b.type === 'video' && /^data:/.test(b.thumb || '')) { const u = hostFor(b, 'thumb'); if (u) out.thumb = u; }
    if (b.type === 'columns' && Array.isArray(b.cols)) out.cols = b.cols.map((c) => hostImages(c, hostFor));
    return out;
  });
}

// Flatten a block list to every block including column children — so an asset route
// can find an image block by id whether it's top-level or inside a column.
function flattenBlocks(blocks) {
  const out = [];
  for (const b of (Array.isArray(blocks) ? blocks : [])) {
    if (!b) continue;
    out.push(b);
    if (b.type === 'columns' && Array.isArray(b.cols)) for (const c of b.cols) out.push(...flattenBlocks(c));
  }
  return out;
}

// Sanitise a block list from client input: cap count + per-field lengths, keep only
// known types, and give each a stable id (used to host its images on real sends).
// `columns` is allowed at the top level only (no nesting) and its two columns are
// cleaned recursively as plain (non-column) block lists.
const CHILD_TYPES = new Set(['heading', 'text', 'image', 'button', 'divider', 'spacer', 'video', 'social', 'quote', 'list', 'menu', 'html']);
const BLOCK_TYPES = new Set([...CHILD_TYPES, 'columns']);
function cleanBlockList(arr, { allowColumns } = {}) {
  if (!Array.isArray(arr)) return [];
  const allowed = allowColumns ? BLOCK_TYPES : CHILD_TYPES;
  return arr.slice(0, 40).filter((b) => b && allowed.has(b.type)).map((b, i) => {
    const out = {
      id: String(b.id || `b${i}`).slice(0, 40),
      type: b.type,
      text: String(b.text || '').slice(0, 8000),
      level: [1, 2, 3].includes(Number(b.level)) ? Number(b.level) : 1,
      align: ['left', 'center', 'right'].includes(b.align) ? b.align : 'left',
      url: String(b.url || '').slice(0, 1500000),
      thumb: String(b.thumb || '').slice(0, 1500000),
      alt: String(b.alt || '').slice(0, 200),
      href: String(b.href || '').slice(0, 500),
      width: ['full', 'half', 'third'].includes(b.width) ? b.width : 'full',
      size: ['sm', 'md', 'lg'].includes(b.size) ? b.size : 'md',
      ordered: !!b.ordered,                          // list: numbered vs bulleted
      html: String(b.html || '').slice(0, 50000),    // html block: raw author markup
      items: Array.isArray(b.items) ? b.items.slice(0, 8).map((it) => ({ type: String(it?.type || '').slice(0, 20), url: String(it?.url || '').slice(0, 500) })) : [],
      links: Array.isArray(b.links) ? b.links.slice(0, 8).map((l) => ({ label: String(l?.label || '').slice(0, 60), url: String(l?.url || '').slice(0, 500) })) : [], // menu links
    };
    if (b.type === 'columns') out.cols = (Array.isArray(b.cols) ? b.cols : []).slice(0, 4).map((c) => cleanBlockList(c, { allowColumns: false }));
    return out;
  });
}
const cleanBlocks = (arr) => cleanBlockList(arr, { allowColumns: true });

module.exports = { render, hostImages, flattenBlocks, cleanBlocks, blockHtml, blockText };
