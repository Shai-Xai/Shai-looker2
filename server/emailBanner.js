// ─── AI-designed email banners: SVG → PNG ──────────────────────────────────────
// Tier-2 visual design: the Owl (Claude) AUTHORS an SVG banner from a short brief +
// the client's brand colours; we sanitise it and rasterize to a PNG here (resvg, the
// same headless pipeline the Owl uses for WhatsApp charts — no browser). The PNG (a
// data-URL) drops into an image block. Only a static PNG ever reaches a recipient, so
// no SVG runs anywhere; we still strip scripts/foreignObject/external refs defensively.
const { Resvg } = require('@resvg/resvg-js');

// The designer prompt lives here (registered for the AI audit via insights.promptRegistry()).
// Kept deliberately simple/robust: shapes, gradients and ONE short headline in a common
// sans-serif — email banners must read at a glance, and it renders headless (no web fonts).
const DESIGN_SVG_SYSTEM = `You are a senior graphic designer producing a single, clean banner IMAGE for a marketing email, expressed as SVG.

Output ONLY one <svg>…</svg> element — no markdown, no code fence, no explanation, no comment before or after.

Hard rules:
- Root: <svg xmlns="http://www.w3.org/2000/svg" width="W" height="H" viewBox="0 0 W H"> using the EXACT width/height given.
- Use ONLY: rect, circle, ellipse, path, polygon, line, linearGradient/radialGradient/stop, and <text>. No <image>, no <foreignObject>, no <script>, no external href/url() references, no filters that fetch resources.
- Fonts: font-family="Arial, Helvetica, sans-serif" only (nothing custom — it renders headless). Keep text to the ONE short headline given (and an optional 2-4 word kicker); large, high-contrast, never more than ~6 words total. Do not render body copy.
- Design on-brand with the provided colours: use them for backgrounds/gradients/shapes/accents. Aim for a modern, confident event-brand look (bold shapes, a gradient or two, generous negative space). Ensure the headline is legible against its background.
- Fill the whole canvas (a full-bleed background rect first). No transparency around the edges.`;

// Ask Claude to author an SVG banner (uses insights' shared client/model/system helpers).
async function designSvg({ brief, brandColor, secondaryColor, width = 600, height = 240, apiKey, instructions }) {
  const insights = require('./insights');
  const c = insights.requireClient(apiKey);
  const lines = [
    `CANVAS: width=${width} height=${height} (use these exact numbers).`,
    `BRAND COLOURS: primary ${brandColor || '#111111'}${secondaryColor ? `, secondary ${secondaryColor}` : ''}.`,
    `BRIEF: ${brief || 'A bold, modern event banner with a short headline.'}`,
  ];
  const resp = await c.messages.create({
    model: insights.MODEL,
    max_tokens: 2000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    system: insights.systemWith(DESIGN_SVG_SYSTEM, instructions),
    messages: [{ role: 'user', content: lines.join('\n') }],
  });
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const m = text.match(/<svg[\s\S]*<\/svg>/i);
  return m ? m[0] : '';
}

// Keep only the <svg>…</svg>, and remove anything active or off-machine: scripts,
// foreignObject (can embed arbitrary HTML), inline event handlers, and external
// href/src (fetching remote assets). Returns null if there's no usable SVG.
function sanitizeSvg(svg) {
  let s = String(svg || '').trim();
  const m = s.match(/<svg[\s\S]*?<\/svg>/i);
  if (!m) return null;
  s = m[0]
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(["']).*?\1/gi, '')           // onclick=… etc.
    .replace(/\s(?:xlink:href|href|src)\s*=\s*(["'])(?!#)[^"']*\1/gi, ''); // external refs (keep #fragment)
  return s.length > 400000 ? null : s;
}

// Rasterize sanitised SVG → a PNG data-URL at ~2× the target width (crisp on retina).
// Returns null if the SVG is unusable or resvg can't render it.
function svgToPngDataUrl(svg, { width = 600 } = {}) {
  const clean = sanitizeSvg(svg);
  if (!clean) return null;
  try {
    const png = new Resvg(clean, {
      fitTo: { mode: 'width', value: Math.min(1600, Math.max(200, Math.round(width * 2))) },
      font: { loadSystemFonts: true, defaultFontFamily: 'sans-serif' },
    }).render().asPng();
    return `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
  } catch {
    return null;
  }
}

// Route: POST /api/actions/:entityId/design-image { brief, width, height, eventSuiteId }
// → { dataUrl } — the AI designs an SVG banner from the brief + the client's brand,
// which we rasterize to a PNG. Guarded by campaigns.approve + entity ownership.
function mount(app, { auth, insights, anthropicKeyForEntity, aiInstructionsFor, resolveBranding }) {
  app.post('/api/actions/:entityId/design-image', auth.requireAuth, auth.requirePermission('campaigns.approve'), async (req, res) => {
    const entityId = req.params.entityId;
    if (req.user.role !== 'admin' && !(req.user.entityIds || []).includes(entityId)) return res.status(403).json({ error: 'Not allowed' });
    const apiKey = anthropicKeyForEntity(entityId);
    if (!insights.isConfigured(apiKey)) return res.status(400).json({ error: 'AI is not configured for this client' });
    const brief = String((req.body || {}).brief || '').slice(0, 600);
    const width = Math.min(1200, Math.max(200, Number((req.body || {}).width) || 600));
    const height = Math.min(800, Math.max(120, Number((req.body || {}).height) || 240));
    const suiteId = String((req.body || {}).eventSuiteId || '');
    const b = resolveBranding(entityId, suiteId);
    try {
      const svg = await require('./aiUsage').run({ entityId, kind: 'email_design' }, () => designSvg({ brief, brandColor: b.brandColor, secondaryColor: b.secondaryColor, width, height, apiKey, instructions: aiInstructionsFor(suiteId || null, entityId) }));
      const dataUrl = svgToPngDataUrl(svg, { width });
      if (!dataUrl) return res.status(422).json({ error: 'Could not render a banner — try a simpler brief.' });
      res.json({ dataUrl });
    } catch (e) { res.status(500).json({ error: 'Banner design failed — try again in a moment.' }); }
  });
}

module.exports = { sanitizeSvg, svgToPngDataUrl, designSvg, mount, DESIGN_SVG_SYSTEM };
