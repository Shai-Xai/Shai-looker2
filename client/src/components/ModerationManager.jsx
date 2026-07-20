import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';

// Social moderation console — banned lists + review queue + audit trail
// (docs/specs/MODERATION_CONTRACT.md §8.2). ONE component, three surfaces via
// the `scope` prop, MailTemplateEditor-style:
//   'platform' — Admin → Product → Moderation: the Howler-wide rules that hit
//                every client, and the cross-client queue. Writes need the
//                platform_moderator designation (server-enforced; the UI
//                relays the 403 as a hint).
//   'admin'    — a client's console operated by Howler staff on their behalf
//                (Engage → App → Moderation while previewing the client).
//   'my'       — the client's own console (same page, their login; permission
//                moderation.manage, flag community.moderation).
// Mobile-first: everything is a single column of cards that wraps; no fixed
// widths, tap targets ≥ 40px.

const KIND_ICON = { word: '🔤', phrase: '💬', emoji: '😶', image: '🖼' };
const TRIGGER_LABEL = {
  exact_rule: ['⛔ Rule — exact', '#c62828', '#fdecea'],
  similar_rule: ['⚠️ Rule — similar', '#8a6d00', '#fdf6e3'],
  ai: ['🤖 AI', '#5a2f8a', '#f3ecfb'],
  user_report: ['🚩 Fan report', '#0b63c5', '#e8f1fc'],
};
const TYPE_LABEL = { post: '📰 Post', comment: '💭 Comment', chat_message: '💬 Chat message', reaction: '😶 Reaction', channel_name: '👥 Group name' };
const ago = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

export default function ModerationManager({ entityId, scope }) {
  const [sub, setSub] = useState('queue');
  const [rules, setRules] = useState(null);
  const [queue, setQueue] = useState(null);
  const [error, setError] = useState('');
  const isPlatform = scope === 'platform';

  const loadRules = () => api.modRules(scope, entityId).then((r) => setRules(r.rules || [])).catch((e) => { setRules([]); setError(e.message); });
  const loadQueue = () => api.modQueue(scope, entityId).then(setQueue).catch((e) => { setQueue({ items: [], pendingCount: 0 }); setError(e.message); });
  useEffect(() => { setRules(null); setQueue(null); setError(''); loadRules(); loadQueue(); }, [entityId, scope]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = (p) => p.then(() => { setError(''); loadQueue(); loadRules(); }).catch((e) => setError(e.message || 'That didn’t work'));

  const pending = queue?.pendingCount ?? 0;
  const TABS = [
    ['queue', `⏳ Review queue${pending ? ` (${pending})` : ''}`],
    ['rules', '🚫 Banned list'],
    ['audit', '🧾 Audit'],
  ];

  return (
    <section>
      <p style={{ color: 'var(--muted)', fontSize: 13, margin: '0 0 12px' }}>
        {isPlatform
          ? '🌍 Platform scope — these rules hit EVERY client and event, and this queue spans all clients. Changes here need the platform-moderator designation.'
          : 'Applies to this client’s communities & chat channels only — on top of the Howler platform list, which always applies and can’t be removed here.'}
      </p>
      <div className="no-scrollbar" style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 14 }}>
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setSub(k)} style={{ ...mini, whiteSpace: 'nowrap', minHeight: 40, ...(sub === k ? { background: 'var(--brand)', color: '#fff', borderColor: 'var(--brand)' } : {}) }}>{label}</button>
        ))}
      </div>
      {error && <p style={{ color: '#c62828', fontSize: 13, margin: '0 0 10px' }}>{error}{/(403|access)/i.test(error) && isPlatform ? ' — platform rule/queue changes need the platform-moderator designation on your admin login.' : ''}</p>}
      {sub === 'queue' && <Queue scope={scope} entityId={entityId} queue={queue} rules={rules} act={act} onReload={loadQueue} />}
      {sub === 'rules' && <Rules scope={scope} entityId={entityId} rules={rules} act={act} />}
      {sub === 'audit' && <Audit scope={scope} entityId={entityId} rules={rules} />}
    </section>
  );
}

// ── review queue ────────────────────────────────────────────────────────────
function Queue({ scope, entityId, queue, rules, act, onReload }) {
  const [type, setType] = useState('');
  const [items, setItems] = useState(null);
  // The default load (no filter) rides the parent's queue state; a type filter
  // fetches its own slice so switching back is instant.
  useEffect(() => {
    if (!type) { setItems(null); return; }
    api.modQueue(scope, entityId, { type }).then((r) => setItems(r.items || [])).catch(() => setItems([]));
  }, [type, scope, entityId, queue]);
  const rows = type ? items : queue?.items;

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <select style={input} value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All content</option>
          {Object.entries(TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
        {queue?.oldestPendingAt && (queue?.pendingCount ?? 0) > 0 && <span style={{ fontSize: 12, color: 'var(--muted)' }}>oldest waiting {ago(queue.oldestPendingAt)}</span>}
        <button style={{ ...mini, marginLeft: 'auto' }} onClick={onReload}>↻ Refresh</button>
      </div>
      {rows == null ? <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p> : rows.length === 0 ? (
        <p style={{ color: 'var(--muted)', fontSize: 13.5, margin: 0 }}>🎉 Nothing waiting for review. Held content and fan reports land here.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map((it) => <QueueItem key={it.id} item={it} scope={scope} entityId={entityId} rules={rules} act={act} />)}
        </div>
      )}
    </div>
  );
}

