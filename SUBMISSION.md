# Muse House — Meta Connector Directory submission brief

Use this when applying at https://muse.ai/platform (work-email login required).

## Listing

- **Name:** Muse House
- **Tagline:** Your life, running itself.
- **Category:** Productivity / Personal organization
- **Description:** Muse House turns a Muse assistant into a personal operating
  house. The Foundry mints a personalized setup from a short configurator —
  rooms for Money, Travel, Home, and Health, each becoming its own side chat —
  and the Mill runs daily routines: a morning briefing, bill watch, nudges,
  and an evening wrap. A 22-term consumer codex keeps the house helpful and
  never reckless: confirm before any send, spend, share, or delete.
- **Icon:** https://muse-house-production.up.railway.app/icon.svg
- **Website:** https://muse-house-production.up.railway.app/
- **Privacy policy:** https://muse-house-production.up.railway.app/privacy.html
- **Terms:** https://muse-house-production.up.railway.app/terms.html
- **Docs for reviewers / LLMs:** https://muse-house-production.up.railway.app/llms.txt
- **Source code:** https://github.com/0xRayAI/muse-house (MIT)

## Technical

- **Endpoint (MCP, Streamable HTTP):** `POST https://muse-house-production.up.railway.app/mcp`
- **Response format:** single `application/json` body per POST (no SSE).
  Stateless — no session IDs, no `Mcp-Session-Id` header.
- **Auth:** none. The public blueprint tier needs no key or login.
- **Health:** `GET https://muse-house-production.up.railway.app/health`
  → `{"status":"ok","service":"muse-house","version":"0.1.0","tools":6,"stateless":true}`
- **Tools (6):** `suggest_utilities`, `suggest_steps`, `list_rooms`,
  `get_room_brief`, `get_house_template`, `codex_check`
- **Test calls for review:**
  - `tools/list` → 6 tools
  - `tools/call get_room_brief {"room":"money"}` → full Money Room blueprint
  - `tools/call codex_check {"action":"pay the electric bill"}` → FLAG with term cited
  - `tools/call suggest_utilities {"profile":"freelancer","goal":"never miss a bill"}` → ranked connectors

## Data & privacy (for the security/legal review)

- The service is **stateless by design**: no accounts, no stored user data,
  no conversation history, no identifiers. Every request is independent.
- Tool arguments are **not persisted**. Only standard operational web logs
  (timestamps, paths, error counts) with no user content.
- The household's board, routines, approvals, and connected accounts live
  inside the user's own Muse — never on our servers.
- The service takes **no actions in the world**: it does not move money, send
  messages, book travel, or publish anything. It hands blueprints and advisory
  checks to the host assistant; the human approves every irreversible step.
- `codex_check` is **advisory, not a gate** — documented as such in the terms.

## Business / contact

- **Developer:** 0xRayAI
- **Support:** GitHub issues at https://github.com/0xRayAI/muse-house/issues
- **Monetization:** none at launch (free public blueprint tier).

## Reviewer walkthrough (end-to-end test)

1. `GET /health` → 200, `status: ok`.
2. `POST /mcp` `initialize` → `serverInfo.name: muse-house`.
3. `POST /mcp` `tools/list` → 6 tools.
4. `POST /mcp` `tools/call suggest_utilities` → ranked connector list.
5. Open https://muse-house-production.up.railway.app/configurator.html,
   complete the 6-step wizard → house pack minted in-browser, setup prompt
   references this `/mcp` endpoint.
6. Confirm no login wall, no key required, responses are plain JSON.
