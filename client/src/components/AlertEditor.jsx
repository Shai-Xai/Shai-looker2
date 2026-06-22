import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api.js';
import { useIsMobile } from '../lib/useIsMobile.js';

// Set or edit a metric alert (insight → action). Like the goal editor, you point
// it at a single-value (KPI) tile you already look at — the alert watches that live
// number and pings you when it crosses a line. Dual-surface: identical for a client
// self-serving and an admin acting on their behalf; the server guard decides who may
// write. `entityId` scopes the tile catalogue; `suiteId` is the event it belongs to.
//
// Mobile-first: a single stacked column, a template gallery so setup is a tap +
// one number, and a plain-English preview so the rule always reads back clearly.

// Pre-baked starting points — the common moments, so a client rarely starts blank.
const TEMPLATES = [
  { key: 'soldout', emoji: '🎉', label: 'Sold out', hint: 'When it hits zero', ruleType: 'sold_out', unit: 'tickets', name: 'Sold out' },
  { key: 'revenue', emoji: '💰', label: 'Revenue milestone', hint: 'When revenue crosses a number', ruleType: 'threshold', operator: 'gte', unit: 'ZAR', name: 'Revenue milestone' },
  { key: 'lowstock', emoji: '⚠️', label: 'Low stock', hint: 'When tickets left drop below', ruleType: 'depletion', unit: 'tickets', name: 'Low stock' },
  { key: 'target', emoji: '🎯', label: 'Sales target', hint: 'When tickets sold reach', ruleType: 'threshold', operator: 'gte', unit: 'tickets', name: 'Sales target' },
];

