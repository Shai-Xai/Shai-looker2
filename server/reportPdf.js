// ─── Report snapshot → PDF ───────────────────────────────────────────────────────
// Renders a Report Studio snapshot (resolved blocks — see server/reports.js) to a
// PDF Buffer with pdfkit. Pure JS, no headless browser: chart tiles are already
// PNGs in report_assets (rendered by server/tileimg.js at snapshot time), so the
// PDF just lays out text, chips, tables and images. Standard Helvetica fonts —
// no font files to ship.

const PDFDocument = require('pdfkit');

const PAGE = { width: 595.28, height: 841.89 }; // A4 portrait, points
const M = 48;                                   // page margin
const W = PAGE.width - M * 2;                   // content width

// Branding colours arrive as hex strings; fall back to the Pulse defaults.
const hex = (c, fb) => (/^#[0-9a-fA-F]{6}$/.test(String(c || '')) ? c : fb);

// Strip the **bold** / *italic* author markers (pdfkit has no inline markup;
// plain text beats leaking asterisks into a client deliverable).
const plain = (s) => String(s || '').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1$2');

// data: URL logo → { buffer, isPng } (pdfkit takes PNG/JPEG buffers).
function logoBuffer(logo) {
  const m = /^data:image\/(png|jpe?g);base64,(.+)$/.exec(String(logo || ''));
  if (!m) return null;
  try { return Buffer.from(m[2], 'base64'); } catch { return null; }
}

function renderPdf(content, { branding = {}, getAsset }) {
  return new Promise((resolve, reject) => {
    const accent = hex(branding.brandColor, '#FF2D55');
    const doc = new PDFDocument({ size: 'A4', margins: { top: M, bottom: M + 14, left: M, right: M }, bufferPages: true, info: { Title: content.title || 'Report' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const ensure = (h) => { if (doc.y + h > PAGE.height - M - 20) doc.addPage(); };

    // ── header: logo / wordmark, title, date, accent rule ──
    const logo = logoBuffer(branding.logo);
    if (logo) { try { doc.image(logo, M, M, { fit: [140, 36] }); doc.y = M + 46; } catch { doc.y = M; } }
    if (!logo && branding.wordmark) { doc.font('Helvetica-Bold').fontSize(13).fillColor('#111111').text(branding.wordmark, M, M); doc.moveDown(0.6); }
    doc.font('Helvetica-Bold').fontSize(24).fillColor('#111111').text(plain(content.title || 'Report'), M, doc.y, { width: W });
    const dateLine = content.generatedAt ? new Date(content.generatedAt).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Johannesburg' }) : '';
    if (dateLine) { doc.font('Helvetica').fontSize(10).fillColor('#86868b').text(dateLine, { width: W }); }
    doc.moveDown(0.4);
    doc.moveTo(M, doc.y).lineTo(M + W, doc.y).lineWidth(2).strokeColor(accent).stroke();
    doc.moveDown(1);

    // ── blocks ──
    // Consecutive KPI chips flow onto one row; buffer them and flush on any other block.
    let chipX = M;
    let chipRowBottom = 0;
    const flushChips = () => { if (chipRowBottom) { doc.y = chipRowBottom + 14; doc.x = M; chipX = M; chipRowBottom = 0; } };
    const drawChip = (b) => {
      const label = String(b.title || '').slice(0, 40);
      const value = String(b.value || '—').slice(0, 30);
      doc.font('Helvetica-Bold');
      const wVal = doc.fontSize(16).widthOfString(value);
      const wLab = doc.fontSize(7.5).widthOfString(label.toUpperCase());
      const w = Math.min(W, Math.max(wVal, wLab) + 28);
      if (chipX > M && chipX + w > M + W) { doc.y = chipRowBottom + 10; chipX = M; }
      const y0 = chipRowBottom && chipX > M ? chipRowBottom - 52 : (ensure(64), doc.y);
      doc.roundedRect(chipX, y0, w, 52, 8).lineWidth(1).strokeColor('#e2e2e8').stroke();
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#86868b').text(label.toUpperCase(), chipX + 14, y0 + 11, { width: w - 28, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(16).fillColor('#111111').text(value, chipX + 14, y0 + 24, { width: w - 28, lineBreak: false });
      chipRowBottom = y0 + 52;
      chipX += w + 10;
    };

    for (const b of content.blocks || []) {
      if (!(b.type === 'tile' && b.kind === 'kpi')) flushChips();
      switch (b.type) {
        case 'heading': {
          ensure(40);
          doc.moveDown(0.5);
          doc.font('Helvetica-Bold').fontSize(b.level === 2 ? 13 : 16).fillColor('#111111').text(plain(b.text), M, doc.y, { width: W });
          doc.moveDown(0.35);
          break;
        }
        case 'text': {
          ensure(30);
          doc.font('Helvetica').fontSize(10.5).fillColor('#3a3a3c').text(plain(b.text), M, doc.y, { width: W, lineGap: 2.5 });
          doc.moveDown(0.7);
          break;
        }
        case 'ai': {
          const body = plain(b.text || b.note || '');
          if (!body) break;
          doc.font('Helvetica').fontSize(10.5);
          const h = doc.heightOfString(body, { width: W - 26, lineGap: 2.5 }) + 24;
          ensure(Math.min(h, 400));
          const y0 = doc.y;
          doc.font('Helvetica-Bold').fontSize(7.5).fillColor(accent).text('ANALYSIS', M + 14, y0 + 2);
          doc.font(b.text ? 'Helvetica' : 'Helvetica-Oblique').fontSize(10.5).fillColor('#3a3a3c').text(body, M + 14, y0 + 14, { width: W - 26, lineGap: 2.5 });
          doc.moveTo(M + 2, y0).lineTo(M + 2, doc.y).lineWidth(2.5).strokeColor(accent).stroke();
          doc.moveDown(0.8);
          break;
        }
        case 'button': {
          if (!b.text) break;
          ensure(22);
          doc.font('Helvetica-Bold').fontSize(10.5).fillColor(accent).text(`${plain(b.text)} »`, M, doc.y, { width: W, link: b.href || undefined, underline: !!b.href });
          doc.moveDown(0.6);
          break;
        }
        case 'divider': {
          ensure(16);
          doc.moveDown(0.3);
          doc.moveTo(M, doc.y).lineTo(M + W, doc.y).lineWidth(0.7).strokeColor('#e2e2e8').stroke();
          doc.moveDown(0.6);
          break;
        }
        case 'image': {
          const bytes = b.assetToken && getAsset ? getAsset(b.assetToken) : null;
          if (bytes && /png|jpe?g/i.test(bytes.mime || '')) {
            ensure(200);
            try { doc.image(bytes.bytes, M, doc.y, { fit: [W, 320], align: 'center' }); doc.y += Math.min(320, 240); doc.moveDown(0.6); } catch { /* unsupported image — skip */ }
          }
          break;
        }
        case 'tile': {
          if (b.kind === 'kpi') { drawChip(b); break; }
          if (b.kind === 'chart') {
            const a = getAsset ? getAsset(b.assetToken) : null;
            if (a) {
              ensure(300);
              // Charts render at 1040×600 (2×) — draw at content width, 4:2.3 ratio.
              const h = W * (300 / 520);
              try { doc.image(a.bytes, M, doc.y, { width: W, height: h }); doc.y += h; doc.moveDown(0.8); } catch { /* skip broken image */ }
            }
            break;
          }
          if (b.kind === 'table') {
            const cols = (b.columns || []).slice(0, 8);
            if (!cols.length) break;
            const rows = b.rows || [];
            const cw = W / cols.length;
            const rowH = (cells, font, size) => { doc.font(font).fontSize(size); return Math.max(...cells.map((c) => doc.heightOfString(String(c || ' '), { width: cw - 10 }))) + 8; };
            ensure(60);
            if (b.title) { doc.font('Helvetica-Bold').fontSize(11).fillColor('#111111').text(b.title, M, doc.y, { width: W }); doc.moveDown(0.3); }
            let y = doc.y;
            const hh = rowH(cols, 'Helvetica-Bold', 7.5);
            cols.forEach((c, i) => doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#86868b').text(String(c).toUpperCase(), M + i * cw + 4, y + 4, { width: cw - 10 }));
            y += hh;
            doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.8).strokeColor('#d9d9df').stroke();
            for (const r of rows) {
              const h = rowH(r, 'Helvetica', 9);
              if (y + h > PAGE.height - M - 24) { doc.addPage(); y = doc.y; }
              r.slice(0, cols.length).forEach((v, i) => doc.font('Helvetica').fontSize(9).fillColor('#3a3a3c').text(String(v ?? ''), M + i * cw + 4, y + 4, { width: cw - 10 }));
              y += h;
              doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.4).strokeColor('#ececf1').stroke();
            }
            if (b.more) { doc.font('Helvetica-Oblique').fontSize(8.5).fillColor('#86868b').text(`… ${b.more} more rows`, M, y + 4); y += 16; }
            doc.y = y;
            doc.x = M;
            doc.moveDown(0.9);
            break;
          }
          if (b.kind === 'missing') {
            ensure(20);
            doc.font('Helvetica-Oblique').fontSize(9.5).fillColor('#86868b').text(`${b.title || 'Tile'} — data unavailable at generation time`, M, doc.y, { width: W });
            doc.moveDown(0.6);
          }
          break;
        }
        default: break;
      }
    }
    flushChips();

    // ── footer on every page ──
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      // Writing inside the bottom margin would trigger pdfkit's auto page-add —
      // zero the margin for the footer write, then restore it.
      const keep = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.font('Helvetica').fontSize(8).fillColor('#a1a1a6')
        .text(`${branding.wordmark || 'Howler : Pulse'} — generated by Howler : Pulse${range.count > 1 ? `  ·  ${i + 1}/${range.count}` : ''}`, M, PAGE.height - M + 6, { width: W, align: 'center', lineBreak: false });
      doc.page.margins.bottom = keep;
    }
    doc.end();
  });
}

module.exports = { renderPdf };
