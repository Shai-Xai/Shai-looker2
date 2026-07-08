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

// Clamp + sanitize an Owl-authored node tree, stamping what the EXECUTION
// engine needs: stable node `id`s, a `step` number on every message (ties it to
// the per-step open/click tracking), a `kind` on decisions ('behaviour' waits on
// what people DID; 'split' forks instantly on WHO they are — an attribute like
// ticket type / gender / age / location), and a machine `when` predicate on
// behaviour branches (bought | clicked | opened | timeout), inferred from the
// human label when the author omitted it. Throws readable reasons (the Owl
// sees them and self-corrects).
const MAX_NODES = 14; const MAX_DEPTH = 2;
function inferWhen(label) {
  const l = String(label || '').toLowerCase();
  if (/bought|purchas|convert|paid|complete/.test(l)) return 'bought';
  if (/click/.test(l) && /(didn|not|no |never)/.test(l) === false) return 'clicked';
  if (/open/.test(l) && /(didn|not|no |never)/.test(l) === false) return 'opened';
  return 'timeout'; // "no response" / "didn't open" / "otherwise" — the catch-all
}
function cleanNodes(nodes, depth = 0, ctx = { left: MAX_NODES, seq: 0, step: 0 }) {
  if (!Array.isArray(nodes)) return [];
  const out = [];
  for (const n of nodes) {
    if (!n || typeof n !== 'object' || ctx.left <= 0) continue;
    if (n.type === 'decision') {
      if (depth >= MAX_DEPTH) throw new Error(`Decisions can nest at most ${MAX_DEPTH} levels deep — flatten the tree.`);
      ctx.left -= 1;
      const id = `d${(ctx.seq += 1)}`;
      const kind = n.kind === 'split' || n.field ? 'split' : 'behaviour';
      const branches = (Array.isArray(n.branches) ? n.branches : []).slice(0, 4)
        .map((b) => ({
          label: String(b?.label || 'Branch').slice(0, 60),
          ...(kind === 'split'
            ? { values: Array.isArray(b?.values) && b.values.length ? b.values.slice(0, 12).map((v) => String(v).slice(0, 80)) : null } // null = "everyone else"
            : {
              when: ['bought', 'clicked', 'opened', 'timeout', 'in_segment'].includes(b?.when) ? b.when : inferWhen(b?.label),
              // 'in_segment': this branch watches its OWN list — fires when the person
              // is currently in that saved segment (e.g. a "Buyers" segment, an
              // attended-list). Different decisions can watch different segments.
              ...(b?.when === 'in_segment' ? { segmentName: String(b.segmentName || '').slice(0, 120), segmentId: String(b.segmentId || '').slice(0, 60) } : {}),
            }),
          nodes: cleanNodes(b?.nodes, depth + 1, ctx),
        }))
        .filter((b) => b.nodes.length);
      if (branches.length < 2) throw new Error('A decision needs at least 2 branches, each with at least one message.');
      if (kind === 'split') {
        if (!String(n.field || '').trim()) throw new Error('An audience split needs the attribute field it splits on (e.g. core_ticket_types.name).');
        if (!branches.some((b) => b.values === null)) branches[branches.length - 1].values = null; // last branch catches everyone else
        out.push({ type: 'decision', kind, id, question: String(n.question || 'Which group are they in?').slice(0, 140), field: String(n.field).slice(0, 120), branches });
      } else {
        if (!branches.some((b) => b.when === 'timeout')) branches[branches.length - 1].when = 'timeout'; // someone must catch the silence
        out.push({ type: 'decision', kind, id, question: String(n.question || 'What did they do?').slice(0, 140), waitHours: Math.min(720, Math.max(1, Number(n.waitHours) || 48)), branches });
      }
    } else {
      ctx.left -= 1;
      out.push({
        type: 'message',
        id: `m${(ctx.seq += 1)}`,
        step: (ctx.step += 1) - 1, // 0-based — the open-pixel / click-link step used for tracking
        channel: n.channel === 'sms' ? 'sms' : 'email',
        delayHours: Math.min(8760, Math.max(0, Number(n.delayHours) || 0)),
        subject: String(n.subject || '').slice(0, 200),
        body: String(n.body || '').slice(0, 8000),
        ctaText: String(n.ctaText || '').slice(0, 60),
        heroImage: String(n.heroImage || '').slice(0, 1500000), // per-mailer artwork (data-URL/URL) — renders via the existing per-step hero path
        ctaUrl: String(n.ctaUrl || '').slice(0, 500), // per-mailer link override (falls back to the campaign buy link)
        contentMode: n.contentMode === 'html' ? 'html' : 'template', // per-mailer: built template or full custom HTML
        customHtml: String(n.customHtml || '').slice(0, 300000), // rendered via the existing per-step html path (links auto-tracked, unsubscribe guaranteed)
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
    return { ok: true, confirm: true, action: { kind: 'draftJourney', entityId, ...journey, audience, audienceName, reach, master: String(args.master || '').slice(0, 80) } };
  }
  const schema = {
    name: 'draftJourney',
    description:
      'DRAFT a multi-step, multi-channel marketing JOURNEY (an automated sequence with branching), for the user to confirm — you do NOT send or activate anything. Use when the user wants an automated flow with steps/conditions over time ("abandoned cart: email, then SMS if they don\'t open", "win-back with a follow-up for non-openers") rather than a single blast (that\'s draftCampaign). YOU author the whole tree, copy included, as the tool input: `nodes` is an ordered array where each node is EITHER a MESSAGE {type:"message", channel:"email"|"sms", delayHours, subject (email only, <60 chars), body (email 50-120 words / SMS <=300 chars; may use {{name}} once and {{ticketType}} if natural; no invented prices/discounts), ctaText (2-4 words)} OR a DECISION, which comes in two kinds: (a) BEHAVIOUR — waits then branches on what they DID: {type:"decision", question (e.g. "After 2 days, did they open it?"), waitHours, branches:[{label, when:"bought"|"clicked"|"opened"|"in_segment"|"timeout", nodes:[...]}]} — always include a when on each branch ("timeout" = no response, the catch-all). A branch may instead watch a SAVED SEGMENT: {when:"in_segment", segmentName:"Buyers"} fires when the person is currently in that segment — use it when the user wants a specific list to define the condition (e.g. "if they end up on the attended list…"), and different decisions can watch different segments. Branches evaluate in the order you author them, first match wins; (b) SPLIT — forks INSTANTLY on who they ARE: {type:"decision", kind:"split", question (e.g. "VIP or GA?"), field: a curated dimension (e.g. "core_ticket_types.name", buyer city/country, age, gender), branches:[{label, values:["VIP","VVIP"], nodes:[...]}, {label:"Everyone else", values:null, nodes:[...]}]} — use a split when the user wants different treatment per ticket type/category, gender, age or location (e.g. VIPs get one flow, GA another). 2-3 branches per decision (max 4); nest at most 2 deep; keep the whole tree to ~6-10 nodes. A "bought" branch usually thanks and stops. TARGETING — establish the audience BEFORE calling this tool (it is the heart of the journey; ask the user one short question if they haven\'t named who it\'s for): pass segmentName for an EXISTING saved segment, OR filters to build a NEW cohort from curated dimensions (e.g. {"core_purchasers.country":"Spain"}) — on confirm the cohort is auto-SAVED as a reusable segment and the journey pointed at it, so tell the user the segment gets saved too. Provide at most ONE of segmentName/filters; contact/PII fields cannot define the audience. Only draft without an audience if the user explicitly wants to pick it later in Engage. The user taps "Create draft journey" → it lands as a DRAFT in Engage → Campaigns where a human reviews and approves; the branching runs as the engine ships (the opening messages run as a timed sequence today — say so honestly if asked). After calling it: give one line on the flow, STATE the audience size from the returned reach and that a new cohort will be saved as a segment in Engage → Segments, ask the user to confirm the audience is right (or offer: another saved segment, refined filters, or building it from a dashboard tile\'s 🎯 Create segment button / an uploaded list in Engage → Segments, then targeting it here by name), and tell them to tap the button. If reach is zero/missing, flag it and verify the filter values before proceeding.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short journey name, <40 chars (e.g. "Abandoned cart recovery").' },
        goal: { type: 'string', description: 'One sentence: the outcome this journey drives.' },
        summary: { type: 'string', description: '2-3 plain sentences a non-technical promoter reads to understand what happens and how it branches.' },
        nodes: { type: 'array', description: 'The ordered tree of message/decision nodes (see tool description for the exact node shapes).', items: { type: 'object' } },
        segmentName: { type: 'string', description: 'Target an EXISTING saved segment by name (only when the user names one).' },
        filters: { type: 'object', description: 'OR build a NEW cohort as {dimension: value} over curated dimensions, e.g. {"core_purchasers.country":"Spain","core_ticket_types.name":"VIP"}. Auto-saved as a segment on confirm. Contact/PII fields are NOT allowed.' },
        master: { type: 'string', description: 'OPTIONAL master-campaign group name, when the user says this journey belongs to a broader campaign (e.g. "Bushfire 2026 launch"). Groups it with sibling campaigns for combined reporting in Engage.' },
      },
      required: ['name', 'nodes'],
    },
  };
  return { schema, run };
}

