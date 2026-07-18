# Spike — Meta Ads MCP server (`https://mcp.facebook.com/ads`)

> 2026-07-18. Question: can Pulse's Owl use Meta's hosted Ads MCP server
> directly (server-side), or is it only reachable through Claude/ChatGPT as
> the MCP client? Probed live from the Pulse codebase session.
> Docs: https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server
> (Meta's doc pages 500 on automated fetches; findings below are from probing
> the live endpoints + community reports.)

## What was established (verified against the live server)

1. **The server speaks spec-standard MCP OAuth.** An unauthenticated
   `initialize` returns `401` with
   `WWW-Authenticate: Bearer resource_metadata="https://mcp.facebook.com/.well-known/oauth-protected-resource/ads"`
   and scopes `ads_management ads_read catalog_management business_management
   pages_show_list instagram_basic ads_mcp_management`.
2. **The authorization server is plain Meta OAuth.** Metadata at
   `https://mcp.facebook.com/.well-known/oauth-authorization-server/ads`:
   - `authorization_endpoint`: `https://www.facebook.com/v25.0/dialog/oauth`
   - `token_endpoint`: `https://graph.facebook.com/v25.0/oauth/access_token`
   - grants: `authorization_code` + **`refresh_token`** (so unattended renewal
     is designed in — the "manual 60-day re-auth" in blog coverage is a client
     limitation, not a protocol one)
   - PKCE S256, `token_endpoint_auth_methods_supported: ["none"]` (public client)
3. **Dynamic client registration is CLOSED.** Every registration attempt at
   `https://mcp.facebook.com/.well-known/register/ads` (Pulse metadata, minimal
   metadata, localhost redirect) returns
   `{"error":"invalid_client_metadata","error_description":"Dynamic registration is not available for this client."}`.
   Not redirect-URI-dependent — it's a client allowlist. OpenAI's Codex CLI hits
   the same wall (https://github.com/openai/codex/issues/24103), as does Claude
   Code (https://github.com/anthropics/claude-code/issues/55002). Claude
   **Desktop/claude.ai** and ChatGPT connect fine ⇒ they are pre-registered
   (allowlisted) clients.

## The open question — answered by the in-product probe

Since the token endpoint is the ordinary Graph endpoint, Meta MCP bearer tokens
are (very likely) ordinary Meta user tokens. The remaining unknown: **does the
MCP resource server accept tokens minted outside its own allowlisted clients**
— i.e. the system-user / "Continue with Facebook" tokens Pulse already stores?
Secrets are write-only in Pulse, so this can't be tested with copy-paste curl;
instead there's an admin-only probe:

- **UI:** Admin → client → Integrations → Meta card → **🧪 Test Meta Ads MCP**
  (shows on any client with a connected Meta token).
- **API:** `POST /api/admin/entities/:id/meta-mcp-probe` (`server/metaConnect.js`).
- It runs `initialize` → `tools/list` with the stored token and reports a
  plain-language verdict + the tool list. Read-only; never returns the token.

### Interpreting the probe

| Result | Meaning | Next step |
|---|---|---|
| ✓ lists tools | Graph tokens work ⇒ the Owl can get Meta's ~29 ads tools server-side via the Anthropic API's MCP connector — no Marketing API wrappers. | Scope "Owl × Meta MCP" properly: per-client flag, read-only tool subset first (reporting, activity logs, Help Center), write tools behind the Owl's draft/approve rule. |
| ✗ 401/403 | The MCP validates the issuing client, not just the token ⇒ closed to third-party backends for now. | Fall back: document for clients how to pair the Pulse connector + Meta's MCP in Claude (https://claude.ai/settings/connectors) / ChatGPT (https://chatgpt.com/#settings/Connectors); watch for Meta opening registration or a partner program (Pipeboard et al. are badged Meta Business Partners). |

## What the MCP does NOT change either way

- **Background jobs stay on the Graph API.** Nightly paid-ads ingestion
  (`server/metaAds.js`) and Custom Audience sync (`server/meta.js`) need
  unattended, Pulse-scheduled access; audience upload isn't in the official MCP
  tool set at all. The existing connection paths (system-user token / Continue
  with Facebook) remain the backbone — the 2026-07-18 setup-guide work stands.
- **Client-side option exists today, zero code:** anyone can add
  `https://mcp.facebook.com/ads` next to the Pulse connector in Claude/ChatGPT
  and get one conversation over both Pulse data and live Meta campaigns.
