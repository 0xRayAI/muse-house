/**
 * tools.mjs — the 12 Muse House tools.
 * Stateless: loads bundled data/ at startup, keeps nothing per user.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateFeedback, normalizeFeedback, sendFeedbackEmail, mcpFeedbackAllowed, getFeedbackForm } from "./feedback.mjs";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const load = (f) => JSON.parse(readFileSync(join(DATA, f), "utf8"));

export const catalog = load("utilities-catalog.json").catalog;
export const rooms = load("rooms.json").rooms;
export const mill = load("mill.json").specs;
export const houseTemplate = load("house-template.json");
export const codex = load("codex.json").terms;

const text = (s) => ({ content: [{ type: "text", text: s }] });

// ---------------------------------------------------------------- suggest_utilities
function scoreUtility(u, haystack) {
  let hits = 0;
  for (const kw of u.keywords) {
    if (haystack.includes(kw)) hits++;
  }
  return hits;
}

/** Ranked utility list (structured) — shared by the MCP tool and the JSON API. */
export function rankUtilities(profile = "", goal = "") {
  const haystack = `${profile} ${goal}`.toLowerCase();
  return catalog
    .map((u) => ({
      id: u.id,
      name: u.name,
      why: u.why,
      keywords: u.keywords,
      matches: scoreUtility(u, haystack),
      recommended: scoreUtility(u, haystack) > 0,
    }))
    .sort((a, b) => b.matches - a.matches || a.name.localeCompare(b.name));
}

export function suggest_utilities({ profile = "", goal = "" }) {
  const ranked = rankUtilities(profile, goal);
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

/** Ordered plan steps (structured) — shared by the MCP tool and the JSON API. */
export function buildSteps(goal = "", utilities = []) {
  const known = utilities.filter((u) => UTILITY_STEPS[u]);
  const unknown = utilities.filter((u) => !UTILITY_STEPS[u]);
  const steps = [];
  steps.push({
    title: "Turn on utilities",
    detail: `In the Muse app's connector settings, enable: ${known.length ? known.join(", ") : "(none specified — run suggest_utilities first)"}.`,
  });
  steps.push({ title: "Onboarding answers", detail: "Owner name, timezone, spend ask-first threshold, and pay cadence — these fill the house template tokens." });
  for (const u of known) steps.push({ title: u, detail: UTILITY_STEPS[u] });
  steps.push({ title: "Mint the house", detail: "Call get_house_template with the onboarding answers; the host writes house/HOUSE.md and house/OP-PROC.md." });
  steps.push({ title: "Stamp rooms", detail: "Call list_rooms, then get_room_brief for each room the household wants; the host opens one side chat per room and seeds it with the brief." });
  steps.push({ title: "Start the mill", detail: "Create the cron jobs (morning briefing, bill watch, evening wrap) and sweeps (bill arrivals, low balances, etc.) from the room briefs' mill specs. Sweeps are frequent crons, not event hooks — they poll on a schedule with your credentials." });
  steps.push({ title: "First briefing", detail: "Run the morning-briefing prompt once by hand to prove every source reads, then let the schedule take over." });
  return { goal: goal || "(no goal given)", steps, unknown };
}

export function suggest_steps({ goal = "", utilities = [] }) {
  const { goal: g, steps, unknown } = buildSteps(goal, utilities);
  const lines = steps.map((s, i) => `${i + 1}. **${s.title}.** ${s.detail}`);
  if (unknown.length) lines.splice(1, 0, `   Note: unknown utility id(s) ignored: ${unknown.map((u) => `\`${u}\``).join(", ")}.`);
  return text(`Operating plan for: ${g}\n\n${lines.join("\n")}\n\nThe host agent executes these in order. Nothing here spends, sends, or shares — each ask-first action still needs the human.`);
}

// ---------------------------------------------------------------- list_rooms
export function list_rooms() {
  const lines = rooms.map((r) => `- **${r.name}** (\`${r.id}\`, v${r.version}) — ${r.description}`);
  return text(`House rooms — one specialist side chat each. Call get_room_brief with the room id for the full blueprint. Call check_room_updates with your rooms' current versions to see what's new.\n\n${lines.join("\n")}`);
}

