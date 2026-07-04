import { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api.js';

// Hive → Calls: the dispatch side of device support calls. Two halves:
//   1. Call links — each device's PRE-BOUND link (station + device baked in). Save it
//      on that device's home screen; the person on the ground just taps a reason.
//   2. The live queue — open calls, acknowledge (with an ETA) and resolve.
// Test mode (default while trialling) routes each call to the test inbox only — staff
// are never contacted until you go live in Admin → Data health.
export default function CallsTab({ suiteId, canManage }) {
  const [kiosk, setKiosk] = useState(null);
  const [devices, setDevices] = useState(null);
  const [data, setData] = useState(null); // { calls, testMode }
  const [filter, setFilter] = useState('open');
  const [showLinks, setShowLinks] = useState(false);

  const loadCalls = useCallback(() => { api.eventopsCalls(suiteId, filter).then(setData).catch(() => setData({ calls: [] })); }, [suiteId, filter]);
  useEffect(() => { api.eventopsKiosk(suiteId).then(setKiosk).catch(() => setKiosk(null)); api.eventopsDevices(suiteId).then((d) => setDevices(d.devices || d)).catch(() => setDevices([])); }, [suiteId]);
  useEffect(() => { loadCalls(); const t = setInterval(loadCalls, 20000); return () => clearInterval(t); }, [loadCalls]);

  const token = kiosk && kiosk.token;
  const calls = (data && data.calls) || [];
  const open = calls.filter((c) => c.status !== 'resolved').length;

  const ack = async (c) => {
    const eta = window.prompt('On it — ETA to reach them? (optional, e.g. "2 min")', '') ?? '';
    try { await api.eventopsAckCall(suiteId, c.id, { eta: eta.trim() }); loadCalls(); } catch (e) { window.alert(e.message); }
  };
  const resolve = async (c) => {
    const resolution = window.prompt('Resolve this call — what happened? (optional)', '') ?? '';
    try { await api.eventopsResolveCall(suiteId, c.id, { resolution: resolution.trim() }); loadCalls(); } catch (e) { window.alert(e.message); }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <h2 style={{ fontSize: 17, fontWeight: 800, margin: '0 0 2px' }}>📣 Calls {open ? <span style={{ color: 'var(--error, #dc2626)' }}>· {open} open</span> : null}</h2>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>The person at a bar taps a reason on the device’s saved link — it lands here with where they are. No app needed.</p>
      </div>

      {data && data.testMode && (
        <div style={testBanner}>🧪 <strong>Test mode</strong> — calls go to your test inbox only; staff aren’t contacted. Flip to live in <strong>Admin → Data health</strong> when ready.</div>
      )}

      {/* ── device call links ── */}
      <div style={panel}>
        <button onClick={() => setShowLinks((v) => !v)} style={linkHdr}>
          <span style={{ fontWeight: 700, fontSize: 14 }}>🔗 Device call links</span>
          <span style={{ color: 'var(--muted)', fontSize: 12.5 }}>{showLinks ? 'Hide' : `Show (${(devices || []).length})`}</span>
        </button>
        {showLinks && (
          !token ? <div style={{ fontSize: 12.5, color: 'var(--muted)', paddingTop: 8 }}>Turn on the staff portal link (Staff tab) first — the call links share its token.</div>
          : !(devices && devices.length) ? <div style={{ fontSize: 12.5, color: 'var(--muted)', paddingTop: 8 }}>No devices yet. Add devices, deploy them to a station, then save each one’s link on that device.</div>
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 10 }}>
              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>Open each device’s link on that device and add it to the home screen — it’s pre-set to that station + device.</div>
              {devices.map((d) => {
                const url = `${window.location.origin}/eventops/call/${suiteId}/${token}/${d.id}`;
                return (
                  <div key={d.id} style={linkRow}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.label || d.serialNumber || 'Device'}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{d.stationName || 'Hive'}</div>
                    </div>
                    <button onClick={() => { navigator.clipboard?.writeText(url).then(() => {}, () => {}); }} style={copyBtn} title={url}>Copy link</button>
                    <a href={url} target="_blank" rel="noreferrer" style={openBtn}>Open</a>
                  </div>
                );
              })}
            </div>
          )
        )}
      </div>

      {/* ── the live queue ── */}
      <div style={{ display: 'flex', gap: 6 }}>
        {['open', 'acked', 'resolved', 'all'].map((f) => (
          <button key={f} onClick={() => setFilter(f)} style={chip(filter === f)}>{f[0].toUpperCase() + f.slice(1)}</button>
        ))}
      </div>

      {!data ? <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
        : !calls.length ? <div style={empty}>No {filter === 'all' ? '' : filter} calls. When someone taps their device link, it shows here.</div>
        : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {calls.map((c) => (
              <div key={c.id} style={callCard(c.status)}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 22 }}>{c.reasonIcon}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 800, fontSize: 14.5 }}>{c.reasonLabel} — {[c.stationLabel, c.deviceLabel].filter(Boolean).join(' · ')}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{c.callerName ? `${c.callerName} · ` : ''}{rel(c.createdAt)}</div>
                  </div>
                  <span style={statusPill(c.status)}>{c.status === 'acked' ? 'On it' : c.status === 'resolved' ? 'Done' : 'Open'}</span>
                </div>
                {(c.comment || c.tried) && (
                  <div style={{ fontSize: 12.5, marginTop: 8, lineHeight: 1.5 }}>
                    {c.comment && <div>💬 {c.comment}</div>}
                    {c.tried && <div style={{ color: 'var(--muted)' }}>🛠 Tried: {c.tried}</div>}
                  </div>
                )}
                {c.status === 'acked' && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>✋ {c.ackedBy}{c.eta ? ` · ETA ${c.eta}` : ''}</div>}
                {c.status === 'resolved' && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6 }}>✅ {c.resolvedBy}{c.resolution ? ` — ${c.resolution}` : ''}</div>}
                {canManage && c.status !== 'resolved' && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    {c.status === 'open' && <button onClick={() => ack(c)} style={ackBtn}>✋ On it</button>}
                    <button onClick={() => resolve(c)} style={resolveBtn}>✅ Resolve</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

function rel(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

const panel = { border: '1px solid var(--hairline)', borderRadius: 12, background: 'var(--card)', padding: '12px 14px' };
const linkHdr = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', border: 'none', background: 'transparent', color: 'var(--text)', cursor: 'pointer', padding: 0, fontFamily: 'inherit' };
const linkRow = { display: 'flex', alignItems: 'center', gap: 8, border: '1px solid var(--hairline)', borderRadius: 10, padding: '8px 10px', background: 'var(--bg, transparent)' };
const copyBtn = { border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--brand)', borderRadius: 8, fontSize: 12, fontWeight: 700, padding: '6px 10px', cursor: 'pointer', flexShrink: 0 };
const openBtn = { border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 8, fontSize: 12, fontWeight: 700, padding: '6px 10px', cursor: 'pointer', flexShrink: 0, textDecoration: 'none' };
const testBanner = { background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.4)', borderRadius: 10, padding: '9px 12px', fontSize: 12.5, lineHeight: 1.5 };
const chip = (active) => ({ border: active ? '1.5px solid var(--brand)' : '1px solid var(--hairline)', background: active ? 'rgba(var(--brand-rgb,10,132,255),0.1)' : 'var(--card)', color: active ? 'var(--brand)' : 'var(--text)', borderRadius: 980, fontSize: 12.5, fontWeight: 700, padding: '6px 13px', cursor: 'pointer' });
const empty = { padding: '24px 16px', textAlign: 'center', color: 'var(--muted)', border: '1px dashed var(--hairline)', borderRadius: 12, fontSize: 13 };
const callCard = (status) => ({ border: status === 'open' ? '1.5px solid rgba(220,38,38,0.5)' : '1px solid var(--hairline)', borderRadius: 12, background: 'var(--card)', padding: '12px 14px', opacity: status === 'resolved' ? 0.68 : 1 });
const statusPill = (status) => ({ fontSize: 10.5, fontWeight: 800, padding: '2px 9px', borderRadius: 980, flexShrink: 0,
  background: status === 'open' ? 'rgba(220,38,38,0.14)' : status === 'acked' ? 'rgba(10,132,255,0.14)' : 'rgba(128,128,128,0.15)',
  color: status === 'open' ? 'var(--error, #dc2626)' : status === 'acked' ? 'var(--brand)' : 'var(--muted)' });
const ackBtn = { flex: 1, border: 'none', background: 'var(--brand)', color: '#fff', borderRadius: 9, fontSize: 13, fontWeight: 700, padding: '9px', cursor: 'pointer' };
const resolveBtn = { flex: 1, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 9, fontSize: 13, fontWeight: 700, padding: '9px', cursor: 'pointer' };
