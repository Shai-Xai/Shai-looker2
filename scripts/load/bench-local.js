#!/usr/bin/env node
// Local micro-benchmark for the social feed hot path.
//
// Boots ONLY the social module on a real Express server with a stubbed
// Howler backend (same stubs the test suite uses), seeds a realistic feed
// (posts × reactions × comments), then hammers GET /api/app/social/feed
// with autocannon and prints req/s + latency percentiles. Run it on two
// commits to A/B a performance change:
//
//   node scripts/load/bench-local.js            # current working tree
//   git stash && node scripts/load/bench-local.js && git stash pop
//
// Needs autocannon (dev-only): npx -y autocannon is spawned automatically.
// For STAGING load tests (real network, mixed feed+chat), use the k6 script
// in this folder instead — this file is for fast before/after comparisons.

const { spawn } = require('child_process');

const POSTS = 60;
const REACTIONS_PER_POST = 30;
const COMMENTS_PER_POST = 10;
const PORT = 4599;
const DURATION = 8; // seconds
const CONNECTIONS = 25;

// test/helpers points DATA_DIR at a throwaway temp dir BEFORE db.js loads.
const { db, auth, makeEntity, makeAdmin } = require('../../test/helpers');
const social = require('../../server/social');
const flags = require('../../server/flags');
const rateLimit = require('../../server/ratelimit');
const express = require('express');

flags.init(db);

async function main() {
  // ── seed ──
  const admin = makeAdmin('bench@test.local');
  const entity = makeEntity('Bench Org', 'Bench Org');
  db.db.prepare("INSERT INTO feature_flags (entity_id, flag, value, updated_by, updated_at) VALUES (?, 'community', 'on', 'bench', ?)")
    .run(entity.id, new Date().toISOString());

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  const verifyAppToken = async (t) => (t === 'tok-1' ? { id: '1', name: 'Bench Fan' } : null);
  social.mount(app, { db, auth, rateLimit: () => (req, res, next) => next(), verifyAppToken, fetchAppTickets: async () => [] });

  // Seed straight through the module's own tables (no HTTP overhead).
  const nowIso = () => new Date().toISOString();
  const commIns = db.db.prepare('INSERT INTO social_feed_communities (id, entity_id, suite_id, parent_id, type, event_id, name, description, visibility, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  commIns.run('com_bench', entity.id, '', '', 'organiser', '', 'Bench Community', '', 'public', 'bench', nowIso(), nowIso());
  const postIns = db.db.prepare("INSERT INTO social_feed_posts (id, entity_id, community_id, body, media, link_url, source, global, to_parent, status, published_at, cta_label, cta_destination, cta_style, audience, author_name, author_email, moderation_status, created_at, updated_at) VALUES (?,?,?,?,'[]','','pulse',1,0,'published',?,'','','primary','','','','visible',?,?)");
  const reactIns = db.db.prepare('INSERT INTO social_feed_reactions (post_id, howler_user_id, created_at) VALUES (?,?,?)');
  const cmtIns = db.db.prepare("INSERT INTO social_feed_comments (id, post_id, entity_id, howler_user_id, author_name, author_type, body, parent_id, cta_label, cta_destination, created_at) VALUES (?,?,?,?,?,'fan',?,'','','',?)");
  for (let i = 0; i < POSTS; i++) {
    const id = `post_bench_${i}`;
    const ts = new Date(Date.now() - i * 60000).toISOString();
    postIns.run(id, entity.id, 'com_bench', `Bench post ${i} — see you at the main stage`, ts, ts, ts);
    for (let r = 0; r < REACTIONS_PER_POST; r++) reactIns.run(id, String(1000 + r), ts);
    for (let c = 0; c < COMMENTS_PER_POST; c++) cmtIns.run(`cmt_${i}_${c}`, id, entity.id, String(1000 + c), `Fan ${c}`, 'so keen 🔥', ts);
  }
  console.log(`Seeded ${POSTS} global posts × ${REACTIONS_PER_POST} reactions × ${COMMENTS_PER_POST} comments`);

  const server = await new Promise((resolve) => {
    const s = app.listen(PORT, '127.0.0.1', () => resolve(s));
  });

  const url = `http://127.0.0.1:${PORT}/api/app/social/feed?limit=30`;

  // Sanity + ETag demo before the storm.
  const first = await fetch(url, { headers: { authorization: 'Bearer tok-1' } });
  const etag = first.headers.get('etag');
  const body = await first.json();
  console.log(`GET /feed → ${first.status}, ${body.posts.length} posts, ETag ${etag || '(none)'}`);
  if (etag) {
    const again = await fetch(url, { headers: { authorization: 'Bearer tok-1', 'if-none-match': etag } });
    console.log(`GET /feed with If-None-Match → ${again.status} (expect 304)`);
  }

  console.log(`\nautocannon: ${CONNECTIONS} connections × ${DURATION}s (viewer-authenticated)`);
  // MUST be async — a synchronous spawn would block THIS process' event loop,
  // and the server under test lives in this process.
  const code = await new Promise((resolve) => {
    const p = spawn('npx', ['-y', 'autocannon', '-d', String(DURATION), '-c', String(CONNECTIONS), '-H', 'authorization=Bearer tok-1', url], { stdio: 'inherit' });
    p.on('exit', resolve);
  });
  if (code !== 0) console.error('autocannon failed — is npm registry reachable?');

  server.close();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