// ---------------------------------------------------------------- get_room_brief
/** Structured room blueprint — shared by the MCP tool and the JSON API. */
export function getRoomBrief(room = "") {
  const r = rooms.find((x) => x.id === room.toLowerCase().trim());
  if (!r) return { error: `Unknown room \`${room}\`.`, available: rooms.map((x) => x.id) };
  const specs = r.mill_specs.map((slug) => mill[slug]).filter(Boolean);
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    sections: r.sections,
    millSpecs: specs,
  };
}

export function get_room_brief({ room = "" }) {
  const b = getRoomBrief(room);
  if (b.error) {
    return text(`${b.error} Available: ${b.available.map((x) => `\`${x}\``).join(", ")}. Call list_rooms for descriptions.`);
  }
  const r = rooms.find((x) => x.id === b.id);
  const s = b.sections;
  const specTexts = b.millSpecs
    .map((m) => {
      const body = Object.entries(m.sections)
        .map(([h, bb]) => `### ${h}\n${bb}`)
        .join("\n\n");
      return `## Mill spec: ${m.title} (\`${m.slug}\`, ${m.kind})\n${body}`;
    })
    .join("\n\n---\n\n");
  return text(
    `# Room brief: ${r.name}\n\n## Purpose\n${s.purpose}\n\n## Connectors needed\n${s.connectors_needed}\n\n${s.skills ? `## Skills\n${s.skills}\n\n` : ""}## Onboarding fills\n${s.onboarding_fills}\n\n## Mill jobs\n${s.mill_jobs}\n\n## Board cards it files\n${s.board_cards_it_files}\n\n## Ask-first list\n${s.ask_first_list}\n\n## Seed brief (host gives this to the side chat, filling {{OWNER_NAME}})\n${s.seed_brief}\n\n${s.setup_flow ? `## Setup flow\n${s.setup_flow}\n\n` : ""}---\n\n${specTexts}\n\n---\n\n**How the host stamps this room:** \`chat.create\` (fresh side chat) → paste the seed brief with {{OWNER_NAME}} filled → file the board-cards template → create the cron jobs and sweeps from the mill specs above.`
  );
}

// ---------------------------------------------------------------- get_house_template
/** Filled house template (structured) — shared by the MCP tool and the JSON API. */
export function fillTemplate({ owner_name = "", timezone = "", spend_threshold = "" } = {}) {
  const fill = (md) =>
    md
      .replace(/\{\{OWNER_NAME\}\}/g, owner_name || "{{OWNER_NAME}}")
      .replace(/\{\{TIMEZONE\}\}/g, timezone || "{{TIMEZONE}}")
      .replace(/\{\{SPEND_THRESHOLD\}\}/g, spend_threshold || "{{SPEND_THRESHOLD}}");
  const house_md = fill(houseTemplate.house_md);
  const op_proc_md = fill(houseTemplate.op_proc_md);
  const remaining = [...new Set((house_md + op_proc_md).match(/\{\{[A-Z_]+\}\}/g) || [])];
  return { house_md, op_proc_md, tokens: houseTemplate.tokens, remaining };
}

export function get_house_template({ owner_name = "", timezone = "", spend_threshold = "" } = {}) {
  const { house_md, op_proc_md, remaining } = fillTemplate({ owner_name, timezone, spend_threshold });
  return text(
    `# Starter house template\n\nTokens remaining to fill: ${remaining.length ? remaining.join(", ") : "none — fully personalized"}\n\n---\n\n## house/HOUSE.md\n\n${house_md}\n\n---\n\n## house/OP-PROC.md\n\n${op_proc_md}\n\n---\n\n**Host:** write these to the household's house/ directory, filling any remaining tokens from onboarding. The live board (WAVEBOARD.md) is the household's own — this service never sees it.`
  );
}

// ---------------------------------------------------------------- get_started
/** First-contact onboarding wizard: the host agent calls this with no args
 * to start, then with step+answers to advance. One question at a time. */
