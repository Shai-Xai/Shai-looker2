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

  // Once logged in, check whether AI insights are configured on the server.
  useEffect(() => {
    if (!user) { setInsightsEnabled(false); return; }
    api.insightStatus().then((r) => setInsightsEnabled(!!r.enabled)).catch(() => setInsightsEnabled(false));
  }, [user]);

  const login = useCallback(async (email, password) => {
    const r = await api.login(email, password);
    setUser(r.user);
    return r.user;
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, []);

  const isAdmin = user?.role === 'admin';

  return (
    <AuthCtx.Provider value={{ user, loading, isAdmin, insightsEnabled, login, logout, refresh }}>
      {children}
    </AuthCtx.Provider>
  );
}
