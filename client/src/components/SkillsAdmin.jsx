import { useEffect, useState } from 'react';
import { useIsMobile } from '../lib/useIsMobile.js';

// ─── Skills admin — configure, run, backtest & grade autonomous skills ─────────
// Admin → client detail → 🤖 Skills (docs/SKILLS_BRIEF.md P1). One card per
// specialist (first: the Ticketing Manager): activate it per event, edit the
// client's playbook additions, run it now, or BACKTEST it against a finished
// event (frozen at N days out — it cannot read past the freeze). Every run lands
// in the log below where an AM grades it (👍/👎 + note) — the training loop.

const input = { width: '100%', boxSizing: 'border-box', padding: '9px 11px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, outline: 'none', fontFamily: 'inherit', background: 'var(--card, #fff)', color: 'var(--text)' };
const btn = { padding: '8px 14px', borderRadius: 8, border: '1.5px solid var(--hairline)', background: 'transparent', color: 'var(--text)', fontSize: 12.5, cursor: 'pointer', minHeight: 36 };
const primaryBtn = { ...btn, background: 'var(--text)', color: 'var(--bg, #fff)', border: 0, fontWeight: 700 };
const card = { border: '1px solid var(--hairline)', borderRadius: 12, padding: 14, marginTop: 10 };
const small = { fontSize: 11.5, color: 'var(--muted)', margin: '2px 0 4px' };
const chip = (bg, fg) => ({ display: 'inline-block', padding: '2px 9px', borderRadius: 999, fontSize: 11, fontWeight: 700, background: bg, color: fg });
const summaryStyle = { cursor: 'pointer', fontWeight: 700, fontSize: 13, padding: '6px 0', listStyle: 'none' };

const MODE = { backtest: ['🧪 backtest', '#eef2ff', '#4338ca'], manual: ['▶ manual', '#ecfdf5', '#047857'], scheduled: ['⏰ scheduled', '#fff7ed', '#c2410c'] };

// Minimal markdown-ish rendering (bold + bullets), matching InsightModal's style.
function renderAdvice(text) {
  if (!text) return null;
  return text.split('\n').filter((l) => l.trim()).map((line, i) => {
    const t = line.trim();
    const bulleted = /^[-*]\s+/.test(t);
    const content = t.replace(/^[-*]\s+/, '');
    const parts = content.split(/(\*\*[^*]+\*\*)/g).map((p, j) =>
      p.startsWith('**') && p.endsWith('**') ? <strong key={j}>{p.slice(2, -2)}</strong> : p
    );
    const headline = /^HEADLINE:/i.test(content);
    return (
      <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 7, fontSize: headline ? 14 : 13, fontWeight: headline ? 800 : 400, lineHeight: 1.5 }}>
        {bulleted && <span style={{ color: 'var(--brand, #6d5df6)' }}>•</span>}
        <span>{parts}</span>
      </div>
    );
  });
}

