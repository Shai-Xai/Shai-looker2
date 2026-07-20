# Production-Readiness Audit — Report
## Howler Pulse

**Prepared by:** Platform45  ·  **Prepared for:** Shai (Howler)  ·  **Date:** 20 July 2026
**Audit type:** Standard  ·  **System reviewed:** Howler Pulse — multi-tenant analytics & client-engagement platform (repository `shai-xai/shai-looker2`, `main` branch; production at https://howler-pulse-v2.onrender.com)

---

## 1. Executive summary

We reviewed **Howler Pulse** to assess whether it is ready to run in production — that is, to safely serve real users, hold real data, and support real revenue-affecting decisions without unacceptable risk to your business or your customers.

**Overall verdict: Conditionally ready.** This is not a fragile demo. It is a genuinely well-engineered system: real server-side authentication, strict multi-tenant data separation that fails safely, a full automated test suite that passes (525 tests), encrypted secrets, brute-force protection, and a mature deployment setup with a separate staging environment. That is well above what we typically see in a rapidly-built product, and the team behind it has clearly applied real engineering discipline. Credit where it is due.

The reasons it is *conditionally* ready rather than fully ready are concentrated in two areas, and neither is about the code being "broken." First, **the entire database sits on a single disk on one server, and the off-site backup that would protect it against that disk being lost is an optional setting that must be switched on** — we could not confirm from the code whether it is actually switched on in production, and the recovery procedure has never been rehearsed. If that setting is off, a single hardware failure could permanently lose all customer data. Second, for a public product that collects personal information from South African (and some EU) users, **the legal and privacy scaffolding is missing** — there is no privacy policy, terms, or cookie notice in the app, no way to fulfil a "delete my data" request, and the production database currently lives in the United States.

The good news is that these are known, well-understood, fixable items — not deep architectural flaws. Below we set out exactly what must be confirmed or fixed before you can consider the system launched with confidence, what should follow shortly after, and roughly how much effort each item is. With the launch-blocking items in Section 4 closed, Howler Pulse can be brought to a fully production-ready standard.

---

## 2. What "production-ready" means

A system that demos well is not the same as a system that is ready for production. A demo has to work once, for a friendly user, on the happy path. Production has to work continuously, for strangers — some of whom will make mistakes or act maliciously — while protecting data, staying available, and being fixable when something breaks.

We assessed ten areas that separate the two: security, data integrity, error handling, testing, monitoring, performance, deployment, compliance, code maintainability, and business continuity. We assessed each against Howler Pulse's actual intended use — **a public, installable web app that holds client and end-customer personal data (contacts, campaign recipient lists, messaging threads), sends email and SMS marketing on clients' behalf, and drives revenue and reporting decisions for a South African events business with at least one EU pilot** — not against an abstract ideal.

---

## 3. Scorecard

Scores are 0 (critical) to 4 (strong). The overall verdict is gated: a critical gap in Security, Data, or Compliance means "not production-ready" regardless of the average.

| # | Area | Score /4 | One-line summary |
|---|------|:---:|------------------|
| 1 | Security & authentication | **3** | Genuinely strong; real multi-tenant isolation, minor hardening left |
| 2 | Data integrity & database | **2** | Solid core, but all data on one disk; off-site backup is optional & unconfirmed |
| 3 | Error handling & resilience | **3** | Well-designed; a few routes still leak raw errors |
| 4 | Testing & quality assurance | **3** | 525 automated tests, all passing; no end-to-end/browser tests |
| 5 | Monitoring & operations | **2** | Background failures alert to Slack, but no error tracking or uptime monitoring |
| 6 | Performance & scalability | **3** | Fine for current scale; single-instance ceiling is documented |
| 7 | Infrastructure & deployment | **3** | IaC blueprint, isolated staging, health checks — mature |
| 8 | Compliance, privacy & legal | **1** | Public PII product with no privacy policy, no "delete my data", US data residency |
| 9 | Code quality & maintainability | **3** | Enforced file-size limits, lean deps, accurate docs; some large files |
| 10 | Documentation & business continuity | **3** | Strong docs; account-ownership inventory & tested restore missing |

**Overall: 61% — Conditionally ready.**

No single area scored 0, so the automatic "critical gate" is not triggered. However, the system carries **one potential critical data-loss exposure** (Section 4, C1) that must be confirmed closed, and a cluster of **compliance gaps** (H1–H3) that are launch-blocking for a public product collecting personal data in South Africa and the EU. Go-live should be gated on the defined list in Section 4.

---

## 4. The critical issues (must fix — or confirm — before launch)

### Finding [C1]: All customer data sits on a single disk, and off-site backup is an optional switch we could not confirm is on
**Severity: Critical**  ·  **Area: Data integrity**

**What we found:** The whole system runs as one server with one attached disk, and the entire database — every client, user, dashboard, settlement, document and message — is a single file on that one disk. The software *does* take an automatic nightly backup, and it *can* copy that backup off the server to safe cloud storage — but that off-site copy only happens if four specific settings have been filled in, and by default they ship empty. The nightly backup that always runs is saved onto **the same disk as the live database**, so it does not protect you if that disk is lost. We cannot tell from the code whether the off-site copy is actually switched on in your live environment.

**Why it matters to your business:** If that off-site setting is off and the server's disk fails or is wiped, **every piece of customer data is gone permanently** — with no way to recover it. This is the single highest business risk in the system. Everything else in this report is secondary to knowing the answer to one question: *is the off-site backup switched on, and has anyone ever successfully restored from it?*

**Evidence:** The deployment is defined as one instance with one 1&nbsp;GB disk (`render.yaml:26–30`); the database is a single file on it (`server/db.js:26–28`). The off-site backup credentials are all optional/unset by default (`render.yaml:56–63`), and when they are unset the system explicitly records "no off-box storage configured — local snapshot only" (`server/backup.js:187`). The deploy guide itself states that the local snapshot "alone does NOT survive disk loss" (`DEPLOY.md:85`), and the documented restore procedure has no verification step.

**What needs to happen:** (1) Confirm in the live environment that the off-site backup destination is configured and that backups are actually landing there. (2) Do a **real restore drill** — take a recent backup, restore it to a fresh environment, and confirm the data comes back intact (this also depends on safely keeping a copy of the encryption key; see continuity note). (3) Document the tested procedure. **Estimated effort: Small–Medium (1–3 days), most of it verification rather than building.**

---

### Finding [H1]: There is no way to fulfil a "give me / delete my data" request
**Severity: High**  ·  **Area: Compliance & data integrity**

**What we found:** People whose personal data the system holds (contacts, campaign recipients, chat/lead profiles, inbox threads) have a legal right under POPIA and GDPR to ask for a copy of their data and to have it deleted. There is currently no feature anywhere in the app to do either. The existing "unsubscribe" only stops future marketing to an address — it does not remove or export the person's stored data.

**Why it matters to your business:** If a customer, or a regulator acting on a complaint, asks you to delete or produce someone's personal data, you presently cannot do it except by manual database surgery — and because personal data is spread across many tables that are not linked together (see H4), even that manual deletion would likely miss records. Under POPIA this is a genuine compliance exposure, not a nicety.

**Evidence:** No data-export or person-level erasure endpoint exists in the codebase; the ~40 delete operations all remove business objects (campaigns, segments, threads), never a person's data across tables. Unsubscribe only adds an address to a suppression list (`server/actionTracking.js:94`).

**What needs to happen:** Build a data-subject request capability — locate all data tied to a person (by email/phone), and offer export and delete. **Estimated effort: Medium (a week or so), larger if H4 is not addressed first.**

---

### Finding [H2]: A public app collecting personal data with no privacy policy, terms, or cookie notice
**Severity: High**  ·  **Area: Compliance**

**What we found:** Howler Pulse is a public, installable web app that collects personal information (user logins, contact lists, lead-capture forms). It presents no privacy policy, no terms of use, and no cookie/consent notice anywhere in the product. Compliance is mentioned in *marketing copy* but never surfaced to the people whose data is collected — including a lead-capture form that says "you can unsubscribe any time" but links to no policy.

**Why it matters to your business:** POPIA requires you to tell people what you do with their data at the point you collect it. Marketing the product as privacy-minded while shipping no actual privacy notice creates a real gap between what is claimed and what exists — exactly the kind of thing that turns a routine complaint into a finding against you.

**Evidence:** No `/privacy`, `/terms`, or `/legal` route or consent surface exists in the app; POPIA/GDPR appear only in marketing text (`server/productSite.js:101,152`) and the lead form (`client/src/pages/FanOwlEmbedPage.jsx:227–231`).

**What needs to happen:** Publish a privacy policy and terms (content is a legal task; wiring them into the app is small), and add a cookie/consent notice. **Estimated effort: Small on the engineering side (1–2 days); the policy content needs your legal input.**

---

### Finding [H3]: Production data is stored in the United States
**Severity: High**  ·  **Area: Compliance**

**What we found:** The hosting configuration does not pin a region, so the service defaults to the provider's US (Oregon) region. That means the live database of South African — and some EU — personal data physically sits in the United States, with no documented legal mechanism for that cross-border transfer.

**Why it matters to your business:** POPIA restricts sending personal information outside South Africa, and GDPR restricts EU→US transfers, unless specific safeguards are in place. A SA/EU customer base with the database in the US is a material residency finding.

**Evidence:** `render.yaml` sets no `region` for either service (defaulting to US Oregon); the hosting provider offers a Frankfurt region.

**What needs to happen:** Pin the hosting region to an appropriate location (e.g. Frankfurt) and confirm backups are stored in the same region, or document the transfer safeguard with legal input. **Estimated effort: Small (a planned migration of the environment), but requires a maintenance window and legal sign-off on the chosen approach.**

---

### Finding [H4]: Deleting a user or client leaves their personal data orphaned across many tables
**Severity: High**  ·  **Area: Data integrity**

**What we found:** Only a handful of the core database tables are formally linked so that deleting a record cleans up the related records. Around thirty other tables store personal or account data keyed only by a loose text reference with no such link. As a result, deleting a user or a client removes the main record but leaves behind their preferences, login tokens, saved views, feedback, 2FA records and more — forever.

**Why it matters to your business:** This compounds H1: even a well-intentioned deletion misses data, so "we deleted them" would not be true. Over time these orphaned records also accumulate on the size-limited disk, and a reused identifier could, in theory, surface old data in a new context.

**Evidence:** Foreign-key links exist only on the core organisation tables (`server/db.js`); ~30 satellite tables across modules (`os.js`, `goals.js`, `alerts.js`, `apiKeys.js`, and others) use bare text keys, so `deleteUser`/`deleteEntity` cascade only the linked rows.

**What needs to happen:** Add proper linking (foreign keys with cascade) or a single deletion routine that sweeps every table for a person/entity. **Estimated effort: Medium.**

---

## 5. Issues to address soon after launch

| Ref | Area | Issue (plain English) | Business impact | Effort |
|-----|------|-----------------------|-----------------|:---:|
| M1 | Resilience | ~32 places return raw internal error text to the browser instead of a generic message, bypassing the app's own error-handling policy | Can leak internal details (file paths, upstream error text) to users; contradicts a control the system otherwise enforces well | M |
| M2 | Monitoring | No error tracking (e.g. Sentry) and no uptime monitoring; front-end errors and outages are invisible until a customer reports them | You'd learn about an outage from a customer email, not an alert | S–M |
| M3 | Compliance | Marketing consent "fails open" — if the consent column isn't mapped, everyone is treated as consented — plus an "ignore consent" override with no audit trail | A campaign could be sent to non-consenting recipients, a POPIA direct-marketing risk | M |
| M4 | Security | Embedded-view access tokens aren't invalidated by a password/2FA reset and stay valid up to ~2 hours | A revoked user could keep an embed session briefly after a reset | S |
| M5 | Data | No versioned database migration system; schema changes are additive-only and applied ad hoc | Non-trivial schema changes are hand-rolled and error-prone; environments can drift | M |
| M6 | Security hygiene | A dev session token file (`c.txt`) is committed to the repo (now expired, localhost-only) and slipped past the ignore rules | Low direct risk here, but signals scratch files leaking into the repo | S |
| M7 | Security | Content-Security-Policy only blocks framing; no script-level policy, so no browser-level containment if an XSS bug ever slipped in | Reduces defence-in-depth against a future cross-site-scripting bug | S–M |
| M8 | Data | A couple of multi-step writes aren't wrapped in transactions, and uploaded files are stored inside the database on the 1&nbsp;GB disk | A mid-operation failure could leave half-finished state; large files can crowd the disk and eventually stall backups | M |

---

## 6. Minor items and best-practice improvements

- Rate limiting is held in memory on the single instance; it would need moving to shared storage (e.g. Redis) before scaling to more than one server.
- Cross-site request protection relies on the `SameSite=Lax` cookie setting alone (adequate today; keep the "no side-effects on GET" rule, consider `SameSite=Strict`).
- Password hashing work factor is at the acceptable floor (bcrypt cost 10); consider raising to 12.
- The async error-wrapper (`asyncHandler`) is applied to under half the routes; the rest are safe today via manual try/catch but the protection is opt-in.
- A few very large source files (e.g. `index.js` ~3,000 lines) sit at their enforced size ceiling — the direction is correct and mechanically capped, but they warrant continued extraction.
- Non-application scratch files are committed at the repo root (`loc_data.csv`, `update_tracker.py`, `Build_Value_Tracker.xlsx`, `c.txt`) and should be removed.

---

## 7. What is working well

These are genuine, specific strengths — not padding. They are the reason this system is "conditionally ready" and not "not ready":

- **Multi-tenant data separation is real and fails safely.** Every data query is force-scoped to the client's own events on the server, a client can only ever *narrow* that scope (never widen it), and if a client's scope can't be resolved the query is refused rather than run open. We specifically tested for the classic "change the ID in the URL to see someone else's data" flaw and did not find it.
- **Authentication is properly built:** real server-side sessions, two-factor authentication done correctly, and layered brute-force protection on login (per-IP and per-account limits, plus an alert when someone is being attacked) with no account-enumeration leak.
- **Sensitive settings are encrypted at rest** and are never sent back to the browser — only shown as "set / not set."
- **All database access uses safe, parameterised queries** — we found no SQL-injection exposure. Outbound web requests are guarded against server-side request forgery.
- **There is a real, passing automated test suite** — 525 tests covering the critical paths (login, permissions, 2FA, settlements, campaigns) — plus automatic checks that keep files from growing unbounded. Dependencies are lean and current, with zero known vulnerabilities.
- **Errors are handled by design:** a single place turns errors into safe responses, every external service call (Looker, the AI provider, SMS/email) has a timeout so a slow third party can't hang the app, and an unexpected crash is logged rather than taking the process down.
- **The deployment is mature:** infrastructure defined as code, a **separate staging environment that physically cannot send email/SMS to real customers**, health checks, and Slack alerts when a background job fails.
- **Payments are handled correctly and safely** — the system never touches or stores card data, so it creates no card-security (PCI) obligations for you.
- **Documentation is unusually good and accurate** — the internal guides match what the code actually does.

---

## 8. Recommended roadmap to production

**Stage 1 — Launch blockers (complete or confirm before go-live).** Close C1 by confirming off-site backups are on and running a real restore drill; address the compliance cluster H1 (data-subject requests), H2 (privacy policy/terms/cookie notice), and H3 (data residency); and H4 (personal-data deletion across tables). *Estimated effort: ~2–3 weeks of engineering, plus your legal input on H2/H3 and a verification pass on C1.*

**Stage 2 — Stabilise (first weeks after launch).** Add error tracking and uptime monitoring (M2) so problems surface to you, not to customers; tighten marketing-consent handling (M3); close the raw-error leaks (M1) and the embed-token reset gap (M4). *Estimated effort: ~1 week.*

**Stage 3 — Harden & scale (ongoing).** Introduce a versioned migration system (M5), move uploaded files and rate-limiting off the single instance ahead of scaling (M8, minor items), add a full Content-Security-Policy (M7), and clear the repository scratch files. *Estimated effort: scheduled backlog.*

We recommend not treating the system as launched until Stage 1 is complete — in particular, until the backup/restore question (C1) is answered. If a commercial deadline forces an earlier launch, each unresolved Stage 1 item should be a documented, consciously accepted business risk — signed off with eyes open — rather than an unknown.

---

## 9. How Platform45 can help

This report is yours to act on with any team you choose. If it is useful, Platform45 can carry out the Stage 1 work as a scoped, fixed-price engagement — with the backup/restore verification (C1) as an immediate first step, since it is low-effort and de-risks everything else — and can provide ongoing engineering support to take the system to a fully production-ready standard. We would scope that work from the findings above and share a separate proposal.

---

## Appendix A — Evidence

Findings are anchored to specific files and lines in the reviewed codebase (branch `main`). Key references:

- **C1 (single-disk / optional off-site backup):** `render.yaml:26–30`, `render.yaml:56–63`; `server/db.js:26–28`; `server/backup.js:171,187`; `DEPLOY.md:85,100–101`.
- **H1 (no data-subject requests):** no export/erasure endpoint in `server/*.js`; `server/actionTracking.js:94` (unsubscribe = suppression only).
- **H2 (no privacy surface):** no `/privacy`,`/terms`,`/legal` route in `client/src`; `server/productSite.js:101,152`; `client/src/pages/FanOwlEmbedPage.jsx:227–231`.
- **H3 (data residency):** `render.yaml` — no `region` set (defaults to US Oregon).
- **H4 (orphaned personal data):** foreign keys only on core tables in `server/db.js`; ~30 satellite tables with bare text keys (`server/os.js`, `goals.js`, `alerts.js`, `apiKeys.js`, others).
- **M1 (raw error leaks):** ~32 `res.status(500).json({ error: e.message })` sites, incl. client-facing `server/index.js` briefing routes; policy defined in `server/http.js:29–39`.
- **M3 (consent fail-open):** `server/audienceMap.js:44–45`; `server/actions.js:376`; `client/src/components/CampaignManager.jsx:880–891`.
- **M4 (embed token reset gap):** `server/auth.js:149–157` vs cookie path `auth.js:135–142`.
- **M6 (committed token):** `c.txt` (tracked; JWT expired 2026-07-03, localhost).
- **Strengths:** scope enforcement `server/query.js:106–123`, `server/auth.js:458–503`; SSRF guard `server/safeFetch.js`; 2FA `server/twofactor.js`; login guard `server/loginGuard.js`; error middleware `server/http.js`; staging safety `render.yaml:78–116`.

**Automated sweep results:** `npm audit` — 0 vulnerabilities. `npm test` — 525 tests, 525 passing. `npm run lint` — 0 errors (60 style warnings, mostly unused variables in tests). Architecture line-budget test — passing.

## Appendix B — Method & scope

We assessed the system across ten dimensions using Platform45's Production-Readiness Audit framework, combining automated scanning (dependency and secret scans, static analysis / lint, the project's own test suite) with manual expert review of the source across security, data, resilience, compliance and operations.

**Scope reviewed:** repository `shai-xai/shai-looker2`, `main` branch, as of 20 July 2026. **Explicitly out of scope:** remediation of any issues, a formal penetration test, formal legal or compliance certification, and full-scale load testing. Where these are warranted we have flagged them above.

A note on legal and compliance items: we flag areas of potential legal or regulatory risk (POPIA, GDPR) so you can act on them, but we are not lawyers — please confirm specific obligations with a suitably qualified professional. One item, C1, depends on a live-environment setting we could not read from the source; we have flagged it as requiring operational confirmation rather than asserting it is unprotected.

Prepared by Platform45. This assessment reflects the state of the system as reviewed on 20 July 2026 and the intended use described above. Material changes to the system after this date are not covered.
