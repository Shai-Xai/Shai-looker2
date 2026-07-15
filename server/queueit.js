// ─── Queue-it — live waiting-room stats — DISPOSABLE MODULE ────────────────────
// Pulls a client's Queue-it (queue-it.com) waiting-room statistics into Pulse:
// the rooms themselves, a live per-minute summary (waiting now, redirected,
// throughput) and time-series details for charts. READ-ONLY — Pulse never
// changes a queue's state.
//
// Credentials layer like every other integration (platform default → client
// override): per-client `queueitCustomerId` + `queueitApiKey` live in the entity
// integrations blob (the key auto-seals via secretbox.isSecretName); blank
// client fields fall back to the platform settings `queueit_customer_id` /
// `queueit_api_key` (Admin → Integrations). The Queue-it Management API v2 is
// customer-scoped: https://{customerId}.api2.queue-it.net with an `api-key`
// header (docs: https://api2.queue-it.net/swagger/index.html).
//
// Room scoping: when a client rides on the PLATFORM account, they see only the
// waiting rooms an admin explicitly assigned to them (`queueitWaitingRoomIds`)
// — never the whole Howler account. A client with their OWN key sees all their
// rooms unless the list narrows it.
//
// Mount: require('./queueit').mount(app, { db, auth, fetchImpl })
// Uninstall: remove the mount line + this file + QueueItCard.jsx + the queueit
// blocks in integrationsConfig.js / IntegrationsForm.jsx.

const { HttpError, asyncHandler } = require('./http');

// Statistic types the details endpoint accepts (Queue-it swagger enum). The
// UI offers the headline ones; the rest stay callable for power users.
const STAT_TYPES = [
  'queuebeforeeventinflow', 'queueinflow', 'queueuniqueinflow', 'queueoutflow',
  'queueuniqueoutflow', 'safetynetoutflow', 'maxoutflow', 'queueidsinqueue',
  'redirectedpercentage', 'queueidscanceled', 'notificationfirst',
  'notificationyourturn', 'queueexpectedwaittime', 'queueactualwaittime',
  'returningqueueitemsinlessthan30s', 'oldqueuenumbers', 'exceededmaxredirectcount',
  'captchashown', 'captchasolved', 'captcharejected', 'proofofworkshown',
  'proofofworksolved', 'proofofworkrejected', 'abuserequesthardblocked',
  'abuserequestsoftblocked', 'abuserequestsoftblockchallengesolved',
];

// ── integrations slice (integrationsConfig delegates here, like pixel/slack) ──
function applyPatch(body, set) {
  const q = body.queueit || {};
  if (q.customerId !== undefined) set('queueitCustomerId', String(q.customerId || '').trim().toLowerCase());
  if (q.apiKey) set('queueitApiKey', String(q.apiKey).trim());
  if (q.clearApiKey) set('queueitApiKey', '');
  if (q.waitingRoomIds !== undefined) set('queueitWaitingRoomIds', roomIdList(q.waitingRoomIds).join(','));
}
function view(i, maskSecret) {
  return {
    customerId: i.queueitCustomerId || '',
    keySet: !!i.queueitApiKey,
    keyHint: maskSecret ? maskSecret(i.queueitApiKey) : '',
    waitingRoomIds: roomIdList(i.queueitWaitingRoomIds),
  };
}

// Accepts an array or a comma/space-separated string; returns clean unique ids.
function roomIdList(v) {
  const arr = Array.isArray(v) ? v : String(v || '').split(/[\s,]+/);
  return [...new Set(arr.map((s) => String(s || '').trim()).filter(Boolean))];
}

// Customer id becomes a subdomain — keep it strictly hostname-safe.
const validCustomerId = (c) => /^[a-z0-9][a-z0-9-]{0,62}$/i.test(String(c || ''));
const apiBase = (customerId) => `https://${String(customerId).toLowerCase()}.api2.queue-it.net/2_0`;

// Blank client fields inherit the platform tier (same layering as every setting).
function resolveCreds(db, entityId) {
  const i = db.getEntityIntegrations(entityId);
  if (i.queueitCustomerId && i.queueitApiKey) return { customerId: i.queueitCustomerId, apiKey: i.queueitApiKey, source: 'client' };
  const customerId = db.getSetting('queueit_customer_id', '');
  const apiKey = db.getSetting('queueit_api_key', '');
  if (customerId && apiKey) return { customerId, apiKey, source: 'platform' };
  return null;
}

// ── normalizers (pure — exported for tests) ──
const num = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

// DtoMinimalReadEvent → a compact room row.
function normalizeRoom(r) {
  return {
    id: r.EventId || '',
    name: r.DisplayName || r.EventId || '',
    status: r.QueueStatusText || r.QueueStatus || '',
    type: r.WaitingRoomType || '',
    isTest: String(r.IsTest || '').toLowerCase() === 'true',
    startsAt: r.EventStartTime || null,
    endsAt: r.EventEndTime || null,
    maxRedirectsPerMinute: num(r.MaxRedirectsPerMinute),
  };
}

