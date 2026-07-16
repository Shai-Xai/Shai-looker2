# Post-Event Survey Contract — Pulse ⇄ Howler App

> **Status: PROPOSED (v1, 2026-07-16)** — agreed shape for the joint
> post-event survey feature. Surveys are designed/managed in Pulse, answered
> by fans in the Howler app, results flow back into Pulse.
>
> This document is the single source of truth for the data shapes and
> endpoints. An identical copy lives in both repos:
> - Pulse: `docs/specs/SURVEY_CONTRACT.md`
> - Howler app: `docs/survey-contract.md`
>
> If the contract changes, change BOTH copies in the same round and bump the
> version below.

**Contract version: 1** (sent as `"contractVersion": 1` in every payload).

---

## 1. Principles

- **Pulse owns surveys.** The Howler app never stores survey definitions; it
  fetches them live and renders whatever Pulse sends (within the four
  supported question types).
- **The app talks to Pulse over plain REST + JSON** on a new, app-facing
  surface: `/api/app/...` on the Pulse server. This is separate from the
  existing organiser API (`/api/v1`, secret `pulse_sk_` keys) because a
  fan's phone cannot hold a secret key.
- **Published surveys are immutable.** Answers reference option positions
  (indices), so a live survey's questions/options must never be edited.
  To change a live survey: close it and publish a new one.
- **Question types are fixed at four** (matching the app's existing survey
  UI widgets): `rating` (1–5 stars), `single_choice`, `multiple_choice`,
  `text`.
- **Events are matched by Howler event ID** — the numeric event ID the app
  already has for every ticket (staging IDs while the app points at the
  staging backend).
- **Minimal PII.** The app sends an opaque Howler user ID and (optionally)
  a display name/email only if the survey requests it. v1 responses are
  honest-but-unverified (see Security notes, §6).

## 2. Survey object (Pulse → app)

```json
{
  "contractVersion": 1,
  "id": "srv_a1b2c3",
  "eventId": "19203",
  "eventName": "Bushfire Festival 2026",
  "title": "How was Bushfire?",
  "description": "2 minutes — help us make next year better.",
  "status": "live",
  "opensAt": "2026-07-20T18:00:00Z",
  "closesAt": "2026-08-03T22:00:00Z",
  "questions": [
    {
      "id": "q_overall",
      "type": "rating",
      "text": "How would you rate the event overall?",
      "required": true
    },
    {
      "id": "q_fav",
      "type": "single_choice",
      "text": "What was the highlight?",
      "required": false,
      "options": ["Music", "Food & drink", "Atmosphere", "Production"]
    },
    {
      "id": "q_improve",
      "type": "multiple_choice",
      "text": "What should we improve? (pick any)",
      "required": false,
      "options": ["Queues", "Parking", "Sound", "Food options", "Signage"]
    },
    {
      "id": "q_comments",
      "type": "text",
      "text": "Anything else you'd like to tell us?",
      "required": false
    }
  ]
}
```

Field rules:
- `id` — Pulse-generated, stable, prefix `srv_`.
- `eventId` — string form of the Howler event ID.
- `status` — `draft` | `live` | `closed`. The app only ever receives `live`
  surveys.
- `opensAt` / `closesAt` — ISO-8601 UTC; either may be null (open-ended).
- `questions[].id` — stable within the survey; answers reference it.
- `options` — required for `single_choice`/`multiple_choice` (2–10 entries),
  absent for `rating`/`text`.
- `required` — the app blocks submit until all required questions are
  answered.
- Rating scale is fixed 1–5. Text answers are capped at 1000 characters
  (app enforces, Pulse re-enforces).

## 3. Response object (app → Pulse)

`POST` body:

