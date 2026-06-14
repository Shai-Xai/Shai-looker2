import { createContext, useContext } from 'react';

// Carries the current Suite context (suiteId) so tile queries, drills and
// filter suggestions are scoped (organiser) and pre-filled to that suite.
// null = no suite (admin previewing a dashboard directly → unscoped).
// entityId/dashboardId let a tile act on itself (e.g. create a segment).
const ScopeContext = createContext({ suiteId: null, dashboardContext: '', entityId: null, dashboardId: null });

export function ScopeProvider({ suiteId, dashboardContext = '', entityId = null, dashboardId = null, children }) {
  return <ScopeContext.Provider value={{ suiteId: suiteId || null, dashboardContext: dashboardContext || '', entityId: entityId || null, dashboardId: dashboardId || null }}>{children}</ScopeContext.Provider>;
}

export function useScope() {
  return useContext(ScopeContext);
}