// DtoReadStatisticsSummary (all values arrive as strings) → numbers the UI can tile.
function normalizeSummary(s) {
  return {
    asOf: s.VersionTimestamp || null,
    waitingNow: num(s.TotalWaitingInQueueCount),
    totalQueued: num(s.TotalQueueCount),
    queuedBeforeStart: num(s.TotalQueueCountBeforeStart),
    leftQueue: num(s.TotalLeftQueueCount),
    redirectsLastMinute: num(s.NoOfRedirectsLastMinute),
    uniqueRedirectsLastMinute: num(s.NoOfUniqueRedirectsLastMinute),
    totalRedirected: num(s.TotalRedirectedCount),
    emailNotifications: num(s.TotalEmailNotificationCount),
    exceededMaxRedirects: num(s.TotalExceededMaxRedirectCount),
  };
}

// DtoReadStatistics → timestamped points. Queue-it returns bare entries aligned
// to From at a fixed interval (per-minute under 7 days, per-hour beyond).
function seriesFromDetails(d) {
  const start = new Date(d.From || 0).getTime();
  const step = /hour/i.test(String(d.Interval || '')) ? 3600_000 : 60_000;
  const points = (d.Entries || []).map((e, idx) => ({
    t: new Date(start + idx * step).toISOString(),
    v: num(e && e.Sum),
  }));
  return { from: d.From || null, to: d.To || null, interval: /hour/i.test(String(d.Interval || '')) ? 'hour' : 'minute', sum: num(d.Sum), points };
}

// Which rooms may THIS surface show? Admin: everything on the resolved account.
// Client: their assigned list; with their own account an empty list means all —
// on the shared platform account an empty list means NONE (never leak other
// clients' rooms).
function visibleRooms(rooms, { scope, source, assignedIds }) {
  if (scope === 'admin') return rooms;
  const ids = roomIdList(assignedIds);
  if (ids.length) { const set = new Set(ids.map((x) => x.toLowerCase())); return rooms.filter((r) => set.has(String(r.id).toLowerCase())); }
  return source === 'client' ? rooms : [];
}

