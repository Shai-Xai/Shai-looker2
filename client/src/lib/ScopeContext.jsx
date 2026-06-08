import { createContext, useContext } from 'react';

// Carries the current Suite context (suiteId) so tile queries, drills and
// filter suggestions are scoped (organiser) and pre-filled to that suite.
// null = no suite (admin previewing a dashboard directly → unscoped).
const ScopeContext = createContext({ suiteId: null, dashboardContext: '' });

export function ScopeProvider({ suiteId, dashboardContext = '', children }) {
  return <ScopeContext.Provider value={{ suiteId: suiteId || null, dashboardContext: dashboardContext || '' }}>{children}</ScopeContext.Provider>;
}

export function useScope() {
  return useContext(ScopeContext);
}
