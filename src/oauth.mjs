/**
 * oauth.mjs — OAuth 2.0 for the Muse House custom connector (v2.1 spec).
 *
 * The MCP endpoint (/mcp) is PUBLIC — no auth on tool calls. These OAuth
 * endpoints exist solely so the Muse custom-connector flow
 * (`credentials.request_api_access` with auth_scheme oauth2_code) has a real
 * OAuth 2.0 handshake instead of a fake API key field.
 *
 * THIS IS CONNECTOR-HANDSHAKE COMPLIANCE, NOT ACCESS CONTROL.
 * Tokens are not enforced on /mcp.
 *
 * Spec: docs/oauth-tech-spec.md (v2.1, security critic approved round 2)
 *
 * Endpoints:
 *   GET  /.well-known/oauth-authorization-server — metadata
 *   POST /oauth/register — closed dynamic client registration (RFC 7591)
 *   GET  /oauth/authorize — approval page (PKCE mandatory, S256 only)
 *   POST /oauth/approve — POST-only approval with single-use CSRF
 *   POST /oauth/token — code exchange with atomic single-use + PKCE verify
 *
 * State: Redis-backed. All keys prefixed `oauth:`. Server refuses to start
 * without OAUTH_SIGNING_KEY unless NODE_ENV=development.
 */

import { timingSafeEqual, randomBytes, createHmac, createHash } from "node:crypto";
import { createClient } from "redis";

const ISSUER = "https://mymuse.house";

// ── Signing key (fail fast) ──────────────────────────────────────────
const SIGNING_KEY_ENV = process.env.OAUTH_SIGNING_KEY;
if (!SIGNING_KEY_ENV && process.env.NODE_ENV !== "development") {
  throw new Error("OAUTH_SIGNING_KEY is required (set NODE_ENV=development to bypass)");
}
// Dev fallback: random per boot — tokens don't survive restarts.
const SIGNING_KEY = SIGNING_KEY_ENV || randomBytes(32).toString("hex");

// ── Redis ────────────────────────────────────────────────────────────
let redisClient = null;
let redisAvailable = false;

export async function initOAuthRedis() {
  const url = process.env.REDIS_URL;
  if (!url) {
    console.warn("[oauth] REDIS_URL not set — OAuth endpoints will return 503");
    return;
  }
  try {
    redisClient = createClient({ url });
    redisClient.on("error", () => { redisAvailable = false; });
    await redisClient.connect();
    redisAvailable = true;
    console.log("[oauth] Redis connected");
  } catch (err) {
    console.warn("[oauth] Redis connect failed:", err.message);
    redisAvailable = false;
  }
}

function requireRedis(res) {
  if (!redisAvailable || !redisClient) {
    json(res, 503, { error: "oauth_unavailable" });
    return false;
  }
  return true;
}

// ── Crypto helpers ───────────────────────────────────────────────────
function base64urlEncode(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

function sign(payload) {
  const body = base64urlEncode(Buffer.from(JSON.stringify(payload)));
  const sig = base64urlEncode(createHmac("sha256", SIGNING_KEY).update(body).digest());
  return `${body}.${sig}`;
}

function verify(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = base64urlEncode(createHmac("sha256", SIGNING_KEY).update(body).digest());
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(base64urlDecode(body).toString());
  } catch {
    return null;
  }
}

function pkceChallenge(verifier) {
  return base64urlEncode(createHash("sha256").update(verifier, "utf8").digest());
}

