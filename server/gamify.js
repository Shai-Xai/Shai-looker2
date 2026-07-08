// ─── Gamification — SELF-CONTAINED, DISPOSABLE MODULE ─────────────────────────
// The badges & Pulse Points layer on top of the onboarding journey: a STICKER
// per completed phase, ACTIVITY BADGES for real outcomes (Owl questions, a
// win-back that converted, a goal hit, streaks…), and a points total the client
// team earns together. Everything is awarded from VERIFIED usage — the same
// signals the journey reads — once per client, so nothing can be farmed.
// Earning only for now: the reward catalogue ("spend your points") ships once
// the business picks it; the shelf shows points as progress in the meantime.
// Also keeps `journey_pulse` — when a client's step count last moved — which is
// what the AM cockpit's "stalled" flag reads.
//
// Mount AFTER onboarding: require('./gamify').mount(app, { db, auth, onboarding });

function mount(app, { db, auth, onboarding }) {
  const sql = db.db;
  sql.exec(`CREATE TABLE IF NOT EXISTS badge_awards (
    entity_id  TEXT NOT NULL,
    key        TEXT NOT NULL,            -- 'phase:<key>' | 'activated' | an activity badge key
    points     INTEGER NOT NULL DEFAULT 0,
    awarded_at TEXT NOT NULL,
    seen       INTEGER NOT NULL DEFAULT 0,  -- 0 until the client has seen the unlock toast
    PRIMARY KEY (entity_id, key)
  );`);
  sql.exec(`CREATE TABLE IF NOT EXISTS journey_pulse (
    entity_id TEXT PRIMARY KEY,
    done      INTEGER NOT NULL DEFAULT 0, -- step count at last change
    at        TEXT NOT NULL               -- when it last moved
  );`);

  const count = (q, ...a) => { try { return sql.prepare(q).get(...a)?.n || 0; } catch { return 0; } };

  // Four consecutive weeks with any dashboard activity by the client's own team,
  // ending this week or last (a live streak, not an ancient one).
  function streakWeeks(entityId) {
    // Distinct active weeks (client's own users, dashboard opens), most recent first.
    // Use the same %Y-%W bucketing for the data and for "now" so they always align.
    let weeks = [];
    try { weeks = sql.prepare("SELECT DISTINCT strftime('%Y-%W', v.at) w FROM user_views v JOIN user_entities ue ON ue.user_id=v.user_id WHERE ue.entity_id=? ORDER BY w DESC LIMIT 12").all(entityId).map((r) => r.w); } catch { return 0; }
    if (!weeks.length) return 0;
    const bucket = (t) => { try { return sql.prepare("SELECT strftime('%Y-%W', ?) w").get(new Date(t).toISOString()).w; } catch { return ''; } };
    // Walk back week by week; the streak may anchor on this week or last week.
    let streak = 0; const t = Date.now();
    for (let i = 0; i < 12; i++) {
      const wk = bucket(t - i * 604800000);
      if (weeks.includes(wk)) streak += 1;
      else if (i === 0) continue; // nothing yet this week — a live streak can still stand
      else break;
    }
    return streak;
  }
  // A campaign whose conversion sweep counted real come-backs.
  const converted = (e) => {
    try {
      for (const r of sql.prepare("SELECT results FROM actions WHERE entity_id=? AND results LIKE '%converted%' LIMIT 50").all(e)) {
        try { if ((JSON.parse(r.results || '{}').converted || 0) > 0) return true; } catch { /* row */ }
      }
    } catch { /* table */ }
    return false;
  };

  // Activity badge catalogue — outcomes, not clicks. Keys are stable.
  const ACTIVITY = [
    { key: 'data_detective', icon: '🕵️', title: 'Data Detective', desc: 'Asked the Owl 10 questions', pts: 150, test: (e) => count("SELECT COUNT(*) n FROM ai_usage WHERE entity_id=? AND kind='owl_chat'", e) >= 10 },
    { key: 'cart_rescuer', icon: '🛒', title: 'Cart Rescuer', desc: 'A campaign brought customers back', pts: 300, test: converted },
    { key: 'goal_getter', icon: '🏅', title: 'Goal Getter', desc: 'Hit an event goal', pts: 200, test: (e) => count("SELECT COUNT(*) n FROM goals WHERE entity_id=? AND result_band IN ('hit','smashed')", e) > 0 },
    { key: 'streak_4', icon: '🔥', title: 'On a Streak', desc: 'Active four weeks in a row', pts: 100, test: (e) => streakWeeks(e) >= 4 },
    { key: 'full_house', icon: '👑', title: 'Full House', desc: 'Five or more teammates with access', pts: 150, test: (e) => count('SELECT COUNT(*) n FROM user_entities WHERE entity_id=?', e) >= 5 },
    { key: 'bug_hunter', icon: '🐛', title: 'Bug Hunter', desc: 'Reported something — and we shipped the fix', pts: 200, test: (e) => count("SELECT COUNT(*) n FROM tickets WHERE entity_id=? AND reporter_role='client' AND status='shipped'", e) > 0 },
  ];

  const award = sql.prepare('INSERT OR IGNORE INTO badge_awards (entity_id,key,points,awarded_at,seen) VALUES (?,?,?,?,0)');
  const awardsFor = (e) => { try { return sql.prepare('SELECT key, points, awarded_at, seen FROM badge_awards WHERE entity_id=?').all(e); } catch { return []; } };

  // Detect + persist anything newly earned, and refresh the journey pulse.
  // Cheap enough to run on every shelf/journey read.
  function sweep(entityId, prog) {
    prog = prog || onboarding.progress(entityId);
    const now = new Date().toISOString();
    for (const p of prog.phases.filter((x) => x.complete)) award.run(entityId, `phase:${p.key}`, onboarding.bonuses.phase, now);
    if (prog.complete) award.run(entityId, 'activated', onboarding.bonuses.activated, now);
    for (const b of ACTIVITY) { try { if (b.test(entityId)) award.run(entityId, b.key, b.pts, now); } catch { /* signal table missing */ } }
    try {
      const cur = sql.prepare('SELECT done FROM journey_pulse WHERE entity_id=?').get(entityId);
      if (!cur) sql.prepare('INSERT INTO journey_pulse (entity_id,done,at) VALUES (?,?,?)').run(entityId, prog.done, now);
      else if (cur.done !== prog.done) sql.prepare('UPDATE journey_pulse SET done=?, at=? WHERE entity_id=?').run(prog.done, now, entityId);
    } catch { /* best-effort */ }
    return prog;
  }

  // The full "Your journey" payload: sticker shelf, activity badges, points.
  function summary(entityId) {
    const prog = sweep(entityId);
    const got = Object.fromEntries(awardsFor(entityId).map((a) => [a.key, a]));
    const stickers = onboarding.phases.map((p, i) => ({
      key: p.key, phase: i + 1, sticker: p.sticker, title: p.title,
      earned: !!got[`phase:${p.key}`], awardedAt: got[`phase:${p.key}`]?.awarded_at || null, pts: onboarding.bonuses.phase,
    }));
    const badges = ACTIVITY.map((b) => ({ key: b.key, icon: b.icon, title: b.title, desc: b.desc, pts: b.pts, earned: !!got[b.key], awardedAt: got[b.key]?.awarded_at || null }));
    const activityPts = badges.filter((b) => b.earned).reduce((n, b) => n + b.pts, 0);
    const unseen = awardsFor(entityId).filter((a) => !a.seen).map((a) => {
      const ph = onboarding.phases.find((p) => `phase:${p.key}` === a.key);
      const act = ACTIVITY.find((b) => b.key === a.key);
      return { key: a.key, points: a.points, label: ph ? ph.sticker : (a.key === 'activated' ? '🏆 Fully Activated' : (act ? `${act.icon} ${act.title}` : a.key)) };
    });
    return {
      stickers, badges, unseen,
      activated: { earned: !!got.activated, pts: onboarding.bonuses.activated },
      // prog.points already includes steps + phase bonuses + the activation bonus.
      points: { journey: prog.points, activity: activityPts, total: prog.points + activityPts },
      journey: { done: prog.done, total: prog.total, currentPhase: prog.currentPhase, complete: prog.complete },
    };
  }

  const canEntity = (req, entityId) => req.user.role === 'admin' || (req.user.entityIds || []).includes(entityId);

  app.get('/api/my/journey/:entityId', auth.requireAuth, (req, res) => {
    if (!canEntity(req, req.params.entityId)) return res.status(403).json({ error: 'Not allowed' });
    res.json(summary(req.params.entityId));
  });
  // The unlock toast was shown — don't show those awards again.
  app.post('/api/my/journey/:entityId/seen', auth.requireAuth, (req, res) => {
    if (!canEntity(req, req.params.entityId)) return res.status(403).json({ error: 'Not allowed' });
    try { sql.prepare('UPDATE badge_awards SET seen=1 WHERE entity_id=?').run(req.params.entityId); } catch { /* ignore */ }
    res.json({ ok: true });
  });
  // Admin view of a client's shelf (the same payload).
  app.get('/api/admin/entities/:id/journey', auth.requireAdmin, (req, res) => res.json(summary(req.params.id)));

  // Background sweep keeps the pulse + awards fresh even for clients who don't
  // open Pulse (so phase emails, cockpit stall flags and badges stay in step).
  const sweepAll = () => { try { for (const r of sql.prepare('SELECT id FROM entities').all()) { try { sweep(r.id); } catch { /* one client */ } } } catch { /* no table */ } };
  setInterval(sweepAll, 30 * 60 * 1000).unref?.();

  console.log('[gamify] badges + Pulse Points layer mounted');
  return { sweep, summary, sweepAll };
}

module.exports = { mount };
