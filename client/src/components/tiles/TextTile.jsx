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
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\n/g, '<br/>');
  return <div style={containerStyle} dangerouslySetInnerHTML={{ __html: html }} />;
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
    case 'link':
      return <a key={key} href={node.url} target="_blank" rel="noopener" style={style}>{children}</a>;
    case 'block-quote':
      return <blockquote key={key} style={{ ...style, borderLeft: '3px solid #ddd', paddingLeft: 10, color: '#666' }}>{children}</blockquote>;
    default:
      return <div key={key} style={{ ...style, fontSize: 13 }}>{children}</div>;
  }
}

// Minimal sanitizer: drop <script>/<style> blocks and inline event handlers.
function sanitize(html) {
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');
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
