// ─── Owl data catalogue — admin-editable explores + field selection ────────────
// SELF-CONTAINED, DISPOSABLE MODULE. The Owl's askData tool queries a CURATED slice
// of the Active Tickets explore (server/owlCatalogueSeed.js — the "primary"). This
// module lets an admin, IN PULSE:
//   • see every field in an explore and TICK which ones the Owl may use, and
//   • REGISTER additional Looker explores (chosen from a live list) for the Owl.
// Slice 1 (this file) owns the platform-level selection + storage; the runtime wiring
// (Owl querying the extra explores) and per-client on/off layer on top of it.
//
// Safety: contact/PII fields (email, phone, name, id, …) are NEVER selectable as
// groupable data — they stay filter-only lookups. Removing this file + its mount line
// reverts the Owl to the pure seed.

const seed = require('./owlCatalogueSeed');

const EXTRA_KEY = 'owl_catalogue_extra';        // primary explore: JSON [{ name, label, kind, type }]
const DISABLED_KEY = 'owl_catalogue_disabled';  // primary explore: JSON [name, …] (non-PII seed fields off)
const EXPLORES_KEY = 'owl_catalogue_explores';  // registered EXTRA explores: JSON [{ model, view, label }]
const EXPFIELDS_KEY = 'owl_catalogue_expfields'; // extra explores' enabled fields: JSON { key: [name, …] }
const ACCESS_KEY = 'owl_catalogue_access';       // per-client on/off: JSON { key: { defaultOn, clients: { entityId: bool } } }

const PRIMARY = { model: seed.model, view: seed.explore, label: seed.label };
const keyOf = (model, view) => `${model}::${view}`;
const isPrimary = (model, view) => model === seed.model && view === seed.explore;

const PII_PATTERNS = (seed.excluded && seed.excluded.patterns) || ['email', 'cellphone', 'phone', 'mobile', 'id_number', 'first_name', 'last_name', 'passport', 'street', 'postal_code', 'date_of_birth'];
const isPII = (name) => PII_PATTERNS.some((p) => String(name).toLowerCase().includes(String(p).toLowerCase()));

const J = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };
const readExtra = (db) => { const v = J(db.getSetting(EXTRA_KEY, ''), []); return Array.isArray(v) ? v : []; };
const readDisabled = (db) => { const v = J(db.getSetting(DISABLED_KEY, ''), []); return Array.isArray(v) ? v : []; };
const readExplores = (db) => { const v = J(db.getSetting(EXPLORES_KEY, ''), []); return Array.isArray(v) ? v.filter((e) => e && e.model && e.view && !isPrimary(e.model, e.view)) : []; };
const readExpFields = (db) => { const v = J(db.getSetting(EXPFIELDS_KEY, ''), {}); return v && typeof v === 'object' ? v : {}; };
const readAccess = (db) => { const v = J(db.getSetting(ACCESS_KEY, ''), {}); return v && typeof v === 'object' ? v : {}; };

// An early build stored an extra explore's ticked fields as plain NAMES (no
// measure/dimension kind), which made everything read as a dimension → zero measures
// → the explore's tool was silently never generated. Normalise both shapes; for
// legacy strings, guess the kind from the name (a wrong guess degrades gracefully —
// the query refuses — and the next Save re-stores full metadata).
const MEASURE_NAME_RE = /(^|[._])(count|sum|total|revenue|amount|value|spend|avg|average|fee|fees|qty|quantity|gmv|turnover)([._]|$)|_(count|sum|total|avg)$/i;
function normalizeExpFields(list) {
  return (Array.isArray(list) ? list : [])
    .map((f) => (typeof f === 'string' ? { name: f, kind: MEASURE_NAME_RE.test(f) ? 'measure' : 'dimension' } : f))
    .filter((f) => f && f.name && !isPII(f.name));
}

