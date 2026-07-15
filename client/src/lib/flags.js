import { useEffect, useState } from 'react';
import { api } from './api.js';

// The client's effective feature-flag map (server-resolved: overrides + platform
// defaults + parent chain). Cached per entity for the session; while loading (or
// with no entity) everything reads ON so nav never flash-hides. Server routes are
// the real enforcement — this only drives UI hiding.
const cache = new Map(); // entityId -> flags map
export function useMyFlags(entityId) {
  const [flags, setFlags] = useState(entityId ? cache.get(entityId) || null : null);
  useEffect(() => {
    if (!entityId) { setFlags(null); return; }
    if (cache.has(entityId)) { setFlags(cache.get(entityId)); return; }
    let alive = true;
    api.myFlags(entityId)
      .then((r) => { cache.set(entityId, r.flags || {}); if (alive) setFlags(r.flags || {}); })
      .catch(() => { if (alive) setFlags(null); });
    return () => { alive = false; };
  }, [entityId]);
  return flags;
}
// True unless the map is loaded AND says off.
export const flagOn = (flags, key) => !flags || flags[key] !== false;
export const bustFlagsCache = () => cache.clear();
