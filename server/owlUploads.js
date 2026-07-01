// ─── Owl uploads — external data the Owl can query alongside ticketing ─────────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns owl_uploads + /api/owl/uploads/*. Mounted
// from owlChat.js. Remove that line + this file to uninstall.
//
// Lets a user attach a TABLE that isn't in Looker — a one-off CSV/spreadsheet export,
// or a LIVE Google Sheet (its "Publish to web" CSV link, re-fetched on refresh). The
// table is parsed to typed columns + rows and stored per CLIENT (entity). The Owl's
// askUpload tool (server/owlTools.js) then filters/groups/aggregates it like askData,
// so you can ask questions of the upload AND the ticketing data in one conversation.
//
// Dependency-free: a small CSV parser handles files and the Sheet CSV export. XLSX
// (binary) would need a parser lib — not supported yet (export to CSV / publish-CSV).

const crypto = require('crypto');
const { owlAllowed } = require('./owlChat');

const ROW_CAP = 5000;
const TEXT_CAP = 6 * 1024 * 1024; // 6MB of CSV text

// RFC-4180-ish CSV: quoted fields, escaped quotes, CR/LF rows.
function parseCsv(text) {
  const s = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = []; let row = []; let field = ''; let inQ = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQ) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length && !(r.length === 1 && r[0].trim() === ''));
}
const isNum = (v) => v != null && String(v).trim() !== '' && Number.isFinite(Number(String(v).replace(/[,\s]/g, '').replace(/[R$€£%]/g, '')));
const toNum = (v) => Number(String(v).replace(/[,\s]/g, '').replace(/[R$€£%]/g, ''));

// CSV text → { columns:[{name,label,type}], rows:[{name:value}] }. Types are inferred:
// a column is 'number' when most of its non-blank values parse numerically.
function tableFromCsv(text) {
  const grid = parseCsv(text);
  if (!grid.length) return { columns: [], rows: [] };
  const headers = grid[0].map((h, i) => (String(h || '').trim() || `col_${i + 1}`));
  const body = grid.slice(1, 1 + ROW_CAP);
  const columns = headers.map((h, i) => {
    let nums = 0, seen = 0;
    for (const r of body) { const v = r[i]; if (v != null && String(v).trim() !== '') { seen++; if (isNum(v)) nums++; } }
    return { name: h, label: h, type: seen > 0 && nums / seen >= 0.8 ? 'number' : 'string' };
  });
  const rows = body.map((r) => { const o = {}; headers.forEach((h, i) => { o[h] = r[i] != null ? String(r[i]).slice(0, 500) : ''; }); return o; });
  return { columns, rows };
}