// Per-client on/off for an EXTRA explore. Each explore has a platform default
// (on unless the admin flips it) plus per-client overrides. The primary explore is
// always on for everyone. No entityId in context (e.g. a pure admin chat) → the
// platform default applies. Checked PER TURN, so a flip applies immediately.
function exploreEnabledFor(db, key, entityId) {
  const a = readAccess(db)[key];
  if (!a) return true; // nothing configured → on for everyone
  const dflt = a.defaultOn !== false;
  const o = a.clients && entityId != null && entityId !== '' ? a.clients[entityId] : undefined;
  return typeof o === 'boolean' ? o : dflt;
}

// Persist one explore's access config: { defaultOn, clients: { entityId: bool } }.
// Only boolean overrides are kept (anything else means "inherit the default").
function setAccess(db, key, cfg) {
  const all = readAccess(db);
  const clients = {};
  for (const [eid, v] of Object.entries((cfg && cfg.clients) || {})) if (typeof v === 'boolean' && eid) clients[eid] = v;
  all[key] = { defaultOn: !(cfg && cfg.defaultOn === false), clients };
  db.setSetting(ACCESS_KEY, JSON.stringify(all));
  return { ok: true };
}

// A cheap cache key: when any of the selection settings change, this string changes →
// owlTools rebuilds so admin edits take effect on the next Owl turn without a restart.
function version(db) {
  return [EXTRA_KEY, DISABLED_KEY, EXPLORES_KEY, EXPFIELDS_KEY].map((k) => db.getSetting(k, '')).join('|');
}

// A memoized owlTools provider: rebuilds via make() only when the catalogue changes.
function provider(db, make) {
  let inst = null; let ver = null;
  return () => { const v = version(db); if (!inst || v !== ver) { ver = v; inst = make(); } return inst; };
}

// Map a Looker field type to the catalogue's coarse type (only metadata/labels use it).
function coarseType(t) {
  const s = String(t || '').toLowerCase();
  if (s.includes('date') || s.includes('time')) return 'date';
  if (s === 'yesno') return 'yesno';
  if (s.includes('number') || s.includes('int') || s.includes('sum') || s.includes('count') || s.includes('avg') || s.includes('average')) return 'number';
  return 'string';
}

// The registered explores (primary first). Labels come from the stored registration.
function explores(db) { return [PRIMARY, ...readExplores(db)]; }

// The EFFECTIVE PRIMARY catalogue = seed − disabled(non-PII) + extras(non-PII). Identical
// to the seed when nothing is configured. (Slice 2 will fold the extra explores in here.)
function effective(db) {
  const disabled = new Set(readDisabled(db).filter((n) => !isPII(n)));
  const extras = readExtra(db).filter((e) => e && e.name && !isPII(e.name));
  const seedNames = new Set([...seed.measures, ...seed.dimensions].map((f) => f.name));
  const measures = seed.measures.filter((m) => !disabled.has(m.name));
  const dimensions = seed.dimensions.filter((d) => !disabled.has(d.name));
  const seen = new Set(seedNames);
  const extraNames = [];
  for (const e of extras) {
    if (seen.has(e.name)) continue;
    seen.add(e.name);
    const label = String(e.label || e.name).slice(0, 80);
    const type = coarseType(e.type);
    if (e.kind === 'measure') measures.push({ name: e.name, label, type, default: false, aka: [] });
    else dimensions.push({ name: e.name, label, type, group: 'Custom', filter: true, aka: [] });
    extraNames.push(label);
  }
  const notes = [...(seed.notes || [])];
  if (extraNames.length) notes.push(`Admin has enabled extra fields for you to use here: ${extraNames.join(', ')}. Treat them like any other curated field.`);
  // Registered EXTRA explores → each becomes its own catalogue (the Owl gets a separate
  // read tool per explore). Built from the stored field metadata, so it's synchronous.
  const expf = readExpFields(db);
  const extraExplores = readExplores(db).map((e) => {
    const raw = normalizeExpFields(expf[keyOf(e.model, e.view)]);
    const ms = raw.filter((f) => f.kind === 'measure').map((f) => ({ name: f.name, label: String(f.label || f.name), type: coarseType(f.type), default: false, aka: [] }));
    const ds = raw.filter((f) => f.kind !== 'measure').map((f) => ({ name: f.name, label: String(f.label || f.name), type: coarseType(f.type), group: 'Custom', filter: true, aka: [] }));
    if (!ms.length) return null; // need at least one measure to be queryable
    const dateDim = ds.find((d) => d.type === 'date');
    return { model: e.model, explore: e.view, label: e.label, measures: ms, dimensions: ds, dateDimension: dateDim ? dateDim.name : '', notes: [] };
  }).filter(Boolean);
  // NB: no global "you also have these sources" note here — each extra explore's tool
  // carries its own routing/combine guidance in its schema description, so a client
  // with that explore switched OFF is never told they have it (the tool is absent).
  return { ...seed, measures, dimensions, notes, extras: extraExplores };
}

