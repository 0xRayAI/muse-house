# Muse House — Meta Connector Directory submission brief

Use this when applying at https://muse.ai/platform (work-email login required).

## Listing

- **Name:** Muse House
- **Tagline:** Your life, running itself.
- **Category:** Productivity / Personal organization
- **Description:** Muse House turns a Muse assistant into a personal operating
  house. The Foundry mints a personalized setup from a short configurator —
  nine rooms (Money, Travel, Home, Health, Game, Art, Dev, Coach, Bling), each becoming its
  own side chat — and the Mill runs daily routines: a morning briefing, bill
  watch, nudges, and an evening wrap. Rooms are conversational companions, not
  dashboards: Art generates and iterates on images, Money tracks budgets
  read-only, Home runs chores, maintenance, and household automations. A
  22-term consumer codex keeps the house helpful and never reckless: confirm
  before any send, spend, share, or delete.
- **Icon:** https://mymuse.house/icon.svg
- **Website:** https://mymuse.house/
- **Privacy policy:** https://mymuse.house/privacy.html
- **Terms:** https://mymuse.house/terms.html
- **Docs for reviewers / LLMs:** https://mymuse.house/llms.txt
- **Source code:** https://github.com/0xRayAI/muse-house (MIT)

## Technical

- **Endpoint (MCP, Streamable HTTP):** `POST https://mymuse.house/mcp`
- **Response format:** single `application/json` body per POST (no SSE).
  Stateless — no session IDs, no `Mcp-Session-Id` header.
- **Auth:** public blueprint MCP tier needs no key or login. Token-protected website routes only: `GET /api/bling/orders` (`BLING_API_TOKEN`), `POST /api/bling/dev/grant` (`BLING_DEV_TOKEN`). No connector OAuth is required or invented for blueprints. `install_skill` needs no login but returns files only with proof of a paid Bling purchase (Stripe Checkout session id, verified with Stripe server-side).
- **Health:** `GET https://mymuse.house/health`
  → `{"status":"ok","service":"muse-house","version":"0.1.0","tools":11,"stateless":true}`
- **Tools (11)** with access labels:
  - **read:** `suggest_utilities`, `suggest_steps`, `list_rooms`,
    `get_room_brief`, `get_house_template`, `stamp_rooms` (returns host
    plan only — does not create chats), `codex_check` (advisory, not a
    gate), `get_feedback_form`, `check_room_updates`
  - **sensitive-write:** `send_feedback` (structured kind/room/summary/details;
    durable offsite email to the support inbox; only when the human
    explicitly asks AND confirms the exact text; PII redacted server-side;
    rate-limited; nothing stored)
  - **write:** `install_skill` (skill_id + session_id; **entitlement-gated** —
    returns a purchased skill's files only after Stripe confirms that
    Checkout session is paid and its Bling item sells that skill; unpaid,
    unknown, dev-grant, or unverifiable sessions get a refusal and no files;
    the host writes the files with the human's OK; never charges or moves money)
- **Test calls for review:**
  - `tools/list` → 11 tools
  - `tools/call get_room_brief {"room":"money"}` → full Money Room blueprint
  - `tools/call stamp_rooms {"rooms":"health","owner_name":"Alex"}` → executable room-creation protocol
  - `tools/call codex_check {"action":"pay the electric bill"}` → FLAG with term cited
  - `tools/call suggest_utilities {"profile":"freelancer","goal":"never miss a bill"}` → ranked connectors

## Data & privacy (for the security/legal review)

- The service is **stateless by design**: no accounts, no stored user data,
  no conversation history, no identifiers. Every request is independent.
- Tool arguments are **not persisted**. Only standard operational web logs
  (timestamps, paths, error counts) with no user content.
- The household's board, routines, approvals, and connected accounts live
  inside the user's own Muse — never on our servers.
- The service takes **no high-stakes actions in the world**: it does not move money, send
  messages on the user's behalf, book travel, or publish anything. The single exception is
  **user-initiated feedback**: the website help form (POST /api/feedback) and the
  `send_feedback` MCP tool forward a message the human explicitly asked to send to the
  support inbox. Both are rate-limited, validated, and store nothing. It hands blueprints and advisory
  checks to the host assistant; the human approves every irreversible step.
- `codex_check` is **advisory, not a gate** — documented as such in the terms.

## Known limitations (stated plainly for reviewers)

- Room blueprints reference third-party connectors (Google Calendar, Gmail,
  Plaid, GitHub, Steam, Discord, Telegram, Google Drive). The service itself
  connects to none of them — it ships setup procedures and the host assistant
  verifies real connection status before claiming anything is linked. Some
  listed connectors (Telegram, Discord bot auth) require the user to supply
  their own credentials via a documented setup flow; they are not pre-wired.
- Rooms never take irreversible actions: no money movement, no bookings, no
  sends, no publishes without explicit human approval, enforced by the codex.

## Business / contact (directory packet stubs)

- **Named maintainer:** Ray (0xRayAI) — org https://github.com/0xRayAI
- **Support contact:** support@mymuse.house · help form https://mymuse.house/help.html ·
  GitHub issues https://github.com/0xRayAI/muse-house/issues
- **Directory status:** **draft / not submitted.** Listing copy below is prepared for
  https://muse.ai/platform; there is no completed directory submission ID in-repo.
- **Still required offline (do not invent completed forms):** business verification,
  data/security questionnaire, and a dedicated test account for reviewers. Complete
  those outside this repo before any real directory submit.
- **Monetization / Bling posture:** the Bling shop at https://mymuse.house/bling.html sells optional digital extras (trinkets, gizmos, delights) via **website Stripe Checkout only**. Cards stay on Stripe — this service never sees card numbers. Bling is **not** an MCP money-movement tool (no transfers, trades, or payments via MCP). No Meta money tools. The house, rooms, and mill remain free.


## Reviewer walkthrough (end-to-end test)

1. `GET /health` → 200, `status: ok`.
2. `POST /mcp` `initialize` → `serverInfo.name: muse-house`.
3. `POST /mcp` `tools/list` → 11 tools.
4. `POST /mcp` `tools/call suggest_utilities` → ranked connector list.
5. Open https://mymuse.house/configurator.html,
   complete the 6-step wizard → house pack minted in-browser, setup prompt
   references this `/mcp` endpoint.
6. Confirm no login wall, no key required, responses are plain JSON.
