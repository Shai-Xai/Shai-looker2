// ─── Briefing & digest engine: fact-gathering + phase/time steering ────────────
// SHARED LIBRARY (not a routes module). The deterministic, AI-free layer that the
// home briefing, multi-event briefing and scheduled digests all sit on top of:
//   • Event-phase + time-of-day steering (PHASES/TIMES + their resolvers)
//   • The client's dashboard catalogue and the cheap "light snapshot"
//   • The heavy Looker fact sweep (buildFacts) and the curated picker
//     (buildFactsFromTiles), with their tile-priority / category logic.
//
// Factory: require('./briefing')({ db, store, query }). Lifted VERBATIM out of
// server/index.js — the only change is that db/store and the query engine arrive
// as injected deps instead of module-level references. The AI-generation layer
// (generateBriefing/Overall/Events, instruction stacks, digest content) stays in
// index.js and consumes these functions.

module.exports = function createBriefingEngine({ db, store, query }) {
  const { runLookerQuery, expandLockMap, effectiveFilterValues, tileQueryBody, daysBeforeOverlayFor } = query;

  // ─── Event phases (briefing steering) ───────────────────────────────────────
  // Every event moves through phases; the briefing's instructions change with
  // them. Defaults are global (editable in Admin → AI); each suite/event can
  // override per phase, and the phase itself auto-derives from the suite's dates
  // (launch + event start/end) with a manual override for things like Artist
  // Drops, which are announcement-driven rather than date-driven.
  const PHASES = [
    { key: 'pre_launch', label: 'Pre Launch' },
    { key: 'launch', label: 'Launch' },
    { key: 'artist_drops', label: 'Artist Drops' },
    { key: 'mid_campaign', label: 'Mid Campaign' },
    { key: 'build_up', label: 'Build Up' },
    { key: 'event_day', label: 'Event Day' },
    { key: 'day_after', label: 'Day After' },
    { key: 'post_event', label: 'Post Event' },
  ];
  const PHASE_DEFAULTS = {
    pre_launch: 'Tickets are not on sale yet. Focus on readiness: pricing tiers set up, comparisons to the previous event at this point, and audience/marketing signals. Do not treat zero sales as a problem.',
    launch: 'Tickets just went on sale. Focus on launch velocity: first-day/first-week sales, which tiers are moving, early-bird sell-through, and how launch compares to the previous event\'s launch.',
    artist_drops: 'A lineup announcement just happened. Focus on the sales spike around the announcement: uplift vs the days before, which ticket types benefited, resale activity, and traffic/audience response.',
    mid_campaign: 'Steady campaign period. Focus on weekly pace, sell-through by tier, pricing-phase transitions, comps creep, and whether pace projects to sell-out — call out anything going quiet.',
    build_up: 'Final week before the event. Focus on daily pace, projected final numbers, door-list/comps readiness, cashless top-up uptake, and any operational flags.',
    event_day: 'The event is LIVE. Focus on today: gate/check-in numbers, on-the-day sales, cashless top-ups and spend, and anything anomalous that needs action now.',
    day_after: 'The event just ended. Focus on the headline result: final attendance vs tickets sold, total revenue vs previous event, cashless spend per head, and biggest surprises.',
    post_event: 'Wrap-up mode. Focus on final totals vs last event, what over- and under-performed, refund/resale tails, and settlement status. Frame learnings for the next event.',
  };
  // Resolve a suite's current phase from its briefing config.
  function resolvePhase(cfg = {}, nowMs = Date.now()) {
    if (cfg.manualPhase && cfg.manualPhase !== 'auto' && PHASES.some((p) => p.key === cfg.manualPhase)) {
      return { key: cfg.manualPhase, source: 'manual' };
    }
    const day = 864e5;
    const t = (s) => (s ? new Date(`${s}T00:00:00`).getTime() : null);
    const launch = t(cfg.launchDate), start = t(cfg.eventStart), end = t(cfg.eventEnd) ?? t(cfg.eventStart);
    if (end != null && nowMs > end + 2 * day) return { key: 'post_event', source: 'auto' };
    if (end != null && nowMs > end + day) return { key: 'day_after', source: 'auto' };
    if (start != null && end != null && nowMs >= start && nowMs <= end + day) return { key: 'event_day', source: 'auto' };
    if (start != null && nowMs >= start - 7 * day) return { key: 'build_up', source: 'auto' };
    if (launch != null && nowMs < launch) return { key: 'pre_launch', source: 'auto' };
    if (launch != null && nowMs <= launch + 7 * day) return { key: 'launch', source: 'auto' };
    if (launch != null || start != null) return { key: 'mid_campaign', source: 'auto' };
    return { key: null, source: 'none' }; // no dates configured
  }
  function phaseDefaults() {
    const saved = JSON.parse(db.getSetting('briefing_phase_defaults', '{}') || '{}');
    return Object.fromEntries(PHASES.map((p) => [p.key, (saved[p.key] || '').trim() || PHASE_DEFAULTS[p.key]]));
  }

  // Time-of-day lens: a reader wants different things at 8am, 1pm and 7pm. The
  // client sends its local hour; the segment shapes the briefing's angle and
  // splits the cache so each part of the day gets a fresh generation.
  const TIMES = [
    { key: 'morning', label: 'Morning' },
    { key: 'midday', label: 'Midday' },
    { key: 'evening', label: 'Evening' },
  ];
  const TIME_DEFAULTS = {
    morning: 'It is MORNING for the reader. Open with what happened since yesterday/overnight — sales added, notable moves — then where the campaign stands overall, and set up the day: the one or two things to watch today.',
    midday: 'It is MIDDAY for the reader. Focus on how TODAY is tracking so far — pace versus a typical day, anything spiking or stalling — and flag anything that needs action this afternoon.',
    evening: 'It is EVENING for the reader. Wrap the day: how today closed (sales, revenue, standout performers or laggards), and what tomorrow should bring or needs attention.',
  };
  function timeSegment(hour) {
    const h = Number.isFinite(hour) ? hour : new Date().getHours();
    return h < 12 ? 'morning' : h < 17 ? 'midday' : 'evening';
  }
  function timeDefaults() {
    const saved = JSON.parse(db.getSetting('briefing_time_defaults', '{}') || '{}');
    return Object.fromEntries(TIMES.map((t) => [t.key, (saved[t.key] || '').trim() || TIME_DEFAULTS[t.key]]));
  }

  // Catalogue + lead dashboards for a client's suites (cheap; no Looker).
  function clientCatalogue(entityId) {
    const suites = db.listSuitesForEntity(entityId);
    const catalogue = [];
    const leads = []; // first top-level dashboard (+ its tabs) per set
    for (const su of suites) {
      for (const sid of su.setIds) {
        const set = db.getSet(sid);
        if (!set) continue;
        const entries = set.dashboards || [];
        const valid = new Set(entries.map((e) => e.id));
        const tops = entries.filter((e) => !e.parentId || !valid.has(e.parentId));
        for (const e of entries) {
          const d = store.get(e.id);
          if (d) catalogue.push({ dashboardId: d.id, title: d.title, setName: set.name, suiteId: su.id, suiteName: su.name });
        }
        const lead = tops[0];
        if (lead) leads.push({ suiteId: su.id, suiteName: su.name, setName: set.name, dashboardIds: [lead.id, ...entries.filter((e) => e.parentId === lead.id).map((e) => e.id)] });
      }
    }
    return { suites, catalogue, leads };
  }

  // Cheap home data (no Looker): greeting context, browsing shortcuts, settlement
  // teaser, dashboard catalogue. Called on every home load.
  function buildLightSnapshot(user, entityId) {
    const entity = db.getEntity(entityId);
    if (!entity) return null;
    const { catalogue } = clientCatalogue(entityId);
    const prof = db.viewProfile(user.id);
    const byId = Object.fromEntries(catalogue.map((c) => [c.dashboardId, c]));
    const shortcuts = prof.top.filter((t) => byId[t.dashboardId]).map((t) => ({ ...t, ...byId[t.dashboardId] })).slice(0, 4);
    const latest = db.listSettlements({ entityIds: [entityId] })[0] || null;
    const fresh = latest && (Date.now() - new Date(latest.settlementDate || latest.createdAt).getTime()) < 60 * 864e5;

    // Pinned tiles render as REAL tiles on the home page: ship the tile def plus
    // the dashboard's effective filter values (defaults + suite locks) so the
    // client runs them exactly like the dashboard view would.
    const pinnedTiles = [];
    const lockCache = {};
    const viewCache = {}; // dashboardId -> client-default saved filter view
    for (const m of db.listMarks({ userId: user.id, entityId, kind: 'pin' })) {
      const meta = byId[m.dashboardId];
      const def = meta && store.get(m.dashboardId);
      if (!def) continue;
      const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))];
      const tile = tiles.find((t) => t.id === m.tileId);
      if (!tile || tile.type === 'text') continue;
      lockCache[meta.suiteId] = lockCache[meta.suiteId] || expandLockMap(db.lockedFiltersForSuite(meta.suiteId));
      if (!(def.id in viewCache)) viewCache[def.id] = db.getFilterView('entity', entityId, def.id);
      pinnedTiles.push({
        tile, suiteId: meta.suiteId, dashboardId: def.id, dashTitle: def.title, setName: meta.setName,
        filterValues: effectiveFilterValues(def, lockCache[meta.suiteId], viewCache[def.id]), scope: m.scope,
      });
    }
    // Apply the user's chosen pin order (pins not in the list fall to the end by
    // pin time), THEN cap — so a reordered pin can't be dropped by the cap.
    let pinOrder = [];
    try { pinOrder = JSON.parse(db.getUserPref(user.id, `pin_order:${entityId}`) || '[]'); } catch { pinOrder = []; }
    if (pinOrder.length) {
      const rank = (p) => { const i = pinOrder.indexOf(`${p.dashboardId}|${p.tile.id}`); return i === -1 ? Number.MAX_SAFE_INTEGER : i; };
      pinnedTiles.sort((a, b) => rank(a) - rank(b));
    }
    pinnedTiles.splice(8); // cap at 8 after ordering

    return {
      entity: { id: entity.id, name: entity.name },
      generatedAt: new Date().toISOString(),
      lastVisit: prof.lastVisit,
      shortcuts, catalogue, settlement: fresh ? latest : null,
      pinnedTiles,
    };
  }

  // Heavy facts for the briefing (Looker reads): pinned tiles first (always
  // covered), then the lead dashboards' value/chart/table tiles, capped, with
  // row-limited data. Bounded for scale + behind the briefing cache.
  const FACT_MAX_TILES = 18;
  // Within a dashboard, prefer the headline/cumulative tiles (Total sold, Gross
  // revenue, Orders…) over noisy time-windowed ones (last hour, per-minute) that
  // are often ~0 at digest time — so the briefing/digest leads with the numbers
  // that matter, not whatever happens to sit first on the board.
  const NOISY_TILE = /\b(last|current|this)\s*(hour|min(ute)?s?)\b|per\s*(minute|min|hour|sec)|\/\s*(min|hour|sec)\b|minute\s*10|real[-\s]?time|\blive\b/i;
  const SUMMARY_TILE = /\b(total|gross|cumulative|overall|net|sold|revenue|orders?|sell[-\s]?through|attendance|to[-\s]?date|lifetime|ytd)\b/i;
  function tilePriority(t) {
    const title = t.title || '';
    let s = 0;
    if (NOISY_TILE.test(title)) s += 100;   // pick later
    if (SUMMARY_TILE.test(title)) s -= 10;  // pick first
    return s;
  }
  // What every event's briefing always tries to cover, on top of the ticketing
  // headline. Toggleable per reader (Tune → "What the briefing covers"); default all
  // on. Each has a tile-title matcher (ga4 is matched by set/dashboard name instead).
  const BRIEF_CATS = [
    { key: 'daily_sales', label: 'Daily sales pace', re: /daily\s*sales|sales\s*(by\s*)?day|sales\s*per\s*day|day(?:'s)?\s*sales/i },
    { key: 'ticket_types', label: 'Ticket-type mix', re: /ticket\s*type|type\s*of\s*ticket|tickets?\s*by\s*type|by\s*ticket\s*type/i },
    { key: 'abandoned', label: 'Abandoned carts', re: /abandon/i },
    { key: 'audience', label: 'Audience: age, gender, country/city', re: /\bage\b|gender|demographic|nationalit|\bcountr|province|\bcit(y|ies)\b|catchment|\bregion\b/i },
    { key: 'ga4', label: 'Website traffic (GA4)', re: null },
  ];
  function briefingCats(userId, entityId) {
    const all = BRIEF_CATS.map((c) => c.key);
    let on = null;
    try { on = JSON.parse(db.getUserPref(userId, `briefing_cats:${entityId}`) || 'null'); } catch { on = null; }
    return Array.isArray(on) ? new Set(on.filter((k) => all.includes(k))) : new Set(all); // default: all on
  }
  async function buildFacts(user, entityId, force = false, alignDaysBefore = false, priorityDashboards = [], opts = {}) {
    const { catalogue, leads, suites: catSuites } = clientCatalogue(entityId);
    const follows = db.listMarks({ userId: user.id, entityId, kind: 'follow' });
    const dashMeta = Object.fromEntries(catalogue.map((c) => [c.dashboardId, c]));
    // Suite name by suiteId — authoritative even for SHARED dashboards (where the
    // dashboardId→meta map is last-suite-wins, so it would mislabel the event).
    const suiteNameById = Object.fromEntries((catSuites || []).map((s) => [s.id, s.name]));
    // Optional: restrict the whole fact-gather to a set of suites (multi-event
    // briefing scopes to the selected events). Null = every suite (default).
    const suiteSet = Array.isArray(opts.suiteIds) && opts.suiteIds.length ? new Set(opts.suiteIds) : null;
    // Scale the tile budget when covering multiple events so each gets a fair share
    // (≈10 tiles/event, capped) rather than all events squeezing into the single cap.
    const maxTiles = suiteSet ? Math.min(72, Math.max(FACT_MAX_TILES, suiteSet.size * 14)) : FACT_MAX_TILES;
    const enabledCats = briefingCats(user.id, entityId); // which always-include categories are on
    const picks = []; // { tile, def, suiteId, setName, dashTitle, pinned }
    const seen = new Set();
    // `pinned` = READER-CHOSEN (a followed tile or an explicit Tune focus pick).
    // It renders as [FOLLOWED] to the model, which must address every one — so
    // the auto-guaranteed fillers (ticket headline, GA4, rotation) must NOT set
    // it, or the reader's actual picks drown in a sea of [FOLLOWED] ticketing.
    const addTile = (def, tile, suiteId, pinned) => {
      const meta = dashMeta[def.id];
      const sid = suiteId || meta?.suiteId;
      if (suiteSet && !suiteSet.has(sid)) return; // not in the selected events
      // Dedupe per dashboard+tile — but when scoped to multiple events (suiteSet),
      // a SHARED dashboard must contribute once PER event (each resolved with that
      // event's own locks), so include the suite in the signature there.
      const sig = suiteSet ? `${sid}|${def.id}|${tile.id}` : `${def.id}|${tile.id}`;
      if (seen.has(sig)) return;
      picks.push({ tile, def, suiteId: sid, setName: meta?.setName || '', dashTitle: def.title, pinned: !!pinned });
      seen.add(sig);
    };
    // 1) Followed tiles — wherever they live — always make the cut.
    for (const p of follows) {
      const def = store.get(p.dashboardId);
      if (!def) continue;
      const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))];
      const tile = tiles.find((t) => t.id === p.tileId);
      if (tile) addTile(def, tile, dashMeta[def.id]?.suiteId, true);
    }
    // 1b) Explicit briefing focus tiles (reader-chosen, like a digest's curated
    //     tiles). tileId '*' = the whole dashboard. Prioritised like follows.
    //     A pick may be scoped to a lifecycle PHASE: it feeds the briefing only
    //     while its event is in that phase (a launch board leads during Launch,
    //     the gates board on Event Day). The dashboard's own event decides; a
    //     non-event dashboard matches when ANY of the client's events is in the
    //     phase (that's what "a management board for event week" means). When NO
    //     event has a resolvable phase at all (no dates, no manual phase), scoping
    //     has nothing to bite on — the pick feeds anyway rather than silently
    //     dropping the reader's explicit choice (the Tune UI nudges to set dates).
    //     Every pick's outcome lands in focusDiag so "why isn't my tile in the
    //     briefing?" is answerable (admin diagnose + server log).
    const FOCUS_WHOLE_CAP = 6; // a whole-dashboard pick can't eat the whole tile budget
    let focus = [];
    try { focus = JSON.parse(db.getUserPref(user.id, `briefing_tiles:${entityId}`) || '[]'); } catch { focus = []; }
    const suitePhase = (sid) => { const su = sid && db.getSuite(sid); return su ? resolvePhase(su.briefing || {}).key : null; };
    const entityPhases = new Set(db.listSuitesForEntity(entityId).map((su) => resolvePhase(su.briefing || {}).key).filter(Boolean));
    const focusDiag = []; // { dashboard, tile, phase, status } per pick, in pick order
    for (const fsel of Array.isArray(focus) ? focus : []) {
      const def = store.get(fsel.dashboardId);
      const dTitle = def?.title || fsel.dashboardId;
      const allTiles = def ? [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))] : [];
      const tTitle = fsel.tileId === '*' ? '(whole board)' : (allTiles.find((t) => t.id === fsel.tileId)?.title || fsel.tileId);
      const note = (status) => focusDiag.push({ dashboard: dTitle, tile: tTitle, phase: fsel.phase || '', status });
      if (picks.length >= maxTiles) { note('tile budget full'); continue; }
      if (!def || !dashMeta[def.id]) { note('not in this client\'s catalogue'); continue; } // must be in this client's catalogue
      let phaseNote = '';
      if (fsel.phase && PHASES.some((p) => p.key === fsel.phase)) {
        const cur = suitePhase(dashMeta[def.id]?.suiteId);
        const anyPhase = cur != null || entityPhases.size > 0; // is ANY event phase resolvable?
        if (anyPhase && !(cur ? cur === fsel.phase : entityPhases.has(fsel.phase))) {
          note(`out of phase (event is in ${cur || [...entityPhases].join('/') || '?'})`);
          continue; // out of phase right now
        }
        if (!anyPhase) phaseNote = ' (phase scope ignored — set the event dates/phase in Tune)'; // fail open, but say so
      }
      const chosen = fsel.tileId === '*'
        ? allTiles.filter((t) => t.type !== 'text' && t.query?.fields?.length).sort((a, b) => tilePriority(a) - tilePriority(b)).slice(0, FOCUS_WHOLE_CAP)
        : allTiles.filter((t) => t.id === fsel.tileId);
      if (!chosen.length) { note('tile not found on the dashboard'); continue; }
      const before = picks.length;
      for (const t of chosen) addTile(def, t, dashMeta[def.id]?.suiteId, true);
      const diagIdx = focusDiag.length; // patched after the sweep if the query drops it
      note((picks.length > before ? 'feeding the briefing' : 'already included') + phaseNote);
      focusDiag[diagIdx]._check = { dashTitle: def.title, titles: chosen.map((t) => t.title || '(untitled)') };
    }
    const PER_DASH = 4; // per-dashboard cap, shared by the priority seed + rotation fill
    // 1c) "Always include" dashboards (digest config) — their headline/cumulative
    //     tiles are guaranteed in, ahead of the rotation, so the boards that
    //     matter (e.g. ticketing, audience) are never crowded out by busier ones
    //     (e.g. GA4). Capped per dashboard like the rotation fill.
    for (const did of Array.isArray(priorityDashboards) ? priorityDashboards : []) {
      if (picks.length >= maxTiles) break;
      const def = store.get(did);
      if (!def || !dashMeta[did]) continue; // must be in this client's catalogue
      const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))]
        .filter((t) => t.type !== 'text' && t.query?.fields?.length)
        .sort((a, b) => tilePriority(a) - tilePriority(b));
      let taken = 0;
      for (const t of tiles) { if (taken >= PER_DASH || picks.length >= maxTiles) break; const before = picks.length; addTile(def, t, dashMeta[did]?.suiteId, false); if (picks.length > before) taken += 1; }
    }
    const isAnalyticsName = (name) => /\bga4\b|analytics|google/i.test(name || '');
    // 1d0) Guarantee the AUTHORITATIVE ticketing HEADLINE tiles by CONTENT, so the lead
    //      sales figures are always present even when set/dashboard naming doesn't say
    //      "ticketing/overview" (which is what let a Reps board take the lead). Match
    //      tiles like "Total Tickets Sold", "Gross Revenue", "Orders" — excluding
    //      analytics/GA4 sources (their "tickets" are funnel interest, not sales).
    const TICKET_HEADLINE = /total\s*tickets|tickets?\s*sold|gross\s*(revenue|sales)|\bnet\s*sales\b|tickets?\s*revenue|sell[-\s]?through|attendance|checked?[-\s]?in|daily\s*sales|sales\s*(by\s*)?day|ticket\s*type|tickets?\s*by\s*type/i;
    let head = 0; const HEAD_BUDGET = 4;
    for (const c of catalogue) {
      if (head >= HEAD_BUDGET || picks.length >= maxTiles) break;
      if (isAnalyticsName(c.setName) || isAnalyticsName(c.title)) continue;
      const def = store.get(c.dashboardId);
      if (!def || !dashMeta[c.dashboardId]) continue;
      const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((t) => t.tiles || []))]
        .filter((t) => t.type !== 'text' && t.query?.fields?.length && TICKET_HEADLINE.test(t.title || ''))
        .sort((a, b) => tilePriority(a) - tilePriority(b));
      for (const t of tiles) {
        if (head >= HEAD_BUDGET || picks.length >= maxTiles) break;
        const before = picks.length; addTile(def, t, c.suiteId, false);
        if (picks.length > before) head += 1;
      }
    }
    // 1d) ALWAYS lead with TICKETING. Pull the ticketing set's OVERVIEW headline tiles
    //     first (tickets sold, revenue, orders) — across the WHOLE ticketing set, not
    //     just its first-listed dashboard — so a non-overview board (e.g. a Reps
    //     dashboard that happens to be listed first) can't take the lead and make the
    //     briefing read "reps-only". Detected by set name; analytics/GA4 sets excluded.
    //     Capped (TKT_BUDGET) so the other boards still get plenty of the budget.
    const isTicketingSet = (name) => /ticket/i.test(name || '') && !/\bga4\b|analytics|google/i.test(name || '');
    const isOverviewDash = (title) => /overview|summary|headline/i.test(title || '');
    // 1c2) MULTI-EVENT BALANCE: when scoped to several events, fill EACH event with a
    //      spread across ITS dashboards — round-robin so a section isn't all
    //      ticketing: lead with ticketing/overview, then GA4, audience, then the
    //      rest (cashless/vendor last — they're empty pre-event). This both keeps the
    //      events fair (each gets its own budget) and gives them breadth.
    if (suiteSet) {
      const perEvent = Math.max(6, Math.floor(maxTiles / suiteSet.size));
      const rank = (c) => {
        const n = `${c.setName} ${c.title}`.toLowerCase();
        if (isTicketingSet(c.setName)) return isOverviewDash(c.title) ? 0 : 1;
        if (/\bga4\b|analytics|google/.test(n)) return enabledCats.has('ga4') ? 2 : 9;          // traffic / funnel
        if (/audience|fan|customer|demograph|marketing/.test(n)) return enabledCats.has('audience') ? 3 : 7;
        if (/cashless|vendor|\bbar\b|token|product/.test(n)) return 8; // empty pre-event → last
        return 5;
      };
      // Always include, per event, the reader's enabled categories (daily-sales,
      // ticket-types, abandoned carts, audience) — matched by tile title.
      const MUST = BRIEF_CATS.filter((cat) => cat.re && enabledCats.has(cat.key)).map((cat) => cat.re);
      for (const sid of suiteSet) {
        let count = 0; // tiles taken for THIS event — caps it at perEvent so later
        // events aren't starved (the global maxTiles guard alone isn't enough).
        const dashes = catalogue.filter((c) => c.suiteId === sid).map((c) => store.get(c.dashboardId)).filter(Boolean);
        for (const re of MUST) {
          for (const def of dashes) {
            const m = [...(def.tiles || []), ...((def.carousels || []).flatMap((t) => t.tiles || []))].find((t) => t.type !== 'text' && t.query?.fields?.length && re.test(t.title || ''));
            if (m) { const before = picks.length; addTile(def, m, sid, false); if (picks.length > before) count += 1; break; }
          }
        }
        const pools = catalogue.filter((c) => c.suiteId === sid)
          .map((c) => ({ c, def: store.get(c.dashboardId) }))
          .filter((x) => x.def)
          .sort((a, b) => rank(a.c) - rank(b.c))
          .map(({ def }) => ({ def, tiles: [...(def.tiles || []), ...((def.carousels || []).flatMap((t) => t.tiles || []))].filter((t) => t.type !== 'text' && t.query?.fields?.length).sort((a, b) => tilePriority(a) - tilePriority(b)), idx: 0, taken: 0 }))
          .filter((p) => p.tiles.length);
        let progressed = true;
        while (count < perEvent && progressed && picks.length < maxTiles) {
          progressed = false;
          for (const pool of pools) {
            if (count >= perEvent || picks.length >= maxTiles) break;
            if (pool.idx < pool.tiles.length && pool.taken < PER_DASH) {
              const t = pool.tiles[pool.idx++]; const before = picks.length;
              addTile(pool.def, t, sid, false);
              if (picks.length > before) { pool.taken += 1; count += 1; progressed = true; }
            }
          }
        }
      }
    }
    const ticketingDashes = catalogue
      .filter((c) => isTicketingSet(c.setName))
      .sort((a, b) => (isOverviewDash(b.title) ? 1 : 0) - (isOverviewDash(a.title) ? 1 : 0)); // overview boards first
    let tkt = 0; const TKT_BUDGET = 8;
    for (const c of ticketingDashes) {
      if (tkt >= TKT_BUDGET || picks.length >= maxTiles) break;
      const def = store.get(c.dashboardId);
      if (!def || !dashMeta[c.dashboardId]) continue;
      const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((t) => t.tiles || []))]
        .filter((t) => t.type !== 'text' && t.query?.fields?.length)
        .sort((a, b) => tilePriority(a) - tilePriority(b));
      let taken = 0;
      for (const t of tiles) {
        if (taken >= PER_DASH || tkt >= TKT_BUDGET || picks.length >= maxTiles) break;
        const before = picks.length; addTile(def, t, c.suiteId, false);
        if (picks.length > before) { taken += 1; tkt += 1; }
      }
    }
    // 1e) Guarantee a little GA4/ANALYTICS — but ONLY if the client actually has an
    //     analytics set (else this is a no-op). A small budget so the traffic/
    //     funnel headline tiles always make the cut without crowding out ticketing.
    const isAnalyticsSet = (name) => /\bga4\b|analytics|google/i.test(name || '');
    let ga = 0; const GA_BUDGET = enabledCats.has('ga4') ? 3 : 0; // off when the reader hides GA4
    for (const lead of leads) {
      if (ga >= GA_BUDGET || picks.length >= maxTiles) break;
      if (!isAnalyticsSet(lead.setName)) continue;
      for (const did of lead.dashboardIds) {
        if (ga >= GA_BUDGET || picks.length >= maxTiles) break;
        const def = store.get(did);
        if (!def || !dashMeta[did]) continue;
        const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((t) => t.tiles || []))]
          .filter((t) => t.type !== 'text' && t.query?.fields?.length)
          .sort((a, b) => tilePriority(a) - tilePriority(b));
        let taken = 0;
        for (const t of tiles) {
          if (taken >= PER_DASH || ga >= GA_BUDGET || picks.length >= maxTiles) break;
          const before = picks.length; addTile(def, t, lead.suiteId, false);
          if (picks.length > before) { taken += 1; ga += 1; }
        }
      }
    }
    // 2) Fill from EVERY dashboard across the client's sets, round-robin so the
    //    budget spreads over the whole catalogue (Payments, Comps, Resale…)
    //    instead of the first dashboard eating it. A per-dashboard cap keeps any
    //    one dashboard from dominating, and a daily rotation offset starts the
    //    sweep at a different dashboard each day — so the briefing's coverage
    //    (and therefore its story) naturally varies day to day.
    const pools = [];
    const pooled = new Set();
    for (const c of catalogue) {
      if (suiteSet && !suiteSet.has(c.suiteId)) continue; // only the selected events
      // One pool per dashboard — but per (suite, dashboard) when scoped to multiple
      // events, so a shared dashboard fills each event with its own scoped tiles.
      const pkey = suiteSet ? `${c.suiteId}|${c.dashboardId}` : c.dashboardId;
      if (pooled.has(pkey)) continue;
      pooled.add(pkey);
      const def = store.get(c.dashboardId);
      if (!def) continue;
      const tiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((t) => t.tiles || []))]
        .filter((t) => t.type !== 'text' && t.query?.fields?.length)
        .sort((a, b) => tilePriority(a) - tilePriority(b)); // headline/cumulative tiles first, noisy time-windowed last
      if (tiles.length) pools.push({ def, suiteId: c.suiteId, tiles, idx: 0, taken: 0 });
    }
    const offset = pools.length ? Math.floor(Date.now() / 864e5) % pools.length : 0;
    const rotated = [...pools.slice(offset), ...pools.slice(0, offset)];
    let progressed = true;
    while (picks.length < maxTiles && progressed) {
      progressed = false;
      for (const pool of rotated) {
        if (picks.length >= maxTiles) break;
        while (pool.idx < pool.tiles.length && pool.taken < PER_DASH) {
          const tile = pool.tiles[pool.idx++];
          const before = picks.length;
          addTile(pool.def, tile, pool.suiteId, false);
          if (picks.length > before) { pool.taken += 1; progressed = true; break; }
        }
      }
    }

    // Suite locked filters (Current Event / Cashless) per suite, resolved once
    // and expanded so name-keyed locks also match by field.
    const lockMaps = {};
    for (const p of picks) if (p.suiteId && !(p.suiteId in lockMaps)) lockMaps[p.suiteId] = expandLockMap(db.lockedFiltersForSuite(p.suiteId));
    // Client-default saved filters per dashboard (e.g. a management board with the
    // event filter cleared) — so briefing facts match what the dashboard shows
    // instead of dying on the narrow built-in defaults. Mapped name→query field
    // via each tile's listenTo (ANY_VALUE rides through, dropped by stripAnyValue).
    const entityViews = {};
    for (const p of picks) if (!(p.def.id in entityViews)) entityViews[p.def.id] = db.getFilterView('entity', entityId, p.def.id) || null;
    // Days-to-go alignment (opt-in): per dashboard with a days-before sync in apply
    // mode, resolve { filterName: expr } once and layer it onto each tile's query.
    // Keyed by SUITE+dashboard — a shared dashboard's alignment differs per event
    // (each event's days-to-go), so it must not be computed once and reused.
    const dboKey = (p) => `${p.suiteId}|${p.def.id}`;
    const daysBeforeOverlays = {};
    const tOverlay = Date.now();
    if (alignDaysBefore) {
      // Resolve each unique suite+dashboard overlay in parallel — every one is a
      // Looker round-trip, so a sequential loop here serialised N calls before the
      // (already-parallel) tile sweep could even start.
      const uniq = []; const seenDbo = new Set();
      for (const p of picks) { const k = dboKey(p); if (!seenDbo.has(k)) { seenDbo.add(k); uniq.push(p); } }
      await Promise.all(uniq.map(async (p) => { daysBeforeOverlays[dboKey(p)] = await daysBeforeOverlayFor(p.def, user, p.suiteId, lockMaps[p.suiteId] || {}); }));
    }
    const overlayMs = Date.now() - tOverlay;

    const dropped = []; // tiles excluded from the facts, with the reason (logged below)
    const slow = []; // per-tile query durations, for the diagnostics log
    const tSweep = Date.now();
    const tiles = (await Promise.all(picks.slice(0, maxTiles).map(async (p) => {
      const view = entityViews[p.def.id];
      const extra = {};
      if (view) for (const [fname, qfield] of Object.entries(p.tile.listenTo || {})) if (fname in view) extra[qfield] = view[fname];
      // Days-to-go overlay — but NOT for analytics/GA4 (they have no days-before-event
      // axis; forcing one can return zero, which is what broke GA4 tiles in the briefing).
      const dbo = isAnalyticsName(p.setName) ? null : daysBeforeOverlays[dboKey(p)];
      if (dbo) for (const [fname, qfield] of Object.entries(p.tile.listenTo || {})) if (fname in dbo) extra[qfield] = dbo[fname];
      // Expand the dashboard's client-default saved filters into the lock map (suite
      // locks still win), exactly like resolveTileValue — so a GA4 tile gets its saved
      // DATE RANGE (without which GA4 explores return 0) instead of dropping out.
      const lockMap = { ...expandLockMap(view || {}), ...(lockMaps[p.suiteId] || {}) };
      const body = await tileQueryBody(p.tile, p.def, user, p.suiteId, lockMap, extra);
      if (!body) { dropped.push(`${p.dashTitle} › ${p.tile.title || '?'} (scope blocked / unrunnable)`); return null; }
      const tQ = Date.now();
      try {
        const data = await runLookerQuery('/queries/run/json_detail', body, undefined, force);
        slow.push({ t: `${p.dashTitle} › ${p.tile.title || '?'}`, ms: Date.now() - tQ });
        if (!data?.data?.length) { dropped.push(`${p.dashTitle} › ${p.tile.title || '?'} (no rows for the default filters)`); return null; }
        return {
          title: p.tile.title || '(untitled)', visType: p.tile.vis?.type, context: p.tile.aiContext || '',
          fields: data.fields, rows: data.data, filters: body.filters || {},
          dashboardId: p.def.id, suiteId: p.suiteId, suiteName: suiteNameById[p.suiteId] || dashMeta[p.def.id]?.suiteName || '', setName: p.setName, dashTitle: p.dashTitle, pinned: p.pinned,
        };
      } catch (e) { slow.push({ t: `${p.dashTitle} › ${p.tile.title || '?'}`, ms: Date.now() - tQ }); dropped.push(`${p.dashTitle} › ${p.tile.title || '?'} (error: ${e.message})`); return null; }
    }))).filter(Boolean);
    const sweepMs = Date.now() - tSweep;

    // Reconcile the focus diag with what actually RAN: a pick can pass selection
    // yet still drop at query time (no rows / scope blocked). Patch its status so
    // the diagnose tells the truth instead of "feeding the briefing".
    for (const f of focusDiag) {
      if (!f._check) continue;
      const fed = tiles.filter((t) => t.dashTitle === f._check.dashTitle && f._check.titles.includes(t.title)).length;
      if (!fed) f.status = 'picked, but the query returned no rows / was blocked — see dropped tiles' + (f.status.includes('(') ? f.status.slice(f.status.indexOf(' (')) : '');
      else if (f.tile === '(whole board)' && fed < f._check.titles.length) f.status = f.status.replace('feeding the briefing', `feeding the briefing (${fed}/${f._check.titles.length} tiles returned data)`);
      delete f._check;
    }
    if (focusDiag.length) console.log(`[facts] entity=${entityId} focus picks: ${focusDiag.map((f) => `${f.dashboard}›${f.tile}${f.phase ? `@${f.phase}` : ''} → ${f.status}`).join(' · ')}`);

    // Why a dashboard might be missing from a briefing/digest: tiles drop when the
    // explore can't be scoped, or the query returns no rows. Log it so it's not a
    // mystery (visible in the server logs when a digest is built/tested).
    if (dropped.length) console.warn(`[facts] entity=${entityId} kept ${tiles.length} tiles, dropped ${dropped.length}: ${dropped.slice(0, 25).join(' · ')}`);
    if (tiles.length) console.log(`[facts] entity=${entityId} dashboards in facts: ${[...new Set(tiles.map((t) => t.dashTitle))].join(' · ')}`);
    // ── DIAGNOSTICS ── where the fact sweep's wall-clock went. force=true (a hard
    // refresh) bypasses the Looker query cache, so every tile re-runs live.
    const top = slow.sort((a, b) => b.ms - a.ms).slice(0, 5);
    console.log(`[briefing-timing] facts entity=${entityId} force=${!!force} picks=${picks.length} ran=${slow.length} overlays=${overlayMs}ms sweep=${sweepMs}ms slowest=[${top.map((s) => `${s.ms}ms ${s.t}`).join(' | ')}]`);
    const timing = { overlayMs, sweepMs, picks: picks.length, ran: slow.length, slowest: top };

    return { tiles, catalogue, dropped, timing, focusDiag };
  }

  // Current calendar date in the client's timezone, e.g.
  // "Tuesday, 16 June 2026 (ISO 2026-06-16)". Passed to the AI so the digest/
  // briefing anchor "today/yesterday/month-to-date" to the SEND date — not the
  // latest (possibly lagging) date in the data. The ISO form gives the model an
  // exact YYYY-MM to match against date/month pivot keys, so a tile that spans
  // several months can't have a completed PRIOR month read as "this month"
  // (a June cumulative was headlined as the month's revenue on 14 July).
  function todayLabel(tz = 'Africa/Johannesburg') {
    try {
      const d = new Date();
      const pretty = d.toLocaleDateString('en-ZA', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      const iso = d.toLocaleDateString('en-CA', { timeZone: tz }); // en-CA renders YYYY-MM-DD
      return `${pretty} (ISO ${iso})`;
    } catch { return new Date().toISOString().slice(0, 10); }
  }

  // Best display value for a fact tile (first measure → table calc → dimension of
  // the first row), preferring Looker's rendered string. Used by the digest/
  // briefing facts inspectors to show what each tile resolved to.
  function factValueLabel(t) {
    const row = (t.rows || [])[0];
    if (!row) return '—';
    const fields = [...(t.fields?.measures || []), ...(t.fields?.table_calculations || []), ...(t.fields?.dimensions || [])];
    for (const f of fields) {
      const cell = row[f.name];
      if (cell && (cell.rendered != null || cell.value != null)) return String(cell.rendered != null ? cell.rendered : cell.value);
    }
    return '—';
  }
  // The tile's data RANGE: first row's → last row's first-dimension value (e.g.
  // "2026-06-01 → 2026-07-14"), so the facts inspectors show at a glance WHICH
  // period a tile actually served — a stale month, a wrong-month series or a
  // truncated range is visible without opening the dashboard.
  function factSpanLabel(t) {
    const rows = t.rows || [];
    const dim = (t.fields?.dimensions || [])[0];
    if (rows.length < 2 || !dim) return '';
    const val = (row) => { const c = row[dim.name]; return c == null ? '' : String(c.rendered ?? c.value ?? ''); };
    const a = val(rows[0]); const b = val(rows[rows.length - 1]);
    return a && b && a !== b ? `${a} → ${b}` : '';
  }

  // Curated mode: fetch a specific set of tiles (by dashboard+tile id) instead of
  // the round-robin sweep buildFacts does.
  async function buildFactsFromTiles(user, entityId, picks, alignDaysBefore = false) {
    const { catalogue } = clientCatalogue(entityId);
    const meta = Object.fromEntries(catalogue.map((c) => [c.dashboardId, c]));
    // Resolve the picks into a concrete tile list. tileId '*' = the whole
    // dashboard (all its data tiles). Capped so a "whole dashboard" pick can't
    // blow the budget.
    const wanted = [];
    const seen = new Set();
    for (const p of picks || []) {
      const def = store.get(p.dashboardId);
      const m = meta[p.dashboardId];
      if (!def || !m) continue;
      const allTiles = [...(def.tiles || []), ...((def.carousels || []).flatMap((c) => c.tiles || []))];
      const chosen = p.tileId === '*'
        ? allTiles.filter((t) => t.type !== 'text' && t.query?.fields?.length)
        : allTiles.filter((t) => t.id === p.tileId);
      for (const tile of chosen) {
        const sig = `${def.id}|${tile.id}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        wanted.push({ tile, def, m });
      }
    }
    const lockMaps = {};
    const entityViews = {};
    const daysBeforeOverlays = {};
    const out = [];
    const dropped = [];
    for (const { tile, def, m } of wanted.slice(0, 24)) {
      if (!(m.suiteId in lockMaps)) lockMaps[m.suiteId] = expandLockMap(db.lockedFiltersForSuite(m.suiteId));
      if (!(def.id in entityViews)) entityViews[def.id] = db.getFilterView('entity', entityId, def.id) || null;
      if (alignDaysBefore && !(def.id in daysBeforeOverlays)) daysBeforeOverlays[def.id] = await daysBeforeOverlayFor(def, user, m.suiteId, lockMaps[m.suiteId] || {});
      const view = entityViews[def.id];
      const dbo = daysBeforeOverlays[def.id];
      const extra = {};
      if (view) for (const [fname, qfield] of Object.entries(tile.listenTo || {})) if (fname in view) extra[qfield] = view[fname];
      if (dbo) for (const [fname, qfield] of Object.entries(tile.listenTo || {})) if (fname in dbo) extra[qfield] = dbo[fname];
      // Expand the dashboard's client-default saved filters into the lock map (suite locks
      // win), like resolveTileValue — so GA4 tiles get their saved DATE RANGE and don't
      // come back empty (they were missing entirely from curated digests before).
      const lockMap = { ...expandLockMap(view || {}), ...(lockMaps[m.suiteId] || {}) };
      const body = await tileQueryBody(tile, def, user, m.suiteId, lockMap, extra);
      if (!body) { dropped.push(`${def.title} › ${tile.title || '?'} (scope blocked / unrunnable)`); continue; }
      try {
        const data = await runLookerQuery('/queries/run/json_detail', body, undefined, false);
        if (!data?.data?.length) { dropped.push(`${def.title} › ${tile.title || '?'} (no rows for the default filters)`); continue; }
        out.push({ title: tile.title || '(untitled)', visType: tile.vis?.type, context: tile.aiContext || '', fields: data.fields, rows: data.data, pivots: data.pivots || [], filters: body.filters || {}, dashboardId: def.id, suiteId: m.suiteId, setName: m.setName, dashTitle: def.title, pinned: false });
      } catch (e) { dropped.push(`${def.title} › ${tile.title || '?'} (error: ${e.message})`); }
    }
    if (dropped.length) console.warn(`[facts:curated] entity=${entityId} kept ${out.length}, dropped ${dropped.length}: ${dropped.slice(0, 25).join(' · ')}`);
    return { tiles: out, catalogue, dropped };
  }

  return { PHASES, PHASE_DEFAULTS, resolvePhase, phaseDefaults, TIMES, TIME_DEFAULTS, timeSegment, timeDefaults, clientCatalogue, buildLightSnapshot, FACT_MAX_TILES, NOISY_TILE, SUMMARY_TILE, tilePriority, BRIEF_CATS, briefingCats, buildFacts, todayLabel, buildFactsFromTiles, factValueLabel, factSpanLabel };
};