// The full field list for ONE explore, annotated with enabled/inSeed/pii for the UI.
// Defaults to the primary; pass model/view for a registered extra explore.
async function listFields(db, getExploreFields, model = seed.model, view = seed.explore) {
  let f = { measures: [], dimensions: [] };
  try { f = (await getExploreFields(model, view)) || f; } catch { /* Looker unreachable → empty */ }
  const primary = isPrimary(model, view);
  const seedM = new Map(primary ? seed.measures.map((m) => [m.name, m]) : []);
  const seedD = new Map(primary ? seed.dimensions.map((d) => [d.name, d]) : []);
  const disabled = new Set(primary ? readDisabled(db) : []);
  const extra = new Set(primary
    ? readExtra(db).map((e) => e && e.name).filter(Boolean)
    : (readExpFields(db)[keyOf(model, view)] || []).map((f) => (typeof f === 'string' ? f : f && f.name)).filter(Boolean));
  const row = (fld, kind, seedMap) => {
    const name = fld.name;
    const inSeed = seedMap.has(name);
    const seedFld = seedMap.get(name);
    const pii = isPII(name) || (seedFld && seedFld.filterOnly);
    const enabled = pii ? false : (inSeed ? !disabled.has(name) : extra.has(name));
    return {
      name, kind,
      label: (seedFld && seedFld.label) || fld.label || fld.label_short || name,
      type: coarseType(fld.type),
      group: fld.group_label || (seedFld && seedFld.group) || '',
      inSeed, enabled, pii: !!pii,
    };
  };
  const measures = (f.measures || []).filter((m) => !m.hidden).map((m) => row(m, 'measure', seedM));
  const dimensions = (f.dimensions || []).filter((d) => !d.hidden).map((d) => row(d, 'dimension', seedD));
  return { model, view, primary, label: primary ? seed.label : (readExplores(db).find((e) => e.model === model && e.view === view) || {}).label || view, measures, dimensions };
}

// Persist the admin's ticked set for ONE explore. Primary → seed extras/disabled model;
// an extra explore → just its enabled (non-PII) field names. Ignores PII names entirely.
async function setEnabled(db, enabledNames, getExploreFields, model = seed.model, view = seed.explore) {
  const wanted = new Set((Array.isArray(enabledNames) ? enabledNames : []).map(String));
  const { measures, dimensions } = await listFields(db, getExploreFields, model, view);
  const all = [...measures, ...dimensions];
  const known = new Set(all.map((r) => r.name));
  if (isPrimary(model, view)) {
    const extras = []; const disabled = [];
    for (const r of all) {
      if (r.pii) continue;
      const on = wanted.has(r.name);
      if (r.inSeed) { if (!on) disabled.push(r.name); }
      else if (on) extras.push({ name: r.name, label: r.label, kind: r.kind, type: r.type });
    }
    db.setSetting(EXTRA_KEY, JSON.stringify(extras));
    db.setSetting(DISABLED_KEY, JSON.stringify(disabled));
  } else {
    // Store full field metadata (name/label/kind/type) so effective() can build the
    // extra explore's catalogue synchronously (no Looker round-trip at query time).
    const on = all.filter((r) => !r.pii && wanted.has(r.name) && known.has(r.name)).map((r) => ({ name: r.name, label: r.label, kind: r.kind, type: r.type }));
    const map = readExpFields(db); map[keyOf(model, view)] = on;
    db.setSetting(EXPFIELDS_KEY, JSON.stringify(map));
  }
  return { ok: true, version: version(db) };
}

