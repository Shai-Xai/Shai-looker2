// ─── User action audit — SELF-CONTAINED, DISPOSABLE MODULE ───────────────────
// Records every meaningful state-changing request (and a few deliberate page
// "views") against a declarative route map, so Admin → Users can show exactly
// what each person did and when. One write per request, AFTER a success — it
// never blocks or fails a request. The table + readers live in db.js
// (user_actions); this module only decides "did something audit-worthy happen,
// and what do we call it?".
//
// Coverage is an explicit allowlist, not a blanket "log every POST", so the
// timeline stays signal-rich (computational POSTs like previews/field-values are
// deliberately NOT logged). To add a new action, add a rule below — nothing else
// changes. Remove this file + its one-line mount in index.js to uninstall.
//
// Mount AFTER auth.attachUser (so req.user is populated):
//   require('./audit').mount(app, { db });

const M = {
  POST: ['POST'], PUT: ['PUT'], DELETE: ['DELETE'], PATCH: ['PATCH'],
  WRITE: ['POST', 'PUT', 'PATCH', 'DELETE'], GET: ['GET'],
};

// Each rule: { m: methods, re: /regex with capture groups/, action, label,
//   type?: target type, entity?: 'pN'|'body'|'suite:pN', target?: 'pN', view?: bool }
// Order matters: the FIRST matching rule wins, so put specific paths before
// generic ones. Regexes are anchored, so longer paths don't collide by accident.
const RULES = [
  // ── Campaigns (server/actions.js) ──────────────────────────────────────────
  { m: M.POST, re: /^\/api\/actions\/([^/]+)\/([^/]+)\/approve$/, action: 'campaign.send', label: 'Sent a campaign', type: 'campaign', entity: 'p1', target: 'p2' },
  { m: M.POST, re: /^\/api\/actions\/([^/]+)\/([^/]+)\/schedule$/, action: 'campaign.schedule', label: 'Scheduled a campaign', type: 'campaign', entity: 'p1', target: 'p2' },
  { m: M.POST, re: /^\/api\/actions\/([^/]+)\/([^/]+)\/submit$/, action: 'campaign.submit', label: 'Submitted a campaign for approval', type: 'campaign', entity: 'p1', target: 'p2' },
  { m: M.POST, re: /^\/api\/actions\/([^/]+)\/([^/]+)\/pause$/, action: 'campaign.pause', label: 'Paused a campaign', type: 'campaign', entity: 'p1', target: 'p2' },
  { m: M.POST, re: /^\/api\/actions\/([^/]+)\/([^/]+)\/reject$/, action: 'campaign.reject', label: 'Rejected a campaign', type: 'campaign', entity: 'p1', target: 'p2' },
  { m: M.POST, re: /^\/api\/actions\/([^/]+)\/([^/]+)\/duplicate$/, action: 'campaign.duplicate', label: 'Duplicated a campaign', type: 'campaign', entity: 'p1', target: 'p2' },
  { m: M.POST, re: /^\/api\/actions\/([^/]+)\/test-send$/, action: 'campaign.test', label: 'Sent a test campaign', type: 'campaign', entity: 'p1' },
  { m: M.PUT, re: /^\/api\/actions\/([^/]+)\/masters$/, action: 'campaign.master', label: 'Edited campaign master copy', entity: 'p1' },
  { m: M.DELETE, re: /^\/api\/actions\/([^/]+)\/masters\/([^/]+)$/, action: 'campaign.master', label: 'Deleted a campaign master', entity: 'p1' },
  { m: M.PUT, re: /^\/api\/actions\/([^/]+)\/approval-setting$/, action: 'campaign.approval', label: 'Changed campaign approval setting', entity: 'p1' },
  { m: M.POST, re: /^\/api\/actions\/([^/]+)$/, action: 'campaign.create', label: 'Created a campaign', type: 'campaign', entity: 'p1' },
  { m: M.PUT, re: /^\/api\/actions\/([^/]+)\/([^/]+)$/, action: 'campaign.edit', label: 'Edited a campaign', type: 'campaign', entity: 'p1', target: 'p2' },
  { m: M.DELETE, re: /^\/api\/actions\/([^/]+)\/([^/]+)$/, action: 'campaign.delete', label: 'Deleted a campaign', type: 'campaign', entity: 'p1', target: 'p2' },

  // ── Segments (server/segments.js) ──────────────────────────────────────────
  { m: M.POST, re: /^\/api\/segments\/([^/]+)\/recipe\/([^/]+)$/, action: 'segment.create', label: 'Created a segment from a recipe', type: 'segment', entity: 'p1' },
  { m: M.POST, re: /^\/api\/segments\/([^/]+)\/([^/]+)\/sync\/meta$/, action: 'segment.sync', label: 'Synced a segment to Meta', type: 'segment', entity: 'p1', target: 'p2' },
  { m: M.POST, re: /^\/api\/segments\/([^/]+)\/([^/]+)\/sync\/tiktok$/, action: 'segment.sync', label: 'Synced a segment to TikTok', type: 'segment', entity: 'p1', target: 'p2' },
  { m: M.PUT, re: /^\/api\/segments\/([^/]+)\/([^/]+)\/sync\/([^/]+)\/auto$/, action: 'segment.sync-auto', label: 'Changed segment auto-sync', type: 'segment', entity: 'p1', target: 'p2' },
  { m: M.POST, re: /^\/api\/segments\/([^/]+)$/, action: 'segment.create', label: 'Created a segment', type: 'segment', entity: 'p1' },
  { m: M.PATCH, re: /^\/api\/segments\/([^/]+)\/([^/]+)$/, action: 'segment.edit', label: 'Edited a segment', type: 'segment', entity: 'p1', target: 'p2' },
  { m: M.DELETE, re: /^\/api\/segments\/([^/]+)\/([^/]+)$/, action: 'segment.delete', label: 'Deleted a segment', type: 'segment', entity: 'p1', target: 'p2' },

  // ── Goals (server/goals.js) ────────────────────────────────────────────────
  { m: M.POST, re: /^\/api\/goals\/suites\/([^/]+)$/, action: 'goal.create', label: 'Set a goal', type: 'goal', entity: 'suite:p1' },
  { m: M.GET, re: /^\/api\/goals\/suites\/([^/]+)$/, action: 'goal.view', label: 'Viewed goals', type: 'goal', entity: 'suite:p1', view: true },
  { m: M.POST, re: /^\/api\/goals\/templates$/, action: 'goal.template', label: 'Created a goal template' },
  { m: M.DELETE, re: /^\/api\/goals\/templates\/([^/]+)$/, action: 'goal.template.delete', label: 'Deleted a goal template' },
  { m: M.POST, re: /^\/api\/goals\/([^/]+)\/snapshot$/, action: 'goal.snapshot', label: 'Saved a goal snapshot', type: 'goal', target: 'p1' },
  { m: M.PUT, re: /^\/api\/goals\/([^/]+)$/, action: 'goal.edit', label: 'Updated a goal', type: 'goal', target: 'p1' },
  { m: M.DELETE, re: /^\/api\/goals\/([^/]+)$/, action: 'goal.delete', label: 'Deleted a goal', type: 'goal', target: 'p1' },

  // ── Alerts (server/alerts.js) ──────────────────────────────────────────────
  { m: M.POST, re: /^\/api\/alerts\/suites\/([^/]+)$/, action: 'alert.create', label: 'Created an alert', type: 'alert', entity: 'suite:p1' },
  { m: M.POST, re: /^\/api\/alerts\/templates$/, action: 'alert.template', label: 'Created an alert template' },
  { m: M.DELETE, re: /^\/api\/alerts\/templates\/([^/]+)$/, action: 'alert.template.delete', label: 'Deleted an alert template' },
  { m: M.POST, re: /^\/api\/alerts\/([^/]+)\/status$/, action: 'alert.status', label: 'Changed an alert status', type: 'alert', target: 'p1' },
  { m: M.PUT, re: /^\/api\/alerts\/([^/]+)$/, action: 'alert.edit', label: 'Updated an alert', type: 'alert', target: 'p1' },
  { m: M.DELETE, re: /^\/api\/alerts\/([^/]+)$/, action: 'alert.delete', label: 'Deleted an alert', type: 'alert', target: 'p1' },

  // ── Digests (server/scheduler.js) ──────────────────────────────────────────
  { m: M.POST, re: /^\/api\/my\/digests\/([^/]+)\/([^/]+)\/test$/, action: 'digest.test', label: 'Sent a test digest', type: 'digest', entity: 'p1', target: 'p2' },
  { m: M.POST, re: /^\/api\/my\/digests\/([^/]+)\/test-send(?:-sms)?$/, action: 'digest.test', label: 'Sent a test digest', type: 'digest', entity: 'p1' },
  { m: M.POST, re: /^\/api\/my\/digests\/([^/]+)$/, action: 'digest.create', label: 'Created a digest', type: 'digest', entity: 'p1' },
  { m: M.PUT, re: /^\/api\/my\/digests\/([^/]+)\/([^/]+)$/, action: 'digest.edit', label: 'Updated a digest', type: 'digest', entity: 'p1', target: 'p2' },
  { m: M.DELETE, re: /^\/api\/my\/digests\/([^/]+)\/([^/]+)$/, action: 'digest.delete', label: 'Deleted a digest', type: 'digest', entity: 'p1', target: 'p2' },
  { m: M.GET, re: /^\/api\/my\/digest-history\/([^/]+)\/([^/]+)$/, action: 'digest.view', label: 'Viewed a digest', type: 'digest', entity: 'p1', target: 'p2', view: true },
  { m: M.POST, re: /^\/api\/my\/digest-history\/([^/]+)\/([^/]+)\/feedback$/, action: 'digest.feedback', label: 'Gave digest feedback', type: 'digest', entity: 'p1', target: 'p2' },

  // ── Settings: branding / integrations / briefing / notifications / home ─────
  { m: M.PUT, re: /^\/api\/my\/notification-prefs$/, action: 'settings.notifications', label: 'Changed notification preferences', entity: 'body' },
  { m: M.PUT, re: /^\/api\/my\/integrations\/([^/]+)$/, action: 'settings.integrations', label: 'Updated integrations', entity: 'p1' },
  { m: M.PUT, re: /^\/api\/admin\/entities\/([^/]+)\/integrations$/, action: 'settings.integrations', label: 'Updated client integrations', entity: 'p1' },
  { m: M.PUT, re: /^\/api\/admin\/integrations$/, action: 'settings.integrations', label: 'Updated platform integrations' },
  { m: M.PUT, re: /^\/api\/my\/mail-template\/([^/]+)$/, action: 'settings.branding', label: 'Updated branding', entity: 'p1' },
  { m: M.PUT, re: /^\/api\/my\/suites\/([^/]+)\/mail-template$/, action: 'settings.branding', label: 'Updated event branding', entity: 'suite:p1' },
  { m: M.PUT, re: /^\/api\/admin\/entities\/([^/]+)\/mail-template$/, action: 'settings.branding', label: 'Updated client branding', entity: 'p1' },
  { m: M.PUT, re: /^\/api\/admin\/suites\/([^/]+)\/mail-template$/, action: 'settings.branding', label: 'Updated event branding', entity: 'suite:p1' },
  { m: M.PUT, re: /^\/api\/admin\/mail-template$/, action: 'settings.branding', label: 'Updated platform branding' },
  { m: M.PUT, re: /^\/api\/my\/briefing-config\/suite\/([^/]+)$/, action: 'settings.briefing', label: 'Updated briefing config', entity: 'suite:p1' },
  { m: M.PUT, re: /^\/api\/my\/briefing\/suites$/, action: 'settings.briefing', label: 'Updated briefing suites' },
  { m: M.PUT, re: /^\/api\/my\/briefing-tune$/, action: 'settings.briefing', label: 'Tuned the briefing' },
  { m: M.POST, re: /^\/api\/my\/briefing-feedback$/, action: 'briefing.feedback', label: 'Gave briefing feedback' },
  { m: M.PUT, re: /^\/api\/admin\/briefing-settings$/, action: 'settings.briefing', label: 'Updated briefing settings' },
  { m: M.PUT, re: /^\/api\/admin\/notification-settings$/, action: 'settings.notifications', label: 'Updated notification settings' },
  { m: M.POST, re: /^\/api\/my\/pins$/, action: 'home.pin', label: 'Updated home pins' },
  { m: M.PUT, re: /^\/api\/my\/pin-order$/, action: 'home.pin', label: 'Reordered home pins' },

  // ── Team (a client managing its own logins) ────────────────────────────────
  { m: M.PUT, re: /^\/api\/my\/team\/([^/]+)\/([^/]+)\/role$/, action: 'team.role', label: "Changed a teammate's role", type: 'user', entity: 'p1', target: 'p2' },
  { m: M.POST, re: /^\/api\/my\/team\/([^/]+)$/, action: 'team.invite', label: 'Invited a teammate', entity: 'p1' },
  { m: M.DELETE, re: /^\/api\/my\/team\/([^/]+)\/([^/]+)$/, action: 'team.remove', label: 'Removed a teammate', type: 'user', entity: 'p1', target: 'p2' },

  // ── Admin: clients / events / sets / dashboards ────────────────────────────
  { m: M.POST, re: /^\/api\/admin\/entities\/([^/]+)\/dashboards\/import$/, action: 'admin.dashboard.import', label: 'Imported dashboards', entity: 'p1' },
  { m: M.POST, re: /^\/api\/admin\/entities\/([^/]+)\/sets(?:\/clone)?$/, action: 'admin.client.sets', label: 'Updated client sets', entity: 'p1' },
  { m: M.POST, re: /^\/api\/admin\/entities$/, action: 'admin.client.create', label: 'Created a client' },
  { m: M.PUT, re: /^\/api\/admin\/entities\/([^/]+)$/, action: 'admin.client.edit', label: 'Updated a client', entity: 'p1' },
  { m: M.DELETE, re: /^\/api\/admin\/entities\/([^/]+)$/, action: 'admin.client.delete', label: 'Deleted a client', entity: 'p1' },
  { m: M.POST, re: /^\/api\/admin\/suites$/, action: 'admin.event.create', label: 'Created an event' },
  { m: M.PUT, re: /^\/api\/admin\/suites\/([^/]+)$/, action: 'admin.event.edit', label: 'Updated an event', entity: 'suite:p1' },
  { m: M.DELETE, re: /^\/api\/admin\/suites\/([^/]+)$/, action: 'admin.event.delete', label: 'Deleted an event' },
  { m: M.POST, re: /^\/api\/admin\/sets$/, action: 'admin.set.create', label: 'Created a set' },
  { m: M.PUT, re: /^\/api\/admin\/sets\/([^/]+)$/, action: 'admin.set.edit', label: 'Updated a set' },
  { m: M.DELETE, re: /^\/api\/admin\/sets\/([^/]+)$/, action: 'admin.set.delete', label: 'Deleted a set' },

  // ── Admin: users & roles ───────────────────────────────────────────────────
  { m: M.POST, re: /^\/api\/admin\/users\/promote$/, action: 'admin.user.promote', label: 'Promoted a user to admin', type: 'user' },
  { m: M.POST, re: /^\/api\/admin\/users$/, action: 'admin.user.create', label: 'Created a user', type: 'user' },
  { m: M.PUT, re: /^\/api\/admin\/users\/([^/]+)$/, action: 'admin.user.edit', label: 'Edited a user', type: 'user', target: 'p1' },
  { m: M.DELETE, re: /^\/api\/admin\/users\/([^/]+)$/, action: 'admin.user.delete', label: 'Deleted a user', type: 'user', target: 'p1' },
  { m: M.PUT, re: /^\/api\/admin\/entities\/([^/]+)\/logins\/([^/]+)\/role$/, action: 'admin.user.role', label: "Changed a user's client role", type: 'user', entity: 'p1', target: 'p2' },
  { m: M.PUT, re: /^\/api\/admin\/entities\/([^/]+)\/content-roles\/([^/]+)\/([^/]+)$/, action: 'admin.content-roles', label: 'Changed content visibility', entity: 'p1' },
];

