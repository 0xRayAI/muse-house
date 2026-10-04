/**
 * bling-apply.mjs — what an owned Bling item changes.
 * Pure aside from reading the voice-pack file. No storage, no cron, no chat client.
 * The order feed and the room brief are the existing paths that carry the result.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DAY_MS = 24 * 60 * 60 * 1000;
const DINER_DAYS = 30;

export const BLING = {
  neon: "neon-nights-icons",
  diner: "midnight-diner-theme",
  year: "year-in-review",
  voice: "briefing-voice-pack",
  mystery: "mystery-drop",
  seasonal: "seasonal-pack",
};

const EMOJI = {
  money: "👛",
  travel: "✈️",
  home: "🏠",
  health: "❤️",
  game: "🎮",
  art: "🎨",
  dev: "💻",
  coach: "🎯",
  bling: "💎",
};

/** The four images that exist in site/bling/delights/seasonal-pack/. Quarter is UTC. */
const SEASONAL_FILES = ["moon.png", "leaf.png", "candy.png", "ghost.png"];

const STICKERS = [
  { src: "/bling/delights/stickers/sparkle.gif", label: "sparkle" },
  { src: "/bling/delights/stickers/gem.gif", label: "gem" },
  { src: "/bling/delights/stickers/party.gif", label: "party" },
  { src: "/bling/delights/stickers/music.gif", label: "music" },
  { src: "/bling/delights/stickers/gift.gif", label: "gift" },
];

const VOICES_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "site", "bling", "delights", "voice-pack", "voices.json");

export function parseOwned(owned) {
  if (Array.isArray(owned)) return owned.map((s) => String(s).trim()).filter(Boolean);
  return String(owned || "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function neonIcon(roomId) {
  return `/bling/delights/neon-nights/${roomId}.png`;
}

export function seasonalIcon(date) {
  const q = Math.floor(date.getUTCMonth() / 3);
  const file = SEASONAL_FILES[q];
  return { quarter: q + 1, file, url: `/bling/delights/seasonal-pack/${file}` };
}

export function dinerState(purchasedAtMs, nowMs) {
  if (!Number.isFinite(purchasedAtMs)) return { active: false, reason: "needs_purchase_time" };
  const untilMs = purchasedAtMs + DINER_DAYS * DAY_MS;
  const active = nowMs < untilMs;
  return {
    active,
    purchased_at: new Date(purchasedAtMs).toISOString(),
    until: new Date(untilMs).toISOString(),
    days_left: active ? Math.ceil((untilMs - nowMs) / DAY_MS) : 0,
    personality: active
      ? `Midnight diner shift. Warm chrome, coffee at 2am. Open with "What'll it be, hon?" This shift ends ${new Date(untilMs).toISOString()} (30 days from the purchase). After that, speak as the regular Bling shopkeeper.`
      : null,
  };
}

export function yearBriefNote(rooms, year) {
  const lines = [
    `Board year ${year} count for the room brief. Not a sent chat message. Counted from the room blueprints this product ships (not a live house board).`,
    `${rooms.length} rooms.`,
  ];
  for (const r of rooms) {
    const raw = (r.sections && r.sections.board_cards_it_files) || "";
    const types = [...raw.matchAll(/\*\*([A-Z][A-Z0-9-]*)\*\*/g)].map((m) => m[1]);
    if (types.length) lines.push(`${r.name}: ${types.join(", ")}`);
  }
  return lines.join("\n");
}

export function mysterySticker(seed) {
  let h = 0;
  const s = String(seed || "drop");
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) + s.charCodeAt(i)) >>> 0;
  return STICKERS[h % STICKERS.length];
}

let voicesCache;
export function loadVoices() {
  if (!voicesCache) voicesCache = JSON.parse(readFileSync(VOICES_PATH, "utf8")).voices;
  return voicesCache;
}

export function briefingWithVoice(prompt, voice) {
  if (!voice) return { prompt, changed: false, voice_id: null, voice_name: null };
  return {
    prompt: `${String(prompt || "").trim()}\n\nVoice for this briefing (${voice.name}): ${voice.instruction}`,
    changed: true,
    voice_id: voice.id,
    voice_name: voice.name,
  };
}

