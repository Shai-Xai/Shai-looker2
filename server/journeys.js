// ─── Journeys — the Owl's journey-building skill ──────────────────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. A journey is a DECISION TREE of `message`
// (email/SMS) + `decision` nodes that branch on behaviour (opened / clicked /
// bought / no response). This module owns the tree's validation, the Owl's
// `draftJourney` ACT-TOOL (registered in owlTools.js — the NORMAL Owl drafts
// journeys mid-conversation; no separate journey chat), and the starter-recipe
// route the Engage → Journeys tab shows as suggestion prompts. The Owl only
// DRAFTS: the user confirms in chat, which creates a draft campaign a human
// finishes and approves in Engage. Recipes live in actionTemplates.js.
const actionTemplates = require('./actionTemplates');

// Clamp + sanitize an Owl-authored node tree. Returns { nodes, messages, decisions }
// or throws with a readable reason (the Owl sees it and self-corrects).
const MAX_NODES = 14; const MAX_DEPTH = 2;
function cleanNodes(nodes, depth = 0, budget = { left: MAX_NODES }) {
  if (!Array.isArray(nodes)) return [];
  const out = [];
  for (const n of nodes) {
    if (!n || typeof n !== 'object' || budget.left <= 0) continue;
    if (n.type === 'decision') {
      if (depth >= MAX_DEPTH) throw new Error(`Decisions can nest at most ${MAX_DEPTH} levels deep — flatten the tree.`);
      budget.left -= 1;
      const branches = (Array.isArray(n.branches) ? n.branches : []).slice(0, 4)
        .map((b) => ({ label: String(b?.label || 'Branch').slice(0, 60), nodes: cleanNodes(b?.nodes, depth + 1, budget) }))
        .filter((b) => b.nodes.length);
      if (branches.length < 2) throw new Error('A decision needs at least 2 branches, each with at least one message.');
      out.push({ type: 'decision', question: String(n.question || 'What did they do?').slice(0, 140), waitHours: Math.min(720, Math.max(1, Number(n.waitHours) || 48)), branches });
    } else {
      budget.left -= 1;
      out.push({
        type: 'message',
        channel: n.channel === 'sms' ? 'sms' : 'email',
        delayHours: Math.min(8760, Math.max(0, Number(n.delayHours) || 0)),
        subject: String(n.subject || '').slice(0, 200),
        body: String(n.body || '').slice(0, 8000),
        ctaText: String(n.ctaText || '').slice(0, 60),
      });
    }
  }
  return out;
}
function countNodes(nodes) {
  let messages = 0; let decisions = 0;
  for (const n of nodes || []) {
    if (n.type === 'decision') { decisions += 1; for (const b of n.branches) { const c = countNodes(b.nodes); messages += c.messages; decisions += c.decisions; } }
    else messages += 1;
  }
  return { messages, decisions };
}
function validateJourney(j = {}) {
  const nodes = cleanNodes(j.nodes);
  if (!nodes.length) throw new Error('The journey has no steps — give it at least one message.');
  const { messages, decisions } = countNodes(nodes);
  if (!messages) throw new Error('The journey has no messages.');
  return {
    name: String(j.name || 'Journey').slice(0, 120),
    goal: String(j.goal || '').slice(0, 300),
    summary: String(j.summary || '').slice(0, 600),
    nodes, messages, decisions,
  };
}

// The opening (pre-decision) message sequence → drip-engine steps. What the
// linear engine can run as a draft today, until branch execution ships.
function openingSteps(nodes) {
  const trunk = [];
  for (const n of nodes || []) {
    if (n.type === 'message') trunk.push(n);
    else { if (trunk.length) break; const b = (n.branches || [])[0]; return b ? openingSteps(b.nodes) : trunk; }
  }
  return trunk;
}

