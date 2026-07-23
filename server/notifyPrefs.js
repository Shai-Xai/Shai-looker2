// Per-user notification PREFERENCES layer — the granular category (digests,
// goals, alerts, messages, reports) × channel (email, push) matrix, plus the
// "pause everything" switch. Extracted from db.js (line-budget ratchet); a
// factory over the user_prefs helpers so it owns no storage of its own.
// notifyTypeOn() is the single gate every pref-respecting send consults.
module.exports = function mountNotifyPrefs({ getUserPref, setUserPref }) {
  // Per-type notification preferences — a granular layer under the email/push
  // channel switches. A user can mute a whole category (digests, goals, alerts,
  // messages) regardless of channel. Stored as JSON in user_prefs; default ON, so
  // existing users keep getting everything until they opt out.
  const NOTIFY_TYPES = [
    { key: 'digest', label: 'Digests', desc: 'When your scheduled briefing is ready' },
    { key: 'goals', label: 'Goals', desc: 'Weekly goal-progress nudges' },
    { key: 'alerts', label: 'Alerts', desc: 'Campaign & data alerts that need attention' },
    { key: 'messages', label: 'Messages', desc: 'New messages from Howler in your inbox' },
    { key: 'reports', label: 'Report updates', desc: 'Progress on bugs, improvements & ideas you reported — every stage from triage to live' },
  ];
  function getNotifyTypes(userId) {
    let stored = {};
    try { stored = JSON.parse(getUserPref(userId, 'notify_types', '') || '{}'); } catch { stored = {}; }
    const out = {};
    for (const t of NOTIFY_TYPES) out[t.key] = stored[t.key] !== false; // default on
    return out;
  }
  function setNotifyTypes(userId, partial = {}) {
    const cur = getNotifyTypes(userId);
    for (const t of NOTIFY_TYPES) if (t.key in partial) cur[t.key] = !!partial[t.key];
    setUserPref(userId, 'notify_types', JSON.stringify(cur));
    return cur;
  }
  // Per-CHANNEL per-type matrix — the granular layer. A user can switch a category
  // (digests/goals/alerts/messages) off for ONE channel (e.g. no goal emails) while
  // keeping it on for another (push). Stored as { email:{key:bool}, push:{key:bool} }
  // in user_prefs. Defaults ON; a legacy flat `notify_types` mute seeds BOTH channels
  // so existing opt-outs carry over until a per-channel pref is set.
  const NOTIFY_CHANNELS = ['email', 'push'];
  function getNotifyMatrix(userId) {
    let stored = {}; let legacy = {};
    try { stored = JSON.parse(getUserPref(userId, 'notify_matrix', '') || '{}'); } catch { stored = {}; }
    try { legacy = JSON.parse(getUserPref(userId, 'notify_types', '') || '{}'); } catch { legacy = {}; }
    const out = {};
    for (const ch of NOTIFY_CHANNELS) {
      out[ch] = {};
      for (const t of NOTIFY_TYPES) {
        const v = stored?.[ch]?.[t.key];
        out[ch][t.key] = v !== undefined ? v !== false : (legacy[t.key] !== false);
      }
    }
    return out;
  }
  function setNotifyMatrix(userId, partial = {}) {
    const cur = getNotifyMatrix(userId);
    for (const ch of NOTIFY_CHANNELS) {
      if (partial[ch] && typeof partial[ch] === 'object') {
        for (const t of NOTIFY_TYPES) if (t.key in partial[ch]) cur[ch][t.key] = !!partial[ch][t.key];
      }
    }
    setUserPref(userId, 'notify_matrix', JSON.stringify(cur));
    return cur;
  }
  // Pause ALL notifications until a date — the "I'm on leave" switch (client
  // self-service, Settings → Notifications). Stored as an ISO timestamp in
  // user_prefs ('' = not paused; year 9999 = until they resume). Enforced inside
  // notifyTypeOn(), which every pref-respecting send consults, so one switch
  // silences email + push across reports, digests, goals, alerts and messages.
  function getNotifyPause(userId) {
    const v = getUserPref(userId, 'notify_paused_until', '') || '';
    if (!v) return '';
    if (new Date(v).getTime() <= Date.now()) { setUserPref(userId, 'notify_paused_until', ''); return ''; } // expired → auto-clear
    return v;
  }
  function setNotifyPause(userId, untilIso) {
    const t = untilIso ? new Date(untilIso).getTime() : 0;
    setUserPref(userId, 'notify_paused_until', t && t > Date.now() ? new Date(t).toISOString() : '');
    return getNotifyPause(userId);
  }
  // Is a category on for this user on a given channel? With no channel, allow if it's
  // on for ANY channel (safe default for legacy callers). Unknown/blank type ⇒ allowed.
  function notifyTypeOn(userId, type, channel) {
    if (userId && getNotifyPause(userId)) return false; // paused = everything off
    if (!type) return true;
    const m = getNotifyMatrix(userId);
    if (channel && NOTIFY_CHANNELS.includes(channel)) return m[channel]?.[type] !== false;
    return NOTIFY_CHANNELS.some((ch) => m[ch]?.[type] !== false);
  }

  // Self-service routes (GET/PUT /api/my/notification-prefs) — mounted from
  // index.js with the deps the handlers need (db for the master channel toggles
  // + user lookup, push for availability). Kept here so the whole notification-
  // preference feature lives in one disposable file.
  function mountRoutes(app, { db, auth, push }) {
    app.get('/api/my/notification-prefs', auth.requireAuth, (req, res) => {
      const u = auth.publicUser(db.getUser(req.user.id));
      res.json({
        email: u?.notifyEmail !== false, push: u?.notifyPush !== false, pushAvailable: push.isEnabled(),
        types: getNotifyTypes(req.user.id), typeCatalog: NOTIFY_TYPES,
        matrix: getNotifyMatrix(req.user.id), channels: NOTIFY_CHANNELS,
        pausedUntil: getNotifyPause(req.user.id),
      });
    });
    app.put('/api/my/notification-prefs', auth.requireAuth, (req, res) => {
      const { email, push: wantPush, types, matrix } = req.body || {};
      const next = db.setNotificationPrefs(req.user.id, {
        ...(email != null ? { email: !!email } : {}),
        ...(wantPush != null ? { push: !!wantPush } : {}),
      });
      // `matrix` is the per-channel layer; `types` kept for older clients (applied
      // to every channel via the matrix's legacy seed).
      if (types && typeof types === 'object') setNotifyTypes(req.user.id, types);
      if (matrix && typeof matrix === 'object') setNotifyMatrix(req.user.id, matrix);
      // Pause everything until a date ('' / null resumes; year 9999 = indefinite).
      if ('pausedUntil' in (req.body || {})) setNotifyPause(req.user.id, req.body.pausedUntil || '');
      res.json({ ...(next || { email: true, push: true }), types: getNotifyTypes(req.user.id), matrix: getNotifyMatrix(req.user.id), pausedUntil: getNotifyPause(req.user.id) });
    });
  }

  return { NOTIFY_TYPES, NOTIFY_CHANNELS, getNotifyTypes, setNotifyTypes, getNotifyMatrix, setNotifyMatrix, notifyTypeOn, getNotifyPause, setNotifyPause, mountRoutes };
};