// ─── The branching engine ─────────────────────────────────────────────────────
// Executes the tree. STAGING-GATED: runs only when JOURNEY_ENGINE=1 (env) or the
// `journey_engine` setting is '1' — otherwise journey campaigns keep sending
// their linear opening sequence through the classic drip loop, unchanged.
//
// COMPILE: flatten the stored tree into a graph — Map(id → { node, nextId }) —
// where each branch's tail links back to the node AFTER its decision (or ends).
// Pure + exported for tests.
function compile(nodes) {
  const map = new Map();
  const walk = (seq, afterId) => {
    for (let i = 0; i < seq.length; i++) {
      const n = seq[i];
      const nextId = i + 1 < seq.length ? seq[i + 1].id : afterId;
      map.set(n.id, { node: n, nextId });
      if (n.type === 'decision') for (const b of n.branches) walk(b.nodes, nextId);
    }
  };
  walk(nodes || [], null);
  return { map, entryId: (nodes && nodes[0] && nodes[0].id) || null };
}

// Behaviour decision: branches evaluate in AUTHORED order, first-match-wins —
// so the author controls precedence when conditions overlap. Predicates:
// bought / clicked / opened (from signals), in_segment (signals.inSegment(branch)
// — each branch can watch its own saved list). The timeout branch only fires
// once the wait window has expired. Pure.
function pickBranch(decision, signals) {
  for (const b of decision.branches) {
    if (b.when === 'timeout') continue;
    if (b.when === 'in_segment') { if (signals.inSegment && signals.inSegment(b)) return b; continue; }
    if (signals[b.when]) return b;
  }
  if (signals.expired) return decision.branches.find((x) => x.when === 'timeout') || null;
  return null; // keep waiting
}
// Attribute split: instant fork on who the person IS. Case-insensitive value
// match; the `values: null` branch catches everyone else. Pure.
function pickSplit(decision, attributes) {
  const raw = attributes ? attributes[decision.field] : undefined;
  const v = raw == null ? '' : String(raw).trim().toLowerCase();
  for (const b of decision.branches) {
    if (Array.isArray(b.values) && b.values.some((x) => String(x).trim().toLowerCase() === v)) return b;
  }
  return decision.branches.find((b) => b.values === null) || decision.branches[decision.branches.length - 1];
}