```json
{
  "contractVersion": 1,
  "surveyId": "srv_a1b2c3",
  "respondent": {
    "howlerUserId": "662076",
    "displayName": null,
    "email": null
  },
  "client": { "platform": "ios", "appVersion": "3.78.1+214" },
  "answers": [
    { "questionId": "q_overall", "type": "rating", "rating": 4 },
    { "questionId": "q_fav", "type": "single_choice", "selectedIndex": 2 },
    { "questionId": "q_improve", "type": "multiple_choice", "selectedIndices": [0, 3] },
    { "questionId": "q_comments", "type": "text", "text": "Loved it. More water points please." }
  ]
}
```

Rules:
- One response per `(surveyId, howlerUserId)`. Re-submitting **replaces** the
  previous response (upsert) — friendlier for fans than an error.
- `selectedIndex` / `selectedIndices` are zero-based positions into the
  question's `options` array. Pulse stores the option text alongside the
  index at write time (snapshot), so results stay readable forever.
- Unanswered optional questions are simply omitted from `answers`.
- `displayName`/`email` are null unless the app user has explicitly agreed
  to share them (not in v1 UI).

## 4. Endpoints (all on the Pulse server)

### App-facing (public, no API key — rate-limited, see §6)

| Method & path | Purpose | Returns |
|---|---|---|
| `GET /api/app/surveys?eventId=19203` | Live surveys for an event | `{ "surveys": [ <survey>, ... ] }` (empty list if none) |
| `GET /api/app/surveys/:id` | One survey by id | `<survey>` or `404` |
| `POST /api/app/surveys/:id/responses` | Submit / replace a response | `200 { "ok": true, "responseId": "rsp_..." }` |

Error shape everywhere: `{ "error": "<safe message>" }` with proper HTTP
status (`400` invalid payload, `404` unknown/not-live survey, `409` survey
closed, `429` rate-limited).

### Pulse-internal (dual-surface rule, normal Pulse auth)

- Admin: `GET/POST/PUT /api/admin/entities/:id/surveys...` — Howler staff
  manage surveys for a client.
- Client self-service: `GET/POST/PUT /api/my/surveys...` — clients manage
  their own, entity-scoped.
- Results: `GET .../surveys/:id/results` — per-question aggregates
  (average rating, counts per option, text answers list) + response count +
  CSV export.

## 5. App-side integration points (Howler repo)

- New `SurveyRepository` interface in `lib/domain/repositories/`, with:
  - `MockSurveyRepositoryImpl` — reads bundled JSON fixtures that match §2/§3
    **byte-for-byte** (fixtures live in `howler_app/assets/mock/surveys/`).
  - `RestSurveyRepositoryImpl` — Dio-based, base URL from a new
    `pulseBaseUrl` in `EnvironmentConfig` (mock env: unused; staging &
    production: `https://howler-pulse-v2.onrender.com`).
- Registered in `injection_container.dart` behind the existing
  `config.useRealApi` switch, same as every other repository.
- UI reuses `EventSurveyScreenContent` + `SurveyThankYouScreenContent` from
  the `howler_screen_builders` package; entry point replaces the
  "Feedback — Coming soon" stub in `my_tickets_screen.dart` /
  `my_events_screen.dart`.

## 6. Security & abuse notes (honest v1 posture)

- The app-facing endpoints are **public by design** (a phone can't keep a
  secret). v1 protections: per-IP + per-user rate limits, payload size caps,
  strict validation, one-response-per-user upsert, and surveys only
  answerable while `live`.
- Consequence to accept in v1: a technically skilled person could submit a
  response with a made-up `howlerUserId`. For post-event feedback this is a
  low-value target; results screens should treat data as directional.
- v2 hardening path (already scoped, not built): the app sends its Howler
  session token in a header; Pulse verifies it once against the Howler
  GraphQL API (`user` query) and only then trusts the user ID. No Howler
  backend changes required.
- No secrets, tokens or payment data ever ride through these endpoints.

## 7. Out of scope for v1

- Push/notification prompts to take a survey (app already has a local
  survey prompt card; deep-link wiring exists via `?survey=true`).
- Incentives/rewards for completion.
- Anonymous-mode analytics, skip logic, free-form question ordering logic.
- Verified respondents (v2, §6).
