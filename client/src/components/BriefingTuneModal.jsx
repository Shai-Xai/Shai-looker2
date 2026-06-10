import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../lib/api.js';
import AiMark from './AiMark.jsx';

// "Tune your briefing": the promoter-facing controls behind the home briefing.
// - Your focus: standing requests applied to every briefing for this reader.
// - Per event: dates (drive automatic phase detection), a manual phase
//   override (e.g. Artist Drops), event-specific instructions, and per-phase
//   wording overrides (defaults shown as placeholders).
export default function BriefingTuneModal({ entityId, onClose, onSaved }) {
  const [cfg, setCfg] = useState(null);
  const [tune, setTune] = useState('');
  const [suiteEdits, setSuiteEdits] = useState({}); // suiteId -> briefing cfg
  const [openSuite, setOpenSuite] = useState(null);
  const [openPhase, setOpenPhase] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.myBriefingConfig(entityId).then((r) => {
      setCfg(r);
      setTune(r.tune || '');
      setSuiteEdits(Object.fromEntries(r.suites.map((s) => [s.id, {
        launchDate: s.briefing.launchDate || '', eventStart: s.briefing.eventStart || '', eventEnd: s.briefing.eventEnd || '',
        manualPhase: s.briefing.manualPhase || 'auto', instructions: s.briefing.instructions || '',
        phaseOverrides: s.briefing.phaseOverrides || {},
      }])));
      if (r.suites.length === 1) setOpenSuite(r.suites[0].id);
    }).catch((e) => setError(e.message));
  }, [entityId]);

  async function saveAll() {
    setBusy(true); setError(null);
    try {
      await api.saveBriefingTune(tune, entityId);
      for (const su of cfg.suites) await api.saveSuiteBriefing(su.id, suiteEdits[su.id], entityId);
      onSaved?.();
      onClose();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  const upd = (sid, patch) => setSuiteEdits((p) => ({ ...p, [sid]: { ...p[sid], ...patch } }));
  const phaseLabel = (key) => cfg?.phases.find((p) => p.key === key)?.label || key;

  const node = (
    <div className="ai-overlay" style={overlay} onClick={onClose}>
      <div className="modal-in ai-glow" style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <AiMark size={24} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 800 }}>Tune your briefing</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>Teach the Owl what matters to you and where each event is in its lifecycle.</div>
          </div>
          <button onClick={onClose} aria-label="Close" style={closeBtn}>✕</button>
        </div>

        {error && <p style={{ color: 'var(--error)', fontSize: 13, margin: '8px 0' }}>⚠ {error}</p>}
        {!cfg ? (
          <p style={{ color: 'var(--muted)', fontSize: 13, padding: '14px 0' }}>Loading…</p>
        ) : (
          <div style={{ overflowY: 'auto', flex: 1, minHeight: 0, paddingRight: 2 }}>
            <Label>Your focus — applied to every briefing</Label>
            <textarea
              value={tune} onChange={(e) => setTune(e.target.value)} rows={3}
              placeholder={'e.g. Always mention resale activity. Compare everything to last year. I care most about cashless spend per head.'}
              style={ta}
            />

            {cfg.suites.map((su) => {
              const e = suiteEdits[su.id] || {};
              const open = openSuite === su.id;
              const auto = su.phase?.source !== 'manual' && su.phase?.key ? ` — currently ${phaseLabel(su.phase.key)}` : '';
              return (
                <div key={su.id} style={{ border: '1px solid var(--hairline)', borderRadius: 10, marginTop: 10, overflow: 'hidden' }}>
                  <button onClick={() => setOpenSuite(open ? null : su.id)} style={suiteHead}>
                    <span style={{ width: 12, fontSize: 9, color: 'var(--muted)', transform: open ? 'rotate(90deg)' : 'none' }}>▶</span>
                    <span style={{ flex: 1, textAlign: 'left' }}>{su.name}</span>
                    {su.phase?.key && <span style={phaseChip}>{phaseLabel(su.phase.key)}{su.phase.source === 'manual' ? ' (set manually)' : ''}</span>}
                  </button>
                  {open && (
                    <div style={{ padding: 12 }}>
                      <Label>Key dates — the phase follows these automatically</Label>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                        <DateField label="Tickets on sale" value={e.launchDate} onChange={(v) => upd(su.id, { launchDate: v })} />
                        <DateField label="Event start" value={e.eventStart} onChange={(v) => upd(su.id, { eventStart: v })} />
                        <DateField label="Event end" value={e.eventEnd} onChange={(v) => upd(su.id, { eventEnd: v })} />
                      </div>
                      <Label>Phase{auto}</Label>
                      <select value={e.manualPhase || 'auto'} onChange={(ev) => upd(su.id, { manualPhase: ev.target.value })} style={sel}>
                        <option value="auto">Automatic (from dates)</option>
                        {cfg.phases.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
                      </select>
                      <div style={{ fontSize: 11, color: 'var(--muted)', margin: '4px 0 10px' }}>Pick a phase manually for moments dates can't know — e.g. set Artist Drops during a lineup announcement, then back to Automatic.</div>
                      <Label>Instructions for this event — always applied</Label>
                      <textarea
                        value={e.instructions || ''} onChange={(ev) => upd(su.id, { instructions: ev.target.value })} rows={2}
                        placeholder={'e.g. This is our 5th edition — compare against Pretoria IV. VIP is the priority this year.'}
                        style={ta}
                      />
                      <Label>Phase wording for this event (leave blank to use the defaults)</Label>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 4 }}>
                        {cfg.phases.map((p) => {
                          const pOpen = openPhase === `${su.id}:${p.key}`;
                          const overridden = !!(e.phaseOverrides?.[p.key] || '').trim();
                          return (
                            <div key={p.key} style={{ border: '1px solid var(--hairline)', borderRadius: 8, overflow: 'hidden' }}>
                              <button onClick={() => setOpenPhase(pOpen ? null : `${su.id}:${p.key}`)} style={phaseRow}>
                                <span style={{ width: 11, fontSize: 8, color: 'var(--muted)', transform: pOpen ? 'rotate(90deg)' : 'none' }}>▶</span>
                                {p.label}
                                {overridden && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--brand)', marginLeft: 6 }}>customised</span>}
                              </button>
                              {pOpen && (
                                <div style={{ padding: 8 }}>
                                  <textarea
                                    value={e.phaseOverrides?.[p.key] || ''}
                                    onChange={(ev) => upd(su.id, { phaseOverrides: { ...e.phaseOverrides, [p.key]: ev.target.value } })}
                                    rows={3}
                                    placeholder={cfg.phaseDefaults?.[p.key] || ''}
                                    style={{ ...ta, fontSize: 12 }}
                                  />
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 12, flexShrink: 0 }}>
          <button style={ghost} onClick={onClose} disabled={busy}>Cancel</button>
          <button style={primary} onClick={saveAll} disabled={busy || !cfg}>{busy ? 'Saving…' : 'Save & regenerate'}</button>
        </div>
      </div>
    </div>
  );
  return createPortal(node, document.body);
}

function Label({ children }) {
  return <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--muted)', margin: '10px 0 4px' }}>{children}</div>;
}
function DateField({ label, value, onChange }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>
      {label}
      <input type="date" value={value || ''} onChange={(e) => onChange(e.target.value)} style={{ border: '1px solid var(--hairline)', borderRadius: 8, padding: '7px 9px', fontSize: 13, background: 'var(--card)', color: 'var(--text)', outline: 'none', fontFamily: 'inherit' }} />
    </label>
  );
}

const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 400, padding: 14 };
const panel = { width: 'min(640px, 96vw)', maxHeight: '90dvh', display: 'flex', flexDirection: 'column', background: 'var(--card)', borderRadius: 16, boxShadow: '0 18px 60px -12px rgba(0,0,0,0.4)', padding: 18 };
const closeBtn = { border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 17, color: 'var(--muted)' };
const ta = { width: '100%', boxSizing: 'border-box', padding: '9px 11px', border: '1.5px solid var(--hairline)', borderRadius: 9, fontSize: 13, outline: 'none', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5, background: 'var(--card)', color: 'var(--text)' };
const sel = { border: '1.5px solid var(--hairline)', borderRadius: 8, padding: '8px 10px', fontSize: 13, background: 'var(--card)', color: 'var(--text)', outline: 'none', fontFamily: 'inherit' };
const suiteHead = { width: '100%', display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', border: 'none', background: 'var(--elevated)', cursor: 'pointer', fontSize: 13.5, fontWeight: 700, color: 'var(--text)' };
const phaseChip = { fontSize: 10.5, fontWeight: 700, color: 'var(--ai, #7c3aed)', background: 'var(--ai-bg, rgba(124,58,237,0.10))', borderRadius: 980, padding: '3px 9px', flexShrink: 0 };
const phaseRow = { width: '100%', display: 'flex', alignItems: 'center', gap: 7, padding: '7px 10px', border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, color: 'var(--text)', textAlign: 'left' };
const ghost = { border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 980, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const primary = { border: 'none', background: 'var(--brand)', color: '#fff', borderRadius: 980, padding: '8px 18px', fontSize: 13, fontWeight: 700, cursor: 'pointer' };
