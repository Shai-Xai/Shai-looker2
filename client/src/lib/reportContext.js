// A tiny registry so an in-context screen (a dashboard) can publish the tiles a
// bug report could be about, and the app-wide ReportForm can offer a "which
// tile?" picker without the two components knowing about each other. Kept
// framework-free (module state + a DOM event) and deliberately transient: the
// dashboard view clears it on unmount, so the tile picker only appears where
// tiles were actually published (i.e. on a dashboard, not on every screen).
let tiles = [];
export const REPORT_TILES_EVENT = 'pulse:report-tiles';

// Publish the current screen's tiles as [{ id, title }]. Pass [] to clear.
export function setReportTiles(next) {
  tiles = Array.isArray(next) ? next.filter((t) => t && t.id) : [];
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(REPORT_TILES_EVENT));
}

export function getReportTiles() { return tiles; }
