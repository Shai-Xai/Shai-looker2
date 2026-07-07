import { useState, useEffect, useRef, Fragment } from 'react';
import { api } from '../lib/api.js';

// Engage → Journeys. The front door is the OWL — a conversational, data-aware
// assistant. You tell it what you want, it asks/suggests (grounded in the
// client's real saved audiences), and it drafts a branching decision tree that
// renders live and updates as you refine by talking. Recipes survive as starter
// suggestion chips, not a card wall. The Owl proposes; a human reviews and
// creates the draft (audience + final copy finished in Campaigns). Nothing sends.
//
// A journey is a tree of `message` + `decision` nodes (see server/journeys.js).

const fmtDelay = (h) => {
  if (!h) return 'right away';
  if (h % 24 === 0) { const d = h / 24; return `after ${d} day${d === 1 ? '' : 's'}`; }
  if (h < 24) return `after ${h}h`;
  return `after ${Math.round((h / 24) * 10) / 10} days`;
};
const fmtWait = (h) => {
  if (!h) return '';
  if (h % 24 === 0) { const d = h / 24; return `waits up to ${d} day${d === 1 ? '' : 's'}`; }
  return `waits up to ${h}h`;
};

const BRANCH_COLORS = ['#7c3aed', '#0ea5e9', '#f59e0b', '#ec4899', '#10b981'];

const TREE_CSS = `
.jt-scroll { overflow-x: auto; padding: 4px 2px 10px; }
.jt-col { display: inline-flex; flex-direction: column; align-items: center; }
.jt-link { width: 2px; height: 18px; background: var(--hairline); flex: none; }
.jt-stem { width: 2px; height: 16px; background: var(--hairline); }
.jt-branches { display: flex; align-items: flex-start; justify-content: center; }
.jt-branch { position: relative; padding: 18px 9px 0; display: flex; flex-direction: column; align-items: center; }
.jt-branch::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; background: var(--hairline); }
.jt-branch:first-child::before { left: 50%; }
.jt-branch:last-child::before { right: 50%; }
.jt-branch:only-child::before { display: none; }
.jt-branch::after { content: ''; position: absolute; top: 0; left: calc(50% - 1px); width: 2px; height: 18px; background: var(--hairline); }
.jt-card { width: 210px; box-sizing: border-box; }
`;

