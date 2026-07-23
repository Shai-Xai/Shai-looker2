// Renders Looker text tiles. Looker stores these three ways:
//  1. Slate rich-text  — body_text is a JSON array of nodes (rich_content_json
//     format "slate"). Headings, alignment, bold/italic.
//  2. Raw HTML          — e.g. an embedded <img> logo (data URI).
//  3. Markdown          — simple **bold**, *italic*, [links](), line breaks.
export default function TextTile({ tile }) {
  const body = tile.body_text || '';

  // 1. Slate rich text
  if (looksLikeSlate(tile)) {
    try {
      const nodes = JSON.parse(body);
      return <div style={containerStyle}>{nodes.map((n, i) => renderNode(n, i))}</div>;
    } catch {
      /* fall through to other renderers */
    }
  }

  // 2. Raw HTML (logos / embedded images)
  if (/<\w+[\s>]/.test(body)) {
    return <div style={containerStyle} dangerouslySetInnerHTML={{ __html: sanitize(body) }} />;
  }

  // 3. Markdown
  const html = body
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Only render a real <a> when the URL scheme is safe; otherwise show the link
    // text as plain text (no href) so `[x](javascript:…)` can't execute on click.
    .replace(/\[(.+?)\]\((.+?)\)/g, (_m, text, url) => {
      const safe = safeUrl(url);
      return safe ? `<a href="${safe}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
    })
    .replace(/\n/g, '<br/>');
  return <div style={containerStyle} dangerouslySetInnerHTML={{ __html: html }} />;
}

// Allow only benign link schemes (http/https/mailto) or relative URLs; reject
// javascript:, data:, vbscript:, etc. Returns a safe href string or '' if unsafe.
function safeUrl(url) {
  const raw = String(url || '').trim();
  if (/^(https?:|mailto:)/i.test(raw)) return raw;
  if (/^[/#?]/.test(raw) || /^[\w./-]+$/.test(raw)) return raw; // relative / anchor
  return '';
}

function looksLikeSlate(tile) {
  if (tile.rich && /slate/i.test(typeof tile.rich === 'string' ? tile.rich : JSON.stringify(tile.rich))) return true;
  const b = (tile.body_text || '').trim();
  return b.startsWith('[{') && b.includes('"children"');
}

// ─── Slate node rendering ──────────────────────────────────────────────────

const HEADING_SIZE = { h1: 22, h2: 18, h3: 15 };

function renderNode(node, key) {
  // Leaf (text run)
  if (node.text !== undefined) {
    let el = node.text;
    if (node.bold) el = <strong key={key}>{el}</strong>;
    if (node.italic) el = <em key={key}>{el}</em>;
    if (node.underline) el = <u key={key}>{el}</u>;
    return <span key={key}>{el}</span>;
  }

  const children = (node.children || []).map((c, i) => renderNode(c, i));
  const style = { textAlign: node.align || 'left', margin: '2px 0' };

  switch (node.type) {
    case 'h1':
    case 'h2':
    case 'h3':
      return <div key={key} style={{ ...style, fontSize: HEADING_SIZE[node.type], fontWeight: 700, lineHeight: 1.2 }}>{children}</div>;
    case 'link': {
      const safe = safeUrl(node.url);
      return safe
        ? <a key={key} href={safe} target="_blank" rel="noopener noreferrer" style={style}>{children}</a>
        : <span key={key} style={style}>{children}</span>;
    }
    case 'block-quote':
      return <blockquote key={key} style={{ ...style, borderLeft: '3px solid #ddd', paddingLeft: 10, color: '#666' }}>{children}</blockquote>;
    default:
      return <div key={key} style={{ ...style, fontSize: 13 }}>{children}</div>;
  }
}

// Best-effort sanitizer for the raw-HTML branch (Looker-authored logos/images).
// Regex sanitizing is inherently limited — this is defense-in-depth on top of the
// fact that only privileged/Looker authors can write tile HTML. It drops active
// content (script/style/iframe/object/embed/link/meta), strips inline event
// handlers, and neutralizes dangerous URL schemes in href/src (keeping data: for
// embedded image logos). A future hardening is a real DOM sanitizer (DOMPurify).
function sanitize(html) {
  return String(html || '')
    .replace(/<\s*(script|style|iframe|object|embed|link|meta)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed|link|meta)[^>]*\/?\s*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src|xlink:href)\s*=\s*("|')\s*(javascript|vbscript|data:text\/html)[^"']*\2/gi, '$1="#"')
    .replace(/(javascript|vbscript)\s*:/gi, '');
}

const containerStyle = {
  height: '100%',
  overflow: 'auto',
  fontSize: 13,
  lineHeight: 1.6,
  color: 'var(--text)',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
};
