// ─── Staff alerts (phase 1, 🧪): when a board station goes dark, tell the
// people standing at it. Bridges data-health station names ↔ Event Ops
// stations (auto name-match + manual override), finds the staff assigned
// there, and notifies. In TEST MODE (rides data-health's switch) only the
// test email hears about it, with the would-be recipients listed — staff are
// never contacted until Go live. SELF-CONTAINED, DISPOSABLE: owns the
// staff_alert_* tables + /api/my/staff-alerts routes; reads data_monitors and
// eventops_* tables directly (no coupling into those modules' code). Kill
// switch: settings key `staff_alerts_enabled` ('0' = no tick, routes 404).
// Later phases: rules/escalation ladders, SMS/WhatsApp session channel, Ops Owl.

const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

function mount(app, { db, auth, mailer = require('./mailer'), push = require('./push'), messaging = null }) {
  const sql = db.db;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS staff_alert_bridge (
      suite_id       TEXT NOT NULL,
      health_station TEXT NOT NULL,
      ops_station_id TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (suite_id, health_station)
    );
    -- Staff who've opened a WhatsApp window (messaged our number). msisdn ↔ staff,
    -- with the last inbound time (the 24h free-form window) and their last message.
    CREATE TABLE IF NOT EXISTS eventops_staff_wa (
      msisdn      TEXT NOT NULL PRIMARY KEY,
      staff_id    TEXT NOT NULL,
      suite_id    TEXT NOT NULL,
      last_in_at  TEXT NOT NULL,
      last_msg    TEXT NOT NULL DEFAULT '',
      opted_out   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_eventops_staff_wa ON eventops_staff_wa(staff_id);
    CREATE TABLE IF NOT EXISTS staff_alert_state (
      k      TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      at     TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS staff_alert_log (
      id         TEXT PRIMARY KEY,
      at         TEXT NOT NULL,
      suite_id   TEXT NOT NULL,
      station    TEXT NOT NULL,
      kind       TEXT NOT NULL,
      message    TEXT NOT NULL,
      recipients TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_sal_suite ON staff_alert_log(suite_id, at);
  `);
  const now = () => new Date().toISOString();
  const uuid = () => require('crypto').randomUUID();
  const enabled = () => db.getSetting('staff_alerts_enabled', '1') !== '0';
  // Master OFF switch for EVERY event's ops alerts (the big red stop). Distinct
  // from per-event pause; when off the tick sends nothing anywhere.
  const allOff = () => db.getSetting('staff_alerts_all_off', '0') === '1';
  // Per-event dark threshold (% of a station's devices dark before its crew is
  // paged). Settable on Hive → Alerts; recovery is half the threshold.
  const thresholdPct = (sid) => { const v = Number(db.getSetting('staff_alerts_threshold_' + (sid || 'all'), '')); return v >= 10 && v <= 100 ? v : 50; };
  // Per-event pause — silences the tick for this suite without disabling the
  // whole feature. Toggled on Hive → Alerts (e.g. during a known pipe wobble).
  const paused = (sid) => db.getSetting('staff_alerts_paused_' + (sid || 'all'), '0') === '1';
  const testMode = () => db.getSetting('data_health_test_mode', '1') !== '0';
  const testEmail = () => db.getSetting('data_health_test_email', 'shai.evian@howler.co.za');
  const parse = (s, f) => { try { return JSON.parse(s) ?? f; } catch { return f; } };
  const off404 = (res) => res.status(404).json({ error: 'Staff alerts are disabled' });

  // Every station the Data health board knows for a suite, with live on/off
  // from the monitor snapshots. A station-less monitor is its own station.
  function healthStations(suiteId) {
    const rows = sql.prepare("SELECT id, name, entity_id, suite_id, roster_snapshot FROM data_monitors WHERE status!='closed' AND entity_id!=''").all();
    const out = [];
    for (const r of rows) {
      if (suiteId && r.suite_id && r.suite_id !== suiteId) continue;
      const snap = parse(r.roster_snapshot, null);
      for (const s of (snap && snap.stations) || []) {
        const name = s.station && s.station !== '—' ? s.station : r.name;
        out.push({ station: name, on: s.on || 0, off: s.off || 0, entityId: r.entity_id, suiteId: r.suite_id || suiteId || '', monitor: r.name });
      }
    }
    return out;
  }

  // The bridge: a manual mapping wins (even an explicit '' = unmapped);
  // otherwise match by normalised name — exact first, then containment.
  function resolveStation(suiteId, healthStation, opsStations) {
    const o = sql.prepare('SELECT ops_station_id FROM staff_alert_bridge WHERE suite_id=? AND health_station=?').get(suiteId, healthStation);
    if (o) return { id: o.ops_station_id, manual: true };
    const n = norm(healthStation);
    const hit = opsStations.find((s) => norm(s.name) === n)
      || (n && opsStations.find((s) => norm(s.name).includes(n) || n.includes(norm(s.name))));
    return { id: hit ? hit.id : '', manual: false };
  }

  function log(suiteId, station, kind, message, recipients) {
    sql.prepare('INSERT INTO staff_alert_log (id, at, suite_id, station, kind, message, recipients) VALUES (?,?,?,?,?,?,?)')
      .run(uuid(), now(), suiteId, station, kind, message, recipients || '');
    sql.prepare('DELETE FROM staff_alert_log WHERE at<?').run(new Date(Date.now() - 30 * 86400000).toISOString());
  }

  // Push straight to the crew's own phones (portal web-push, opted in on the
  // staff portal). Live-mode only — test mode never contacts staff.
  function sendToStaff(staffIds, payload) {
    const ids = (staffIds || []).filter(Boolean);
    if (!ids.length || !push.isEnabled()) return;
    const rows = sql.prepare(`SELECT endpoint, p256dh, auth FROM eventops_staff_push WHERE staff_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    if (rows.length && push.sendRaw) Promise.resolve(push.sendRaw(rows, payload)).catch(() => {});
  }

  // WhatsApp as an alert channel (phase 3).
  // Staff open the channel by messaging the Howler WhatsApp number — that opens
  // the 24h window WhatsApp requires for free-form messages. They do NOT reach
  // the Owl: staffInbound() intercepts a known staff number, captures the note
  // for ops, and replies with a simple confirmation. Returns TRUE only for a
  // real staff number (any other number falls straight through to the Owl).
  const waNorm = (n) => (messaging && messaging.normaliseMsisdn ? messaging.normaliseMsisdn(n) : String(n || '').replace(/[^\d]/g, ''));
  async function staffInbound(msisdn, text) {
    if (!messaging) return false;
    const m = waNorm(msisdn);
    if (!m) return false;
    // Match against every event's staff numbers (normalised).
    const cand = sql.prepare("SELECT id, suite_id, number, name FROM eventops_staff WHERE number!=''").all()
      .find((s) => waNorm(s.number) === m);
    if (!cand) return false; // not staff → let the Owl handle it as before
    const body = String(text || '').trim();
    const stop = /^(stop|unsubscribe|opt.?out)$/i.test(body);
    sql.prepare(`INSERT INTO eventops_staff_wa (msisdn, staff_id, suite_id, last_in_at, last_msg, opted_out) VALUES (?,?,?,?,?,?)
      ON CONFLICT(msisdn) DO UPDATE SET staff_id=excluded.staff_id, suite_id=excluded.suite_id, last_in_at=excluded.last_in_at, last_msg=excluded.last_msg, opted_out=excluded.opted_out`)
      .run(m, cand.id, cand.suite_id, now(), body.slice(0, 500), stop ? 1 : 0);
    log(cand.suite_id, cand.name || cand.number, stop ? 'wa-optout' : 'wa-msg', `WhatsApp from ${cand.name || cand.number}: ${body.slice(0, 200)}`, '');
    const reply = stop
      ? 'You will no longer get station alerts on WhatsApp. Message us again any time to switch them back on.'
      : `✅ Thanks ${cand.name || ''}${cand.name ? ' — ' : ''}you're set up for station alerts on WhatsApp. We'll message you here if a station you're on goes dark. Reply STOP to opt out.`;
    try { await messaging.sendWhatsapp({ to: m, text: reply }); } catch { /* best effort */ }
    return true;
  }

  // Free-form WhatsApp to the crew — ONLY numbers with an open 24h window and
  // not opted out (WhatsApp forbids free-form outside the window without a
  // template). Live-mode only.
  function sendWhatsappToStaff(staffIds, text) {
    const ids = (staffIds || []).filter(Boolean);
    if (!ids.length || !messaging || !messaging.sendWhatsapp) return;
    const rows = sql.prepare(`SELECT msisdn, last_in_at, opted_out FROM eventops_staff_wa WHERE staff_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    for (const r of rows) {
      if (r.opted_out) continue;
      if (Date.now() - Date.parse(r.last_in_at) >= 24 * 3600000) continue; // window closed
      Promise.resolve(messaging.sendWhatsapp({ to: r.msisdn, text })).catch(() => {});
    }
  }

  function notify(suiteId, hs, crew, map) {
    const total = hs.on + hs.off;
    const who = crew.map((x) => `${x.name}${x.role ? ` (${x.role})` : ''}${x.number ? ` · ${x.number}` : ''}`).join(', ');
    const title = `🚨 ${hs.station} needs eyes — ${hs.off} of ${total} devices dark`;
    const body = crew.length ? `Assigned staff: ${who}.`
      : map.id ? 'No staff assigned to this station in Event Ops.'
        : 'No Event Ops station matched — map it in Hive → Alerts.';
    log(suiteId, hs.station, 'alert', `${hs.off}/${total} dark. ${body}`, who);
    if (testMode()) {
      const to = testEmail();
      if (to && mailer?.send) {
        mailer.send({
          to, subject: `[TEST] ${title}`,
          text: `${body}\n\n🧪 Staff alerts are in TEST MODE — staff were NOT contacted; only you receive this. Go live in Admin → Data health.`,
          kind: 'notification',
        }).catch((e) => console.error('[staff-alerts] test mail failed', e.message));
      }
      // Push lands on the test admin's own devices, so the channel is provable
      // end-to-end without touching the client's team.
      const admin = (db.listUsers?.() || []).find((u) => (u.email || '').toLowerCase() === String(to).toLowerCase());
      if (admin && push.isEnabled()) Promise.resolve(push.sendToUser(admin.id, { title: `[TEST] ${title}`, body, url: '/event-ops' }, 'alerts')).catch(() => {});
    } else {
      Promise.resolve(push.sendToEntity(hs.entityId, { title, body, url: '/event-ops' }, 'alerts')).catch(() => {});
      // phase 2: ping the crew's OWN phones (portal push) + phase 3: WhatsApp
      // (only numbers with an open 24h window).
      const line = `🚨 ${hs.station}: ${hs.off} of ${total} devices dark — check the connection.`;
      sendToStaff(crew.map((x) => x.id), { title, body: `You're on ${hs.station}. ${hs.off} of ${total} devices dark — check the connection.`, url: '/event-ops', requireInteraction: true });
      sendWhatsappToStaff(crew.map((x) => x.id), line);
    }
  }

  // STORM GUARD: when several stations cross in the same tick it's the PIPE
  // (ingest stall), not the people — send ONE site-wide note, max one per 15
  // min per event, instead of paging every station's crew at once.
  const STORM_N = 4;
  function siteNotify(suiteId, entityId, fires) {
    const list = fires.slice(0, 8).map((h) => `${h.station} ${h.off}/${h.on + h.off} dark`).join(' · ');
    const title = `📡 ${fires.length} stations went dark together — likely the data pipe, not staff`;
    const body = `${list}${fires.length > 8 ? ` +${fires.length - 8} more` : ''}. When one pipe stalls every station looks dark at once — check the cashless/data sync before dispatching anyone.`;
    log(suiteId, '(site-wide)', 'site', `${fires.length} stations crossed together. ${body}`, '');
    if (testMode()) {
      const to = testEmail();
      if (to && mailer?.send) mailer.send({ to, subject: `[TEST] ${title}`, text: `${body}\n\n🧪 TEST MODE — one combined note instead of ${fires.length} station alerts; staff were NOT contacted.`, kind: 'notification' }).catch((e) => console.error('[staff-alerts] test mail failed', e.message));
    } else if (entityId) {
      Promise.resolve(push.sendToEntity(entityId, { title, body, url: '/event-ops' }, 'alerts')).catch(() => {});
    }
  }

  // The rule (phase 1): the event's THRESHOLD share of a station's devices dark
  // → alert; back under half the threshold → recovered. Edge-detected per
  // suite+station, 15-min re-fire cooldown.
  function tick() {
    if (!enabled() || allOff()) return;
    try {
      const suites = [...new Set(sql.prepare('SELECT DISTINCT suite_id FROM eventops_staff').all().map((r) => r.suite_id))];
      for (const suiteId of suites) {
        if (paused(suiteId)) continue; // event's alerts are paused — skip the whole suite
        const opsStations = sql.prepare('SELECT id, name FROM eventops_stations WHERE suite_id=?').all(suiteId);
        const staff = sql.prepare('SELECT id, name, number, role, station_id FROM eventops_staff WHERE suite_id=? AND (alerts_on IS NULL OR alerts_on=1)').all(suiteId);
        const thr = thresholdPct(suiteId) / 100;
        const fires = [];
        for (const hs of healthStations(suiteId)) {
          const total = hs.on + hs.off;
          if (total < 2) continue; // one lonely device flapping must not page anyone
          const share = hs.off / total;
          const k = `${suiteId}|${hs.station}`;
          const st = sql.prepare('SELECT status, at FROM staff_alert_state WHERE k=?').get(k);
          const alerting = st && st.status === 'alerting';
          if (!alerting && share >= thr) {
            if (st && Date.now() - Date.parse(st.at) < 15 * 60000) continue;
            fires.push(hs);
            sql.prepare('INSERT INTO staff_alert_state (k, status, at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET status=excluded.status, at=excluded.at').run(k, 'alerting', now());
          } else if (alerting && share <= thr / 2) {
            sql.prepare('UPDATE staff_alert_state SET status=?, at=? WHERE k=?').run('ok', now(), k);
            log(suiteId, hs.station, 'recovered', `${hs.on}/${total} devices back online`, '');
          }
        }
        if (fires.length >= STORM_N) {
          const sk = `${suiteId}|__site__`;
          const ss = sql.prepare('SELECT status, at FROM staff_alert_state WHERE k=?').get(sk);
          if (!ss || Date.now() - Date.parse(ss.at) >= 15 * 60000) {
            siteNotify(suiteId, fires[0].entityId, fires);
            sql.prepare('INSERT INTO staff_alert_state (k, status, at) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET status=excluded.status, at=excluded.at').run(sk, 'alerting', now());
          }
        } else {
          for (const hs of fires) {
            const map = resolveStation(suiteId, hs.station, opsStations);
            notify(suiteId, hs, map.id ? staff.filter((x) => x.station_id === map.id) : [], map);
          }
        }
      }
    } catch (e) { console.error('[staff-alerts] tick failed', e.message); }
  }
  const timer = setInterval(tick, 60000);
  timer.unref?.();

  // ── surface (my-scope serves clients AND admins — same as flow-target) ──
  const requireAuth = auth.requireAuth || auth.requireAdmin;
  const ownsSuite = (req, suiteId) => {
    if (req.user && req.user.role === 'admin') return true;
    const row = sql.prepare('SELECT entity_id FROM eventops_stations WHERE suite_id=? LIMIT 1').get(suiteId)
      || sql.prepare('SELECT entity_id FROM data_monitors WHERE suite_id=? LIMIT 1').get(suiteId);
    return !!row && ((req.user && req.user.entityIds) || []).includes(row.entity_id);
  };

  app.get('/api/my/staff-alerts', requireAuth, (req, res) => {
    if (!enabled()) return off404(res);
    const suiteId = String(req.query.suiteId || '');
    if (!suiteId || !ownsSuite(req, suiteId)) return res.status(403).json({ error: 'Not your event' });
    const opsStations = sql.prepare('SELECT id, name, kind FROM eventops_stations WHERE suite_id=? ORDER BY name').all(suiteId);
    const staff = sql.prepare('SELECT id, name, number, role, station_id FROM eventops_staff WHERE suite_id=?').all(suiteId);
    // Which staff are reachable — portal push, or an open WhatsApp window.
    const reachable = new Set(sql.prepare('SELECT DISTINCT staff_id FROM eventops_staff_push WHERE suite_id=?').all(suiteId).map((r) => r.staff_id));
    const waReach = new Set(sql.prepare("SELECT staff_id FROM eventops_staff_wa WHERE suite_id=? AND opted_out=0 AND last_in_at > ?").all(suiteId, new Date(Date.now() - 24 * 3600000).toISOString()).map((r) => r.staff_id));
    const stations = healthStations(suiteId).map((hs) => {
      const map = resolveStation(suiteId, hs.station, opsStations);
      const crew = map.id ? staff.filter((x) => x.station_id === map.id) : [];
      const st = sql.prepare('SELECT status FROM staff_alert_state WHERE k=?').get(`${suiteId}|${hs.station}`);
      return { station: hs.station, monitor: hs.monitor, on: hs.on, off: hs.off, opsStationId: map.id, manual: map.manual, alerting: !!st && st.status === 'alerting', staff: crew.map((x) => ({ name: x.name, role: x.role, number: x.number, reachable: reachable.has(x.id), whatsapp: waReach.has(x.id) })) };
    });
    const logRows = sql.prepare('SELECT at, station, kind, message FROM staff_alert_log WHERE suite_id=? ORDER BY at DESC LIMIT 50').all(suiteId);
    const whatsappFrom = (messaging && messaging.waFrom && messaging.waConfigured && messaging.waConfigured()) ? messaging.waFrom() : '';
    res.json({ testMode: testMode(), testEmail: testMode() ? testEmail() : '', thresholdPct: thresholdPct(suiteId), paused: paused(suiteId), allOff: allOff(), whatsappFrom, stations, opsStations, log: logRows });
  });

  app.put('/api/my/staff-alerts/settings', requireAuth, (req, res) => {
    if (!enabled()) return off404(res);
    const b = req.body || {};
    const suiteId = String(b.suiteId || '').slice(0, 64);
    if (!suiteId) return res.status(400).json({ error: 'suiteId required' });
    if (!ownsSuite(req, suiteId)) return res.status(403).json({ error: 'Not your event' });
    // Pause toggle and threshold can arrive together or apart.
    if (typeof b.paused === 'boolean') {
      db.setSetting('staff_alerts_paused_' + suiteId, b.paused ? '1' : '0');
      if (b.paused) log(suiteId, '(all)', 'paused', 'Alerts paused for this event.', '');
      else log(suiteId, '(all)', 'resumed', 'Alerts resumed for this event.', '');
    }
    // Master off — silences EVERY event's ops alerts (global). Admin-only.
    if (typeof b.allOff === 'boolean' && req.user && req.user.role === 'admin') {
      db.setSetting('staff_alerts_all_off', b.allOff ? '1' : '0');
      log(suiteId, '(all)', b.allOff ? 'all-off' : 'all-on', b.allOff ? 'ALL ops alerts switched off.' : 'Ops alerts switched back on.', '');
    }
    if (b.thresholdPct != null) {
      const pct = Math.round(Number(b.thresholdPct));
      if (!(pct >= 10 && pct <= 100)) return res.status(400).json({ error: 'Threshold must be between 10 and 100%' });
      db.setSetting('staff_alerts_threshold_' + suiteId, String(pct));
    }
    res.json({ thresholdPct: thresholdPct(suiteId), paused: paused(suiteId), allOff: allOff() });
  });

  app.put('/api/my/staff-alerts/bridge', requireAuth, (req, res) => {
    if (!enabled()) return off404(res);
    const b = req.body || {};
    const suiteId = String(b.suiteId || ''); const hsName = String(b.healthStation || '').slice(0, 200);
    if (!suiteId || !hsName) return res.status(400).json({ error: 'suiteId and healthStation required' });
    if (!ownsSuite(req, suiteId)) return res.status(403).json({ error: 'Not your event' });
    if (b.opsStationId == null) { // null clears the override → back to auto-match
      sql.prepare('DELETE FROM staff_alert_bridge WHERE suite_id=? AND health_station=?').run(suiteId, hsName);
    } else {
      sql.prepare('INSERT INTO staff_alert_bridge (suite_id, health_station, ops_station_id) VALUES (?,?,?) ON CONFLICT(suite_id, health_station) DO UPDATE SET ops_station_id=excluded.ops_station_id')
        .run(suiteId, hsName, String(b.opsStationId).slice(0, 64));
    }
    res.json({ ok: true });
  });

  return { tick, healthStations, resolveStation, staffInbound };
}

module.exports = { mount, norm };
