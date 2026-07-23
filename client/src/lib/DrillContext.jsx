import { createContext, useContext, useState, useCallback } from 'react';
import DrillModal from '../components/DrillModal.jsx';

const DrillCtx = createContext(null);

// useDrill().openDrill(links, title) opens the drill panel for a clicked value.
// `links` is the cell's Looker links array; only /explore/ drill links are used.
export function useDrill() {
  return useContext(DrillCtx) || { openDrill: () => {}, canDrill: () => false };
}

export function DrillProvider({ children }) {
  const [state, setState] = useState(null);

  const openDrill = useCallback((links, title) => {
    const drillable = (links || []).filter((l) => l && l.url && /\/explore\//.test(l.url));
    if (!drillable.length) return;
    setState({ links: drillable, title });
  }, []);

  const canDrill = useCallback(
    (links) => (links || []).some((l) => l && l.url && /\/explore\//.test(l.url)),
    []
  );

  return (
    <DrillCtx.Provider value={{ openDrill, canDrill }}>
      {children}
      {state && <DrillModal links={state.links} title={state.title} onClose={() => setState(null)} />}
    </DrillCtx.Provider>
  );
}
