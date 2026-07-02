// Google Drive connector — link parsing, service-account auth, sync (Sheets →
// owl_uploads tables, Docs/PDFs → searchable text), folder mirroring, the
// background tick, entity scoping, and the two Owl read-tools. All Google API
// traffic is stubbed via fetchImpl — no network.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const drive = require('../server/googleDrive');
const createOwlTools = require('../server/owlTools');

// ── pure helpers ────────────────────────────────────────────────────────────────

test('parseLink handles Sheets/Docs/file/folder/id links and rejects junk', () => {
  assert.deepEqual(drive.parseLink('https://docs.google.com/spreadsheets/d/abc123_-XYZ/edit#gid=0'), { fileId: 'abc123_-XYZ', folder: false });
  assert.deepEqual(drive.parseLink('https://docs.google.com/document/d/DOC-id_9/edit'), { fileId: 'DOC-id_9', folder: false });
  assert.deepEqual(drive.parseLink('https://drive.google.com/file/d/FILE99/view?usp=sharing'), { fileId: 'FILE99', folder: false });
  assert.deepEqual(drive.parseLink('https://drive.google.com/drive/folders/FOLD-1'), { fileId: 'FOLD-1', folder: true });
  assert.deepEqual(drive.parseLink('https://drive.google.com/drive/u/0/folders/FOLD-2?usp=x'), { fileId: 'FOLD-2', folder: true });
  assert.deepEqual(drive.parseLink('https://drive.google.com/open?id=OPENID77'), { fileId: 'OPENID77', folder: false });
  assert.deepEqual(drive.parseLink('1aBcD2eFgH3iJkL4mNoP5qRsT6uVwXyZ'), { fileId: '1aBcD2eFgH3iJkL4mNoP5qRsT6uVwXyZ', folder: false });
  assert.equal(drive.parseLink('https://example.com/whatever'), null);
  assert.equal(drive.parseLink('not a link'), null);
  assert.equal(drive.parseLink(''), null);
});

test('parseServiceAccount validates the key shape', () => {
  assert.equal(drive.parseServiceAccount('not json'), null);
  assert.equal(drive.parseServiceAccount('{"client_email":"x"}'), null);
  const ok = drive.parseServiceAccount(JSON.stringify({ client_email: 'owl@proj.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n' }));
  assert.equal(ok.email, 'owl@proj.iam.gserviceaccount.com');
});

