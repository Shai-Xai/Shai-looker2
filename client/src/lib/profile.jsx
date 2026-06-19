import { createContext, useContext, useState, useMemo, useCallback, useEffect, useRef } from 'react';
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
  const { user, isAdmin, refresh } = useAuth();
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
  // client experience). Re-pull /auth/me so the new profile's role/permissions
  // are fresh — a role change made elsewhere applies without a re-login.
  const setProfile = useCallback((id) => {
    localStorage.setItem(KEY, id);
    localStorage.setItem(MODE_KEY, 'client');
    setActiveId(id);
    setMode('client');
    refresh?.();
  }, [refresh]);
  // Admins: return to the admin console.
  const enterConsole = useCallback(() => {
    localStorage.setItem(MODE_KEY, 'console');
    setMode('console');
    refresh?.();
  }, [refresh]);

  // Deep-link from an email (e.g. a digest's "Open Pulse"): ?entity=<id> opens
  // ON that client's profile, so a multi-profile login doesn't land on its
  // default. Applied once entities have loaded (after /auth/me), then the param
  // is stripped so it doesn't re-fire on later navigation.
  const entityParamDone = useRef(false);
  useEffect(() => {
    if (entityParamDone.current) return;
    let want = '';
    try { want = new URLSearchParams(window.location.search).get('entity') || ''; } catch { want = ''; }
    if (!want) { entityParamDone.current = true; return; }
    if (!entities.length) return; // wait for the profile list to load
    entityParamDone.current = true;
    if (entities.some((e) => e.id === want)) {
      localStorage.setItem(KEY, want);
      localStorage.setItem(MODE_KEY, 'client');
      setActiveId(want);
      setMode('client');
    }
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete('entity');
      window.history.replaceState({}, '', u.pathname + u.search + u.hash);
    } catch { /* ignore */ }
  }, [entities]);

  // Refresh permissions when the tab regains focus (throttled), so role/access
  // changes made in another session take effect without logging out.
  useEffect(() => {
    let last = Date.now();
    const maybeRefresh = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - last > 30000) { last = now; refresh?.(); }
    };
    window.addEventListener('focus', maybeRefresh);
    document.addEventListener('visibilitychange', maybeRefresh);
    return () => { window.removeEventListener('focus', maybeRefresh); document.removeEventListener('visibilitychange', maybeRefresh); };
  }, [refresh]);

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
