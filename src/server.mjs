#!/usr/bin/env node
/**
 * server.mjs — Muse House Foundry MCP service.
 *
 * Streamable HTTP (stateless) on a single /mcp endpoint, plus GET /health.
 * POST /mcp answers with a single `application/json` body (never SSE):
 * Meta's egress proxy has been reported to hang on Server-Sent Events, so
 * plain JSON keeps directory review and custom connectors working.
 * Stateless by design: no sessions, no user data stored, every request
 * independent. Blueprints and governance checks only — the household's
 * board lives with their own Muse agent, never here.
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { TOOL_DEFS } from "./tools.mjs";
import { handleApi } from "./api.mjs";
import { handleApiTemplate } from "./api.mjs";
import { handleFeedbackPost } from "./feedback.mjs";
import { handleBlingCatalog, handleBlingCheckout, handleBlingWebhook, handleBlingOrders } from "./bling.mjs";

const SERVICE = "muse-house";
const VERSION = "0.1.0";
const PORT = Number(process.env.PORT || 3000);
const SITE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "site");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

/** Serve the marketing site (GET / and static assets under site/). */
function serveSite(req, res) {
  const raw = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const safe = normalize(raw).replace(/^(\.\.[/\\])+/, "");
  const file = join(SITE_DIR, safe);
  if (!file.startsWith(SITE_DIR) || !existsSync(file)) return false;
  const ext = safe.slice(safe.lastIndexOf("."));
  res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
  res.end(readFileSync(file));
  return true;
}

/** Minimal MCP request handler: single application/json response, never SSE. */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"];

function mcpError(id, code, message) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

async function handleMcpMessage(msg) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return mcpError(msg && msg.id, -32600, "Invalid Request");
  }
  const isNotification = msg.id === undefined || msg.id === null;
  const ok = (result) => ({ jsonrpc: "2.0", id: msg.id, result });

  switch (msg.method) {
    case "initialize": {
      const v = msg.params && msg.params.protocolVersion;
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(v) ? v : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: SERVICE, version: VERSION },
      });
    }
    case "notifications/initialized":
      return null; // notification: no JSON-RPC response
    case "ping":
      return ok({});
    case "tools/list":
      return ok({
        tools: TOOL_DEFS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });
    case "tools/call": {
      const name = msg.params && msg.params.name;
      const def = TOOL_DEFS.find((t) => t.name === name);
      if (!def) {
        return isNotification ? null : mcpError(msg.id, -32602, `Unknown tool: ${name}`);
      }
      try {
        const result = await def.fn((msg.params && msg.params.arguments) || {});
        return isNotification ? null : ok(result);
      } catch (e) {
        return isNotification ? null : mcpError(msg.id, -32603, String((e && e.message) || e));
      }
    }
    default:
      return isNotification ? null : mcpError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

/** POST /mcp → one JSON body, Content-Type: application/json. */
async function handleMcpPost(body) {
  const batch = Array.isArray(body);
  const messages = batch ? body : [body];
  const responses = [];
  for (const m of messages) {
    const r = await handleMcpMessage(m);
    if (r) responses.push(r);
  }
  if (batch) return { status: 200, body: responses };
  if (responses.length === 0) return { status: 202, body: "" }; // notification only
  return { status: 200, body: responses[0] };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const http = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: SERVICE, version: VERSION, tools: TOOL_DEFS.length, stateless: true }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/house-template") {
      // Personalization travels in the POST body, never the URL —
      // request-path logs must not see owner names or timezones.
      const body = await readBody(req).catch(() => ({}));
      const apiRes = handleApiTemplate(body || {});
      if (apiRes) {
        res.writeHead(apiRes.status, apiRes.headers);
        res.end(apiRes.body);
        return;
      }
    }
    if (req.method === "POST" && req.url === "/api/feedback") {
      // Help-form submissions → forwarded to the support inbox via Resend.
      // Fire-and-forward: nothing stored, message content never logged.
      const body = await readBody(req).catch(() => ({}));
      const fwd = req.headers["x-forwarded-for"];
      const ip = (typeof fwd === "string" && fwd.split(",")[0].trim()) || req.socket.remoteAddress || "unknown";
      const fbRes = await handleFeedbackPost(body || {}, ip);
      res.writeHead(fbRes.status, fbRes.headers);
      res.end(fbRes.body);
      return;
    }
    if (req.method === "GET" && req.url === "/api/bling/catalog") {
      // Public catalog — no keys needed.
      const catRes = handleBlingCatalog();
      res.writeHead(catRes.status, catRes.headers);
      res.end(catRes.body);
      return;
    }
    if (req.method === "POST" && req.url === "/api/bling/checkout") {
      // Create a Stripe Checkout Session for a catalog item.
      // 503 with payments_not_configured until STRIPE_SECRET_KEY is set.
      const body = await readBody(req).catch(() => ({}));
      const coRes = await handleBlingCheckout(body || {});
      res.writeHead(coRes.status, coRes.headers);
      res.end(coRes.body);
      return;
    }
    if (req.method === "POST" && req.url === "/api/bling/webhook") {
      // Stripe webhook — needs the RAW body for signature verification.
      const raw = await readRawBody(req).catch(() => null);
      const sig = req.headers["stripe-signature"];
      const whRes = await handleBlingWebhook(raw, Array.isArray(sig) ? sig[0] : sig);
      res.writeHead(whRes.status, whRes.headers);
      res.end(whRes.body);
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/api/bling/orders")) {
      // Token-protected order feed for Bling rooms. The token lives in
      // Railway env (BLING_API_TOKEN) and in the room's memory — never in chat.
      const sp = new URL(req.url, "http://localhost").searchParams;
      const oRes = await handleBlingOrders(sp);
      res.writeHead(oRes.status, oRes.headers);
      res.end(oRes.body);
      return;
    }
    if (req.method === "GET" && req.url.startsWith("/api/")) {
      const apiRes = handleApi(req.url, new URL(req.url, "http://localhost").searchParams);
      if (apiRes) {
        res.writeHead(apiRes.status, apiRes.headers);
        res.end(apiRes.body);
        return;
      }
    }
    if (req.method === "POST" && req.url === "/mcp") {
      const body = await readBody(req);
      const mcpRes = await handleMcpPost(body);
      if (mcpRes.status === 202) {
        res.writeHead(202);
        res.end();
      } else {
        res.writeHead(mcpRes.status, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(mcpRes.body));
      }
      return;
    }
    if (req.method === "GET" && req.url === "/mcp") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        service: "Muse House",
        note: "This is a machine endpoint — it only speaks MCP over POST. If you're a human, start at https://mymuse.house/ (docs: https://mymuse.house/tech.html).",
        usage: "POST a JSON-RPC 2.0 body here (tools/list, tools/call).",
        routes: ["GET / (site)", "POST /mcp", "GET /health"]
      }));
      return;
    }
    if (req.method === "GET" && serveSite(req, res)) return;
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found", routes: ["GET / (site)", "POST /mcp", "GET /health"] }));
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "internal", message: String(e && e.message || e) }));
  }
});

http.listen(PORT, () => {
  console.log(`${SERVICE} v${VERSION} listening on :${PORT} — GET / (site), POST /mcp (stateless), GET /health`);
});
