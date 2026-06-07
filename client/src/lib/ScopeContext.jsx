import { createContext, useContext } from 'react';

// Carries the current Dashboard Set context (setId) so tile queries, drills and
// filter suggestions are scoped to that set's locked filters server-side.
// null = no set (admin previewing a dashboard directly → unscoped).
const ScopeContext = createContext({ setId: null });

export function ScopeProvider({ setId, children }) {
  return <ScopeContext.Provider value={{ setId: setId || null }}>{children}</ScopeContext.Provider>;
}

export function useScope() {
  return useContext(ScopeContext);
}
