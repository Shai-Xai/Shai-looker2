// ─── Journey simulations — watch fake people flow through the real engine ─────
// Builds realistic journeys, enrols personas, and drives server/journeys.js's
// ACTUAL execution engine tick by tick — injecting opens, clicks, purchases,
// ticket types and segment membership, advancing "time" — then prints a
// readable trace of what each person received and which branch they took.
//
//   • `node scripts/journeySim.js`  → the human-readable report (no framework).
//   • test/journeySimulation.test.js imports `SCENARIOS` + `simulate` and turns
//     each persona's expected outcome into a CI assertion.
//
// No network, no real mail: an in-memory SQLite DB + stubbed senders. The engine
// code under test is unchanged and unaware it's a simulation.
const Database = require('better-sqlite3');
const j = require('../server/journeys');

const PAST = () => new Date(Date.now() - 5000).toISOString();
const msg = (o) => ({ type: 'message', channel: 'email', delayHours: 0, subject: '', body: '', ctaText: '', ...o });

// A single simulation run over one journey + a cast of personas.
class Sim {
  // opts.convSource: true (default) = an explicit conversion source (convSet);
  // false = default mode, where "bought" means leaving the live audience.
  constructor(journey, opts = {}) {
    this.convSource = opts.convSource !== false;
    this.sql = new Database(':memory:');
    this.sql.exec(`
      CREATE TABLE action_enrollments (action_id TEXT, email TEXT, name TEXT DEFAULT '', ticket TEXT DEFAULT '', phone TEXT DEFAULT '',
        anchor_at TEXT DEFAULT '', step_index INTEGER DEFAULT 0, next_at TEXT, status TEXT DEFAULT 'active',
        enrolled_at TEXT DEFAULT '', updated_at TEXT DEFAULT '', PRIMARY KEY (action_id, email));
      CREATE TABLE action_clicks (action_id TEXT, email TEXT, at TEXT, channel TEXT DEFAULT '', step INTEGER DEFAULT -1);
      CREATE TABLE action_opens (action_id TEXT, email TEXT, at TEXT, step INTEGER DEFAULT -1);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);`);
    this.reachable = new Map();
    this.convSet = this.convSource ? new Set() : null; // explicit conversion source, or null = "left the audience" mode
    this.segSets = {};               // segmentId -> Set(email) for in_segment branches
    this.emailByPhone = {};          // phone -> email (SMS sends arrive keyed by phone)
    this.sup = new Set();            // unsubscribed emails
    this.sends = [];                 // { to, channel, subject, tick }
    this.syncs = [];                 // { platform, audienceName, action, emails, tick }
    this.tick = '';
    this.action = { id: 'sim', entityId: 'e1', title: journey.name, config: { journey }, results: {} };
    const self = this;
    this.deps = {
      sql: this.sql, now: () => new Date().toISOString(), reachable: this.reachable, convSet: this.convSet, sup: this.sup,
      renderFor: (a, r, node) => ({ html: '<p>x</p>', text: node.body, subject: node.subject }),
      renderSmsFor: (a, r, node) => node.body,
      mailer: { send: async ({ to, subject }) => { self.sends.push({ to, channel: 'email', subject, tick: self.tick }); return { ok: true }; } },
      messaging: { sendSms: async ({ to, text }) => { self.sends.push({ to, channel: 'sms', subject: text, tick: self.tick }); return { ok: true }; } },
      branding: { senderName: 'Sim' },
      saveResults: () => {},
      sysUser: { role: 'admin' },
      audienceFor: async (eid, cfg) => ({ list: [...(self.segSets[cfg.audience?.segmentId] || [])].map((e) => ({ email: e })) }),
      syncAudience: async ({ platform, audienceName, action, members }) => { self.syncs.push({ platform, audienceName, action, emails: members.map((m) => m.email), tick: self.tick }); return { ok: true }; },
    };
  }
  enrol(email, { name = email, phone, ticket = '', attributes = {} } = {}) {
    phone = phone || `+2782${Object.keys(this.emailByPhone).length}`; // unique per person so SMS attributes back to them
    this.emailByPhone[phone] = email;
    this.reachable.set(email, { emailOk: true, smsOk: true, attributes });
    this.sql.prepare("INSERT INTO action_enrollments (action_id,email,name,phone,ticket,anchor_at,next_at,status,enrolled_at,updated_at) VALUES ('sim',?,?,?,?,?,?,'active',?,?)")
      .run(email, name, phone, ticket, PAST(), PAST(), PAST(), PAST());
  }
  open(email) { this.sql.prepare("INSERT INTO action_opens (action_id,email,at,step) VALUES ('sim',?,?,0)").run(email, new Date().toISOString()); }
  click(email) { this.open(email); this.sql.prepare("INSERT INTO action_clicks (action_id,email,at,step) VALUES ('sim',?,?,0)").run(email, new Date().toISOString()); }
  buy(email) { this.convSet.add(email.toLowerCase()); }
  leave(email) { this.reachable.delete(email); } // default mode: leaving the live audience = "bought"
  unsub(email) { this.sup.add(email); }
  consent(email, patch) { this.reachable.set(email, { ...this.reachable.get(email), ...patch }); }
  addToSegment(segId, email) { (this.segSets[segId] = this.segSets[segId] || new Set()).add(email.toLowerCase()); }
  // Advance to the next due moment: everyone active becomes due, and (optionally)
  // any open wait window expires — then run one real engine tick.
  async run(label, { expire = false } = {}) {
    this.tick = label;
    this.sql.prepare("UPDATE action_enrollments SET next_at=? WHERE status='active'").run(PAST());
    if (expire) this.sql.prepare("UPDATE action_enrollments SET wait_until=? WHERE status='active' AND wait_until!=''").run(PAST());
    await j.processAction(this.action, this.deps);
  }
  status(email) { return this.sql.prepare("SELECT status FROM action_enrollments WHERE action_id='sim' AND email=?").get(email)?.status; }
  // Match both email sends (keyed by email) and SMS sends (keyed by phone).
  received(email) { return this.sends.filter((s) => s.to === email || this.emailByPhone[s.to] === email); }
  syncedFor(email) { return this.syncs.filter((s) => s.emails.includes(email)).map((s) => ({ platform: s.platform, action: s.action, audience: s.audienceName })); }
}