const VIEW_THROTTLE_MS = 10 * 60_000; // collapse repeat "views" of the same thing

function mount(app, { db }) {
  // In-memory throttle for view rows so pollers don't flood the timeline. Resets
  // on restart — worst case a couple of extra rows, never a correctness issue.
  const lastView = new Map();

  function resolveEntity(spec, m) {
    if (!spec) return '';
    if (spec === 'body') return ''; // resolved from captured body below
    if (spec.startsWith('suite:')) {
      const sid = m[Number(spec.slice(7).replace('p', ''))];
      try { return (db.getSuite(sid) || {}).entityId || ''; } catch { return ''; }
    }
    return m[Number(spec.replace('p', ''))] || '';
  }

  app.use((req, res, next) => {
    // Capture everything we need NOW (req.url / req.body can change after the
    // response in edge cases). originalUrl is never rewritten.
    const method = req.method;
    if (!M.WRITE.includes(method) && method !== 'GET') return next();
    const rawUrl = String(req.originalUrl || req.url || '');
    const path = rawUrl.split('?')[0];
    if (!path.startsWith('/api/')) return next();
    // A passive/background fetch (home widget, admin overview) marks itself with
    // ?bg=1 so its GET isn't recorded as a deliberate "view" action — otherwise
    // every home-page load counts as "Viewed goals" and swamps the report.
    const isBackground = /[?&]bg=1(?:&|$)/.test(rawUrl);
    const body = req.body && typeof req.body === 'object' ? req.body : null;
    const bodyName = body ? (body.name || body.title || body.label || '') : '';
    const bodyEntity = body ? (body.entityId || '') : '';

    res.on('finish', () => {
      try {
        const user = req.user;
        if (!user || !user.id) return;          // only authenticated actions
        if (res.statusCode >= 400) return;       // only successful ones
        for (const rule of RULES) {
          if (!rule.m.includes(method)) continue;
          const m = rule.re.exec(path);
          if (!m) continue;
          let entityId = rule.entity === 'body' ? bodyEntity : resolveEntity(rule.entity, m);
          const targetId = rule.target ? (m[Number(rule.target.replace('p', ''))] || '') : '';
          if (rule.view) {
            if (isBackground) return; // widget/overview fetch — not a deliberate view
            const key = `${user.id}|${rule.action}|${targetId || entityId}`;
            const prev = lastView.get(key) || 0;
            if (Date.now() - prev < VIEW_THROTTLE_MS) return; // seen recently — skip
            lastView.set(key, Date.now());
          }
          const detail = bodyName ? { name: String(bodyName).slice(0, 120) } : {};
          db.recordAction({ userId: user.id, entityId, action: rule.action, label: rule.label, targetType: rule.type || '', targetId, detail, method, path });
          return; // first match wins
        }
      } catch { /* audit must never break a request */ }
    });
    next();
  });

  console.log('[audit] user action log mounted');
}

module.exports = { mount };