async function j(url, opts) {
  const r = await fetch(url, opts ? { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined } : undefined);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

export default function SkillsAdmin({ entityId, suites = [] }) {
  const isMobile = useIsMobile();
  const base = `/api/admin/entities/${entityId}`;
  const [catalogue, setCatalogue] = useState(null); // [{key,name,emoji,blurb,defaultPlaybook,instances}]
  const [enabled, setEnabled] = useState(true);
  const [runs, setRuns] = useState([]);
  const [busy, setBusy] = useState(''); // '<key>:<suiteId>:run' | '...:backtest' | 'save'
  const [err, setErr] = useState('');
  const [note, setNote] = useState(''); // transient success note

  const suiteName = (id) => (suites.find((s) => s.id === id) || {}).name || id || '(no event)';

  const load = () => {
    j(`${base}/skills`).then((d) => { setCatalogue(d.skills || []); setEnabled(d.enabled !== false); }).catch((e) => setErr(e.message));
    j(`${base}/skill-runs`).then((d) => setRuns(d.runs || [])).catch(() => {});
  };
  useEffect(load, [entityId]); // eslint-disable-line react-hooks/exhaustive-deps

  const upsert = async (key, patch) => {
    setBusy('save'); setErr('');
    try { await j(`${base}/skills/${key}`, { method: 'PUT', body: patch }); load(); } catch (e) { setErr(e.message); }
    setBusy('');
  };

  const runNow = async (key, suiteId) => {
    const tag = `${key}:${suiteId}:run`;
    setBusy(tag); setErr(''); setNote('');
    try {
      await j(`${base}/skills/${key}/run`, { method: 'POST', body: { suiteId } });
      setNote('Review complete — see the run log below.');
      load();
    } catch (e) { setErr(e.message); }
    setBusy('');
  };

  const backtest = async (key, suiteId, daysBefore, freezeDate) => {
    const tag = `${key}:${suiteId}:backtest`;
    setBusy(tag); setErr(''); setNote('');
    try {
      await j(`${base}/skills/${key}/backtest`, { method: 'POST', body: { suiteId, daysBefore: Number(daysBefore) || 0, freezeDate: freezeDate || '' } });
      setNote('Backtest complete — mark its homework in the run log below.');
      load();
    } catch (e) { setErr(e.message); }
    setBusy('');
  };

  const grade = async (runId, rating, feedbackNote) => {
    setErr('');
    try {
      const { run } = await j(`/api/admin/skill-runs/${runId}/feedback`, { method: 'POST', body: { rating, note: feedbackNote } });
      setRuns((rs) => rs.map((r) => (r.id === run.id ? { ...r, ...run } : r)));
    } catch (e) { setErr(e.message); }
  };

  if (!catalogue) return <p style={small}>Loading skills…</p>;

  return (
    <div>
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 4px', lineHeight: 1.55 }}>
        <b>Skills</b> are autonomous specialists that review one event on a schedule and write grounded,
        <b> advise-only</b> reviews — they cannot send, change prices or touch money. Instances start
        <b> paused</b> (shadow mode): nothing runs until you activate it. Train a skill by editing its
        playbook additions, <b>backtesting</b> it on a finished event, and grading every run below.
      </p>
      {!enabled && <p style={{ ...small, color: '#b45309' }}>⚠ The skills engine is switched off platform-wide (setting <code>skills_enabled</code>) — nothing will run, including manual runs’ schedules.</p>}
      {err && <p style={{ ...small, color: '#b91c1c' }}>⚠ {err}</p>}
      {note && <p style={{ ...small, color: '#047857' }}>✓ {note}</p>}

      {catalogue.map((def) => (
        <SkillCard key={def.key} def={def} suites={suites} isMobile={isMobile} busy={busy}
          onUpsert={(patch) => upsert(def.key, patch)} onRun={(sid) => runNow(def.key, sid)} onBacktest={(sid, d, f) => backtest(def.key, sid, d, f)} />
      ))}

      <h3 style={{ fontSize: 14, fontWeight: 700, margin: '20px 0 2px' }}>Run log</h3>
      <p style={small}>Newest first. Expand a run to read the full review and grade it — the grades + notes are the skill’s track record (and tomorrow’s playbook material).</p>
      {runs.length === 0 && <p style={small}>No runs yet. Activate a skill, hit “Run now”, or backtest a finished event.</p>}
      {runs.map((r) => <RunRow key={r.id} run={r} suiteName={suiteName} onGrade={grade} />)}
    </div>
  );
}

function SkillCard({ def, suites, isMobile, busy, onUpsert, onRun, onBacktest }) {
  const [adding, setAdding] = useState('');
  const watched = new Set(def.instances.map((i) => i.suiteId));
  const free = suites.filter((s) => !watched.has(s.id));
  return (
    <div style={card}>
      <div style={{ fontSize: 15, fontWeight: 800 }}>{def.emoji} {def.name}</div>
      <p style={{ ...small, marginTop: 4 }}>{def.blurb}</p>
      <details>
        <summary style={summaryStyle}>📖 Default playbook (platform-wide)</summary>
        <p style={{ ...small, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{def.defaultPlaybook}</p>
        <p style={small}>This ships with the skill and is refined via the AM workshop. Per-event additions below layer on top for this client only.</p>
      </details>

      {def.instances.map((inst) => (
        <Instance key={inst.id} inst={inst} suites={suites} busy={busy} onUpsert={onUpsert} onRun={onRun} onBacktest={onBacktest} />
      ))}

      {free.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <select style={{ ...input, width: isMobile ? '100%' : 260 }} value={adding} onChange={(e) => setAdding(e.target.value)}>
            <option value="">＋ Watch an event…</option>
            {free.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          {adding && <button style={primaryBtn} onClick={() => { onUpsert({ suiteId: adding }); setAdding(''); }}>Add (starts paused)</button>}
        </div>
      )}
    </div>
  );
}

function Instance({ inst, suites, busy, onUpsert, onRun, onBacktest }) {
  const [playbook, setPlaybook] = useState(inst.playbook || '');
  const [time, setTime] = useState(inst.timeOfDay || '06:30');
  const [days, setDays] = useState(40);
  const [freeze, setFreeze] = useState('');
  const [showBacktest, setShowBacktest] = useState(false);
  const active = inst.status === 'active';
  const running = busy === `${inst.key}:${inst.suiteId}:run`;
  const backtesting = busy === `${inst.key}:${inst.suiteId}:backtest`;
  const suiteName = (suites.find((s) => s.id === inst.suiteId) || {}).name || inst.suiteId;
  const dirty = playbook !== (inst.playbook || '') || time !== (inst.timeOfDay || '06:30');

  return (
    <div style={{ ...card, background: 'var(--elevated, transparent)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 700, fontSize: 13.5, flex: 1, minWidth: 140 }}>🗓 {suiteName}</div>
        <span style={active ? chip('#ecfdf5', '#047857') : chip('var(--hairline)', 'var(--muted)')}>{active ? 'active' : 'paused (shadow)'}</span>
        <span style={chip('var(--hairline)', 'var(--muted)')}>{inst.autonomy}</span>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <label style={{ ...small, margin: 0 }}>Daily at</label>
        <input type="time" style={{ ...input, width: 110 }} value={time} onChange={(e) => setTime(e.target.value)} />
        <button style={btn} disabled={busy === 'save'} onClick={() => onUpsert({ suiteId: inst.suiteId, status: active ? 'paused' : 'active', timeOfDay: time })}>
          {active ? '⏸ Pause' : '▶ Activate daily runs'}
        </button>
        <button style={{ ...primaryBtn, opacity: running ? 0.6 : 1 }} disabled={!!busy} onClick={() => onRun(inst.suiteId)}>
          {running ? 'Reviewing… (can take a minute)' : 'Run now'}
        </button>
        <button style={btn} disabled={!!busy} onClick={() => setShowBacktest((v) => !v)}>🧪 Backtest…</button>
      </div>

      {showBacktest && (
        <div style={{ ...card, marginTop: 10 }}>
          <p style={small}>Freeze this event at <b>N days before</b> it happened (or pick an exact date) and let the skill write the advice it <i>would</i> have given — it cannot read data past the freeze. Best on a <b>finished</b> event, so you can mark its homework.</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <label style={{ ...small, margin: 0 }}>Days before</label>
            <input type="number" min="1" style={{ ...input, width: 90 }} value={days} onChange={(e) => setDays(e.target.value)} />
            <label style={{ ...small, margin: 0 }}>or freeze date</label>
            <input type="date" style={{ ...input, width: 160 }} value={freeze} onChange={(e) => setFreeze(e.target.value)} />
            <button style={{ ...primaryBtn, opacity: backtesting ? 0.6 : 1 }} disabled={!!busy} onClick={() => onBacktest(inst.suiteId, days, freeze)}>
              {backtesting ? 'Backtesting… (can take a minute)' : 'Run backtest'}
            </button>
          </div>
        </div>
      )}

      <details style={{ marginTop: 8 }}>
        <summary style={summaryStyle}>✍️ Playbook additions for this client {inst.playbook ? '(set)' : '(inheriting default only)'}</summary>
        <p style={small}>House rules that refine the default playbook for this client — e.g. “Never discount VIP; bundle it.” Fold in what run feedback teaches you.</p>
        <textarea rows={4} style={{ ...input, resize: 'vertical' }} value={playbook} onChange={(e) => setPlaybook(e.target.value)} placeholder="One rule per line…" />
      </details>
      {dirty && <button style={{ ...primaryBtn, marginTop: 8 }} disabled={busy === 'save'} onClick={() => onUpsert({ suiteId: inst.suiteId, playbook, timeOfDay: time })}>Save changes</button>}
    </div>
  );
}

function RunRow({ run, suiteName, onGrade }) {
  const [note, setNote] = useState(run.feedback || '');
  const [m, bg, fg] = MODE[run.mode] || MODE.manual;
  const headline = (run.advice || '').split('\n').find((l) => l.trim()) || (run.status === 'error' ? `Failed: ${run.error}` : '(no output)');
  const when = (run.startedAt || '').slice(0, 16).replace('T', ' ');
  const toolNames = [...new Set((run.trail || []).map((t) => t.name))];
  return (
    <details style={{ ...card, padding: '10px 14px' }}>
      <summary style={{ ...summaryStyle, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={chip(bg, fg)}>{m}{run.mode === 'backtest' && run.freezeDate ? ` @ ${run.freezeDate}` : ''}</span>
        {run.status === 'error' && <span style={chip('#fef2f2', '#b91c1c')}>error</span>}
        {run.rating && <span>{run.rating === 'up' ? '👍' : '👎'}</span>}
        <span style={{ fontWeight: 400, fontSize: 12, color: 'var(--muted)' }}>{when}</span>
        <span style={{ flexBasis: '100%', fontWeight: 600, fontSize: 12.5 }}>{headline.replace(/^HEADLINE:\s*/i, '')}</span>
      </summary>
      <div style={{ marginTop: 8 }}>
        {run.status === 'error' ? <p style={{ ...small, color: '#b91c1c' }}>{run.error}</p> : renderAdvice(run.advice)}
        <p style={small}>Event: {suiteName(run.suiteId)}{toolNames.length ? ` · looked at: ${toolNames.join(', ')} (${(run.trail || []).length} calls)` : ''}{run.reviewedBy ? ` · graded by ${run.reviewedBy}` : ''}</p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 6 }}>
          <button style={{ ...btn, ...(run.rating === 'up' ? { background: '#ecfdf5', borderColor: '#047857' } : {}) }} onClick={() => onGrade(run.id, 'up', note)}>👍 Good call</button>
          <button style={{ ...btn, ...(run.rating === 'down' ? { background: '#fef2f2', borderColor: '#b91c1c' } : {}) }} onClick={() => onGrade(run.id, 'down', note)}>👎 Off the mark</button>
          <input style={{ ...input, flex: 1, minWidth: 180 }} placeholder="What did it get right / wrong? (feeds the playbook)" value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => run.rating && note !== (run.feedback || '') && onGrade(run.id, run.rating, note)} />
        </div>
      </div>
    </details>
  );
}
