// ─── Remote MCP server — Pulse for AI agents ───────────────────────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. Exposes curated read tools over the SAME
// core the /api/v1 REST surface uses (server/api.js `core`) — one implementation,
// two transports (docs/API_MCP_BRIEF.md §6). Authed by the same per-entity API
// key (Authorization: Bearer pulse_sk_…), so an agent is pinned to one client
// and rides every existing scope gate.
//
// Transport: MCP Streamable HTTP in STATELESS mode — each POST /mcp carries its
// own auth and gets a fresh server+transport pair, so any agent platform
// (Claude, etc.) can connect remotely with no session affinity. Tools are
// curated (clear names, tight inputs, honest descriptions — the agent reads
// these to decide), not a 1:1 schema dump. Reads by default; the two `write`
// tools create DRAFTS only (behind the in-app approval flow — no send surface).
//
// Mount: `require('./mcp').mount(app, { apiKeys, core, rateLimit })`.

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { asyncHandler } = require('./http');

function mount(app, { apiKeys, core, rateLimit, clientContextFor }) {
  // One tool table so the list stays curated and auditable. Every handler gets
  // the request's synthetic principal — scope enforcement happens in `core`.
  const TOOLS = [
    {
      name: 'pulse_get_me',
      title: 'Who am I connected to?',
      description: 'START HERE (instant). Who am I: the client this key belongs to, its scopes, and the client\'s events (suites) with their ids. Call ONCE at the start and reuse the suite ids for the rest of the conversation — metrics and goals need them.',
      input: {},
      run: (u, _a, key) => core.me(u, key),
    },
    {
      name: 'pulse_list_dashboards',
      title: 'List dashboards',
      description: 'Instant (no data query). Lists the client\'s dashboards, one entry per (dashboard, event) with its suiteId. Use this to find the dashboardId + suiteId for a metric.',
      input: {},
      run: (u) => ({ dashboards: core.listDashboards(u) }),
    },
    {
      name: 'pulse_get_dashboard',
      title: 'Look at a dashboard',
      description: 'Instant (no data query). One dashboard\'s tile list (id, title, type) and filters. Use it ONLY to discover the tileId you need, then call pulse_get_metric for the number.',
      input: { dashboardId: z.string().describe('Dashboard id from pulse_list_dashboards') },
      run: (u, a) => core.getDashboard(u, a.dashboardId),
    },
    {
      name: 'pulse_get_metric',
      title: 'Read a live metric',
      description: 'PREFERRED for a single number. One live KPI value a tile shows (~1–3s, cached after). Use THIS — not fetch or pulse_get_dashboard — when the user asks about one metric. Pass suiteId to pick the event (defaults to the dashboard\'s first event).',
      input: {
        dashboardId: z.string(),
        tileId: z.string().describe('Tile id from pulse_get_dashboard'),
        suiteId: z.string().optional().describe('Event (suite) id from pulse_list_dashboards / pulse_get_me'),
      },
      run: (u, a) => core.metric(u, a),
    },
    {
      name: 'pulse_list_segments',
      title: 'List audience segments',
      description: 'Instant (cached counts). The client\'s saved audience segments with size + per-channel reach (email/sms). Good enough for most questions; only use pulse_get_segment_reach if the user needs an up-to-the-second figure.',
      input: {},
      run: (u) => ({ segments: core.listSegments(u) }),
    },
    {
      name: 'pulse_get_segment_reach',
      title: 'Count a segment live',
      description: 'LIVE, slower (runs the real audience query). Re-resolves ONE segment for a current size + consent-aware reach. Only call when the cached numbers from pulse_list_segments aren\'t fresh enough.',
      input: { segmentId: z.string().describe('Segment id from pulse_list_segments') },
      run: (u, a) => core.segmentReach(u, a.segmentId),
    },
    {
      name: 'pulse_list_campaigns',
      title: 'List campaigns',
      description: 'Instant. The client\'s campaigns with status + results (sent, clicks, opens, CTR). This list already includes the headline numbers — you usually do NOT need pulse_get_campaign_report as well. Optional status filter: draft | pending | running | done | failed.',
      input: { status: z.string().optional().describe('Filter: draft | pending | running | done | failed') },
      run: (u, a) => ({ campaigns: core.listCampaigns(u, { status: a.status }) }),
    },
    {
      name: 'pulse_get_campaign_report',
      title: 'Read a campaign report',
      description: 'Instant. Full per-channel report for ONE campaign (sent, failed, clicks, opens, CTR, per-channel splits, conversions). Only needed when pulse_list_campaigns doesn\'t already answer the question.',
      input: { campaignId: z.string().describe('Campaign id from pulse_list_campaigns') },
      run: (u, a) => core.getCampaign(u, a.campaignId),
    },
    {
      name: 'pulse_event_ops',
      title: 'Check Event Ops',
      scope: 'read_rows', // operational row-level data (staff names, device movements)
      description: 'LIVE, per event. On-the-ground Event Ops: query=overview (device totals per station + open issues + recent checkpoints), locate (find ONE device by its code), or the devices / issues / staff / stations / checkpoints lists. Requires a suiteId (event) from pulse_get_me and a key with the read_rows scope.',
      input: {
        suiteId: z.string().describe('Event (suite) id from pulse_get_me'),
        query: z.enum(['overview', 'locate', 'devices', 'issues', 'staff', 'stations', 'checkpoints']).optional().describe('What to fetch (default overview)'),
        code: z.string().optional().describe('For locate: the device QR code / serial / label (e.g. SL005)'),
        state: z.enum(['in_stock', 'deployed', 'returned', 'lost', 'damaged']).optional().describe('For devices: filter by state'),
        station: z.string().optional().describe('Filter by station name (devices/staff/checkpoints)'),
        status: z.enum(['open', 'resolved', 'all']).optional().describe('For issues: which ones (default open)'),
      },
      run: (u, a) => core.eventOps(u, a),
    },
    {
      name: 'pulse_get_tile_rows',
      title: 'Pull row-level data',
      scope: 'read_rows', // only registered for keys that explicitly carry it
      description: 'ROW-LEVEL data, LIVE (one query; payload can be large — keep `limit` as small as the task allows). The table behind a tile, every column incl. display-hidden ones, e.g. customer/ticketing records. Requires the read_rows scope; rows may contain personal data.',
      input: {
        dashboardId: z.string(),
        tileId: z.string().describe('Tile id from pulse_get_dashboard'),
        suiteId: z.string().optional().describe('Event (suite) id — which event\'s locks apply (defaults to the dashboard\'s first event)'),
        limit: z.number().optional().describe('Max rows (default 500, cap 10000)'),
      },
      run: (u, a) => core.tileRows(u, a),
    },
    {
      name: 'pulse_list_data_sources',
      title: 'List queryable data',
      description: 'Instant. The curated data sources this client can query DIRECTLY (no dashboard needed) — each with its measures (numbers to compute), group-by dimensions and filter-only lookup fields. Call once, then use pulse_query_data.',
      input: {},
      run: (u) => ({ sources: core.listDataSources(u) }),
    },
    {
      name: 'pulse_query_data',
      title: 'Query event data',
      description: 'LIVE query (~1-3s, cached after). THE MOST POWERFUL READ: compute any curated measure grouped by any curated dimensions with filters and a date range, straight from the client\'s data — use this when no dashboard tile matches the question (e.g. "revenue by ticket type last 30 days"). Field names must come from pulse_list_data_sources. Aggregate results only; personal fields are filter-only lookups, never listable.',
      input: {
        source: z.string().optional().describe('Data source key from pulse_list_data_sources (default: primary, the ticketing data)'),
        measure: z.string().describe('The number to compute — a measure name from the source'),
        measures: z.array(z.string()).optional().describe('Optional: 2+ measures side by side'),
        dimensions: z.array(z.string()).optional().describe('Optional group-by fields (dimension names from the source)'),
        filters: z.record(z.string(), z.string()).optional().describe('Optional {field: value} filters, e.g. {"core_tickets.ticket_type": "VIP"}'),
        dateRange: z.string().optional().describe('Optional Looker date expression, e.g. "last 30 days", "this month", "2026-01-01 to 2026-02-01"'),
        suiteId: z.string().optional().describe('Optional event (suite) id to narrow to one event'),
        limit: z.number().optional().describe('Max rows (default 500)'),
      },
      run: (u, a) => core.queryData(u, a),
    },
    // Writes (P3) — `write` scope only, DRAFTS only. Both delegate to the same
    // validated commit paths the in-app Owl uses; nothing on MCP can send.
    {
      name: 'pulse_create_segment',
      title: 'Create a segment (draft work)',
      scope: 'write',
      description: 'CREATE a saved audience segment from a cohort (e.g. {"ticket type": "VIP", "city": "Cape Town"} using dimension names from pulse_list_data_sources). It saves an audience DEFINITION — no message is sent, consent applies if it is ever messaged. Contact fields (email/phone/name) can never define a cohort. Pass suiteId to scope the cohort to ONE event — the scope is persisted and honoured on every later resolution (reach checks, campaigns), not just at creation. Confirm the cohort with the user in chat BEFORE calling. Returns the saved segment + its size/reach + the resolved event `scope`.',
      input: {
        name: z.string().optional().describe('Segment name (auto-generated from the cohort if omitted)'),
        filters: z.record(z.string(), z.string()).describe('{dimension: value} cohort filters — curated dimensions only'),
        suiteId: z.string().optional().describe('Optional event (suite) id to scope the cohort to one event'),
        folder: z.string().optional().describe('Optional folder label for organisation'),
      },
      run: (u, a) => core.createSegment(u, a),
    },
    {
      name: 'pulse_draft_campaign',
      title: 'Draft a campaign (needs your approval to send)',
      scope: 'write',
      description: 'DRAFT an email/SMS campaign — it lands as a DRAFT in Pulse for a human to review, approve and send; this tool CANNOT send anything. Audience = a saved segment (segmentName) OR a cohort (filters). Pulse\'s own AI writes/designs the content server-side from your goal. The response includes the resolved event `scope` (which event the audience resolves to, or entity-wide) — check it against what the user intended before telling them it is drafted. Confirm goal + audience with the user in chat BEFORE calling. Tell the user afterwards it is a draft awaiting their approval in Pulse.',
      input: {
        goal: z.string().describe('Who to reach and what to get them to do, e.g. "win back last year\'s VIP buyers who haven\'t rebooked"'),
        channel: z.enum(['email', 'sms', 'both']).optional().describe('Default email'),
        segmentName: z.string().optional().describe('Use a saved segment by name (see pulse_list_segments)'),
        filters: z.record(z.string(), z.string()).optional().describe('OR a cohort: {dimension: value} filters (curated dimensions only)'),
        name: z.string().optional().describe('Campaign name (defaults from the drafted subject)'),
        ctaUrl: z.string().optional().describe('Optional call-to-action link'),
        language: z.string().optional().describe('Optional 2-letter language override for the copy'),
        suiteId: z.string().optional().describe('Optional event (suite) id this campaign is for'),
      },
      run: (u, a) => core.draftCampaign(u, a),
    },
    // OpenAI/ChatGPT compatibility: connectors require `search` + `fetch`.
    // They return structuredContent (results / a document) per OpenAI's schema;
    // aggregate data only, so any read key has them. Generic names on purpose —
    // that's what ChatGPT looks for.
    {
      name: 'search',
      title: 'Search Pulse',
      openai: true,
      description: 'Instant. Find this client\'s Pulse items — dashboards, segments, campaigns, goals — by keyword; returns ids to pass to `fetch`. (ChatGPT/OpenAI deep-research compatible.) If you already know you need one KPI number, skip this and use pulse_get_metric.',
      input: { query: z.string().describe('Keywords, e.g. a dashboard, segment, campaign or goal name') },
      run: (u, a) => core.search(u, a.query),
    },
    {
      name: 'fetch',
      title: 'Fetch a Pulse item',
      openai: true,
      description: 'Fetch one Pulse item by an id from `search`. NOTE: fetching a DASHBOARD runs several live queries (slower) to include its tile numbers — for a single number prefer pulse_get_metric. Segments, campaigns and goals are instant.',
      input: { id: z.string().describe('An id returned by search, e.g. "segment:…" or "dashboard:…"') },
      run: (u, a) => core.fetchDoc(u, a.id),
    },
    {
      name: 'pulse_get_goals',
      title: 'Check goals',
      description: 'Instant for targets/deadlines. The goals set for one event (suite). Set withProgress ONLY when the user asks about pace/progress — it runs one live query per goal (slower).',
      input: {
        suiteId: z.string().describe('Event (suite) id from pulse_get_me'),
        withProgress: z.boolean().optional().describe('Also resolve live progress per goal — one data read each; leave off unless progress is asked for'),
      },
      run: (u, a) => core.listGoals(u, { suiteId: a.suiteId, progress: !!a.withProgress }),
    },
  ];

  // Fresh McpServer per request (stateless): tools close over THIS request's
  // principal, so nothing user-scoped outlives the response.
  // Top-level guidance the client shows the model at connect time — the Owl
  // persona (same voice as the in-app Owl, see insights.js/owlChat.js) plus the
  // steering that picks the correct AND fast path before any tool is chosen.
  const INSTRUCTIONS = [
    'You are the Owl 🦉 — Howler Pulse\'s data analyst — answering an event organiser\'s questions about THEIR OWN live event data through these tools. Speak as the Owl, not as "the Pulse API": first person, warm and direct, numbers-first, no fluff. Ground every figure in tool results — never invent or estimate data; if a number isn\'t reachable, say so plainly. You are read-only: you can look anything up, but you never change, send or delete anything.',
    'Pulse gives read-only access to ONE Howler client\'s live event data (dashboards, metrics, segments, campaigns, goals).',
    'Efficient workflow:',
    '1. Call pulse_get_me ONCE at the start to get the client + its events (suite ids). Reuse those ids; do not call it again.',
    '2. For a single KPI number, go straight to pulse_get_metric (find the dashboardId/tileId via pulse_list_dashboards → pulse_get_dashboard). Do NOT fetch a whole dashboard just to read one number.',
    '3. List tools (pulse_list_dashboards, pulse_list_segments, pulse_list_campaigns) are instant and already carry headline numbers — prefer them and avoid redundant per-item calls.',
    '4. For analytical questions no tile answers (breakdowns, custom filters, date ranges — e.g. "revenue by ticket type last month"), use pulse_query_data with fields from pulse_list_data_sources. One query beats stitching several tile reads.',
    '5. Only these do a slower live query: pulse_get_metric, pulse_query_data, pulse_get_segment_reach, pulse_get_tile_rows, pulse_get_goals with withProgress, and fetch of a dashboard. Use them deliberately.',
    '6. Make independent lookups in parallel. Answer from the data you have rather than re-fetching.',
  ].join('\n');

  // Per-connection instructions: the shared guidance + THIS client's stored AI
  // context (the same grounding the in-app Owl gets — business background,
  // terminology, currency/language), + write guidance only when the key can write.
  function instructionsFor(req) {
    const parts = [INSTRUCTIONS];
    try {
      const note = clientContextFor ? clientContextFor(req.apiKey.entityId) : '';
      if (note) parts.push(`Client context (from Pulse — treat as background truth):\n${note}`);
    } catch { /* context is enrichment, never a blocker */ }
    if (apiKeys.hasScope(req, 'write')) {
      parts.push('You also have DRAFT-creation tools (segments, campaigns). Anything you create is a DRAFT a human must review, approve and send in Pulse — you cannot send. ALWAYS confirm the cohort/goal with the user in chat before calling a write tool, and afterwards tell them it awaits their approval in Pulse.');
    }
    return parts.join('\n\n');
  }

  function buildServer(req) {
    // `name` stays the stable machine id; `title` is what connector UIs display.
    const server = new McpServer({ name: 'pulse', title: 'The Owl — Howler Pulse', version: '1.0.0' }, { instructions: instructionsFor(req) });
    const base = `${req.protocol}://${req.get('host')}`;
    // OpenAI's search/fetch want a `url` on every result/document (ChatGPT only
    // builds a citation when url is a non-empty string). We don't have per-item
    // deep links, so cite the Pulse app itself — a valid, resolving URL.
    const withUrls = (name, out) => (name === 'search'
      ? { results: (out.results || []).map((r) => ({ ...r, url: base })) }
      : { ...out, url: out.url || base });
    for (const t of TOOLS) {
      // Scope-gated tools are invisible to keys that lack the scope — an agent
      // is never offered a tool it can't use.
      if (t.scope && !apiKeys.hasScope(req, t.scope)) continue;
      // Honest hints so clients can relax confirmation prompts on the harmless
      // reads and keep them for writes: read tools are read-only; the draft
      // tools write (but are non-destructive — they only ever ADD drafts).
      const isWrite = t.scope === 'write';
      const annotations = { readOnlyHint: !isWrite, openWorldHint: true, destructiveHint: false, idempotentHint: false };
      server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.input, annotations }, async (args) => {
        try {
          const out = await t.run(req.user, args || {}, req.apiKey);
          apiKeys.audit(req, 'mcp', `tool:${t.name}`, 200);
          if (t.openai) {
            // Return structuredContent AND a JSON-encoded string copy in content
            // (OpenAI's compatibility contract).
            const structured = withUrls(t.name, out);
            return { structuredContent: structured, content: [{ type: 'text', text: JSON.stringify(structured) }] };
          }
          return { content: [{ type: 'text', text: JSON.stringify(out) }] };
        } catch (e) {
          const status = Number.isInteger(e?.status) ? e.status : 500;
          apiKeys.audit(req, 'mcp', `tool:${t.name}`, status);
          // HttpErrors are client-safe by design; anything else stays generic
          // (same policy as errorMiddleware — never leak raw error text).
          const msg = e?.expose === true ? e.message : 'Something went wrong on our end.';
          if (status >= 500) console.error(`[mcp] ${t.name} →`, e?.stack || e);
          return { content: [{ type: 'text', text: JSON.stringify({ error: msg }) }], isError: true };
        }
      });
    }
    return server;
  }

  app.post('/mcp',
    apiKeys.bearerAuth, apiKeys.requireScope('read'),
    rateLimit({ windowMs: 60_000, max: 60, by: (req) => `key:${req.apiKey?.id}`, scope: 'mcp' }),
    asyncHandler(async (req, res) => {
      const server = buildServer(req);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    }));
  // Stateless mode: no server-initiated stream, no session to delete.
  const noSession = (_req, res) => res.status(405).json({
    jsonrpc: '2.0', error: { code: -32000, message: 'Pulse MCP is stateless — use POST /mcp.' }, id: null,
  });
  app.get('/mcp', noSession);
  app.delete('/mcp', noSession);

  console.log('[mcp] remote MCP server mounted at /mcp');
}

module.exports = { mount };