const POLL_MS = 3.5 * 60000; // re-check waiting people roughly every tick
const MAX_HOPS = 6; // max sends/moves per person per tick (loop backstop)
function engineOn(sql) {
  if (process.env.JOURNEY_ENGINE === '1') return true;
  try { return (sql.prepare("SELECT value FROM settings WHERE key='journey_engine'").get() || {}).value === '1'; } catch { return false; }
}

// One tick of one journey campaign. Called from the drip loop (which has already
// re-resolved the live audience, conversions and suppressions for this action).
// Same safety net as the classic loop: consent per channel per send, suppression
// ejects, conversion routes (bought) rather than silently exiting.
async function processAction(a, deps) {
  const { sql, now, reachable, convSet, sup, renderFor, renderSmsFor, mailer, messaging, branding, saveResults, audienceFor, sysUser } = deps;
  try { sql.exec("ALTER TABLE action_enrollments ADD COLUMN node_id TEXT NOT NULL DEFAULT ''"); } catch { /* exists */ }
  try { sql.exec("ALTER TABLE action_enrollments ADD COLUMN wait_until TEXT NOT NULL DEFAULT ''"); } catch { /* exists */ }
  const { map, entryId } = compile(stampIfNeeded(a.config.journey).nodes);
  // Per-branch segment watches: any in_segment branch resolves ITS segment live,
  // once per tick — different decisions can watch different lists (a "Buyers"
  // segment at one decision, an attended-list at another). Unresolvable → no match.
  const segSets = new Map();
  if (audienceFor) {
    const segIds = new Set();
    for (const { node } of map.values()) if (node.type === 'decision' && node.kind !== 'split') for (const b of node.branches) if (b.when === 'in_segment' && b.segmentId) segIds.add(b.segmentId);
    for (const sid of segIds) {
      try { const { list } = await audienceFor(a.entityId, { audience: { mode: 'segment', segmentId: sid } }, sysUser); segSets.set(sid, new Set(list.map((m) => String(m.email || '').toLowerCase()))); }
      catch (err) { console.error('[journeys] branch segment resolve failed', a.id, sid, err.message); }
    }
  }
  const due = sql.prepare("SELECT * FROM action_enrollments WHERE action_id=? AND status='active' AND next_at <= ?").all(a.id, now());
  const upd = (e, fields) => sql.prepare(`UPDATE action_enrollments SET ${Object.keys(fields).map((k) => `${k}=?`).join(', ')}, updated_at=? WHERE action_id=? AND email=?`).run(...Object.values(fields), now(), a.id, e.email);
  let sent = 0; let converted = 0; let emailSent = 0; let smsSent = 0;
  const signalsFor = (email) => ({
    bought: convSet ? convSet.has(String(email || '').toLowerCase()) : !reachable.has(email),
    clicked: !!sql.prepare('SELECT 1 FROM action_clicks WHERE action_id=? AND email=? LIMIT 1').get(a.id, email),
    opened: !!sql.prepare('SELECT 1 FROM action_opens WHERE action_id=? AND email=? LIMIT 1').get(a.id, email),
    inSegment: (b) => { const s = b.segmentId && segSets.get(b.segmentId); return !!(s && s.has(String(email || '').toLowerCase())); },
  });
  for (const e of due) {
    if (sup.has(e.email)) { upd(e, { status: 'unsubscribed' }); continue; }
    const row = reachable.get(e.email) || {};
    let id = e.node_id || entryId;
    let waitUntil = e.wait_until || '';
    let boughtRouted = false;
    for (let hops = 0; hops < MAX_HOPS; hops++) {
      const cur = id ? map.get(id) : null;
      if (!cur) { upd(e, { status: boughtRouted ? 'converted' : 'done', node_id: id || '' }); converted += boughtRouted ? 1 : 0; break; }
      const n = cur.node;
      if (n.type === 'message') {
        // A delayed message we only just arrived at: schedule it, don't send yet.
        if (n.delayHours > 0 && e.node_id !== n.id && hops > 0) { upd(e, { node_id: n.id, next_at: new Date(Date.now() + n.delayHours * 3600e3).toISOString(), wait_until: '' }); break; }
        try {
          const rcpt = { email: e.email, name: e.name, ticket: e.ticket, phone: e.phone, attributes: row.attributes || {} };
          let ok = false;
          if (n.channel !== 'sms' && e.email && row.emailOk !== false) { const { html, text, subject } = renderFor(a, rcpt, n, n.step); const r = await mailer.send({ to: e.email, subject: subject || a.title || 'A reminder from your event', html, text, fromName: branding.senderName, kind: 'campaign', entity: a.entityId }); if (r.ok) { ok = true; emailSent += 1; } }
          if (n.channel === 'sms' && e.phone && row.smsOk !== false) { const r = await messaging.sendSms({ to: e.phone, text: renderSmsFor(a, rcpt, n, n.step) }); if (r.ok) { ok = true; smsSent += 1; } }
          if (ok) sent += 1;
        } catch (err) { console.error('[journeys] send failed', a.id, e.email, err.message); }
        id = cur.nextId; waitUntil = '';
        const nx = id ? map.get(id) : null;
        if (!nx) { upd(e, { status: boughtRouted ? 'converted' : 'done', node_id: '' }); converted += boughtRouted ? 1 : 0; break; }
        if (nx.node.type === 'message' && nx.node.delayHours > 0) { upd(e, { node_id: id, next_at: new Date(Date.now() + nx.node.delayHours * 3600e3).toISOString(), wait_until: '' }); break; }
        continue; // immediate next node — same tick
      }
      // Decisions.
      if (n.kind === 'split') { const b = pickSplit(n, row.attributes || {}); id = (b.nodes[0] && b.nodes[0].id) || cur.nextId; waitUntil = ''; continue; }
      if (!waitUntil || e.node_id !== n.id) waitUntil = new Date(Date.now() + (n.waitHours || 48) * 3600e3).toISOString(); // just arrived — open the window
      const sig = signalsFor(e.email); sig.expired = now() >= waitUntil;
      const b = pickBranch(n, sig);
      if (!b) { upd(e, { node_id: n.id, wait_until: waitUntil, next_at: new Date(Date.now() + POLL_MS).toISOString() }); break; } // keep waiting, poll next tick
      if (b.when === 'bought') boughtRouted = true;
      id = (b.nodes[0] && b.nodes[0].id) || cur.nextId; waitUntil = '';
      continue;
    }
    await new Promise((r) => setTimeout(r, 120)); // gentle rate (matches the classic loop)
  }
  if (sent || converted) {
    const res = a.results || {};
    saveResults(a.id, { ...res, sent: (res.sent || 0) + sent, converted: (res.converted || 0) + converted, emailSent: (res.emailSent || 0) + emailSent, smsSent: (res.smsSent || 0) + smsSent });
  }
}

