import { useState, useEffect } from 'react';

// 📤 Provider report — configure the shareable device-health report + who gets it.
// The report link (a print-to-PDF page) can be shared by hand; the scheduled +
// drop-alert digest emails the same link + headline numbers to outside recipients
// (the network / operations provider). Client self-service, scoped to this event.
export default function SignalReportPanel({ suiteId }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} title="Provider report + scheduled email"
        style={{ border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 8, minWidth: 40, minHeight: 34, cursor: 'pointer', fontSize: 14, flexShrink: 0, fontFamily: 'inherit' }}>📤</button>
      {open && <Drawer suiteId={suiteId} onClose={() => setOpen(false)} />}
    </>
  );
}

const CADENCES = [[0, 'Off'], [30, 'Every 30 min'], [60, 'Hourly'], [120, 'Every 2 h']];

function Drawer({ suiteId, onClose }) {
  const [c, setC] = useState(null);
  const [rcpt, setRcpt] = useState('');
  const [cad, setCad] = useState(0);
  const [drop, setDrop] = useState(true);
  const [on, setOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = () => fetch(`/api/my/signal-report/${suiteId}`).then((r) => r.json()).then((d) => {
    setC(d); if (d && !d.error) { setRcpt((d.recipients || []).join('\n')); setCad(d.cadenceMin || 0); setDrop(!!d.dropAlert); setOn(!!d.enabled); }
  }).catch(() => setC({ error: true }));
  useEffect(() => { load(); }, [suiteId]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (over) => {
    setBusy(true); setMsg('');
    try {
      const body = { recipients: rcpt, cadenceMin: cad, dropAlert: drop, enabled: on, ...(over || {}) };
      const d = await fetch(`/api/my/signal-report/${suiteId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
      setC(d); setRcpt((d.recipients || []).join('\n')); setMsg('Saved.');
    } catch (e) { setMsg(e.message || 'Could not save.'); } finally { setBusy(false); }
  };
  const rotate = async () => { if (!window.confirm('Rotate the link? The old link stops working immediately.')) return; setBusy(true); try { setC(await fetch(`/api/my/signal-report/${suiteId}/rotate`, { method: 'POST' }).then((r) => r.json())); setMsg('New link generated.'); } finally { setBusy(false); } };
  const copy = () => { navigator.clipboard?.writeText(c.link).then(() => setMsg('Link copied.'), () => {}); };

  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={(e) => e.stopPropagation()} style={sheet}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <span style={{ fontSize: 19 }}>📤</span>
          <h2 style={{ fontSize: 16, fontWeight: 800, flex: 1, margin: 0 }}>Provider report</h2>
          <button onClick={onClose} style={xBtn} aria-label="Close">✕</button>
        </div>

        {!c ? <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
          : c.error ? <div style={{ color: 'var(--error, #dc2626)', fontSize: 13 }}>Couldn’t load — you may not manage this event.</div>
          : (<>
            {c.testMode && <div style={testBanner}>🧪 <b>Test mode</b> — scheduled + drop emails go to your test inbox only, not the real recipients. Go live in <b>Admin → Data health</b>.</div>}

            <div style={label}>Shareable report link <span style={{ fontWeight: 400, color: 'var(--muted)' }}>(a print-to-PDF page — no login needed)</span></div>
            <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
              <input readOnly value={c.link} onFocus={(e) => e.target.select()} style={{ ...inp, flex: 1, fontSize: 12 }} />
              <button onClick={copy} style={miniBtn}>Copy</button>
              <a href={c.link} target="_blank" rel="noreferrer" style={{ ...miniBtn, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>Open</a>
            </div>
            <button onClick={rotate} disabled={busy} style={{ ...miniBtn, background: 'transparent', border: 'none', color: 'var(--muted)', padding: '2px 0', marginBottom: 14 }}>↻ Rotate link (revoke the old one)</button>

            <div style={label}>Email it to <span style={{ fontWeight: 400, color: 'var(--muted)' }}>(the network / ops provider — one per line)</span></div>
            <textarea value={rcpt} onChange={(e) => setRcpt(e.target.value)} placeholder={'ops@yourprovider.com\nnoc@telco.io'} style={{ ...inp, minHeight: 62, marginBottom: 14 }} />

            <div style={label}>Send a scheduled digest</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
              {CADENCES.map(([v, lab]) => (
                <button key={v} onClick={() => setCad(v)} style={seg(cad === v)}>{lab}</button>
              ))}
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, marginBottom: 10, cursor: 'pointer' }}>
              <input type="checkbox" checked={drop} onChange={() => setDrop((v) => !v)} style={{ width: 17, height: 17, accentColor: 'var(--brand)' }} />
              Also email the moment signal drops below target
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, fontWeight: 700, marginBottom: 14, cursor: 'pointer' }}>
              <input type="checkbox" checked={on} onChange={() => setOn((v) => !v)} style={{ width: 17, height: 17, accentColor: 'var(--brand)' }} />
              Send emails for this event {on ? '· ON' : '· off'}
            </label>

            {msg && <div style={{ fontSize: 12, color: 'var(--brand)', marginBottom: 10, fontWeight: 600 }}>{msg}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => save()} disabled={busy} style={primary}>{busy ? 'Saving…' : 'Save'}</button>
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 10, lineHeight: 1.5 }}>
              The email carries the headline numbers + this link; recipients open it for the full per-station report and a Download-PDF button.
            </div>
          </>)}
      </div>
    </div>
  );
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.42)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 14, zIndex: 1000 };
const sheet = { width: '100%', maxWidth: 460, maxHeight: '88vh', overflowY: 'auto', background: 'var(--card)', border: '1px solid var(--border, var(--hairline))', borderRadius: 16, padding: '18px', boxShadow: '0 18px 48px rgba(0,0,0,0.32)', color: 'var(--text)' };
const label = { fontSize: 12, fontWeight: 700, marginBottom: 6 };
const inp = { width: '100%', boxSizing: 'border-box', padding: '9px 11px', border: '1.5px solid var(--hairline)', borderRadius: 9, fontSize: 14, outline: 'none', background: 'var(--card)', color: 'var(--text)', fontFamily: 'inherit' };
const xBtn = { border: 'none', background: 'rgba(128,128,128,0.12)', color: 'var(--muted)', borderRadius: 980, width: 28, height: 28, fontSize: 13, cursor: 'pointer' };
const miniBtn = { border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--brand)', borderRadius: 8, fontSize: 12, fontWeight: 700, padding: '7px 11px', cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 };
const seg = (a) => ({ border: a ? '1.5px solid var(--brand)' : '1.5px solid var(--hairline)', background: a ? 'rgba(var(--brand-rgb,10,132,255),0.08)' : 'var(--card)', color: a ? 'var(--brand)' : 'var(--text)', borderRadius: 9, fontSize: 12.5, fontWeight: 700, padding: '7px 11px', cursor: 'pointer', fontFamily: 'inherit' });
const primary = { flex: 1, padding: '11px', borderRadius: 10, border: 'none', background: 'var(--brand)', color: '#fff', fontSize: 14, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit' };
const testBanner = { background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.4)', borderRadius: 10, padding: '9px 11px', fontSize: 12, lineHeight: 1.5, marginBottom: 14 };
