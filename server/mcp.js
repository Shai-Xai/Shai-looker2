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
// these to decide), not a 1:1 schema dump. v1 tools are all READ; write tools
// land in P3 behind the approval workflow.
//
// Mount: `require('./mcp').mount(app, { apiKeys, core, rateLimit })`.

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { z } = require('zod');
const { asyncHandler } = require('./http');

function mount(app, { apiKeys, core, rateLimit }) {
  // One tool table so the list stays curated and auditable. Every handler gets
  // the request's synthetic principal — scope enforcement happens in `core`.
  const TOOLS = [
    {
      name: 'pulse_get_me',
      description: 'Who am I? The client (entity) this API key belongs to, the key\'s scopes, and the client\'s events (suites). Call this first — suite ids are needed for metrics and goals.',
      input: {},
      run: (u, _a, key) => core.me(u, key),
    },
    {
      name: 'pulse_list_dashboards',
      description: 'List the dashboards this client can see, one entry per (dashboard, event) pairing with its suiteId — the event context a metric read needs.',
      input: {},
      run: (u) => ({ dashboards: core.listDashboards(u) }),
    },
    {
      name: 'pulse_get_dashboard',
      description: 'One dashboard\'s tiles (id, title, type) and filters, plus which events (suites) it appears in. Use tile ids with pulse_get_metric.',
      input: { dashboardId: z.string().describe('Dashboard id from pulse_list_dashboards') },
      run: (u, a) => core.getDashboard(u, a.dashboardId),
    },
    {
      name: 'pulse_get_metric',
      description: 'The live number a dashboard tile currently shows (KPI tiles), read through the same scope-enforced query path as the dashboard itself. Pass suiteId to pick which event\'s locks apply (defaults to the dashboard\'s first event).',
      input: {
        dashboardId: z.string(),
        tileId: z.string().describe('Tile id from pulse_get_dashboard'),
        suiteId: z.string().optional().describe('Event (suite) id from pulse_list_dashboards / pulse_get_me'),
      },
      run: (u, a) => core.metric(u, a),
    },
    {
      name: 'pulse_list_segments',
      description: 'The client\'s saved audience segments with their cached size and per-channel contactable reach (email / sms). Reach here is the last-resolved cache; use pulse_get_segment_reach for a live figure.',
      input: {},
      run: (u) => ({ segments: core.listSegments(u) }),
    },
    {
      name: 'pulse_get_segment_reach',
      description: 'Re-resolve one segment LIVE and return its current size and consent-aware per-channel reach. Slower than the list (runs the real audience query).',
      input: { segmentId: z.string().describe('Segment id from pulse_list_segments') },
      run: (u, a) => core.segmentReach(u, a.segmentId),
    },
    {
      name: 'pulse_list_campaigns',
      description: 'The client\'s campaigns (email/SMS) with status and results counters (sent, clicks, opens, CTR). Optionally filter by status: draft | pending | running | done | failed.',
      input: { status: z.string().optional().describe('Filter: draft | pending | running | done | failed') },
      run: (u, a) => ({ campaigns: core.listCampaigns(u, { status: a.status }) }),
    },
    {
      name: 'pulse_get_campaign_report',
      description: 'One campaign\'s delivery + engagement report: sent, failed, clicks, opens, CTR, per-channel sends, conversion counter.',
      input: { campaignId: z.string().describe('Campaign id from pulse_list_campaigns') },
      run: (u, a) => core.getCampaign(u, a.campaignId),
    },
    {
      name: 'pulse_get_tile_rows',
      scope: 'read_rows', // only registered for keys that explicitly carry it
      description: 'ROW-LEVEL data: the table behind a dashboard tile — every column (including ones the tile hides for display) and up to `limit` rows, e.g. customer/ticketing records. Requires a key with the read_rows scope; rows may contain personal data, handle accordingly.',
      input: {
        dashboardId: z.string(),
        tileId: z.string().describe('Tile id from pulse_get_dashboard'),
        suiteId: z.string().optional().describe('Event (suite) id — which event\'s locks apply (defaults to the dashboard\'s first event)'),
        limit: z.number().optional().describe('Max rows (default 500, cap 10000)'),
      },
      run: (u, a) => core.tileRows(u, a),
    },
    {
      name: 'pulse_get_goals',
      description: 'The goals set for one event (suite): targets, direction, deadline — and, when withProgress is true, live progress resolved through the same scoped readers the app uses (slower).',
      input: {
        suiteId: z.string().describe('Event (suite) id from pulse_get_me'),
        withProgress: z.boolean().optional().describe('Also resolve live progress per goal (one data read each)'),
      },
      run: (u, a) => core.listGoals(u, { suiteId: a.suiteId, progress: !!a.withProgress }),
    },
  ];

  // Fresh McpServer per request (stateless): tools close over THIS request's
  // principal, so nothing user-scoped outlives the response.
  function buildServer(req) {
    const server = new McpServer({ name: 'pulse', version: '1.0.0' });
    for (const t of TOOLS) {
      // Scope-gated tools are invisible to keys that lack the scope — an agent
      // is never offered a tool it can't use.
      if (t.scope && !apiKeys.hasScope(req, t.scope)) continue;
      server.registerTool(t.name, { description: t.description, inputSchema: t.input }, async (args) => {
        try {
          const out = await t.run(req.user, args || {}, req.apiKey);
          apiKeys.audit(req, 'mcp', `tool:${t.name}`, 200);
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
