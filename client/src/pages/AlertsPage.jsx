import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useProfile } from '../lib/profile.jsx';
import HomeButton from '../components/HomeButton.jsx';
import AlertEditor from '../components/AlertEditor.jsx';

// The Alerts surface (insight → action). Grouped by event, like Goals: each event
// lists its metric watchers, with a one-tap "New alert". An alert is a saved rule
// over a dashboard tile's live number — Pulse evaluates it in the background and
// pings the team the moment it crosses. Dual-surface: the same page serves a client
// self-serving and a Howler admin (scoped to the active client by the profile).
// Deep link: ?new=<suiteId> opens the editor for that event.
export default function AlertsPage() {
  const { activeEntityId } = useProfile();
  const [suites, setSuites] = useState([]);
  const [bySuite, setBySuite] = useState({}); // suiteId -> { alerts, canManage, smsAvailable }
  const [editor, setEditor] = useState(null);  // { suiteId, alert, template } | null
  const [suitesLoading, setSuitesLoading] = useState(true);
  const [params, setParams] = useSearchParams();
  const handled = useRef(false);
  const [tab, setTab] = useState('alerts');         // 'alerts' | 'templates'
  const [templates, setTemplates] = useState(null);  // reusable templates (this client + global)

  useEffect(() => { api.mySuites().then(setSuites).catch(() => {}).finally(() => setSuitesLoading(false)); }, []);
  const visibleSuites = activeEntityId ? suites.filter((s) => s.entityId === activeEntityId) : suites;

  const loadTemplates = useCallback(() => {
    if (!activeEntityId) { setTemplates([]); return; }
    api.alertTemplates(activeEntityId).then((r) => setTemplates(r.templates || [])).catch(() => setTemplates([]));
  }, [activeEntityId]);
  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  const loadSuite = useCallback((sid) => {
    api.suiteAlerts(sid).then((r) => setBySuite((m) => ({ ...m, [sid]: r }))).catch(() => {});
  }, []);
  useEffect(() => { visibleSuites.forEach((s) => loadSuite(s.id)); }, [visibleSuites.map((s) => s.id).join(','), loadSuite]); // eslint-disable-line react-hooks/exhaustive-deps
  const reloadAll = () => visibleSuites.forEach((s) => loadSuite(s.id));

  const rows = visibleSuites.map((s) => ({ suite: s, alerts: [], canManage: false, smsAvailable: false, loaded: bySuite[s.id] !== undefined, ...(bySuite[s.id] || {}) }));

  // Deep link from a teaser/onboarding: ?new=<suiteId> opens the editor.
  useEffect(() => {
    if (handled.current || !rows.length) return;
    const newSuite = params.get('new');
    if (newSuite) {
      const target = rows.find((r) => r.suite.id === newSuite && r.canManage) || rows.find((r) => r.canManage);
      if (target) { setEditor({ suiteId: target.suite.id, alert: null }); handled.current = true; const next = new URLSearchParams(params); next.delete('new'); setParams(next, { replace: true }); }
    }
  }, [rows, params, setParams]);

  const toggleStatus = (alert) => {
    api.setAlertStatus(alert.id, alert.status === 'paused' ? 'active' : 'paused')
      .then(() => loadSuite(alert.suiteId)).catch((e) => window.alert(e.message));
  };

  // Start a new alert from a saved template — attach it to a manageable event.
  const useTemplate = (t) => {
    const sid = (rows.find((r) => r.canManage)?.suite.id) || visibleSuites[0]?.id;
    if (!sid) { window.alert('Add an event first, then create an alert from a template.'); return; }
    setTab('alerts');
    setEditor({ suiteId: sid, alert: null, template: t.payload });
  };
  const deleteTpl = (t) => {
    if (!window.confirm(`Delete template “${t.payload?.name || t.name}”?`)) return;
    api.deleteAlertTemplate(t.id).then(() => setTemplates((x) => (x || []).filter((y) => y.id !== t.id))).catch((e) => window.alert(e.message));
  };

  return (
    <div style={{ maxWidth: 920, margin: '0 auto', padding: '4px 2px 40px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '6px 0 12px' }}>
        <HomeButton />
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--muted)', marginBottom: 2 }}>Action</div>
          <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em' }}>Alerts</h1>
        </div>
      </div>
      <p style={{ color: 'var(--muted)', fontSize: 13.5, margin: '0 0 18px', lineHeight: 1.5 }}>
        Get a tap on the shoulder the moment a number matters — a sell-out, a revenue milestone, stock running low.
        Pulse watches the metric for you (checked every few minutes) and tells you on your phone, by email or SMS.
      </p>

      {/* Tabs: live alerts vs the reusable templates available to this client. */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 18, borderBottom: '1px solid var(--hairline)' }}>
        <TabBtn active={tab === 'alerts'} onClick={() => setTab('alerts')}>Alerts</TabBtn>
        <TabBtn active={tab === 'templates'} onClick={() => setTab('templates')}>Templates{templates && templates.length ? ` (${templates.length})` : ''}</TabBtn>
      </div>

      {tab === 'templates' && (
        <TemplatesView templates={templates} canUse={rows.some((r) => r.canManage) || visibleSuites.length > 0} onUse={useTemplate} onDelete={deleteTpl} />
      )}

      {tab === 'alerts' && (<>
      {suitesLoading && <Skel w="100%" h={90} r={14} />}

      {!suitesLoading && !rows.length && (
        <div style={empty}>No events yet. Once you have an event, set its first alert here.</div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
        {rows.map(({ suite, alerts = [], canManage, smsAvailable, loaded }) => (
          <section key={suite.id}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <h2 style={eventName}>{suite.name}</h2>
              <span style={{ flex: 1 }} />
              {loaded && canManage && (
                <button onClick={() => setEditor({ suiteId: suite.id, alert: null })} style={addBtn}>＋ {alerts.length ? 'Add an alert' : 'New alert'}</button>
              )}
            </div>
            {!loaded && <Skel w="100%" h={68} r={12} />}
            {loaded && (alerts.length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {alerts.map((a) => (
                  <AlertRow key={a.id} alert={a} canManage={canManage} onEdit={() => setEditor({ suiteId: suite.id, alert: a })} onToggle={() => toggleStatus(a)} />
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>No alerts yet — set one and we’ll watch the number for you.</div>
            ))}
          </section>
        ))}
      </div>
      </>)}

      {editor && (
        <AlertEditor
          entityId={suites.find((s) => s.id === editor.suiteId)?.entityId || activeEntityId}
          suiteId={editor.suiteId}
          suiteName={suites.find((s) => s.id === editor.suiteId)?.name}
          alert={editor.alert}
          initialTemplate={editor.template || null}
          smsAvailable={!!bySuite[editor.suiteId]?.smsAvailable}
          slackAvailable={!!bySuite[editor.suiteId]?.slackAvailable}
          onClose={() => setEditor(null)}
          onSaved={() => { reloadAll(); loadTemplates(); }}
        />
      )}
    </div>
  );
}

// One alert as a row: name, the rule in a sentence, a live status chip, and the
// channels + last fire. Tap to edit; the ⏸/▶ pauses without losing the rule.
function AlertRow({ alert, canManage, onEdit, onToggle }) {
  const chip = alert.status === 'paused' ? { label: 'Paused', bg: 'rgba(128,128,128,0.15)', fg: 'var(--muted)' }
    : alert.state === 'triggered' ? { label: 'Triggered', bg: 'rgba(220,38,38,0.12)', fg: 'var(--error, #dc2626)' }
      : { label: 'Watching', bg: 'rgba(16,185,129,0.12)', fg: '#059669' };
  const chIcon = { push: '📱', email: '✉️', sms: '💬' };
  return (
    <div style={card}>
      <div role="button" tabIndex={0} onClick={canManage ? onEdit : undefined} onKeyDown={(e) => { if (canManage && (e.key === 'Enter' || e.key === ' ')) onEdit(); }} style={{ flex: 1, minWidth: 0, cursor: canManage ? 'pointer' : 'default' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 700, fontSize: 14.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{alert.name}</span>
          <span style={{ fontSize: 10.5, fontWeight: 800, padding: '2px 8px', borderRadius: 980, background: chip.bg, color: chip.fg }}>{chip.label}</span>
          {alert.priority === 'important' && <span title="Important — ignores quiet hours" style={{ fontSize: 11 }}>🔴</span>}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 3, lineHeight: 1.4 }}>{ruleText(alert)}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, fontSize: 11.5, color: 'var(--muted)', flexWrap: 'wrap' }}>
          <span>🗂 inbox{(alert.channels || []).map((c) => ` · ${chIcon[c] || ''} ${c}`).join('')}</span>
          {alert.lastValue != null && <span>· now {fmtNum(alert.lastValue, alert.unit)}</span>}
          {alert.fireCount > 0 && <span>· fired {alert.fireCount}×{alert.lastFiredAt ? ` · last ${rel(alert.lastFiredAt)}` : ''}</span>}
        </div>
      </div>
      {canManage && (
        <button onClick={onToggle} style={iconBtn} title={alert.status === 'paused' ? 'Resume' : 'Pause'} aria-label={alert.status === 'paused' ? 'Resume' : 'Pause'}>
          {alert.status === 'paused' ? '▶' : '⏸'}
        </button>
      )}
    </div>
  );
}

function ruleText(a) {
  const metric = (a.source === 'metric' ? a.metricLabel : a.tileName) || 'the number';
  const t = fmtNum(a.threshold, a.unit);
  if (a.ruleType === 'sold_out') return `When ${metric} sells out`;
  if (a.ruleType === 'depletion') return `When ${metric} drops below ${t}`;
  return `When ${metric} ${(a.operator === 'lte' || a.operator === 'lt') ? 'drops to' : 'reaches'} ${t}`;
}
function fmtNum(v, unit) {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  const s = Math.abs(n) >= 1000 ? Math.round(n).toLocaleString('en-ZA') : String(n);
  if (unit === 'ZAR') return `R${s}`;
  if (unit === '%') return `${s}%`;
  return unit && unit !== 'count' ? `${s} ${unit}` : s;
}
function rel(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function Skel({ w = '100%', h = 14, r = 8, style }) { return <div className="skel" style={{ width: w, height: h, borderRadius: r, ...style }} />; }

function TabBtn({ active, onClick, children }) {
  return (
    <button type="button" onClick={onClick} style={{
      border: 'none', background: 'none', cursor: 'pointer', font: 'inherit', padding: '8px 4px', marginBottom: -1,
      fontSize: 14, fontWeight: active ? 800 : 600, color: active ? 'var(--text)' : 'var(--muted)',
      borderBottom: `2px solid ${active ? 'var(--brand)' : 'transparent'}`,
    }}>{children}</button>
  );
}

// Reusable alert templates — this client's own plus 🌐 global ones. Tap to start a
// new alert from one; delete removes it (global ones admin-only, enforced server-side).
function TemplatesView({ templates, canUse, onUse, onDelete }) {
  if (templates === null) return <Skel w="100%" h={60} r={12} />;
  if (!templates.length) {
    return (
      <div style={empty}>
        No templates yet. Build an alert, then tap <b>📑 Template</b> in its editor to save the setup here and reuse it.
      </div>
    );
  }
  const desc = (p = {}) => {
    const bits = [];
    if (p.source === 'metric' && p.metricRef?.metricLabel) bits.push(p.metricRef.metricLabel);
    else if (p.source === 'tile' && p.tileRef?.tileName) bits.push(p.tileRef.tileName);
    if (p.threshold != null && p.ruleType !== 'sold_out') bits.push(`${p.ruleType === 'depletion' ? 'below ' : ''}${p.threshold}${p.unit && p.unit !== 'count' ? ` ${p.unit}` : ''}`);
    if (p.ruleType === 'sold_out') bits.push('sold out');
    return bits.join(' · ');
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {templates.map((t) => (
        <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 12, border: '1px solid var(--hairline)', borderRadius: 12, background: 'var(--card)', padding: '12px 14px' }}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              {t.global && <span title="Global template (available to every client)" style={{ fontSize: 10, fontWeight: 800, color: 'var(--brand)', border: '1px solid var(--hairline)', borderRadius: 980, padding: '1px 7px' }}>🌐 GLOBAL</span>}
              <span style={{ fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.payload?.name || t.name}</span>
            </span>
            {desc(t.payload) && <span style={{ display: 'block', fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>{desc(t.payload)}</span>}
          </span>
          {canUse && <button onClick={() => onUse(t)} style={addBtn}>＋ Use</button>}
          <button onClick={() => onDelete(t)} aria-label="Delete template" style={{ border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer', fontSize: 13, padding: 4 }}>🗑</button>
        </div>
      ))}
    </div>
  );
}

const eventName = { fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--muted)' };
const addBtn = { border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--brand)', borderRadius: 9, fontSize: 12.5, fontWeight: 700, padding: '6px 11px', cursor: 'pointer', flexShrink: 0 };
const card = { display: 'flex', alignItems: 'center', gap: 12, border: '1px solid var(--hairline)', borderRadius: 12, background: 'var(--card)', padding: '12px 14px' };
const iconBtn = { border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', borderRadius: 9, width: 38, height: 34, fontSize: 13, cursor: 'pointer', flexShrink: 0 };
const empty = { padding: '28px 18px', textAlign: 'center', color: 'var(--muted)', border: '1px dashed var(--hairline)', borderRadius: 14 };