export default function AlertEditor({ entityId, suiteId, suiteName, alert, smsAvailable = false, onClose, onSaved }) {
  const isMobile = useIsMobile();
  const editing = !!alert;

  const [name, setName] = useState(alert?.name || '');
  const [ruleType, setRuleType] = useState(alert?.ruleType || 'threshold');
  const [dashboardId, setDashboardId] = useState(alert?.dashboardId || '');
  const [tileId, setTileId] = useState(alert?.tileId || '');
  const [operator, setOperator] = useState(alert?.operator || 'gte');
  const [threshold, setThreshold] = useState(alert ? String(alert.threshold ?? '') : '');
  const [unit, setUnit] = useState(alert?.unit || 'tickets');
  const [channels, setChannels] = useState(alert?.channels || ['push']);
  const [smsRecipients, setSmsRecipients] = useState((alert?.smsRecipients || []).join(', '));
  const [priority, setPriority] = useState(alert?.priority || 'normal');
  const [frequency, setFrequency] = useState(alert?.frequency || 'once');
  const [cooldownMin, setCooldownMin] = useState(alert?.cooldownMin != null ? String(alert.cooldownMin) : '60');
  const [quietStart, setQuietStart] = useState(alert?.quietStart || '');
  const [quietEnd, setQuietEnd] = useState(alert?.quietEnd || '');

  const [cat, setCat] = useState(null);          // tile catalogue { dashboards: [...] }
  const [preview, setPreview] = useState(null);   // live value of the picked target

  // Custom-metric source (alert on a raw measure + dimension filter, no tile).
  const [source, setSource] = useState(alert?.source || 'tile');   // 'tile' | 'metric'
  const [exCat, setExCat] = useState(null);        // { explores: [...] }
  const [exKey, setExKey] = useState(alert?.source === 'metric' && alert?.model ? `${alert.model}::${alert.view}` : '');
  const [measure, setMeasure] = useState(alert?.measure || '');
  const [mFilters, setMFilters] = useState(() => Object.entries(alert?.metricFilters || {}).map(([field, value]) => ({ field, value })));
  const [filterVals, setFilterVals] = useState({}); // dimensionField -> [values] | 'loading'

  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [err, setErr] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);

  // Load the client's dashboards/tiles for the tile picker (once, when used).
  useEffect(() => { if (source === 'tile' && !cat && entityId) api.getMyDigestTiles(entityId).then(setCat).catch(() => setCat({ dashboards: [] })); }, [source, cat, entityId]);
  // Load the metric catalogue (explores the client already uses) when building a metric.
  useEffect(() => { if (source === 'metric' && !exCat && suiteId) api.alertMetricCatalog(suiteId).then(setExCat).catch(() => setExCat({ explores: [] })); }, [source, exCat, suiteId]);

  // The chosen explore + its measures/dimensions.
  const explores = exCat?.explores || [];
  const curExplore = explores.find((e) => `${e.model}::${e.view}` === exKey) || null;
  const measuresFor = () => curExplore?.measures || [];
  const dimsFor = () => curExplore?.dimensions || [];
  const measureObj = () => measuresFor().find((m) => m.name === measure) || null;
  const dimLabel = (name) => dimsFor().find((d) => d.name === name)?.label || name;
  const metricFiltersObj = () => { const o = {}; for (const f of mFilters) if (f.field && f.value) o[f.field] = f.value; return o; };
  const metricLabelStr = () => {
    const ml = measureObj()?.label || '';
    const fs = mFilters.filter((f) => f.field && f.value).map((f) => `${dimLabel(f.field)} = ${f.value}`);
    return fs.length ? `${ml} · ${fs.join(', ')}` : ml;
  };
  // Lazily fetch the distinct values for a filter dimension (scoped to this event).
  const loadFilterVals = (field) => {
    if (!field || filterVals[field] || !curExplore) return;
    setFilterVals((m) => ({ ...m, [field]: 'loading' }));
    api.alertMetricFilterValues(suiteId, { model: curExplore.model, view: curExplore.view, field })
      .then((r) => setFilterVals((m) => ({ ...m, [field]: r.values || [] })))
      .catch(() => setFilterVals((m) => ({ ...m, [field]: [] })));
  };
  const setFilter = (i, patch) => setMFilters((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const addFilter = () => setMFilters((fs) => [...fs, { field: '', value: '' }]);
  const removeFilter = (i) => setMFilters((fs) => fs.filter((_, j) => j !== i));

  // Live value of the chosen target (tile OR built metric), so the threshold is set
  // against the real number.
  useEffect(() => {
    let alive = true;
    const done = (v) => { if (alive) setPreview(v); };
    if (source === 'tile') {
      if (!dashboardId || !tileId || !suiteId) { setPreview(null); return undefined; }
      setPreview({ loading: true });
      api.alertTileValue(suiteId, dashboardId, tileId).then((r) => done({ value: r.value })).catch(() => done({ value: null }));
    } else {
      if (!curExplore || !measure || !suiteId) { setPreview(null); return undefined; }
      setPreview({ loading: true });
      api.alertMetricValue(suiteId, { model: curExplore.model, view: curExplore.view, measure, filters: metricFiltersObj() })
        .then((r) => done({ value: r.value })).catch(() => done({ value: null }));
    }
    return () => { alive = false; };
  }, [source, dashboardId, tileId, suiteId, exKey, measure, JSON.stringify(mFilters)]); // eslint-disable-line react-hooks/exhaustive-deps

  const dashboards = cat?.dashboards || [];
  // An alert watches ONE headline number, so only single-value (KPI) tiles qualify
  // (mirrors the goal editor's test).
  const isKpi = (t) => { const v = t.visType || ''; return v === 'single_value' || v === 'single_value_period_over_period' || v.includes('bar_gauge'); };
  const tilesFor = (dId) => (dashboards.find((d) => d.dashboardId === dId)?.tiles || []).filter(isKpi);
  const tileName = () => { const d = dashboards.find((x) => x.dashboardId === dashboardId); return d?.tiles?.find((x) => x.tileId === tileId)?.title || ''; };
  const dashName = () => dashboards.find((x) => x.dashboardId === dashboardId)?.title || '';

  const applyTemplate = (t) => {
    setRuleType(t.ruleType);
    if (t.operator) setOperator(t.operator);
    if (t.unit) setUnit(t.unit);
    if (!name) setName(t.name);
    if (t.ruleType === 'sold_out') setThreshold('0');
  };

  const toggleChannel = (c) => setChannels((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]));

  // The plain-English read-back of the rule (always visible, so it's never a mystery).
  const sentence = () => {
    const metric = (source === 'metric' ? metricLabelStr() : tileName()) || 'the number';
    const tval = threshold === '' ? '…' : fmtNum(Number(threshold), unit);
    let when;
    if (ruleType === 'sold_out') when = `${metric} sells out`;
    else if (ruleType === 'depletion') when = `${metric} drops below ${tval}`;
    else when = `${metric} ${operator === 'lte' || operator === 'lt' ? 'drops to' : 'reaches'} ${tval}`;
    const via = ['in your inbox', ...channels.map((c) => ({ push: 'push', email: 'email', sms: 'SMS' }[c]))].filter(Boolean);
    const viaTxt = via.length > 1 ? `${via.slice(0, -1).join(', ')} and ${via[via.length - 1]}` : via[0];
    const freq = frequency === 'once' ? 'once' : `repeatedly (max once per ${cooldownMin || 60} min)`;
    return `When ${when}, notify me via ${viaTxt} — ${freq}.`;
  };

  async function save() {
    if (!name.trim()) { setErr('Give the alert a name.'); return; }
    if (source === 'metric') { if (!curExplore || !measure) { setErr('Pick the metric to watch.'); return; } }
    else if (!dashboardId || !tileId) { setErr('Pick the dashboard tile to watch.'); return; }
    if (ruleType !== 'sold_out' && (threshold === '' || Number.isNaN(Number(threshold)))) { setErr('Set a number to alert on.'); return; }
    if (!channels.length) { setErr('Pick at least one way to be notified (or just the inbox stays on).'); }
    setBusy(true); setErr('');
    const body = {
      name: name.trim(), ruleType, source,
      operator: ruleType === 'depletion' || ruleType === 'sold_out' ? 'lte' : operator,
      threshold: ruleType === 'sold_out' ? 0 : Number(threshold),
      unit, channels,
      smsRecipients: channels.includes('sms') ? smsRecipients.split(',').map((s) => s.trim()).filter(Boolean) : [],
      priority, frequency,
      cooldownMin: Number(cooldownMin) || 60,
      quietStart, quietEnd,
    };
    if (source === 'metric') {
      body.model = curExplore.model; body.view = curExplore.view; body.measure = measure;
      body.measureLabel = measureObj()?.label || ''; body.metricFilters = metricFiltersObj(); body.metricLabel = metricLabelStr();
    } else {
      body.dashboardId = dashboardId; body.tileId = tileId; body.dashboardName = dashName(); body.tileName = tileName();
    }
    try {
      if (editing) await api.updateAlert(alert.id, body);
      else await api.createAlert(suiteId, body);
      onSaved?.(); onClose();
    } catch (e) { setErr(e.message || 'Could not save the alert.'); setBusy(false); }
  }

  async function del() {
    setBusy(true); setErr('');
    try { await api.deleteAlert(alert.id); onSaved?.(); onClose(); }
    catch (e) { setErr(e.message || 'Could not delete the alert.'); setBusy(false); }
  }

  async function test() {
    if (!editing) { setErr('Save the alert first, then send a test.'); return; }
    setTesting(true); setErr('');
    try {
      const r = await api.testAlert(alert.id);
      window.alert(`Test sent.\n\n“${r.message}”\n\nDelivered via: ${(r.channels || []).join(', ') || 'inbox'}`);
    } catch (e) { setErr(e.message || 'Could not send a test.'); }
    finally { setTesting(false); }
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div style={{ ...sheet, maxWidth: isMobile ? '100%' : 460 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
          <span style={{ fontSize: 20 }}>🔔</span>
          <h2 style={{ fontSize: 17, fontWeight: 800, flex: 1 }}>{editing ? 'Edit alert' : 'New alert'}{suiteName ? <span style={{ fontWeight: 600, color: 'var(--muted)', fontSize: 13 }}> · {suiteName}</span> : null}</h2>
          <button onClick={onClose} style={xBtn} aria-label="Close">✕</button>
        </div>

        {/* Template gallery — tap a starting point, then tweak one number. */}
        {!editing && (
          <Field label="Start from">
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : '1fr 1fr', gap: 8 }}>
              {TEMPLATES.map((t) => (
                <button key={t.key} type="button" onClick={() => applyTemplate(t)} style={tmplCard(ruleType === t.ruleType)}>
                  <span style={{ fontSize: 18 }}>{t.emoji}</span>
                  <span style={{ fontWeight: 700, fontSize: 13 }}>{t.label}</span>
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>{t.hint}</span>
                </button>
              ))}
            </div>
          </Field>
        )}

        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. VIP nearly gone, R1m revenue" style={inp} autoFocus />
        </Field>

        <Field label="What should we watch?">
          <div style={{ display: 'flex', gap: 8 }}>
            <Seg active={source === 'tile'} onClick={() => setSource('tile')}>📊 A dashboard tile</Seg>
            <Seg active={source === 'metric'} onClick={() => setSource('metric')}>🧩 Build a metric</Seg>
          </div>
        </Field>

        {source === 'tile' ? (
          <Field label="Which tile?" hint="Pick a single-value (KPI) tile you already look at — the alert watches that live number.">
            <select value={dashboardId} onChange={(e) => { setDashboardId(e.target.value); setTileId(''); }} style={inp}>
              <option value="">{cat ? 'Choose a dashboard…' : 'Loading…'}</option>
              {dashboards.map((d) => <option key={d.dashboardId} value={d.dashboardId}>{d.title}{d.setName ? ` · ${d.setName}` : ''}</option>)}
            </select>
            {dashboardId && (tilesFor(dashboardId).length ? (
              <select value={tileId} onChange={(e) => setTileId(e.target.value)} style={{ ...inp, marginTop: 8 }}>
                <option value="">Choose a tile…</option>
                {tilesFor(dashboardId).map((t) => <option key={t.tileId} value={t.tileId}>{t.title}</option>)}
              </select>
            ) : (
              <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)', lineHeight: 1.4 }}>
                No single-value (KPI) tiles on this dashboard. Alerts watch one headline number — pick a dashboard with a KPI tile, or “Build a metric”.
              </div>
            ))}
          </Field>
        ) : (
          <Field label="Build the metric" hint="Pick a measure and (optionally) filter it — e.g. tickets sold where Ticket Type = VIP. No tile needed.">
            <select value={exKey} onChange={(e) => { setExKey(e.target.value); setMeasure(''); setMFilters([]); }} style={inp}>
              <option value="">{exCat ? 'Choose a data source…' : 'Loading…'}</option>
              {explores.map((e) => <option key={`${e.model}::${e.view}`} value={`${e.model}::${e.view}`}>{e.label}</option>)}
            </select>
            {exCat && !explores.length && (
              <div style={{ marginTop: 8, fontSize: 12, color: 'var(--muted)', lineHeight: 1.4 }}>
                No data sources available yet (these come from your existing dashboards). Use “A dashboard tile” instead.
              </div>
            )}
            {curExplore && (
              <select value={measure} onChange={(e) => { setMeasure(e.target.value); const m = measuresFor().find((x) => x.name === e.target.value); if (m && /revenue|amount|sales|gross|net|value|spend/i.test(`${m.label} ${m.name}`)) setUnit('ZAR'); }} style={{ ...inp, marginTop: 8 }}>
                <option value="">Choose a measure…</option>
                {measuresFor().map((m) => <option key={m.name} value={m.name}>{m.label}</option>)}
              </select>
            )}
            {curExplore && measure && (
              <div style={{ marginTop: 10 }}>
                {mFilters.map((f, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                    <select value={f.field} onChange={(e) => { setFilter(i, { field: e.target.value, value: '' }); loadFilterVals(e.target.value); }} style={{ ...inp, flex: 1 }}>
                      <option value="">Filter by…</option>
                      {dimsFor().map((d) => <option key={d.name} value={d.name}>{d.label}</option>)}
                    </select>
                    {f.field && (
                      Array.isArray(filterVals[f.field])
                        ? <select value={f.value} onChange={(e) => setFilter(i, { value: e.target.value })} style={{ ...inp, flex: 1 }}>
                            <option value="">{filterVals[f.field].length ? 'Choose a value…' : 'type below'}</option>
                            {filterVals[f.field].map((v) => <option key={v} value={v}>{v}</option>)}
                          </select>
                        : <input value={f.value} onChange={(e) => setFilter(i, { value: e.target.value })} placeholder={filterVals[f.field] === 'loading' ? 'loading values…' : 'value (e.g. VIP)'} style={{ ...inp, flex: 1 }} />
                    )}
                    <button type="button" onClick={() => removeFilter(i)} aria-label="Remove filter" style={msX}>✕</button>
                  </div>
                ))}
                <button type="button" onClick={addFilter} style={addFilterBtn}>＋ Add a filter (e.g. Ticket Type, Category)</button>
              </div>
            )}
          </Field>
        )}

        {/* Shared live-value box — what the chosen target reads right now. */}
        {((source === 'tile' && tileId) || (source === 'metric' && measure)) && (
          <div style={readsBox}>
            <span style={{ color: 'var(--muted)', fontWeight: 600 }}>This reads:</span>
            {preview?.loading ? <span style={{ color: 'var(--muted)' }}>reading…</span>
              : preview && preview.value != null ? <b style={{ fontSize: 15 }}>{fmtNum(preview.value, unit)}</b>
                : <span style={{ color: 'var(--muted)' }}>— couldn't read it right now</span>}
            <span style={{ flex: 1 }} />
            {preview && preview.value != null && threshold === '' && ruleType !== 'sold_out' && (
              <button type="button" onClick={() => setThreshold(String(Math.round(Number(preview.value))))} style={miniBtn}>Use as start</button>
            )}
          </div>
        )}

        <Field label="Alert me when…">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Seg active={ruleType === 'threshold'} onClick={() => setRuleType('threshold')}>📈 Crosses a number</Seg>
            <Seg active={ruleType === 'depletion'} onClick={() => setRuleType('depletion')}>⚠️ Drops below</Seg>
            <Seg active={ruleType === 'sold_out'} onClick={() => { setRuleType('sold_out'); setThreshold('0'); }}>🎉 Sold out</Seg>
          </div>
        </Field>

        {ruleType === 'threshold' && (
          <div style={{ display: 'flex', gap: 10 }}>
            <Field label="Direction" style={{ flex: 1 }}>
              <select value={operator} onChange={(e) => setOperator(e.target.value)} style={inp}>
                <option value="gte">Rises to / above ↑</option>
                <option value="lte">Drops to / below ↓</option>
              </select>
            </Field>
            <Field label="Number" style={{ flex: 1 }}>
              <input value={threshold} onChange={(e) => setThreshold(e.target.value)} placeholder="e.g. 5000" inputMode="decimal" style={inp} />
            </Field>
            <Field label="Unit" style={{ width: 96 }}>
              <UnitSelect unit={unit} setUnit={setUnit} />
            </Field>
          </div>
        )}
        {ruleType === 'depletion' && (
          <div style={{ display: 'flex', gap: 10 }}>
            <Field label="When fewer than" style={{ flex: 1 }}>
              <input value={threshold} onChange={(e) => setThreshold(e.target.value)} placeholder="e.g. 100" inputMode="decimal" style={inp} />
            </Field>
            <Field label="Unit" style={{ width: 96 }}>
              <UnitSelect unit={unit} setUnit={setUnit} />
            </Field>
          </div>
        )}
        {ruleType === 'sold_out' && (
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12, lineHeight: 1.45 }}>
            Fires the moment this number hits zero — the big one. No threshold to set.
          </div>
        )}

        <Field label="How should we tell you?" hint="It always lands in your Pulse inbox. Add any of these on top.">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Chip active={channels.includes('push')} onClick={() => toggleChannel('push')}>📱 Push</Chip>
            <Chip active={channels.includes('email')} onClick={() => toggleChannel('email')}>✉️ Email</Chip>
            <Chip active={channels.includes('sms')} onClick={() => toggleChannel('sms')} disabled={!smsAvailable} title={smsAvailable ? '' : 'SMS isn’t configured for this client yet'}>💬 SMS</Chip>
          </div>
          {channels.includes('sms') && (
            <input value={smsRecipients} onChange={(e) => setSmsRecipients(e.target.value)} placeholder="Mobile numbers, comma-separated (e.g. 0821234567)" style={{ ...inp, marginTop: 8 }} />
          )}
        </Field>

        <div style={{ display: 'flex', gap: 10 }}>
          <Field label="Importance" hint="Important alerts ignore quiet hours." style={{ flex: 1 }}>
            <select value={priority} onChange={(e) => setPriority(e.target.value)} style={inp}>
              <option value="normal">Normal</option>
              <option value="important">Important (always reach me)</option>
            </select>
          </Field>
          <Field label="How often" style={{ flex: 1 }}>
            <select value={frequency} onChange={(e) => setFrequency(e.target.value)} style={inp}>
              <option value="once">Once, then rest</option>
              <option value="repeat">Every time it crosses</option>
            </select>
          </Field>
        </div>

        {frequency === 'repeat' && (
          <Field label="Cooldown (minutes)" hint="The least time between repeat alerts, so a busy on-sale can’t spam you.">
            <input value={cooldownMin} onChange={(e) => setCooldownMin(e.target.value)} inputMode="numeric" style={inp} />
          </Field>
        )}

        <Field label="Quiet hours (optional)" hint="Hold non-important alerts during these hours (your timezone). Leave blank for none.">
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <input type="time" value={quietStart} onChange={(e) => setQuietStart(e.target.value)} style={{ ...inp, flex: 1 }} />
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>to</span>
            <input type="time" value={quietEnd} onChange={(e) => setQuietEnd(e.target.value)} style={{ ...inp, flex: 1 }} />
          </div>
        </Field>

        {/* Plain-English read-back — the rule, in a sentence. */}
        <div style={sentenceBox}>{sentence()}</div>

        {err && <div style={{ color: 'var(--error, #dc2626)', fontSize: 12.5, marginTop: 10 }}>{err}</div>}

        <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center' }}>
          {editing && (confirmDel ? (
            <button onClick={del} disabled={busy} style={btnDanger}>Delete alert</button>
          ) : (
            <button onClick={() => setConfirmDel(true)} style={btnDelGhost} aria-label="Delete alert" title="Delete this alert">🗑</button>
          ))}
          {editing && <button onClick={test} disabled={testing} style={btnGhost} title="Send a test notification now">{testing ? 'Sending…' : '🔔 Test'}</button>}
          <button onClick={onClose} style={btnGhost}>Cancel</button>
          <button onClick={save} disabled={busy} style={btnPrimary}>{busy ? 'Saving…' : (editing ? 'Save alert' : 'Create alert')}</button>
        </div>
      </div>
    </div>
  );
}