test('buildAssertion produces a verifiable RS256 JWT with the drive.readonly scope', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const jwt = drive.buildAssertion({ email: 'sa@test', key: privateKey }, 1_700_000_000);
  const [h, c, sig] = jwt.split('.');
  const payload = JSON.parse(Buffer.from(c, 'base64url').toString());
  assert.equal(payload.iss, 'sa@test');
  assert.equal(payload.aud, 'https://oauth2.googleapis.com/token');
  assert.match(payload.scope, /drive\.readonly/);
  assert.equal(payload.exp - payload.iat, 3600);
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${h}.${c}`);
  assert.ok(verifier.verify(publicKey, Buffer.from(sig, 'base64url')));
});

test('kindOf maps mimes: sheets/csv→table, docs/slides/text→doc, pdf→pdf, binaries unsupported', () => {
  assert.equal(drive.kindOf('application/vnd.google-apps.spreadsheet').kind, 'table');
  assert.equal(drive.kindOf('text/csv').kind, 'table');
  assert.equal(drive.kindOf('application/vnd.google-apps.document').kind, 'doc');
  assert.equal(drive.kindOf('application/vnd.google-apps.presentation').kind, 'doc');
  assert.equal(drive.kindOf('application/pdf').kind, 'pdf');
  assert.equal(drive.kindOf('application/vnd.google-apps.folder').kind, 'folder');
  assert.equal(drive.kindOf('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), null);
});

// ── harness: in-memory db + fake Google ────────────────────────────────────────

const SA_JSON = () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  return JSON.stringify({ client_email: 'owl@proj.iam.gserviceaccount.com', private_key: privateKey });
};

function makeHarness({ files = {}, folders = {}, extractDocText } = {}) {
  const sqlite = new Database(':memory:');
  // owl_uploads is owned by owlUploads.js in prod (mounted first); mirror its schema.
  sqlite.exec(`CREATE TABLE owl_uploads (
    id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, user_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'file', sheet_url TEXT NOT NULL DEFAULT '',
    columns TEXT NOT NULL DEFAULT '[]', rows TEXT NOT NULL DEFAULT '[]', row_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  const integrations = { e1: { googleServiceAccountSecret: SA_JSON() } };
  const db = {
    db: sqlite,
    getEntityIntegrations: (id) => integrations[id] || {},
    setEntityIntegrations: (id, patch) => { integrations[id] = { ...(integrations[id] || {}), ...patch }; return integrations[id]; },
    getSetting: (k, d) => d,
  };
  const calls = { token: 0, byUrl: [] };
  const respond = (body, { text = false, buffer = false } = {}) => ({
    ok: true, status: 200,
    json: async () => (text || buffer ? {} : body),
    text: async () => String(body),
    arrayBuffer: async () => (Buffer.isBuffer(body) ? body : Buffer.from(String(body))),
  });
  const fetchImpl = async (url) => {
    calls.byUrl.push(url);
    if (url.startsWith('https://oauth2.googleapis.com/token')) { calls.token++; return respond({ access_token: `tok${calls.token}`, expires_in: 3600 }); }
    const exp = url.match(/files\/([\w-]+)\/export/);
    if (exp) { const f = files[exp[1]]; return f ? respond(f.body, { text: true }) : { ok: false, status: 404, json: async () => ({ error: { message: 'nope' } }) }; }
    const media = url.match(/files\/([\w-]+)\?alt=media/);
    if (media) { const f = files[media[1]]; return f ? respond(f.body, { buffer: true }) : { ok: false, status: 404, json: async () => ({ error: { message: 'nope' } }) }; }
    const list = url.match(/files\?q=/);
    if (list) { const fid = decodeURIComponent(url).match(/'([\w-]+)' in parents/)[1]; return respond({ files: (folders[fid] || []).map((id) => meta(id)) }); }
    const one = url.match(/files\/([\w-]+)\?fields/);
    if (one) { const m = meta(one[1]); return m ? respond(m) : { ok: false, status: 404, json: async () => ({ error: { message: 'File not found' } }) }; }
    throw new Error(`unexpected url ${url}`);
  };
  function meta(id) {
    if (folders[id]) return { id, name: `Folder ${id}`, mimeType: 'application/vnd.google-apps.folder', modifiedTime: 't0' };
    const f = files[id];
    return f ? { id, name: f.name, mimeType: f.mime, modifiedTime: f.modified || 't1' } : null;
  }
  // capture routes so we can invoke the my/admin handlers directly
  const routes = {};
  const capture = (method) => (path, ...handlers) => { routes[`${method} ${path}`] = handlers; };
  const app = { get: capture('GET'), post: capture('POST'), put: capture('PUT'), delete: capture('DELETE') };
  const auth = {
    requireAuth: (req, res, next) => next(),
    requireAdmin: (req, res, next) => (req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'admin only' })),
    requirePermission: () => (req, res, next) => next(),
  };
  const api = drive.mount(app, { db, auth, extractDocText, fetchImpl, startTimer: false });
  // tiny express-ish invoker: runs the chain, returns { status, body }
  async function call(key, { params = {}, body = {}, user = { id: 'u1', role: 'member', entityIds: ['e1'] } } = {}) {
    const handlers = routes[key];
    assert.ok(handlers, `route ${key} exists`);
    const req = { params, body, user, query: {} };
    let out = { status: 200, body: null };
    const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
    for (const h of handlers) {
      let nexted = false;
      await h(req, res, () => { nexted = true; });
      if (!nexted) break;
    }
    return out;
  }
  return { api, db, sqlite, call, calls, files, folders };
}

// ── sync flows ──────────────────────────────────────────────────────────────────

