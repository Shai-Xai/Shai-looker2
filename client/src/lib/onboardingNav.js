import { api } from './api.js';

// Resolve the path to a client's first real dashboard (their first suite → first
// set → first dashboard). Onboarding "explore your dashboards" CTAs use this so
// "Go" opens an actual dashboard instead of bouncing to the home page. Returns
// null if the client has no dashboards yet (caller should fall back to home).
export async function firstDashboardPath(entityId) {
  try {
    const suites = await api.mySuites();
    const mine = entityId ? suites.filter((s) => s.entityId === entityId) : suites;
    const su = mine[0] || suites[0];
    if (!su) return null;
    const d = await api.mySuite(su.id);
    const first = (d.sets || []).flatMap((s) => s.dashboards || [])[0];
    return first ? `/suite/${su.id}/d/${first.id}` : null;
  } catch { return null; }
}
