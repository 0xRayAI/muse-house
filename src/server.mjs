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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { TOOL_DEFS } from "./tools.mjs";

const SERVICE = "muse-house";
const VERSION = "0.1.0";
const PORT = Number(process.env.PORT || 3000);

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
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found", routes: ["POST /mcp", "GET /health"] }));
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "internal", message: String(e && e.message || e) }));
  }
});

http.listen(PORT, () => {
  console.log(`${SERVICE} v${VERSION} listening on :${PORT} — POST /mcp (stateless), GET /health`);
});
