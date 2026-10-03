#!/usr/bin/env node
/**
 * build-data.mjs — bundles self-contained data/ from the read-only
 * ~/workspace/muse-foundry sources. Strips owner-specific values to
 * {{TOKENS}}. Safe to re-run; output is deterministic.
 *
 * Sources (READ-ONLY, never modified):
 *   ~/workspace/muse-foundry/rooms/*.md
 *   ~/workspace/muse-foundry/mill/cron-jobs/*.md
 *   ~/workspace/muse-foundry/mill/hooks/*.md
 *   ~/workspace/muse-foundry/house/HOUSE.md
 *   ~/workspace/muse-foundry/house/OP-PROC.md
 *   ~/workspace/muse-foundry/codex-muse.json
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SRC = join(process.env.HOME || "~", "workspace", "muse-foundry");
const DATA = join(ROOT, "data");

// If the source tree isn't present (e.g. Railway build), keep the committed
// data/ as-is and exit cleanly instead of failing the deploy.
if (!existsSync(SRC)) {
  console.log("build-data: no source tree at", SRC, "— keeping committed data/, skipping.");
  process.exit(0);
}

const read = (p) => readFileSync(p, "utf8");

/** Split markdown into { intro, sections: {heading: body} } on ## headings. */
function parseSections(md) {
  const lines = md.split("\n");
  let title = "";
  const sections = {};
  let current = null;
  const intro = [];
  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+)/);
    const h2 = line.match(/^##\s+(.+)/);
    if (h1 && !title) { title = h1[1].trim(); continue; }
    if (h2) { current = h2[1].trim().toLowerCase().replace(/[^a-z0-9]+/g, "_"); sections[current] = []; continue; }
    if (current) sections[current].push(line);
    else if (!h1) intro.push(line);
  }
  const out = {};
  for (const [k, v] of Object.entries(sections)) out[k] = v.join("\n").trim();
  return { title, intro: intro.join("\n").trim(), sections: out };
}

const MILL_SLUGS = [
  ["morning-briefing", ["morning briefing", "morning cash position"]],
  ["bill-watch", ["bill watch"]],
  ["evening-wrap", ["evening wrap"]],
  ["bill-arrived", ["bill-arrived"]],
  ["low-balance", ["low-balance"]],
  ["deploy-watch", ["deploy watch"]],
  ["lab-result-watch", ["lab result watch"]],
  ["price-watch", ["price watch"]],
];

function millSpecsFor(millJobsText = "") {
  const lower = millJobsText.toLowerCase();
  // morning briefing + evening wrap are house-generic: every room gets them.
  const hits = ["morning-briefing", "evening-wrap"];
  for (const [slug, keys] of MILL_SLUGS) {
    if (hits.includes(slug)) continue;
    if (keys.some((k) => lower.includes(k))) hits.push(slug);
  }
  return hits;
}

// ---------- rooms ----------
const rooms = [];
for (const file of readdirSync(join(SRC, "rooms")).filter((f) => f.endsWith(".md")).sort()) {
  const md = read(join(SRC, "rooms", file));
  const { title, sections } = parseSections(md);
  const id = file.replace(/-room\.md$/, "");
  const purpose = sections.purpose || "";
  const oneLiner = purpose.split("\n").map((l) => l.trim()).filter(Boolean)[0] || title;
  rooms.push({
    id,
    name: title,
    description: oneLiner,
    version: (sections.version || "1").trim().split("\n")[0].trim(),
    sections: {
      purpose,
      connectors_needed: sections.connectors_needed || "",
      onboarding_fills: sections.onboarding_fills || "",
      mill_jobs: sections.mill_jobs || "",
      board_cards_it_files: sections.board_cards_it_files || "",
      ask_first_list: sections.ask_first_list || "",
      seed_brief: sections.seed_brief || "",
      setup_flow: sections.setup_flow || "",
      skills: sections.skills || "",
      changelog: sections.changelog || "",
    },
    mill_specs: millSpecsFor(sections.mill_jobs || ""),
  });
}

