import { useState, useEffect } from 'react';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';

// Archive of past digests with feedback. Reading back and reacting (👍/👎 + a
// comment) feeds the per-client "digest preferences" the Owl learns from. You can
// edit your own comments (admins can edit any) — edits re-feed the loop.
// `compact` = the home-page placement: hidden when empty, collapsed by default.
export default function DigestHistory({ entityId, compact = false }) {
  const { user, isAdmin } = useAuth();
  const myEmail = (user?.email || '').toLowerCase();
  const [list, setList] = useState(null);
  const [collapsed, setCollapsed] = useState(true); // collapsed by default in both placements
  const [openId, setOpenId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [comment, setComment] = useState('');
  const [sent, setSent] = useState('');
  const [busy, setBusy] = useState(false);
  const [editId, setEditId] = useState(null);   // feedback id being edited
  const [editText, setEditText] = useState('');

  useEffect(() => { setList(null); if (!entityId) { setList([]); return; } api.myDigests(entityId).then((r) => setList(r.digests || [])).catch(() => setList([])); }, [entityId]);

  const loadDetail = (id) => api.myDigest(entityId, id).then(setDetail).catch(() => setDetail({ error: true }));
  const open = (d) => {
    if (openId === d.id) { setOpenId(null); return; }
    setOpenId(d.id); setDetail(null); setComment(''); setSent(''); setEditId(null);
    loadDetail(d.id);
  };
  const react = async (kind) => {
    if (!openId || busy) return;
    setBusy(true);
    try { await api.myDigestFeedback(entityId, openId, { kind, comment: kind === 'comment' ? comment : '' }); setSent(kind === 'comment' ? 'comment' : kind); if (kind === 'comment') setComment(''); await loadDetail(openId); }
    catch { /* ignore */ } finally { setBusy(false); }
  };
  const saveEdit = async (fbId) => {
    setBusy(true);
    try { await api.editDigestFeedback(entityId, openId, fbId, editText); setEditId(null); await loadDetail(openId); }
    catch { /* ignore */ } finally { setBusy(false); }
  };
  const when = (iso) => { try { return new Date(iso).toLocaleString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };

  if (list === null) return null;
  if (compact && list.length === 0) return null; // keep the home page tidy

  return (
    <div style={{ marginTop: compact ? 18 : 30 }}>
      <button type="button" onClick={() => setCollapsed((c) => !c)} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer', font: 'inherit', textAlign: 'left' }}>
        <span style={{ width: 12, fontSize: 10, color: 'var(--muted)', transform: collapsed ? 'none' : 'rotate(90deg)', transition: 'transform .15s' }}>▶</span>
        <span style={{ fontSize: compact ? 14 : 16, fontWeight: 700 }}>📨 Recent digests{list.length ? ` (${list.length})` : ''}</span>
      </button>
      {!compact && !collapsed && <p style={{ color: 'var(--muted)', fontSize: 13, margin: '4px 0 12px' }}>Look back at what was sent — tell the Owl what you liked or want changed, and future digests adapt.</p>}
      {!collapsed && (
        list.length === 0 ? (
          <p style={{ color: 'var(--muted)', fontSize: 13, marginTop: 10 }}>No digests sent yet — they’ll appear here once your schedule runs (or you send a test).</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: compact ? 10 : 0 }}>
            {(compact ? list.slice(0, 5) : list).map((d) => (
              <div key={d.id} style={{ border: '1px solid var(--hairline)', borderRadius: 12, background: 'var(--card)', overflow: 'hidden' }}>
                <button type="button" onClick={() => open(d)} style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 10, padding: '11px 14px', background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', font: 'inherit', color: 'var(--text)' }}>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontWeight: 600, fontSize: 13.5, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{(d.headline || d.subject || 'Digest').replace(/\*\*/g, '')}</span>
                    <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{d.role ? `${d.role} · ` : ''}{when(d.createdAt)}</span>
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--muted)', flexShrink: 0 }}>{openId === d.id ? '▲' : '▼'}</span>
                </button>
                {openId === d.id && (
                  <div style={{ borderTop: '1px solid var(--hairline)', padding: '14px 16px' }}>
                    {!detail ? <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p>
                      : detail.error ? <p style={{ color: 'var(--error,#ef4444)', fontSize: 13 }}>Couldn’t load this digest.</p>
                        : <DigestBody content={detail.content || {}} />}
                    {/* Existing feedback — your own comments are editable (admins: any). */}
                    {detail && (detail.feedback || []).length > 0 && (
                      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {detail.feedback.map((f) => {
                          const mine = (f.email || '') === myEmail;
                          const editable = f.kind === 'comment' && (mine || isAdmin);
                          return (
                            <div key={f.id} style={{ fontSize: 12.5, color: 'var(--muted)', display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                              <span style={{ flexShrink: 0 }}>{f.kind === 'up' ? '👍' : f.kind === 'down' ? '👎' : '💬'}</span>
                              {editId === f.id ? (
                                <span style={{ flex: 1 }}>
                                  <textarea value={editText} onChange={(e) => setEditText(e.target.value)} rows={2} style={{ width: '100%', boxSizing: 'border-box', padding: '6px 9px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 12.5, fontFamily: 'inherit' }} />
                                  <span style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                                    <button type="button" style={linkBtn('var(--brand)')} disabled={busy} onClick={() => saveEdit(f.id)}>Save</button>
                                    <button type="button" style={linkBtn('var(--muted)')} onClick={() => setEditId(null)}>Cancel</button>
                                  </span>
                                </span>
                              ) : (
                                <span style={{ flex: 1 }}>
                                  {f.comment || (f.kind === 'up' ? '(liked)' : f.kind === 'down' ? '(marked off)' : '')}
                                  {f.email ? <span style={{ opacity: 0.7 }}> — {mine ? 'you' : f.email}</span> : ''}
                                  {editable && <button type="button" style={{ ...linkBtn('var(--brand)'), marginLeft: 8 }} onClick={() => { setEditId(f.id); setEditText(f.comment || ''); }}>✎ Edit</button>}
                                </span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {/* New feedback */}
                    <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px dashed var(--hairline)' }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 8 }}>How was this digest?</div>
                      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                        <button type="button" style={fbBtn(sent === 'up')} disabled={busy} onClick={() => react('up')}>👍 Useful</button>
                        <button type="button" style={fbBtn(sent === 'down')} disabled={busy} onClick={() => react('down')}>👎 Off</button>
                      </div>
                      <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} placeholder="What did you like, or what should change? (the Owl learns from this)" style={{ width: '100%', boxSizing: 'border-box', padding: '9px 11px', border: '1.5px solid var(--hairline)', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', resize: 'vertical' }} />
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                        <button type="button" style={{ ...fbBtn(false), background: 'var(--brand)', color: '#fff', borderColor: 'var(--brand)' }} disabled={busy || !comment.trim()} onClick={() => react('comment')}>Send feedback</button>
                        {sent && <span style={{ fontSize: 12.5, color: 'var(--success,#10b981)' }}>Thanks — the Owl will learn from it.</span>}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )
      )}
    </div>
  );
}

function DigestBody({ content }) {
  return (
    <div>
      {content.headline && <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 8, lineHeight: 1.35 }}>{content.headline.replace(/\*\*/g, '')}</div>}
      {(content.kpis || []).length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
          {content.kpis.map((k, i) => (
            <div key={i} style={{ background: 'rgba(128,128,128,0.08)', border: '1px solid var(--hairline)', borderRadius: 10, padding: '8px 11px', minWidth: 110 }}>
              <div style={{ fontSize: 10.5, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 700 }}>{k.label}</div>
              <div style={{ fontSize: 16, fontWeight: 800 }}>{k.value}</div>
              {k.delta && <div style={{ fontSize: 11, fontWeight: 700, color: /^-|↓|behind/i.test(k.delta) ? 'var(--error,#ef4444)' : 'var(--success,#10b981)' }}>{k.delta}</div>}
            </div>
          ))}
        </div>
      )}
      {(content.narrative || []).map((p, i) => <p key={i} style={{ fontSize: 13.5, lineHeight: 1.55, color: 'var(--text)', margin: '0 0 8px' }}>{String(p).replace(/\*\*/g, '')}</p>)}
    </div>
  );
}

const fbBtn = (on) => ({ padding: '7px 14px', borderRadius: 980, border: `1.5px solid ${on ? 'var(--brand)' : 'var(--hairline)'}`, background: on ? 'rgba(var(--brand-rgb,255,56,92),0.08)' : 'var(--card)', color: on ? 'var(--brand)' : 'var(--text)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' });
const linkBtn = (color) => ({ background: 'none', border: 'none', padding: 0, color, fontSize: 12, fontWeight: 600, cursor: 'pointer' });
