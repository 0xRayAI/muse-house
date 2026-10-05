import test from "node:test";
import assert from "node:assert/strict";
import { rooms, mill, getRoomBrief, get_room_brief } from "../src/tools.mjs";
import { applyBling, applyForOrder, dinerState, seasonalIcon, BLING } from "../src/bling-apply.mjs";

const prompt = mill["morning-briefing"].sections.prompt_template_for_the_cron_job_;
const bought = "2026-10-01T12:00:00.000Z";
const during = Date.parse("2026-10-04T12:00:00.000Z");
const after = Date.parse("2026-11-15T12:00:00.000Z");

test("neon icons replace emoji on every room", () => {
  const out = applyBling({ rooms, owned: BLING.neon, now: during });
  assert.equal(out.rooms.length, 9);
  for (const r of out.rooms) {
    assert.equal(r.icon, `/bling/delights/neon-nights/${r.id}.png`);
    assert.equal(r.icon_kind, "neon");
  }
});

test("diner personality is on for 30 days and then off", () => {
  const on = applyBling({ rooms, owned: BLING.diner, purchasedAt: bought, now: during });
  assert.equal(on.diner.active, true);
  assert.match(on.diner.personality, /What'll it be, hon/);
  assert.ok(on.diner.days_left > 0 && on.diner.days_left <= 30);
  const off = dinerState(Date.parse(bought), after);
  assert.equal(off.active, false);
  assert.equal(off.personality, null);
  const missing = applyBling({ rooms, owned: BLING.diner, now: during });
  assert.equal(missing.diner.active, false);
});

test("year note is a brief count, not a chat post", () => {
  const out = applyBling({ rooms, owned: BLING.year, now: during });
  assert.equal(out.chat_post, undefined);
  assert.equal(out.year_chat_post, undefined);
  assert.match(out.year_brief, /for the room brief/);
  assert.match(out.year_brief, /Not a sent chat message/);
  assert.match(out.year_brief, /not a live house board/);
  assert.match(out.year_brief, /BILL-DUE/);
  const order = applyForOrder({
    itemId: BLING.year,
    createdSec: Date.parse(bought) / 1000,
    nowMs: during,
    rooms,
    briefingPrompt: prompt,
    seed: "sess",
  });
  assert.equal(order.chat_post, undefined);
  assert.equal(order.room_apply.year_brief, out.year_brief);
  const text = get_room_brief({ room: "bling", owned: BLING.year }).content[0].text;
  assert.match(text, /Not posted to chat/);
  assert.equal(text.includes("Post this in the room chat"), false);
  assert.equal(text.includes("posts chat_post"), false);
  assert.equal(text.includes("post that"), false);
});

test("voice pack changes the morning briefing prompt", () => {
  const plain = applyBling({ rooms, briefingPrompt: prompt, now: during });
  assert.equal(plain.briefing.changed, false);
  assert.equal(plain.briefing.prompt, prompt);
  const owned = applyBling({ rooms, briefingPrompt: prompt, owned: BLING.voice, now: during });
  assert.equal(owned.briefing.voice_id, "newscaster");
  assert.match(owned.briefing.prompt, /Voice for this briefing \(Newscaster\)/);
  assert.notEqual(owned.briefing.prompt, prompt);
  const picked = applyBling({ rooms, briefingPrompt: prompt, owned: BLING.voice, voiceId: "bold", now: during });
  assert.equal(picked.briefing.voice_id, "bold");
  const brief = getRoomBrief("bling", { owned: BLING.voice, voice: "warm" });
  const spec = brief.millSpecs.find((m) => m.slug === "morning-briefing");
  assert.match(spec.sections.prompt_template_for_the_cron_job_, /Voice for this briefing \(Warm\)/);
  const untouched = mill["morning-briefing"].sections.prompt_template_for_the_cron_job_;
  assert.equal(untouched, prompt);
});

test("mystery drop puts a sticker on the apply result", () => {
  const out = applyBling({ rooms, owned: BLING.mystery, seed: "house-a", now: during });
  assert.match(out.sticker.src, /^\/bling\/delights\/stickers\/.+\.gif$/);
  const text = get_room_brief({ room: "bling", owned: BLING.mystery }).content[0].text;
  assert.match(text, /Sticker: \/bling\/delights\/stickers\//);
});

test("seasonal pack rotates the icon by quarter and beats neon", () => {
  const q1 = seasonalIcon(new Date("2026-02-01T00:00:00.000Z"));
  const q4 = seasonalIcon(new Date("2026-11-01T00:00:00.000Z"));
  assert.equal(q1.file, "moon.png");
  assert.equal(q4.file, "ghost.png");
  assert.notEqual(q1.url, q4.url);
  const out = applyBling({
    rooms,
    owned: `${BLING.seasonal},${BLING.neon}`,
    now: Date.parse("2026-05-01T00:00:00.000Z"),
  });
  assert.equal(out.seasonal.file, "leaf.png");
  for (const r of out.rooms) {
    assert.equal(r.icon, "/bling/delights/seasonal-pack/leaf.png");
    assert.equal(r.icon_kind, "seasonal");
  }
});

test("unowned room brief does not grow an Owned Bling section", () => {
  const text = get_room_brief({ room: "money" }).content[0].text;
  assert.equal(text.includes("## Owned Bling"), false);
  assert.equal(text.includes("## Personality"), false);
});