// ── Scenarios ─────────────────────────────────────────────────────────────────
// Each: a journey, a flow description, and personas with a `drive(sim)` script +
// the outcome we expect (final status + the exact messages they should receive).
const SCENARIOS = [
  {
    name: 'Abandoned-cart recovery',
    flow: [
      '✉  "You left something behind"   (sent right away)',
      '◆  After 2 days — what did they do?   (severity: bought › clicked › opened › no-response)',
      '   ├─ Purchased          → ✉  "You’re in! 🎉"        → exits CONVERTED',
      '   ├─ Clicked, no buy     → ✉  "Still thinking?"',
      '   ├─ Opened, no click    → ✉  "One more nudge"',
      '   └─ No response         → 💬 "Last call" (SMS)',
    ],
    journey: {
      name: 'Abandoned-cart recovery',
      nodes: [
        msg({ subject: 'You left something behind' }),
        { type: 'decision', question: 'After 2 days, what did they do?', waitHours: 48, branches: [
          { label: 'Purchased', nodes: [msg({ subject: 'You’re in! 🎉' })] },
          { label: 'Clicked, no buy', nodes: [msg({ subject: 'Still thinking?' })] },
          { label: 'Opened, no click', nodes: [msg({ subject: 'One more nudge' })] },
          { label: 'No response', nodes: [msg({ channel: 'sms', body: 'Last call — tap to grab yours' })] },
        ] },
      ],
    },
    personas: [
      { name: 'Sam', email: 'sam@x.com', behaviour: 'opens, then buys',
        drive: [(s, e) => { s.open(e); s.buy(e); }],
        expect: { status: 'converted', got: ['You left something behind', 'You’re in! 🎉'] } },
      { name: 'Ava', email: 'ava@x.com', behaviour: 'opens and clicks, no purchase',
        drive: [(s, e) => s.click(e)],
        expect: { status: 'done', got: ['You left something behind', 'Still thinking?'] } },
      { name: 'Ben', email: 'ben@x.com', behaviour: 'opens, never clicks',
        drive: [(s, e) => s.open(e)],
        expect: { status: 'done', got: ['You left something behind', 'One more nudge'] } },
      { name: 'Zoe', email: 'zoe@x.com', behaviour: 'ignores everything',
        drive: [() => {}],
        expect: { status: 'done', got: ['You left something behind', 'Last call — tap to grab yours'] } },
    ],
  },
  {
    name: 'VIP vs GA split, then RSVP',
    flow: [
      '◆  Ticket type?   (instant audience split)',
      '   ├─ VIP           → ✉  "VIP: lounge + fast-lane"',
      '   └─ Everyone else → ✉  "GA: upgrade to VIP?"',
      '◆  Clicked within a day?',
      '   ├─ Clicked       → ✉  "See you there 🎉"',
      '   └─ No response   → 💬 "Quick reminder" (SMS)',
    ],
    journey: {
      name: 'VIP vs GA split',
      nodes: [
        { type: 'decision', kind: 'split', question: 'Ticket type?', field: 'core_ticket_types.name', branches: [
          { label: 'VIP', values: ['VIP'], nodes: [msg({ subject: 'VIP: lounge + fast-lane' })] },
          { label: 'Everyone else', nodes: [msg({ subject: 'GA: upgrade to VIP?' })] },
        ] },
        { type: 'decision', question: 'Clicked within a day?', waitHours: 24, branches: [
          { label: 'Clicked', nodes: [msg({ subject: 'See you there 🎉' })] },
          { label: 'No response', nodes: [msg({ channel: 'sms', body: 'Quick reminder — doors soon' })] },
        ] },
      ],
    },
    personas: [
      { name: 'Nomsa', email: 'nomsa@x.com', behaviour: 'VIP ticket, clicks',
        attributes: { 'core_ticket_types.name': 'VIP' },
        drive: [(s, e) => s.click(e)],
        expect: { status: 'done', got: ['VIP: lounge + fast-lane', 'See you there 🎉'] } },
      { name: 'Tom', email: 'tom@x.com', behaviour: 'GA ticket, ghosts',
        attributes: { 'core_ticket_types.name': 'General' },
        drive: [() => {}],
        expect: { status: 'done', got: ['GA: upgrade to VIP?', 'Quick reminder — doors soon'] } },
    ],
  },
  {
    name: 'Watch another list (multi-source)',
    flow: [
      '✉  "Early-bird is open"   (sent right away)',
      '◆  After a day — are they on the “FF26 Buyers” list?',
      '   ├─ On the list  → ✉  "Thanks — see you again"',
      '   └─ No response  → ✉  "Last chance for early-bird"',
    ],
    journey: {
      name: 'Watch FF26 Buyers',
      nodes: [
        msg({ subject: 'Early-bird is open' }),
        { type: 'decision', question: 'After a day, are they on FF26 Buyers?', waitHours: 24, branches: [
          { label: 'On FF26 Buyers', when: 'in_segment', segmentName: 'FF26 Buyers', segmentId: 'seg-buyers', nodes: [msg({ subject: 'Thanks — see you again' })] },
          { label: 'No response', nodes: [msg({ subject: 'Last chance for early-bird' })] },
        ] },
      ],
    },
    personas: [
      { name: 'Lena', email: 'lena@x.com', behaviour: 'lands on the “FF26 Buyers” list',
        drive: [(s, e) => s.addToSegment('seg-buyers', e)],
        expect: { status: 'done', got: ['Early-bird is open', 'Thanks — see you again'] } },
      { name: 'Max', email: 'max@x.com', behaviour: 'never appears on the list',
        drive: [() => {}],
        expect: { status: 'done', got: ['Early-bird is open', 'Last chance for early-bird'] } },
    ],
  },
  {
    name: 'Severity — a purchase beats a click beats an open',
    flow: [
      '✉  opener  →  ◆ what did they do?   (all four signals can be true at once)',
      '   Purchased ‹ Clicked ‹ Opened ‹ No response   — the FIRST match wins',
    ],
    journey: {
      name: 'Severity check',
      nodes: [
        msg({ subject: 'opener' }),
        { type: 'decision', question: 'What did they do?', waitHours: 48, branches: [
          { label: 'Purchased', nodes: [msg({ subject: 'You’re in! 🎉' })] },
          { label: 'Clicked, no buy', nodes: [msg({ subject: 'Still thinking?' })] },
          { label: 'Opened, no click', nodes: [msg({ subject: 'One more nudge' })] },
          { label: 'No response', nodes: [msg({ subject: 'We’ll miss you' })] },
        ] },
      ],
    },
    personas: [
      { name: 'Whale', email: 'whale@x.com', behaviour: 'opens AND clicks AND buys (all at once)',
        drive: [(s, e) => { s.click(e); s.buy(e); }],
        expect: { status: 'converted', got: ['opener', 'You’re in! 🎉'] } },
      { name: 'Ivy', email: 'ivy@x.com', behaviour: 'opens AND clicks, no buy',
        drive: [(s, e) => s.click(e)],
        expect: { status: 'done', got: ['opener', 'Still thinking?'] } },
    ],
  },
  {
    name: 'Nested decisions (a decision inside a branch)',
    flow: [
      '✉  opener  →  ◆ Opened?',
      '   ├─ Opened → ◆ Clicked?  →  ├─ Clicked → ✉ "See you there"',
      '   │                          └─ No      → ✉ "Last nudge"',
      '   └─ Didn’t open           →  ✉ "Did you get our email?"',
    ],
    journey: {
      name: 'Nested',
      nodes: [
        msg({ subject: 'opener' }),
        { type: 'decision', question: 'Opened it?', waitHours: 48, branches: [
          { label: 'Opened', nodes: [
            { type: 'decision', question: 'Clicked?', waitHours: 24, branches: [
              { label: 'Clicked', nodes: [msg({ subject: 'See you there' })] },
              { label: 'No response', nodes: [msg({ subject: 'Last nudge' })] },
            ] },
          ] },
          { label: 'Didn’t open', nodes: [msg({ subject: 'Did you get our email?' })] },
        ] },
      ],
    },
    personas: [
      { name: 'Cleo', email: 'cleo@x.com', behaviour: 'opens, then clicks',
        drive: [(s, e) => s.open(e), (s, e) => s.click(e)],
        expect: { status: 'done', got: ['opener', 'See you there'] } },
      { name: 'Dan', email: 'dan@x.com', behaviour: 'opens but never clicks',
        drive: [(s, e) => s.open(e)],
        expect: { status: 'done', got: ['opener', 'Last nudge'] } },
      { name: 'Eve', email: 'eve@x.com', behaviour: 'never opens',
        drive: [() => {}],
        expect: { status: 'done', got: ['opener', 'Did you get our email?'] } },
    ],
  },
  {
    name: 'Safety net — consent gating & unsubscribe',
    flow: [
      '✉  opener  →  ◆ after 2 days  →  💬 "Last call" (SMS)',
      '   • no SMS consent → the SMS is skipped, the journey still completes',
      '   • unsubscribed   → ejected, no further messages',
    ],
    journey: {
      name: 'Safety net',
      nodes: [
        msg({ subject: 'opener' }),
        { type: 'decision', question: 'Reacted after 2 days?', waitHours: 48, branches: [
          { label: 'Clicked', nodes: [msg({ subject: 'Nice one' })] },
          { label: 'No response', nodes: [msg({ channel: 'sms', body: 'Last call — tap here' })] },
        ] },
      ],
    },
    personas: [
      { name: 'Pia', email: 'pia@x.com', behaviour: 'ghosts, but has NO SMS consent',
        consent: { smsOk: false },
        drive: [() => {}],
        expect: { status: 'done', got: ['opener'] } }, // SMS node reached but skipped — no stall
      { name: 'Rob', email: 'rob@x.com', behaviour: 'unsubscribes after the opener',
        drive: [(s, e) => s.unsub(e)],
        expect: { status: 'unsubscribed', got: ['opener'] } },
    ],
  },
  {
    name: 'A purchase exits even with NO “bought” branch',
    flow: [
      '✉  opener  →  ◆ Clicked?  →  ├─ Clicked → ✉ nudge',
      '                              └─ No      → ✉ last chance',
      '   (no Purchased branch) — someone who BUYS should still stop, not get nurtured',
    ],
    journey: {
      name: 'Buyer exit',
      nodes: [
        msg({ subject: 'opener' }),
        { type: 'decision', question: 'Clicked?', waitHours: 48, branches: [
          { label: 'Clicked', nodes: [msg({ subject: 'nudge' })] },
          { label: 'No response', nodes: [msg({ subject: 'last chance' })] },
        ] },
      ],
    },
    personas: [
      { name: 'Gus', email: 'gus@x.com', behaviour: 'buys, never clicks (no bought branch exists)',
        drive: [(s, e) => s.buy(e)],
        expect: { status: 'converted', got: ['opener'] } }, // exits on purchase, gets no sales nudge
      { name: 'Hana', email: 'hana@x.com', behaviour: 'ghosts',
        drive: [() => {}],
        expect: { status: 'done', got: ['opener', 'last chance'] } },
    ],
  },
  {
    name: 'Ad-audience sync from a branch (Meta + TikTok)',
    flow: [
      '✉  opener  →  ◆ bought after 2 days?',
      '   ├─ Bought      → 🎯 REMOVE from "FF27 retargeting" (Meta+TikTok) → ✉ Thanks',
      '   └─ No response → 🎯 ADD to "FF27 retargeting" (Meta+TikTok)    → 💬 Last call',
      '   (stop paying to retarget a buyer; start retargeting the silent)',
    ],
    journey: {
      name: 'Retargeting sync',
      nodes: [
        msg({ subject: 'opener' }),
        { type: 'decision', question: 'Bought after 2 days?', waitHours: 48, branches: [
          { label: 'Bought', nodes: [
            { type: 'sync', platform: 'both', action: 'remove', audienceName: 'FF27 retargeting' },
            msg({ subject: 'Thanks — see you there!' }),
          ] },
          { label: 'No response', nodes: [
            { type: 'sync', platform: 'both', action: 'add', audienceName: 'FF27 retargeting' },
            msg({ channel: 'sms', body: 'Last call — grab your ticket' }),
          ] },
        ] },
      ],
    },
    personas: [
      { name: 'Bea', email: 'bea@x.com', behaviour: 'buys → removed from retargeting on both platforms, thanked',
        drive: [(s, e) => s.buy(e)],
        expect: { status: 'converted', got: ['opener', 'Thanks — see you there!'],
          syncs: [{ platform: 'meta', action: 'remove', audience: 'FF27 retargeting' }, { platform: 'tiktok', action: 'remove', audience: 'FF27 retargeting' }] } },
      { name: 'Cy', email: 'cy@x.com', behaviour: 'ghosts → added to retargeting on both platforms',
        drive: [() => {}],
        expect: { status: 'done', got: ['opener', 'Last call — grab your ticket'],
          syncs: [{ platform: 'meta', action: 'add', audience: 'FF27 retargeting' }, { platform: 'tiktok', action: 'add', audience: 'FF27 retargeting' }] } },
    ],
  },
  {
    name: 'Conversion by LEAVING the audience (default mode, no conversion source)',
    convSource: false, // "bought" = no longer in the live audience (classic abandoned-cart)
    flow: [
      '✉  opener  →  ◆ after 2 days, still in the abandoned-cart audience?',
      '   ├─ Bought (left the audience) → ✉ Thanks  → exits CONVERTED',
      '   └─ No response                → ✉ Last chance',
      '   (no separate conversion list — leaving the audience IS the purchase signal)',
    ],
    journey: {
      name: 'Left-audience conversion',
      nodes: [
        msg({ subject: 'opener' }),
        { type: 'decision', question: 'Bought after 2 days?', waitHours: 48, branches: [
          { label: 'Bought', nodes: [msg({ subject: 'Thanks!' })] },
          { label: 'No response', nodes: [msg({ subject: 'Last chance' })] },
        ] },
      ],
    },
    personas: [
      { name: 'Nia', email: 'nia@x.com', behaviour: 'completes checkout → drops out of the abandoned-cart audience',
        drive: [(s, e) => s.leave(e)],
        expect: { status: 'converted', got: ['opener', 'Thanks!'] } },
      { name: 'Ola', email: 'ola@x.com', behaviour: 'stays in the audience, never buys',
        drive: [() => {}],
        expect: { status: 'done', got: ['opener', 'Last chance'] } },
    ],
  },
  {
    name: 'A late click after the window closed does NOT re-route',
    flow: [
      '✉  opener  →  ◆ clicked in 24h?',
      '   ├─ Clicked → ✉ hot lead',
      '   └─ No      → ✉ last chance   ← Uma lands here…',
      '   …then Uma clicks a day LATE — she must STAY done, not jump to “hot lead”.',
    ],
    journey: {
      name: 'Late click',
      nodes: [
        msg({ subject: 'opener' }),
        { type: 'decision', question: 'Clicked in 24h?', waitHours: 24, branches: [
          { label: 'Clicked', nodes: [msg({ subject: 'hot lead' })] },
          { label: 'No response', nodes: [msg({ subject: 'last chance' })] },
        ] },
      ],
    },
    personas: [
      { name: 'Uma', email: 'uma@x.com', behaviour: 'ghosts through the window, then clicks a day late',
        drive: [() => {}],
        late: [(s, e) => s.click(e)],
        expect: { status: 'done', got: ['opener', 'last chance'] } }, // late click ignored — already finished
      { name: 'Vic', email: 'vic@x.com', behaviour: 'clicks inside the window',
        drive: [(s, e) => s.click(e)],
        expect: { status: 'done', got: ['opener', 'hot lead'] } },
    ],
  },
  {
    name: 'A delayed follow-up INSIDE a branch fires later, not immediately',
    flow: [
      '✉  opener  →  ◆ bought after 2 days?',
      '   ├─ Bought      → ✉ Thanks (converted)',
      '   └─ No response → 💬 Quick reminder (now)  …then  ✉ Final call (+2 days)',
      '   The final email must be SCHEDULED, then send on a later tick — not now.',
    ],
    journey: {
      name: 'Delayed follow-up',
      nodes: [
        msg({ subject: 'opener' }),
        { type: 'decision', question: 'Bought after 2 days?', waitHours: 48, branches: [
          { label: 'Bought', nodes: [msg({ subject: 'Thanks!' })] },
          { label: 'No response', nodes: [
            msg({ channel: 'sms', body: 'Quick reminder' }),
            msg({ subject: 'Final call', delayHours: 48 }),
          ] },
        ] },
      ],
    },
    personas: [
      { name: 'Zed', email: 'zed@x.com', behaviour: 'ghosts → reminder now, final email two days later',
        drive: [() => {}],
        late: [() => {}], // the trailing tick fires the scheduled +2-day email
        expect: { status: 'done', got: ['opener', 'Quick reminder', 'Final call'] } },
      { name: 'Bea', email: 'bea2@x.com', behaviour: 'buys → thanked, no follow-ups',
        drive: [(s, e) => s.buy(e)],
        expect: { status: 'converted', got: ['opener', 'Thanks!'] } },
    ],
  },
  {
    name: 'Email consent revoked — the email node is skipped, journey continues',
    flow: [
      '✉  opener  →  ◆ clicked?  →  ├─ Clicked → ✉ nudge  (no email consent → skipped)',
      '                              └─ No      → ✉ last chance',
      '   No stall: an email with consent off is skipped and the person still finishes.',
    ],
    journey: {
      name: 'Email consent',
      nodes: [
        msg({ subject: 'opener' }),
        { type: 'decision', question: 'Clicked?', waitHours: 24, branches: [
          { label: 'Clicked', nodes: [msg({ subject: 'nudge' })] },
          { label: 'No response', nodes: [msg({ subject: 'last chance' })] },
        ] },
      ],
    },
    personas: [
      { name: 'Wes', email: 'wes@x.com', behaviour: 'clicks, but has email consent OFF',
        consent: { emailOk: false },
        drive: [(s, e) => s.click(e)],
        expect: { status: 'done', got: [] } }, // both emails (opener + nudge) skipped; still completes
    ],
  },
  {
    name: 'Competing segment-watch branches — authored order wins',
    flow: [
      '✉  opener  →  ◆ which list are they on after a day?',
      '   ├─ On "VIP buyers"  → ✉ VIP thanks',
      '   ├─ On "GA buyers"   → ✉ GA thanks',
      '   └─ No response      → ✉ Still time',
      '   Someone on BOTH lists must take the FIRST matching branch (VIP).',
    ],
    journey: {
      name: 'Two watched lists',
      nodes: [
        msg({ subject: 'opener' }),
        { type: 'decision', question: 'On a buyers list after a day?', waitHours: 24, branches: [
          { label: 'VIP buyers', when: 'in_segment', segmentName: 'VIP buyers', segmentId: 'seg-vip', nodes: [msg({ subject: 'VIP thanks' })] },
          { label: 'GA buyers', when: 'in_segment', segmentName: 'GA buyers', segmentId: 'seg-ga', nodes: [msg({ subject: 'GA thanks' })] },
          { label: 'No response', nodes: [msg({ subject: 'Still time' })] },
        ] },
      ],
    },
    personas: [
      { name: 'Val', email: 'val@x.com', behaviour: 'on BOTH VIP and GA lists → takes VIP (first match)',
        drive: [(s, e) => { s.addToSegment('seg-vip', e); s.addToSegment('seg-ga', e); }],
        expect: { status: 'done', got: ['opener', 'VIP thanks'] } },
      { name: 'Gil', email: 'gil@x.com', behaviour: 'on the GA list only',
        drive: [(s, e) => s.addToSegment('seg-ga', e)],
        expect: { status: 'done', got: ['opener', 'GA thanks'] } },
      { name: 'Nod', email: 'nod@x.com', behaviour: 'on neither list',
        drive: [() => {}],
        expect: { status: 'done', got: ['opener', 'Still time'] } },
    ],
  },
  {
    name: 'Split value matching is case- and whitespace-insensitive',
    flow: [
      '◆ ticket type?  ├─ values ["VIP"] → VIP flow   └─ everyone else → GA flow',
      '   A ticket recorded as "  vip " (messy casing/spacing) must still match VIP.',
    ],
    journey: {
      name: 'Messy split value',
      nodes: [
        { type: 'decision', kind: 'split', question: 'Ticket type?', field: 'core_ticket_types.name', branches: [
          { label: 'VIP', values: ['VIP'], nodes: [msg({ subject: 'VIP flow' })] },
          { label: 'Everyone else', nodes: [msg({ subject: 'GA flow' })] },
        ] },
      ],
    },
    personas: [
      { name: 'Mia', email: 'mia@x.com', behaviour: 'ticket recorded as "  vip " (mixed case + spaces)',
        attributes: { 'core_ticket_types.name': '  vip ' },
        drive: [() => {}],
        expect: { status: 'done', got: ['VIP flow'] } },
      { name: 'Sol', email: 'sol@x.com', behaviour: 'ticket "General"',
        attributes: { 'core_ticket_types.name': 'General' },
        drive: [() => {}],
        expect: { status: 'done', got: ['GA flow'] } },
    ],
  },
  {
    name: 'A split with no catch-all still never strands anyone — last branch absorbs the unmatched',
    flow: [
      '◆ ticket type?  ├─ ["VIP"] → VIP flow   └─ ["GA"] → GA flow   (NO explicit "everyone else")',
      '   Validation makes the LAST branch the catch-all, so an unknown ticket',
      '   ("Comp") lands there instead of dangling active forever.',
    ],
    journey: {
      name: 'Split without a catch-all',
      nodes: [
        { type: 'decision', kind: 'split', question: 'Ticket type?', field: 'core_ticket_types.name', branches: [
          { label: 'VIP', values: ['VIP'], nodes: [msg({ subject: 'VIP flow' })] },
          { label: 'GA', values: ['GA'], nodes: [msg({ subject: 'GA flow' })] },
        ] },
      ],
    },
    personas: [
      { name: 'Mia', email: 'mia@x.com', behaviour: 'VIP ticket → matches the first branch',
        attributes: { 'core_ticket_types.name': 'VIP' },
        drive: [() => {}],
        expect: { status: 'done', got: ['VIP flow'] } },
      { name: 'Nix', email: 'nix@x.com', behaviour: 'unknown "Comp" ticket → last branch catches it, not stranded',
        attributes: { 'core_ticket_types.name': 'Comp' },
        drive: [() => {}],
        expect: { status: 'done', got: ['GA flow'] } },
      { name: 'Sol', email: 'sol@x.com', behaviour: 'GA ticket → the last branch (now the catch-all)',
        attributes: { 'core_ticket_types.name': 'GA' },
        drive: [() => {}],
        expect: { status: 'done', got: ['GA flow'] } },
    ],
  },
  {
    name: 'Someone already unsubscribed before the journey starts receives nothing',
    flow: [
      '✉ opener  →  ◆ clicked?  ├─ Clicked → ✉ nice   └─ No response → 💬 last call',
      '   A person on the suppression list before Day 0 is ejected on the first',
      '   tick — never gets even the opener.',
    ],
    journey: {
      name: 'Pre-suppressed guard',
      nodes: [
        msg({ subject: 'opener' }),
        { type: 'decision', question: 'Clicked?', waitHours: 24, branches: [
          { label: 'Clicked', nodes: [msg({ subject: 'nice' })] },
          { label: 'No response', nodes: [msg({ channel: 'sms', body: 'last call' })] },
        ] },
      ],
    },
    personas: [
      { name: 'Kip', email: 'kip@x.com', behaviour: 'already unsubscribed before Day 0 → gets nothing, exits',
        pre: [(s, e) => s.unsub(e)],
        drive: [() => {}],
        expect: { status: 'unsubscribed', got: [] } },
      { name: 'Lou', email: 'lou@x.com', behaviour: 'reachable, ghosts → opener then the SMS last call',
        drive: [() => {}],
        expect: { status: 'done', got: ['opener', 'last call'] } },
    ],
  },
];