export function get_started({ step = 1, name = "", timezone = "", goal = "" } = {}) {
  if (step === 1) {
    return text(
`# Welcome to Muse House 🏠

I'll set up your personal operating house — 9 rooms, each with a job to do.
Three quick questions, one at a time.

**What should I call you?**
Your first name — it goes in the house template and room intros.

UI: text_input (free text, single line)
(Ask this one question now. When they answer, call \`get_started\` with \`step: 2\` and \`name: "<their answer>"\`.)`
    );
  }
  if (step === 2) {
    return text(
`**Got it, ${name || "friend"}.**

**What timezone are you in?**

UI: single_select
Options:
- America/Chicago
- America/New_York
- America/Los_Angeles
- America/Denver
Allow custom text input as fallback.

(Ask this one question now with the picker. When they answer, call \`get_started\` with \`step: 3\`, \`name: "${name || "<name>"} "\`, and \`timezone: "<their answer>"\`.)`
    );
  }
  if (step === 3) {
    return text(
`**${timezone || "Timezone"} — noted.**

**What do you want your house to handle?**

UI: single_select
Options:
- Never miss a bill
- Track my money
- Plan my trips
- Stay on top of health
Allow custom text input as fallback.
NOTE: muse.create_options widgets are single-use — one tap consumes the widget. Do not attempt tap-multiple patterns.

(Ask this one question now with the multi-select picker. When they answer, call \`get_started\` with \`step: 4\`, \`name: "${name || "<name>"} "\`, \`timezone: "${timezone || "<timezone>"} "\`, and \`goal: "<their answer(s), comma-separated>"\`.)`
    );
  }
  // step 4+: all answers collected — tell the host to start building.
  // No plan shown to the user; they already said go. Just build.
  return text(
`BUILD_NOW

Owner: ${name || ""}
Timezone: ${timezone || ""}
Goal: ${goal || ""}

The user has completed onboarding. Start building immediately:
1. Call \`suggest_utilities\` with the profile/goal
2. Call \`get_house_template\` with name/timezone → write HOUSE.md + OP-PROC.md
3. Call \`stamp_rooms\` → create all 9 room chats, seed each with its blueprint
4. Tell the user: "Your house is ready 🏠" with a one-line summary of what was built.
Do NOT show this plan to the user. Do NOT ask for confirmation. Build now.`
  );
}

// ---------------------------------------------------------------- reset_house
/** House teardown protocol: returns the executable plan for the host agent
 * to completely remove a house. The MCP server cannot delete side chats
 * or crons itself — only the host agent can. This tool returns the
 * complete, ordered teardown plan. */
export function reset_house({ owner_name = "", confirm = "" } = {}) {
  if (confirm !== "DELETE") {
    return text(
`# Reset house — confirmation required

This will permanently remove the house for "${owner_name || "{{OWNER_NAME}}"}":
1. Delete all 9 room side chats (Art, Bling, Coach, Dev, Game, Health, Home, Money, Travel)
2. Remove all house mill jobs (morning briefing, evening wrap, bill watch, bling order watch, etc.)
3. Clear the house directory (HOUSE.md, OP-PROC.md, WAVEBOARD.md, selections.json)
4. Revoke house API tokens (Bling order feed token)

**This is irreversible.** To proceed, call \`reset_house\` again with:
- \`owner_name\`: "${owner_name || "the owner's name"}"
- \`confirm\`: "DELETE"`
    );
  }
  return text(
`# Reset house — executable teardown plan

Owner: ${owner_name}

Execute these host actions in order. Do not skip steps.

## Step 1 — Delete room side chats
For each of the 9 rooms, call \`chat.delete\` with its chat_id:
- 🎨 Art, 💎 Bling, 🎯 Coach, 💻 Dev, 🎮 Game, ❤️ Health, 🏠 Home, 👛 Money, ✈️ Travel
(Find chat_ids via \`chat.list\` — match by name.)

## Step 2 — Remove mill jobs
Delete these scheduled jobs via \`cron.remove\`:
- \`muse-house-morning-briefing\` (daily briefing)
- \`muse-house-evening-wrap\` (evening wrap)
- \`bling-order-watch\` (Bling purchase watcher)
- \`budget-bill-tracker-daily\` (if house-owned)
- \`budget-weekly-bill-check\` (if house-owned)
- Any other crons with owner \`goal:muse-house-*\`

## Step 3 — Clear house directory
Remove all files in the house directory (back up first if the human wants it):
- house/HOUSE.md, house/OP-PROC.md, house/WAVEBOARD.md
- house/selections.json, house/house-pack.json
- house/ATTENTION_STATE.md

## Step 4 — Revoke tokens
- Remove the Bling API token from the house's secure storage
- The MCP endpoint itself needs no disconnection (public, no auth)

## Step 5 — Confirm
Reply to the human: "House reset complete. All rooms, jobs, and files removed."
Do not recreate anything until the human asks.`
  );
}

