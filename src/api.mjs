/**
 * api.mjs — JSON API for the web configurator (and any web client).
 * Same underlying data + logic as the MCP tools, but structured JSON
 * instead of LLM-facing markdown. Stateless, no user data stored.
 */
import {
  catalog,
  rooms,
  mill,
  rankUtilities,
  buildSteps,
  checkCodex,
  fillTemplate,
  getRoomBrief,
} from "./tools.mjs";
import { applyBling } from "./bling-apply.mjs";

const json = (data, status = 200) => ({
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify(data),
});

export function handleApi(url, query) {
  const path = url.split("?")[0];
  switch (path) {
    case "/api/rooms": {
      const view = applyBling({
        rooms,
        owned: query.get("owned") || "",
        purchasedAt: query.get("purchased_at") || "",
        now: Date.now(),
      });
      return json({
        rooms: view.rooms.map((r) => ({
          id: r.id, name: r.name, description: r.description, icon: r.icon, icon_kind: r.icon_kind,
        })),
      });
    }

    case "/api/utilities": {
      const ranked = rankUtilities(query.get("profile") || "", query.get("goal") || "");
      return json({
        utilities: ranked.map((u) => ({
          id: u.id, name: u.name, why: u.why,
          matches: u.matches, recommended: u.recommended,
        })),
      });
    }

    case "/api/room-brief": {
      const room = query.get("room") || "";
      const b = getRoomBrief(room, {
        owned: query.get("owned") || "",
        voice: query.get("voice") || "",
        purchased_at: query.get("purchased_at") || "",
      });
      if (b.error) return json({ error: b.error, available: b.available }, 404);
      return json(b);
    }

    case "/api/house-template": {
      // GET kept for backwards compat; prefer POST (see handleApiTemplate).
      const t = fillTemplate({
        owner_name: query.get("owner_name") || "",
        timezone: query.get("timezone") || "",
        spend_threshold: query.get("spend_threshold") || "",
      });
      return json(t);
    }

    case "/api/steps": {
      const utils = (query.get("utilities") || "").split(",").map((s) => s.trim()).filter(Boolean);
      return json(buildSteps(query.get("goal") || "", utils));
    }

    case "/api/codex-check":
      return json(checkCodex(query.get("action") || ""));

    case "/api/bling/apply": {
      const prompt = (mill["morning-briefing"] && mill["morning-briefing"].sections.prompt_template_for_the_cron_job_) || "";
      return json(applyBling({
        rooms,
        briefingPrompt: prompt,
        owned: query.get("items") || query.get("owned") || "",
        purchasedAt: query.get("purchased_at") || "",
        now: Date.now(),
        voiceId: query.get("voice") || "",
        seed: query.get("seed") || query.get("house") || "",
      }));
    }

    default:
      return null;
  }
}

/**
 * POST /api/house-template — same as the GET case, but personalization
 * (owner name, timezone, spend threshold) arrives in the JSON body so it
 * never appears in request-path logs.
 */
export function handleApiTemplate(body) {
  const t = fillTemplate({
    owner_name: body.owner_name || "",
    timezone: body.timezone || "",
    spend_threshold: body.spend_threshold || "",
  });
  return json(t);
}
