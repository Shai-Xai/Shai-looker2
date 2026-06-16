import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';

// Engage → Journeys. The easy-setup front door for branching journeys: the
// promoter either picks a pre-wired RECIPE or DESCRIBES what they want in plain
// language and an AI drafts it. Either way they get a read-only DECISION TREE to
// review, then create it as a draft campaign (finished — audience + final copy —
// in the Campaigns tab). The graph is generated, never hand-built; the AI
// proposes, a human always reviews.
//
// A journey is a tree of `nodes`: `message` nodes (email/SMS) interleaved with
// `decision` nodes that branch on behaviour (bought / clicked / opened / no
// response). Today's drip engine runs the opening (pre-decision) sequence as a
// timed draft; executing the branches is the J3 engine.

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

function channelChip(channel) {
  const email = channel === 'email';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 700,
      textTransform: 'uppercase', letterSpacing: '0.04em', borderRadius: 980, padding: '2px 8px',
      background: email ? 'rgba(124,58,237,0.12)' : 'rgba(16,185,129,0.14)',
      color: email ? 'var(--brand)' : '#0d9668',
    }}>{email ? '✉️ Email' : '💬 SMS'}</span>
  );
}

function MessageNode({ node }) {
  return (
    <div style={{ padding: 13, border: '1px solid var(--hairline)', borderRadius: 12, background: 'var(--card)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        {channelChip(node.channel)}
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>{fmtDelay(node.delayHours)}</span>
      </div>
      {node.channel === 'email' && node.subject && <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 3 }}>{node.subject}</div>}
      {node.body && <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap', color: 'var(--text)' }}>{node.body}</div>}
      {node.ctaText && <div style={{ marginTop: 8 }}><span style={{ display: 'inline-block', fontSize: 12, fontWeight: 700, color: 'var(--brand)', border: '1px solid var(--brand)', borderRadius: 8, padding: '3px 10px' }}>{node.ctaText} →</span></div>}
    </div>
  );
}

function DecisionNode({ node, depth }) {
  return (
    <div>
      {/* the decision diamond/question */}
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 13px', borderRadius: 10, background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.4)' }}>
        <span style={{ fontSize: 14 }}>◆</span>
        <span style={{ fontSize: 13.5, fontWeight: 700 }}>{node.question}</span>
        {node.waitHours ? <span style={{ fontSize: 11.5, color: 'var(--muted)', fontWeight: 600 }}>· {fmtWait(node.waitHours)}</span> : null}
      </div>
      {/* the branches */}
      <div style={{ marginTop: 8 }}>
        {(node.branches || []).map((b, i) => {
          const color = BRANCH_COLORS[i % BRANCH_COLORS.length];
          return (
            <div key={i} style={{ marginTop: 10 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, color: '#fff', background: color, borderRadius: 980, padding: '2px 10px' }}>
                <span style={{ opacity: 0.85 }}>if</span> {b.label}
              </span>
              <div style={{ marginTop: 8, marginLeft: 7, paddingLeft: 14, borderLeft: `2px solid ${color}` }}>
                <NodeTree nodes={b.nodes || []} depth={depth + 1} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function NodeTree({ nodes, depth = 0 }) {
  return (
    <div>
      {(nodes || []).map((n, i) => (
        <div key={i}>
          {i > 0 && (
            <div style={{ display: 'flex', justifyContent: 'flex-start', marginLeft: 13 }}>
              <div style={{ width: 2, height: 14, background: 'var(--hairline)' }} />
            </div>
          )}
          {n.type === 'decision' ? <DecisionNode node={n} depth={depth} /> : <MessageNode node={n} />}
        </div>
      ))}
    </div>
  );
}

// Count decision nodes (recursively) and pull the opening (pre-decision) message
// sequence — what the linear drip can run as a draft today.
function countDecisions(nodes) {
  let c = 0;
  for (const n of nodes || []) {
    if (n.type === 'decision') { c += 1; for (const b of n.branches || []) c += countDecisions(b.nodes); }
  }
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

export default function JourneyWizard({ entityId }) {
  const [recipes, setRecipes] = useState([]);
  const [stage, setStage] = useState('choose'); // choose | review | done
  const [journey, setJourney] = useState(null);
  const [desc, setDesc] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { api.journeyRecipes(entityId).then((r) => setRecipes(r.recipes || [])).catch(() => setRecipes([])); }, [entityId]);

  const pickRecipe = (r) => { setError(''); setJourney({ ...r, source: 'recipe' }); setStage('review'); };
  const draftWithAI = async () => {
    if (!desc.trim()) return;
    setError(''); setDrafting(true);
    try {
      const out = await api.draftJourney(entityId, { description: desc.trim() });
      setJourney({ name: out.name || 'Untitled journey', goal: out.goal || '', summary: out.summary || '', nodes: out.nodes || [], source: 'ai' });
      setStage('review');
    } catch (e) { setError(e.message || 'Could not draft the journey. Try rephrasing.'); }
    finally { setDrafting(false); }
  };

  const createDraft = async () => {
    if (!journey) return;
    setError(''); setCreating(true);
    try {
      const opening = openingMessages(journey.nodes);
      const channels = [...new Set(opening.map((s) => (s.channel === 'sms' ? 'sms' : 'email')))];
      const channel = channels.length > 1 ? 'both' : (channels[0] || 'email');
      const steps = opening.map((s) => ({ delayHours: Number(s.delayHours) || 0, subject: s.subject || '', body: s.body || '', ctaText: s.ctaText || '' }));
      await api.createAction(entityId, {
        title: journey.name, channel, campaignMode: 'sequence', dripStart: 'send', master: journey.name,
        subject: steps[0]?.subject || journey.name, body: steps[0]?.body || '', ctaText: steps[0]?.ctaText || '', steps,
      });
      setStage('done');
    } catch (e) { setError(e.message || 'Could not create the draft campaign.'); }
    finally { setCreating(false); }
  };

  const startOver = () => { setJourney(null); setDesc(''); setError(''); setStage('choose'); };

  // ── Review: the decision tree ─────────────────────────────────────────────
  if (stage === 'review' && journey) {
    const decisions = countDecisions(journey.nodes);
    return (
      <div style={{ maxWidth: 660 }}>
        <button onClick={startOver} style={linkBtn}>← Start over</button>
        <div style={{ marginTop: 10, padding: '16px 16px 10px', border: '1px solid var(--hairline)', borderRadius: 14, background: 'var(--card)' }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)' }}>
            {journey.source === 'ai' ? '✨ AI-drafted journey' : '📋 Recipe'} · review before creating
          </div>
          <h2 style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.02em', margin: '4px 0 6px' }}>{journey.name}</h2>
          {journey.goal && <p style={{ fontSize: 13.5, color: 'var(--muted)', margin: '0 0 8px' }}><strong style={{ color: 'var(--text)' }}>Goal:</strong> {journey.goal}</p>}
          {journey.summary && <p style={{ fontSize: 14, lineHeight: 1.5, margin: 0 }}>{journey.summary}</p>}
        </div>

        <div style={{ marginTop: 16 }}>
          <NodeTree nodes={journey.nodes} />
        </div>

        {decisions > 0 && (
          <div style={{ fontSize: 12.5, color: 'var(--muted)', background: 'rgba(128,128,128,0.08)', borderRadius: 8, padding: '9px 11px', margin: '16px 0 12px' }}>
            This journey has {decisions} decision point{decisions === 1 ? '' : 's'}. The tree above is the design; running the branches (routing people by what they opened, clicked or bought) is the journey engine we’re building next. For now, <strong>Create as draft</strong> sets up the opening sequence as a campaign you can finish and send.
          </div>
        )}

        {error && <p style={{ color: 'var(--error)', fontSize: 13, marginBottom: 8 }}>{error}</p>}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: decisions ? 0 : 16 }}>
          <button onClick={createDraft} disabled={creating} style={primaryBtn}>{creating ? 'Creating…' : 'Create as draft campaign'}</button>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>You’ll add the audience and finalise copy before anything sends.</span>
        </div>
      </div>
    );
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  if (stage === 'done') {
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

  // ── Choose: AI describe + recipe gallery ──────────────────────────────────
  return (
    <div>
      <div style={{ padding: 16, border: '1px solid var(--hairline)', borderRadius: 14, background: 'var(--card)', marginBottom: 22, maxWidth: 660 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>✨ Describe your journey</div>
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 10px' }}>
          Tell us in plain language what you want — including the “ifs”. e.g. “Email people who didn’t finish checkout. If they open but don’t buy, follow up; if they buy, thank them; if no response, keep nudging.”
        </p>
        <textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="When someone… then… if they… otherwise…" rows={3}
          style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', borderRadius: 10, border: '1px solid var(--hairline)', background: 'var(--bg)', color: 'var(--text)', padding: 10, fontSize: 14, fontFamily: 'inherit' }} />
        {error && <p style={{ color: 'var(--error)', fontSize: 13, margin: '8px 0 0' }}>{error}</p>}
        <div style={{ marginTop: 10 }}>
          <button onClick={draftWithAI} disabled={drafting || !desc.trim()} style={{ ...primaryBtn, opacity: drafting || !desc.trim() ? 0.6 : 1 }}>{drafting ? 'Drafting…' : 'Draft with AI'}</button>
        </div>
      </div>

      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>Or start from a recipe</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
        {recipes.map((r) => {
          const branches = countDecisions(r.nodes);
          return (
            <button key={r.key} onClick={() => pickRecipe(r)} style={{ textAlign: 'left', cursor: 'pointer', padding: 14, border: '1px solid var(--hairline)', borderRadius: 12, background: 'var(--card)', color: 'var(--text)', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 14.5, fontWeight: 700 }}>{r.label}</div>
              <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.45 }}>{r.short}</div>
              {branches > 0 && <div style={{ fontSize: 11.5, fontWeight: 700, color: '#b45309' }}>◆ {branches} decision{branches === 1 ? '' : 's'}</div>}
            </button>
          );
        })}
        {!recipes.length && <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading recipes…</p>}
      </div>
    </div>
  );
}

const primaryBtn = { minHeight: 40, padding: '9px 16px', border: 'none', borderRadius: 10, background: 'var(--brand)', color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer' };
const secondaryBtn = { minHeight: 40, padding: '9px 16px', border: '1px solid var(--hairline)', borderRadius: 10, background: 'var(--card)', color: 'var(--text)', fontWeight: 600, fontSize: 14, cursor: 'pointer' };
const linkBtn = { border: 'none', background: 'none', color: 'var(--muted)', fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: 0 };
