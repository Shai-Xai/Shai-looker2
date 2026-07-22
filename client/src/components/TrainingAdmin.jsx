import { useEffect, useState } from 'react';

// ─── Training — practical exams taken inside Pulse (Admin → 🎓 Training) ──────
// Two surfaces in one tab, both for Howler staff:
//   • My exams (top) — the TRAINEE view: your personal exam code, the task
//     checklist with live "Check my work" grading, and final submission.
//   • Manage (below) — the TRAINER view: build an exam from the task catalog,
//     point it at a sandbox client, assign trainees (each gets a code), and
//     watch the live results board. Grading is automatic — the server inspects
//     real system state for evidence of each task (server/training.js).

const input = { width: '100%', boxSizing: 'border-box', padding: '9px 11px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, outline: 'none', fontFamily: 'inherit', background: 'var(--card, #fff)', color: 'var(--text)' };
const btn = { padding: '8px 14px', borderRadius: 8, border: '1.5px solid var(--hairline)', background: 'transparent', color: 'var(--text)', fontSize: 12.5, cursor: 'pointer', minHeight: 40 };
const primaryBtn = { ...btn, background: 'var(--text)', color: 'var(--bg, #fff)', border: 0, fontWeight: 700 };
const card = { border: '1px solid var(--hairline)', borderRadius: 12, padding: 14, marginTop: 10 };
const small = { fontSize: 11.5, color: 'var(--muted)', margin: '2px 0 4px' };
const label = { display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--muted)', margin: '10px 0 4px' };
const chip = (bg, fg) => ({ display: 'inline-block', padding: '2px 9px', borderRadius: 999, fontSize: 11, fontWeight: 700, background: bg, color: fg });

const STATUS_CHIP = {
  assigned: ['Not started', '#f1f5f9', '#475569'],
  in_progress: ['In progress', '#fff7ed', '#c2410c'],
  passed: ['PASSED', '#ecfdf5', '#047857'],
  failed: ['Not passed', '#fef2f2', '#b91c1c'],
};

async function j(url, opts) {
  const r = await fetch(url, opts ? { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined } : undefined);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

function ProgressBar({ pct }) {
  return (
    <div style={{ height: 8, borderRadius: 999, background: 'var(--hairline)', overflow: 'hidden' }}>
      <div style={{ width: `${Math.max(0, Math.min(100, pct))}%`, height: '100%', borderRadius: 999, background: pct >= 100 ? '#059669' : 'var(--brand, #6d5df6)', transition: 'width .4s' }} />
    </div>
  );
}

function TaskRow({ t }) {
  return (
    <div style={{ display: 'flex', gap: 10, padding: '10px 0', borderTop: '1px solid var(--hairline)', alignItems: 'flex-start' }}>
      <span style={{ fontSize: 18, lineHeight: '22px' }}>{t.done ? '✅' : t.emoji}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 13 }}>
          {t.title} <span style={{ fontWeight: 400, color: 'var(--muted)' }}>· {t.area} · {t.points} pts</span>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text)', opacity: 0.85, marginTop: 2, lineHeight: 1.45 }}>{t.brief}</div>
        {t.evidence && <div style={{ fontSize: 12, marginTop: 4, color: t.done ? '#047857' : '#c2410c' }}>{t.done ? '✓ ' : '⚠ '}{t.evidence}</div>}
      </div>
    </div>
  );
}