function UnitSelect({ unit, setUnit }) {
  return (
    <select value={unit} onChange={(e) => setUnit(e.target.value)} style={inp}>
      {[...new Set(['tickets', 'ZAR', '%', 'orders', 'count', unit].filter(Boolean))].map((u) => <option key={u} value={u}>{u}</option>)}
    </select>
  );
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

function Field({ label, hint, children, style }) {
  return (
    <div style={{ marginBottom: 12, ...style }}>
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 5 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, lineHeight: 1.4 }}>{hint}</div>}
    </div>
  );
}
function Seg({ active, onClick, children }) {
  return (
    <button type="button" onClick={onClick} style={{
      flex: '1 1 auto', padding: '9px 8px', borderRadius: 10, fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
      border: `1.5px solid ${active ? 'var(--brand)' : 'var(--hairline)'}`,
      background: active ? 'rgba(var(--brand-rgb,10,132,255),0.10)' : 'var(--card)',
      color: active ? 'var(--brand)' : 'var(--text)',
    }}>{children}</button>
  );
}
function Chip({ active, onClick, disabled, title, children }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} style={{
      padding: '8px 13px', borderRadius: 980, fontSize: 12.5, fontWeight: 700, cursor: disabled ? 'not-allowed' : 'pointer',
      border: `1.5px solid ${active ? 'var(--brand)' : 'var(--hairline)'}`, opacity: disabled ? 0.45 : 1,
      background: active ? 'rgba(var(--brand-rgb,10,132,255),0.10)' : 'var(--card)',
      color: active ? 'var(--brand)' : 'var(--text)',
    }}>{children}</button>
  );
}
const tmplCard = (active) => ({
  display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start', textAlign: 'left',
  padding: '10px 12px', borderRadius: 12, cursor: 'pointer',
  border: `1.5px solid ${active ? 'var(--brand)' : 'var(--hairline)'}`,
  background: active ? 'rgba(var(--brand-rgb,10,132,255),0.07)' : 'var(--card)', color: 'var(--text)',
});

