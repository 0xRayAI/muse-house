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

## Tools

| Tool | Input | What it returns |
|------|-------|-----------------|
| `suggest_utilities` | profile, goal | Ranked Muse connectors (utilities) to turn on, each with a one-line why. Catalog: `data/utilities-catalog.json` (editable). |
| `suggest_steps` | goal, utilities[] | Ordered operating plan the host executes: onboarding → utility setup → house mint → room stamping → mill startup. |
| `list_rooms` | — | The 4 room blueprints (money, travel, home, health) with one-line descriptions. |
| `get_room_brief` | room | Full blueprint: purpose, connectors, onboarding fills, mill jobs + full mill specs, board-card templates, ask-first list, side-chat seed brief. |
| `get_house_template` | owner_name?, timezone? | Starter `HOUSE.md` + `OP-PROC.md` with `{{TOKENS}}` filled where given; remaining tokens listed. |
| `codex_check` | action | PASS / ADVISORY / FLAG against the consumer codex, matched terms cited. Advisory only. |

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

## Future work

- **Auth.** v0 is public, read-only blueprints — nothing sensitive to protect.
  When the foundry grows write-adjacent tools, add bearer auth and per-key
  rate limits.
- **Paid tiers.** The 0xray shop model (x402 pay endpoints) fits here when a
  tool costs something to run.
- **More rooms.** Room blueprints are data (`data/rooms.json` via
  `scripts/build-data.mjs`) — add rooms without touching the server.
