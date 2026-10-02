/**
 * tools.mjs — the 6 Amuse House Foundry tools.
 * Stateless: loads bundled data/ at startup, keeps nothing per user.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const load = (f) => JSON.parse(readFileSync(join(DATA, f), "utf8"));

const catalog = load("utilities-catalog.json").catalog;
const rooms = load("rooms.json").rooms;
const mill = load("mill.json").specs;
const houseTemplate = load("house-template.json");
const codex = load("codex.json").terms;

const text = (s) => ({ content: [{ type: "text", text: s }] });

// ---------------------------------------------------------------- suggest_utilities
function scoreUtility(u, haystack) {
  let hits = 0;
  for (const kw of u.keywords) {
    if (haystack.includes(kw)) hits++;
  }
  return hits;
}

export function suggest_utilities({ profile = "", goal = "" }) {
  const haystack = `${profile} ${goal}`.toLowerCase();
  const ranked = catalog
    .map((u) => ({ id: u.id, name: u.name, why: u.why, matches: scoreUtility(u, haystack) }))
    .sort((a, b) => b.matches - a.matches || a.name.localeCompare(b.name));
  const lines = ranked.map(
    (r, i) => `${i + 1}. **${r.name}** (\`${r.id}\`) — ${r.why}${r.matches ? ` [${r.matches} keyword match${r.matches > 1 ? "es" : ""}]` : " [no direct keyword match — general utility]"}`
  );
  return text(
    `Suggested utilities for this household, ranked by fit to the profile and goal:\n\n${lines.join("\n")}\n\nTurn these on in the Muse app's connector settings (move-in checklist). The host agent then references them by id in suggest_steps.`
  );
}

// ---------------------------------------------------------------- suggest_steps
const UTILITY_STEPS = {
  plaid: "Connect Plaid (read-only). Set a low-balance floor per account and name the account nicknames the board will use — never account numbers.",
  gmail: "Grant inbox access. Run a first bill-watch sweep over the last 30 days to seed known vendors, amounts, and due rhythms.",
  "google-calendar": "Share the calendar so the morning briefing sees today's appointments and the mill can compute day-of timing.",
  quickbooks: "Connect QuickBooks. Pull the last 90 days of income/expenses so the weekly cash plan starts from real numbers.",
  stripe: "Connect Stripe. Map payouts to the accounts they land in so revenue shows up in the cash position.",
  slack: "Connect Slack. Choose one channel for house nudges that shouldn't wait for the briefing.",
  notion: "Connect Notion. Point the house at the docs it should treat as reference (or start fresh).",
  asana: "Connect Asana. The board mirrors open cards here so nothing lives in two places.",
};

export function suggest_steps({ goal = "", utilities = [] }) {
  const known = utilities.filter((u) => UTILITY_STEPS[u]);
  const unknown = utilities.filter((u) => !UTILITY_STEPS[u]);
  const steps = [];
  steps.push(`1. **Turn on utilities.** In the Muse app's connector settings, enable: ${known.length ? known.map((u) => `\`${u}\``).join(", ") : "(none specified — run suggest_utilities first)"}.`);
  if (unknown.length) steps.push(`   Note: unknown utility id(s) ignored: ${unknown.map((u) => `\`${u}\``).join(", ")}.`);
  steps.push(`2. **Onboarding answers.** Owner name, timezone, spend ask-first threshold, and pay cadence — these fill the house template tokens.`);
  for (const u of known) steps.push(`3. **${u}:** ${UTILITY_STEPS[u]}`);
  const n = steps.length;
  steps.push(`${n + 1}. **Mint the house.** Call get_house_template with the onboarding answers; the host writes house/HOUSE.md and house/OP-PROC.md.`);
  steps.push(`${n + 2}. **Stamp rooms.** Call list_rooms, then get_room_brief for each room the household wants; the host opens one side chat per room and seeds it with the brief.`);
  steps.push(`${n + 3}. **Start the mill.** Create the cron jobs (morning briefing, bill watch, evening wrap) and hooks (bill-arrived, low-balance) from the room briefs' mill specs. New hooks start disabled — dry-run before enabling.`);
  steps.push(`${n + 4}. **First briefing.** Run the morning-briefing prompt once by hand to prove every source reads, then let the schedule take over.`);
  return text(`Operating plan for: ${goal || "(no goal given)"}\n\n${steps.join("\n")}\n\nThe host agent executes these in order. Nothing here spends, sends, or shares — each ask-first action still needs the human.`);
}

// ---------------------------------------------------------------- list_rooms
export function list_rooms() {
  const lines = rooms.map((r) => `- **${r.name}** (\`${r.id}\`) — ${r.description}`);
  return text(`House rooms — one specialist side chat each. Call get_room_brief with the room id for the full blueprint.\n\n${lines.join("\n")}`);
}

// ---------------------------------------------------------------- get_room_brief
export function get_room_brief({ room = "" }) {
  const r = rooms.find((x) => x.id === room.toLowerCase().trim());
  if (!r) {
    return text(`Unknown room \`${room}\`. Available: ${rooms.map((x) => `\`${x.id}\``).join(", ")}. Call list_rooms for descriptions.`);
  }
  const s = r.sections;
  const specTexts = r.mill_specs
    .map((slug) => mill[slug])
    .filter(Boolean)
    .map((m) => {
      const body = Object.entries(m.sections)
        .map(([h, b]) => `### ${h}\n${b}`)
        .join("\n\n");
      return `## Mill spec: ${m.title} (\`${m.slug}\`, ${m.kind})\n${body}`;
    })
    .join("\n\n---\n\n");
  return text(
    `# Room brief: ${r.name}\n\n## Purpose\n${s.purpose}\n\n## Connectors needed\n${s.connectors_needed}\n\n## Onboarding fills\n${s.onboarding_fills}\n\n## Mill jobs\n${s.mill_jobs}\n\n## Board cards it files\n${s.board_cards_it_files}\n\n## Ask-first list\n${s.ask_first_list}\n\n## Seed brief (host gives this to the side chat, filling {{OWNER_NAME}})\n${s.seed_brief}\n\n---\n\n${specTexts}\n\n---\n\n**How the host stamps this room:** \`chat.create\` (fresh side chat) → paste the seed brief with {{OWNER_NAME}} filled → file the board-cards template → create the cron jobs and hooks from the mill specs above.`
  );
}

// ---------------------------------------------------------------- get_house_template
export function get_house_template({ owner_name = "", timezone = "" } = {}) {
  const fill = (md) =>
    md
      .replace(/\{\{OWNER_NAME\}\}/g, owner_name || "{{OWNER_NAME}}")
      .replace(/\{\{TIMEZONE\}\}/g, timezone || "{{TIMEZONE}}");
  const house_md = fill(houseTemplate.house_md);
  const op_proc_md = fill(houseTemplate.op_proc_md);
  const remaining = [...new Set((house_md + op_proc_md).match(/\{\{[A-Z_]+\}\}/g) || [])];
  return text(
    `# Starter house template\n\nTokens remaining to fill: ${remaining.length ? remaining.join(", ") : "none — fully personalized"}\n\n---\n\n## house/HOUSE.md\n\n${house_md}\n\n---\n\n## house/OP-PROC.md\n\n${op_proc_md}\n\n---\n\n**Host:** write these to the household's house/ directory, filling any remaining tokens from onboarding. The live board (WAVEBOARD.md) is the household's own — this service never sees it.`
  );
}

// ---------------------------------------------------------------- codex_check
const CODEX_RULES = [
  { match: ["send", "email", "e-mail", "message", "text", "sms", "post", "publish", "share", "dm"], terms: ["M1"] },
  { match: ["pay", "payment", "bill", "buy", "purchase", "spend", "charge", "money", "subscribe"], terms: ["M1"] },
  { match: ["delete", "remove", "erase", "unpair", "wipe", "revoke"], terms: ["M1", 12] },
  { match: ["password", "token", "secret", "api key", "credential", "otp", "one-time code", "ssn"], terms: [29] },
  { match: ["account number", "routing number", "credit card number"], terms: ["M2", 29] },
  { match: ["always allow", "standing approval", "standing default", "auto-pay", "autopay"], terms: [12, "M1"] },
  { match: ["live", "current", "real-time", "up to date", "verify", "check"], terms: ["M3"] },
  { match: ["new skill", "new tool", "new integration", "new connector", "new mcp", "new surface"], terms: [69] },
  { match: ["subagent", "delegate", "spawn", "side chat", "parallel"], terms: [52, 59] },
  { match: ["retry", "workaround", "bypass", "again and again", "loop"], terms: [8] },
  { match: ["public", "publicly", "tweet", "listing"], terms: ["M1", 29] },
];
const FLAG_TERMS = new Set(["M1", 12, 29, 8]);

export function codex_check({ action = "" }) {
  const lower = action.toLowerCase();
  const hitNums = new Set();
  for (const rule of CODEX_RULES) {
    if (rule.match.some((k) => lower.includes(k))) rule.terms.forEach((t) => hitNums.add(t));
  }
  const matched = [...hitNums]
    .map((n) => codex.find((t) => String(t.number) === String(n)))
    .filter(Boolean);
  const flagged = matched.some((t) => FLAG_TERMS.has(String(t.number)));
  const cited = matched
    .map((t) => `- [${t.number}] ${t.title}: ${t.description}`)
    .join("\n");
  const verdict = matched.length === 0
    ? "PASS — no consumer-codex terms triggered by this wording. Host judgment still applies; vague actions should be clarified before executing."
    : `${flagged ? "FLAG" : "ADVISORY"} — matched ${matched.length} term(s):\n${cited}\n\nThis is advisory, not a gate. The host agent decides; when in doubt, ask the human.`;
  return text(`codex_check for: "${action}"\n\n${verdict}`);
}

export const TOOL_DEFS = [
  {
    name: "suggest_utilities",
    description: "Rank the Muse connectors (utilities) a household should turn on, given a profile and goal. Returns the curated catalog ranked by keyword fit, each with a one-line why.",
    inputSchema: {
      type: "object",
      properties: {
        profile: { type: "string", description: "Who the household is (e.g. 'freelancer, rents, paid biweekly')" },
        goal: { type: "string", description: "What they want the house to do (e.g. 'never miss a bill')" },
      },
    },
    fn: suggest_utilities,
  },
  {
    name: "suggest_steps",
    description: "Build an ordered operating plan for a goal, given the utilities already chosen. Concrete steps the host agent executes: onboarding, per-utility setup, house minting, room stamping, mill startup.",
    inputSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: "The household goal" },
        utilities: { type: "array", items: { type: "string" }, description: "Utility ids from suggest_utilities (e.g. ['plaid','gmail'])" },
      },
    },
    fn: suggest_steps,
  },
  {
    name: "list_rooms",
    description: "List the house room blueprints (money, travel, home, health) with one-line descriptions.",
    inputSchema: { type: "object", properties: {} },
    fn: list_rooms,
  },
  {
    name: "get_room_brief",
    description: "Full blueprint for one room: purpose, connectors, onboarding fills, mill jobs with full specs, board-card templates, ask-first list, and the side-chat seed brief. The host uses this to stamp the room's side chat.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Room id: money | travel | home | health" },
      },
      required: ["room"],
    },
    fn: get_room_brief,
  },
  {
    name: "get_house_template",
    description: "Starter HOUSE.md and OP-PROC.md for a new household, with {{TOKENS}} filled where owner_name/timezone are given. Remaining tokens are listed so the host can finish personalization.",
    inputSchema: {
      type: "object",
      properties: {
        owner_name: { type: "string", description: "Owner's first name (optional)" },
        timezone: { type: "string", description: "IANA timezone (optional)" },
      },
    },
    fn: get_house_template,
  },
  {
    name: "codex_check",
    description: "Advisory check of a planned action against the 22-term consumer codex. Returns PASS, ADVISORY, or FLAG with matched terms cited. Not a hard gate — the host agent decides.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "Plain-language description of the planned action" },
      },
      required: ["action"],
    },
    fn: codex_check,
  },
];