// ── Trainee view: one attempt card ────────────────────────────────────────────
function AttemptCard({ a, onChanged }) {
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const act = async (what) => {
    setBusy(what); setErr('');
    try { await j(`/api/training/my/${a.id}/${what}`, { method: 'POST', body: {} }); onChanged(); }
    catch (e) { setErr(e.message); }
    setBusy('');
  };
  const [txt, bg, fg] = STATUS_CHIP[a.status] || STATUS_CHIP.assigned;
  const submitted = a.status === 'passed' || a.status === 'failed';
  return (
    <div style={card}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <strong style={{ fontSize: 14, flex: 1, minWidth: 160 }}>{a.exam.title}</strong>
        <span style={chip(bg, fg)}>{txt}</span>
      </div>
      <div style={small}>Sandbox client: <strong>{a.exam.entityName}</strong> · pass mark {a.exam.passPct}%{a.exam.timeLimitMin ? ` · time limit ${a.exam.timeLimitMin} min` : ''}</div>
      {a.exam.notes && <div style={{ fontSize: 12.5, margin: '6px 0', padding: 10, borderRadius: 8, background: 'var(--hairline)', lineHeight: 1.5 }}>{a.exam.notes}</div>}
      <div style={{ margin: '10px 0', padding: 12, borderRadius: 10, border: '1.5px dashed var(--brand, #6d5df6)', textAlign: 'center' }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--muted)' }}>Your exam code — put it in the NAME of everything you create</div>
        <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: 2, marginTop: 4, userSelect: 'all' }}>{a.code}</div>
      </div>
      {a.status !== 'assigned' && (
        <div style={{ margin: '8px 0' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
            <span>{submitted ? `Final score: ${a.scorePct}%` : `Progress: ${a.progressPct}%`}</span>
            {a.deadline && !submitted && <span style={{ color: a.late ? '#b91c1c' : 'var(--muted)' }}>{a.late ? 'Past the time limit' : `Due ${new Date(a.deadline).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}</span>}
          </div>
          <ProgressBar pct={submitted ? a.scorePct : a.progressPct} />
        </div>
      )}
      <div style={{ marginTop: 6 }}>{a.tasks.map((t) => <TaskRow key={t.key} t={t} />)}</div>
      {err && <div style={{ color: '#b91c1c', fontSize: 12.5, marginTop: 8 }}>{err}</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        {a.status === 'assigned' && <button style={primaryBtn} disabled={!!busy} onClick={() => act('start')}>{busy === 'start' ? 'Starting…' : 'Start the exam'}</button>}
        {a.status === 'in_progress' && <>
          <button style={btn} disabled={!!busy} onClick={() => act('check')}>{busy === 'check' ? 'Checking…' : '🔍 Check my work'}</button>
          <button style={primaryBtn} disabled={!!busy} onClick={() => { if (window.confirm('Submit and lock in your score? You cannot change anything after this.')) act('submit'); }}>{busy === 'submit' ? 'Submitting…' : 'Submit final answers'}</button>
        </>}
        {submitted && <div style={{ fontSize: 13, fontWeight: 700 }}>{a.status === 'passed' ? `🎉 Passed with ${a.scorePct}%` : `Scored ${a.scorePct}% — pass mark is ${a.exam.passPct}%. Chat to your trainer about a retake.`}</div>}
      </div>
    </div>
  );
}

// ── Trainer: create-exam form ─────────────────────────────────────────────────
function ExamForm({ catalog, entities, onCreated }) {
  const [title, setTitle] = useState('');
  const [entityId, setEntityId] = useState('');
  const [keys, setKeys] = useState(catalog.map((t) => t.key));
  const [passPct, setPassPct] = useState(70);
  const [timeLimitMin, setTimeLimitMin] = useState(0);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const toggle = (k) => setKeys((ks) => (ks.includes(k) ? ks.filter((x) => x !== k) : [...ks, k]));
  const create = async () => {
    setBusy(true); setErr('');
    try {
      await j('/api/admin/training/exams', { method: 'POST', body: { title, entityId, taskKeys: keys, passPct: +passPct, timeLimitMin: +timeLimitMin, notes } });
      setTitle(''); setNotes(''); onCreated();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <div style={card}>
      <strong style={{ fontSize: 13 }}>New practical exam</strong>
      <span style={label}>Exam title</span>
      <input style={input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Sales & CS practical — July intake" />
      <span style={label}>Sandbox client (trainees work inside this client — use a test client, not a live one)</span>
      <select style={input} value={entityId} onChange={(e) => setEntityId(e.target.value)}>
        <option value="">Pick a client…</option>
        {entities.map((en) => <option key={en.id} value={en.id}>{en.name}</option>)}
      </select>
      <span style={label}>Tasks ({keys.length} selected)</span>
      <div>
        {catalog.map((t) => (
          <label key={t.key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '7px 0', cursor: 'pointer', borderTop: '1px solid var(--hairline)' }}>
            <input type="checkbox" checked={keys.includes(t.key)} onChange={() => toggle(t.key)} style={{ marginTop: 3, width: 16, height: 16 }} />
            <span style={{ fontSize: 12.5 }}><strong>{t.emoji} {t.title}</strong> <span style={{ color: 'var(--muted)' }}>· {t.area} · {t.points} pts</span><br /><span style={{ color: 'var(--muted)' }}>{t.brief.replaceAll('{CODE}', 'PX-····').replaceAll('{code}', 'px-····')}</span></span>
          </label>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 130 }}><span style={label}>Pass mark %</span><input style={input} type="number" min="1" max="100" value={passPct} onChange={(e) => setPassPct(e.target.value)} /></div>
        <div style={{ flex: 1, minWidth: 130 }}><span style={label}>Time limit (min, 0 = none)</span><input style={input} type="number" min="0" value={timeLimitMin} onChange={(e) => setTimeLimitMin(e.target.value)} /></div>
      </div>
      <span style={label}>Briefing shown to trainees</span>
      <textarea style={{ ...input, minHeight: 70 }} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Work ONLY inside the sandbox client. Name everything you create with your exam code. Do not send anything." />
      {err && <div style={{ color: '#b91c1c', fontSize: 12.5, marginTop: 8 }}>{err}</div>}
      <button style={{ ...primaryBtn, marginTop: 10 }} disabled={busy || !title || !entityId || !keys.length} onClick={create}>{busy ? 'Creating…' : 'Create exam'}</button>
    </div>
  );
}

// ── Trainer: one exam's management + results board ────────────────────────────
function ExamCard({ exam, onChanged }) {
  const [results, setResults] = useState(null);
  const [names, setNames] = useState(''); // "Name <email>" or "email" per line
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);

  const loadResults = () => j(`/api/admin/training/exams/${exam.id}/results`).then(setResults).catch((e) => setErr(e.message));
  useEffect(() => { if (open) loadResults(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const addTrainees = async () => {
    const trainees = names.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const m = /^(.*?)[\s<]*([^\s<>]+@[^\s<>]+)>?$/.exec(l);
      return m ? { name: m[1].trim().replace(/[<,]$/, ''), email: m[2] } : null;
    }).filter(Boolean);
    if (!trainees.length) { setErr('Add one trainee per line: Name email@howler.co.za'); return; }
    setBusy('add'); setErr('');
    try { await j(`/api/admin/training/exams/${exam.id}/attempts`, { method: 'POST', body: { trainees } }); setNames(''); loadResults(); onChanged(); }
    catch (e) { setErr(e.message); }
    setBusy('');
  };
  const setStatus = async (status) => {
    setBusy('status');
    try { await j(`/api/admin/training/exams/${exam.id}`, { method: 'PUT', body: { status } }); onChanged(); } catch (e) { setErr(e.message); }
    setBusy('');
  };
  const removeExam = async () => {
    if (!window.confirm(`Delete "${exam.title}" and all its attempts?`)) return;
    try { await j(`/api/admin/training/exams/${exam.id}`, { method: 'DELETE' }); onChanged(); } catch (e) { setErr(e.message); }
  };
  const removeAttempt = async (id) => {
    if (!window.confirm('Remove this trainee attempt?')) return;
    try { await j(`/api/admin/training/attempts/${id}`, { method: 'DELETE' }); loadResults(); onChanged(); } catch (e) { setErr(e.message); }
  };

  const byId = Object.fromEntries(((results && results.trainees) || []).map((t) => [t.id, t]));
  return (
    <div style={card}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <strong style={{ flex: 1, minWidth: 160, fontSize: 13.5 }}>{exam.title}</strong>
        <span style={chip(exam.status === 'open' ? '#ecfdf5' : '#f1f5f9', exam.status === 'open' ? '#047857' : '#475569')}>{exam.status}</span>
        <button style={btn} onClick={() => setOpen(!open)}>{open ? 'Hide' : `Manage · ${exam.attempts} trainee(s)`}</button>
      </div>
      <div style={small}>Sandbox: <strong>{exam.entityName}</strong> · {exam.taskKeys.length} tasks · pass {exam.passPct}%{exam.timeLimitMin ? ` · ${exam.timeLimitMin} min` : ''}</div>
      {open && (
        <div>
          <span style={label}>Add trainees (one per line — Name email@howler.co.za)</span>
          <textarea style={{ ...input, minHeight: 60 }} value={names} onChange={(e) => setNames(e.target.value)} placeholder={'Thandi M thandi@howler.co.za\nsipho@howler.co.za'} />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            <button style={primaryBtn} disabled={busy === 'add'} onClick={addTrainees}>{busy === 'add' ? 'Adding…' : 'Add trainees'}</button>
            <button style={btn} disabled={busy === 'status'} onClick={() => setStatus(exam.status === 'open' ? 'closed' : 'open')}>{exam.status === 'open' ? 'Close exam' : 'Reopen exam'}</button>
            <button style={btn} onClick={loadResults}>↻ Refresh results</button>
            <button style={{ ...btn, color: '#b91c1c' }} onClick={removeExam}>Delete</button>
          </div>
          {err && <div style={{ color: '#b91c1c', fontSize: 12.5, marginTop: 8 }}>{err}</div>}
          {results && results.attempts.map((a) => {
            const t = byId[a.id] || {};
            const [txt, bg, fg] = STATUS_CHIP[a.status] || STATUS_CHIP.assigned;
            const submitted = a.status === 'passed' || a.status === 'failed';
            return (
              <div key={a.id} style={{ ...card, padding: 12 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                  <strong style={{ fontSize: 13, flex: 1, minWidth: 140 }}>{t.name || t.email}</strong>
                  <code style={{ fontSize: 12, fontWeight: 700 }}>{a.code}</code>
                  <span style={chip(bg, fg)}>{txt}{submitted ? ` · ${a.scorePct}%` : ''}</span>
                  <button style={{ ...btn, minHeight: 30, padding: '3px 9px' }} onClick={() => removeAttempt(a.id)}>✕</button>
                </div>
                <div style={{ ...small, marginBottom: 6 }}>{t.email}{a.late ? ' · ⏰ past time limit' : ''}</div>
                <ProgressBar pct={submitted ? a.scorePct : a.progressPct} />
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                  {a.tasks.map((tk) => (
                    <span key={tk.key} title={`${tk.title}${tk.evidence ? ` — ${tk.evidence}` : ''}`} style={chip(tk.done ? '#ecfdf5' : '#f1f5f9', tk.done ? '#047857' : '#94a3b8')}>{tk.done ? '✓' : '·'} {tk.emoji} {tk.title}</span>
                  ))}
                </div>
              </div>
            );
          })}
          {results && !results.attempts.length && <div style={{ ...small, marginTop: 10 }}>No trainees yet — add them above; each gets a personal exam code to hand out.</div>}
        </div>
      )}
    </div>
  );
}

export default function TrainingAdmin() {
  const [mine, setMine] = useState([]);
  const [exams, setExams] = useState([]);
  const [catalog, setCatalog] = useState([]);
  const [entities, setEntities] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [err, setErr] = useState('');

  const load = () => {
    j('/api/training/my').then((d) => setMine(d.attempts || [])).catch(() => {});
    j('/api/admin/training/exams').then((d) => setExams(d.exams || [])).catch((e) => setErr(e.message));
    j('/api/admin/training/catalog').then((d) => setCatalog(d.tasks || [])).catch(() => {});
    j('/api/admin/entities').then((d) => setEntities(Array.isArray(d) ? d : d.entities || [])).catch(() => {});
  };
  useEffect(load, []);

  return (
    <div style={{ maxWidth: 760 }}>
      <h2 style={{ margin: '4px 0 2px', fontSize: 18 }}>🎓 Training</h2>
      <p style={small}>Practical exams taken inside Pulse. Trainees do the real work — build segments, campaigns, goals, dashboards — in a sandbox client, and the system grades itself by checking what actually got created.</p>
      {err && <div style={{ color: '#b91c1c', fontSize: 12.5 }}>{err}</div>}

      {mine.length > 0 && (
        <section style={{ marginTop: 14 }}>
          <h3 style={{ margin: 0, fontSize: 14 }}>My exams</h3>
          {mine.map((a) => <AttemptCard key={a.id} a={a} onChanged={load} />)}
        </section>
      )}

      <section style={{ marginTop: 22 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h3 style={{ margin: 0, fontSize: 14, flex: 1 }}>Manage exams</h3>
          <button style={showForm ? btn : primaryBtn} onClick={() => setShowForm(!showForm)}>{showForm ? 'Cancel' : '＋ New exam'}</button>
        </div>
        {showForm && catalog.length > 0 && <ExamForm catalog={catalog} entities={entities} onCreated={() => { setShowForm(false); load(); }} />}
        {exams.map((e) => <ExamCard key={e.id} exam={e} onChanged={load} />)}
        {!exams.length && !showForm && <div style={{ ...small, marginTop: 10 }}>No exams yet. Create one, pick a sandbox client, choose the tasks, then add your trainees.</div>}
      </section>
    </div>
  );
}