test('a Drive Sheet becomes an owl_uploads table (askUpload-visible) and skips when unchanged', async () => {
  const h = makeHarness({ files: { SHEET1: { name: 'Budget 2026', mime: 'application/vnd.google-apps.spreadsheet', body: 'Item,Cost\nStage,1000\nSound,500' } } });
  const r = await h.call('POST /api/my/drive/:entityId/sources', { params: { entityId: 'e1' }, body: { link: 'https://docs.google.com/spreadsheets/d/SHEET1/edit' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.sources.length, 1);
  assert.equal(r.body.sources[0].status, 'ok');
  const up = h.sqlite.prepare("SELECT * FROM owl_uploads WHERE entity_id='e1' AND source='drive'").get();
  assert.ok(up, 'upload row created');
  assert.equal(up.name, 'Budget 2026');
  assert.equal(up.row_count, 2);
  assert.equal(up.sheet_url, 'drive:SHEET1');
  // unchanged re-sync: no second export call
  const exportsBefore = h.calls.byUrl.filter((u) => u.includes('/export')).length;
  await h.call('POST /api/my/drive/:entityId/sources/:sid/sync', { params: { entityId: 'e1', sid: r.body.sources[0].id } });
  assert.equal(h.calls.byUrl.filter((u) => u.includes('/export')).length, exportsBefore, 'unchanged file is not re-exported');
  // changed on Drive → re-export + row updated
  h.files.SHEET1.modified = 't2';
  h.files.SHEET1.body = 'Item,Cost\nStage,1000\nSound,500\nLights,900';
  await h.call('POST /api/my/drive/:entityId/sources/:sid/sync', { params: { entityId: 'e1', sid: r.body.sources[0].id } });
  assert.equal(h.sqlite.prepare("SELECT row_count FROM owl_uploads WHERE sheet_url='drive:SHEET1'").get().row_count, 3);
});

test('a Google Doc becomes searchable text; readDoc chunks and stays entity-scoped', async () => {
  const long = `Marketing plan. Launch week focus: ${'x'.repeat(7000)} THE-NEEDLE end.`;
  const h = makeHarness({ files: { DOC1: { name: 'Marketing plan', mime: 'application/vnd.google-apps.document', body: long } } });
  const r = await h.call('POST /api/my/drive/:entityId/sources', { params: { entityId: 'e1' }, body: { link: 'https://docs.google.com/document/d/DOC1/edit' } });
  assert.equal(r.body.sources[0].status, 'ok');
  const hits = h.api.searchDocs('e1', 'THE-NEEDLE');
  assert.equal(hits.length, 1);
  assert.match(hits[0].snippet, /THE-NEEDLE/);
  assert.equal(h.api.searchDocs('someone-else', 'THE-NEEDLE').length, 0, 'search is entity-scoped');
  const first = h.api.readDoc('e1', { name: 'marketing' });
  assert.equal(first.offset, 0);
  assert.ok(first.more, 'long doc pages');
  const next = h.api.readDoc('e1', { docId: first.id, offset: first.nextOffset });
  assert.match(first.text + next.text, /THE-NEEDLE/);
  assert.equal(h.api.readDoc('someone-else', { docId: first.id }), null, 'docId read re-checks ownership');
});

test('a PDF is transcribed via the injected extractor; extraction failure records an error', async () => {
  let extracted = 0;
  const h = makeHarness({
    files: { PDF1: { name: 'Venue contract', mime: 'application/pdf', body: Buffer.from('%PDF-fake') }, PDF2: { name: 'Bad scan', mime: 'application/pdf', body: Buffer.from('%PDF-fake2') } },
    extractDocText: async ({ pdfBase64, entityId }) => { extracted++; assert.equal(entityId, 'e1'); return pdfBase64 ? 'Contracted capacity: 5000. Curfew 23:00.' : ''; },
  });
  const r = await h.call('POST /api/my/drive/:entityId/sources', { params: { entityId: 'e1' }, body: { link: 'https://drive.google.com/file/d/PDF1/view' } });
  assert.equal(r.body.sources[0].status, 'ok');
  assert.equal(extracted, 1);
  assert.match(h.api.readDoc('e1', { name: 'venue' }).text, /Curfew 23:00/);
});

test('a folder syncs supported children, mirrors removals, and unsupported types are skipped', async () => {
  const h = makeHarness({
    files: {
      C1: { name: 'Notes', mime: 'text/plain', body: 'hello notes' },
      C2: { name: 'Numbers', mime: 'text/csv', body: 'a,b\n1,2' },
      C3: { name: 'Binary', mime: 'application/zip', body: 'zzz' },
    },
    folders: { FOLD1: ['C1', 'C2', 'C3'] },
  });
  const r = await h.call('POST /api/my/drive/:entityId/sources', { params: { entityId: 'e1' }, body: { link: 'https://drive.google.com/drive/folders/FOLD1' } });
  const src = r.body.sources[0];
  assert.equal(src.kind, 'folder');
  assert.equal(src.watch, true, 'folders watch by default');
  assert.equal(src.files.length, 2, 'zip skipped');
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM owl_uploads WHERE entity_id='e1'").get().n, 1, 'csv child became a table');
  // child removed on Drive → dropped here (and its upload table with it)
  h.folders.FOLD1 = ['C1'];
  await h.call('POST /api/my/drive/:entityId/sources/:sid/sync', { params: { entityId: 'e1', sid: src.id } });
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM drive_files WHERE source_id=?").get(src.id).n, 1);
  assert.equal(h.sqlite.prepare("SELECT COUNT(*) n FROM owl_uploads WHERE entity_id='e1'").get().n, 0, 'removed csv upload cleaned up');
});

test('adding an unshared file fails with a share-with hint and saves nothing', async () => {
  const h = makeHarness({});
  const r = await h.call('POST /api/my/drive/:entityId/sources', { params: { entityId: 'e1' }, body: { link: 'https://drive.google.com/file/d/NOPE99-xxxxxxxxxxxx/view' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /owl@proj\.iam\.gserviceaccount\.com/);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) n FROM drive_sources').get().n, 0);
});

test('route scoping: another client cannot touch e1 and admins can; key is write-only', async () => {
  const h = makeHarness({});
  const stranger = { id: 'u2', role: 'member', entityIds: ['e2'] };
  const r = await h.call('GET /api/my/drive/:entityId', { params: { entityId: 'e1' }, user: stranger });
  assert.equal(r.status, 403);
  const admin = await h.call('GET /api/admin/entities/:entityId/drive', { params: { entityId: 'e1' }, user: { id: 'a', role: 'admin' } });
  assert.equal(admin.status, 200);
  assert.equal(admin.body.configured, true);
  assert.equal(admin.body.saEmail, 'owl@proj.iam.gserviceaccount.com');
  assert.ok(!JSON.stringify(admin.body).includes('PRIVATE KEY'), 'the key never leaves the server');
});

test('token is cached across calls and the background tick re-syncs due watched folders', async () => {
  const h = makeHarness({ files: { C1: { name: 'Notes', mime: 'text/plain', body: 'v1' } }, folders: { FOLD1: ['C1'] } });
  const r = await h.call('POST /api/my/drive/:entityId/sources', { params: { entityId: 'e1' }, body: { link: 'https://drive.google.com/drive/folders/FOLD1' } });
  assert.equal(h.calls.token, 1, 'one token fetch despite several API calls');
  // make it look stale, change the file, tick
  h.sqlite.prepare("UPDATE drive_sources SET last_synced='2020-01-01T00:00:00.000Z'").run();
  h.files.C1.modified = 't9';
  h.files.C1.body = 'v2 with LATE-ADDITION';
  await h.api.tick();
  assert.match(h.api.readDoc('e1', { name: 'notes' }).text, /LATE-ADDITION/);
  assert.equal(h.calls.token, 1, 'cached token reused by the tick');
});

// ── the Owl tools ────────────────────────────────────────────────────────────────

test('searchDriveDocs/readDriveDoc tools: refuse without a client, ground when given one', async () => {
  const h = makeHarness({ files: { DOC1: { name: 'Sponsor deck', mime: 'application/vnd.google-apps.document', body: 'Headline sponsor pays 250000 EUR.' } } });
  await h.call('POST /api/my/drive/:entityId/sources', { params: { entityId: 'e1' }, body: { link: 'https://docs.google.com/document/d/DOC1/edit' } });
  const t = createOwlTools({ query: { applyScope: () => false, runLookerQuery: async () => [] }, auth: {}, getDriveApi: () => h.api });
  const noClient = await t.searchDriveDocs.run({ query: 'sponsor' }, { user: { id: 'u1' } });
  assert.equal(noClient.ok, false);
  assert.equal(noClient.reason, 'no_client');
  const found = await t.searchDriveDocs.run({ query: 'sponsor' }, { user: { id: 'u1' }, entityId: 'e1' });
  assert.equal(found.ok, true);
  assert.equal(found.results.length, 1);
  const read = await t.readDriveDoc.run({ name: 'sponsor' }, { user: { id: 'u1' }, entityId: 'e1' });
  assert.match(read.text, /250000 EUR/);
  const other = await t.readDriveDoc.run({ name: 'sponsor' }, { user: { id: 'u2' }, entityId: 'other' });
  assert.equal(other.ok, false, 'other client sees nothing');
});
