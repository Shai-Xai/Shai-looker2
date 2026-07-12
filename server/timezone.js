// ─── Reporting timezone ───────────────────────────────────────────────────────
// SHARED LIBRARY (not a routes module). Resolves the IANA timezone that Looker
// should evaluate a client's queries in — so relative date filters ("today",
// "yesterday", "this week") and date grouping land on the client's LOCAL calendar
// day, not Looker's server default (typically UTC).
//
// This fixes the class of bug where cashless/askData `dateRange="today"` returned
// zero rows even though today's sales existed: the fresh Looker query bodies the
// Owl builds carried no query_timezone, so "today" was computed in the wrong zone
// and today's local rows fell outside the window. (Dashboard TILES were unaffected
// — they carry their own saved query_timezone from the Looker definition.)
//
// Layered like the rest of Pulse: platform default → per-entity override. A blank
// entity override inherits the platform default.

// Platform default. Howler is GMT+2 (Africa/Johannesburg), which is also where our
// European summer clients currently sit (CEST = GMT+2), so it's a safe default and
// env-overridable for other deployments.
const PLATFORM_TIMEZONE = process.env.REPORTING_TIMEZONE || 'Africa/Johannesburg';

// Is `tz` a real IANA zone the runtime accepts? (Intl throws on an unknown zone.)
function isValidTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// The entity's configured reporting timezone, or '' when unset/invalid (→ inherit
// the platform default). Tolerant of a missing db (falls back to the default).
function entityTimezone(db, entityId) {
  if (!entityId || !db || !db.getEntity) return '';
  let e; try { e = db.getEntity(entityId); } catch { return ''; }
  const tz = e && e.reportingTimezone;
  return isValidTimezone(tz) ? tz : '';
}

// The reporting timezone for a query CONTEXT ({ entityId, suiteId, user }). Prefers
// an explicit entity, then the suite's entity, then a single-entity user's client;
// falls back to the platform default. Never throws — a query must always get a zone.
function reportingTimezoneFor(db, ctx = {}) {
  const { entityId, suiteId, user } = ctx || {};
  let tz = entityTimezone(db, entityId);
  if (!tz && suiteId && db && db.getSuite) {
    let su; try { su = db.getSuite(suiteId); } catch { su = null; }
    if (su && su.entityId) tz = entityTimezone(db, su.entityId);
  }
  if (!tz && user && Array.isArray(user.entityIds) && user.entityIds.length === 1) {
    tz = entityTimezone(db, user.entityIds[0]);
  }
  return tz || PLATFORM_TIMEZONE;
}

module.exports = { PLATFORM_TIMEZONE, isValidTimezone, entityTimezone, reportingTimezoneFor };
