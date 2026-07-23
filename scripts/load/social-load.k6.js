// k6 load test for Pulse social — REALISTIC fan mix against STAGING.
//
//   k6 run -e BASE=https://<staging-pulse-host> -e TOKEN=<howler-jwt> \
//     -e EVENT=19203 -e CHANNEL=<channel-id> scripts/load/social-load.k6.js
//
// Scale the storm with -e VUS=200 -e DURATION=2m. NEVER point this at
// production. The mix mirrors a fan session: mostly feed + chat polls
// (with If-None-Match, like the app after the ETag change), occasional
// community feed opens, rare writes (a like).
//
// Pass/fail thresholds are set below — a run FAILS loudly if p95 latency
// or error rate cross them, so this can gate releases: the "knee" is the
// VUS level where thresholds start failing. Record that number in
// docs/specs/SOCIAL_CONTRACT.md whenever it's re-measured.

import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE || 'https://howler-pulse-v2-staging.onrender.com';
const TOKEN = __ENV.TOKEN || '';
const EVENT = __ENV.EVENT || '19203';
const CHANNEL = __ENV.CHANNEL || '';

export const options = {
  vus: Number(__ENV.VUS || 50),
  duration: __ENV.DURATION || '1m',
  thresholds: {
    http_req_failed: ['rate<0.01'],       // <1% errors
    http_req_duration: ['p(95)<800'],      // p95 under 800ms
  },
};

const auth = TOKEN ? { headers: { Authorization: `Bearer ${TOKEN}` } } : {};
// Per-VU ETag memory — mirrors the app re-sending If-None-Match on polls.
const etags = {};

function get(name, url) {
  const params = { ...auth, headers: { ...(auth.headers || {}) }, tags: { name } };
  if (etags[name]) params.headers['If-None-Match'] = etags[name];
  const res = http.get(url, params);
  const tag = res.headers.Etag || res.headers.ETag;
  if (tag) etags[name] = tag;
  check(res, { [`${name} ok`]: (r) => r.status === 200 || r.status === 304 });
  return res;
}

export default function fanSession() {
  // Every loop ≈ one "glance at the phone".
  get('feed', `${BASE}/api/app/social/feed?limit=30`);
  sleep(1);
  get('rail', `${BASE}/api/app/social/rail`);
  if (CHANNEL) {
    // Chat poll — the highest-frequency call in a real session.
    for (let i = 0; i < 3; i++) {
      get('chat', `${BASE}/api/app/social/chat/channels/${CHANNEL}/messages?limit=50`);
      sleep(2);
    }
  }
  // Occasional deeper actions.
  if (Math.random() < 0.3) get('communities', `${BASE}/api/app/social/communities?eventId=${EVENT}`);
  sleep(Math.random() * 3);
}
