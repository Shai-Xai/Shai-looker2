# Privacy data map — where contact-level personal data lives

The registry in `server/dsar.js` (entity purge + contact forget) mirrors this
map. **When a new table stores emails, phones, names, or fan free-text, add it
BOTH here and to the dsar registry in the same change.**

Last verified: 2026-07-21 (source: full `CREATE TABLE` sweep of `server/*.js`).

## Tables holding personal data

| Table | Owner module | PII columns | Entity link | Contact link |
|---|---|---|---|---|
| `actions.audience` (+`config`) | actions.js | JSON snapshot rows: email, name, phone | `entity_id` | inside JSON |
| `action_suppressions` | actions.js | email | `entity_id` | email — **KEEP on forget** |
| `action_clicks` / `action_opens` | actions.js | email | via `action_id` | email |
| `action_sent` | actions.js | email | via `root_id` | email |
| `action_sends` | actions.js | recipient (email or phone) | via `action_id` | recipient |
| `action_enrollments` | actions.js | email, name, ticket | via `action_id` | email |
| `action_promo_codes` | actions.js | email | via `action_id` | email |
| `fan_profiles` | fanOwl.js | email, name, preferences, consent | `entity_id` | email |
| `fan_sessions` / `fan_messages` / `fan_events` | fanOwl.js | fan free-text, page URLs | via profile/site | via profile |
| `survey_responses` | surveys.js | email, display_name, answers | via `survey_id` | email |
| `survey_links` | surveyWeb.js | email, display_name | via `survey_id` | email |
| `os_threads` / `os_messages` / `os_receipts` / `os_attachments` | os.js | author email/name, bodies | `entity_id` / via thread | author_email |
| `social_chat_*` (channels/members/messages/reactions/reads/pins) | chat.js | howler_user_id, names, bodies | `entity_id` / via channel | howler_user_id |
| `social_feed_*` (posts/comments/members/posters) | social.js | fan bodies, user ids | `entity_id` | user id |
| `socialplus_*` (joins/members/presence/actors) | socialplus.js | member ids/names | `entity_id` | member id |
| `mail_log` | mailer.js | recipient, subject | `entity_id` | recipient |
| `mail_suppressions` | mailer.js | email | GLOBAL | email — **KEEP on forget** |
| `pixel_events` | pixel.js | visitor id, URLs | `entity_id` | visitor id |
| `tickets` / `ticket_comments` / `ticket_attachments` | tickets.js | reporter email/name, bodies | `entity_id` (may be '') | reporter_email |
| `settlements` / `event_documents` | db.js | data/notes JSON, PDFs | `entity_id` (FK SET NULL) | — |
| `owl_uploads` | owlUploads.js | arbitrary uploaded rows (often emails/phones) | `entity_id` | inside rows |
| `owl_threads` / `owl_messages` | owlChat.js | user_id, free-text | `entity_id` / via thread | user_id |
| `owl_wa_*` (msgs/events/suggest/sent/pending) | owlWhatsapp.js | msisdn (phone), bodies | `entity_id` | msisdn |
| `eventops_staff` / `eventops_staff_wa` | eventops.js / staffAlerts.js | staff names, msisdn | `entity_id` | msisdn |
| `push_subscriptions` | push.js | device endpoints | — | user_id |
| `user_views` / `user_actions` | activity.js | behavioural | — | user_id |
| `tiktok_audience_members` / meta audience members | tiktok.js / meta.js | SHA-256-hashed contacts | `entity_id` | hashed |
| `users` / `user_entities` | db.js | staff/client login email, password hash | membership | email |

## The two deletion paths

- **Entity offboarding** — `DELETE /api/admin/entities/:id` → `dsar.offboardEntity`:
  sweeps every entity-linked table above, then `deleteEntity` (FK cascade covers
  `user_entities`, `suites`+`suite_sets`). Per-table counts + skipped tables are
  returned to the caller — skips are normal when a module isn't installed.
- **Contact forget** — `POST /api/admin/dsar/forget` (super-admin, `confirm:true`):
  erases one person by email/phone everywhere including inside historical
  `actions.audience` JSON snapshots. **Keeps** `mail_suppressions` and
  `action_suppressions` — remembering who said "don't contact me" is the lawful,
  minimal exception; forgetting it would effectively re-subscribe them.
- **Contact export** — `GET /api/admin/dsar/export?email=…` (super-admin): the
  right-of-access mirror of the forget sweep, as JSON.

## Known gaps (documented, not hidden)

- `os_attachments` / `ticket_attachments` bytes live on disk keyed by row id;
  the rows are deleted, orphaned files are unreadable via the app but not yet
  unlinked. Bounded by disk retention; tighten when the blob→R2 move happens (F19).
- `users` rows (staff/client logins) are managed via Admin → Users, not dsar.
- Hashed ad-audience members (tiktok/meta) are already pseudonymised; entity
  purge removes them with the entity.
