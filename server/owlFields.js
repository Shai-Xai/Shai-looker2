// ─── Owl field dictionary — no-code labels / synonyms / typical questions ──────
// SELF-CONTAINED, DISPOSABLE MODULE. Mounted from owlChat.js. Remove that line + this
// file to uninstall.
//
// The askData catalogue (server/owlCatalogueSeed.js) is code: each measure/dimension
// ships with a label + synonyms. This lets an admin RENAME a field, manage its
// synonyms, and add example "typical questions" WITHOUT a deploy — stored as overrides
// merged over the seed at runtime. The merged list feeds the model's field guide (so
// edits change how the Owl understands questions) and the citation labels.
//
// Stored as a single setting (owl_field_overrides) keyed by field name. Not secret.

const seed = require('./owlCatalogueSeed');

function build(db) {
  const KEY = 'owl_field_overrides';
  const read = () => { try { return JSON.parse(db.getSetting(KEY, '') || '{}'); } catch { return {}; } };
  const write = (o) => db.setSetting(KEY, JSON.stringify(o || {}));

  // Every field (seed measures + dimensions) merged with its override. `label`/`aka`
  // fall back to the seed; `questions` is override-only (the seed has none).
  const list = () => {
    const ov = read();
    const mk = (f, kind) => {
      const o = ov[f.name] || {};
      return {
        name: f.name, kind, type: f.type || '', group: f.group || '', filterOnly: !!f.filterOnly,
        label: (o.label && String(o.label).trim()) || f.label || f.name,
        aka: Array.isArray(o.aka) ? o.aka : (f.aka || []),
        questions: Array.isArray(o.questions) ? o.questions : [],
        edited: !!(o.label || o.aka || o.questions),
      };
    };
    return [...seed.measures.map((m) => mk(m, 'measure')), ...seed.dimensions.map((d) => mk(d, 'dimension'))];
  };

  const save = (incoming) => {
    const ov = {};
    for (const f of incoming || []) {
      if (!f || !f.name) continue;
      const e = {};
      if (f.label != null && String(f.label).trim()) e.label = String(f.label).trim().slice(0, 80);
      if (Array.isArray(f.aka)) { const a = f.aka.map((s) => String(s).trim()).filter(Boolean).slice(0, 30); if (a.length) e.aka = a; }
      if (Array.isArray(f.questions)) { const q = f.questions.map((s) => String(s).trim()).filter(Boolean).slice(0, 12); if (q.length) e.questions = q; }
      if (Object.keys(e).length) ov[f.name] = e;
    }
    write(ov);
    return ov;
  };

  return { list, save, read };
}

function mount(app, { db, auth, getExploreFields }) {
  const api = build(db);
  app.get('/api/admin/owl-fields', auth.requireAdmin, (_req, res) => res.json({ fields: api.list() }));
  app.put('/api/admin/owl-fields', auth.requireAdmin, (req, res) => {
    api.save((req.body || {}).fields || []);
    res.json({ ok: true, fields: api.list() });
  });

  // Sync check: what does Looker's ticketing explore have that the curated catalogue
  // doesn't (new fields to consider adding), and what's in the catalogue but gone from
  // Looker (stale)? Read-only — surfaces the diff so an admin knows what's available.
  app.get('/api/admin/owl-fields/looker-sync', auth.requireAdmin, async (_req, res) => {
    if (typeof getExploreFields !== 'function') return res.json({ supported: false });
    let f; try { f = await getExploreFields(seed.model, seed.explore); } catch { return res.status(502).json({ error: 'Could not reach Looker.' }); }
    if (!f) return res.json({ supported: false });
    const have = new Set([...seed.measures, ...seed.dimensions].map((x) => x.name));
    const lk = [
      ...(f.measures || []).map((m) => ({ name: m.name, label: m.label || m.name, kind: 'measure' })),
      ...(f.dimensions || []).map((d) => ({ name: d.name, label: d.label || d.name, kind: 'dimension' })),
    ];
    const lkNames = new Set(lk.map((x) => x.name));
    res.json({
      supported: true, explore: `${seed.model}/${seed.explore}`,
      newInLooker: lk.filter((x) => !have.has(x.name)),
      missingFromLooker: [...have].filter((n) => !lkNames.has(n)),
      lookerCount: lk.length, curatedCount: have.size,
    });
  });

  console.log('[owlFields] field dictionary module mounted');
  return api;
}

module.exports = { mount, build };