// ── HTML escaping ────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ── HTTP helpers ─────────────────────────────────────────────────────
function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function htmlError(res, status, title, message) {
  const page = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>body{font-family:system-ui;max-width:420px;margin:60px auto;padding:0 20px;text-align:center}</style></head>
<body><h1>${esc(title)}</h1><p>${esc(message)}</p></body></html>`;
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'self'",
    "X-Frame-Options": "DENY",
  });
  res.end(page);
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
        const out = {};
        for (const [k, v] of new URLSearchParams(data)) out[k] = v;
        resolve(out);
      }
    });
  });
}

// ── Rate limiting (in-memory sliding window, per-instance) ───────────
const rateBuckets = new Map();
function rateLimit(ip, maxPerMin) {
  const now = Date.now();
  const key = `${ip}`;
  let bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.windowStart > 60_000) {
    bucket = { windowStart: now, count: 0 };
    rateBuckets.set(key, bucket);
  }
  bucket.count++;
  return bucket.count <= maxPerMin;
}
// Periodic cleanup to prevent memory leak from unbounded Map growth
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now - bucket.windowStart > 120_000) {
      rateBuckets.delete(key);
    }
  }
}, 120_000).unref();
function clientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket?.remoteAddress || "unknown";
}

// ── Redirect allowlist (host-based matching, NEVER string-prefix) ────
function getAllowedPatterns() {
  const raw = process.env.OAUTH_ALLOWED_REDIRECT_PATTERNS || "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function hostMatchesPattern(hostname, pattern) {
  // Pattern is a hostname, optionally prefixed with "*." for subdomains.
  // Exact match, or subdomain match if pattern starts with "*.".
  if (pattern.startsWith("*.")) {
    const base = pattern.slice(2).toLowerCase();
    const h = hostname.toLowerCase();
    return h === base || h.endsWith("." + base);
  }
  return hostname.toLowerCase() === pattern.toLowerCase();
}

function isRedirectAllowed(uri) {
  let parsed;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  // Scheme check
  const isDev = process.env.NODE_ENV === "development";
  if (parsed.protocol === "http:") {
    if (!(isDev && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1"))) {
      return false;
    }
  } else if (parsed.protocol !== "https:") {
    return false;
  }
  // No fragments
  if (parsed.hash) return false;
  // Host-based allowlist matching
  const patterns = getAllowedPatterns();
  if (patterns.length === 0) return false; // deny-all default
  return patterns.some((p) => hostMatchesPattern(parsed.hostname, p));
}

// ── Endpoints ────────────────────────────────────────────────────────

export function handleOAuthMetadata(req, res) {
  json(res, 200, {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/oauth/authorize`,
    token_endpoint: `${ISSUER}/oauth/token`,
    registration_endpoint: `${ISSUER}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["mcp"],
  });
}

export async function handleOAuthRegister(req, res) {
  if (!requireRedis(res)) return;
  if (!rateLimit(clientIp(req), 10)) {
    return json(res, 429, { error: "rate_limited" });
  }
  const body = await parseBody(req);
  const redirectUris = body.redirect_uris;

  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    return json(res, 400, { error: "invalid_redirect_uri" });
  }
  for (const uri of redirectUris) {
    if (typeof uri !== "string" || !isRedirectAllowed(uri)) {
      return json(res, 400, { error: "invalid_redirect_uri" });
    }
  }

  const clientId = `mh_${randomBytes(12).toString("hex")}`;
  try {
    await redisClient.set(`oauth:client:${clientId}`, JSON.stringify({
      redirect_uris: redirectUris,
      created_at: Date.now(),
    }));
  } catch {
    return json(res, 503, { error: "oauth_unavailable" });
  }

  json(res, 201, {
    client_id: clientId,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    scope: "mcp",
  });
}

export async function handleOAuthAuthorize(req, res, query) {
  if (!requireRedis(res)) return;

  const clientId = query.get("client_id") || "";
  const redirectUri = query.get("redirect_uri") || "";
  const state = query.get("state") || "";
  const codeChallenge = query.get("code_challenge") || "";
  const codeChallengeMethod = query.get("code_challenge_method") || "";

  // Bound state length to prevent abuse
  if (state.length > 2048) {
    return htmlError(res, 400, "Invalid state", "State parameter too long.");
  }

  // PKCE is MANDATORY (S256 only)
  if (!codeChallenge) {
    return htmlError(res, 400, "PKCE required", "code_challenge is required.");
  }
  if (codeChallengeMethod !== "S256") {
    return htmlError(res, 400, "Invalid PKCE method", "Only S256 is supported.");
  }

  // Validate client
  let clientRaw;
  try {
    clientRaw = await redisClient.get(`oauth:client:${clientId}`);
  } catch {
    return json(res, 503, { error: "oauth_unavailable" });
  }
  if (!clientRaw) {
    return htmlError(res, 400, "Unknown client", `Client ID "${clientId}" is not registered.`);
  }
  const client = JSON.parse(clientRaw);

  // Exact redirect URI match against registered list
  if (!client.redirect_uris.includes(redirectUri)) {
    return htmlError(res, 400, "Redirect URI not registered",
      `Redirect URI "${redirectUri}" does not match registered URIs.`);
  }

  // Generate single-use CSRF token binding all authorize params
  const csrfToken = randomBytes(32).toString("hex");
  try {
    await redisClient.setEx(`oauth:csrf:${csrfToken}`, 600, JSON.stringify({
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
    }));
  } catch {
    return json(res, 503, { error: "oauth_unavailable" });
  }

  const page = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Muse House</title>
<style>body{font-family:system-ui;max-width:420px;margin:60px auto;padding:0 20px;text-align:center}
h1{font-size:1.4rem}.btn{display:inline-block;margin:8px;padding:12px 32px;border:0;border-radius:10px;
font-weight:600;font-size:1rem;cursor:pointer}.yes{background:#7c3aed;color:#fff}.no{background:#eee;color:#666}</style></head>
<body><h1>🏠 Connect Muse House?</h1>
<p>Muse wants to connect to your Muse House MCP server at <b>mymuse.house</b>.</p>
<p style="color:#666;font-size:.9rem">This grants access to house setup tools (rooms, blueprints, shop). No personal data leaves your device beyond what you ask it to do.</p>
<form method="POST" action="/oauth/approve">
<input type="hidden" name="csrf_token" value="${esc(csrfToken)}">
<input type="hidden" name="state" value="${esc(state)}">
<button type="submit" class="btn yes" name="decision" value="approve">Connect</button>
<button type="submit" class="btn no" name="decision" value="deny">Cancel</button>
</form></body></html>`;
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": "default-src 'self'",
    "X-Frame-Options": "DENY",
  });
  res.end(page);
}

