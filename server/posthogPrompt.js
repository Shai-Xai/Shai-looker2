// ─── App-analytics Owl prompt — split from server/posthog.js (line budget) ─────
// The page-summary system prompt + its fact-sheet builder. Registered in the
// AI audit via promptRegistry(), which insights.promptRegistry() spreads in
// (through server/posthog.js re-exports — the public interface is unchanged).

// System prompt for the App-analytics page summary (streamed by the ✨ button,
// exact same UX as the whole-dashboard summary). Registered in the AI audit via
// promptRegistry() below, which insights.promptRegistry() spreads in.
const APP_INSIGHT_SYSTEM = `You are the Owl — the senior data analyst for Howler, an events ticketing platform (organisers run events; customers buy tickets and engage in the Howler consumer app; amounts in South African Rand, ZAR).

You are given everything shown on one client's App analytics page for a date window: headline engagement (live actives, unique viewers), the daily series, per-event totals, interaction-type/surface breakdowns, community posts (with their view counts), campaign sends, app-link clicks and the most active app users.

Write the page's story for a non-technical organiser:
- Open with 1-2 sentences on the headline: how their events are doing inside the app this window, and the direction of travel.
- Then 3-6 bullets with the most important specific findings, always with numbers: trend turns and spikes (tie them to the posts / campaign sends / link-click surges that plausibly drove them — they carry timestamps), what people actually do in the app (interaction types, surfaces, CTA taps vs views), the standout posts by views, and anything notable about the super fans (the most active app users).
- End with "Try next:" and 2-3 concrete suggestions grounded in THIS data — e.g. repeat the format/timing of the post that outperformed, tag campaigns to the app, place CTAs on the busiest surface, re-engage a quiet stretch. No generic advice.

Rules: only use the numbers given — never invent, recompute or extrapolate; skip sections with no data rather than mentioning their absence; attribute spikes cautiously ("lines up with", "likely helped") rather than claiming causation; be concise and skimmable; no headings other than the closing "Try next:".`;

// Compact fact sheet the model reads — one section per page panel, numbers only.
function buildAppInsightPrompt({ scopeLabel, report, live, time = null, moments: mom = [], linkClicks: clicks = [], breakdowns = [], topUsers = [], ctaLabels = null, funnel = null }) {
  const L = [];
  if (scopeLabel) L.push(`Scope: ${scopeLabel}.`);
  L.push(`Window: ${report.from} to ${report.to} (${report.days} days, inclusive).`);
  if (live) L.push(`Live: ${live.actives} unique viewers today so far; ${live.windowUniques} unique viewers across the whole window.`);
  if (time && time.sessions) L.push(`Time in app (window): average session ${time.avgSessionSec}s; average total per user ${time.avgUserSec}s, over ${time.sessions} sessions (floors — single-event sessions measure 0s).`);
  const t = report.totals || {};
  L.push(report.kind === 'app'
    ? `Window totals (whole app): interactions ${t.interactions || 0}; views ${t.views || 0}; new users ${t.newUsers || 0}; sessions ${t.sessions || 0}.`
    : `Window totals: interactions ${t.interactions || 0}; views ${t.views || 0}; CTA taps ${t.ctaTaps || 0}; purchases ${t.purchases || 0}${t.purchaseValue ? ` (in-app revenue R${Math.round(t.purchaseValue)})` : ''}.`);
  if ((report.series || []).length) {
    if (report.kind === 'app') {
      L.push('', 'Daily series (date · daily actives · interactions · views · sessions):');
      for (const r of report.series.slice(-31)) L.push(`${r.date} · ${r.dau} · ${r.interactions} · ${r.views} · ${r.sessions}`);
    } else {
      L.push('', 'Daily series (date · uniques · interactions · views · ctaTaps):');
      for (const r of report.series.slice(-31)) L.push(`${r.date} · ${r.uniques} · ${r.interactions} · ${r.views} · ${r.ctaTaps}`);
    }
  }
  if ((report.events || []).length) {
    L.push('', `${report.kind === 'app' ? 'Top events across every client' : 'Per event'} (name · uniques · interactions · views · ctaTaps · purchases):`);
    for (const e of report.events.slice(0, 10)) L.push(`${e.eventName || e.eventRef} · ${e.uniques} · ${e.interactions} · ${e.views} · ${e.ctaTaps} · ${e.purchases}`);
  }
  for (const b of breakdowns) {
    if (!b.values.length) continue;
    L.push('', `Breakdown by ${b.key} (value · count · unique people):`);
    for (const v of b.values.slice(0, 8)) L.push(`${v.value} · ${v.count} · ${v.uniques}`);
  }
  if (ctaLabels && (ctaLabels.labels || []).length) {
    L.push('', `CTA clicks by label (label · clicks · unique people)${ctaLabels.otherCount ? ` — plus ${ctaLabels.otherCount} smaller labels totalling ${ctaLabels.otherClicks} clicks` : ''}:`);
    for (const v of ctaLabels.labels.slice(0, 12)) L.push(`${v.label} · ${v.clicks} · ${v.uniques}`);
  }
  if (funnel && (funnel.steps || []).length) {
    L.push('', 'Checkout funnel — unique people reaching each stage this window (not a strict sequence):');
    for (const s of funnel.steps) L.push(`${s.label} · ${s.people}`);
  }
  const posts = mom.filter((m) => m.type === 'post');
  if (posts.length) {
    L.push('', 'Community posts in the window (time · community · views · reactions · comments · text):');
    for (const p of posts.slice(0, 20)) L.push(`${String(p.at).slice(0, 16)} · ${p.community || '-'} · ${p.impressions ?? p.reach ?? '?'} · ${p.reactions ?? 0} · ${p.comments ?? 0} · ${p.text || p.label}`);
  }
  const camps = mom.filter((m) => m.type === 'campaign');
  if (camps.length) {
    L.push('', 'Campaign sends (time · title · app-relevant):');
    for (const cpn of camps.slice(0, 20)) L.push(`${String(cpn.at).slice(0, 16)} · ${cpn.label} · ${cpn.appLinked ? 'yes' : 'no'}`);
  }
  if (clicks.length) L.push('', `App-link clicks by day: ${clicks.map((r) => `${r.date}:${r.clicks}`).join(' · ')} (total ${clicks.reduce((a, r) => a + r.clicks, 0)}).`);
  if (topUsers.length) {
    L.push('', 'Super fans — the most active app users (name/email · interactions · last seen):');
    for (const u of topUsers) L.push(`${[u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || 'unknown'} · ${u.interactions} · ${String(u.lastSeen).slice(0, 16)}`);
  }
  return L.join('\n');
}
// Surfaced in Admin → AI "Everything the AI is told" via insights.promptRegistry().
function promptRegistry() {
  return [{ key: 'appAnalyticsSummary', label: 'App analytics — Owl page summary', scope: 'Summarises a client\'s App analytics page (engagement, posts, campaigns, link clicks, top users) with grounded suggestions', text: APP_INSIGHT_SYSTEM }];
}

module.exports = { APP_INSIGHT_SYSTEM, buildAppInsightPrompt, promptRegistry };
