// ─── Social engagement ledger — views/impressions + CTA clicks ───────────────
// FACTORY LIBRARY (see CLAUDE.md architecture notes — like server/query.js):
// owns the social_feed_impressions + social_cta_clicks tables and their
// rollup/audience logic, extracted from server/social.js to keep that module
// inside its line budget. server/social.js mounts the routes; this holds the
// engine. Wire contract: docs/specs/SOCIAL_CONTRACT.md §13b (impressions) +
// §13c (CTA clicks → segments).
const { HttpError } = require('./http');

function create({ sql, now, appUserName }) {
  sql.exec(`
    -- Views & impressions, one counter row per (post, viewer, kind, day):
    --   delivered → the post rode a feed response (logged server-side)
    --   seen      → the app reported the card actually on screen
    --   view      → a video played inline / the reel was opened
    -- howler_user_id '' = anonymous reader (counts, but not unique reach).
    CREATE TABLE IF NOT EXISTS social_feed_impressions (
      post_id        TEXT NOT NULL,
      howler_user_id TEXT NOT NULL DEFAULT '',
      kind           TEXT NOT NULL DEFAULT 'delivered',
      day            TEXT NOT NULL,
      n              INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (post_id, howler_user_id, kind, day)
    );

    -- CTA taps, one rollup row per (surface, target, user): WHO tapped an
    -- organiser CTA, how many times, with the JWT-verified name/email captured
    -- at tap time — so the clicker list can become a paste segment for
    -- campaigns. howler_user_id '' = anonymous (total only, no segment).
    CREATE TABLE IF NOT EXISTS social_cta_clicks (
      kind           TEXT NOT NULL DEFAULT 'post',  -- post | chat | comment
      ref_id         TEXT NOT NULL,
      howler_user_id TEXT NOT NULL DEFAULT '',
      name           TEXT NOT NULL DEFAULT '',
      email          TEXT NOT NULL DEFAULT '',
      n              INTEGER NOT NULL DEFAULT 0,
      first_at       TEXT NOT NULL,
      last_at        TEXT NOT NULL,
      PRIMARY KEY (kind, ref_id, howler_user_id)
    );
  `);

  const impressionUpsert = sql.prepare(`INSERT INTO social_feed_impressions (post_id, howler_user_id, kind, day, n) VALUES (?,?,?,?,1)
      ON CONFLICT(post_id, howler_user_id, kind, day) DO UPDATE SET n=n+1`);
  // ONE transaction per page, not one auto-commit per post — every feed GET
  // logs a 'delivered' impression per rendered post, so at scale this is the
  // single hottest write path in the module.
  const impressionsTx = sql.transaction((postIds, viewerId, kind, day) => {
    for (const id of postIds) impressionUpsert.run(String(id), String(viewerId || ''), kind, day);
  });
  function logImpressions(postIds, viewerId, kind) {
    if (!postIds.length) return;
    impressionsTx(postIds, viewerId, kind, new Date().toISOString().slice(0, 10));
  }

  // Per-post rollup for the management surfaces: delivered count + unique
  // reach (signed-in viewers), on-screen count, video views, and CTA taps
  // (total + unique signed-in tappers).
  function postStats(entityId) {
    const rows = sql.prepare(`SELECT i.post_id, i.kind, SUM(i.n) n,
        COUNT(DISTINCT CASE WHEN i.howler_user_id!='' THEN i.howler_user_id END) uniq
      FROM social_feed_impressions i JOIN social_feed_posts p ON p.id=i.post_id
      WHERE p.entity_id=? GROUP BY i.post_id, i.kind`).all(entityId);
    const out = {};
    for (const r of rows) {
      const s = out[r.post_id] ||= { delivered: 0, reach: 0, seen: 0, views: 0 };
      if (r.kind === 'delivered') { s.delivered = r.n; s.reach = r.uniq; }
      else if (r.kind === 'seen') s.seen = r.n;
      else if (r.kind === 'view') s.views = r.n;
    }
    const clicks = sql.prepare(`SELECT c.ref_id post_id, SUM(c.n) n,
        COUNT(DISTINCT CASE WHEN c.howler_user_id!='' THEN c.howler_user_id END) uniq
      FROM social_cta_clicks c JOIN social_feed_posts p ON p.id=c.ref_id
      WHERE c.kind='post' AND p.entity_id=? GROUP BY c.ref_id`).all(entityId);
    for (const r of clicks) {
      const s = out[r.post_id] ||= { delivered: 0, reach: 0, seen: 0, views: 0 };
      s.ctaClicks = r.n; s.ctaUsers = r.uniq;
    }
    return out;
  }

  // One CTA tap. Anonymous ok (viewer null → total only); signed-in taps
  // capture the verified name/email so the clicker list can become a segment.
  function logClick(kindRaw, refId, viewer) {
    const kind = ['chat', 'comment'].includes(kindRaw) ? kindRaw : 'post';
    const ref = String(refId || '').trim().slice(0, 64);
    if (!ref) throw new HttpError(400, 'refId required');
    const t = now();
    sql.prepare(`INSERT INTO social_cta_clicks (kind, ref_id, howler_user_id, name, email, n, first_at, last_at)
      VALUES (?,?,?,?,?,1,?,?)
      ON CONFLICT(kind, ref_id, howler_user_id) DO UPDATE SET n=n+1, last_at=excluded.last_at,
        name=CASE WHEN excluded.name!='' THEN excluded.name ELSE name END,
        email=CASE WHEN excluded.email!='' THEN excluded.email ELSE email END`)
      .run(kind, ref, String(viewer?.id || ''), String(viewer?.name || ''), String(viewer?.email || ''), t, t);
  }

  // WHO tapped a CTA — the audience behind the count, for the management
  // surfaces. Ownership is enforced through the target: post → its entity;
  // comment → its post's entity; chat broadcast → its channel's entity (chat
  // tables share the DB — read-only reach, guarded for test envs).
  function clickers(entityId, kindRaw, refId) {
    const kind = ['chat', 'comment'].includes(kindRaw) ? kindRaw : 'post';
    const ref = String(refId || '').trim();
    if (!ref) throw new HttpError(400, 'refId required');
    if (kind === 'post') {
      const p = sql.prepare('SELECT entity_id FROM social_feed_posts WHERE id=?').get(ref);
      if (!p || p.entity_id !== entityId) throw new HttpError(404, 'Post not found');
    } else if (kind === 'comment') {
      const c = sql.prepare('SELECT p.entity_id e FROM social_feed_comments c JOIN social_feed_posts p ON p.id=c.post_id WHERE c.id=?').get(ref);
      if (!c || c.e !== entityId) throw new HttpError(404, 'Comment not found');
    } else {
      let m = null;
      try {
        m = sql.prepare('SELECT c.entity_id FROM social_chat_messages m JOIN social_chat_channels c ON c.id=m.channel_id WHERE m.id=?').get(ref);
      } catch { /* chat module not mounted (tests) */ }
      if (!m || m.entity_id !== entityId) throw new HttpError(404, 'Message not found');
    }
    const rows = sql.prepare('SELECT * FROM social_cta_clicks WHERE kind=? AND ref_id=? ORDER BY last_at DESC').all(kind, ref);
    const users = rows.filter((r) => r.howler_user_id !== '').map((r) => ({
      userId: r.howler_user_id,
      name: r.name || appUserName(r.howler_user_id),
      email: r.email,
      clicks: r.n,
      firstAt: r.first_at,
      lastAt: r.last_at,
    }));
    const anon = rows.find((r) => r.howler_user_id === '');
    return {
      total: rows.reduce((a, r) => a + r.n, 0),
      anonymous: anon ? anon.n : 0,
      users,
    };
  }

  return { logImpressions, postStats, logClick, clickers };
}

module.exports = { create };