// The journey-authoring guidance lives in the draftJourney tool description —
// expose it in the AI audit like any other prompt (insights.js spreads this in).
function promptRegistry() {
  return [{ key: 'journey', label: 'Journey drafting (Owl tool)', scope: 'The Owl\'s draftJourney act-tool: how it authors branching journeys in chat', text: owlTool({}).schema.description }];
}

// Starter recipes for the Engage → Journeys tab (suggestion prompts + example
// trees). resolveContext is accepted for mount-signature compatibility.
function mount(app, { auth, db }) {
  app.get('/api/journeys/:entityId/recipes', auth.requireAuth, auth.requirePermission('campaigns.view'), (req, res) => {
    res.json({ recipes: actionTemplates.listJourneys() });
  });

  // Live per-node stats for one journey — the tree becomes a funnel. Honest v1:
  // per MESSAGE node, distinct people who opened / clicked it (from the per-step
  // tracking already recorded); per node, how many people are CURRENTLY parked
  // there (waiting at a decision or a delayed message); plus journey totals.
  // ("Sent per node" isn't recorded yet — that lands with the engine's send log.)
  app.get('/api/journeys/:entityId/:actionId/stats', auth.requireAuth, auth.requirePermission('campaigns.view'), (req, res) => {
    const sql = db.db;
    const a = sql.prepare('SELECT * FROM actions WHERE id=? AND entity_id=?').get(req.params.actionId, req.params.entityId);
    if (!a) return res.status(404).json({ error: 'Not found' });
    let cfg = {}; try { cfg = JSON.parse(a.config || '{}'); } catch { /* corrupt config */ }
    if (!cfg.journey?.nodes?.length) return res.status(404).json({ error: 'Not a journey campaign' });
    const journey = stampIfNeeded(cfg.journey);
    const byStep = {};
    try { for (const r of sql.prepare("SELECT step, COUNT(DISTINCT email) n FROM action_opens WHERE action_id=? AND email!='' GROUP BY step").all(a.id)) byStep[r.step] = { ...(byStep[r.step] || {}), opened: r.n }; } catch { /* legacy */ }
    try { for (const r of sql.prepare("SELECT step, COUNT(DISTINCT email) n FROM action_clicks WHERE action_id=? AND email!='' GROUP BY step").all(a.id)) byStep[r.step] = { ...(byStep[r.step] || {}), clicked: r.n }; } catch { /* legacy */ }
    const atNode = {};
    try { for (const r of sql.prepare("SELECT node_id, COUNT(*) n FROM action_enrollments WHERE action_id=? AND status='active' AND node_id!='' GROUP BY node_id").all(a.id)) atNode[r.node_id] = r.n; } catch { /* column lands with the engine */ }
    const totals = { enrolled: 0, active: 0, converted: 0, done: 0, unsubscribed: 0 };
    try { for (const r of sql.prepare('SELECT status, COUNT(*) n FROM action_enrollments WHERE action_id=? GROUP BY status').all(a.id)) { totals[r.status] = r.n; totals.enrolled += r.n; } } catch { /* no enrolments yet */ }
    res.json({ byStep, atNode, totals, nodes: journey.nodes });
  });
}

