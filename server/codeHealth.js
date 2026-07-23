// ─── Code health panel — disposable module ────────────────────────────────────
// SELF-CONTAINED. Surfaces the daily automated code review INSIDE Pulse
// (Admin → Product → 🩺 Code health) so nobody has to log into GitHub to see
// what it found. The reviewer itself lives in .github/workflows/code-health.yml
// and posts one comment per day to a single rolling issue; this module just
// READS that issue through the GitHub bridge (server/github.js) and caches it
// briefly. No tables, no writes — delete this file + its mount line to remove.
const { asyncHandler } = require('./http');

const ISSUE_TITLE_FRAGMENT = 'Code health — daily review';
const CACHE_MS = 5 * 60_000; // the reviewer posts once a day; 5 min is plenty fresh

function mount(app, { auth, github }) {
  let cache = { at: 0, data: null };

  app.get('/api/admin/code-health', auth.requireAdmin, asyncHandler(async (req, res) => {
    if (!github?.isConfigured?.()) return res.json({ configured: false });
    const bust = req.query.refresh === '1';
    if (!bust && cache.data && Date.now() - cache.at < CACHE_MS) return res.json(cache.data);
    let data;
    try {
      const issue = await github.findOpenIssueByTitle(ISSUE_TITLE_FRAGMENT);
      if (!issue) {
        data = { configured: true, found: false };
      } else {
        // Newest first. Each reviewer comment is one day's report; other
        // comments (fix confirmations, human notes) ride along, labelled by
        // author, so the panel shows the whole conversation the issue holds.
        const reports = (await github.listIssueComments(issue.number)).reverse();
        data = { configured: true, found: true, issue, reports };
      }
      cache = { at: Date.now(), data };
    } catch (e) {
      // GitHub down or rate-limited: stale beats broken.
      if (cache.data) return res.json({ ...cache.data, stale: true });
      throw e; // errorMiddleware sanitizes + pages ops
    }
    res.json(data);
  }));

  return { _clearCache: () => { cache = { at: 0, data: null }; } };
}

module.exports = { mount, ISSUE_TITLE_FRAGMENT };
