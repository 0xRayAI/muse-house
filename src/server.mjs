#!/usr/bin/env node
/**
 * server.mjs — Amuse House Foundry MCP service.
 *
 * Streamable HTTP (stateless) on a single /mcp endpoint, plus GET /health.
 * Stateless by design: no sessions, no user data stored, every request
 * independent. Blueprints and governance checks only — the household's
 * board lives with their own Muse agent, never here.
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { TOOL_DEFS } from "./tools.mjs";

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

/** zod object schema from a JSON-schema-ish inputSchema (flat string/array props). */
function toZod(inputSchema) {
  const shape = {};
  const props = inputSchema.properties || {};
  for (const [key, def] of Object.entries(props)) {
    let s;
    if (def.type === "array") s = z.array(z.string());
    else s = z.string();
    if (def.description) s = s.describe(def.description);
    if (!(inputSchema.required || []).includes(key)) s = s.optional();
    shape[key] = s;
  }
  return shape;
}

function createMcpServer() {
  const server = new McpServer({ name: SERVICE, version: VERSION });
  for (const def of TOOL_DEFS) {
    server.registerTool(def.name, { description: def.description, inputSchema: toZod(def.inputSchema) }, async (args) => def.fn(args || {}));
  }
  return server;
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

const http = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: SERVICE, version: VERSION, tools: TOOL_DEFS.length, stateless: true }));
      return;
    }
    if (req.method === "POST" && req.url === "/mcp") {
      const body = await readBody(req);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = createMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
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
