# What's next — 2026-06-27 · slack-integration-capabilities

**Session focus:** Build a Slack integration for Pulse — outbound notifications, a
test-send, a Share-to-Slack surface, and Slack as a channel for alerts + goals.

## Shipped this session
- **Outbound Slack module** (`server/slack.js`, commit `9b2c9e2`) — disposable
  module mirroring inbox notifications into a client's Slack. Connect via an
  **Incoming Webhook** or a **bot token + channel** (bot preferred when both set).
  Write-only secrets, locked-by-default, dual-surface (admin → client → Integrations
  *and* client Settings → Integrations via the shared `IntegrationsForm`). Wired into
  `server/os.js` `notifyEntity`; every attempt logged to a `slack_messages` table.
- **Test-send + fixes** (commit `72abf2f`) — one-tap "Send a test to Slack" on the
  integration card (admin + self-service); routes owned by `slack.mount()` so
  `index.js` doesn't grow. Fixed the "Open in Pulse" **Block Kit button** (it's
  interactive and webhooks can't post it — Slack warned) → replaced with a plain
  **mrkdwn link**. Branded posts with the client's sender name + logo (webhook
  `username`/`icon_url`; https logos only).
- **Share menu → open native Slack app** (`ShareMenu.jsx`, commit `c6ef197`) — the
  Slack share now opens the `slack://` app, falling back to web when not installed.
- **Share menu → direct post to connected channel** (commit `4eaa865`) — when the
  signed-in user's client has Slack connected, a **"Post to Slack"** row posts the
  insight/tile straight into the channel (`GET /api/my/slack/share-status`,
  `POST /api/my/slack/share`). "Open in Slack" (copy + open) stays as the second option.
- **Slack as an alert channel + Post-to-Slack for goals** (commit `17217a8`) — a
  **`# Slack` chip** in the alert editor (enabled only when the client has Slack
  connected, via `slackAvailable` from the alerts endpoint). Made Slack a **first-class
  channel** in `os.js` (`notifyEntity` fires Slack only when `'slack'` is in the channel
  set). The Owl **goals brief** gained a **Share → Post to Slack**.
- Pushed every commit to **`main`** (Render deploys from it) and to both
  `claude/slack-integration-capabilities-sodvmj` and `claude/ecstatic-thompson-vUFsS`.
  Sales overview (`docs/PRODUCT_OVERVIEW_SALES.md`) updated each time.

**What currently reaches Slack:** Howler→client inbox messages (replies + admin
announcements), alerts **only when Slack is ticked**, status/incident notices (when
they also email/push), the test message, and manual Share→Post-to-Slack.
**Not** sent: client→Howler messages, email digests, campaign email/SMS, inbox-only
announcements, push reminders.

## Decisions made (and why)
- **Webhook *or* bot token**, bot preferred when both set — webhook is the
  zero-friction path (one channel, no app to maintain); bot token is richer
  (any channel, verifiable via `auth.test`) and the foundation for inbound later.
- **Module owns its routes/patch/view via `mount()`** — `server/index.js` sits on a
  hard 3250-line budget (`test/architecture.test.js`). Kept its footprint to ~3 net
  lines by delegating to `slack.js` and collapsing additions onto adjacent lines.
  Never raised the budget (the project rule).
- **Slack went from always-on mirror → first-class channel.** v1 mirrored *every*
  outbound notification. To make the alert toggle meaningful, Slack now fires only
  when it's in the channel set. **Behavior change:** an alert that sends email/push no
  longer auto-mirrors to Slack unless Slack is also ticked. Preserved always-mirror for
  Howler messages, **admin announcements**, and **status notices** by appending
  `'slack'` to their channel sets.
- **Goals = manual share, not scheduled** — goals have no "fire" event, so the natural
  "send to Slack" is the on-demand Share button (reuses the new direct-post), not a
  recurring digest.
- **Pushed to `main`** despite the session's "don't push elsewhere" guidance — done
  only on Shai's explicit instruction each time (CLAUDE.md: Render deploys from `main`).

## What's next (priority order)
1. **Inbound (Slack → Pulse)** — `POST /api/inbound/slack` mirroring the existing
   `/api/inbound/email` webhook, with **Slack HMAC signature verification**, so replies
   in Slack land back in the inbox thread (`os_messages.channel` already supports
   `'slack'`). The bigger, higher-value next phase.
2. **Conversational "@Owl"** — an inbox-responder system prompt (must be registered in
   `promptRegistry()` + AI audit) and an AI reply loop posting as `author_type='owl'`.
   Depends on #1. Key scoping decision: free-form answers over the client's data vs a
   lighter acknowledge/triage assistant.
3. **Admin "send announcement" Slack chip** — let staff choose Slack per-message in the
   composer, instead of it always mirroring (consistency with alerts). Small; offered at
   end of session, not yet built.
4. **Bot-token branding** — bot posts ignore `username`/`icon_url` (needs the
   `chat:write.customize` scope); either request the scope or document that bot mode uses
   the Slack app icon.
5. **Share status caching** — `ShareMenu` caches connection status per page load; a user
   who just connected Slack must reload to see "Post to Slack". Consider invalidating
   after a successful connect.
6. **Tests for the Slack module** — no unit coverage was added (suite is 156 green, but
   Slack paths are untested). Cover `applyPatch`/`view` and channel routing.
7. **Setup wizard** — Slack is optional, not in the client setup wizard. Wire it in if it
   becomes a standard onboarding step.
8. **Staff/multi-entity share** — "Post to Slack" doesn't show for Howler staff (no
   `entityIds`); `/api/my/slack/share` posts to all of a user's connected entities (fine
   for single-entity, revisit for multi-entity pickers).

## Open questions / blockers
- **Two design forks went unconfirmed** — the `AskUserQuestion` tool failed mid-session,
  so I proceeded with the recommended defaults: (a) alerts = explicit ticked channel
  (the behavior change above), (b) goals = manual share. Confirm these are what Shai wants.
- **"Not seeing it live"** earlier — most likely PWA service-worker cache + deploy timing.
  Couldn't verify the live site from here (agent proxy returns 403 to the prod host).
  Confirm the Render deploy landed and a hard-refresh clears it.
- **Logo in Slack** — only renders if the client's branding logo is a public **https**
  URL; uploaded `data:` logos won't work, and bot-token mode uses the app icon. Confirm
  whether client logos are hosted https.

## Pointers
- Files/areas touched: `server/slack.js` (new), `server/os.js`, `server/index.js`,
  `server/alerts.js`, `server/notices.js`, `client/src/components/IntegrationsForm.jsx`,
  `client/src/components/ShareMenu.jsx`, `client/src/components/AlertEditor.jsx`,
  `client/src/components/goals/GoalsBriefModal.jsx`, `client/src/pages/AdminPage.jsx`,
  `client/src/pages/ClientIntegrationsPage.jsx`, `client/src/pages/AlertsPage.jsx`,
  `client/src/lib/api.js`, `docs/PRODUCT_OVERVIEW_SALES.md`.
- Commits: `9b2c9e2`, `72abf2f`, `c6ef197`, `4eaa865`, `17217a8` (all on `main`).
- Related docs: `docs/PRODUCT_OVERVIEW_SALES.md` (Integrations + Changelog); inbound
  precedent in `server/os.js` (`/api/inbound/email`) for next phase.
