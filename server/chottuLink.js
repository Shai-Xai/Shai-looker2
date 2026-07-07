// ─── ChottuLink deep links — create & track howler.chottu.link short links ─────
// SELF-CONTAINED, DISPOSABLE MODULE. Owns the `chottu_links` table and the
// dual-surface link-management routes (admin per client + client self-service in
// Engage → Links). See docs/CHOTTULINK_INTEGRATION_SCOPE.md.
//
// Pulse fronts the ChottuLink REST API (https://docs.chottulink.com/rest-api/postman)
// so links are created programmatically instead of one-by-one in their dashboard,
// tied to a Pulse event (suite) and reported with their click counts. Credentials
// layer platform → client: Howler's account (settings: chottu_api_key/chottu_domain)
// is the default; a client with its own ChottuLink org sets chottuApiKey/chottuDomain
// in entities.integrations (auto-sealed by secretbox — field names end in ApiKey).
// The upstream API has no delete — "remove" here is disable + archive locally.
//
// Mount: `require('./chottuLink').mount(app, { db, auth, rateLimit })`.

const crypto = require('crypto');
const { HttpError, asyncHandler } = require('./http');

const API_BASE = 'https://api2.chottulink.com/chotuCore/pa/v1';
const IMPORT_PAGE_SIZE = 100;
const IMPORT_MAX_PAGES = 20;      // 2 000 links — far above any real account, bounds a runaway
const STATS_REFRESH_CAP = 150;    // per refresh call — sequential upstream calls, keep requests snappy

