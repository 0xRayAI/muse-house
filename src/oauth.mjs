/**
 * oauth.mjs — OAuth 2.0 for the Muse House custom connector.
 *
 * The MCP endpoint is public (no auth on tool calls). These endpoints exist
 * solely so the Muse custom-connector flow (`credentials.request_api_access`
 * with auth_scheme oauth2_code) has a real OAuth handshake instead of a fake
 * API key field.
 *
 * Endpoints:
 *   GET  /.well-known/oauth-authorization-server — metadata
 *   POST /oauth/register — dynamic client registration (RFC 7591)
 *   GET  /oauth/authorize — user approval page
 *   POST /oauth/token — code → token exchange
 *
 * Tokens are HMAC-signed (stateless, no storage). They are not currently
 * enforced on /mcp — the handshake satisfies the connector flow.
 */

import { createHmac, randomBytes } from "node:crypto";

const ISSUER = "https://mymuse.house";
const SIGNING_KEY = process.env.OAUTH_SIGNING_KEY || "muse-house-dev-signing-key";

function base64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sign(payload) {
  const body = base64url(Buffer.from(JSON.stringify(payload)));
  const sig = base64url(createHmac("sha256", SIGNING_KEY).update(body).digest());
  return `${body}.${sig}`;
}

function verify(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = base64url(createHmac("sha256", SIGNING_KEY).update(body).digest());
  if (sig !== expected) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64").toString());
  } catch {
    return null;
  }
}

function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function parseBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const ct = req.headers["content-type"] || "";
      if (ct.includes("application/json")) {
        try { resolve(JSON.parse(data)); } catch { resolve({}); }
      } else {
        // application/x-www-form-urlencoded
        const out = {};
        for (const [k, v] of new URLSearchParams(data)) out[k] = v;
        resolve(out);
      }
    });
  });
}

export function handleOAuthMetadata(req, res) {
  json(res, 200, {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/oauth/authorize`,
    token_endpoint: `${ISSUER}/oauth/token`,
    registration_endpoint: `${ISSUER}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256", "plain"],
    scopes_supported: ["mcp"],
  });
}

export function handleOAuthRegister(req, res) {
  parseBody(req).then((body) => {
    const clientId = `mh_${randomBytes(12).toString("hex")}`;
    json(res, 201, {
      client_id: clientId,
      client_secret: null,
      redirect_uris: body.redirect_uris || [],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      scope: "mcp",
    });
  });
}

export function handleOAuthAuthorize(req, res, query) {
  const clientId = query.get("client_id") || "";
  const redirectUri = query.get("redirect_uri") || "";
  const state = query.get("state") || "";
  const scope = query.get("scope") || "mcp";

  // Simple approval page — no login, one tap.
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Muse House</title>
<style>body{font-family:system-ui;max-width:420px;margin:60px auto;padding:0 20px;text-align:center}
h1{font-size:1.4rem}.btn{display:inline-block;margin:8px;padding:12px 32px;border-radius:10px;
text-decoration:none;font-weight:600}.yes{background:#7c3aed;color:#fff}.no{color:#666}</style></head>
<body><h1>🏠 Connect Muse House?</h1>
<p>Muse wants to connect to your Muse House MCP server at <b>mymuse.house</b>.</p>
<p style="color:#666;font-size:.9rem">This grants access to house setup tools (rooms, blueprints, shop). No personal data leaves your device beyond what you ask it to do.</p>
<p><a class="btn yes" href="/oauth/approve?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}&scope=${encodeURIComponent(scope)}">Connect</a></p>
<p><a class="btn no" href="${redirectUri}?error=access_denied&state=${encodeURIComponent(state)}">Cancel</a></p>
</body></html>`;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

export function handleOAuthApprove(req, res, query) {
  const redirectUri = query.get("redirect_uri") || "";
  const state = query.get("state") || "";
  // Issue a short-lived auth code (signed, 10 min).
  const code = sign({ type: "authcode", exp: Date.now() + 600_000, nonce: randomBytes(8).toString("hex") });
  const sep = redirectUri.includes("?") ? "&" : "?";
  res.writeHead(302, { Location: `${redirectUri}${sep}code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}` });
  res.end();
}

export function handleOAuthToken(req, res) {
  parseBody(req).then((body) => {
    if (body.grant_type !== "authorization_code") {
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    const payload = verify(body.code);
    if (!payload || payload.type !== "authcode" || payload.exp < Date.now()) {
      return json(res, 400, { error: "invalid_grant" });
    }
    // Issue access token (signed, 1 year — connector stays connected).
    const accessToken = sign({ type: "access", exp: Date.now() + 365 * 24 * 3600_000, scope: "mcp" });
    json(res, 200, {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 365 * 24 * 3600,
      scope: "mcp",
    });
  });
}

/** Route OAuth paths. Returns true if handled. */
export function routeOAuth(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET" && url.pathname === "/.well-known/oauth-authorization-server") {
    handleOAuthMetadata(req, res);
    return true;
  }
  if (req.method === "POST" && url.pathname === "/oauth/register") {
    handleOAuthRegister(req, res);
    return true;
  }
  if (req.method === "GET" && url.pathname === "/oauth/authorize") {
    handleOAuthAuthorize(req, res, url.searchParams);
    return true;
  }
  if (req.method === "GET" && url.pathname === "/oauth/approve") {
    handleOAuthApprove(req, res, url.searchParams);
    return true;
  }
  if (req.method === "POST" && url.pathname === "/oauth/token") {
    handleOAuthToken(req, res);
    return true;
  }
  return false;
}
