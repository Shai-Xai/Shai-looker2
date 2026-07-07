import { Fragment } from 'react';

// The journey DECISION TREE renderer — shared by the Owl chat's draftJourney
// confirm card and the Engage → Journeys tab's recipe previews. A journey is a
// tree of `message` + `decision` nodes (see server/journeys.js); decisions fan
// out into side-by-side branch columns with connector lines, and the whole tree
// scrolls horizontally when wider than its container (mobile-safe).

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
export default function JourneyTree({ nodes }) {
  return <div className="jt-scroll"><style>{TREE_CSS}</style><NodeColumn nodes={nodes} /></div>;
}

export function countDecisions(nodes) {
  let c = 0;
  for (const n of nodes || []) if (n.type === 'decision') { c += 1; for (const b of n.branches || []) c += countDecisions(b.nodes); }
  return c;
}
// (Creating the draft happens server-side — POST /api/owl/act/draft-journey —
// which also auto-saves a new chat cohort as a reusable segment first.)
