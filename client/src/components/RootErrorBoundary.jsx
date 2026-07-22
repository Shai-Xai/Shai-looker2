import { Component } from 'react';
import crashReport from '../lib/crashReport.js';

// Whole-app safety net for two distinct cases:
//
//  1) A DEPLOY is rolling out while this tab is open. The bundle loaded earlier
//     can break against the freshly deployed server (a sudden "x is not a
//     function" deep in React). We detect it — the server now serves a different
//     asset hash, or it's briefly down (502) — and show "Updating…", retrying
//     automatically until the new build loads. This is the common case and the
//     user should never see a scary error for it.
//
//  2) A GENUINE render crash — show an actionable screen, with the stack +
//     component stack under "Technical details" (the build keeps names so these
//     are readable).
export default class RootErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null, deploying: false };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidMount() {
    // If the app has been alive a few seconds, we're past any deploy hiccup —
    // clear the one-shot guards so a FUTURE deploy gets a fresh set of retries.
    this._clearT = setTimeout(() => {
      try { sessionStorage.removeItem('howler_deploy_retries'); sessionStorage.removeItem('howler_reloaded_once'); } catch { /* ignore */ }
    }, 5000);
  }
  componentWillUnmount() { clearTimeout(this._clearT); }
  componentDidCatch(error, info) {
    clearTimeout(this._clearT); // don't clear the retry guards mid-crash
    this.setState({ info });
    const msg = String(error?.message || error);
    // A dynamic-import/chunk failure means the HTML references assets that no
    // longer exist (post-deploy). Force one fresh reload to pull the new build.
    if (/(dynamically imported module|importing a module script failed|Failed to fetch.*module|ChunkLoadError)/i.test(msg)
        && !sessionStorage.getItem('howler_reloaded_once')) {
      sessionStorage.setItem('howler_reloaded_once', '1');
      window.location.reload();
      return;
    }
    // Otherwise check whether a deploy is in progress — a stale bundle running
    // against a just-deployed server is the usual cause of a sudden crash.
    this.checkDeploy();
  }
  async checkDeploy() {
    let deploying = false;
    try {
      const res = await fetch(`/?_=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) {
        deploying = true; // server restarting (502/503) mid-deploy
      } else {
        const html = await res.text();
        const served = (html.match(/assets\/index-[\w-]+\.js/) || [])[0] || '';
        const loaded = Array.from(document.scripts).map((s) => s.getAttribute('src') || '')
          .find((s) => /assets\/index-[\w-]+\.js/.test(s)) || '';
        // The running bundle differs from what the server serves now → new build.
        if (served && loaded && !loaded.endsWith(served.split('/').pop())) deploying = true;
      }
    } catch {
      deploying = true; // network/fetch failed → almost certainly mid-deploy
    }
    if (deploying) {
      this.setState({ deploying: true });
      // Auto-retry to pick up the finished deploy, capped so a genuine outage
      // doesn't loop forever (after which the manual "Reload" stays available).
      const tries = Number(sessionStorage.getItem('howler_deploy_retries') || '0');
      if (tries < 4) {
        sessionStorage.setItem('howler_deploy_retries', String(tries + 1));
        setTimeout(() => window.location.reload(), 4000);
      }
    } else {
      // A GENUINE crash (not a deploy hiccup) — tell the server so the team
      // sees it without waiting for a user to complain.
      crashReport(this.state.error, this.state.info);
    }
  }
  render() {
    if (this.state.deploying) {
      return (
        <Frame>
          <h1 style={h1Style}>Updating…</h1>
          <p style={pStyle}>A new version of Pulse is rolling out. Hang tight — this page will refresh itself in a moment.</p>
          <div style={{ margin: '14px auto 0', width: 22, height: 22, border: '2.5px solid rgba(128,128,128,0.25)', borderTopColor: '#FF385C', borderRadius: '50%', animation: 'howler-spin 0.8s linear infinite' }} />
          <style>{'@keyframes howler-spin{to{transform:rotate(360deg)}}'}</style>
          <button
            onClick={() => { try { sessionStorage.removeItem('howler_deploy_retries'); } catch { /* ignore */ } window.location.reload(); }}
            style={{ ...btnStyle, marginTop: 18, background: 'transparent', color: '#86868b', border: '1px solid var(--hairline, #e0e0e0)' }}
          >
            Reload now
          </button>
        </Frame>
      );
    }
    if (this.state.error) {
      return (
        <Frame>
          <h1 style={h1Style}>Something went wrong</h1>
          <p style={pStyle}>The app hit an error while loading. Reloading usually fixes it.</p>
          <button onClick={() => { try { sessionStorage.removeItem('howler_reloaded_once'); } catch { /* ignore */ } window.location.reload(); }} style={btnStyle}>
            Reload
          </button>
          <p style={{ fontSize: 11, color: '#b0b0b6', marginTop: 16, wordBreak: 'break-word' }}>{String(this.state.error.message || this.state.error)}</p>
          <details style={{ marginTop: 14, textAlign: 'left' }}>
            <summary style={{ cursor: 'pointer', fontSize: 12, color: '#86868b', textAlign: 'center' }}>Technical details</summary>
            <pre style={{ marginTop: 8, maxHeight: 260, overflow: 'auto', fontSize: 10.5, lineHeight: 1.45, background: 'rgba(0,0,0,0.05)', padding: 10, borderRadius: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: '#555' }}>
              {String(this.state.error.stack || this.state.error.message || this.state.error)}
              {this.state.info?.componentStack ? `\n— component stack —${this.state.info.componentStack}` : ''}
            </pre>
          </details>
        </Frame>
      );
    }
    return this.props.children;
  }
}

// Shared centered card with the Pulse mark — used by both states.
function Frame({ children }) {
  return (
    <div style={{ minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif', background: 'var(--bg, #f5f6f8)' }}>
      <div style={{ maxWidth: 420, textAlign: 'center' }}>
        <div style={{ width: 52, height: 52, borderRadius: 14, margin: '0 auto 18px', overflow: 'hidden', background: 'linear-gradient(135deg, #FF385C 0%, #FF6B35 45%, #7C3AED 100%)' }}>
          <img src="/logo.png" alt="Howler : Pulse" onError={(e) => { e.currentTarget.style.display = 'none'; }} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        </div>
        {children}
      </div>
    </div>
  );
}

const h1Style = { fontSize: 18, fontWeight: 700, marginBottom: 8 };
const pStyle = { fontSize: 14, color: '#86868b', lineHeight: 1.5, marginBottom: 18 };
const btnStyle = { border: 'none', background: '#FF385C', color: '#fff', borderRadius: 980, padding: '10px 22px', fontSize: 14, fontWeight: 600, cursor: 'pointer' };
