import { createContext, useContext, useState, useMemo, useCallback } from 'react';
import { useAuth } from './auth.jsx';

// The active "workspace" for the signed-in login. A client login moves between
// its client profiles. An admin login moves between the ADMIN CONSOLE and any
// client accounts it's linked to (admins can be customers too). Lifted to a
// context so the top-header switcher, the shell routing and every page agree on
// "what am I looking at right now". Persisted so it survives reloads.
const ProfileCtx = createContext(null);
const KEY = 'howler_active_profile';
const MODE_KEY = 'howler_active_mode'; // admins only: 'console' | 'client'

export function ProfileProvider({ children }) {
  const { user, isAdmin } = useAuth();
  const entities = user?.entities || [];
  const [activeId, setActiveId] = useState(() => localStorage.getItem(KEY) || null);
  // Admins default to the console; clients are always in client mode.
  const [mode, setMode] = useState(() => (isAdmin ? (localStorage.getItem(MODE_KEY) || 'console') : 'client'));

  // Resolve to a real, owned profile — fall back to the first if the stored one
  // is gone (access removed) or never set.
  const resolvedId = entities.length
    ? (entities.some((e) => e.id === activeId) ? activeId : entities[0].id)
    : null;
  // In console mode there is no active client; otherwise it's the resolved one.
  const effectiveMode = isAdmin ? mode : 'client';
  const activeEntityId = effectiveMode === 'console' ? null : resolvedId;
  const active = useMemo(() => entities.find((e) => e.id === activeEntityId) || null, [entities, activeEntityId]);

  // Act as a client (a client login switching profile, or an admin entering a
  // client experience).
  const setProfile = useCallback((id) => {
    localStorage.setItem(KEY, id);
    localStorage.setItem(MODE_KEY, 'client');
    setActiveId(id);
    setMode('client');
  }, []);
  // Admins: return to the admin console.
  const enterConsole = useCallback(() => {
    localStorage.setItem(MODE_KEY, 'console');
    setMode('console');
  }, []);

  const value = useMemo(
    () => ({ entities, activeEntityId, active, mode: effectiveMode, isAdmin, setProfile, enterConsole }),
    [entities, activeEntityId, active, effectiveMode, isAdmin, setProfile, enterConsole],
  );
  return <ProfileCtx.Provider value={value}>{children}</ProfileCtx.Provider>;
}

export function useProfile() {
  return useContext(ProfileCtx)
    || { entities: [], activeEntityId: null, active: null, mode: 'client', isAdmin: false, setProfile: () => {}, enterConsole: () => {} };
}