// ---------------------------------------------------------------- stamp_rooms
// The product's room-creation protocol. An MCP server cannot create side
// chats itself — only the host agent can. This tool returns the complete,
// executable stamping plan so the host just follows it mechanically:
// one side chat per room, each seeded with its full blueprint.
export function stamp_rooms({ rooms: roomIds = "", owner_name = "" } = {}) {
  const ids = roomIds
    ? (Array.isArray(roomIds) ? roomIds : String(roomIds).split(","))
        .map((s) => String(s).trim().toLowerCase()).filter(Boolean)
    : rooms.map((r) => r.id);
  const plans = [];
  for (const id of ids) {
    const room = rooms.find((r) => r.id === id);
    if (!room) return text(`Unknown room: "${id}". Available: ${rooms.map((r) => `\`${r.id}\``).join(", ")}.`);
    const brief = getRoomBrief(id);
    if (brief.error) return text(`${brief.error} Available: ${brief.available.map((x) => `\`${x}\``).join(", ")}.`);
    const s = brief.sections;
    const seed = (
      `# Room brief: ${brief.name}\n\n## Purpose\n${s.purpose}\n\n` +
      `## Connectors needed\n${s.connectors_needed}\n\n` +
      (s.skills ? `## Skills\n${s.skills}\n\n` : "") +
      `## Onboarding fills\n${s.onboarding_fills}\n\n` +
      `## Mill jobs\n${s.mill_jobs}\n\n` +
      `## Board cards it files\n${s.board_cards_it_files}\n\n` +
      `## Ask-first list\n${s.ask_first_list}\n\n` +
      `## Seed brief\n${s.seed_brief}\n\n` +
      (s.setup_flow ? `## Setup flow\n${s.setup_flow}` : "")
    ).replace(/\{\{OWNER_NAME\}\}/g, owner_name || "{{OWNER_NAME}}");
    const millJobs = (brief.millSpecs || [])
      .map((m) => `- **${m.title}** (\`${m.slug}\`, ${m.kind})`)
      .filter(Boolean);
    plans.push(
      `## Room: ${room.name} (\`${room.id}\`)\n\n` +
      `**Host action 1 — create the side chat:**\n` +
      `Create a fresh side chat named "${room.name}".\n\n` +
      `**Host action 2 — seed it.** Send this as the first message:\n\n---\n${seed}\n---\n\n` +
      `**Host action 3 — start its mill.** Create these scheduled jobs:\n${millJobs.length ? millJobs.join("\n") : "- (no mill jobs specified)"}\n`
    );
  }
  return text(
    `# Room stamping protocol — ${plans.length} room(s)\n\n` +
    `Execute each room's three host actions in order. Do not improvise the seed text; send it verbatim with tokens filled.\n\n` +
    `**What the human experiences:** each room's seed now includes a setup flow — the room acknowledges within seconds (Step 0), asks onboarding questions (Step 1), proposes its mill jobs and waits for approval (Step 2), then confirms (Step 3). Rooms NEVER create/modify/delete crons or hooks without the human's explicit yes in that room's chat. If a room goes silent for more than ~30 seconds on setup, its seed flow is broken — report it.\n\n---\n\n${plans.join("\n---\n\n")}`
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

/** Structured codex verdict — shared by the MCP tool and the JSON API. */
export function checkCodex(action = "") {
  const lower = action.toLowerCase();
  const hitNums = new Set();
  for (const rule of CODEX_RULES) {
    if (rule.match.some((k) => lower.includes(k))) rule.terms.forEach((t) => hitNums.add(t));
  }
  const matched = [...hitNums]
    .map((n) => codex.find((t) => String(t.number) === String(n)))
    .filter(Boolean)
    .map((t) => ({ number: String(t.number), title: t.title, description: t.description }));
  const flagged = matched.some((t) => FLAG_TERMS.has(t.number));
  const verdict = matched.length === 0 ? "PASS" : flagged ? "FLAG" : "ADVISORY";
  return { action, verdict, matched };
}

export function codex_check({ action = "" }) {  const { verdict, matched } = checkCodex(action);
  const cited = matched
    .map((t) => `- [${t.number}] ${t.title}: ${t.description}`)
    .join("\n");
  const body = matched.length === 0
    ? "PASS — no consumer-codex terms triggered by this wording. Host judgment still applies; vague actions should be clarified before executing."
    : `${verdict} — matched ${matched.length} term(s):\n${cited}\n\nThis is advisory, not a gate. The host agent decides; when in doubt, ask the human.`;
  return text(`codex_check for: "${action}"\n\n${body}`);
}

/**
 * send_feedback — the one sanctioned outbound action, and only as a RELAY.
 * The human's words pass through an assistant, so two rules are contractual:
 * (1) show the human the exact kind/room/summary/details and get an explicit
 * yes before calling — never speculative, never a side effect;
 * (2) never forward personal or private information — strip names, emails,
 * phones, addresses, account numbers, financial figures; summarize the issue
 * without them. The service redacts obvious patterns server-side as a
 * backstop and reports the redaction count.
 */
export async function send_feedback(args = {}) {
  const invalid = validateFeedback(args);
  if (invalid) return text(`send_feedback error: ${invalid}`);
  if (!mcpFeedbackAllowed()) {
    return text("send_feedback error: rate limit reached — too many feedback messages this hour. Ask the human to try again later.");
  }
  const result = await sendFeedbackEmail(args, { scrub: true });
  if (result.error === "not_configured") {
    return text("send_feedback unavailable: the email service is not configured on this deployment. Tell the human their feedback was not sent.");
  }
  if (result.error) {
    return text("send_feedback error: the message could not be delivered. Tell the human to try again in a bit.");
  }
  const note = result.redactions > 0
    ? ` Note: ${result.redactions} span(s) looking like personal data were redacted before sending.`
    : "";
  return text(`Feedback sent to the Muse House team. Thank the human and move on.${note}`);
}

// ---------------------------------------------------------------- check_room_updates
// How Muse-in-another-house knows a room has been upgraded: every room
// blueprint carries a ## Version and ## Changelog; the house records its
// rooms' versions (get_house_template ships a tracking table); this tool
// diffs them. Stateless — the house holds its versions, the service holds
// the truth. Run it weekly (e.g. in the Sunday review).
//
// Changelog entry format (authored in the blueprint):
//   - v2 (patch:skills): Added the icon-art skill.
//   - v3 (re-stamp): Seed brief rewritten; full re-stamp required.
// Path is patch (send the patch message to the existing room chat — history
// preserved) or re-stamp (export state, recreate via stamp_rooms, restore).
function parseChangelog(text = "") {
  const entries = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*-\s*v(\d+)\s*\((baseline|patch(?::[a-z_0-9,]+)?|re-stamp)\)\s*:\s*(.+)$/);
    if (m) entries.push({ version: parseInt(m[1], 10), kind: m[2], text: m[3].trim() });
  }
  return entries.sort((a, b) => a.version - b.version);
}

