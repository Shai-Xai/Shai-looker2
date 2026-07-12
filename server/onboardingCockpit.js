// ─── AM cockpit + scorecard — SELF-CONTAINED, DISPOSABLE MODULE ───────────────
// The account team's view of client onboarding. Two reads and one action:
//   • /cockpit    — one row per client: journey bar, current phase, days since
//                   progress last moved (the STALLED flag), last milestone,
//                   welcome state, owner. Sorted by who needs attention.
//   • /scorecard  — per-AM month scorecard + team leaderboard: activations,
//                   speed, stalled count, first-reply time, Owl adoption, a
//                   VISIBLE composite score, and AM badges. Recognition only —
//                   deliberately not tied to hours-in-app (fakeable) or comp.
//   • /:id/nudge  — one tap: the journey's "here's what's still open" note.
// Pure read layer over data the journey/gamify modules already maintain.
//
// Mount: require('./onboardingCockpit').mount(app, { db, auth, onboarding });

const DAY = 86400000;

function mount(app, { db, auth, onboarding }) {
  const sql = db.db;
  const all = (q, ...a) => { try { return sql.prepare(q).all(...a); } catch { return []; } };
  const one = (q, ...a) => { try { return sql.prepare(q).get(...a); } catch { return null; } };
  const stallDays = () => Number(db.getSetting('onboarding_stall_days', '14')) || 14;
  const warnDays = () => Math.max(1, Math.round(stallDays() / 2));

  const mailLog = (eid) => Object.fromEntries(all('SELECT key, sent_at FROM onboarding_mail_log WHERE entity_id=?', eid).map((r) => [r.key, r.sent_at]));

  // Latest earned badge/sticker — the "last milestone" cell.
  const lastMilestone = (eid) => {
    const r = one("SELECT key, awarded_at FROM badge_awards WHERE entity_id=? ORDER BY awarded_at DESC LIMIT 1", eid);
    if (!r) return null;
    const ph = onboarding.phases.find((p) => `phase:${p.key}` === r.key);
    const label = ph ? ph.sticker : (r.key === 'activated' ? '🏆 Fully activated' : r.key.replace(/_/g, ' '));
    return { label, at: r.awarded_at };
  };

  function row(e) {
    const prog = onboarding.progress(e.id);
    const log = mailLog(e.id);
    const pulse = one('SELECT done, at FROM journey_pulse WHERE entity_id=?', e.id);
    const sinceMove = pulse?.at ? Math.floor((Date.now() - new Date(pulse.at).getTime()) / DAY)
      : (e.createdAt ? Math.floor((Date.now() - new Date(e.createdAt).getTime()) / DAY) : null);
    const curIdx = prog.phases.findIndex((p) => p.key === prog.currentPhase);
    const owner = e.howlerOwnerUserId ? db.getUser(e.howlerOwnerUserId) : null;
    return {
      id: e.id, name: e.name, logo: e.logo || '',
      phases: prog.phases.map((p) => ({ key: p.key, icon: p.icon, complete: p.complete, done: p.done, total: p.total })),
      currentPhase: prog.complete ? null : { idx: curIdx + 1, key: prog.currentPhase, icon: prog.phases[curIdx]?.icon, title: prog.phases[curIdx]?.title },
      done: prog.done, total: prog.total, points: prog.points, complete: prog.complete,
      daysInactive: prog.complete ? null : sinceMove,
      stalled: !prog.complete && sinceMove != null && sinceMove >= stallDays(),
      warning: !prog.complete && sinceMove != null && sinceMove >= warnDays(),
      welcomeSentAt: log.welcome || null,
      lastMilestone: lastMilestone(e.id),
      am: owner ? { id: owner.id, name: owner.fullName || owner.email } : null,
      hasLogins: (all('SELECT user_id FROM user_entities WHERE entity_id=?', e.id).length > 0),
    };
  }

  // Welcome → first real campaign, in days (the funnel's headline speed metric).
  function firstSendDays(eid, log) {
    if (!log.welcome || log.welcome === 'baseline') return null;
    const a = one("SELECT MIN(created_at) t FROM actions WHERE entity_id=? AND status!='draft'", eid);
    if (!a?.t) return null;
    const d = (new Date(a.t) - new Date(log.welcome)) / DAY;
    return d >= 0 ? Math.round(d) : null;
  }
  const median = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

  app.get('/api/admin/onboarding/cockpit', auth.requireAdmin, (req, res) => {
    const entities = all('SELECT id FROM entities').map((r) => db.getEntity(r.id)).filter(Boolean);
    const rows = entities.map(row);
    // Who needs attention first: stalled desc by idle days, then in-flight, then done.
    rows.sort((a, b) => (b.stalled - a.stalled) || (a.complete - b.complete) || ((b.daysInactive || 0) - (a.daysInactive || 0)));
    const inFlight = rows.filter((r) => !r.complete && r.hasLogins);
    const speed = median(entities.map((e) => firstSendDays(e.id, mailLog(e.id))));
    res.json({
      stallDays: stallDays(), warnDays: warnDays(),
      stats: { onboarding: inFlight.length, stalled: rows.filter((r) => r.stalled).length, activated: rows.filter((r) => r.complete).length, medianFirstSendDays: speed },
      rows,
    });
  });

  app.post('/api/admin/onboarding/cockpit/:id/nudge', auth.requireAdmin, (req, res) => {
    const e = db.getEntity(req.params.id);
    if (!e) return res.status(404).json({ error: 'No such client' });
    const ok = onboarding.nudge(e);
    res.json({ ok, note: ok ? 'Nudge sent (inbox + email).' : 'Nothing to nudge — journey complete.' });
  });

  // ── The AM scorecard ────────────────────────────────────────────────────────
  // Median hours from a client message to the FIRST Howler reply in the same
  // thread, across an AM's book, last 60 days. Sampled per thread — good enough
  // for a scoreboard, cheap enough to run on request.
  function medianReplyHours(entityIds) {
    const gaps = [];
    for (const eid of entityIds.slice(0, 25)) {
      for (const th of all("SELECT id FROM os_threads WHERE entity_id=? ORDER BY updated_at DESC LIMIT 10", eid)) {
        const msgs = all('SELECT author_type, created_at FROM os_messages WHERE thread_id=? ORDER BY created_at', th.id);
        for (let i = 0; i < msgs.length; i++) {
          if (msgs[i].author_type !== 'client') continue;
          const reply = msgs.slice(i + 1).find((m) => m.author_type === 'howler');
          if (reply) gaps.push((new Date(reply.created_at) - new Date(msgs[i].created_at)) / 3600000);
          break; // first client→howler gap per thread
        }
      }
    }
    return median(gaps) != null ? Math.round(median(gaps) * 10) / 10 : null;
  }

  app.get('/api/admin/onboarding/scorecard', auth.requireAdmin, (req, res) => {
    const entities = all('SELECT id FROM entities').map((r) => db.getEntity(r.id)).filter(Boolean);
    const monthAgo = new Date(Date.now() - 30 * DAY).toISOString();
    const byAm = {};
    for (const e of entities) {
      const uid = e.howlerOwnerUserId; if (!uid) continue;
      (byAm[uid] = byAm[uid] || []).push(e);
    }
    const cards = [];
    for (const [uid, book] of Object.entries(byAm)) {
      const u = db.getUser(uid); if (!u) continue;
      let activatedAll = 0; let activated30 = 0; let stalled = 0; let onboardingNow = 0; let owlBook = 0;
      const actDays = [];
      for (const e of book) {
        const prog = onboarding.progress(e.id);
        const log = mailLog(e.id);
        if (prog.complete) {
          activatedAll += 1;
          const done = one("SELECT awarded_at t FROM badge_awards WHERE entity_id=? AND key='activated'", e.id);
          if (done?.t && done.t > monthAgo) activated30 += 1;
          if (log.welcome && log.welcome !== 'baseline' && done?.t) actDays.push(Math.round((new Date(done.t) - new Date(log.welcome)) / DAY));
        } else {
          onboardingNow += 1;
          const pulse = one('SELECT at FROM journey_pulse WHERE entity_id=?', e.id);
          const idle = pulse?.at ? (Date.now() - new Date(pulse.at).getTime()) / DAY : 0;
          if (idle >= stallDays()) stalled += 1;
        }
        if (one('SELECT 1 x FROM owl_threads WHERE entity_id=? LIMIT 1', e.id)) owlBook += 1;
      }
      const replyH = medianReplyHours(book.map((e) => e.id));
      const owlAdoption = book.length ? owlBook / book.length : 0;
      cards.push({
        userId: uid, name: u.fullName || u.email, book: book.length,
        activatedAll, activated30, medianActivationDays: median(actDays),
        onboardingNow, stalled, medianReplyHours: replyH, owlAdoption: Math.round(owlAdoption * 100),
      });
    }
    const teamMedianAct = median(cards.map((c) => c.medianActivationDays));
    for (const c of cards) {
      // The visible composite — every term shown to the team, weights in settings later.
      const speedPts = c.medianActivationDays == null ? 0 : (teamMedianAct != null && c.medianActivationDays <= teamMedianAct ? 25 : 12);
      const replyPts = c.medianReplyHours == null ? 0 : (c.medianReplyHours <= 2 ? 15 : c.medianReplyHours <= 6 ? 10 : c.medianReplyHours <= 24 ? 5 : 0);
      c.score = Math.min(100, c.activated30 * 30 + speedPts + (c.stalled === 0 && c.onboardingNow > 0 ? 20 : 0) + replyPts + Math.round(c.owlAdoption / 10));
      c.badges = [];
      const tier = c.activatedAll >= 25 ? 'III' : c.activatedAll >= 10 ? 'II' : c.activatedAll >= 5 ? 'I' : null;
      if (tier) c.badges.push(`🚀 Launchmaster ${tier}`);
      if (c.medianActivationDays != null && c.medianActivationDays < 14) c.badges.push('⚡ Speedrunner');
      if (c.stalled === 0 && c.onboardingNow >= 2) c.badges.push('🧼 Clean Sheet');
      if (c.medianReplyHours != null && c.medianReplyHours <= 2) c.badges.push('📨 Lightning Reply');
      if (c.owlAdoption === 100 && c.book >= 3) c.badges.push('🦉 Owl Evangelist');
    }
    cards.sort((a, b) => b.score - a.score);
    if (cards[0]) cards[0].badges.unshift('🏆 Golden Owl');
    res.json({ me: req.user.id, teamMedianActivationDays: teamMedianAct, cards });
  });

  console.log('[onboardingCockpit] AM cockpit + scorecard mounted');
}

module.exports = { mount };
