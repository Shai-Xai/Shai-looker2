// ─── Loyalty & preference engine — phase 1: the identity handshake ─────────────
// FACTORY LIBRARY (like query.js/briefing.js), consumed by fanOwl.js: verified
// identity (email + 6-digit code) unlocking a DERIVED fan profile computed from
// the client's own Howler purchase history. Spec: docs/specs/LOYALTY_ENGINE_SPEC.md.
//
// The two rules everything here serves (spec §1):
//   1. VERIFIED IDENTITY ONLY — history is never shown for a typed-in address
//      alone (anyone could type their mate's email). The OTP proves control of
//      the inbox BEFORE anything personal unlocks; verification is per-session.
//   2. DERIVED TRAITS, NEVER RAW HISTORY, REACH THE MODEL — the Looker lookup
//      runs server-side, once, and caches a compact profile (tier + signals +
//      traits) on fan_profiles. The chat context gets that summary; transaction
//      rows never leave this module. Same philosophy as audienceQuery.js.
//
// Scoping (fails closed): the history query carries the entity's organiser
// lock(s) — a fan's history with OTHER Howler clients is never visible here.
// No resolvable organiser lock → no history lookup at all (tier stays "new",
// history marked unavailable) rather than an unscoped query.

const crypto = require('crypto');

// Appended to the fan Owl's instructions ONLY when the entity's fanowl.loyalty
// flag is on. Registered in insights.promptRegistry() (AI audit) like every
// hardcoded prompt.
const FAN_LOYALTY_SYSTEM = `VERIFICATION & REWARDS (these tools are available because the organiser enabled them):
- You can recognise returning fans — but ONLY after they verify. Offer it as a favour, never a gate: "if you've been to one of these events before, I can check if there's a reward waiting — want me to? I just need your email." NEVER imply you already know who they are before verification.
- startVerification → send the fan a 6-digit code, ONLY when they have given you their email in this chat and said yes to checking. One send per request; if it fails, relay the message honestly.
- confirmVerification → check the code the fan typed. On success you get their profile summary (tier, past events, favourite ticket type) — greet them like a friend who remembers ("you were at the last two editions!"), and let it guide your recommendations naturally.
- The profile summary is your ONLY personal fact source. NEVER invent history, spend, tiers or rewards beyond what the tools return. If history is unavailable, say you couldn't find past orders for that email and carry on helping normally.
- A wrong code is no drama — invite them to re-check or resend. Never pressure a fan to verify; "no" ends the topic gracefully.`;

const OTP_TTL_MS = 10 * 60_000; // a code lives 10 minutes
const MAX_ATTEMPTS = 5; //          …and survives 5 wrong guesses
const PROFILE_TTL_MS = 24 * 3600_000; // cached derived profile refresh window

// ── The derived profile (pure — exported for tests) ─────────────────────────────
// rows: Looker /queries/run/json output — one row per event × ticket type with
// sold + revenue measures, already scoped to ONE organiser + ONE purchaser email.
function deriveProfile(rows) {
  const R = Array.isArray(rows) ? rows : [];
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const byEvent = new Map(); // event name → { tickets, spend, date }
  const byType = new Map(); //  ticket type → tickets
  let currency = '';
  for (const r of R) {
    const ev = String(r['core_events.name'] || '').trim();
    if (!ev) continue;
    // Attendance counts ANY active ticket: sold_tickets excludes complimentary
    // tickets (right for revenue, wrong for loyalty — a comp guest still
    // attended), so take the larger of sold vs the incl-comps count.
    const paid = num(r['core_tickets.sold_tickets']);
    const sold = Math.max(paid, num(r['core_tickets.count']));
    const spend = num(r['core_tickets.sum_revenue_decimal']);
    const e = byEvent.get(ev) || { tickets: 0, paid: 0, spend: 0, date: '' };
    e.tickets += sold; e.paid += paid; e.spend += spend;
    const d = String(r['core_events.start_date'] || '');
    if (d > e.date) e.date = d;
    byEvent.set(ev, e);
    const ty = String(r['core_ticket_types.name'] || '').trim();
    if (ty) byType.set(ty, (byType.get(ty) || 0) + sold);
    if (!currency && r['core_events.currency']) currency = String(r['core_events.currency']);
  }
  const events = [...byEvent.entries()].filter(([, e]) => e.tickets > 0);
  const eventsCount = events.length;
  // Paid vs comp views kept SEPARATE so phase-2 reward pools can include or
  // exclude comps from eligibility (spec §5) — the tier here counts attendance.
  const paidEventsCount = events.filter(([, e]) => e.paid > 0).length;
  const totalTickets = events.reduce((n, [, e]) => n + e.tickets, 0);
  const totalSpend = events.reduce((n, [, e]) => n + e.spend, 0);
  const last = events.sort((a, b) => (a[1].date < b[1].date ? 1 : -1))[0] || null;
  const favType = [...byType.entries()].sort((a, b) => b[1] - a[1])[0] || null;
  const maxBasket = events.reduce((n, [, e]) => Math.max(n, e.tickets), 0);
  return {
    tier: eventsCount >= 2 ? 'loyal' : eventsCount >= 1 ? 'returning' : 'new',
    signals: { group_buyer: maxBasket >= 4, comp_guest: eventsCount > paidEventsCount },
    traits: {
      eventsCount, paidEventsCount, totalTickets,
      totalSpend: Math.round(totalSpend * 100) / 100, currency,
      favTicketType: favType ? favType[0] : '',
      lastEvent: last ? { name: last[0], date: last[1].date } : null,
      maxTicketsOneEvent: maxBasket,
    },
  };
}

