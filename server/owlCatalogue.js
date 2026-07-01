// ─── Owl data catalogue — admin-editable field selection ───────────────────────
// SELF-CONTAINED, DISPOSABLE MODULE. The Owl's askData tool queries a CURATED slice
// of the Active Tickets explore (server/owlCatalogueSeed.js). This module lets an
// admin, IN PULSE, see every field in that explore and TICK which ones the Owl may
// use — extras are added on top of the seed, and non-PII seed fields can be turned
// off. The effective catalogue is what owlTools actually runs on.
//
// Safety: contact/PII fields (email, phone, name, id, …) are NEVER selectable as
// groupable data — they stay filter-only lookups exactly as the seed curates them.
// Removing this file + its mount line reverts the Owl to the pure seed.

const seed = require('./owlCatalogueSeed');

const EXTRA_KEY = 'owl_catalogue_extra';       // JSON [{ name, label, kind, type }]
const DISABLED_KEY = 'owl_catalogue_disabled'; // JSON [name, …] (non-PII seed fields turned off)

const PII_PATTERNS = (seed.excluded && seed.excluded.patterns) || ['email', 'cellphone', 'phone', 'mobile', 'id_number', 'first_name', 'last_name', 'passport', 'street', 'postal_code', 'date_of_birth'];
const isPII = (name) => PII_PATTERNS.some((p) => String(name).toLowerCase().includes(String(p).toLowerCase()));

const J = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };
const readExtra = (db) => (Array.isArray(J(db.getSetting(EXTRA_KEY, ''), [])) ? J(db.getSetting(EXTRA_KEY, ''), []) : []);
const readDisabled = (db) => (Array.isArray(J(db.getSetting(DISABLED_KEY, ''), [])) ? J(db.getSetting(DISABLED_KEY, ''), []) : []);

// A cheap cache key: when either setting changes, the string changes → owlTools rebuilds.
function version(db) { return `${db.getSetting(EXTRA_KEY, '')}|${db.getSetting(DISABLED_KEY, '')}`; }

// A memoized owlTools provider: rebuilds via make() only when the catalogue changes, so
// admin edits take effect on the next Owl turn without a restart. Used by the composition
// root to hand owlChat/owlWhatsapp a live getOwlTools() without them knowing about this.
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

// The EFFECTIVE catalogue = seed − disabled(non-PII seed fields) + extras(non-PII).
// Identical to the seed when nothing is configured, so default behaviour is unchanged.
function effective(db) {
  const disabled = new Set(readDisabled(db).filter((n) => !isPII(n)));
  const extras = readExtra(db).filter((e) => e && e.name && !isPII(e.name));
  const seedNames = new Set([...seed.measures, ...seed.dimensions].map((f) => f.name));
  const measures = seed.measures.filter((m) => !disabled.has(m.name));
  const dimensions = seed.dimensions.filter((d) => !disabled.has(d.name));
  const seen = new Set(seedNames);
  const extraNames = [];
  for (const e of extras) {
    if (seen.has(e.name)) continue; // don't duplicate a seed field
    seen.add(e.name);
    const label = String(e.label || e.name).slice(0, 80);
    const type = coarseType(e.type);
    if (e.kind === 'measure') measures.push({ name: e.name, label, type, default: false, aka: [] });
    else dimensions.push({ name: e.name, label, type, group: 'Custom', filter: true, aka: [] });
    extraNames.push(label);
  }
  const notes = [...(seed.notes || [])];
  if (extraNames.length) notes.push(`Admin has enabled extra fields for you to use here: ${extraNames.join(', ')}. Treat them like any other curated field.`);
  return { ...seed, measures, dimensions, notes };
}

// The full explore field list for the admin UI, each annotated with enabled/inSeed/pii.
async function listFields(db, getExploreFields) {
  let f = { measures: [], dimensions: [] };
  try { f = (await getExploreFields(seed.model, seed.explore)) || f; } catch { /* Looker unreachable → empty */ }
  const disabled = new Set(readDisabled(db));
  const extra = new Set(readExtra(db).map((e) => e && e.name).filter(Boolean));
  const seedM = new Map(seed.measures.map((m) => [m.name, m]));
  const seedD = new Map(seed.dimensions.map((d) => [d.name, d]));
  const row = (fld, kind, seedMap) => {
    const name = fld.name;
    const inSeed = seedMap.has(name);
    const seedFld = seedMap.get(name);
    const pii = isPII(name) || (seedFld && seedFld.filterOnly);
    // PII stays lookup-only (never groupable) → not togglable here. Seed non-PII fields
    // are on unless explicitly disabled; extras are on when present.
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
  return { model: seed.model, explore: seed.explore, label: seed.label, measures, dimensions };
}

// Persist the admin's ticked set: derive extras (enabled non-seed, non-PII) + disabled
// (unticked non-PII seed fields) from the full field list. Ignores PII names entirely.
async function setEnabled(db, enabledNames, getExploreFields) {
  const wanted = new Set((Array.isArray(enabledNames) ? enabledNames : []).map(String));
  const { measures, dimensions } = await listFields(db, getExploreFields);
  const all = [...measures, ...dimensions];
  const byName = new Map(all.map((r) => [r.name, r]));
  const extras = [];
  const disabled = [];
  for (const r of all) {
    if (r.pii) continue; // contact fields are never toggled here
    const on = wanted.has(r.name);
    if (r.inSeed) { if (!on) disabled.push(r.name); }
    else if (on) extras.push({ name: r.name, label: r.label, kind: r.kind, type: r.type });
  }
  // Guard: only keep wanted names we actually know (ignore anything not in the explore).
  db.setSetting(EXTRA_KEY, JSON.stringify(extras.filter((e) => byName.has(e.name))));
  db.setSetting(DISABLED_KEY, JSON.stringify(disabled));
  return { ok: true, version: version(db), extras: extras.length, disabled: disabled.length };
}

function mount(app, { db, auth, getExploreFields }) {
  // GET — the whole explore's fields, annotated, for the checkbox UI.
  app.get('/api/admin/owl/catalogue', auth.requireAdmin, async (req, res) => {
    try { res.json(await listFields(db, getExploreFields)); }
    catch (e) { res.status(502).json({ error: 'Could not read the explore fields from Looker.' }); }
  });
  // PUT — save the ticked set { enabled: [name, …] }. Takes effect on the next Owl turn.
  app.put('/api/admin/owl/catalogue', auth.requireAdmin, async (req, res) => {
    try { res.json(await setEnabled(db, (req.body || {}).enabled, getExploreFields)); }
    catch (e) { res.status(500).json({ error: 'Could not save the catalogue selection.' }); }
  });
  console.log('[owlCatalogue] Owl data-catalogue editor mounted');
}

module.exports = { mount, effective, version, provider, listFields, setEnabled, isPII };
