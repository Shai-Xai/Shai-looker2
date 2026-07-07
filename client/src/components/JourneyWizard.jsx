import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';
import JourneyTree, { countDecisions } from './JourneyTree.jsx';

// Engage → Journeys. Journeys are built by talking to THE Owl (the floating owl
// button) — its draftJourney tool authors the branching tree in chat. This page
// is the other half of that conversation:
//   1. LIVE CANVAS — while the Owl drafts/refines a journey in the drawer, the
//      chat card broadcasts it (howler:journey-draft) and the tree renders
//      full-size here, updating as you talk.
//   2. DRAFTS LIBRARY — every created journey (a draft sequence campaign whose
//      config carries the full tree) lists here: preview the tree, duplicate,
//      or edit/approve in Campaigns.
// Starter recipes remain as previewable suggestions.

const EXAMPLE_ASKS = [
  'Build an abandoned-cart journey — email right away, and if they don’t open within 2 days, send an SMS.',
  'Win back people who haven’t bought in a while; if they open but don’t buy, follow up with a different email.',
  'Send a journey to my Spanish customers about the early-bird tickets.',
];

const fmtDate = (iso) => { try { return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); } catch { return ''; } };

export default function JourneyWizard({ entityId }) {
  const [recipes, setRecipes] = useState([]);
  const [preview, setPreview] = useState(null); // recipe being previewed
  const [live, setLive] = useState(null); // the journey the Owl is building right now
  const [liveState, setLiveState] = useState(''); // '' | busy | done | error
  const [liveErr, setLiveErr] = useState('');
  const [drafts, setDrafts] = useState([]);
  const [openDraft, setOpenDraft] = useState(null); // draft id with the tree expanded
  const [stats, setStats] = useState({}); // draft id -> live funnel stats

  const loadStats = (id) => api.journeyStats(entityId, id).then((s) => setStats((m) => ({ ...m, [id]: s }))).catch(() => {});
  const toggleDraft = (a, open) => { setOpenDraft(open ? null : a.id); if (!open) loadStats(a.id); };

  const loadDrafts = () => api.listActions(entityId)
    .then((r) => setDrafts((r.actions || []).filter((a) => a.config?.journey?.nodes?.length)))
    .catch(() => setDrafts([]));
  useEffect(() => { api.journeyRecipes(entityId).then((r) => setRecipes(r.recipes || [])).catch(() => setRecipes([])); loadDrafts(); }, [entityId]); // eslint-disable-line react-hooks/exhaustive-deps

  // The Owl's chat card broadcasts every journey draft/update — render it live
  // here. Arriving late (chat happened on another screen) we ASK for a rebroadcast;
  // and when the user confirms in CHAT, the created event refreshes our list too.
  useEffect(() => {
    const h = (e) => { if (e.detail?.nodes) { setLive(e.detail); setLiveState(''); setLiveErr(''); } };
    const created = () => { setLiveState('done'); loadDrafts(); };
    window.addEventListener('howler:journey-draft', h);
    window.addEventListener('howler:journey-created', created);
    try { window.dispatchEvent(new Event('howler:journey-request')); } catch { /* ignore */ }
    return () => { window.removeEventListener('howler:journey-draft', h); window.removeEventListener('howler:journey-created', created); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openOwl = () => { try { window.dispatchEvent(new Event('howler:open-analyst')); } catch { /* ignore */ } };

  const createLive = async () => {
    if (!live) return;
    setLiveState('busy'); setLiveErr('');
    try {
      await api.owlDraftJourney({ entityId: live.entityId || entityId, name: live.name, goal: live.goal, summary: live.summary, nodes: live.nodes, audience: live.audience, audienceName: live.audienceName, master: live.master || undefined });
      setLiveState('done'); loadDrafts();
    } catch (e) { setLiveState('error'); setLiveErr((e && e.message) || 'Could not create the draft.'); }
  };
  const duplicate = async (a) => { try { await api.duplicateAction(entityId, a.id); loadDrafts(); } catch { /* list unchanged */ } };

  const liveDecisions = live ? countDecisions(live.nodes) : 0;

  return (
    <div>
      {/* Front door / live canvas header */}
      {!live ? (
        <div style={{ maxWidth: 720, padding: 18, border: '1px solid var(--hairline)', borderRadius: 14, background: 'var(--card)' }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>🦉 Build a journey with the Owl</div>
          <p style={{ fontSize: 13.5, lineHeight: 1.5, color: 'var(--muted)', margin: '0 0 12px' }}>
            Open the Owl and tell it what you want — as it drafts and refines the journey, the tree builds <strong style={{ color: 'var(--text)' }}>live on this page</strong>. When you're happy, create it as a draft; it appears below and in Campaigns for review and approval.
          </p>
          <button onClick={openOwl} style={primaryBtn}>Ask the Owl</button>
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)' }}>Try saying</div>
            {EXAMPLE_ASKS.map((t, i) => <div key={i} style={{ fontSize: 12.5, color: 'var(--muted)', fontStyle: 'italic' }}>“{t}”</div>)}
          </div>
        </div>
      ) : (
        <div>
          <div style={{ maxWidth: 860, display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--brand)' }}>● Live — the Owl is building</span>
            <h2 style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-0.02em', margin: 0 }}>{live.name}</h2>
            {liveDecisions > 0 && <span style={{ fontSize: 12, color: '#b45309', fontWeight: 700 }}>◆ {liveDecisions} decision{liveDecisions === 1 ? '' : 's'}</span>}
            <button onClick={openOwl} style={{ ...linkBtn }}>Open the Owl ↗</button>
          </div>
          {live.audienceName && (
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>
              → “{live.audienceName}”{live.reach ? ` · ${live.reach.total} people${live.reach.email != null ? ` · ${live.reach.email} emailable` : ''}${live.reach.sms ? ` · ${live.reach.sms} SMS` : ''}` : ''}
            </div>
          )}
          {live.summary && <p style={{ maxWidth: 860, fontSize: 13.5, lineHeight: 1.5, color: 'var(--muted)', margin: '4px 0 0' }}>{live.summary}</p>}
          <JourneyTree nodes={live.nodes} />
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
            {liveState === 'done' ? (
              <span style={{ fontSize: 13, color: 'var(--brand)', fontWeight: 700 }}>✓ Draft created — it's in the list below and in <a href="/engage/campaigns" style={{ color: 'var(--brand)' }}>Campaigns</a>.</span>
            ) : (
              <>
                <button onClick={createLive} disabled={liveState === 'busy'} style={{ ...primaryBtn, opacity: liveState === 'busy' ? 0.6 : 1 }}>{liveState === 'busy' ? 'Creating…' : 'Create draft journey'}</button>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>Keep talking to the Owl to change anything — the tree updates here.</span>
                {liveState === 'error' && <span style={{ fontSize: 12.5, color: 'var(--error, #d33)' }}>{liveErr}</span>}
              </>
            )}
          </div>
        </div>
      )}

      {/* Drafts library */}
      {drafts.length > 0 && (
        <div style={{ marginTop: 26 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Your journeys</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 860 }}>
            {drafts.map((a) => {
              const j = a.config.journey;
              const d = countDecisions(j.nodes);
              const open = openDraft === a.id;
              return (
                <div key={a.id} style={{ border: '1px solid var(--hairline)', borderRadius: 12, background: 'var(--card)', padding: '12px 14px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <button onClick={() => toggleDraft(a, open)} style={{ ...linkBtn, fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{open ? '▾' : '▸'} {a.title || j.name}</button>
                    <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', borderRadius: 980, padding: '2px 8px', background: a.status === 'draft' ? 'rgba(128,128,128,0.14)' : 'rgba(124,58,237,0.12)', color: a.status === 'draft' ? 'var(--muted)' : 'var(--brand)' }}>{a.status}</span>
                    {d > 0 && <span style={{ fontSize: 11.5, color: '#b45309', fontWeight: 700 }}>◆ {d}</span>}
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>{fmtDate(a.updatedAt || a.createdAt)}</span>
                    <span style={{ flex: 1 }} />
                    <button onClick={() => toggleDraft(a, open)} style={{ ...smallBtn, ...(open ? { background: 'var(--brand)', color: '#fff', borderColor: 'var(--brand)' } : {}) }}>{open ? 'Hide tree' : '🧭 View tree'}</button>
                    <button onClick={() => duplicate(a)} style={smallBtn}>Duplicate</button>
                    <a href={`/engage/campaigns?action=${a.id}`} style={{ ...smallBtn, textDecoration: 'none', display: 'inline-block' }}>Edit in Campaigns</a>
                  </div>
                  {j.summary && !open && <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>{j.summary}</div>}
                  {open && (() => {
                    const s = stats[a.id];
                    const t = s?.totals || {};
                    return (
                      <div style={{ marginTop: 8 }}>
                        {j.summary && <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 4px' }}>{j.summary}</p>}
                        {t.enrolled > 0 && (
                          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', fontSize: 12.5, fontWeight: 600, margin: '2px 0 6px' }}>
                            <span>👥 {t.enrolled} enrolled</span>
                            <span>▶ {t.active || 0} in the journey</span>
                            <span style={{ color: 'var(--brand)' }}>✓ {t.converted || 0} converted</span>
                            <span style={{ color: 'var(--muted)' }}>{t.done || 0} finished{t.unsubscribed ? ` · ${t.unsubscribed} unsubscribed` : ''}</span>
                            <button onClick={() => loadStats(a.id)} style={{ ...linkBtn }}>↻ refresh</button>
                          </div>
                        )}
                        <JourneyTree nodes={(s?.nodes) || j.nodes} stats={s} />
                      </div>
                    );
                  })()}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Starter recipes */}
      {recipes.length > 0 && (
        <div style={{ marginTop: 26 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Starter journeys — tap to preview</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {recipes.map((r) => {
              const on = preview?.key === r.key;
              return (
                <button key={r.key} onClick={() => setPreview(on ? null : r)} style={{ fontSize: 12.5, fontWeight: on ? 700 : 600, color: on ? '#fff' : 'var(--text)', background: on ? 'var(--brand)' : 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 980, padding: '7px 13px', cursor: 'pointer' }}>
                  {r.label}{countDecisions(r.nodes) > 0 ? ' ◆' : ''}
                </button>
              );
            })}
          </div>
          {preview && (
            <div style={{ marginTop: 14 }}>
              <p style={{ maxWidth: 720, fontSize: 13.5, lineHeight: 1.5, color: 'var(--muted)', margin: '0 0 4px' }}>{preview.summary}</p>
              <JourneyTree nodes={preview.nodes} />
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
                <button onClick={openOwl} style={primaryBtn}>Build this with the Owl</button>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>Ask it for “{preview.label.toLowerCase()}” and tweak anything — audience, timing, copy, branches.</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const primaryBtn = { minHeight: 40, padding: '9px 16px', border: 'none', borderRadius: 10, background: 'var(--brand)', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' };
const linkBtn = { border: 'none', background: 'none', color: 'var(--brand)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', padding: 0 };
const smallBtn = { minHeight: 32, padding: '5px 11px', border: '1px solid var(--hairline)', borderRadius: 9, background: 'var(--bg)', color: 'var(--text)', fontWeight: 600, fontSize: 12.5, cursor: 'pointer' };