function createLoyalty({ db, auth, mailer, runQuery, catalogue = require('./owlCatalogueSeed') }) {
  const sql = db.db;
  sql.exec(`
    CREATE TABLE IF NOT EXISTS fan_verifications (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, session_id TEXT NOT NULL,
      email TEXT NOT NULL, code_hash TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      expires_at TEXT NOT NULL, verified_at TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fan_verifications_session ON fan_verifications(session_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_fan_verifications_email ON fan_verifications(entity_id, email, created_at);
  `);
  // The loyalty columns ride fan_profiles (created by fanOwl before this factory runs).
  for (const col of ["verified_at TEXT NOT NULL DEFAULT ''", "verified_channel TEXT NOT NULL DEFAULT ''",
    "tier TEXT NOT NULL DEFAULT ''", "signals TEXT NOT NULL DEFAULT '{}'", "traits TEXT NOT NULL DEFAULT '{}'",
    "profile_refreshed_at TEXT NOT NULL DEFAULT ''"]) {
    try { sql.exec(`ALTER TABLE fan_profiles ADD COLUMN ${col}`); } catch { /* already present */ }
  }
  const now = () => new Date().toISOString();
  const uid = () => crypto.randomUUID();
  const J = (s, d) => { try { const v = JSON.parse(s); return v == null ? d : v; } catch { return d; } };
  const hash = (id, code) => crypto.createHash('sha256').update(`${id}:${code}`).digest('hex');
  const getProfile = (entityId, email) => sql.prepare('SELECT * FROM fan_profiles WHERE entity_id = ? AND email = ?').get(entityId, email);

  // Default Looker runner — lazy so tests can inject a stub and never touch Looker.
  let _runQuery = runQuery;
  const looker = () => (_runQuery ||= require('./query')({ looker: require('./looker'), auth }).runLookerQuery);

  // The entity's organiser lock(s) as real dotted fields — the hard scope for the
  // history query. Same resolution auth.fieldLocksFromEntities applies to every
  // dashboard query. Empty result = fail closed (no history lookup).
  function orgLocks(entityId) {
    const out = {};
    const ent = db.getEntity(entityId);
    for (const [key, v] of Object.entries(ent?.lockedFilters || {})) {
      if (v == null || String(v).trim() === '') continue;
      const field = key.includes('.') ? key : (auth.filterNameToField ? auth.filterNameToField(key) : null);
      if (field && field.includes('.')) out[field] = String(v);
    }
    return out;
  }

  // Compute + cache the derived profile. Best-effort: a Looker hiccup leaves the
  // profile historyless rather than failing the verification.
  async function refreshProfile(entityId, profile, { force = false } = {}) {
    if (!force && profile.profile_refreshed_at && Date.now() - Date.parse(profile.profile_refreshed_at) < PROFILE_TTL_MS) return profile;
    let derived = null;
    const locks = orgLocks(entityId);
    if (Object.keys(locks).length) {
      try {
        const rows = await looker()('/queries/run/json', {
          model: catalogue.model, view: catalogue.explore,
          fields: ['core_events.name', 'core_events.start_date', 'core_events.currency', 'core_ticket_types.name',
            'core_tickets.sold_tickets', 'core_tickets.count', 'core_tickets.sum_revenue_decimal'],
          filters: { 'core_purchasers.email': profile.email, ...locks },
          limit: 500,
        });
        derived = deriveProfile(rows);
      } catch (e) { console.error('[loyalty] history lookup failed', e.message); }
    }
    // lead_no_purchase: they were in fan_profiles (captured lead) but have no
    // purchase history — Pulse's native "preregistrant" (spec §4).
    if (!derived) derived = { tier: 'new', signals: {}, traits: { historyUnavailable: true } };
    derived.signals.lead_no_purchase = derived.tier === 'new' && !!profile.created_at;
    sql.prepare('UPDATE fan_profiles SET tier = ?, signals = ?, traits = ?, profile_refreshed_at = ?, updated_at = ? WHERE id = ?')
      .run(derived.tier, JSON.stringify(derived.signals), JSON.stringify(derived.traits), now(), now(), profile.id);
    return getProfile(entityId, profile.email);
  }

  // The compact summary — what the MODEL is allowed to see (spec §2 PII table).
  const summary = (p) => ({
    tier: p.tier || 'new',
    signals: J(p.signals, {}),
    ...J(p.traits, {}),
    firstName: (p.name || '').split(' ')[0] || '',
  });

  // ── startVerification — send the 6-digit code ─────────────────────────────────
  async function startVerification(site, session, { email }) {
    const em = String(email || '').trim().toLowerCase();
    if (!/.+@.+\..+/.test(em)) return { ok: false, reason: 'bad_email', message: 'That doesn’t look like a valid email address — ask the fan to re-check it.' };
    // Staging test mode (docs/STAGING.md): OUTBOUND_DISABLED=1 hard-kills all
    // email, which would make this flow untestable there — so a staging server
    // may set FAN_OTP_TEST_CODE (6 digits) and that shared code verifies WITHOUT
    // any send. Double-gated: ignored unless the outbound brake is ALSO on, so
    // it can never weaken production.
    const testCode = process.env.OUTBOUND_DISABLED === '1' && /^\d{6}$/.test(process.env.FAN_OTP_TEST_CODE || '') ? process.env.FAN_OTP_TEST_CODE : '';
    if (!mailer.isConfigured() && !testCode) return { ok: false, reason: 'unavailable', message: 'Verification emails aren’t available right now — carry on helping without it.' };
    const tenMinAgo = new Date(Date.now() - 10 * 60_000).toISOString();
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    if (sql.prepare('SELECT COUNT(*) c FROM fan_verifications WHERE session_id = ? AND created_at >= ?').get(session.id, tenMinAgo).c >= 3
      || sql.prepare('SELECT COUNT(*) c FROM fan_verifications WHERE entity_id = ? AND email = ? AND created_at >= ?').get(site.entity_id, em, hourAgo).c >= 5) {
      return { ok: false, reason: 'rate_limited', message: 'Too many codes sent just now — ask the fan to check their inbox (and spam), or try again in a few minutes.' };
    }
    const code = testCode || String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const id = uid();
    sql.prepare('INSERT INTO fan_verifications (id,entity_id,session_id,email,code_hash,expires_at,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, site.entity_id, session.id, em, hash(id, code), new Date(Date.now() + OTP_TTL_MS).toISOString(), now());
    if (testCode) return { ok: true, sent: false, message: 'TEST MODE (staging server, no email sent): ask the fan to type the 6-digit code — the test team knows the shared staging code. Never state the code yourself.' };
    const eventName = site.name || 'the event';
    try {
      await mailer.send({
        to: em, kind: 'fan_otp', entity: site.entity_id, fromName: eventName,
        subject: `${code} is your ${eventName} code`,
        text: `Your verification code is ${code}\n\nIt expires in 10 minutes. If you didn't ask the ${eventName} assistant for this, just ignore this email.`,
        html: `<p>Your verification code is</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>It expires in 10 minutes. If you didn't ask the ${eventName} assistant for this, just ignore this email.</p>`,
      });
    } catch (e) {
      console.error('[loyalty] otp send failed', e.message);
      return { ok: false, reason: 'send_failed', message: 'The code email didn’t go through — apologise and offer to try again.' };
    }
    return { ok: true, sent: true, message: 'Code sent — ask the fan to type the 6 digits from their inbox (worth mentioning spam folders).' };
  }

  // ── confirmVerification — check the code, unlock the profile ──────────────────
  async function confirmVerification(site, session, { code }) {
    const digits = String(code || '').replace(/\D/g, '');
    if (digits.length !== 6) return { ok: false, reason: 'bad_code', message: 'The code is 6 digits — ask the fan to re-type it.' };
    const v = sql.prepare("SELECT * FROM fan_verifications WHERE session_id = ? AND verified_at = '' ORDER BY created_at DESC LIMIT 1").get(session.id);
    if (!v) return { ok: false, reason: 'no_pending', message: 'No code is waiting for this chat — offer to send one first.' };
    if (Date.parse(v.expires_at) < Date.now()) return { ok: false, reason: 'expired', message: 'That code has expired — offer to send a fresh one.' };
    if (v.attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'locked', message: 'Too many wrong tries for that code — offer to send a fresh one.' };
    sql.prepare('UPDATE fan_verifications SET attempts = attempts + 1 WHERE id = ?').run(v.id);
    if (hash(v.id, digits) !== v.code_hash) return { ok: false, reason: 'wrong_code', message: 'That code doesn’t match — ask the fan to double-check the latest email.' };
    sql.prepare('UPDATE fan_verifications SET verified_at = ? WHERE id = ?').run(now(), v.id);
    // Profile row: created historyless if this fan was never captured before.
    // Consent semantics untouched — verification is identity, NOT marketing opt-in.
    let profile = getProfile(site.entity_id, v.email);
    if (!profile) {
      sql.prepare(`INSERT INTO fan_profiles (id,entity_id,email,name,preferences,consent_marketing,consent_at,consent_version,source_site_id,created_at,updated_at)
        VALUES (?,?,?,?,'[]',0,'','',?,?,?)`).run(uid(), site.entity_id, v.email, '', site.id, now(), now());
      profile = getProfile(site.entity_id, v.email);
    }
    sql.prepare('UPDATE fan_profiles SET verified_at = ?, verified_channel = ? WHERE id = ?').run(now(), 'email', profile.id);
    sql.prepare('UPDATE fan_sessions SET profile_id = ? WHERE id = ?').run(profile.id, session.id);
    // A fresh explicit verification always re-derives (don't serve a stale cache
    // to the one fan who just proved who they are; the query layer still caches).
    profile = await refreshProfile(site.entity_id, profile, { force: true });
    return { ok: true, verified: true, profile: summary(profile) };
  }

  // The verified profile behind a SESSION (via its own verification row — a
  // captureLead-linked profile does NOT count as verified). Null if none.
  function verifiedProfile(session) {
    const v = sql.prepare("SELECT * FROM fan_verifications WHERE session_id = ? AND verified_at != '' ORDER BY verified_at DESC LIMIT 1").get(session.id);
    if (!v) return null;
    const p = getProfile(v.entity_id, v.email);
    return p && p.verified_at ? p : null;
  }

  // The VERIFIED FAN instructions block for the chat turn ('' when unverified).
  function contextBlock(site, session) {
    const p = verifiedProfile(session);
    if (!p) return '';
    const s = summary(p);
    const bits = [`tier: ${s.tier}`];
    if (s.eventsCount) bits.push(`been to ${s.eventsCount} of this organiser's event${s.eventsCount === 1 ? '' : 's'} (${s.totalTickets} tickets${s.totalSpend ? `, ${s.currency || ''} ${s.totalSpend} total`.trim() : ''})`);
    if (s.lastEvent?.name) bits.push(`most recent: ${s.lastEvent.name}`);
    if (s.favTicketType) bits.push(`usually buys: ${s.favTicketType}`);
    if (s.signals?.group_buyer) bits.push('tends to buy for a group (4+ tickets)');
    if (s.historyUnavailable) bits.push('purchase history unavailable — treat as a new fan');
    return `VERIFIED FAN (they proved control of ${p.email} this session — use this to guide, never to pressure; never recite it as "data"): ${bits.join('; ')}.`;
  }

  // The Owl's two new tools (offered by fanOwl.js only when fanowl.loyalty is on).
  const tools = (site, session) => ({
    startVerification: {
      schema: { name: 'startVerification', description: 'Email the fan a 6-digit verification code — ONLY when the fan gave their email in this chat and agreed to check for rewards/history. Never invent or reuse an address.', input_schema: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] } },
      run: (input) => startVerification(site, session, input),
    },
    confirmVerification: {
      schema: { name: 'confirmVerification', description: 'Check the 6-digit code the fan typed back. On success returns their derived profile (tier, past events, favourite ticket type) — your only source of personal facts.', input_schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
      run: (input) => confirmVerification(site, session, input),
    },
  });

  return { startVerification, confirmVerification, verifiedProfile, contextBlock, tools, refreshProfile, summary };
}

module.exports = { createLoyalty, deriveProfile, FAN_LOYALTY_SYSTEM };
