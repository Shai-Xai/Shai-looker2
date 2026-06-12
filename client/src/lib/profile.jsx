import { createContext, useContext, useState, useMemo, useCallback } from 'react';
import { useAuth } from './auth.jsx';

// The active client profile for a login that holds several. Lifted to a context
// so the top header (identity) and the sidebar switcher stay in sync, and so
// every page resolves the same "which client am I looking at" value.
const ProfileCtx = createContext(null);
const KEY = 'howler_active_profile';

export function ProfileProvider({ children }) {
  const { user } = useAuth();
  const entities = user?.entities || [];
  const [activeId, setActiveId] = useState(() => localStorage.getItem(KEY) || null);

  // Resolve to a real, owned profile — fall back to the first if the stored one
  // is gone (access removed) or never set.
  const activeEntityId = entities.length
    ? (entities.some((e) => e.id === activeId) ? activeId : entities[0].id)
    : null;
  const active = useMemo(() => entities.find((e) => e.id === activeEntityId) || null, [entities, activeEntityId]);

  const setProfile = useCallback((id) => { localStorage.setItem(KEY, id); setActiveId(id); }, []);

  const value = useMemo(() => ({ entities, activeEntityId, active, setProfile }), [entities, activeEntityId, active, setProfile]);
  return <ProfileCtx.Provider value={value}>{children}</ProfileCtx.Provider>;
}

export function useProfile() {
  return useContext(ProfileCtx) || { entities: [], activeEntityId: null, active: null, setProfile: () => {} };
}