function mount(app, { db, auth, rateLimit }) {
  const sql = db.db;
  const now = () => new Date().toISOString();

  sql.exec(`
    CREATE TABLE IF NOT EXISTS chottu_links (
      id              TEXT PRIMARY KEY,
      entity_id       TEXT NOT NULL,
      suite_id        TEXT NOT NULL DEFAULT '',   -- Pulse event; '' = not linked to an event
      chottu_link_id  TEXT NOT NULL UNIQUE,       -- ChottuLink's UUID (import upsert key)
      short_url       TEXT NOT NULL,
      link_name       TEXT NOT NULL,
      destination_url TEXT NOT NULL,
      ios_behavior    INTEGER NOT NULL DEFAULT 2, -- 1 browser · 2 app (ChottuLink's enum)
      android_behavior INTEGER NOT NULL DEFAULT 2,
      utm             TEXT NOT NULL DEFAULT '{}',
      social          TEXT NOT NULL DEFAULT '{}',
      is_enabled      INTEGER NOT NULL DEFAULT 1,
      source          TEXT NOT NULL DEFAULT 'pulse',  -- pulse | imported
      created_by      TEXT NOT NULL DEFAULT '',
      total_clicks    INTEGER NOT NULL DEFAULT 0,     -- last-fetched upstream counters
      clicks_7d       INTEGER NOT NULL DEFAULT 0,     -- (history/snapshots are Phase 3)
      clicks_30d      INTEGER NOT NULL DEFAULT 0,
      stats_at        TEXT NOT NULL DEFAULT '',
      archived        INTEGER NOT NULL DEFAULT 0, -- deleted in Pulse; tombstone so imports don't resurrect it
      created_time    TEXT NOT NULL,
      modified_time   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chottu_links_entity ON chottu_links(entity_id, suite_id);
    CREATE TABLE IF NOT EXISTS chottu_templates (
      id            TEXT PRIMARY KEY,
      entity_id     TEXT NOT NULL DEFAULT '',   -- '' = platform template, usable by every client
      name          TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      items         TEXT NOT NULL DEFAULT '[]', -- [{key,name,destination,path,utm,social,iosBehavior,androidBehavior}]
      created_time  TEXT NOT NULL,
      modified_time TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chottu_templates_entity ON chottu_templates(entity_id);
  `);
  // Additive migration for databases created before the delete feature shipped.
  if (!sql.prepare('PRAGMA table_info(chottu_links)').all().some((c) => c.name === 'archived')) {
    sql.exec('ALTER TABLE chottu_links ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
  }

  // ── credentials: client override → platform default ──
  function configFor(entityId) {
    const i = entityId ? db.getEntityIntegrations(entityId) : {};
    if ((i.chottuApiKey || '').trim()) {
      return { key: i.chottuApiKey.trim(), domain: (i.chottuDomain || '').trim(), source: 'client' };
    }
    const key = (db.getSetting('chottu_api_key') || '').trim();
    return { key, domain: (db.getSetting('chottu_domain') || '').trim(), source: key ? 'platform' : null };
  }

  // ── upstream client ──
  // 4xx from ChottuLink carries a useful validation message (e.g. "Path 'x' is
  // already in use") — surface it. 5xx/network stays generic (errorMiddleware).
  async function chottu(cfg, method, path, body) {
    if (!cfg.key) throw new HttpError(400, 'ChottuLink is not connected yet — add the API key first.');
    let res;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: { 'API-KEY': cfg.key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      throw new HttpError(502, 'ChottuLink did not respond — try again in a moment.');
    }
    let data = {};
    try { data = await res.json(); } catch { /* some errors have no body */ }
    if (!res.ok) {
      if (res.status === 401) throw new HttpError(400, 'ChottuLink rejected the API key — check it under Settings → Integrations.');
      const detail = data?.error?.errorMessage || data?.errorMessage || '';
      if (res.status < 500) throw new HttpError(400, detail ? `ChottuLink: ${detail}` : 'ChottuLink rejected the request.');
      throw new Error(`ChottuLink ${res.status} on ${method} ${path}`);
    }
    return data;
  }

  const rowToLink = (r) => ({
    id: r.id, entityId: r.entity_id, suiteId: r.suite_id || null,
    chottuLinkId: r.chottu_link_id, shortUrl: r.short_url, linkName: r.link_name,
    destinationUrl: r.destination_url, iosBehavior: r.ios_behavior, androidBehavior: r.android_behavior,
    utm: JSON.parse(r.utm || '{}'), social: JSON.parse(r.social || '{}'),
    enabled: !!r.is_enabled, source: r.source,
    clicks: { total: r.total_clicks, last7: r.clicks_7d, last30: r.clicks_30d, at: r.stats_at || null },
    createdTime: r.created_time, modifiedTime: r.modified_time,
  });
  const getRow = (entityId, id) => {
    const r = sql.prepare('SELECT * FROM chottu_links WHERE id=?').get(id);
    if (!r || r.entity_id !== entityId || r.archived) throw new HttpError(404, 'Link not found');
    return r;
  };
  function checkSuite(entityId, suiteId) {
    if (!suiteId) return '';
    const su = db.getSuite(suiteId);
    if (!su || su.entityId !== entityId) throw new HttpError(400, 'That event doesn’t belong to this client.');
    return suiteId;
  }
  const cleanUtm = (u) => {
    const out = {};
    for (const k of ['source', 'medium', 'campaign', 'term', 'content']) {
      const v = String((u || {})[k] || '').trim();
      if (v) out[k] = v.slice(0, 120);
    }
    return out;
  };
  const cleanSocial = (s) => {
    const out = {};
    for (const k of ['title', 'description', 'imageUrl']) {
      const v = String((s || {})[k] || '').trim();
      if (v) out[k] = v.slice(0, 500);
    }
    return out;
  };
  const behavior = (v, dflt = 2) => (v === 1 || v === '1' || v === 'browser' ? 1 : v === undefined ? dflt : 2);
  // ChottuLink's create/update take flat utm_*/social_* fields.
  const upstreamFields = (utm, social) => ({
    ...Object.fromEntries(Object.entries(utm).map(([k, v]) => [`utm_${k}`, v])),
    ...(social.title ? { social_title: social.title } : {}),
    ...(social.description ? { social_description: social.description } : {}),
    ...(social.imageUrl ? { social_image_url: social.imageUrl } : {}),
  });

  // ── service functions (shared by both surfaces) ──
  const listLinks = (entityId) =>
    sql.prepare('SELECT * FROM chottu_links WHERE entity_id=? AND archived=0 ORDER BY created_time DESC').all(entityId).map(rowToLink);

  async function createLink(entityId, body, userEmail) {
    const cfg = configFor(entityId);
    if (!cfg.domain) throw new HttpError(400, 'ChottuLink is not connected yet — add the domain first.');
    const linkName = String(body.linkName || '').trim().slice(0, 120);
    const destinationUrl = String(body.destinationUrl || '').trim();
    if (!linkName) throw new HttpError(400, 'Give the link a name.');
    if (!/^https?:\/\/\S+$/i.test(destinationUrl)) throw new HttpError(400, 'The destination must be a full URL (https://…).');
    const suiteId = checkSuite(entityId, body.suiteId);
    const path = String(body.path || '').trim().replace(/^\//, '').slice(0, 80);
    if (path && !/^[\w-]+$/.test(path)) throw new HttpError(400, 'The short-URL path can only use letters, numbers and dashes.');
    const utm = cleanUtm(body.utm); const social = cleanSocial(body.social);
    const ios = behavior(body.iosBehavior); const android = behavior(body.androidBehavior);

    const created = await chottu(cfg, 'POST', '/create-link', {
      domain: cfg.domain, destination_url: destinationUrl, link_name: linkName,
      ios_behavior: ios, android_behavior: android,
      ...(path ? { selected_path: path } : {}),
      ...upstreamFields(utm, social),
    });
    const shortUrl = created.short_url;
    if (!shortUrl) throw new Error('ChottuLink created the link but returned no short_url');
    // Create doesn't return the link id — one info lookup pins it for later updates.
    const info = await chottu(cfg, 'POST', '/links/info', { shortUrl });
    const id = crypto.randomUUID();
    sql.prepare(`INSERT INTO chottu_links
        (id, entity_id, suite_id, chottu_link_id, short_url, link_name, destination_url,
         ios_behavior, android_behavior, utm, social, is_enabled, source, created_by, created_time, modified_time)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,1,'pulse',?,?,?)`)
      .run(id, entityId, suiteId, info.id || `unknown:${id}`, shortUrl, linkName, destinationUrl,
        ios, android, JSON.stringify(utm), JSON.stringify(social), String(userEmail || ''), now(), now());
    return rowToLink(sql.prepare('SELECT * FROM chottu_links WHERE id=?').get(id));
  }

  async function updateLink(entityId, id, body) {
    const r = getRow(entityId, id);
    const patch = {}; const local = {};
    if (body.linkName !== undefined) { local.link_name = String(body.linkName).trim().slice(0, 120) || r.link_name; patch.link_name = local.link_name; }
    if (body.destinationUrl !== undefined) {
      const d = String(body.destinationUrl).trim();
      if (!/^https?:\/\/\S+$/i.test(d)) throw new HttpError(400, 'The destination must be a full URL (https://…).');
      local.destination_url = d; patch.destination_url = d;
    }
    if (body.iosBehavior !== undefined) { local.ios_behavior = behavior(body.iosBehavior); patch.ios_behavior = local.ios_behavior; }
    if (body.androidBehavior !== undefined) { local.android_behavior = behavior(body.androidBehavior); patch.android_behavior = local.android_behavior; }
    if (body.utm !== undefined) { const u = cleanUtm(body.utm); local.utm = JSON.stringify(u); Object.assign(patch, upstreamFields(u, {})); }
    if (body.social !== undefined) { const s = cleanSocial(body.social); local.social = JSON.stringify(s); Object.assign(patch, upstreamFields({}, s)); }
    if (Object.keys(patch).length) await chottu(configFor(entityId), 'PATCH', `/update-link/${r.chottu_link_id}`, patch);
    if (body.suiteId !== undefined) local.suite_id = checkSuite(entityId, body.suiteId); // Pulse-only field — no upstream call
    if (Object.keys(local).length) {
      local.modified_time = now();
      sql.prepare(`UPDATE chottu_links SET ${Object.keys(local).map((k) => `${k}=?`).join(', ')} WHERE id=?`)
        .run(...Object.values(local), id);
    }
    return rowToLink(sql.prepare('SELECT * FROM chottu_links WHERE id=?').get(id));
  }

  async function setEnabled(entityId, id, enabled) {
    const r = getRow(entityId, id);
    await chottu(configFor(entityId), 'PATCH', `/links/change-status/${r.chottu_link_id}`, { is_enabled: !!enabled });
    sql.prepare('UPDATE chottu_links SET is_enabled=?, modified_time=? WHERE id=?').run(enabled ? 1 : 0, now(), id);
    return rowToLink(sql.prepare('SELECT * FROM chottu_links WHERE id=?').get(id));
  }

  // "Delete" — ChottuLink's API has no delete, so the link is switched off
  // upstream (best-effort: a dead connection must not block cleanup in Pulse)
  // and archived locally. The archived row is a tombstone: it hides from every
  // list and a later import will NOT resurrect it (unless explicitly re-picked).
  async function deleteLink(entityId, id) {
    const r = getRow(entityId, id);
    try { await chottu(configFor(entityId), 'PATCH', `/links/change-status/${r.chottu_link_id}`, { is_enabled: false }); }
    catch { /* upstream off is courtesy; the Pulse delete still stands */ }
    sql.prepare('UPDATE chottu_links SET archived=1, is_enabled=0, modified_time=? WHERE id=?').run(now(), id);
    return { ok: true };
  }

  async function fetchAllUpstream(cfg) {
    const all = [];
    for (let page = 1; page <= IMPORT_MAX_PAGES; page++) {
      const data = await chottu(cfg, 'GET', `/links/page?page=${page}&size=${IMPORT_PAGE_SIZE}`);
      const links = data.links || [];
      all.push(...links.filter((l) => l.id && l.short_url));
      if (page >= (data.pagination?.total_pages || 1) || !links.length) break;
    }
    return all;
  }

  // Everything on the ChottuLink account, flagged against what Pulse has —
  // powers the import picker: 'new' (not in Pulse), 'imported', 'removed'
  // (deleted in Pulse earlier; picking it again resurrects it).
  async function importPreview(entityId) {
    const upstream = await fetchAllUpstream(configFor(entityId));
    const known = new Map(sql.prepare('SELECT chottu_link_id, archived FROM chottu_links WHERE entity_id=?').all(entityId).map((r) => [r.chottu_link_id, r]));
    return {
      links: upstream.map((l) => ({
        chottuLinkId: l.id, shortUrl: l.short_url, linkName: l.link_name || '',
        destinationUrl: l.destination_url || '', enabled: !!l.is_enabled, createdTime: l.createdTime || '',
        status: !known.has(l.id) ? 'new' : known.get(l.id).archived ? 'removed' : 'imported',
      })),
    };
  }

  // Pull links from the ChottuLink account into Pulse. `ids` narrows to the
  // picked links (omit = everything); `suiteId` attaches new imports to an
  // event in the same step. Upsert by ChottuLink id: new rows arrive as
  // source='imported'; existing rows refresh upstream truth (name/destination/
  // status) but KEEP their Pulse fields (event, utm…). Archived rows stay
  // deleted unless explicitly picked, which resurrects them.
  async function importLinks(entityId, { ids, suiteId } = {}) {
    const cfg = configFor(entityId);
    const wanted = Array.isArray(ids) && ids.length ? new Set(ids.map(String)) : null;
    const assignSuite = checkSuite(entityId, suiteId);
    let imported = 0; let refreshed = 0; let restored = 0;
    for (const l of await fetchAllUpstream(cfg)) {
      if (wanted && !wanted.has(String(l.id))) continue;
      const existing = sql.prepare('SELECT id, archived FROM chottu_links WHERE chottu_link_id=?').get(l.id);
      if (existing) {
        if (existing.archived && !wanted) continue; // tombstone: bulk import never resurrects
        sql.prepare('UPDATE chottu_links SET link_name=?, destination_url=?, short_url=?, is_enabled=?, archived=0, modified_time=? WHERE chottu_link_id=?')
          .run(l.link_name || '', l.destination_url || '', l.short_url, l.is_enabled ? 1 : 0, now(), l.id);
        if (existing.archived) restored++; else refreshed++;
      } else {
        sql.prepare(`INSERT INTO chottu_links
            (id, entity_id, suite_id, chottu_link_id, short_url, link_name, destination_url, is_enabled, source, created_time, modified_time)
            VALUES (?,?,?,?,?,?,?,?, 'imported', ?, ?)`)
          .run(crypto.randomUUID(), entityId, assignSuite, l.id, l.short_url, l.link_name || '', l.destination_url || '',
            l.is_enabled ? 1 : 0, l.createdTime || now(), now());
        imported++;
      }
    }
    return { imported, refreshed, restored };
  }

  // Refresh click counters from ChottuLink — sequential (their rate limits are
  // unpublished), optionally narrowed to one event or one link.
  async function refreshStats(entityId, { suiteId, linkId } = {}) {
    const cfg = configFor(entityId);
    let rows = linkId ? [getRow(entityId, linkId)]
      : sql.prepare(`SELECT * FROM chottu_links WHERE entity_id=? ${suiteId ? 'AND suite_id=?' : ''} ORDER BY modified_time DESC`)
        .all(...(suiteId ? [entityId, suiteId] : [entityId]));
    rows = rows.slice(0, STATS_REFRESH_CAP);
    let updated = 0; let failed = 0;
    for (const r of rows) {
      try {
        const a = await chottu(cfg, 'POST', '/analytics', { linkId: r.chottu_link_id });
        sql.prepare('UPDATE chottu_links SET total_clicks=?, clicks_7d=?, clicks_30d=?, stats_at=? WHERE id=?')
          .run(a.total_clicks || 0, a.clicks_last_7_days || 0, a.clicks_last_30_days || 0, now(), r.id);
        updated++;
      } catch { failed++; } // one bad link must not sink the sweep
    }
    return { updated, failed };
  }

  // ── templates: one click creates every link an event needs ──
  // An item's strings may carry placeholders, resolved at preview/apply time:
  //   {{event.name}} {{event.slug}} {{event.id}} {{client.name}}
  //   {{base}} — the event's page URL, typed once when applying
  // Anything unresolved is a warning in the preview, never a silent blank.
  const MAX_TEMPLATE_ITEMS = 20;
  const slugify = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'event';

  function fill(str, ctx) {
    const missing = new Set();
    const out = String(str || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, token) => {
      const v = ctx[token];
      if (v === undefined || v === '') { missing.add(token); return ''; }
      return v;
    });
    return { out: out.trim(), missing: [...missing] };
  }

  const cleanItem = (raw) => ({
    key: String(raw.key || '').trim().slice(0, 60) || crypto.randomUUID().slice(0, 8),
    name: String(raw.name || '').trim().slice(0, 160),
    destination: String(raw.destination || '').trim().slice(0, 600),
    path: String(raw.path || '').trim().replace(/^\//, '').slice(0, 120),
    utm: cleanUtm(raw.utm), social: cleanSocial(raw.social),
    iosBehavior: behavior(raw.iosBehavior), androidBehavior: behavior(raw.androidBehavior),
  });
  const rowToTemplate = (r) => ({
    id: r.id, entityId: r.entity_id || null, platform: !r.entity_id,
    name: r.name, description: r.description, items: JSON.parse(r.items || '[]'),
    createdTime: r.created_time, modifiedTime: r.modified_time,
  });
  // A client sees platform templates + their own; edits only their own.
  const listTemplates = (entityId) =>
    sql.prepare("SELECT * FROM chottu_templates WHERE entity_id='' OR entity_id=? ORDER BY entity_id='' DESC, name").all(entityId).map(rowToTemplate);
  function getTemplate(entityId, id, { forEdit = false } = {}) {
    const r = sql.prepare('SELECT * FROM chottu_templates WHERE id=?').get(id);
    if (!r || (r.entity_id && r.entity_id !== entityId)) throw new HttpError(404, 'Template not found');
    if (forEdit && !r.entity_id) throw new HttpError(403, 'This is a platform template — Howler manages it.');
    return r;
  }
  function saveTemplate(entityId, id, body, { platform = false } = {}) {
    const name = String(body.name || '').trim().slice(0, 120);
    if (!name) throw new HttpError(400, 'Give the template a name.');
    const items = (Array.isArray(body.items) ? body.items : []).slice(0, MAX_TEMPLATE_ITEMS).map(cleanItem);
    if (!items.length) throw new HttpError(400, 'Add at least one link to the template.');
    const description = String(body.description || '').trim().slice(0, 400);
    if (id) {
      getTemplate(entityId, id, { forEdit: !platform });
      sql.prepare('UPDATE chottu_templates SET name=?, description=?, items=?, modified_time=? WHERE id=?')
        .run(name, description, JSON.stringify(items), now(), id);
    } else {
      id = crypto.randomUUID();
      sql.prepare('INSERT INTO chottu_templates (id, entity_id, name, description, items, created_time, modified_time) VALUES (?,?,?,?,?,?,?)')
        .run(id, platform ? '' : entityId, name, description, JSON.stringify(items), now(), now());
    }
    return rowToTemplate(sql.prepare('SELECT * FROM chottu_templates WHERE id=?').get(id));
  }

  // Resolve a template against one event → the exact links it would create,
  // each with its warnings. Shared by preview (dry run) and apply.
  function resolveTemplate(entityId, templateId, { suiteId, base }) {
    const t = rowToTemplate(getTemplate(entityId, templateId));
    if (!suiteId) throw new HttpError(400, 'Pick the event to create links for.');
    checkSuite(entityId, suiteId);
    const su = db.getSuite(suiteId);
    const baseUrl = String(base || '').trim().replace(/\/$/, '');
    const ctx = {
      base: baseUrl,
      'event.name': su.name, 'event.slug': slugify(su.name), 'event.id': su.id,
      'client.name': db.getEntity(entityId)?.name || '',
    };
    const fillClean = (v) => fill(v, ctx);
    const items = t.items.map((item) => {
      const warnings = []; const missing = new Set();
      const take = (v) => { const f = fillClean(v); f.missing.forEach((m) => missing.add(m)); return f.out; };
      const name = take(item.name) || item.key;
      const destination = take(item.destination);
      const path = take(item.path).replace(/^\//, '');
      const utm = Object.fromEntries(Object.entries(item.utm || {}).map(([k, v]) => [k, take(v)]).filter(([, v]) => v));
      const social = Object.fromEntries(Object.entries(item.social || {}).map(([k, v]) => [k, take(v)]).filter(([, v]) => v));
      if (missing.size) warnings.push(`Missing ${[...missing].map((m) => `{{${m}}}`).join(', ')}${missing.has('base') ? ' — paste the event page URL' : ''}`);
      if (destination && !/^https?:\/\/\S+$/i.test(destination)) warnings.push('Destination isn’t a full URL');
      if (path && !/^[\w-]+$/.test(path)) warnings.push('Path can only use letters, numbers and dashes');
      if (path && sql.prepare("SELECT 1 FROM chottu_links WHERE entity_id=? AND short_url LIKE '%/' || ?").get(entityId, path)) {
        warnings.push('A link with this path already exists in Pulse');
      }
      return { key: item.key, name, destination, path, utm, social, iosBehavior: item.iosBehavior, androidBehavior: item.androidBehavior, warnings };
    });
    return { template: { id: t.id, name: t.name }, suiteId, items };
  }

  // Create the selected items SEQUENTIALLY, recording each success/failure —
  // a failed path collision must not sink the rest, and nothing is retried
  // blindly (rate limits are unpublished). `overrides` lets the preview's edits
  // (path/name tweaks, unticked items) carry into the real run.
  async function applyTemplate(entityId, templateId, { suiteId, base, items: overrides }, userEmail) {
    const resolved = resolveTemplate(entityId, templateId, { suiteId, base });
    const byKey = new Map((overrides || []).map((o) => [o.key, o]));
    const wanted = (overrides || []).length ? resolved.items.filter((i) => byKey.has(i.key)) : resolved.items;
    if (!wanted.length) throw new HttpError(400, 'Nothing to create — tick at least one link.');
    const results = [];
    for (const item of wanted) {
      const o = byKey.get(item.key) || {};
      try {
        const link = await createLink(entityId, {
          linkName: o.name !== undefined ? o.name : item.name,
          destinationUrl: o.destination !== undefined ? o.destination : item.destination,
          path: o.path !== undefined ? o.path : item.path,
          suiteId, utm: item.utm, social: item.social,
          iosBehavior: item.iosBehavior, androidBehavior: item.androidBehavior,
        }, userEmail);
        results.push({ key: item.key, ok: true, link });
      } catch (e) {
        results.push({ key: item.key, ok: false, error: e.expose ? e.message : 'ChottuLink did not respond — try this one again.' });
      }
    }
    return { created: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
  }

  // First run: seed the platform starter template — the exact per-event set the
  // team has been creating by hand (main + wallet + lineup + map + feed + chat).
  if (!sql.prepare('SELECT COUNT(*) n FROM chottu_templates').get().n) {
    const dest = (q) => `{{base}}?dest=${q}`;
    const items = [
      { key: 'main', name: '{{event.name}}', destination: '{{base}}', path: '{{event.slug}}' },
      { key: 'ticketwallet', name: '{{event.name}} (ticket wallet)', destination: dest('my-tickets'), path: '{{event.slug}}-ticketwallet' },
      { key: 'lineup', name: '{{event.name}} (lineup)', destination: dest('my-lineup'), path: '{{event.slug}}-lineup' },
      { key: 'map', name: '{{event.name}} (map)', destination: dest('my-map'), path: '{{event.slug}}-map' },
      { key: 'eventfeed', name: '{{event.name}} (event feed)', destination: dest('feed'), path: '{{event.slug}}-eventfeed' },
      { key: 'chat', name: '{{event.name}} (chat)', destination: dest('my-chat'), path: '{{event.slug}}-chat' },
    ].map((i) => ({ ...i, utm: { campaign: '{{event.slug}}' }, social: {}, iosBehavior: 2, androidBehavior: 2 }));
    sql.prepare('INSERT INTO chottu_templates (id, entity_id, name, description, items, created_time, modified_time) VALUES (?,?,?,?,?,?,?)')
      .run(crypto.randomUUID(), '', 'Standard event set',
        'The full link set for a new event — main link plus ticket wallet, lineup, map, event feed and chat. Paste the event page URL when applying.',
        JSON.stringify(items), now(), now());
  }

  async function testConnection(entityId) {
    const cfg = configFor(entityId);
    if (!cfg.key) return { ok: false, error: 'No API key configured.' };
    try {
      const data = await chottu(cfg, 'GET', '/links/page?page=1&size=1');
      return { ok: true, totalLinks: data.pagination?.total_items ?? 0, domain: cfg.domain, source: cfg.source };
    } catch (e) {
      return { ok: false, error: e.expose ? e.message : 'ChottuLink did not respond.' };
    }
  }

  const statusFor = (entityId) => {
    const cfg = configFor(entityId);
    return {
      configured: !!(cfg.key && cfg.domain), source: cfg.source, domain: cfg.domain,
      linkCount: sql.prepare('SELECT COUNT(*) n FROM chottu_links WHERE entity_id=? AND archived=0').get(entityId).n,
    };
  };

  // ── routes: admin (Admin → client → 🔗 Deep links) ──
  const A = '/api/admin/entities/:entityId/chottu';
  app.get(`${A}/status`, auth.requireAdmin, (req, res) => res.json(statusFor(req.params.entityId)));
  app.post(`${A}/test`, auth.requireAdmin, asyncHandler(async (req, res) => res.json(await testConnection(req.params.entityId))));
  app.get(`${A}/links`, auth.requireAdmin, (req, res) => res.json({ links: listLinks(req.params.entityId), ...statusFor(req.params.entityId) }));
  app.post(`${A}/links`, auth.requireAdmin, asyncHandler(async (req, res) =>
    res.status(201).json({ link: await createLink(req.params.entityId, req.body || {}, req.user?.email) })));
  app.patch(`${A}/links/:id`, auth.requireAdmin, asyncHandler(async (req, res) =>
    res.json({ link: await updateLink(req.params.entityId, req.params.id, req.body || {}) })));
  app.patch(`${A}/links/:id/status`, auth.requireAdmin, asyncHandler(async (req, res) =>
    res.json({ link: await setEnabled(req.params.entityId, req.params.id, !!req.body?.enabled) })));
  app.get(`${A}/import/preview`, auth.requireAdmin, asyncHandler(async (req, res) => res.json(await importPreview(req.params.entityId))));
  app.post(`${A}/import`, auth.requireAdmin, asyncHandler(async (req, res) =>
    res.json(await importLinks(req.params.entityId, { ids: req.body?.ids, suiteId: req.body?.suiteId }))));
  app.delete(`${A}/links/:id`, auth.requireAdmin, asyncHandler(async (req, res) =>
    res.json(await deleteLink(req.params.entityId, req.params.id))));
  app.post(`${A}/refresh-stats`, auth.requireAdmin, asyncHandler(async (req, res) =>
    res.json(await refreshStats(req.params.entityId, { suiteId: req.body?.suiteId, linkId: req.body?.linkId }))));
  // Templates — admin can also manage the shared platform set ({ platform: true }).
  app.get(`${A}/templates`, auth.requireAdmin, (req, res) => res.json({ templates: listTemplates(req.params.entityId) }));
  app.post(`${A}/templates`, auth.requireAdmin, asyncHandler(async (req, res) =>
    res.status(201).json({ template: saveTemplate(req.params.entityId, null, req.body || {}, { platform: !!req.body?.platform }) })));
  app.patch(`${A}/templates/:tid`, auth.requireAdmin, asyncHandler(async (req, res) =>
    res.json({ template: saveTemplate(req.params.entityId, req.params.tid, req.body || {}, { platform: true }) })));
  app.delete(`${A}/templates/:tid`, auth.requireAdmin, asyncHandler(async (req, res) => {
    getTemplate(req.params.entityId, req.params.tid); // platform templates are admin-deletable too
    sql.prepare('DELETE FROM chottu_templates WHERE id=?').run(req.params.tid);
    res.status(204).end();
  }));
  app.post(`${A}/templates/:tid/preview`, auth.requireAdmin, asyncHandler(async (req, res) =>
    res.json(resolveTemplate(req.params.entityId, req.params.tid, req.body || {}))));
  app.post(`${A}/templates/:tid/apply`, auth.requireAdmin, asyncHandler(async (req, res) =>
    res.json(await applyTemplate(req.params.entityId, req.params.tid, req.body || {}, req.user?.email))));

  // ── routes: client self-service (Engage → Links) ──
  const myEntity = (req) => {
    const entityId = req.params.entityId || req.query.entityId;
    if (!entityId) throw new HttpError(400, 'entityId required');
    if (!(req.user.entityIds || []).includes(entityId)) throw new HttpError(403, 'Not allowed');
    return entityId;
  };
  // Links are a campaign tool — gate on the campaign permission so marketing
  // roles can mint links without holding integrations access.
  const canManage = auth.requirePermission('campaigns.approve', (req) => req.params.entityId || req.query.entityId);
  const M = '/api/my/chottu/:entityId';
  app.get(`${M}/links`, auth.requireAuth, canManage, asyncHandler(async (req, res) => {
    const entityId = myEntity(req);
    res.json({ links: listLinks(entityId), ...statusFor(entityId) });
  }));
  app.post(`${M}/links`, auth.requireAuth, canManage,
    rateLimit({ windowMs: 60_000, max: 20, by: 'user', scope: 'chottu-create', message: 'Too many links at once — give it a minute.' }),
    asyncHandler(async (req, res) => {
      const entityId = myEntity(req);
      res.status(201).json({ link: await createLink(entityId, req.body || {}, req.user?.email) });
    }));
  app.patch(`${M}/links/:id`, auth.requireAuth, canManage, asyncHandler(async (req, res) =>
    res.json({ link: await updateLink(myEntity(req), req.params.id, req.body || {}) })));
  app.patch(`${M}/links/:id/status`, auth.requireAuth, canManage, asyncHandler(async (req, res) =>
    res.json({ link: await setEnabled(myEntity(req), req.params.id, !!req.body?.enabled) })));
  app.delete(`${M}/links/:id`, auth.requireAuth, canManage, asyncHandler(async (req, res) =>
    res.json(await deleteLink(myEntity(req), req.params.id))));
  app.post(`${M}/refresh-stats`, auth.requireAuth, canManage,
    rateLimit({ windowMs: 60_000, max: 4, by: 'user', scope: 'chottu-stats' }),
    asyncHandler(async (req, res) => {
      const entityId = myEntity(req);
      res.json(await refreshStats(entityId, { suiteId: req.body?.suiteId, linkId: req.body?.linkId }));
    }));
  // Templates — clients manage their own; platform templates are read/apply-only.
  app.get(`${M}/templates`, auth.requireAuth, canManage, asyncHandler(async (req, res) =>
    res.json({ templates: listTemplates(myEntity(req)) })));
  app.post(`${M}/templates`, auth.requireAuth, canManage, asyncHandler(async (req, res) =>
    res.status(201).json({ template: saveTemplate(myEntity(req), null, req.body || {}) })));
  app.patch(`${M}/templates/:tid`, auth.requireAuth, canManage, asyncHandler(async (req, res) =>
    res.json({ template: saveTemplate(myEntity(req), req.params.tid, req.body || {}) })));
  app.delete(`${M}/templates/:tid`, auth.requireAuth, canManage, asyncHandler(async (req, res) => {
    getTemplate(myEntity(req), req.params.tid, { forEdit: true });
    sql.prepare('DELETE FROM chottu_templates WHERE id=?').run(req.params.tid);
    res.status(204).end();
  }));
  app.post(`${M}/templates/:tid/preview`, auth.requireAuth, canManage, asyncHandler(async (req, res) =>
    res.json(resolveTemplate(myEntity(req), req.params.tid, req.body || {}))));
  app.post(`${M}/templates/:tid/apply`, auth.requireAuth, canManage,
    rateLimit({ windowMs: 60_000, max: 6, by: 'user', scope: 'chottu-apply', message: 'Too many template runs at once — give it a minute.' }),
    asyncHandler(async (req, res) =>
      res.json(await applyTemplate(myEntity(req), req.params.tid, req.body || {}, req.user?.email))));

  console.log('[chottuLink] deep-link management mounted');
  return { createLink, listLinks, updateLink, setEnabled, deleteLink, importLinks, importPreview, refreshStats, configFor, testConnection, resolveTemplate, applyTemplate, saveTemplate, listTemplates };
}

module.exports = { mount };
