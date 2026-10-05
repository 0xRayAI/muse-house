# Muse House — MCP service

The foundry behind Muse House, served as a **stateless external MCP service**
over Streamable HTTP. A Muse host agent connects it as a custom connector and
gets: house blueprints, room briefs, utility suggestions, operating plans, and
consumer-codex checks.

## What it is

- **Blueprints, not data.** The service mints *how* a house works — templates,
  room briefs, mill specs, ask-first lists. It never sees a household's board,
  balances, bills, or names.
- **Stateless by design.** No sessions, no database, no per-user storage.
  Every request is independent (`sessionIdGenerator: undefined`). If this
  server vanished tomorrow, no household would lose anything — their house
  lives with their own Muse agent.
- **Advisory governance.** `codex_check` cites the 22-term consumer codex and
  returns PASS / ADVISORY / FLAG. It is not a gate; the host agent decides.

## Tools (11) · Rooms (9)

Access: **read** | **write** | **sensitive-write**. Nine rooms in `data/rooms.json`: art, bling, coach, dev, game, health, home, money, travel.

| Tool | Access | Input | What it returns |
|------|--------|-------|-----------------|
| `suggest_utilities` | read | profile, goal | Ranked Muse connectors (utilities) to turn on, each with a one-line why. Catalog: `data/utilities-catalog.json`. |
| `suggest_steps` | read | goal, utilities[] | Ordered operating plan the host executes. The tool only returns the plan. |
| `list_rooms` | read | — | The nine room blueprints with one-line descriptions. |
| `get_room_brief` | read | room | Full blueprint: purpose, connectors, onboarding fills, mill jobs + specs, board-card templates, ask-first list, side-chat seed brief. |
| `get_house_template` | read | owner_name?, timezone? | Starter `HOUSE.md` + `OP-PROC.md` with `{{TOKENS}}` filled where given; remaining tokens listed. |
| `stamp_rooms` | read | rooms?, owner_name? | Executable room-creation protocol for the host. Returns the plan; does not create chats itself. |
| `codex_check` | read | action | PASS / ADVISORY / FLAG against the consumer codex. Advisory only — not a gate. |
| `send_feedback` | sensitive-write | kind, room, summary, details | Relays user-confirmed feedback to the team inbox (durable offsite email). Rate-limited; nothing stored. |
| `get_feedback_form` | read | — | Feedback form schema for consistent host presentation. |
| `check_room_updates` | read | rooms{} | Diff recorded room versions vs live blueprints; patch or re-stamp path. |
| `install_skill` | write | skill_id, session_id | Purchased skill files + host write instructions. Entitlement-gated: Stripe must confirm the Checkout session is paid and its Bling item sells that skill, else refusal and no files. Never moves money. |

## Run locally

```bash
npm ci            # clean install
npm start         # builds data/ from sources, serves on :3000
```

- `GET /health` → `{ status: "ok", ... }`
- `POST /mcp` → MCP Streamable HTTP endpoint (stateless)

Data is bundled at build/start by `scripts/build-data.mjs` from the
read-only `~/workspace/muse-foundry` sources (rooms, mill specs, house
templates, codex). Owner-specific values are stripped to `{{TOKENS}}` and a
PII audit fails the build if anything leaks.

## Deploy (Railway, from GitHub — never `railway up`)

1. `git init && git add -A && git commit -m "muse-house v0.1.0"` (in this dir)
2. Create the repo on GitHub, then:
   ```bash
   git remote add origin git@github.com:<org>/muse-house.git
   git branch -M main
   git push -u origin main
   ```
3. In Railway: **New Project → Deploy from GitHub repo** → select
   `muse-house`. Railway reads `railway.json` (Nixpacks, Node 20,
   `node src/server.mjs`, health check on `/health`).
4. Note the public URL Railway assigns — that is the connector's MCP endpoint
   (`POST https://<app>.up.railway.app/mcp`).

## Auth (honesty)

- **Public blueprint MCP tier:** no key. Blueprints need no login or connector OAuth.
- **Website/API tokens only (not MCP):**
  - `GET /api/bling/orders` requires `BLING_API_TOKEN`
  - `POST /api/bling/dev/grant` requires `BLING_DEV_TOKEN`

## Bling money posture

Bling is the website shop (`/bling.html`) using **Stripe Checkout only**. Cards
stay on Stripe. Bling is **not** an MCP money-movement tool — no transfers,
trades, or payments via MCP. No Meta money tools.

## Future work

- **More rooms.** Room blueprints are data (`data/rooms.json` via
  `scripts/build-data.mjs`) — add rooms without touching the server.