// Run a scenario: enrol everyone, send the opener/split, inject each persona's
// behaviour, then let the windows expire — returning per-persona results.
async function simulate(scn) {
  const journey = j.validateJourney(scn.journey);
  const sim = new Sim(journey, { convSource: scn.convSource });
  for (const p of scn.personas) {
    sim.enrol(p.email, { name: p.name, ticket: p.attributes?.['core_ticket_types.name'] || '', attributes: p.attributes || {} });
    if (p.consent) sim.consent(p.email, p.consent); // e.g. no SMS consent
    for (const step of p.pre || []) step(sim, p.email); // state BEFORE the first send (e.g. already unsubscribed)
  }
  await sim.run('Day 0 · sent');                 // openers + everyone parks at the first wait
  for (const p of scn.personas) for (const step of p.drive || []) step(sim, p.email); // inject behaviours
  await sim.run('In-window · reacted');           // early-advancers route immediately
  await sim.run('Window closed', { expire: true }); // the silent take the timeout branch
  // Optional LATE behaviour (e.g. a click after the window already closed) + one
  // more tick — proves a finished person is never reprocessed / re-routed.
  if (scn.personas.some((p) => p.late)) {
    for (const p of scn.personas) for (const step of p.late || []) step(sim, p.email);
    await sim.run('Later · stale signal');
  }
  return scn.personas.map((p) => ({ ...p, status: sim.status(p.email), got: sim.received(p.email), syncs: sim.syncedFor(p.email) }));
}

