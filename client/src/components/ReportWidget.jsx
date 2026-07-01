// App-wide "Report" widget — a floating button on every screen (for staff AND
// clients) that files a bug, an improvement, or an idea into the product board.
// Because it's mounted globally it auto-captures the screen the reporter was on.
// Bottom-LEFT so it never collides with the Owl chat launcher (bottom-right).
import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useIsMobile } from '../lib/useIsMobile.js';

const TYPES = [
  ['bug', '🐞 Bug', 'Something is broken or wrong'],
  ['improvement', '✨ Improvement', 'Make something better'],
  ['idea', '💡 Idea', 'A new capability or innovation'],
];
const URGENCIES = [['low', 'Low'], ['normal', 'Normal'], ['high', 'High'], ['urgent', 'Urgent']];

// A readable label for the current screen (strip ids so it reads as an area).
function screenLabel(pathname) {
  if (!pathname || pathname === '/') return 'Home';
  return pathname;
}

export default function ReportWidget() {
  const { user } = useAuth();
  const location = useLocation();
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState('bug');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [urgency, setUrgency] = useState('normal');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  // Only for logged-in users; never on the login/recovery screens.
  if (!user) return null;

  const screen = screenLabel(location.pathname);

  function reset() {
    setType('bug'); setTitle(''); setBody(''); setUrgency('normal');
    setBusy(false); setDone(false); setError('');
  }
  function close() { setOpen(false); setTimeout(reset, 200); }

  async function submit() {
    if (!body.trim() && !title.trim()) { setError('Add a title or a description.'); return; }
    setBusy(true); setError('');
    try {
      await api.submitTicket({ type, title: title.trim(), body: body.trim(), urgency, screen });
      setDone(true);
    } catch (e) {
      setError(e.message || 'Could not submit — please try again.');
    } finally { setBusy(false); }
  }

  const bodyLabel = type === 'bug'
    ? 'What went wrong? What did you expect instead?'
    : "What's the objective? What outcome do you want?";

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        aria-label="Report a bug or idea"
        title="Report a bug, improvement or idea"
        style={{
          position: 'fixed', bottom: 20, left: isMobile ? 16 : 24, zIndex: 54,
          width: 54, height: 54, borderRadius: '50%', border: '1px solid var(--hairline)',
          background: 'var(--card)', boxShadow: '0 6px 22px rgba(0,0,0,0.3)', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22,
        }}
      >💬</button>

      {open && (
        <div
          onClick={close}
          style={{
            position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.45)',
            display: 'flex', alignItems: isMobile ? 'flex-end' : 'center', justifyContent: 'center',
            padding: isMobile ? 0 : 20,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%', maxWidth: isMobile ? 'none' : 460, background: 'var(--card)',
              borderRadius: isMobile ? '18px 18px 0 0' : 16, border: '1px solid var(--hairline)',
              boxShadow: '0 20px 60px rgba(0,0,0,0.35)', maxHeight: isMobile ? '92dvh' : '88vh',
              overflowY: 'auto', paddingBottom: 'env(safe-area-inset-bottom)',
            }}
          >
            <div style={{ padding: '18px 18px 20px' }}>
              {done ? (
                <div style={{ textAlign: 'center', padding: '24px 8px' }}>
                  <div style={{ fontSize: 40, marginBottom: 10 }}>🙌</div>
                  <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Thank you — logged.</h3>
                  <p style={{ color: 'var(--muted)', fontSize: 14, marginBottom: 18 }}>
                    {type === 'bug'
                      ? 'The team can see it on the product board and will pick it up.'
                      : "We're turning your note into a clear ticket now — the team will review it on the board."}
                  </p>
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
                    <button onClick={reset} style={btnGhost}>Report another</button>
                    <button onClick={close} style={btnPrimary}>Done</button>
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                    <h3 style={{ fontSize: 18, fontWeight: 700 }}>Report</h3>
                    <button onClick={close} aria-label="Close" style={{ background: 'none', border: 'none', fontSize: 22, color: 'var(--muted)', cursor: 'pointer', lineHeight: 1 }}>×</button>
                  </div>
                  <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 14 }}>
                    On <strong style={{ color: 'var(--text)' }}>{screen}</strong>. Tell us what's up — a person and the AI will pick it up.
                  </p>

                  {/* Type */}
                  <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
                    {TYPES.map(([key, label]) => (
                      <button key={key} onClick={() => setType(key)} style={segBtn(type === key)}>{label}</button>
                    ))}
                  </div>

                  <label style={lbl}>Title <span style={{ color: 'var(--muted)', fontWeight: 400 }}>(optional)</span></label>
                  <input className="fld" value={title} onChange={(e) => setTitle(e.target.value)}
                    placeholder={type === 'bug' ? 'Short summary of the problem' : 'Short summary of the idea'}
                    style={{ width: '100%', marginBottom: 12, boxSizing: 'border-box' }} />

                  <label style={lbl}>{bodyLabel}</label>
                  <textarea className="fld" value={body} onChange={(e) => setBody(e.target.value)} rows={5}
                    placeholder={type === 'bug' ? 'e.g. When I click Export on the sales dashboard, nothing happens…' : 'e.g. It would help if we could…'}
                    style={{ width: '100%', marginBottom: 12, boxSizing: 'border-box', resize: 'vertical' }} />

                  {type === 'bug' && (
                    <>
                      <label style={lbl}>How urgent is it?</label>
                      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
                        {URGENCIES.map(([key, label]) => (
                          <button key={key} onClick={() => setUrgency(key)} style={segBtn(urgency === key)}>{label}</button>
                        ))}
                      </div>
                    </>
                  )}

                  {error && <p style={{ color: 'var(--brand)', fontSize: 13, marginBottom: 10 }}>{error}</p>}

                  <button onClick={submit} disabled={busy} style={{ ...btnPrimary, width: '100%', opacity: busy ? 0.6 : 1 }}>
                    {busy ? 'Sending…' : 'Submit'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const lbl = { display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 };
const btnPrimary = { padding: '10px 16px', borderRadius: 10, border: 'none', background: 'var(--brand)', color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer' };
const btnGhost = { padding: '10px 16px', borderRadius: 10, border: '1px solid var(--hairline)', background: 'transparent', color: 'var(--text)', fontWeight: 600, fontSize: 14, cursor: 'pointer' };
function segBtn(active) {
  return {
    flex: 1, padding: '8px 6px', borderRadius: 9, fontSize: 13, fontWeight: 600, cursor: 'pointer',
    border: `1px solid ${active ? 'var(--brand)' : 'var(--hairline)'}`,
    background: active ? 'rgba(var(--brand-rgb), 0.12)' : 'transparent',
    color: active ? 'var(--brand)' : 'var(--text)', whiteSpace: 'nowrap',
  };
}
