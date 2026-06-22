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
const PREVIEW_KEY = 'howler_admin_preview'; // admins: a previewed client NOT in their linked list

export function ProfileProvider({ children }) {
  const { user, isAdmin, refresh } = useAuth();
  const entities = user?.entities || [];
  const [activeId, setActiveId] = useState(() => localStorage.getItem(KEY) || null);
  // Admins default to the console; clients are always in client mode.
  const [mode, setMode] = useState(() => (isAdmin ? (localStorage.getItem(MODE_KEY) || 'console') : 'client'));
  // An admin previewing a client they aren't a member of: we stash {id,name,logo}
  // so the client shell has an identity (header branding, inClientView) even though
  // the entity isn't in their linked `entities`. Server already authorises admins
  // for every entity; this is purely the client-side "which client am I scoped to".
  const [previewEntity, setPreviewEntity] = useState(() => { try { return JSON.parse(localStorage.getItem(PREVIEW_KEY) || 'null'); } catch { return null; } });

  // Resolve to a real, owned profile — fall back to the first if the stored one
  // is gone (access removed) or never set. Admins may also act as ANY entity
  // (preview), so an unlinked stored id stays valid for them.
  const linkedFallback = entities.length ? entities[0].id : null;
  const resolvedId = entities.some((e) => e.id === activeId)
    ? activeId
    : (isAdmin ? (activeId || linkedFallback) : linkedFallback);
  // In console mode there is no active client; otherwise it's the resolved one.
  const effectiveMode = isAdmin ? mode : 'client';
  const activeEntityId = effectiveMode === 'console' ? null : resolvedId;
  const active = useMemo(
    () => entities.find((e) => e.id === activeEntityId)
      || (previewEntity && previewEntity.id === activeEntityId ? previewEntity : null),
    [entities, activeEntityId, previewEntity],
  );

  // Act as a client (a client login switching profile, or an admin entering a
  // client experience). `entityObj` lets an admin preview a client they aren't a
  // member of (carries its name/logo). Re-pull /auth/me so the new profile's
  // role/permissions are fresh — a role change made elsewhere applies without a
  // re-login.
  const setProfile = useCallback((id, entityObj = null) => {
    localStorage.setItem(KEY, id);
    localStorage.setItem(MODE_KEY, 'client');
    if (entityObj && !(user?.entities || []).some((e) => e.id === id)) {
      const p = { id, name: entityObj.name || '', logo: entityObj.logo || '' };
      localStorage.setItem(PREVIEW_KEY, JSON.stringify(p));
      setPreviewEntity(p);
    } else {
      localStorage.removeItem(PREVIEW_KEY);
      setPreviewEntity(null);
    }
    setActiveId(id);
    setMode('client');
    refresh?.();
  }, [refresh, user]);
  // Admins: return to the admin console.
  const enterConsole = useCallback(() => {
    localStorage.setItem(MODE_KEY, 'console');
    localStorage.removeItem(PREVIEW_KEY);
    setPreviewEntity(null);
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
