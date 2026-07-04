// ─── Signal report: a shareable, print-to-PDF device-health report + the ops
// digest that emails it to an outside party (the network / operations provider) ──
// SELF-CONTAINED, DISPOSABLE MODULE. Owns the `signal_digest` table and every
// /signal-report + /api/*/signal-report route. Mounted from index.js with one line.
//
// WHAT IT DOES
//   • Public report page — GET /signal-report/:suiteId/:token renders a token-gated,
//     self-contained HTML page: every station's online/offline-through-the-day strip
//     (built from Pulse's OWN observed log — no live Looker cost) grouped by zone,
//     with a "Download PDF" button (the browser's print-to-PDF). The link an outside
//     provider can open with no Pulse account; rotating the token revokes it.
//   • Ops digest — a per-event config (recipient emails + cadence + drop-alert) that
//     emails those recipients the headline numbers + the report link, both on a
//     schedule AND the moment signal flow drops below the event's target.
//
// Test mode (shared data_health flag) routes every email to the test inbox only, so
// nothing reaches a real provider until you go live.
//
// TO REMOVE: delete this file + its one-line mount; drop the signal_digest table.

const crypto = require('crypto');

const zoneOf = (name) => {
  const n = String(name || '').trim().toUpperCase();
  if (!n) return '—';
  const w = n.replace(/^(FOOD|RECYCLING|STORE|LOUNGE)\s+/, '').split(/\s+/)[0];
  return w.startsWith('GATE') ? 'GATES' : (w || '—');
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function mount(app, { db, auth, mailer = null, dataHealth = null, signalFlow = null }) {
  const sql = db.db;
  const now = () => new Date().toISOString();
  const enabled = () => db.getSetting('signal_report_enabled', '1') !== '0';
  const testMode = () => db.getSetting('data_health_test_mode', '1') !== '0';
  const testEmail = () => db.getSetting('data_health_test_email', 'shai.evian@howler.co.za');
  const baseUrl = () => (mailer && mailer.baseUrl ? mailer.baseUrl() : '') || '';

  sql.exec(`
    CREATE TABLE IF NOT EXISTS signal_digest (
      suite_id     TEXT PRIMARY KEY,
      entity_id    TEXT NOT NULL DEFAULT '',
      token        TEXT NOT NULL DEFAULT '',
      recipients   TEXT NOT NULL DEFAULT '[]',   -- external emails (the provider)
      cadence_min  INTEGER NOT NULL DEFAULT 0,    -- 0 = no scheduled digest
      drop_alert   INTEGER NOT NULL DEFAULT 1,    -- email the moment flow drops below target
      enabled      INTEGER NOT NULL DEFAULT 0,
      last_sched   TEXT NOT NULL DEFAULT '',
      last_flow    INTEGER,                        -- last observed flow %, to detect the drop crossing
      updated_at   TEXT NOT NULL DEFAULT ''
    );
  `);

  const newToken = () => crypto.randomBytes(9).toString('base64url');
  const parse = (s, f) => { try { const v = JSON.parse(s); return v == null ? f : v; } catch { return f; } };
  function cfg(suiteId) {
    let r = sql.prepare('SELECT * FROM signal_digest WHERE suite_id=?').get(suiteId);
    if (!r) {
      const su = db.getSuite(suiteId);
      sql.prepare('INSERT INTO signal_digest (suite_id, entity_id, token, updated_at) VALUES (?,?,?,?)')
        .run(suiteId, su ? su.entityId : '', newToken(), now());
      r = sql.prepare('SELECT * FROM signal_digest WHERE suite_id=?').get(suiteId);
    }
    return r;
  }
  const cfgView = (r) => ({
    suiteId: r.suite_id, token: r.token, recipients: parse(r.recipients, []),
    cadenceMin: r.cadence_min, dropAlert: !!r.drop_alert, enabled: !!r.enabled,
    link: `${baseUrl()}/signal-report/${r.suite_id}/${r.token}`, testMode: testMode(),
  });

  // ── build the report data from the observed log (no live Looker reads) ──
  function buildReport(suiteId) {
    const su = db.getSuite ? db.getSuite(suiteId) : null;
    const out = { suite: su ? su.name : 'Event', generatedAt: now(), zones: [], stations: 0, onNow: 0, openTotal: 0, closedDevices: 0, flow: null, target: 95 };
    if (!dataHealth || !dataHealth.healthSummary) return out;
    const list = dataHealth.healthSummary({ suiteId }).filter((m) => m.entityId);
    const stations = [];
    for (const lm of list) {
      const m = dataHealth.monitorById ? dataHealth.monitorById(lm.id) : null;
      if (!m || !m.rosterField) continue;
      let ob; try { ob = dataHealth.observedLog(m, dataHealth.obsSinceFor(m, 'start')); } catch { ob = null; }
      if (!ob || !ob.configured || !(ob.ticks || []).length) continue;
      const ticks = ob.ticks.slice(-120);
      const base = ob.ticks.length - ticks.length;
      const byStation = new Map();
      (ob.devices || []).forEach((dev) => { const s = dev.station || ''; if (!byStation.has(s)) byStation.set(s, []); byStation.get(s).push(new Set(dev.offAt || [])); });
      const closedMon = m.status === 'closed';
      for (const [sn, offSets] of byStation) {
        const total = offSets.length;
        const series = ticks.map((k, i) => { let off = 0; for (const s of offSets) if (s.has(base + i)) off += 1; return { off, on: Math.max(0, total - off) }; });
        // Grey only the trailing run where the station is FULLY dark — a single dead
        // device isn't "closed"; the station is still trading on its other devices.
        if (closedMon) { let last = -1; for (let i = 0; i < series.length; i++) if (series[i].on > 0) last = i; series.forEach((c, i) => { c.closed = i > last; }); }
        const openCk = series.filter((c) => !c.closed);
        const nowC = series[series.length - 1] || { on: 0, off: 0 };
        const name = sn || m.name;
        const isClosed = closedMon && !!nowC.closed;
        stations.push({
          name, zone: zoneOf(name), total, series, closed: isClosed,
          nowPct: total ? Math.round((nowC.on / total) * 100) : 0,
          minPct: openCk.length ? Math.round(Math.min(...openCk.map((c) => c.on / total)) * 100) : 100,
          onNow: nowC.on, t0: Date.parse(ticks[0].at || 0), tN: Date.parse(ticks[ticks.length - 1].at || 0),
        });
        if (isClosed) out.closedDevices += total; else { out.openTotal += total; out.onNow += nowC.on; }
      }
    }
    out.stations = stations.length;
    out.flow = out.openTotal ? Math.round((out.onNow / out.openTotal) * 100) : null;
    if (signalFlow) { try { out.target = signalFlow(suiteId).target || 95; } catch { /* default */ } }
    const zmap = new Map();
    for (const s of stations) { if (!zmap.has(s.zone)) zmap.set(s.zone, []); zmap.get(s.zone).push(s); }
    out.zones = [...zmap.entries()].map(([k, arr]) => {
      arr.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      const openS = arr.filter((s) => !s.closed);
      const on = openS.reduce((a, s) => a + s.onNow, 0), tot = openS.reduce((a, s) => a + s.total, 0);
      return { zone: k, stations: arr, pct: tot ? Math.round((on / tot) * 100) : null, dev: arr.reduce((a, s) => a + s.total, 0) };
    }).sort((a, b) => b.dev - a.dev);
    return out;
  }

  // A one-line text summary — the body of the email + the copy-to-share text.
  function summaryText(r) {
    const head = `📶 ${r.suite} — signal ${r.flow == null ? '—' : r.flow + '%'} (${r.onNow}/${r.openTotal} devices online, target ${r.target}%)`;
    const worst = [];
    for (const z of r.zones) for (const s of z.stations) if (!s.closed && s.nowPct < r.target) worst.push(`${s.name} ${s.nowPct}%`);
    return worst.length ? `${head}. Below target: ${worst.slice(0, 8).join(', ')}${worst.length > 8 ? ` +${worst.length - 8}` : ''}.` : `${head}. All open stations at or above target.`;
  }

  // ── the self-contained report page (print-to-PDF) ──
  function reportHtml(r, link) {
    const bars = (s) => s.series.map((c) => {
      const onPct = s.total ? Math.round((c.on / s.total) * 100) : 0;
      const col = c.closed ? '#9aa3af' : '#e5484d';
      const onCol = c.closed ? '#9aa3af' : '#1fa85a';
      return `<span class="b"><i style="height:${100 - onPct}%;background:${col}"></i><i style="height:${onPct}%;background:${onCol}"></i></span>`;
    }).join('');
    const rows = r.zones.map((z) => `
      <div class="zh"><span>${esc(z.zone)}</span><span class="hr"></span><span>${z.pct == null ? 'closed' : z.pct + '% online'}</span></div>
      ${z.stations.map((s) => `
        <div class="row">
          <div class="nm">${esc(s.name)}${s.closed ? '<b class="cl">Closed</b>' : ''}<span>${s.total} devices</span></div>
          <div class="strip">${bars(s)}</div>
          <div class="st ${s.closed ? 'muted' : s.nowPct >= r.target ? 'good' : s.nowPct >= 85 ? 'warn' : 'bad'}">${s.closed ? 'Closed' : s.nowPct + '%'}<span>low ${s.minPct}%</span></div>
        </div>`).join('')}`).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signal report · ${esc(r.suite)}</title><style>
  :root{--bg:#eef1f4;--card:#fff;--text:#131820;--muted:#5c6672;--hair:rgba(18,28,44,.1)}
  @media(prefers-color-scheme:dark){:root{--bg:#0b0d10;--card:#14171c;--text:#e9edf2;--muted:#98a2af;--hair:rgba(255,255,255,.1)}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-variant-numeric:tabular-nums}
  .wrap{max-width:940px;margin:0 auto;padding:24px 18px 60px}
  .top{display:flex;align-items:flex-end;gap:16px;flex-wrap:wrap;margin-bottom:16px}
  .eye{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
  h1{font-size:23px;font-weight:800;margin:2px 0 0}.sub{color:var(--muted);font-size:13px}
  .kpi{margin-left:auto;text-align:right}.kpi b{font-size:26px;font-weight:800}.kpi.good b{color:#1fa85a}.kpi.bad b{color:#e5484d}.kpi span{display:block;font-size:11px;color:var(--muted)}
  .btn{border:1px solid var(--hair);background:var(--card);color:var(--text);border-radius:9px;padding:9px 15px;font-size:13px;font-weight:700;cursor:pointer}
  .panel{background:var(--card);border:1px solid var(--hair);border-radius:14px;overflow:hidden}
  .zh{display:grid;grid-template-columns:150px 1fr 74px;gap:12px;align-items:center;padding:11px 14px 5px;font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}
  .zh .hr{height:1px;background:var(--hair)}.zh span:last-child{text-align:right;font-weight:700}
  .row{display:grid;grid-template-columns:150px 1fr 74px;gap:12px;align-items:center;padding:6px 14px;border-top:1px solid var(--hair)}
  .nm{font-size:13px;font-weight:650;min-width:0;overflow:hidden}.nm span{display:block;font-size:11px;color:var(--muted);font-weight:400}
  .nm .cl{font-size:8.5px;font-weight:800;text-transform:uppercase;background:#9aa3af;color:var(--card);border-radius:4px;padding:1px 5px;margin-left:6px}
  .strip{display:flex;align-items:flex-end;gap:1px;height:30px}
  .strip .b{flex:1;min-width:1px;display:flex;flex-direction:column;justify-content:flex-end;height:30px}
  .strip .b i{display:block;border-radius:1px}
  .st{text-align:right;font-size:14px;font-weight:800}.st span{display:block;font-size:10px;color:var(--muted);font-weight:400}
  .st.good{color:#1fa85a}.st.warn{color:#e8930c}.st.bad{color:#e5484d}.st.muted{color:var(--muted)}
  .legend{display:flex;gap:16px;font-size:12px;color:var(--muted);margin:14px 2px 0}.legend i{width:11px;height:11px;border-radius:3px;display:inline-block;margin-right:5px;vertical-align:-1px}
  .foot{font-size:11.5px;color:var(--muted);margin-top:14px}
  @media print{.btn{display:none}body{background:#fff}.panel{border-color:#ddd}}
</style></head><body><div class="wrap">
  <div class="top">
    <div><div class="eye">Signal · device health</div><h1>Every station through the day</h1><div class="sub">${esc(r.suite)} · generated ${esc(String(r.generatedAt).slice(0, 16).replace('T', ' '))} UTC</div></div>
    <div class="kpi ${r.flow != null && r.flow >= r.target ? 'good' : 'bad'}"><b>${r.flow == null ? '—' : r.flow + '%'}</b><span>${r.onNow}/${r.openTotal} online${r.closedDevices ? ` · ${r.closedDevices} at closed` : ''} · target ${r.target}%</span></div>
  </div>
  <button class="btn" onclick="window.print()">⤓ Download PDF</button>
  <div class="legend" style="margin-bottom:12px"><span><i style="background:#1fa85a"></i>online</span><span><i style="background:#e5484d"></i>offline — should be running</span><span><i style="background:#9aa3af"></i>offline — closed (expected)</span></div>
  <div class="panel">${rows || '<div style="padding:24px;color:var(--muted);font-size:13px">No observed checks yet.</div>'}</div>
  <div class="foot">Live device-connectivity per station, from Pulse's own observed log. Green = online, red = offline while it should be running, grey = a closed station winding down.</div>
</div></body></html>`;
  }

  // ════════════════════════ public report page (token-gated) ════════════════════════
  app.get('/signal-report/:suiteId/:token', (req, res) => {
    if (!enabled()) return res.status(404).send('Not found');
    const r = sql.prepare('SELECT * FROM signal_digest WHERE suite_id=?').get(req.params.suiteId);
    if (!r || !r.token || r.token !== req.params.token) return res.status(403).send('This report link is invalid or has been turned off.');
    res.set('Content-Type', 'text/html; charset=utf-8').send(reportHtml(buildReport(req.params.suiteId), cfgView(r).link));
  });

  // ════════════════════════ config (admin + client self-service) ════════════════════
  const clean = (b) => ({
    recipients: (Array.isArray(b.recipients) ? b.recipients : String(b.recipients || '').split(/[\s,;]+/))
      .map((x) => String(x).trim().toLowerCase()).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)).slice(0, 25),
    cadenceMin: Math.max(0, Math.min(720, Math.round(Number(b.cadenceMin) || 0))),
    dropAlert: b.dropAlert ? 1 : 0, enabled: b.enabled ? 1 : 0,
  });
  function saveCfg(suiteId, b) {
    const c = cfg(suiteId); const v = clean(b);
    sql.prepare('UPDATE signal_digest SET recipients=?, cadence_min=?, drop_alert=?, enabled=?, updated_at=? WHERE suite_id=?')
      .run(JSON.stringify(v.recipients), v.cadenceMin, v.dropAlert, v.enabled, now(), suiteId);
    return cfgView(cfg(suiteId));
  }
  const rotate = (suiteId) => { cfg(suiteId); sql.prepare('UPDATE signal_digest SET token=?, updated_at=? WHERE suite_id=?').run(newToken(), now(), suiteId); return cfgView(cfg(suiteId)); };

  // admin
  app.get('/api/admin/signal-report/:suiteId', auth.requireAdmin, (req, res) => { if (!enabled()) return res.status(404).json({ error: 'off' }); res.json(cfgView(cfg(req.params.suiteId))); });
  app.put('/api/admin/signal-report/:suiteId', auth.requireAdmin, (req, res) => { if (!enabled()) return res.status(404).json({ error: 'off' }); res.json(saveCfg(req.params.suiteId, req.body || {})); });
  app.post('/api/admin/signal-report/:suiteId/rotate', auth.requireAdmin, (req, res) => { if (!enabled()) return res.status(404).json({ error: 'off' }); res.json(rotate(req.params.suiteId)); });
  app.post('/api/admin/signal-report/:suiteId/test', auth.requireAdmin, async (req, res) => { if (!enabled()) return res.status(404).json({ error: 'off' }); res.json(await sendDigest(req.params.suiteId, 'test') || { ok: false }); });

  // client self-service (must own the suite)
  const requireAuth = auth.requireAuth || auth.requireAdmin;
  const ownsSuite = (req) => { const su = db.getSuite(req.params.suiteId); if (!su) return false; return (req.user && req.user.role === 'admin') || (su && ((req.user && req.user.entityIds) || []).includes(su.entityId)); };
  app.get('/api/my/signal-report/:suiteId', requireAuth, (req, res) => { if (!enabled()) return res.status(404).json({ error: 'off' }); if (!ownsSuite(req)) return res.status(403).json({ error: 'Not your event' }); res.json(cfgView(cfg(req.params.suiteId))); });
  app.put('/api/my/signal-report/:suiteId', requireAuth, (req, res) => { if (!enabled()) return res.status(404).json({ error: 'off' }); if (!ownsSuite(req)) return res.status(403).json({ error: 'Not your event' }); res.json(saveCfg(req.params.suiteId, req.body || {})); });
  app.post('/api/my/signal-report/:suiteId/rotate', requireAuth, (req, res) => { if (!enabled()) return res.status(404).json({ error: 'off' }); if (!ownsSuite(req)) return res.status(403).json({ error: 'Not your event' }); res.json(rotate(req.params.suiteId)); });

  // ════════════════════════ the digest emailer ════════════════════════
  // reason: 'scheduled' | 'drop' | 'test'. Test mode → only the test inbox.
  async function sendDigest(suiteId, reason) {
    const c = cfg(suiteId);
    const r = buildReport(suiteId);
    const view = cfgView(c);
    const test = testMode();
    const to = test ? [testEmail()].filter(Boolean) : view.recipients;
    if (!to.length || !mailer || !mailer.send) return { ok: false, sent: 0, reason };
    const tag = reason === 'drop' ? '⚠️ signal drop' : reason === 'test' ? '[TEST] signal report' : 'signal report';
    const subject = `${test ? '[TEST] ' : ''}${tag} — ${r.suite} · ${r.flow == null ? '—' : r.flow + '%'}`;
    const body = `${summaryText(r)}\n\nLive report (open + Download PDF): ${view.link}\n${test ? '\n🧪 TEST MODE — the real recipients were NOT emailed. Go live in Admin → Data health.' : ''}`;
    const html = `<p>${esc(summaryText(r))}</p><p><a href="${esc(view.link)}">Open the live report</a> (with a Download-PDF button).</p>${test ? '<p style="color:#888;font-size:12px">🧪 TEST MODE — real recipients were not emailed.</p>' : ''}`;
    for (const addr of to) { try { await mailer.send({ to: addr, subject, text: body, html, kind: 'notification', entity: c.entity_id || undefined }); } catch (e) { console.error('[signal-report] mail failed', e.message); } }
    return { ok: true, sent: to.length, reason, testMode: test };
  }

  // 60s tick: scheduled digests + drop-below-target alerts.
  const TICK_MS = Number(process.env.SIGNAL_REPORT_TICK_MS) || 60000;
  let ticking = false;
  async function tick() {
    if (!enabled() || ticking || !signalFlow) return;
    ticking = true;
    try {
      const rows = sql.prepare('SELECT * FROM signal_digest WHERE enabled=1').all();
      for (const c of rows) {
        try {
          let flow = null; try { flow = signalFlow(c.suite_id); } catch { flow = null; }
          const pct = flow && flow.total ? flow.pct : null;
          const target = (flow && flow.target) || 95;
          // drop alert: fire on the crossing from at/above target to below.
          if (c.drop_alert && pct != null && pct < target && (c.last_flow == null || c.last_flow >= target)) {
            await sendDigest(c.suite_id, 'drop');
          }
          if (pct != null) sql.prepare('UPDATE signal_digest SET last_flow=? WHERE suite_id=?').run(pct, c.suite_id);
          // scheduled digest
          if (c.cadence_min > 0) {
            const due = !c.last_sched || (Date.now() - Date.parse(c.last_sched)) >= c.cadence_min * 60000 - 20000;
            if (due) { sql.prepare('UPDATE signal_digest SET last_sched=? WHERE suite_id=?').run(now(), c.suite_id); await sendDigest(c.suite_id, 'scheduled'); }
          }
        } catch (e) { console.error('[signal-report] tick row failed', c.suite_id, e.message); }
      }
    } finally { ticking = false; }
  }
  const timer = setInterval(() => tick().catch(() => {}), TICK_MS);
  if (timer.unref) timer.unref();

  console.log('[signal-report] mounted', enabled() ? '(enabled)' : '(disabled)');
  return { buildReport, reportHtml, summaryText, sendDigest, tick };
}

module.exports = { mount, zoneOf };
