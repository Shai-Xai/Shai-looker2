import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from './api.js';

// Tile marks, two kinds:
//   'pin'    → 📌 the tile renders on the user's home page.
//   'follow' → the home briefing always reads + addresses the tile.
// Clients mark for themselves ('user' scope); admins in client preview set
// entity-wide defaults. Mounted by ViewPage inside a suite; everywhere else
// the default no-op context hides the buttons.
const PinContext = createContext({ enabled: false, isPinned: () => false, isFollowed: () => false, toggle: () => {} });
export const usePins = () => useContext(PinContext);

const forDash = (list, dashboardId) => new Set((list || []).filter((p) => p.dashboardId === dashboardId).map((p) => p.tileId));

export function PinProvider({ dashboardId, entityId, isAdmin, enabled, children }) {
  const [pins, setPins] = useState(new Set());
  const [follows, setFollows] = useState(new Set());

  useEffect(() => {
    if (!enabled) return;
    api.myPins(entityId).then((r) => {
      setPins(forDash(r.pins, dashboardId));
      setFollows(forDash(r.follows, dashboardId));
    }).catch(() => {});
  }, [enabled, entityId, dashboardId]);

  const toggle = useCallback((tileId, kind) => {
    const cur = kind === 'follow' ? follows : pins;
    const on = !cur.has(tileId);
    const set = kind === 'follow' ? setFollows : setPins;
    set((prev) => { const n = new Set(prev); if (on) n.add(tileId); else n.delete(tileId); return n; }); // optimistic
    if (on) api.track(entityId, { kind: 'feature', name: kind, event: 'use' }); // feature-usage signal
    api.togglePin({ dashboardId, tileId, kind, on, scope: isAdmin ? 'entity' : 'user', entityId })
      .then((r) => { setPins(forDash(r.pins, dashboardId)); setFollows(forDash(r.follows, dashboardId)); })
      .catch(() => {});
  }, [pins, follows, dashboardId, entityId, isAdmin]);

  const isPinned = useCallback((tileId) => pins.has(tileId), [pins]);
  const isFollowed = useCallback((tileId) => follows.has(tileId), [follows]);

  return <PinContext.Provider value={{ enabled: !!enabled, isPinned, isFollowed, toggle }}>{children}</PinContext.Provider>;
}