async function fetchSheetCsv(url) {
  // Accept a Google Sheets "Publish to web → CSV" link (or any CSV URL). Normalise an
  // /edit link to its CSV export form when possible.
  let u = String(url || '').trim();
  const m = u.match(/docs\.google\.com\/spreadsheets\/d\/([\w-]+)/);
  if (m && !/output=csv|\/export/.test(u)) u = `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv`;
  const res = await fetch(u, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Sheet fetch failed (${res.status})`);
  const text = await res.text();
  if (text.length > TEXT_CAP) throw new Error('Sheet is too large.');
  return text;
}

function mount(app, { db, auth }) {
  const sql = db.db;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS owl_uploads (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, user_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'file', sheet_url TEXT NOT NULL DEFAULT '',
      columns TEXT NOT NULL DEFAULT '[]', rows TEXT NOT NULL DEFAULT '[]', row_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_owl_uploads_entity ON owl_uploads(entity_id);
  `);
  const now = () => new Date().toISOString();
  const rowToMeta = (r) => ({ id: r.id, name: r.name, source: r.source, sheetUrl: r.sheet_url, columns: J(r.columns, []), rowCount: r.row_count, createdAt: r.created_at, updatedAt: r.updated_at });
  const J = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
  const ins = sql.prepare('INSERT INTO owl_uploads (id,entity_id,user_id,name,source,sheet_url,columns,rows,row_count,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  const getRow = sql.prepare('SELECT * FROM owl_uploads WHERE id = ?');
  const listRows = sql.prepare('SELECT * FROM owl_uploads WHERE entity_id = ? ORDER BY created_at DESC LIMIT 50');
  const updRows = sql.prepare('UPDATE owl_uploads SET columns=?, rows=?, row_count=?, updated_at=? WHERE id = ?');
  const del = sql.prepare('DELETE FROM owl_uploads WHERE id = ?');

  const canEntity = (user, entityId) => user && (user.role === 'admin' || (user.entityIds || []).includes(entityId));
  const gate = (req, res) => { if (!owlAllowed(req.user)) { res.status(403).json({ error: 'Not enabled.' }); return false; } return true; };

  // Helpers the askUpload tool uses (no HTTP).
  const listUploads = (entityId) => listRows.all(entityId).map(rowToMeta);
  const getUpload = (id) => { const r = getRow.get(id); return r ? { ...rowToMeta(r), rows: J(r.rows, []) } : null; };

  // POST — attach a CSV file (csv text) or a Google Sheet (sheetUrl).
  app.post('/api/owl/uploads', auth.requireAuth, async (req, res) => {
    if (!gate(req, res)) return;
    const { entityId, name, csv, sheetUrl } = req.body || {};
    if (!entityId || !canEntity(req.user, entityId)) return res.status(403).json({ error: 'Pick a client you have access to.' });
    try {
      let text = csv; let source = 'file';
      if (sheetUrl) { text = await fetchSheetCsv(sheetUrl); source = 'sheet'; }
      if (!text || !String(text).trim()) return res.status(400).json({ error: 'Nothing to import.' });
      if (String(text).length > TEXT_CAP) return res.status(400).json({ error: 'File is too large (6MB max).' });
      const { columns, rows } = tableFromCsv(text);
      if (!columns.length) return res.status(400).json({ error: 'Couldn\'t read any columns.' });
      const id = crypto.randomUUID(); const ts = now();
      ins.run(id, entityId, req.user.id, String(name || 'Upload').slice(0, 120), source, String(sheetUrl || ''), JSON.stringify(columns), JSON.stringify(rows), rows.length, ts, ts);
      res.json({ ok: true, upload: rowToMeta(getRow.get(id)) });
    } catch (e) { res.status(400).json({ error: (e && e.message) || 'Import failed.' }); }
  });

  // GET — list this client's attached sources (metadata + columns, no rows).
  app.get('/api/owl/uploads', auth.requireAuth, (req, res) => {
    if (!gate(req, res)) return;
    const entityId = String(req.query.entityId || '');
    if (!entityId || !canEntity(req.user, entityId)) return res.json({ uploads: [] });
    res.json({ uploads: listUploads(entityId) });
  });

  // POST refresh — re-fetch a live Sheet source.
  app.post('/api/owl/uploads/:id/refresh', auth.requireAuth, async (req, res) => {
    if (!gate(req, res)) return;
    const r = getRow.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'Not found.' });
    if (!canEntity(req.user, r.entity_id)) return res.status(403).json({ error: 'Not allowed.' });
    if (r.source !== 'sheet' || !r.sheet_url) return res.status(400).json({ error: 'Only Google Sheet sources refresh.' });
    try {
      const { columns, rows } = tableFromCsv(await fetchSheetCsv(r.sheet_url));
      updRows.run(JSON.stringify(columns), JSON.stringify(rows), rows.length, now(), r.id);
      res.json({ ok: true, upload: rowToMeta(getRow.get(r.id)) });
    } catch (e) { res.status(400).json({ error: (e && e.message) || 'Refresh failed.' }); }
  });

  app.delete('/api/owl/uploads/:id', auth.requireAuth, (req, res) => {
    if (!gate(req, res)) return;
    const r = getRow.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'Not found.' });
    if (!canEntity(req.user, r.entity_id)) return res.status(403).json({ error: 'Not allowed.' });
    del.run(r.id);
    res.json({ ok: true });
  });

  console.log('[owlUploads] external-data uploads module mounted');
  return { listUploads, getUpload, isNum, toNum };
}

module.exports = { mount, parseCsv, tableFromCsv };
