// Support Owl P0a (server/supportOwl.js) — the customer-support knowledge spine.
// Covers the pure transforms (HelpDocs payload → rows, HTML stripping, the
// translation-map field shape), the sync upsert (add / update / remove stale,
// manual rows untouched), and the two-tier retrieval (client tier wins, tier
// labels carried). The HTTP layer is thin admin CRUD over these — the logic
// lives here.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { db } = require('./helpers');
const { stripHtml, transformArticles, applySync, searchKnowledge, langText } = require('../server/supportOwl');

const sql = db.db;
sql.exec(`
  CREATE TABLE IF NOT EXISTS support_knowledge (
    id TEXT PRIMARY KEY, entity_id TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'article',
    title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'manual', ext_id TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0, synced_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL
  );
`);
const AT = '2026-07-17T00:00:00.000Z';
const art = (extId, title, body, over = {}) => ({ article_id: extId, title, body, status: 'published', ...over });

test('langText handles plain strings and translation maps', () => {
  assert.equal(langText('Refunds'), 'Refunds');
  assert.equal(langText({ en: 'Refunds', de: 'Erstattungen' }), 'Refunds');
  assert.equal(langText({ de: 'Erstattungen' }), 'Erstattungen', 'no en → first translation');
  assert.equal(langText(null), '');
});

test('stripHtml de-tags, decodes entities and keeps block breaks', () => {
  const out = stripHtml('<h1>Refunds</h1><p>Tickets are <b>non-refundable</b> unless&nbsp;cancelled.</p><script>evil()</script>');
  assert.ok(out.includes('Refunds\n') || out.startsWith('Refunds'), 'heading kept, break added');
  assert.ok(out.includes('non-refundable unless cancelled.'));
  assert.ok(!out.includes('<') && !out.includes('evil'), 'tags + scripts gone');
});

test('transformArticles keeps published articles only and requires id/title/body', () => {
  const rows = transformArticles({ articles: [
    art('a1', 'Refund policy', '<p>Within 7 days.</p>'),
    art('a2', 'Draft thing', '<p>WIP</p>', { status: 'draft' }),
    art('', 'No id', '<p>x</p>'),
    art('a3', '', '<p>no title</p>'),
    art('a4', { en: 'Entry rules' }, { en: '<p>Bring your ID.</p>' }, { category_id: 'c9', url: 'https://howler.helpdocs.io/entry' }),
  ] });
  assert.deepEqual(rows.map((r) => r.extId), ['a1', 'a4']);
  assert.equal(rows[0].body, 'Within 7 days.');
  assert.equal(rows[1].title, 'Entry rules');
  assert.equal(rows[1].category, 'c9');
  assert.equal(rows[1].url, 'https://howler.helpdocs.io/entry');
});

test('transformArticles tolerates a malformed payload', () => {
  assert.deepEqual(transformArticles(null), []);
  assert.deepEqual(transformArticles({ articles: 'nope' }), []);
});

test('applySync adds, updates changed, removes stale — manual rows untouched', () => {
  sql.prepare("INSERT INTO support_knowledge (id, entity_id, kind, title, body, source, updated_at) VALUES ('m1', '', 'faq', 'Manual entry', 'Stays put', 'manual', ?)").run(AT);

  let s = applySync(sql, [
    { extId: 'a1', title: 'Refunds', body: 'Within 7 days.', category: '', url: '' },
    { extId: 'a2', title: 'Entry', body: 'Bring ID.', category: '', url: '' },
  ], AT);
  assert.deepEqual({ added: s.added, updated: s.updated, removed: s.removed }, { added: 2, updated: 0, removed: 0 });

  // a1 changes body, a2 vanishes upstream, a3 is new.
  s = applySync(sql, [
    { extId: 'a1', title: 'Refunds', body: 'Within 14 days.', category: '', url: '' },
    { extId: 'a3', title: 'Cashless', body: 'Top up in the app.', category: '', url: '' },
  ], AT);
  assert.deepEqual({ added: s.added, updated: s.updated, removed: s.removed }, { added: 1, updated: 1, removed: 1 });

  const all = sql.prepare('SELECT * FROM support_knowledge ORDER BY title').all();
  assert.deepEqual(all.map((r) => r.title), ['Cashless', 'Manual entry', 'Refunds']);
  assert.equal(all.find((r) => r.title === 'Refunds').body, 'Within 14 days.');
  assert.equal(all.find((r) => r.title === 'Manual entry').source, 'manual', 'manual row survives syncs');
});

test('searchKnowledge merges both tiers and the client tier wins on conflict', () => {
  const now = AT;
  sql.prepare('DELETE FROM support_knowledge').run();
  sql.prepare("INSERT INTO support_knowledge (id, entity_id, kind, title, body, source, updated_at) VALUES ('p1', '', 'policy', 'Refund policy', 'Generic: refunds within 7 days via Howler.', 'helpdocs', ?)").run(now);
  sql.prepare("INSERT INTO support_knowledge (id, entity_id, kind, title, body, source, updated_at) VALUES ('c1', 'ent-1', 'policy', 'Refund policy', 'This event: no refunds after the lineup drop.', 'manual', ?)").run(now);
  sql.prepare("INSERT INTO support_knowledge (id, entity_id, kind, title, body, source, updated_at) VALUES ('x1', 'ent-OTHER', 'policy', 'Refund policy', 'Another client — must never surface.', 'manual', ?)").run(now);

  const out = searchKnowledge(sql, 'ent-1', 'what is the refund policy?');
  assert.equal(out.length, 2, 'both tiers surface; the other client never does');
  assert.equal(out[0].tier, 'client', 'the client tier outranks the platform tier');
  assert.equal(out[1].tier, 'platform');
  assert.ok(!out.some((r) => r.body.includes('Another client')));

  const platformOnly = searchKnowledge(sql, '', 'refund policy');
  assert.equal(platformOnly.length, 1);
  assert.equal(platformOnly[0].tier, 'platform');

  assert.deepEqual(searchKnowledge(sql, 'ent-1', ''), [], 'empty query → no grounding');
  assert.deepEqual(searchKnowledge(sql, 'ent-1', 'zebra parachute'), [], 'no match → empty (agent must say it does not know)');
});