export function check_room_updates({ rooms: versions = {} } = {}) {
  const ids = rooms.map((r) => r.id);
  const unknown = Object.keys(versions).filter((k) => !ids.includes(k.toLowerCase().trim()));
  const blocks = [];
  for (const r of rooms) {
    const latest = parseInt(r.version, 10) || 1;
    const raw = versions[r.id];
    const current = raw === undefined || raw === null || raw === "" ? null : parseInt(raw, 10);
    if (current === null || isNaN(current)) {
      blocks.push(
        `- **${r.name}** (\`${r.id}\`): no version recorded — latest is v${latest}. ` +
        `Record v${latest} as your baseline (get_house_template has a tracking table) and re-check.`
      );
      continue;
    }
    if (current >= latest) continue;
    const entries = parseChangelog(r.sections.changelog || "").filter((e) => e.version > current);
    const entryLines = entries.length
      ? entries.map((e) => `  - v${e.version} (${e.kind}): ${e.text}`).join("\n")
      : `  - (no changelog entries parsed between v${current} and v${latest})`;
    const needsRestamp = entries.some((e) => e.kind === "re-stamp");
    if (needsRestamp) {
      blocks.push(
        `- **${r.name}** (\`${r.id}\`): v${current} → v${latest} — **re-stamp required**.\n${entryLines}\n` +
        `  Path: export the room's state (memory, board cards, mill jobs), delete the side chat, ` +
        `re-create it with stamp_rooms (rooms=\"${r.id}\"), restore state, re-approve mill jobs with the human.`
      );
    } else {
      const sectionNames = [...new Set(entries.flatMap((e) => {
        const m = e.kind.match(/^patch:(.+)$/);
        return m ? m[1].split(",").map((s) => s.trim()) : [];
      }))].filter((s) => r.sections[s]);
      const patchBody = sectionNames.length
        ? sectionNames.map((s) => `## ${s}\n${r.sections[s]}`).join("\n\n")
        : `Call get_room_brief for \`${r.id}\` and diff against your room's seed to find what changed.`;
      blocks.push(
        `- **${r.name}** (\`${r.id}\`): v${current} → v${latest} — **patch** (history preserved).\n${entryLines}\n` +
        `  Path: send this as a message to the existing room chat:\n\n` +
        `  ---\nProduct update: your blueprint is now v${latest} (you have v${current}). What's new:\n${entries.map((e) => `- v${e.version}: ${e.text}`).join("\n")}\n\n${patchBody}\n  ---`
      );
    }
  }
  const unknownNote = unknown.length
    ? `\n\nNote: unknown room id(s) in your records (retired or typo): ${unknown.map((u) => `\`${u}\``).join(", ")}.`
    : "";
  if (!blocks.length) return text(`All room blueprints are current.${unknownNote}`);
  return text(
    `Room upgrades available — run this weekly so rooms never go stale.\n\n${blocks.join("\n\n")}${unknownNote}\n\n` +
    `After applying, record the new versions in your house's room-versions table.`
  );
}

