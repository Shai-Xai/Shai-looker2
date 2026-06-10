import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from './api.js';

// Pin-to-home: tiles pinned here are always read into the home briefing.
// Clients pin for themselves ('user' scope); admins in client preview pin a
// default for the whole client ('entity' scope). Mounted by ViewPage inside a
// suite; everywhere else the default no-op context hides the buttons.
const PinContext = createContext({ enabled: false, isPinned: () => false, toggle: () => {} });
export const usePins = () => useContext(PinContext);

export function PinProvider({ dashboardId, entityId, isAdmin, enabled, children }) {
  const [pins, setPins] = useState(new Set());

  useEffect(() => {
    if (!enabled) return;
    api.myPins(entityId).then((r) => {
      setPins(new Set((r.pins || []).filter((p) => p.dashboardId === dashboardId).map((p) => p.tileId)));
    }).catch(() => {});
  }, [enabled, entityId, dashboardId]);

  const toggle = useCallback((tileId) => {
    const pinned = !pins.has(tileId);
    // Optimistic; the server response reconciles.
    setPins((prev) => { const n = new Set(prev); if (pinned) n.add(tileId); else n.delete(tileId); return n; });
    api.togglePin({ dashboardId, tileId, pinned, scope: isAdmin ? 'entity' : 'user', entityId })
      .then((r) => setPins(new Set((r.pins || []).filter((p) => p.dashboardId === dashboardId).map((p) => p.tileId))))
      .catch(() => {});
  }, [pins, dashboardId, entityId, isAdmin]);

  const isPinned = useCallback((tileId) => pins.has(tileId), [pins]);

  return <PinContext.Provider value={{ enabled: !!enabled, isPinned, toggle }}>{children}</PinContext.Provider>;
}