// Journeys saved before id-stamping existed have no node ids/steps — stamp them
// deterministically on read so the engine and stats work on old trees too.
function stampIfNeeded(journey) {
  if (journey?.nodes?.[0]?.id) return journey;
  try { return validateJourney(journey); } catch { return journey; }
}

// The message node bearing a given tracking step number (for per-node link
// resolution in the click redirect). Stamps old trees on the fly.
function nodeByStep(journey, step) {
  const find = (nodes) => {
    for (const n of nodes || []) {
      if (n.type === 'message' && n.step === step) return n;
      if (n.type === 'decision') for (const b of n.branches) { const hit = find(b.nodes); if (hit) return hit; }
    }
    return null;
  };
  return find(stampIfNeeded(journey)?.nodes);
}

// Link in_segment branches to their saved segments by name (at create time, when
// the segment list is at hand) — the engine then resolves by id each tick.
function linkBranchSegments(nodes, segments) {
  const lc = (s) => String(s || '').toLowerCase();
  const walk = (ns) => {
    for (const n of ns || []) {
      if (n.type !== 'decision') continue;
      for (const b of n.branches || []) {
        if (b.when === 'in_segment' && !b.segmentId && b.segmentName) {
          const hit = (segments || []).find((s) => lc(s.name) === lc(b.segmentName))
            || (segments || []).find((s) => lc(s.name).includes(lc(b.segmentName)) || lc(b.segmentName).includes(lc(s.name)));
          if (hit) { b.segmentId = hit.id; b.segmentName = hit.name; }
        }
        walk(b.nodes);
      }
    }
  };
  walk(nodes);
  return nodes;
}

module.exports = { mount, owlTool, validateJourney, openingSteps, promptRegistry, compile, pickBranch, pickSplit, engineOn, processAction, nodeByStep, linkBranchSegments };