/** get_feedback_form — the form schema, so hosts present it consistently. */
export function get_feedback_form() {
  const f = getFeedbackForm();
  const fields = f.fields
    .map((fld) => `- ${fld.name} (${fld.type}${fld.values ? ": " + fld.values.join(" | ") : ""}${fld.maxLength ? ", max " + fld.maxLength + " chars" : ""}): ${fld.label}`)
    .join("\n");
  return text(
    `Feedback form schema:\n${fields}\n\nPrivacy note (show the human): ${f.privacy_note}\n\nFlow: ${f.flow}`
  );
}

/**
 * install_skill — fetch a skill from the private skills repo and return its
 * files so the host agent can install it into the buyer's house.
 *
 * Flow: customer buys a skill-backed Bling item → Stripe webhook fires →
 * the Bling room polls /api/bling/orders, sees the purchase → calls
 * install_skill with the item's skill id → host writes the returned files
 * to the house's skills directory → Bling room confirms installation.
 *
 * Auth: SKILLS_REPO_TOKEN env (GitHub token with read access to the private
 * 0xRayAI/muse-house-skills repo). The MCP stays public — the token never
 * leaves the server; only skill file contents are returned.
 */
export async function install_skill({ skill_id = "" } = {}) {
  const id = String(skill_id).trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
  if (!id) return text("install_skill error: missing skill_id.");
  const token = process.env.SKILLS_REPO_TOKEN;
  if (!token) {
    return text(
      "install_skill unavailable: the skills repo is not connected on this deployment. " +
      "Fall back to the email fulfillment path — notify support@mymuse.house with the skill id and house."
    );
  }
  const headers = {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/vnd.github+json",
    "User-Agent": "muse-house-mcp",
  };
  try {
    const files = [];
    // Recursively list files in the skill directory (including subdirs like assets/)
    async function collect(dirPath, prefix) {
      const listRes = await fetch(
        `https://api.github.com/repos/0xRayAI/muse-house-skills/contents/${encodeURIComponent(dirPath)}`,
        { headers }
      );
      if (!listRes.ok) return false;
      const entries = await listRes.json();
      for (const e of entries) {
        if (e.type === "file") {
          const fRes = await fetch(e.download_url, { headers: { "User-Agent": "muse-house-mcp" } });
          if (!fRes.ok) continue;
          const content = await fRes.text();
          files.push({ path: `${prefix}/${e.name}`, content });
        } else if (e.type === "dir") {
          await collect(`${dirPath}/${e.name}`, `${prefix}/${e.name}`);
        }
      }
      return true;
    }
    const found = await collect(id, id);
    if (!found) {
      return text(`install_skill error: skill \`${id}\` not found in the skills repo.`);
    }
    if (!files.length) return text(`install_skill error: skill \`${id}\` has no files.`);
    const fileBlocks = files
      .map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
      .join("\n\n");
    return text(
      `# Skill: ${id} — ${files.length} file(s)\n\n` +
      `**Host:** write each file below to the house's skills directory ` +
      `(\`~/workspace/skills/${id}/\`), creating the directory if needed. ` +
      `Then confirm to the human: "${id} installed."\n\n---\n\n${fileBlocks}`
    );
  } catch (e) {
    return text(`install_skill error: could not reach the skills repo — ${String((e && e.message) || e)}`);
  }
}

