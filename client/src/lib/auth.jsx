import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api } from './api.js';

const AuthCtx = createContext(null);

export function useAuth() {
  return useContext(AuthCtx);
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [insightsEnabled, setInsightsEnabled] = useState(false);

  const refresh = useCallback(() => {
    return api.me()
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Global 401 handling: any API call whose session has expired dispatches
  // `auth:unauthorized` (see lib/api.js). Drop the user so the app routes back to
  // the login screen instead of leaving every page on a generic error.
  useEffect(() => {
    const onUnauthorized = () => setUser(null);
    window.addEventListener('auth:unauthorized', onUnauthorized);
    return () => window.removeEventListener('auth:unauthorized', onUnauthorized);
  }, []);

  // Once logged in, check whether AI insights are configured on the server.
  useEffect(() => {
    if (!user) { setInsightsEnabled(false); return; }
    api.insightStatus().then((r) => setInsightsEnabled(!!r.enabled)).catch(() => setInsightsEnabled(false));
  }, [user]);

  const login = useCallback(async (email, password) => {
    const r = await api.login(email, password);
    // 2FA step-up: the server withholds the session and returns a pending token.
    // Surface it to the caller (LoginPage) instead of setting a user.
    if (r && r.twofa) return { twofa: true, pendingToken: r.pendingToken };
    setUser(r.user);
    return r.user;
  }, []);

  // Complete a 2FA step-up (pending token + code) → real session.
  const complete2fa = useCallback(async (pendingToken, code) => {
    const r = await api.verify2fa(pendingToken, code);
    setUser(r.user);
    return r.user;
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, []);

  const isAdmin = user?.role === 'admin';

  return (
    <AuthCtx.Provider value={{ user, loading, isAdmin, insightsEnabled, login, complete2fa, logout, refresh }}>
      {children}
    </AuthCtx.Provider>
  );
}