function mount(app, { db, auth, fetchImpl }) {
  const doFetch = fetchImpl || fetch;

  // Queue-it caches stats to the minute — a matching micro-cache keeps a page of
  // auto-refreshing tiles from hammering their API (and ours).
  const cache = new Map(); // url → { at, data }
  const CACHE_MS = 45_000;
  async function qFetch(creds, path) {
    if (!validCustomerId(creds.customerId)) throw new HttpError(400, 'Queue-it customer ID looks invalid — it is the short account name, e.g. "howler".');
    const url = `${apiBase(creds.customerId)}${path}`;
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
    let res;
    try {
      res = await doFetch(url, { headers: { 'api-key': creds.apiKey, Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new HttpError(502, 'Could not reach Queue-it — try again in a minute.');
    }
    if (res.status === 401 || res.status === 403) throw new HttpError(400, 'Queue-it rejected the API key — check the key and customer ID in Integrations.');
    if (res.status === 404) throw new HttpError(404, 'Queue-it has no such waiting room.');
    if (!res.ok) throw new HttpError(502, `Queue-it returned an error (HTTP ${res.status}).`);
    const data = await res.json().catch(() => { throw new HttpError(502, 'Queue-it sent an unreadable response.'); });
    if (cache.size > 500) cache.clear();
    cache.set(url, { at: Date.now(), data });
    return data;
  }

  const needCreds = (entityId) => {
    const creds = resolveCreds(db, entityId);
    if (!creds) throw new HttpError(400, 'Queue-it isn\'t connected yet — add the customer ID + API key in Integrations.');
    return creds;
  };

  async function roomsFor(entityId, scope) {
    const creds = needCreds(entityId);
    const raw = await qFetch(creds, '/event');
    const all = (Array.isArray(raw) ? raw : []).map(normalizeRoom).filter((r) => r.id);
    const assignedIds = db.getEntityIntegrations(entityId).queueitWaitingRoomIds || '';
    const rooms = visibleRooms(all, { scope, source: creds.source, assignedIds });
    return { creds, all, rooms, assignedIds: roomIdList(assignedIds) };
  }

  // A client may only read stats for a room their scope can see.
  async function guardRoom(entityId, scope, roomId) {
    const { creds, rooms } = await roomsFor(entityId, scope);
    if (scope !== 'admin' && !rooms.some((r) => String(r.id).toLowerCase() === String(roomId).toLowerCase())) {
      throw new HttpError(403, 'That waiting room isn\'t linked to this client.');
    }
    return creds;
  }

  const status = (entityId) => {
    const i = db.getEntityIntegrations(entityId);
    const creds = resolveCreds(db, entityId);
    return {
      configured: !!creds,
      source: creds ? creds.source : null, // 'client' | 'platform'
      customerId: creds ? creds.customerId : '',
      clientKeySet: !!i.queueitApiKey,
      waitingRoomIds: roomIdList(i.queueitWaitingRoomIds),
    };
  };

  const handlers = {
    status: (scope) => (req, res) => res.json({ ...status(req.params.entityId), scope }),
    rooms: (scope) => asyncHandler(async (req, res) => {
      const { rooms, assignedIds, creds } = await roomsFor(req.params.entityId, scope);
      res.json(scope === 'admin' ? { rooms, assignedIds, source: creds.source } : { rooms, source: creds.source });
    }),
    summary: (scope) => asyncHandler(async (req, res) => {
      const creds = await guardRoom(req.params.entityId, scope, req.params.roomId);
      const raw = await qFetch(creds, `/event/${encodeURIComponent(req.params.roomId)}/queue/statistics/summary`);
      res.json(normalizeSummary(raw || {}));
    }),
    details: (scope) => asyncHandler(async (req, res) => {
      const type = String(req.query.type || 'queueinflow').toLowerCase();
      if (!STAT_TYPES.includes(type)) throw new HttpError(400, 'Unknown statistic type.');
      const to = req.query.to ? new Date(String(req.query.to)) : new Date();
      const from = req.query.from ? new Date(String(req.query.from)) : new Date(to.getTime() - 24 * 3600_000);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) throw new HttpError(400, 'Invalid time range.');
      if (to.getTime() - from.getTime() > 366 * 86400_000) throw new HttpError(400, 'Range must be a year or less.');
      const creds = await guardRoom(req.params.entityId, scope, req.params.roomId);
      const raw = await qFetch(creds, `/event/${encodeURIComponent(req.params.roomId)}/queue/statistics/details/${type}?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`);
      res.json({ type, ...seriesFromDetails(raw || {}) });
    }),
    verify: (scope) => asyncHandler(async (req, res) => {
      const { rooms, all } = await roomsFor(req.params.entityId, scope);
      res.json({ ok: true, roomCount: scope === 'admin' ? all.length : rooms.length });
    }),
    // Which rooms the client sees. Admins always; a client only when on their
    // OWN account (on the shared platform account assignment is admin-only).
    setRooms: (scope) => asyncHandler(async (req, res) => {
      if (scope !== 'admin') {
        const creds = needCreds(req.params.entityId);
        if (creds.source !== 'client') throw new HttpError(403, 'Waiting-room assignment on the shared Queue-it account is managed by Howler.');
      }
      db.setEntityIntegrations(req.params.entityId, { queueitWaitingRoomIds: roomIdList((req.body || {}).roomIds).join(',') });
      res.json(status(req.params.entityId));
    }),
  };

  // ── the same surface twice: client self-service + admin (dual-surface rule) ──
  const myEntity = (req, res, next) => {
    const eid = req.params.entityId;
    if (req.user && (req.user.role === 'admin' || (req.user.entityIds || []).includes(eid))) return next();
    return res.status(403).json({ error: 'Not your client.' });
  };
  const manage = (req, res, next) => auth.requirePermission('integrations.manage')(req, res, next);

  app.get('/api/my/queueit/:entityId', auth.requireAuth, myEntity, handlers.status('my'));
  app.get('/api/my/queueit/:entityId/waiting-rooms', auth.requireAuth, myEntity, handlers.rooms('my'));
  app.get('/api/my/queueit/:entityId/waiting-rooms/:roomId/summary', auth.requireAuth, myEntity, handlers.summary('my'));
  app.get('/api/my/queueit/:entityId/waiting-rooms/:roomId/details', auth.requireAuth, myEntity, handlers.details('my'));
  app.post('/api/my/queueit/:entityId/verify', auth.requireAuth, myEntity, manage, handlers.verify('my'));
  app.put('/api/my/queueit/:entityId/rooms', auth.requireAuth, myEntity, manage, handlers.setRooms('my'));

  app.get('/api/admin/entities/:entityId/queueit', auth.requireAdmin, handlers.status('admin'));
  app.get('/api/admin/entities/:entityId/queueit/waiting-rooms', auth.requireAdmin, handlers.rooms('admin'));
  app.get('/api/admin/entities/:entityId/queueit/waiting-rooms/:roomId/summary', auth.requireAdmin, handlers.summary('admin'));
  app.get('/api/admin/entities/:entityId/queueit/waiting-rooms/:roomId/details', auth.requireAdmin, handlers.details('admin'));
  app.post('/api/admin/entities/:entityId/queueit/verify', auth.requireAdmin, handlers.verify('admin'));
  app.put('/api/admin/entities/:entityId/queueit/rooms', auth.requireAdmin, handlers.setRooms('admin'));

  console.log('[queueit] Queue-it stats mounted');
  return { status };
}

module.exports = { mount, applyPatch, view, roomIdList, validCustomerId, apiBase, resolveCreds, normalizeRoom, normalizeSummary, seriesFromDetails, visibleRooms, STAT_TYPES };
