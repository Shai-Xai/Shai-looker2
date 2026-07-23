// Admin → Product → 🩺 Code health: the daily automated code review, readable
// inside Pulse. Once a day (05:15 SAST) a read-only reviewer reads the last 24h
// of commits plus a rotating slice of the server and posts one report to a
// rolling GitHub issue; this panel mirrors that issue so nobody needs a GitHub
// login to see what it found. Data: GET /api/admin/code-health (server/codeHealth.js).
import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';

// Tiny inline markdown (bold / code / italic) — the reports are prose with
// **emphasis** and `file:line` spans; no markdown lib in Pulse (same approach
// as the Owl's renderer).
function Inline({ text }) {
  const out = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|\*([^*\s][^*]*)\*/g;
  const s = String(text || '');
  let last = 0, m, k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    if (m[1] != null) out.push(<strong key={k++}>{m[1]}</strong>);
    else if (m[2] != null) out.push(<code key={k++} style={{ background: 'var(--bg)', border: '1px solid var(--hairline)', borderRadius: 4, padding: '0 4px', fontSize: '0.92em' }}>{m[2]}</code>);
    else out.push(<em key={k++}>{m[3]}</em>);
    last = m.index + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

function ReportBody({ body }) {
  // Paragraph-per-blank-line; bullet-ish lines keep their marker. pre-wrap keeps
  // any structure the reviewer used without a full markdown engine.
  const blocks = String(body || '').split(/\n{2,}/);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {blocks.map((b, i) => (
        <p key={i} style={{ margin: 0, fontSize: 13.5, lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}><Inline text={b} /></p>
      ))}
    </div>
  );
}

const day = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const time = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
// The reviewer posts as the Claude app; anything else is a human/fix follow-up.
const isReviewer = (r) => /^claude(\[bot\])?$/i.test(r.author || '');
const firstLine = (body) => String(body || '').split('\n').find((l) => l.trim()) || '';

export default function CodeHealthPanel() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(0); // newest report starts expanded

  const load = (refresh) => {
    setBusy(true); setErr('');
    api.codeHealth(refresh)
      .then((d) => { setData(d); setOpen(0); })
      .catch((e) => setErr(e.message || 'Could not load the code health feed.'))
      .finally(() => setBusy(false));
  };
  useEffect(() => { load(false); }, []);

  if (err) return <p style={{ color: 'var(--brand)', fontSize: 13.5 }}>{err} <button onClick={() => load(true)} style={linkBtn}>Retry</button></p>;
  if (!data) return <p style={{ color: 'var(--muted)', fontSize: 13.5 }}>Loading the latest reviews…</p>;
  if (!data.configured) {
    return <p style={{ color: 'var(--muted)', fontSize: 13.5, maxWidth: 640 }}>Connect GitHub (Admin → Integrations → GitHub) to read the daily code-health reviews here.</p>;
  }
  if (!data.found) {
    return <p style={{ color: 'var(--muted)', fontSize: 13.5, maxWidth: 640 }}>No review issue yet — the first daily run (05:15) creates it automatically. You can also trigger one from the repo's Actions tab ("Code health — daily review" → Run workflow).</p>;
  }

  const reports = data.reports || [];
  return (
    <div style={{ maxWidth: 780 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>🩺 Daily code-health review</h3>
        <button onClick={() => load(true)} disabled={busy} style={{ ...linkBtn, opacity: busy ? 0.5 : 1 }}>{busy ? 'Refreshing…' : '↻ Refresh'}</button>
      </div>
      <p style={{ color: 'var(--muted)', fontSize: 12.5, margin: '0 0 14px', lineHeight: 1.5 }}>
        An automated reviewer reads every commit from the last 24h plus a rotating slice of the server, every morning at 05:15 — findings a senior engineer would act on, nothing else.
        {data.stale ? ' (GitHub is unreachable right now — showing the last loaded copy.)' : ''}
        {' '}<a href={data.issue.url} target="_blank" rel="noreferrer" style={{ color: 'var(--muted)' }}>Source issue ↗</a>
      </p>

      {!reports.length && <p style={{ color: 'var(--muted)', fontSize: 13.5 }}>The issue exists but has no reports yet — the next 05:15 run posts the first one.</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {reports.map((r, i) => {
          const on = open === i;
          return (
            <div key={r.id} style={{ border: '1px solid var(--hairline)', borderRadius: 12, background: 'var(--card)', overflow: 'hidden' }}>
              <button onClick={() => setOpen(on ? -1 : i)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', minHeight: 44, padding: '10px 14px', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left', color: 'var(--text)' }}>
                <span style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap' }}>{day(r.createdAt)}</span>
                <span style={{ fontSize: 11, fontWeight: 700, borderRadius: 980, padding: '2px 8px', background: isReviewer(r) ? 'rgba(var(--brand-rgb),0.12)' : 'var(--bg)', color: isReviewer(r) ? 'var(--brand)' : 'var(--muted)', whiteSpace: 'nowrap' }}>
                  {isReviewer(r) ? '🩺 Reviewer' : r.author}
                </span>
                {!on && <span style={{ fontSize: 12.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}><Inline text={firstLine(r.body)} /></span>}
                <span style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 12, flexShrink: 0 }}>{on ? '▾' : '▸'} {time(r.createdAt)}</span>
              </button>
              {on && <div style={{ padding: '2px 14px 14px' }}><ReportBody body={r.body} /></div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const linkBtn = { border: 'none', background: 'none', color: 'var(--brand)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', padding: 0 };