function QueueItem({ item, scope, entityId, rules, act }) {
  const [t, color, bg] = TRIGGER_LABEL[item.trigger] || ['❔', 'var(--muted)', 'var(--card)'];
  const matched = (item.evidence?.ruleIds || []).map((id) => (rules || []).find((r) => r.id === id)?.value).filter(Boolean);
  const isReport = item.trigger === 'user_report';
  return (
    <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
        <span style={chip(color, bg)}>{t}</span>
        <span style={chip('var(--text)', 'var(--bg)')}>{TYPE_LABEL[item.contentType] || item.contentType}</span>
        {item.authorUserId && <span style={{ color: 'var(--muted)' }}>fan #{item.authorUserId}</span>}
        <span style={{ color: 'var(--muted)', marginLeft: 'auto' }}>{ago(item.createdAt)}</span>
      </div>
      <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.45, overflowWrap: 'anywhere' }}>
        {item.snapshot?.text || item.snapshot?.name || item.snapshot?.emoji || <span style={{ color: 'var(--muted)' }}>(no text)</span>}
      </p>
      {(matched.length > 0 || item.evidence?.reportReason) && (
        <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)' }}>
          {matched.length > 0 && <>matched: {matched.map((v) => <mark key={v} style={{ background: bg, color, borderRadius: 4, padding: '0 4px', marginRight: 4, fontWeight: 700 }}>{v}</mark>)}</>}
          {item.evidence?.reportReason && <>reported: “{item.evidence.reportReason}”</>}
        </p>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button style={{ ...primary, background: '#1b8a4c' }} onClick={() => act(api.modDecide(scope, entityId, item.id, true))}>
          ✓ {isReport ? 'Dismiss report' : 'Approve — publish it'}
        </button>
        <button style={{ ...primary, background: '#c62828' }} onClick={() => act(api.modDecide(scope, entityId, item.id, false))}>
          ✕ {isReport ? 'Remove content' : 'Decline — remove it'}
        </button>
      </div>
      {isReport && <p style={{ margin: 0, fontSize: 11.5, color: 'var(--muted)' }}>Reported content is still live — it only comes down if you remove it.</p>}
    </div>
  );
}

