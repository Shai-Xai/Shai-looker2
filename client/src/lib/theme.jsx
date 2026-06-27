import { createContext, useContext, useEffect, useState } from 'react';

// Light/dark theme. Persists the user's choice; defaults to the OS preference.
// Sets <html data-theme="…"> so the CSS tokens (and anything using them) flip.
const ThemeCtx = createContext({ theme: 'light', toggle: () => {} });

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => {
    const saved = typeof localStorage !== 'undefined' && localStorage.getItem('howler_theme');
    if (saved === 'dark' || saved === 'light') return saved;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('howler_theme', theme); } catch { /* ignore */ }
  }, [theme]);
  const toggle = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  return <ThemeCtx.Provider value={{ theme, toggle }}>{children}</ThemeCtx.Provider>;
}

export const useTheme = () => useContext(ThemeCtx);
