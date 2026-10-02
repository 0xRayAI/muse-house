/* Muse House customer-lifecycle test v2 — 7 tools. */
const BASE = "https://muse-house-production.up.railway.app";
const MCP = BASE + "/mcp";
let pass = 0, fail = 0;
const issues = [];
function check(name, cond, detail) {
  if (cond) pass++;
  else { fail++; issues.push(name + (detail ? " — " + detail : "")); console.log("FAIL:", name, detail || ""); }
}
async function rpc(id, method, params) {
  const r = await fetch(MCP, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
  const ct = r.headers.get("content-type") || "";
  check(`${method} JSON`, ct.includes("application/json"), ct);
  return { data: await r.json(), status: r.status };
}
async function call(name, args) {
  const res = await rpc(1, "tools/call", { name, arguments: args });
  return { text: res.data.result?.content?.[0]?.text || "", err: res.data.error };
}
const h = await (await fetch(BASE + "/health")).json();
check("health: 7 tools", h.tools === 7, JSON.stringify(h));
let r = await rpc(1, "tools/list", {});
check("tools/list: 7", (r.data.result?.tools || []).length === 7);
let c = await call("stamp_rooms", { rooms: "health", owner_name: "T" });
check("stamp_rooms protocol", c.text.includes("Host action 1") && c.text.includes("Host action 2") && c.text.includes("Host action 3") && !c.text.includes("{{OWNER_NAME}}"));
c = await call("stamp_rooms", { rooms: "nope" });
check("stamp_rooms bad room", c.text.includes("Unknown room"));
c = await call("stamp_rooms", {});
check("stamp_rooms all 4", (c.text.match(/Host action 1/g) || []).length === 4);
c = await call("get_room_brief", { room: "money" });
check("money seed_brief present", c.text.includes("You are the Money Room"));
c = await call("get_house_template", { owner_name: "T", timezone: "X", spend_threshold: "10" });
check("template tokens filled", c.text.includes("fully personalized"));
console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
if (issues.length) process.exit(1);