// ---------- mill specs ----------
const mill = {};
const millDirs = [["cron-jobs", "cron"], ["hooks", "sweep"]];
for (const [dir, kind] of millDirs) {
  for (const file of readdirSync(join(SRC, "mill", dir)).filter((f) => f.endsWith(".md")).sort()) {
    const slug = file.replace(/\.md$/, "");
    const { title, sections } = parseSections(read(join(SRC, "mill", dir, file)));
    mill[slug] = { slug, kind, title, sections };
  }
}

// ---------- house templates (PII-stripped) ----------
// Owner identity comes from the OWNER_NAME env var at build time, so this
// public script never names anyone. Run: OWNER_NAME="<name>" node scripts/build-data.mjs
const OWNER = process.env.OWNER_NAME || "";
const escOwner = OWNER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function stripOwner(md) {
  let out = md;
  if (OWNER) {
    out = out
      .replace(new RegExp(`without ${escOwner}'s explicit go`, "g"), "without {{OWNER_NAME}}'s explicit go")
      .replace(new RegExp(`sharing ${escOwner}'s info publicly`, "g"), "sharing {{OWNER_NAME}}'s info publicly")
      .replace(new RegExp(`needs ${escOwner} now`, "g"), "needs {{OWNER_NAME}} now")
      .replace(new RegExp(`need(?:s|ing)? ${escOwner}\\b`, "g"), (m) => m.replace(OWNER, "{{OWNER_NAME}}"))
      .replace(new RegExp(`\\b${escOwner}\\b`, "g"), "{{OWNER_NAME}}");
  }
  return out
    .replace(/standing approval granted 2026-10-01/g, "standing approval (revocable any time)")
    // Generalize the finance-manager mandate (was written for weekly pay)
    .replace(
      /Maintain the budget:\s*\n?\s*weekly cash math across pay weeks, carry balances across month boundaries,\s*\n?\s*track surplus\/deficit\./,
      "Maintain the household budget on the human's pay cadence: income per period vs bills due, carry balances across periods, track surplus/deficit."
    );
}
const houseTemplate = {
  house_md: stripOwner(read(join(SRC, "house", "HOUSE.md"))),
  op_proc_md: stripOwner(read(join(SRC, "house", "OP-PROC.md"))),
  tokens: ["{{OWNER_NAME}}", "{{TIMEZONE}}", "{{SPEND_THRESHOLD}}"],
};

// ---------- codex (verbatim copy) ----------
const codex = JSON.parse(read(join(SRC, "codex-muse.json")));

// ---------- rename normalization: Amuse House -> Muse House ----------
const deAmuse = (s) =>
  typeof s === "string"
    ? s.replace(/amuse-house-codex/g, "muse-house-codex").replace(/`amuse-/g, "`muse-house-")
    : s;
const deAmuseDeep = (v) => JSON.parse(deAmuse(JSON.stringify(v)));
const roomsOut = deAmuseDeep(rooms);
const millOut = deAmuseDeep(mill);
const houseTemplateOut = deAmuseDeep(houseTemplate);
const codexOut = deAmuseDeep(codex);

// ---------- write ----------
mkdirSync(DATA, { recursive: true });
writeFileSync(join(DATA, "rooms.json"), JSON.stringify({ version: "0.1.0", rooms: roomsOut }, null, 2) + "\n");
writeFileSync(join(DATA, "mill.json"), JSON.stringify({ version: "0.1.0", specs: millOut }, null, 2) + "\n");
writeFileSync(join(DATA, "house-template.json"), JSON.stringify({ version: "0.1.0", ...houseTemplateOut }, null, 2) + "\n");
writeFileSync(join(DATA, "codex.json"), JSON.stringify(codexOut, null, 2) + "\n");

// ---------- PII audit: fail the build if owner data leaked ----------
const bundled = JSON.stringify({ rooms, mill, houseTemplate });
const leaks = [];
const auditPats = [/\$\s?\d[\d,]*/, /0xray-suit/, /muse-foundry/];
if (OWNER) auditPats.push(new RegExp(`\\b${escOwner}\\b`, "i"));
for (const pat of auditPats) {
  if (pat.test(bundled)) leaks.push(String(pat));
}
if (leaks.length) {
  console.error("PII AUDIT FAILED — leaked patterns:", leaks.join(", "));
  process.exit(1);
}
console.log(`build-data OK: ${rooms.length} rooms, ${Object.keys(mill).length} mill specs, house template, codex (${codex.terms.length} terms). PII audit clean.`);