export function applyBling({ rooms = [], briefingPrompt = "", owned, purchasedAt, now, voiceId, seed } = {}) {
  const set = new Set(parseOwned(owned));
  const nowMs = now instanceof Date ? now.getTime() : Number.isFinite(now) ? now : Date.now();
  const nowDate = new Date(nowMs);
  const seasonal = set.has(BLING.seasonal) ? seasonalIcon(nowDate) : null;
  const neon = set.has(BLING.neon);
  const view = rooms.map((r) => {
    let icon = EMOJI[r.id] || "◦";
    let icon_kind = "emoji";
    if (seasonal && EMOJI[r.id]) {
      icon = seasonal.url;
      icon_kind = "seasonal";
    } else if (neon && EMOJI[r.id]) {
      icon = neonIcon(r.id);
      icon_kind = "neon";
    }
    return { id: r.id, name: r.name, description: r.description, icon, icon_kind };
  });
  let diner = null;
  if (set.has(BLING.diner)) {
    const purchasedAtMs = purchasedAt instanceof Date ? purchasedAt.getTime() : Date.parse(purchasedAt);
    diner = dinerState(purchasedAtMs, nowMs);
  }
  const year_brief = set.has(BLING.year) ? yearBriefNote(rooms, nowDate.getUTCFullYear()) : null;
  const voices = set.has(BLING.voice) ? loadVoices() : [];
  let briefing = { prompt: briefingPrompt, changed: false, voice_id: null, voice_name: null, voices: voices.map((v) => ({ id: v.id, name: v.name })) };
  if (voices.length) {
    const chosen = voices.find((v) => v.id === voiceId) || voices.find((v) => v.id === "newscaster") || voices[0];
    briefing = { ...briefingWithVoice(briefingPrompt, chosen), voices: briefing.voices };
  }
  const sticker = set.has(BLING.mystery) ? mysterySticker(seed || BLING.mystery) : null;
  return { owned: [...set], rooms: view, seasonal, diner, year_brief, briefing, sticker };
}

/** One paid order → the apply payload the Bling room already reads off the order feed. */
export function applyForOrder({ itemId, createdSec, nowMs, rooms, briefingPrompt, seed }) {
  const purchasedAt = Number.isFinite(createdSec) ? new Date(createdSec * 1000).toISOString() : "";
  const room_apply = applyBling({
    rooms,
    briefingPrompt,
    owned: itemId ? [itemId] : [],
    purchasedAt,
    now: nowMs,
    voiceId: itemId === BLING.voice ? "newscaster" : "",
    seed: seed || itemId || "",
  });
  return { room_apply };
}

/** Room brief the host stamps. Copies mill specs before editing so the loaded JSON stays put. */
export function decorateRoomBrief(brief, opts = {}) {
  const owned = parseOwned(opts.owned);
  if (!owned.length || !brief || brief.error) return brief;
  const applied = applyBling({
    rooms: opts.rooms || [],
    briefingPrompt: opts.briefingPrompt || "",
    owned,
    purchasedAt: opts.purchased_at || opts.purchasedAt || "",
    now: opts.now,
    voiceId: opts.voice || "",
    seed: opts.seed || "",
  });
  const mine = applied.rooms.find((r) => r.id === brief.id);
  const copy = {
    ...brief,
    sections: { ...brief.sections },
    millSpecs: brief.millSpecs,
    bling_apply: {
      icon: mine ? mine.icon : null,
      icon_kind: mine ? mine.icon_kind : null,
      diner: brief.id === "bling" ? applied.diner : null,
      year_brief: brief.id === "bling" ? applied.year_brief : null,
      sticker: brief.id === "bling" ? applied.sticker : null,
      seasonal: applied.seasonal,
      briefing: applied.briefing.changed
        ? { voice_id: applied.briefing.voice_id, voice_name: applied.briefing.voice_name, prompt: applied.briefing.prompt }
        : null,
    },
  };
  if (applied.briefing.changed) {
    copy.millSpecs = (brief.millSpecs || []).map((m) => {
      if (m.slug !== "morning-briefing") return m;
      return {
        ...m,
        sections: { ...m.sections, prompt_template_for_the_cron_job_: applied.briefing.prompt },
      };
    });
  }
  if (brief.id === "bling" && applied.diner && applied.diner.personality) {
    copy.sections.personality = applied.diner.personality;
  }
  return copy;
}