// ── banned list ─────────────────────────────────────────────────────────────
function Rules({ scope, entityId, rules, act }) {
  const [value, setValue] = useState('');
  const [action, setAction] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [bulk, setBulk] = useState('');
  const [test, setTest] = useState('');
  const [verdict, setVerdict] = useState(null);

  const add = () => value.trim() && act(api.modCreateRule(scope, entityId, { value: value.trim(), matchAction: action }).then(() => setValue('')));
  const runTest = () => test.trim() && api.modTestRules(scope, entityId, test).then(setVerdict).catch(() => setVerdict(null));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ ...card, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input style={{ ...input, flex: 1, minWidth: 160 }} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} placeholder="Word, phrase or emoji to ban…" maxLength={120} />
        <select style={input} value={action} onChange={(e) => setAction(e.target.value)} title="What an exact hit does (near-misses are always held for review)">
          <option value="">⛔ Block outright (default)</option>
          <option value="hold">⚠️ Always hold for review</option>
        </select>
        <button style={primary} onClick={add}>+ Ban it</button>
        <button style={mini} onClick={() => setShowImport((v) => !v)}>{showImport ? 'Close' : '📋 Bulk paste'}</button>
      </div>
      {showImport && (
        <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <textarea style={{ ...input, minHeight: 110, resize: 'vertical' }} value={bulk} onChange={(e) => setBulk(e.target.value)} placeholder={'One entry per line (or comma-separated)…'} />
          <button style={{ ...primary, alignSelf: 'flex-start' }} onClick={() => act(api.modImportRules(scope, entityId, bulk).then((r) => { setBulk(''); setShowImport(false); return r; }))}>Import all</button>
        </div>
      )}

      {/* "Would this be caught?" — try a message against the live rule set. */}
      <div style={{ ...card, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input style={{ ...input, flex: 1, minWidth: 180 }} value={test} onChange={(e) => { setTest(e.target.value); setVerdict(null); }} onKeyDown={(e) => e.key === 'Enter' && runTest()} placeholder="🧪 Type a test message — would it be caught?" />
        <button style={mini} onClick={runTest}>Test</button>
        {verdict && (
          <span style={{ fontSize: 12.5, fontWeight: 700, color: verdict.outcome === 'block' ? '#c62828' : verdict.outcome === 'hold' ? '#8a6d00' : '#1b8a4c' }}>
            {verdict.outcome === 'block' ? '⛔ Blocked' : verdict.outcome === 'hold' ? '⚠️ Held for review' : '✓ Passes'}
            {verdict.matches?.length > 0 && <span style={{ fontWeight: 500, color: 'var(--muted)' }}> — {verdict.matches.map((m) => m.value).filter(Boolean).join(', ')}</span>}
          </span>
        )}
      </div>

      {rules == null ? <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p> : rules.length === 0 ? (
        <p style={{ color: 'var(--muted)', fontSize: 13.5, margin: 0 }}>No entries yet. Exact hits on a banned entry are rejected before anyone sees them; near-miss variants are held for your review.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rules.map((r) => (
            <div key={r.id} style={{ ...card, padding: '9px 12px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', opacity: r.active ? 1 : 0.55 }}>
              <span style={{ fontSize: 13.5, fontWeight: 700, overflowWrap: 'anywhere' }}>{KIND_ICON[r.kind] || ''} {r.value}</span>
              {r.matchAction === 'hold' && <span style={chip('#8a6d00', '#fdf6e3')}>always held</span>}
              <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6 }}>
                <button style={tiny} title={r.active ? 'Disable (kept, not enforced)' : 'Enable'} onClick={() => act(api.modPatchRule(scope, entityId, r.id, { active: !r.active }))}>{r.active ? '⏸' : '▶️'}</button>
                <button style={{ ...tiny, color: '#c62828' }} title="Delete" onClick={() => act(api.modDeleteRule(scope, entityId, r.id))}>🗑</button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── audit trail (lazy — loads when opened) ──────────────────────────────────
function Audit({ scope, entityId, rules }) {
  const [items, setItems] = useState(null);
  useEffect(() => { api.modAudit(scope, entityId, { limit: 100 }).then((r) => setItems(r.items || [])).catch(() => setItems([])); }, [scope, entityId]);
  const STATUS = {
    auto_blocked: ['⛔ auto-blocked', '#c62828'], pending: ['⏳ pending', '#8a6d00'],
    approved: ['✓ approved', '#1b8a4c'], declined: ['✕ removed', '#c62828'],
  };
  if (items == null) return <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</p>;
  if (items.length === 0) return <p style={{ color: 'var(--muted)', fontSize: 13.5, margin: 0 }}>Nothing yet — every automated decision and every human approve/decline lands here.</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {items.map((it) => {
        const [label, color] = STATUS[it.status] || [it.status, 'var(--muted)'];
        const matched = (it.evidence?.ruleIds || []).map((id) => (rules || []).find((r) => r.id === id)?.value).filter(Boolean);
        return (
          <div key={it.id} style={{ ...card, padding: '9px 12px', fontSize: 12.5, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline' }}>
            <span style={{ fontWeight: 700, color }}>{label}</span>
            <span>{TYPE_LABEL[it.contentType] || it.contentType}</span>
            <span style={{ color: 'var(--muted)', overflowWrap: 'anywhere', flex: 1, minWidth: 140 }}>
              {it.snapshot?.redacted ? '(redacted after retention)' : (it.snapshot?.text || it.snapshot?.name || it.snapshot?.emoji || '')}
              {matched.length > 0 && ` · matched: ${matched.join(', ')}`}
            </span>
            {it.reviewedBy && <span style={{ color: 'var(--muted)' }}>by {it.reviewedBy}</span>}
            <span style={{ color: 'var(--muted)' }}>{ago(it.createdAt)}</span>
          </div>
        );
      })}
    </div>
  );
}

const chip = (color, bg) => ({ display: 'inline-flex', alignItems: 'center', padding: '2px 9px', borderRadius: 980, fontSize: 11, fontWeight: 700, color, background: bg, whiteSpace: 'nowrap' });
const input = { boxSizing: 'border-box', fontFamily: 'inherit', fontSize: 13, color: 'var(--text)', background: 'var(--card)', border: '1px solid var(--hairline)', borderRadius: 9, padding: '9px 10px', minHeight: 40 };
const mini = { padding: '8px 12px', borderRadius: 8, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer', minHeight: 40 };
const tiny = { padding: '6px 9px', borderRadius: 7, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 12, cursor: 'pointer', minHeight: 36 };
const primary = { padding: '9px 16px', borderRadius: 980, border: 'none', background: 'var(--brand)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', minHeight: 40 };
const card = { border: '1px solid var(--hairline)', borderRadius: 12, background: 'var(--card)', padding: '12px 14px' };
