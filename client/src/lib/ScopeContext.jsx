import { createContext, useContext } from 'react';

// Carries the current Suite context (suiteId) so tile queries, drills and
// filter suggestions are scoped (organiser) and pre-filled to that suite.
// null = no suite (admin previewing a dashboard directly → unscoped).
// entityId/dashboardId let a tile act on itself (e.g. create a segment).
//
// It also carries per-tile lock data: `tileLocks` ({ tileId: { filterName:
// value } }) is applied to a tile's query; `lockFilters` is the dashboard's
// filters (so an admin can pick which to lock on a tile); `canLockTiles` gates
// the admin affordance; `onSaveTileLock(tileId, map)` persists a tile's locks.
const ScopeContext = createContext({ suiteId: null, dashboardContext: '', entityId: null, dashboardId: null, refreshKey: 0, softKey: 0, tileLocks: {}, lockFilters: [], canLockTiles: false, onSaveTileLock: null });

export function ScopeProvider({ suiteId, dashboardContext = '', entityId = null, dashboardId = null, refreshKey = 0, softKey = 0, tileLocks = {}, lockFilters = [], canLockTiles = false, onSaveTileLock = null, children }) {
  return (
    <ScopeContext.Provider value={{ suiteId: suiteId || null, dashboardContext: dashboardContext || '', entityId: entityId || null, dashboardId: dashboardId || null, refreshKey, softKey, tileLocks: tileLocks || {}, lockFilters: lockFilters || [], canLockTiles: !!canLockTiles, onSaveTileLock }}>
      {children}
    </ScopeContext.Provider>
  );
}

export function useScope() {
  return useContext(ScopeContext);
}
