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
function statChips(node, stats) {
  if (!stats) return null;
  const s = (node.step != null && stats.byStep && stats.byStep[node.step]) || {};
  const waiting = (node.id && stats.atNode && stats.atNode[node.id]) || 0;
  if (!s.opened && !s.clicked && !waiting) return null;
  const chip = { fontSize: 11, fontWeight: 700, borderRadius: 980, padding: '2px 8px', background: 'rgba(128,128,128,0.10)', color: 'var(--muted)' };
  return (
    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 7 }}>
      {s.opened ? <span style={chip}>👁 {s.opened} opened</span> : null}
      {s.clicked ? <span style={{ ...chip, color: 'var(--brand)', background: 'rgba(var(--brand-rgb,255,56,92),0.10)' }}>🖱 {s.clicked} clicked</span> : null}
      {waiting ? <span style={{ ...chip, color: '#b45309', background: 'rgba(245,158,11,0.12)' }}>⏳ {waiting} here now</span> : null}
    </div>
  );
}
function MessageCard({ node, stats, onEdit, templates }) {
  const editIn = { width: '100%', boxSizing: 'border-box', border: '1px solid var(--hairline)', borderRadius: 8, background: 'var(--bg)', color: 'var(--text)', padding: '5px 8px', fontSize: 12.5, fontFamily: 'inherit' };
  const pickImage = async (e) => {
    const f = e.target.files && e.target.files[0]; if (e.target) e.target.value = '';
    if (!f) return;
    const r = new FileReader();
    r.onload = () => onEdit(node.id, { heroImage: String(r.result || '').slice(0, 1500000) });
    r.readAsDataURL(f);
  };
  const applyTemplate = (id) => {
    const t = (templates || []).find((x) => String(x.id) === String(id));
    if (!t) return;
    onEdit(node.id, {
      ...(t.subject ? { subject: t.subject } : {}),
      ...(t.body ? { body: t.body } : {}),
      ...(t.ctaText ? { ctaText: t.ctaText } : {}),
      ...(t.heroImage ? { heroImage: t.heroImage } : {}),
    });
  };
  const usableTemplates = (templates || []).filter((t) => (t.contentMode || 'template') === 'template');
  return (
    <div style={{ padding: 13, border: '1px solid var(--hairline)', borderRadius: 12, background: 'var(--card)', width: '100%', boxSizing: 'border-box', textAlign: 'left' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
        {channelChip(node.channel)}
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>{fmtDelay(node.delayHours)}</span>
      </div>
      {onEdit ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {node.channel === 'email' && usableTemplates.length > 0 && (
            <select style={{ ...editIn, color: 'var(--muted)' }} value="" onChange={(e) => applyTemplate(e.target.value)}>
              <option value="">📝 Apply a template…</option>
              {usableTemplates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
          {node.channel === 'email' && <input style={{ ...editIn, fontWeight: 700 }} value={node.subject} placeholder="Subject" onChange={(e) => onEdit(node.id, { subject: e.target.value })} />}
          {node.channel === 'email' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {node.heroImage
                ? <><img src={node.heroImage} alt="" style={{ height: 34, borderRadius: 6, maxWidth: 90, objectFit: 'cover' }} /><button type="button" onClick={() => onEdit(node.id, { heroImage: '' })} style={{ border: '1px solid var(--hairline)', background: 'none', color: 'var(--muted)', borderRadius: 7, padding: '2px 8px', fontSize: 11, cursor: 'pointer' }}>✕ remove</button></>
                : <label style={{ border: '1px dashed var(--hairline)', borderRadius: 7, padding: '4px 10px', fontSize: 11.5, color: 'var(--muted)', cursor: 'pointer' }}>🖼 Add artwork<input type="file" accept="image/*" onChange={pickImage} style={{ display: 'none' }} /></label>}
            </div>
          )}
          <textarea style={{ ...editIn, resize: 'vertical', lineHeight: 1.45 }} rows={4} value={node.body} placeholder={node.channel === 'sms' ? 'SMS message' : 'Email body'} onChange={(e) => onEdit(node.id, { body: e.target.value })} />
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <input style={{ ...editIn, maxWidth: 130 }} value={node.ctaText} placeholder="Button label" onChange={(e) => onEdit(node.id, { ctaText: e.target.value })} />
            <input style={{ ...editIn, flex: 1, minWidth: 120 }} value={node.ctaUrl || ''} placeholder="Link (blank = campaign buy link)" onChange={(e) => onEdit(node.id, { ctaUrl: e.target.value })} />
          </div>
        </div>
      ) : (
        <>
          {node.channel === 'email' && node.subject && <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 3 }}>{node.subject}</div>}
          {node.body && <div style={{ fontSize: 12.5, lineHeight: 1.45, whiteSpace: 'pre-wrap', color: 'var(--text)' }}>{node.body}</div>}
          {node.ctaText && <div style={{ marginTop: 8 }}><span style={{ display: 'inline-block', fontSize: 11.5, fontWeight: 700, color: 'var(--brand)', border: '1px solid var(--brand)', borderRadius: 8, padding: '3px 9px' }}>{node.ctaText} →</span></div>}
        </>
      )}
      {statChips(node, stats)}
    </div>
  );
}
function DecisionSplit({ node, stats, onEdit, templates }) {
  const waiting = (stats && node.id && stats.atNode && stats.atNode[node.id]) || 0;
  return (
    <div className="jt-col">
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 13px', borderRadius: 10, background: 'rgba(245,158,11,0.12)', border: '1px solid rgba(245,158,11,0.4)', maxWidth: 280, textAlign: 'left' }}>
        <span style={{ fontSize: 14 }}>◆</span>
        <span style={{ fontSize: 13, fontWeight: 700 }}>{node.question}</span>
        {node.waitHours ? <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600, whiteSpace: 'nowrap' }}>· {fmtWait(node.waitHours)}</span> : null}
        {waiting ? <span style={{ fontSize: 11, fontWeight: 800, color: '#b45309', whiteSpace: 'nowrap' }}>⏳ {waiting} waiting</span> : null}
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
              <NodeColumn nodes={b.nodes || []} stats={stats} onEdit={onEdit} templates={templates} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
function NodeColumn({ nodes, stats, onEdit, templates }) {
  return (
    <div className="jt-col">
      {(nodes || []).map((n, i) => (
        <Fragment key={i}>
          {i > 0 && <div className="jt-link" />}
          {n.type === 'decision' ? <DecisionSplit node={n} stats={stats} onEdit={onEdit} templates={templates} /> : <div className="jt-card" style={onEdit ? { width: 270 } : undefined}><MessageCard node={n} stats={stats} onEdit={onEdit} templates={templates} /></div>}
        </Fragment>
      ))}
    </div>
  );
}
// stats (optional): { byStep: {step:{opened,clicked}}, atNode: {nodeId:count} } —
// overlays live funnel chips on the design (see /api/journeys/:e/:id/stats).
// onEdit (optional): (nodeId, patch) — full per-mailer editing in place (copy,
// artwork, link, apply-a-template). templates: campaign templates for the picker.
export default function JourneyTree({ nodes, stats, onEdit, templates }) {
  return <div className="jt-scroll"><style>{TREE_CSS}</style><NodeColumn nodes={nodes} stats={stats} onEdit={onEdit} templates={templates} /></div>;
}

// Immutably apply a copy patch to one message node (by id) anywhere in the tree.
export function patchNode(nodes, id, patch) {
  return (nodes || []).map((n) => {
    if (n.id === id) return { ...n, ...patch };
    if (n.type === 'decision') return { ...n, branches: n.branches.map((b) => ({ ...b, nodes: patchNode(b.nodes, id, patch) })) };
    return n;
  });
}
// The opening (pre-decision) messages — mirrored into the classic `steps` so
// previews + the linear fallback stay coherent with tree edits.
export function openingMessages(nodes) {
  const trunk = [];
  for (const n of nodes || []) {
    if (n.type === 'message') trunk.push(n);
    else { if (trunk.length) break; const b = (n.branches || [])[0]; return b ? openingMessages(b.nodes) : trunk; }
  }
  return trunk;
}

export function countDecisions(nodes) {
  let c = 0;
  for (const n of nodes || []) if (n.type === 'decision') { c += 1; for (const b of n.branches || []) c += countDecisions(b.nodes); }
  return c;
}
// (Creating the draft happens server-side — POST /api/owl/act/draft-journey —
// which also auto-saves a new chat cohort as a reusable segment first.)
