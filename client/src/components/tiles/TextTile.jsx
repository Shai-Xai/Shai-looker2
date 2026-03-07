export default function TextTile({ tile }) {
  const text = tile.body_text || '';

  // Very basic markdown: bold, italic, links, line breaks
  const html = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\n/g, '<br/>');

  return (
    <div
      style={{ padding: 12, fontSize: 13, lineHeight: 1.6, color: 'var(--text)', height: '100%', overflowY: 'auto' }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
