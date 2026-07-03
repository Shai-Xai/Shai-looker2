// ─── Reporting timezone routes (disposable module) ───────────────────────────
// Dual-surface management of a client's REPORTING TIMEZONE — the IANA zone Looker
// evaluates relative date filters ("today"/"this week") and date grouping in, so a
// client's day boundary matches their local calendar rather than Looker's server
// default. This is what makes the Owl's cashless `dateRange="today"` return today's
// real rows instead of zero (see server/timezone.js for the why).
//
// Layered: blank client override → inherit the platform default. Both surfaces
// required by the dual-surface rule:
//   • Admin:  /api/admin/entities/:id/reporting-timezone   (Howler staff)
//   • Client: /api/my/reporting-timezone/:entityId          (self-service)
//
// Mounts in one line from index.js: require('./reportingTz').mount(app, { db, auth }).

const tz = require('./timezone');

// A short, curated picker list (label + IANA id). Any valid IANA zone is accepted
// by the API; this just drives a friendly dropdown on both surfaces.
const COMMON_ZONES = [
  { id: 'Africa/Johannesburg', label: 'Johannesburg (GMT+2)' },
  { id: 'Europe/London',       label: 'London (GMT+0/+1)' },
  { id: 'Europe/Paris',        label: 'Central Europe — Paris/Rome/Berlin (GMT+1/+2)' },
  { id: 'Europe/Athens',       label: 'Athens / Eastern Europe (GMT+2/+3)' },
  { id: 'Europe/Lisbon',       label: 'Lisbon (GMT+0/+1)' },
  { id: 'Africa/Lagos',        label: 'Lagos / West Africa (GMT+1)' },
  { id: 'Africa/Nairobi',      label: 'Nairobi / East Africa (GMT+3)' },
  { id: 'Asia/Dubai',          label: 'Dubai (GMT+4)' },
  { id: 'America/New_York',    label: 'New York / US Eastern (GMT-5/-4)' },
  { id: 'America/Los_Angeles', label: 'Los Angeles / US Pacific (GMT-8/-7)' },
  { id: 'UTC',                 label: 'UTC' },
];

function mount(app, { db, auth }) {
  // The view shared by both surfaces: the raw override, what it resolves to (after
  // the platform-default fallback), the platform default, and the picker list.
  const view = (entityId) => {
    const e = db.getEntity(entityId);
    return {
      entityId,
      name: e ? e.name : '',
      reportingTimezone: e ? (e.reportingTimezone || '') : '', // '' = inherit
      resolved: tz.reportingTimezoneFor(db, { entityId }),
      platformDefault: tz.PLATFORM_TIMEZONE,
      zones: COMMON_ZONES,
    };
  };
  // Accept a blank string (→ inherit) or any valid IANA zone; reject anything else
  // so a typo can't silently disable date filtering. Returns { ok, value } | { error }.
  const cleanTz = (body) => {
    const raw = (body && (body.timezone ?? body.reportingTimezone)) || '';
    const val = String(raw).trim();
    if (val === '') return { ok: true, value: '' };
    if (!tz.isValidTimezone(val)) return { error: `"${val}" is not a valid IANA timezone (e.g. "Europe/Paris").` };
    return { ok: true, value: val };
  };

  // ── Admin surface (Howler staff manage on the client's behalf) ──
  app.get('/api/admin/entities/:id/reporting-timezone', auth.requireAdmin, (req, res) => {
    if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Entity not found' });
    res.json(view(req.params.id));
  });
  app.put('/api/admin/entities/:id/reporting-timezone', auth.requireAdmin, (req, res) => {
    if (!db.getEntity(req.params.id)) return res.status(404).json({ error: 'Entity not found' });
    const c = cleanTz(req.body);
    if (c.error) return res.status(400).json({ error: c.error });
    db.updateEntity(req.params.id, { reportingTimezone: c.value });
    res.json(view(req.params.id));
  });

  // ── Client self-service (scoped to the caller's own entity) ──
  const ownsEntity = (req) => (req.user.role === 'admin') || (req.user.entityIds || []).includes(req.params.entityId);
  app.get('/api/my/reporting-timezone/:entityId', auth.requireAuth, (req, res) => {
    if (!ownsEntity(req)) return res.status(403).json({ error: 'Not allowed' });
    if (!db.getEntity(req.params.entityId)) return res.status(404).json({ error: 'Entity not found' });
    res.json(view(req.params.entityId));
  });
  app.put('/api/my/reporting-timezone/:entityId', auth.requireAuth, auth.requirePermission('integrations.manage'), (req, res) => {
    if (!ownsEntity(req)) return res.status(403).json({ error: 'Not allowed' });
    if (!db.getEntity(req.params.entityId)) return res.status(404).json({ error: 'Entity not found' });
    const c = cleanTz(req.body);
    if (c.error) return res.status(400).json({ error: c.error });
    db.updateEntity(req.params.entityId, { reportingTimezone: c.value });
    res.json(view(req.params.entityId));
  });

  return { COMMON_ZONES };
}

module.exports = { mount, COMMON_ZONES };
