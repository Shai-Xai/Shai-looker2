import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';

// PUBLIC device support-call page — no Pulse login. The link is PRE-BOUND to one
// station + one device (both in the URL), so the person on the ground never picks
// where they are: they tap a reason, add their name (+ an optional note and what
// they've tried) and send. Reaches dispatch as a live call. Works from any phone,
// so a frozen device never blocks a call for help. Mobile-first, big tap targets.
export default function EventOpsCallPage({ suiteId, token, deviceId }) {
  const [info, setInfo] = useState(null); // { suite, device, station, reasons } | { error }
  const [reason, setReason] = useState('');
  const [name, setName] = useState('');
  const [comment, setComment] = useState('');
  const [tried, setTried] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(null); // the reason label just sent | null
  const [err, setErr] = useState('');

  useEffect(() => {
    api.eopCallInfo(suiteId, token, deviceId)
      .then((d) => setInfo(d && d.device ? d : { error: (d && d.error) || 'This link is not valid.' }))
      .catch((e) => setInfo({ error: e.message || 'Could not load.' }));
  }, [suiteId, token, deviceId]);

  const where = info && info.device
    ? [info.station?.name || info.device.location || 'Hive', info.device.label].filter(Boolean).join(' · ')
    : '';

  const send = async () => {
    if (!reason) { setErr('Tap what you need first.'); return; }
    setBusy(true); setErr('');
    try {
      await api.eopCallRaise(suiteId, token, deviceId, { reason, name: name.trim(), comment: comment.trim(), tried: tried.trim() });
      const lbl = (info.reasons.find((r) => r.key === reason) || {}).label || 'Help';
      setSent(lbl); setReason(''); setComment(''); setTried('');
    } catch (e) { setErr(e.message || 'Could not send — try again.'); } finally { setBusy(false); }
  };

  if (!info) return <Shell><div style={{ color: 'var(--muted)', textAlign: 'center', padding: 40 }}>Loading…</div></Shell>;
  if (info.error) return <Shell><div style={card}><div style={{ fontSize: 34, textAlign: 'center' }}>⚠️</div><p style={{ textAlign: 'center', color: 'var(--muted)' }}>{info.error}</p></div></Shell>;

  if (sent) return (
    <Shell>
      <div style={{ ...card, textAlign: 'center' }}>
        <div style={{ fontSize: 52 }}>✅</div>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: '8px 0 4px' }}>Help is coming</h1>
        <p style={{ color: 'var(--muted)', margin: '0 0 4px' }}>{where}</p>
        <p style={{ fontWeight: 700, margin: '0 0 20px' }}>{sent} — we've told the team.</p>
        <button onClick={() => setSent(null)} style={ghostBtn}>Send another</button>
      </div>
    </Shell>
  );

  return (
    <Shell>
      <div style={card}>
        <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--muted)' }}>Call for help</div>
        <h1 style={{ fontSize: 24, fontWeight: 800, margin: '2px 0 2px' }}>{where}</h1>
        <p style={{ color: 'var(--muted)', fontSize: 13, margin: '0 0 16px' }}>Tap what you need — the team sees exactly where you are.</p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 18 }}>
          {(info.reasons || []).map((r) => (
            <button key={r.key} onClick={() => { setReason(r.key); setErr(''); }} style={reasonBtn(reason === r.key)}>
              <span style={{ fontSize: 30 }}>{r.icon}</span>
              <span style={{ fontSize: 15, fontWeight: 700 }}>{r.label}</span>
            </button>
          ))}
        </div>

        <label style={lbl}>Your name
          <input style={inp} value={name} onChange={(e) => setName(e.target.value)} placeholder="So we know who called" />
        </label>
        <label style={lbl}>Anything to add? <span style={opt}>(optional)</span>
          <textarea style={{ ...inp, minHeight: 54 }} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What's going on" />
        </label>
        <label style={lbl}>Tried already? <span style={opt}>(optional)</span>
          <textarea style={{ ...inp, minHeight: 54 }} value={tried} onChange={(e) => setTried(e.target.value)} placeholder="So we don't repeat it" />
        </label>

        {err && <div style={{ color: 'var(--error, #dc2626)', fontSize: 13, margin: '2px 0 10px' }}>{err}</div>}
        <button onClick={send} disabled={busy} style={sendBtn}>{busy ? 'Sending…' : reason ? `Send — ${(info.reasons.find((r) => r.key === reason) || {}).label}` : 'Send'}</button>
      </div>
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div style={{ minHeight: '100dvh', background: 'var(--bg, #0b0d10)', color: 'var(--text, #e8eaed)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '16px 14px 40px' }}>
      <div style={{ width: '100%', maxWidth: 440 }}>{children}</div>
    </div>
  );
}

const card = { background: 'var(--card, #16191d)', border: '1px solid var(--hairline, rgba(255,255,255,0.08))', borderRadius: 18, padding: '20px 18px', boxShadow: '0 10px 30px rgba(0,0,0,0.25)' };
const reasonBtn = (active) => ({
  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '18px 8px', minHeight: 92,
  border: active ? '2px solid var(--brand, #0a84ff)' : '1.5px solid var(--hairline, rgba(255,255,255,0.12))',
  background: active ? 'rgba(var(--brand-rgb,10,132,255),0.14)' : 'var(--card, #16191d)',
  color: 'var(--text)', borderRadius: 14, cursor: 'pointer', fontFamily: 'inherit',
});
const lbl = { display: 'block', fontSize: 12.5, fontWeight: 700, color: 'var(--muted)', marginBottom: 12 };
const opt = { fontWeight: 500 };
const inp = { width: '100%', boxSizing: 'border-box', marginTop: 5, padding: '12px 12px', border: '1.5px solid var(--hairline, rgba(255,255,255,0.14))', borderRadius: 11, fontSize: 16, outline: 'none', background: 'var(--bg, #0b0d10)', color: 'var(--text)', fontFamily: 'inherit' };
const sendBtn = { width: '100%', padding: '15px', borderRadius: 13, border: 'none', background: 'var(--brand, #0a84ff)', color: '#fff', fontSize: 16.5, fontWeight: 800, cursor: 'pointer', marginTop: 4 };
const ghostBtn = { padding: '12px 20px', borderRadius: 12, border: '1px solid var(--hairline)', background: 'transparent', color: 'var(--text)', fontSize: 14.5, fontWeight: 700, cursor: 'pointer' };
