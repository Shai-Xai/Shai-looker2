// ─── Release-notes seed (authored at source) ─────────────────────────────────
// Production has no usable git history (Render does a shallow clone), so we don't
// summarise commits at runtime there. Instead, notes are AUTHORED here as part of
// the change that ships them — version-controlled, reviewed in the PR, and applied
// once on boot. Each entry is applied exactly once (its `key` is recorded in the
// `release_seed_applied` setting), so re-deploys never duplicate a note, nor
// resurrect one an admin has since edited or deleted. See
// docs/specs/RELEASE_NOTES_SPEC.md.
//
// To add a note: append an object with a STABLE unique `key`, the `date`, and the
// three lenses — `summary` (end-user), `howTo` (end-user steps), `dev` (internal).
// `published` defaults to true (seeded notes are reviewed at authoring time).

const SEED = [
  {
    key: 'release-notes-2.0',
    date: '2026-06-22',
    title: 'Daily release notes — three lenses',
    summary: [
      "- Pulse now publishes release notes so you can always see what's new.",
      '- Each update comes with a short how-to, so new features are easy to start using.',
      "- A What's New panel and a weekly email summary are coming next.",
    ].join('\n'),
    howTo: [
      '1. Open Admin → Product → Daily release notes.',
      '2. Review a draft, edit any lens (Summary / How-to / Dev), then Publish.',
      "3. Published notes will reach clients via What's New + the weekly email (shipping next).",
    ].join('\n'),
    deepLink: '/admin',
    dev: [
      '- `release_notes` gains how_to, body_dev, deep_link, modules (additive ALTER).',
      '- RELEASE_NOTES_SYSTEM emits { summary, howTo, deepLink, dev }; registered in promptRegistry().',
      '- Daily auto-draft tick (kill switch: release_notes_auto) + how-to:/link: commit trailers.',
      '- Prod has no git history → notes are seeded here and applied once on boot.',
    ].join('\n'),
    published: true,
  },
];

// Apply any not-yet-applied seed notes. Idempotent: each `key` is recorded in the
// `release_seed_applied` setting and never re-applied, so an admin's later edits
// or deletions survive deploys.
function applySeed(db) {
  try {
    let applied;
    try { applied = new Set(JSON.parse(db.getSetting('release_seed_applied', '[]') || '[]')); }
    catch { applied = new Set(); }
    let added = 0;
    for (const n of SEED) {
      if (!n.key || applied.has(n.key)) continue;
      db.createReleaseNote({
        date: n.date,
        title: n.title || '',
        body: n.summary || '',
        howTo: n.howTo || '',
        bodyDev: n.dev || '',
        deepLink: n.deepLink || '',
        published: n.published !== false,
        source: 'seed',
      });
      applied.add(n.key);
      added += 1;
    }
    if (added) {
      db.setSetting('release_seed_applied', JSON.stringify([...applied]));
      console.log(`[release-notes] applied ${added} seeded note(s)`);
    }
  } catch (e) {
    console.error('[release-notes] seed apply failed:', e.message);
  }
}

module.exports = { SEED, applySeed };