const overlay = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 100 };
const sheet = { width: '100%', maxHeight: '90vh', overflowY: 'auto', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 16, padding: '18px 18px 20px', boxShadow: 'var(--shadow-lg, 0 12px 40px rgba(0,0,0,0.28))', color: 'var(--text)' };
const inp = { width: '100%', boxSizing: 'border-box', padding: '9px 11px', border: '1.5px solid var(--hairline)', borderRadius: 9, fontSize: 14, outline: 'none', background: 'var(--card)', color: 'var(--text)', fontFamily: 'inherit' };
const xBtn = { border: 'none', background: 'rgba(128,128,128,0.12)', color: 'var(--muted-2)', borderRadius: 980, width: 28, height: 28, fontSize: 13, cursor: 'pointer' };
const readsBox = { marginTop: 9, padding: '8px 11px', background: 'rgba(128,128,128,0.07)', borderRadius: 9, fontSize: 13, display: 'flex', alignItems: 'center', gap: 7 };
const msX = { border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--muted)', borderRadius: 9, fontSize: 13, cursor: 'pointer', flexShrink: 0, width: 38 };
const addFilterBtn = { border: '1px dashed var(--hairline)', background: 'transparent', color: 'var(--brand)', borderRadius: 9, fontSize: 12, fontWeight: 700, padding: '7px 11px', cursor: 'pointer', width: '100%' };
const miniBtn = { border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--brand)', borderRadius: 980, fontSize: 11, fontWeight: 700, padding: '3px 9px', cursor: 'pointer' };
const sentenceBox = { marginTop: 6, padding: '11px 13px', background: 'rgba(var(--brand-rgb,10,132,255),0.07)', border: '1px solid var(--hairline)', borderRadius: 10, fontSize: 13, lineHeight: 1.5, fontWeight: 600 };
const btnGhost = { flex: '0 0 auto', padding: '10px 14px', borderRadius: 10, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--text)', fontSize: 13.5, fontWeight: 700, cursor: 'pointer' };
const btnDanger = { flex: '0 0 auto', padding: '10px 14px', borderRadius: 10, border: 'none', background: 'var(--error, #dc2626)', color: '#fff', fontSize: 13.5, fontWeight: 800, cursor: 'pointer' };
const btnDelGhost = { flex: '0 0 auto', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--hairline)', background: 'var(--card)', color: 'var(--error, #dc2626)', fontSize: 15, cursor: 'pointer' };
const btnPrimary = { flex: 1, padding: '10px 16px', borderRadius: 10, border: 'none', background: 'var(--brand)', color: '#fff', fontSize: 13.5, fontWeight: 800, cursor: 'pointer' };