// ── One-shot enrichment: check-in + sales fields on the cashless explore ──────
// Clients ask "who scanned where, on which device, for which ticket type" and
// "what did each operator/station sell, paid how" — those answers live on the
// cashless explore's check-in/access-control and sales-family views, only partly
// ticked in the admin catalogue, so the Owl couldn't answer (or fanned out). This
// does exactly what an admin would in Admin → AI → Owl catalogue: read the
// explore's REAL fields from Looker and enable the non-PII fields of those
// families. Runs once per flag VERSION (bump the flag to sweep newly-needed
// families), only ADDS (never unticks) — later admin edits are always respected.
// v1 (owl_catalogue_checkin_seeded) covered check-ins only; v2 adds the sales
// families (operators, stations, products, operations, payment fields).
const CASHLESS_SEED_FLAG = 'owl_catalogue_cashless_seeded_v2';
const CASHLESS_FAMILY_RE = /check_?in|access_control|sales|operator|operation|station|product/i; // matched against the field's view prefix
// The platform PII patterns skip customer-name fields (the hand-curated primary
// marks those filter-only instead). An UNATTENDED seed must be stricter: never
// auto-enable a customer's name or per-person id. (Operator/station/product
// "name" fields are fine — only person-name shapes are blocked.)
const SEED_PII_RE = /(first|last|full)_?name|phone|mobile|customer_uid/i;
async function seedCashlessFields(db, getExploreFields) {
  if (db.getSetting(CASHLESS_SEED_FLAG, '')) return { ok: true, skipped: 'already seeded' };
  const target = readExplores(db).find((e) => /cashless/i.test(e.view));
  if (!target) return { ok: false, skipped: 'no cashless explore registered' };
  let f;
  try { f = (await getExploreFields(target.model, target.view)) || {}; }
  catch (e) { return { ok: false, skipped: `looker unreachable: ${e.message}` }; } // no flag → retried next boot
  const key = keyOf(target.model, target.view);
  const map = readExpFields(db);
  const current = normalizeExpFields(map[key]);
  const have = new Set(current.map((x) => x.name));
  const added = [];
  const take = (arr, kind) => {
    for (const x of arr || []) {
      if (!CASHLESS_FAMILY_RE.test(String(x.name).split('.')[0])) continue; // its VIEW must be a target family
      if (isPII(x.name) || SEED_PII_RE.test(x.name) || have.has(x.name)) continue;
      added.push({ name: x.name, label: x.label_short || x.label || x.name, kind, type: x.type });
      have.add(x.name);
    }
  };
  take(f.measures, 'measure');
  take(f.dimensions, 'dimension');
  if (added.length) { map[key] = [...current, ...added]; db.setSetting(EXPFIELDS_KEY, JSON.stringify(map)); }
  db.setSetting(CASHLESS_SEED_FLAG, new Date().toISOString());
  return { ok: true, explore: key, added: added.length };
}

// Register / unregister an EXTRA explore (the primary can't be removed).
function registerExplore(db, { model, view, label }) {
  if (!model || !view || isPrimary(model, view)) return { ok: false, error: 'That explore is already available.' };
  const list = readExplores(db);
  if (!list.some((e) => e.model === model && e.view === view)) list.push({ model, view, label: String(label || view).slice(0, 120) });
  db.setSetting(EXPLORES_KEY, JSON.stringify(list));
  return { ok: true };
}
function unregisterExplore(db, model, view) {
  db.setSetting(EXPLORES_KEY, JSON.stringify(readExplores(db).filter((e) => !(e.model === model && e.view === view))));
  const map = readExpFields(db); delete map[keyOf(model, view)]; db.setSetting(EXPFIELDS_KEY, JSON.stringify(map));
  const acc = readAccess(db); delete acc[keyOf(model, view)]; db.setSetting(ACCESS_KEY, JSON.stringify(acc));
  return { ok: true };
}

