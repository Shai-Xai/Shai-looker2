import { Component } from 'react';

// Whole-app safety net: turns a render crash into a visible, actionable screen
// instead of a blank white page. A chunk-load failure (stale cached index.html
// after a deploy) is detected and offered a one-tap hard reload.
export default class RootErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error) {
    // A dynamic-import/chunk failure means the HTML references assets that no
    // longer exist (post-deploy). Force one fresh reload to pull the new build.
    const msg = String(error?.message || error);
    if (/(dynamically imported module|importing a module script failed|Failed to fetch.*module|ChunkLoadError)/i.test(msg)
        && !sessionStorage.getItem('howler_reloaded_once')) {
      sessionStorage.setItem('howler_reloaded_once', '1');
      window.location.reload();
    }
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', background: 'var(--bg, #f5f6f8)' }}>
          <div style={{ maxWidth: 420, textAlign: 'center' }}>
            <div style={{ width: 52, height: 52, borderRadius: 14, margin: '0 auto 18px', background: 'linear-gradient(135deg, #FF385C 0%, #FF6B35 45%, #7C3AED 100%)' }} />
            <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Something went wrong</h1>
            <p style={{ fontSize: 14, color: '#86868b', lineHeight: 1.5, marginBottom: 18 }}>
              The app hit an error while loading. Reloading usually fixes it.
            </p>
            <button
              onClick={() => { sessionStorage.removeItem('howler_reloaded_once'); window.location.reload(); }}
              style={{ border: 'none', background: '#FF385C', color: '#fff', borderRadius: 980, padding: '10px 22px', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}
            >
              Reload
            </button>
            <p style={{ fontSize: 11, color: '#b0b0b6', marginTop: 16, wordBreak: 'break-word' }}>{String(this.state.error.message || this.state.error)}</p>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