export async function handleOAuthApprove(req, res) {
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method Not Allowed");
    return;
  }
  if (!requireRedis(res)) return;

  const body = await parseBody(req);
  const csrfToken = body.csrf_token || "";
  const state = body.state || "";
  const decision = body.decision || "";

  // Single-use CSRF: fetch then delete
  let csrfRaw;
  try {
    csrfRaw = await redisClient.get(`oauth:csrf:${csrfToken}`);
  } catch {
    return json(res, 503, { error: "oauth_unavailable" });
  }
  if (!csrfRaw) {
    return json(res, 403, { error: "invalid_csrf" });
  }
  try {
    await redisClient.del(`oauth:csrf:${csrfToken}`);
  } catch {
    return json(res, 503, { error: "oauth_unavailable" });
  }
  const csrf = JSON.parse(csrfRaw);

  // Anything other than explicit "approve" is treated as deny (safe default)
  if (decision !== "approve") {
    const sep = csrf.redirect_uri.includes("?") ? "&" : "?";
    const loc = `${csrf.redirect_uri}${sep}error=access_denied&state=${encodeURIComponent(state)}`;
    res.writeHead(302, { Location: loc });
    res.end();
    return;
  }

  // Issue auth code: signed payload + Redis single-use tracking
  const nonce = randomBytes(16).toString("hex");
  try {
    await redisClient.setEx(`oauth:code:${nonce}`, 600, "1");
    await redisClient.setEx(`oauth:pkce:${nonce}`, 600, JSON.stringify({
      challenge: csrf.code_challenge,
    }));
  } catch {
    return json(res, 503, { error: "oauth_unavailable" });
  }

  const code = sign({
    type: "authcode",
    nonce,
    client_id: csrf.client_id,
    redirect_uri: csrf.redirect_uri,
    exp: Date.now() + 600_000,
  });

  // Redirect to URI from Redis (never from request)
  const sep = csrf.redirect_uri.includes("?") ? "&" : "?";
  const loc = `${csrf.redirect_uri}${sep}code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
  res.writeHead(302, { Location: loc });
  res.end();
}

// Lua script for atomic code consumption (key via KEYS[1], never interpolated)
const CONSUME_CODE_LUA = `
if redis.call("GET", KEYS[1]) then
  redis.call("DEL", KEYS[1])
  return 1
