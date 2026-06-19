import { useState, useEffect } from 'react';

// Reusable email audit: scheduled-next + a filterable sent log. `load(params)`
// returns { log, upcoming }; admin passes a client column, client surfaces hide
// it (it's always their own).
const KINDS = { digest: '🗓 Digest', campaign: '⚡ Campaign', notification: '📥 Notification', test: '🧪 Test', other: 'Other' };
const fmtT = (iso) => { try { return new Date(iso).toLocaleString('en-ZA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return iso; } };
const statusColor = (s) => (s === 'sent' ? 'var(--success, #10b981)' : s === 'failed' ? 'var(--error, #ef4444)' : 'var(--muted)');

export default function MailLogView({ load, showClient = false }) {
  const [data, setData] = useState(null);
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const refresh = () => load({ kind, status, limit: 200 }).then(setData).catch(() => setData({ log: [], upcoming: [] }));
  useEffect(() => { refresh(); }, [kind, status]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p>;

  return (
    <div>
      {data.upcoming.length > 0 && (
        <div style={{ ...card, marginBottom: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>⏭ Scheduled next</div>
          {data.upcoming.map((u) => (
            <div key={u.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '5px 0', borderTop: '1px solid var(--hairline)', fontSize: 12.5, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600 }}>{u.title}</span>
              {showClient && <span style={{ color: 'var(--muted)' }}>{u.entityName}</span>}
              <span style={{ color: 'var(--muted)' }}>{u.recipients} recipient{u.recipients === 1 ? '' : 's'} · {u.cadence} {u.timeOfDay}</span>
              <span style={{ marginLeft: 'auto', color: 'var(--brand)', fontWeight: 600 }}>{fmtT(u.nextRunAt)}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <select style={sel} value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All types</option>
          <option value="digest">Digests</option>
          <option value="campaign">Campaigns</option>
          <option value="notification">Notifications</option>
          <option value="test">Tests</option>
        </select>
        <select style={sel} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="sent">Sent</option>
          <option value="failed">Failed</option>
          <option value="skipped">Skipped</option>
        </select>
        <button style={mini} onClick={refresh}>↻ Refresh</button>
      </div>

      <div style={card}>
        {data.log.length === 0 ? <p style={{ color: 'var(--muted)', fontSize: 13 }}>No emails yet.</p> : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <th style={th}>When</th><th style={th}>Type</th><th style={th}>To</th><th style={th}>Subject</th>{showClient && <th style={th}>Client</th>}<th style={th}>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.log.map((r, i) => (
                <tr key={i} style={{ borderTop: '1px solid var(--hairline)' }}>
                  <td style={{ ...th, whiteSpace: 'nowrap', color: 'var(--muted)' }}>{fmtT(r.at)}</td>
                  <td style={{ ...th, whiteSpace: 'nowrap' }}>{KINDS[r.kind] || r.kind}</td>
                  <td style={{ ...th, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.recipient}</td>
                  <td style={{ ...th, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.subject}>{r.subject}</td>
                  {showClient && <td style={{ ...th, color: 'var(--muted)' }}>{r.entityName}</td>}
                  <td style={{ ...th, whiteSpace: 'nowrap' }}>
                    <span style={{ fontWeight: 700, color: statusColor(r.status) }}>{r.status}</span>
                    {r.status !== 'sent' && r.detail && <span style={{ color: 'var(--muted)' }} title={r.detail}> · {String(r.detail).slice(0, 40)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const card = { background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 12, padding: 14 };
const th = { padding: '7px 8px', verticalAlign: 'top' };
const sel = { padding: '8px 12px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, background: 'var(--card)', color: 'var(--text)', outline: 'none' };
const mini = { padding: '7px 14px', background: 'rgba(128,128,128,0.10)', color: 'var(--text)', border: '1px solid var(--hairline)', borderRadius: 980, fontSize: 12, fontWeight: 600, cursor: 'pointer' };
