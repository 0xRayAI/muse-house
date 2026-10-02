/**
 * api.mjs — JSON API for the web configurator (and any web client).
 * Same underlying data + logic as the MCP tools, but structured JSON
 * instead of LLM-facing markdown. Stateless, no user data stored.
 */
import {
  catalog,
  rooms,
  rankUtilities,
  buildSteps,
  checkCodex,
  fillTemplate,
  getRoomBrief,
} from "./tools.mjs";

const json = (data, status = 200) => ({
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify(data),
});

export function handleApi(url, query) {
  const path = url.split("?")[0];
  switch (path) {
    case "/api/rooms":
      return json({
        rooms: rooms.map((r) => ({ id: r.id, name: r.name, description: r.description })),
      });

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
      const b = getRoomBrief(room);
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