function mount(app, { db, auth, getExploreFields, listModels }) {
  // GET — registered explores (primary + extras) + the full available list from Looker.
  app.get('/api/admin/owl/explores', auth.requireAdmin, async (req, res) => {
    let available = [];
    try {
      const models = (typeof listModels === 'function' ? await listModels() : []) || [];
      for (const m of models) for (const e of (m.explores || [])) available.push({ model: m.name, view: e.name, label: e.label || e.name, description: e.description || '' });
    } catch { available = []; }
    const access = readAccess(db);
    const expf = readExpFields(db);
    res.json({
      primary: PRIMARY,
      registered: readExplores(db).map((e) => {
        const raw = normalizeExpFields(expf[keyOf(e.model, e.view)]);
        const measures = raw.filter((f) => f.kind === 'measure').length;
        // queryable = the Owl will actually get a tool for it (needs ≥1 ticked measure).
        return { ...e, access: access[keyOf(e.model, e.view)] || { defaultOn: true, clients: {} }, status: { fields: raw.length, measures, queryable: measures > 0 } };
      }),
      available,
    });
  });
  // PUT — one explore's per-client access { model, view, defaultOn, clients: { entityId: bool } }.
  app.put('/api/admin/owl/explores/access', auth.requireAdmin, (req, res) => {
    const { model, view, defaultOn, clients } = req.body || {};
    if (!model || !view || isPrimary(model, view)) return res.status(400).json({ error: 'Pick a registered extra explore.' });
    if (!readExplores(db).some((e) => e.model === model && e.view === view)) return res.status(404).json({ error: 'That explore is not registered.' });
    res.json(setAccess(db, keyOf(model, view), { defaultOn, clients }));
  });
  // POST — register an explore { model, view, label }.
  app.post('/api/admin/owl/explores', auth.requireAdmin, (req, res) => {
    const { model, view, label } = req.body || {};
    res.json(registerExplore(db, { model, view, label }));
  });
  // DELETE — unregister an explore (?model=&view=), clearing its field selection.
  app.delete('/api/admin/owl/explores', auth.requireAdmin, (req, res) => {
    res.json(unregisterExplore(db, String(req.query.model || ''), String(req.query.view || '')));
  });
  // GET — one explore's fields, annotated, for the checkbox UI (defaults to primary).
  app.get('/api/admin/owl/catalogue', auth.requireAdmin, async (req, res) => {
    try { res.json(await listFields(db, getExploreFields, req.query.model || seed.model, req.query.view || seed.explore)); }
    catch (e) { res.status(502).json({ error: 'Could not read the explore fields from Looker.' }); }
  });
  // PUT — save the ticked set { model?, view?, enabled: [name, …] } for one explore.
  app.put('/api/admin/owl/catalogue', auth.requireAdmin, async (req, res) => {
    const b = req.body || {};
    try { res.json(await setEnabled(db, b.enabled, getExploreFields, b.model || seed.model, b.view || seed.explore)); }
    catch (e) { res.status(500).json({ error: 'Could not save the catalogue selection.' }); }
  });
  console.log('[owlCatalogue] Owl data-catalogue editor mounted');
  // Fire-and-forget: enrich the cashless catalogue with check-in + sales fields once.
  seedCashlessFields(db, getExploreFields)
    .then((r) => { if (!r.skipped || r.skipped !== 'already seeded') console.log('[owlCatalogue] cashless field seed:', JSON.stringify(r)); })
    .catch((e) => console.error('[owlCatalogue] cashless field seed failed:', e.message));
}

module.exports = { mount, effective, version, provider, explores, listFields, setEnabled, registerExplore, unregisterExplore, exploreEnabledFor, setAccess, isPII, seedCashlessFields };