function channelChip(channel) {
  const email = channel === 'email';
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', borderRadius: 980, padding: '2px 8px', background: email ? 'rgba(124,58,237,0.12)' : 'rgba(16,185,129,0.14)', color: email ? 'var(--brand)' : '#0d9668' }}>{email ? '✉️ Email' : '💬 SMS'}</span>
  );
}
function MessageCard({ node }) {
  return (
    <div style={{ padding: 13, border: '1px solid var(--hairline)', borderRadius: 12, background: 'var(--card)', width: '100%', boxSizing: 'border-box', textAlign: 'left' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        {channelChip(node.channel)}
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>{fmtDelay(node.delayHours)}</span>
      </div>
      {node.channel === 'email' && node.subject && <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 3 }}>{node.subject}</div>}
      {node.body && <div style={{ fontSize: 12.5, lineHeight: 1.45, whiteSpace: 'pre-wrap', color: 'var(--text)' }}>{node.body}</div>}
      {node.ctaText && <div style={{ marginTop: 8 }}><span style={{ display: 'inline-block', fontSize: 11.5, fontWeight: 700, color: 'var(--brand)', border: '1px solid var(--brand)', borderRadius: 8, padding: '3px 9px' }}>{node.ctaText} →</span></div>}
    </div>
  );
}
function DecisionSplit({ node }) {
  return (
    <div className="jt-col">
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 13px', borderRadius: 10, background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.4)', maxWidth: 280, textAlign: 'left' }}>
        <span style={{ fontSize: 14 }}>◆</span>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{node.question}</span>
        {node.waitHours ? <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, whiteSpace: 'nowrap' }}>· {fmtWait(node.waitHours)}</span> : null}
      </div>
      <div className="jt-stem" />
      <div className="jt-branches">
        {(node.branches || []).map((b, i) => {
          const color = BRANCH_COLORS[i % BRANCH_COLORS.length];
          return (
            <div className="jt-branch" key={i}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, color: '#fff', background: color, borderRadius: 980, padding: '2px 10px', whiteSpace: 'nowrap' }}>
                <span style={{ opacity: 0.85 }}>if</span> {b.label}
              </span>
              <div className="jt-link" />
              <NodeColumn nodes={b.nodes || []} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
function NodeColumn({ nodes }) {
  return (
    <div className="jt-col">
      {(nodes || []).map((n, i) => (
        <Fragment key={i}>
          {i > 0 && <div className="jt-link" />}
          {n.type === 'decision' ? <DecisionSplit node={n} /> : <div className="jt-card"><MessageCard node={n} /></div>}
        </Fragment>
      ))}
    </div>
  );
}
function NodeTree({ nodes }) {
  return <div className="jt-scroll"><style>{TREE_CSS}</style><NodeColumn nodes={nodes} /></div>;
}

function countDecisions(nodes) {
  let c = 0;
  for (const n of nodes || []) if (n.type === 'decision') { c += 1; for (const b of n.branches || []) c += countDecisions(b.nodes); }
  return c;
}
function openingMessages(nodes) {
  const trunk = [];
  for (const n of nodes || []) {
    if (n.type === 'message') trunk.push(n);
    else { if (trunk.length) break; const b = (n.branches || [])[0]; return b ? openingMessages(b.nodes) : trunk; }
  }
  return trunk;
}

const GREETING = "Hi! I'm the Owl 🦉. Tell me what you'd like to achieve and I'll build the journey for you — e.g. “chase abandoned checkouts and escalate to SMS if they don't buy”, or “win back people who haven't bought in a while”. I can target your saved audiences too.";

export default function JourneyWizard({ entityId }) {
  const [recipes, setRecipes] = useState([]);
  const [chat, setChat] = useState([{ role: 'assistant', text: GREETING }]);
  const [input, setInput] = useState('');
  const [journey, setJourney] = useState(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState(false);
  const [creating, setCreating] = useState(false);
  const endRef = useRef(null);

  useEffect(() => { api.journeyRecipes(entityId).then((r) => setRecipes(r.recipes || [])).catch(() => setRecipes([])); }, [entityId]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [chat, sending]);

  const send = async (text) => {
    const msg = (text || '').trim();
    if (!msg || sending) return;
    setError(''); setInput('');
    const next = [...chat, { role: 'user', text: msg }];
    setChat(next); setSending(true);
    try {
      const out = await api.journeyChat(entityId, { messages: next, currentJourney: journey });
      setChat((c) => [...c, { role: 'assistant', text: out.reply || 'Done — take a look at the journey.' }]);
      if (out.journey) setJourney(out.journey);
    } catch (e) {
      setError(e.message || 'The Owl couldn’t respond. Try again.');
      setChat((c) => [...c, { role: 'assistant', text: 'Sorry — I hit a snag. Could you say that again?' }]);
    } finally { setSending(false); }
  };

  const createDraft = async () => {
    if (!journey) return;
    setError(''); setCreating(true);
    try {
      const opening = openingMessages(journey.nodes);
      const channels = [...new Set(opening.map((s) => (s.channel === 'sms' ? 'sms' : 'email')))];
      const channel = channels.length > 1 ? 'both' : (channels[0] || 'email');
      const steps = opening.map((s) => ({ delayHours: Number(s.delayHours) || 0, subject: s.subject || '', body: s.body || '', ctaText: s.ctaText || '' }));
      await api.createAction(entityId, { title: journey.name, channel, campaignMode: 'sequence', dripStart: 'send', master: journey.name, subject: steps[0]?.subject || journey.name, body: steps[0]?.body || '', ctaText: steps[0]?.ctaText || '', steps });
      setCreated(true);
    } catch (e) { setError(e.message || 'Could not create the draft campaign.'); }
    finally { setCreating(false); }
  };

  const startOver = () => { setChat([{ role: 'assistant', text: GREETING }]); setJourney(null); setInput(''); setError(''); setCreated(false); };

  if (created) {
    return (
      <div style={{ maxWidth: 560 }}>
        <div style={{ padding: 18, border: '1px solid var(--hairline)', borderRadius: 14, background: 'var(--card)' }}>
          <div style={{ fontSize: 32, marginBottom: 6 }}>✅</div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: '0 0 6px' }}>Draft created</h2>
          <p style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--muted)', margin: '0 0 14px' }}>
            “{journey?.name}” is saved as a <strong style={{ color: 'var(--text)' }}>draft</strong> on the <strong style={{ color: 'var(--text)' }}>Campaigns</strong> tab. Open it there to choose the audience, finalise the copy, and approve — nothing sends until you do.
          </p>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <a href="/engage/campaigns" style={{ ...primaryBtn, textDecoration: 'none', display: 'inline-block' }}>Go to Campaigns</a>
            <button onClick={startOver} style={secondaryBtn}>Build another</button>
          </div>
        </div>
      </div>
    );
  }

  const decisions = journey ? countDecisions(journey.nodes) : 0;
  const showChips = chat.length <= 1 && !sending;

  return (
    <div>
      {/* Owl chat */}
      <div style={{ maxWidth: 720, border: '1px solid var(--hairline)', borderRadius: 14, background: 'var(--card)', overflow: 'hidden' }}>
        <div style={{ maxHeight: 340, overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {chat.map((m, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start' }}>
              <div style={{ maxWidth: '82%', fontSize: 13.5, lineHeight: 1.5, padding: '8px 12px', borderRadius: 12, whiteSpace: 'pre-wrap', ...(m.role === 'user'
                ? { background: 'var(--brand)', color: '#fff', borderBottomRightRadius: 4 }
                : { background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--hairline)', borderBottomLeftRadius: 4 }) }}>
                {m.text}
              </div>
            </div>
          ))}
          {sending && <div style={{ fontSize: 12.5, color: 'var(--muted)', fontStyle: 'italic' }}>The Owl is thinking…</div>}
          <div ref={endRef} />
        </div>

        {showChips && recipes.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '0 14px 12px' }}>
            {recipes.map((r) => (
              <button key={r.key} onClick={() => send(`Help me ${r.label.toLowerCase()}.`)} style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', background: 'var(--bg)', border: '1px solid var(--hairline)', borderRadius: 980, padding: '6px 12px', cursor: 'pointer' }}>
                {r.label}
              </button>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, padding: 10, borderTop: '1px solid var(--hairline)', background: 'var(--bg)' }}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input); } }}
            placeholder="Tell the Owl what you want…"
            disabled={sending}
            style={{ flex: 1, minHeight: 40, borderRadius: 10, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', padding: '0 12px', fontSize: 14, fontFamily: 'inherit' }}
          />
          <button onClick={() => send(input)} disabled={sending || !input.trim()} style={{ ...primaryBtn, opacity: sending || !input.trim() ? 0.6 : 1 }}>Send</button>
        </div>
      </div>

      {error && <p style={{ color: 'var(--error)', fontSize: 13, margin: '10px 0 0' }}>{error}</p>}

      {/* Live decision tree */}
      {journey && (
        <div style={{ marginTop: 20 }}>
          <div style={{ maxWidth: 720, display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
            <h2 style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.02em', margin: 0 }}>{journey.name}</h2>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{decisions > 0 ? `${decisions} decision point${decisions === 1 ? '' : 's'}` : 'linear'} · ask the Owl to change anything</span>
          </div>
          {journey.summary && <p style={{ maxWidth: 720, fontSize: 13.5, lineHeight: 1.5, color: 'var(--muted)', margin: '0 0 4px' }}>{journey.summary}</p>}
          <NodeTree nodes={journey.nodes} />
          {decisions > 0 && (
            <div style={{ maxWidth: 720, fontSize: 12.5, color: 'var(--muted)', background: 'rgba(128,128,128,0.08)', borderRadius: 8, padding: '9px 11px', margin: '4px 0 12px' }}>
              The branches are the design; running them (routing people by what they opened, clicked or bought) is the journey engine we’re building next. <strong>Create as draft</strong> sets up the opening sequence as a campaign you can finish and send.
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 12 }}>
            <button onClick={createDraft} disabled={creating} style={primaryBtn}>{creating ? 'Creating…' : 'Create as draft campaign'}</button>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>You’ll add the audience and finalise copy before anything sends.</span>
          </div>
        </div>
      )}
    </div>
  );
}

const primaryBtn = { minHeight: 40, padding: '9px 16px', border: 'none', borderRadius: 10, background: 'var(--brand)', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' };
const secondaryBtn = { minHeight: 40, padding: '9px 16px', border: '1px solid var(--hairline)', borderRadius: 10, background: 'var(--card)', color: 'var(--text)', fontWeight: 600, fontSize: 14, cursor: 'pointer' };