// Did a persona land exactly where expected — status, the messages received (in
// order), and (if specified) the ad-audience syncs it triggered? Shared by the
// report and the CI test.
function personaOk(p) {
  if (p.status !== p.expect.status) return false;
  if (JSON.stringify(p.got.map((s) => s.subject)) !== JSON.stringify(p.expect.got)) return false;
  if (p.expect.syncs) {
    const norm = (a) => JSON.stringify([...a].sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))));
    if (norm(p.syncs) !== norm(p.expect.syncs)) return false;
  }
  return true;
}

// ── Pretty report (only when run directly) ────────────────────────────────────
const C = process.stdout.isTTY ? { dim: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m` } : { dim: (s) => s, b: (s) => s, g: (s) => s, r: (s) => s, y: (s) => s };
function line(len = 64) { return '─'.repeat(len); }

async function report() {
  let allOk = true;
  console.log(`\n${C.b('JOURNEY SIMULATIONS')} ${C.dim('— fake people through the real branching engine')}\n`);
  for (let i = 0; i < SCENARIOS.length; i++) {
    const scn = SCENARIOS[i];
    console.log(C.b(`\n${line()}`));
    console.log(C.b(`  ${i + 1}. ${scn.name}`));
    console.log(C.b(line()));
    for (const f of scn.flow) console.log('  ' + C.dim(f));
    console.log('');
    const results = await simulate(scn);
    for (const p of results) {
      const ok = personaOk(p);
      allOk = allOk && ok;
      console.log(`  👤 ${C.b(p.name)} ${C.dim('— ' + p.behaviour)}`);
      for (const s of p.got) console.log(`       ${C.dim(s.tick.padEnd(20))} ${s.channel === 'sms' ? '💬' : '✉ '}  ${s.subject}`);
      for (const y of p.syncs) console.log(`       ${C.dim(''.padEnd(20))} 🎯  ${y.action === 'remove' ? 'remove from' : 'add to'} “${y.audience}” · ${y.platform}`);
      const exitTxt = p.status === 'converted' ? C.g('CONVERTED ✔') : `ended: ${p.status}`;
      console.log(`       ${ok ? C.g('✓ ' + exitTxt) : C.r('✗ ' + exitTxt + ` — expected ${p.expect.status} / ${p.expect.got.join(', ')}${p.expect.syncs ? ' / syncs ' + JSON.stringify(p.expect.syncs) : ''}`)}\n`);
    }
    const pass = results.filter(personaOk).length;
    console.log(`  ${pass === results.length ? C.g(`RESULT: ${pass}/${results.length} routed exactly as expected ✓`) : C.r(`RESULT: ${pass}/${results.length} — see ✗ above`)}`);
  }
  console.log(`\n${allOk ? C.g(C.b('ALL SIMULATIONS PASSED ✓')) : C.r(C.b('SOME SIMULATIONS FAILED ✗'))}\n`);
  return allOk;
}

module.exports = { SCENARIOS, simulate, Sim, personaOk };
if (require.main === module) report().then((ok) => process.exit(ok ? 0 : 1)).catch((e) => { console.error(e); process.exit(1); });