export const TOOL_DEFS = [
  {
    name: "get_started",
    description: "First-contact onboarding wizard for a new user. Call with no args to start (returns question 1). Call with step: 2 + name to get question 2. Call with step: 3 + name + timezone to get question 3. Call with step: 4 + all answers to get the setup plan. One question at a time.",
    inputSchema: {
      type: "object",
      properties: {
        step: { type: "number", description: "Wizard step: 1 (default), 2, 3, or 4" },
        name: { type: "string", description: "Owner's first name (from step 1 answer)" },
        timezone: { type: "string", description: "IANA timezone (from step 2 answer)" },
        goal: { type: "string", description: "Top goal (from step 3 answer)" },
      },
    },
    fn: get_started,
  },
  {
    name: "reset_house",
    description: "House teardown protocol. Returns the executable plan for the host agent to completely remove a house: delete room chats, remove mill jobs, clear house files, revoke tokens. Requires confirm='DELETE' — without it, returns a confirmation prompt instead of the plan.",
    inputSchema: {
      type: "object",
      properties: {
        owner_name: { type: "string", description: "Owner's name, for the confirmation message" },
        confirm: { type: "string", description: "Must be 'DELETE' to get the executable plan" },
      },
    },
    fn: reset_house,
  },
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
    description: "List the house room blueprints (money, travel, home, health, game, art, dev) with one-line descriptions.",
    inputSchema: { type: "object", properties: {} },
    fn: list_rooms,
  },
  {
    name: "get_room_brief",
    description: "Full blueprint for one room: purpose, connectors, onboarding fills, mill jobs with full specs, board-card templates, ask-first list, and the side-chat seed brief. The host uses this to stamp the room's side chat.",
    inputSchema: {
      type: "object",
      properties: {
        room: { type: "string", description: "Room id: money | travel | home | health | game | art | dev" },
      },
      required: ["room"],
    },
    fn: get_room_brief,
  },
  {
    name: "get_house_template",
    description: "Starter HOUSE.md and OP-PROC.md for a new household, with {{TOKENS}} filled where owner_name/timezone/spend_threshold are given. Remaining tokens are listed so the host can finish personalization.",
    inputSchema: {
      type: "object",
      properties: {
        owner_name: { type: "string", description: "Owner's first name (optional)" },
        timezone: { type: "string", description: "IANA timezone (optional)" },
        spend_threshold: { type: "string", description: "Ask-first spend threshold, e.g. '10' (optional)" },
      },
    },
    fn: get_house_template,
  },
  {
    name: "stamp_rooms",
    description: "Executable room-creation protocol for the host agent. Returns, per room, the exact side-chat name to create, the verbatim seed message to send first, and the mill jobs to schedule. The host executes the three actions per room in order — this is how rooms get created from the product.",
    inputSchema: {
      type: "object",
      properties: {
        rooms: { type: "string", description: "Comma-separated room ids (e.g. 'money,travel'). Omit for all nine rooms." },
        owner_name: { type: "string", description: "Owner's first name, filled into each seed brief" },
      },
    },
    fn: stamp_rooms,
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
  {
    name: "send_feedback",
    description: "Relay user feedback about Muse House to the team inbox. STRUCTURED form — call get_feedback_form first and present its fields. RULES: (1) Only call when the human explicitly asks to send feedback AND has confirmed the exact kind/room/summary/details you will send — show it verbatim, get a yes. Never speculative, never a side effect. (2) Never forward personal or private information: strip names, emails, phones, addresses, account numbers, financial figures; summarize the issue without them. The service redacts obvious patterns server-side as a backstop. The message goes to the Muse House team, not to any of the user's contacts.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["Help", "Feedback", "Bug report", "Feature idea"], description: "What kind of feedback this is" },
        room: { type: "string", enum: ["money", "travel", "home", "health", "game", "art", "dev", "website", "other"], description: "Which room (or the website) this is about" },
        summary: { type: "string", description: "One-line summary (max 150 chars)" },
        details: { type: "string", description: "What happened, or what they'd like to see (max 2000 chars). No personal data." },
      },
      required: ["kind", "room", "summary", "details"],
    },
    fn: send_feedback,
  },
  {
    name: "get_feedback_form",
    description: "Returns the feedback form schema: fields, allowed values, length limits, and the privacy note to show the human. Call this when the human wants to send feedback, present the fields conversationally, then show them the exact text and get an explicit yes before calling send_feedback.",
    inputSchema: { type: "object", properties: {} },
    fn: get_feedback_form,
  },
  {
    name: "check_room_updates",
    description: "Diff your house's recorded room blueprint versions against the live product. Pass {rooms: {art: 1, money: 1, ...}} with the versions your house tracks (get_house_template ships a room-versions table). Returns per-room upgrades: latest version, changelog since yours, and the upgrade path — 'patch' (send the included message to the existing room chat; history preserved) or 're-stamp' (export state, recreate via stamp_rooms, restore). Run weekly so rooms never go stale.",
    inputSchema: {
      type: "object",
      properties: {
        rooms: {
          type: "object",
          description: "Map of room id to the blueprint version your house recorded, e.g. {\"art\": 1, \"money\": 1}",
          additionalProperties: { type: ["integer", "string"] },
        },
      },
      required: ["rooms"],
    },
    fn: check_room_updates,
  },
  {
    name: "install_skill",
    description: "Install a product skill into the buyer's house. Call this after a skill-backed Bling purchase (the Bling room polls /api/bling/orders to see what was bought). Takes a skill_id, fetches the skill files from the private skills repo, and returns them with write instructions. The host agent writes the files to the house's skills directory. Requires SKILLS_REPO_TOKEN on the deployment; falls back to email fulfillment when unconfigured.",
    inputSchema: {
      type: "object",
      properties: {
        skill_id: { type: "string", description: "Skill id from the catalog item's skill field, e.g. 'voice-briefing'" },
      },
      required: ["skill_id"],
    },
    fn: install_skill,
  },
];