else
  return 0
end
`;

export async function handleOAuthToken(req, res) {
  if (!requireRedis(res)) return;
  if (!rateLimit(clientIp(req), 30)) {
    return json(res, 429, { error: "rate_limited" });
  }

  const body = await parseBody(req);

  if (body.grant_type !== "authorization_code") {
    return json(res, 400, { error: "unsupported_grant_type" });
  }

  // Verify HMAC signature and expiry
  const payload = verify(body.code);
  if (!payload || payload.type !== "authcode" || payload.exp < Date.now()) {
    return json(res, 400, { error: "invalid_grant" });
  }

  // Exact client binding
  if (body.client_id !== payload.client_id) {
    return json(res, 400, { error: "invalid_grant" });
  }

  // Exact redirect URI binding (RFC 6749 §4.1.3)
  if (body.redirect_uri !== payload.redirect_uri) {
    return json(res, 400, { error: "invalid_grant" });
  }

  // Atomic single-use check-and-delete
  let consumed;
  try {
    consumed = await redisClient.eval(CONSUME_CODE_LUA, {
      keys: [`oauth:code:${payload.nonce}`],
    });
  } catch {
    return json(res, 503, { error: "oauth_unavailable" });
  }
  if (consumed !== 1) {
    return json(res, 400, { error: "invalid_grant" });
  }

  // PKCE verification (S256)
  let pkceRaw;
  try {
    pkceRaw = await redisClient.get(`oauth:pkce:${payload.nonce}`);
  } catch {
    return json(res, 503, { error: "oauth_unavailable" });
  }
  if (!pkceRaw) {
    return json(res, 400, { error: "invalid_grant" });
  }
  const { challenge } = JSON.parse(pkceRaw);
  const computed = pkceChallenge(body.code_verifier || "");
  const a = Buffer.from(computed, "utf8");
  const b = Buffer.from(challenge, "utf8");
  const pkceOk = a.length === b.length && timingSafeEqual(a, b);

  // Always delete PKCE record (prevent orphan on failure)
  try {
    await redisClient.del(`oauth:pkce:${payload.nonce}`);
  } catch {
    // Non-fatal; code already consumed
  }

  if (!pkceOk) {
    return json(res, 400, { error: "invalid_grant" });
  }

  // Issue access token (1 hour, no refresh)
  const accessToken = sign({
    type: "access",
    scope: "mcp",
    exp: Date.now() + 3600_000,
  });

  json(res, 200, {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: 3600,
    scope: "mcp",
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
  if (req.method === "POST" && url.pathname === "/oauth/approve") {
    handleOAuthApprove(req, res);
    return true;
  }
  if (req.method === "GET" && url.pathname === "/oauth/approve") {
    // GET on approve is not allowed — no code issued
    res.writeHead(405, { "Content-Type": "text/plain" });
    res.end("Method Not Allowed");
    return true;
  }
  if (req.method === "POST" && url.pathname === "/oauth/token") {
    handleOAuthToken(req, res);
    return true;
  }
  return false;
}
