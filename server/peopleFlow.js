// ─── People flow: crowd movement between touchpoints, from wristband taps ─────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns the /api/*/people-flow routes. No table
// of its own — it reads the cashless explore through the SAME scoped queryData the
// Owl/API use, so the client's event scope + access gates apply unchanged.
//
// WHAT IT DOES: pulls a sample of wristband taps (customer_gtag_id × station × 10-min
// bucket) for one event, stitches each wristband's taps into a time-ordered journey,
// and counts station→station TRANSITIONS across everyone. The result is an aggregate
// origin→destination matrix (edges) + per-station visit counts (nodes) the venue map
// draws as flow lines. It is a PROXY for movement — it only sees people where they
// tap — and it is AGGREGATE ONLY: no individual's path is ever returned.
// Operator/vendor tags (single-station, never move) are filtered out.
//
// TO REMOVE: delete this file + its one-line mount; drop the People-flow map mode.

const SRC = 'combined::cashless_combine_data';
const F = {
  gtag: 'cashless_open_loop_sales.customer_gtag_id',
  station: 'cashless_open_loop_sales.station_name',
  bucket: 'cashless_open_loop_sales.date_minute10', // sortable 'YYYY-MM-DD HH:MM'
  count: 'cashless_open_loop_sales.transaction_count',
};
const SAMPLE_ROWS = 5000; // the queryData row ceiling — a truncated-but-representative sample
const MAX_EDGES = 80;
const CACHE_TTL = 3 * 60 * 1000;

const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// Build the aggregate flow graph from raw (gtag, station, bucket) tap rows.
function buildFlow(rows) {
  const byTag = new Map(); // gtag -> [{ st, b }]
  for (const r of rows || []) {
    const g = clean(r[F.gtag]); const st = clean(r[F.station]); const b = clean(r[F.bucket]);
    if (!g || !st || !b) continue;
    (byTag.get(g) || byTag.set(g, []).get(g)).push({ st, b });
  }
  const edges = new Map(); // "from→to" -> count
  const visits = new Map(); // station -> journeys touching it
  const entries = new Map(); // first station of a journey -> count
  let journeys = 0; let movers = 0; let taps = 0;
  for (const seq of byTag.values()) {
    taps += seq.length;
    seq.sort((a, b) => (a.b < b.b ? -1 : a.b > b.b ? 1 : 0));
    // Collapse consecutive taps at the SAME station into one stop.
    const stops = [];
    for (const s of seq) if (!stops.length || stops[stops.length - 1] !== s.st) stops.push(s.st);
    const distinct = new Set(stops);
    if (distinct.size < 2) continue; // single-station tag = operator/vendor/idle wristband → skip
    movers++; journeys++;
    entries.set(stops[0], (entries.get(stops[0]) || 0) + 1);
    for (const st of distinct) visits.set(st, (visits.get(st) || 0) + 1);
    for (let i = 0; i < stops.length - 1; i++) {
      const k = `${stops[i]}|~|${stops[i + 1]}`;
      edges.set(k, (edges.get(k) || 0) + 1);
    }
  }
  const edgeList = [...edges.entries()].map(([k, count]) => { const [from, to] = k.split('|~|'); return { from, to, count }; })
    .sort((a, b) => b.count - a.count).slice(0, MAX_EDGES);
  const nodes = [...visits.entries()].map(([station, v]) => ({ station, visits: v, entries: entries.get(station) || 0 }))
    .sort((a, b) => b.visits - a.visits);
  return {
    nodes, edges: edgeList,
    entries: [...entries.entries()].map(([station, count]) => ({ station, count })).sort((a, b) => b.count - a.count).slice(0, 12),
    journeys: movers, tapsSampled: taps, tagsSampled: byTag.size,
  };
}

function mount(app, { db, auth, queryData }) {
  const cache = new Map(); // suiteId -> { at, data }

  async function flowFor(user, suiteId) {
    const hit = cache.get(suiteId);
    if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data;
    const res = await queryData(user, {
      source: SRC, suiteId,
      measure: F.count, dimensions: [F.gtag, F.station, F.bucket], limit: SAMPLE_ROWS,
    });
    const rows = (res && res.rows) || [];
    const flow = buildFlow(rows);
    const data = {
      ...flow,
      sampled: rows.length,
      truncated: rows.length >= SAMPLE_ROWS, // a bigger crowd than the sample window — flows are a sample
      note: 'A sample of wristband journeys between touchpoints (where people tapped). Aggregate only; a proxy for movement, not GPS.',
      asOf: new Date().toISOString(),
    };
    cache.set(suiteId, { at: Date.now(), data });
    return data;
  }

  const send = (req, res) => {
    flowFor(req.user, req.params.suiteId)
      .then((d) => res.json(d))
      .catch((e) => res.status(e.status || 502).json({ error: e.status ? e.message : 'Could not read the crowd flow right now' }));
  };

  app.get('/api/admin/people-flow/:suiteId', auth.requireAdmin, send);

  const requireAuth = auth.requireAuth || auth.requireAdmin;
  const ownsSuite = (req) => { const su = db.getSuite(req.params.suiteId); if (!su) return false; return (req.user && req.user.role === 'admin') || ((req.user && req.user.entityIds) || []).includes(su.entityId); };
  app.get('/api/my/people-flow/:suiteId', requireAuth, (req, res) => { if (!ownsSuite(req)) return res.status(403).json({ error: 'Not your event' }); send(req, res); });

  return { flowFor, buildFlow };
}

module.exports = { mount, buildFlow };