// The Owl act-tool ({ schema, run } — registered in owlTools.js next to
// draftCampaign, which injects the shared cohort machinery: the curated
// catalogue's dimension index + the query-audience resolver). The NORMAL Owl
// writes the tree (copy included) as tool input; this validates it, grounds
// targeting in a saved segment OR a new cohort (auto-saved as a segment on
// confirm, exactly like draftCampaign), and returns a confirm-card action.
// No model call in here.
function owlTool({ db, getSegmentsApi, dimByName, filterableDims, catalogue, resolveQueryAudience }) {
  const refuse = (reason, message) => ({ ok: false, reason, message });
  async function run(args = {}, ctx = {}) {
    const { user, suiteId } = ctx;
    if (!user) return refuse('no_user', 'No authenticated user in context.');
    const entityId = ctx.entityId || (suiteId && db && db.getSuite ? (db.getSuite(suiteId) || {}).entityId : null);
    if (!entityId) return refuse('no_client', 'Open or pick a client first — a journey belongs to a client.');
    let journey;
    try { journey = validateJourney(args); } catch (e) { return refuse('bad_journey', e.message); }
    // Audience grounding: a saved segment by name, OR a new cohort from curated
    // filters (same validation as createSegment/draftCampaign; PII refused).
    let audience = null; let audienceName = ''; let reach = null;
    const segName = String(args.segmentName || '').trim();
    if (segName) {
      const segApi = typeof getSegmentsApi === 'function' ? getSegmentsApi() : null;
      const list = segApi && segApi.listSegments ? segApi.listSegments(entityId) : [];
      const lc = segName.toLowerCase();
      const seg = list.find((s) => s.name.toLowerCase() === lc)
        || list.find((s) => s.name.toLowerCase().includes(lc) || lc.includes(s.name.toLowerCase()));
      if (!seg) {
        return refuse('no_segment', list.length
          ? `No saved segment called "${segName}". You have: ${list.map((s) => `"${s.name}"`).join(', ')}. Pick one, or give a cohort as filters instead.`
          : 'There are no saved segments for this client yet — give the cohort as filters instead (e.g. buyer country Spain) and it will be saved as a segment.');
      }
      audience = { mode: 'segment', segmentId: seg.id };
      audienceName = seg.name;
      try { if (segApi.resolveSegment) { const r = await segApi.resolveSegment(entityId, seg.id, user); if (r && r.reach) reach = r.reach; } } catch { /* best-effort preview */ }
    } else if (args.filters && Object.keys(args.filters).length) {
      if (!dimByName || !catalogue) return refuse('unavailable', 'Cohort targeting isn\'t available right now — name a saved segment instead.');
      const filters = {}; const desc = [];
      for (const [field, val] of Object.entries(args.filters)) {
        const d = dimByName.get(field);
        if (!d) return refuse('unknown_filter', `"${field}" isn't a field I can target by.`);
        if (d.filterOnly || !filterableDims.has(field)) return refuse('pii_filter', `"${field}" is contact data — it can't define an audience.`);
        if (val == null || String(val).trim() === '') continue;
        filters[field] = String(val);
        desc.push(`${d.label} = ${val}`);
      }
      if (!Object.keys(filters).length) return refuse('no_cohort', 'The cohort filters were empty — give at least one, e.g. buyer country Spain.');
      audience = { mode: 'query', model: catalogue.model, view: catalogue.explore, queryFilters: filters, suiteId: suiteId || '' };
      audienceName = desc.join(' · ');
      try { if (resolveQueryAudience) { const r = await resolveQueryAudience({ entityId, definition: audience, user, suiteId }); if (r && !r.error) reach = r.reach; } } catch { /* best-effort preview */ }
    }
    return { ok: true, confirm: true, action: { kind: 'draftJourney', entityId, ...journey, audience, audienceName, reach } };
  }
  const schema = {
    name: 'draftJourney',
    description:
      'DRAFT a multi-step, multi-channel marketing JOURNEY (an automated sequence with branching), for the user to confirm — you do NOT send or activate anything. Use when the user wants an automated flow with steps/conditions over time ("abandoned cart: email, then SMS if they don\'t open", "win-back with a follow-up for non-openers") rather than a single blast (that\'s draftCampaign). YOU author the whole tree, copy included, as the tool input: `nodes` is an ordered array where each node is EITHER a MESSAGE {type:"message", channel:"email"|"sms", delayHours, subject (email only, <60 chars), body (email 50-120 words / SMS <=300 chars; may use {{name}} once and {{ticketType}} if natural; no invented prices/discounts), ctaText (2-4 words)} OR a DECISION {type:"decision", question (e.g. "After 2 days, did they open it?"), waitHours, branches:[{label (e.g. "Opened" / "No response" / "Bought"), nodes:[...]}]}. Decisions branch on opened / clicked / bought / no response; 2-3 branches each; nest at most 2 deep; keep the whole tree to ~6-10 nodes. A "bought" branch usually thanks and stops. TARGETING: pass segmentName for an EXISTING saved segment, OR filters to build a NEW cohort from curated dimensions (e.g. {"core_purchasers.country":"Spain"}) — on confirm the cohort is auto-SAVED as a reusable segment and the journey pointed at it, so tell the user the segment gets saved too. Provide at most ONE of segmentName/filters; contact/PII fields cannot define the audience. The user taps "Create draft journey" → it lands as a DRAFT in Engage → Campaigns where a human reviews and approves; the branching runs as the engine ships (the opening messages run as a timed sequence today — say so honestly if asked). After calling it, give one line on the flow + audience and tell the user to tap the button.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short journey name, <40 chars (e.g. "Abandoned cart recovery").' },
        goal: { type: 'string', description: 'One sentence: the outcome this journey drives.' },
        summary: { type: 'string', description: '2-3 plain sentences a non-technical promoter reads to understand what happens and how it branches.' },
        nodes: { type: 'array', description: 'The ordered tree of message/decision nodes (see tool description for the exact node shapes).', items: { type: 'object' } },
        segmentName: { type: 'string', description: 'Target an EXISTING saved segment by name (only when the user names one).' },
        filters: { type: 'object', description: 'OR build a NEW cohort as {dimension: value} over curated dimensions, e.g. {"core_purchasers.country":"Spain","core_ticket_types.name":"VIP"}. Auto-saved as a segment on confirm. Contact/PII fields are NOT allowed.' },
      },
      required: ['name', 'nodes'],
    },
  };
  return { schema, run };
}

// The journey-authoring guidance lives in the draftJourney tool description —
// expose it in the AI audit like any other prompt (insights.js spreads this in).
function promptRegistry() {
  return [{ key: 'journey', label: 'Journey drafting (Owl tool)', scope: 'The Owl\'s draftJourney act-tool: how it authors branching journeys in chat', text: owlTool({}).schema.description }];
}

// Starter recipes for the Engage → Journeys tab (suggestion prompts + example
// trees). resolveContext is accepted for mount-signature compatibility.
function mount(app, { auth }) {
  app.get('/api/journeys/:entityId/recipes', auth.requireAuth, auth.requirePermission('campaigns.view'), (req, res) => {
    res.json({ recipes: actionTemplates.listJourneys() });
  });
}

module.exports = { mount, owlTool, validateJourney, openingSteps, promptRegistry };
