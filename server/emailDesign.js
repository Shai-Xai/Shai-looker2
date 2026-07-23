// ─── Owl email designer: goal → a full themed BLOCK email ──────────────────────
// Parity with the manual builder: instead of only writing subject/body, the Owl
// designs a structured, on-brand email — a theme (look) + a stack of content blocks
// (heading, text, list, quote, button, columns, divider, spacer). The result drops
// into the SAME block builder for the human to tweak; the server sanitises the blocks
// + theme (actions.cleanConfig → emailBlocks.cleanBlocks / emailTheme.clean), so a
// malformed layout can never reach a send. Uses insights' shared Claude client. The
// prompt is registered for the AI audit via insights.promptRegistry().

const DESIGN_EMAIL_SYSTEM = `You design a marketing email for an event organiser (tickets, festivals, live events) as a THEME + a stack of content BLOCKS — the same building blocks a human editor uses. South African audience; money in Rand.

Respond with ONLY strict JSON (no markdown fences):
{
  "subject": "punchy, specific subject line, <60 chars",
  "theme": { "preset": "clean|bold|warm|minimal", "accent": "" },
  "blocks": [ /* ordered blocks, see types below */ ]
}

Block types (use only these; omit any field you don't need):
- { "type": "heading", "text": "…", "level": 1, "align": "left|center|right" }
- { "type": "text", "text": "a paragraph; **bold**, *italic* and line breaks allowed; tokens {{name}} and {{ticketType}} may be used naturally", "align": "left" }
- { "type": "list", "text": "one item per line", "ordered": false }
- { "type": "quote", "text": "a short pull-quote or highlight" }
- { "type": "button", "text": "2-4 word label", "href": "the buy/checkout URL if given in context, else empty", "align": "center" }
- { "type": "columns", "cols": [ [ …blocks… ], [ …blocks… ] ] }   // 2-4 columns; NEVER nest columns inside columns
- { "type": "divider" }
- { "type": "spacer", "size": "sm|md|lg" }

Rules:
- Build a real email: a heading, one or two short paragraphs, optionally a list/quote or a 2-column highlight, and ONE primary button. 6-12 blocks total; keep copy tight (the body ~60-130 words total).
- Match the GOAL exactly; never invent prices, dates or discounts not given.
- Pick a theme that fits the event's mood (a launch → "bold"; a warm community event → "warm"; default "clean"). Leave "accent" empty to use the client's brand colour, unless a specific colour is clearly warranted.
- No image blocks (the human adds imagery, or generates a banner). No spam tropes, no emoji walls (one tasteful emoji max, in copy).`;

// goal → { subject, theme, blocks } (or null if the model didn't return usable JSON).
async function designEmail({ goal, clientName, clientContext, audienceCount, brandColor, eventName, eventInfo, instructions, apiKey }) {
  const insights = require('./insights');
  const c = insights.requireClient(apiKey);
  const lines = [
    `CLIENT: ${clientName || 'an event organiser'}`,
    clientContext ? `CONTEXT: ${clientContext}` : '',
    eventName ? `EVENT: ${eventName}${eventInfo ? ` — ${eventInfo}` : ''}` : '',
    brandColor ? `BRAND COLOUR: ${brandColor}` : '',
    `AUDIENCE: ${audienceCount || 'unknown number of'} recipients`,
    `GOAL: ${goal || 'Re-engage customers who abandoned their ticket checkout and get them to complete the purchase.'}`,
  ].filter(Boolean);
  const resp = await c.messages.create({
    model: insights.MODEL,
    max_tokens: 1600,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    system: insights.systemWith(DESIGN_EMAIL_SYSTEM, instructions),
    messages: [{ role: 'user', content: lines.join('\n') }],
  });
  const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const out = JSON.parse(m[0]);
    if (!out || !Array.isArray(out.blocks)) return null;
    return { subject: String(out.subject || ''), theme: out.theme || { preset: 'clean' }, blocks: out.blocks };
  } catch { return null; }
}

module.exports = { designEmail, DESIGN_EMAIL_SYSTEM };
