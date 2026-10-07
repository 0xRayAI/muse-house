# Tech Spec: Redis-Backed OAuth 2.0 for Muse House Connector

**Status:** Draft v2 — addresses security critic round 1 (2026-10-07)
**Date:** 2026-10-07
**PR:** #53 (do not merge — pending arch1 review)

## 1. Problem

The Muse custom-connector flow (`credentials.request_api_access` with
`auth_scheme: oauth2_code`) requires a real OAuth 2.0 handshake. The MCP
endpoint (`https://mymuse.house/mcp`) is public — no auth on tool calls.
OAuth exists solely to satisfy the connector UX; tokens are not enforced
on `/mcp`. This is documented as handshake theater, not access control.

The initial stateless implementation (PR #53 v1) failed security review
with 3 critical and 5 high findings. v1 of this spec addressed them with
server-side state backed by Redis. Critic round 1 found 7 remaining gaps.
This v2 incorporates all of them.

## 2. Architecture

```
                    ┌─────────────┐
                    │   Railway   │
                    │             │
  User ──HTTPS──▶   │  Node server │
                    │  (oauth.mjs) │
                    │       │       │
                    │       ▼       │
                    │  Redis (managed) │
                    └─────────────┘
```

- **Compute:** Existing Railway service (Node.js, `src/server.mjs`).
- **State:** Railway managed Redis. Connection via `REDIS_URL` env.
- **Signing:** HMAC-SHA256 with `OAUTH_SIGNING_KEY` env. Server refuses
  to start unless `NODE_ENV=development` OR key is set (fail fast —
  Railway doesn't always set `NODE_ENV=production`, so we invert the
  check). Dev fallback is `randomBytes(32)` per boot — tokens don't
  survive restarts.
- **Dependency:** `redis` npm package (v4+, promise API).

### Graceful degradation

If Redis is unreachable at request time, OAuth endpoints return
`503 { error: "oauth_unavailable" }`. The MCP endpoint (`/mcp`) is
unaffected — it never touches Redis. Health check (`/health`) reports
Redis connectivity as a field, not a failure.

**Important:** Redis errors must be distinguished from missing keys.
A failed `GET` due to connection loss → 503. A successful `GET`
returning null → 400 (unknown client / expired token). Check
connectivity before interpreting absence.

## 3. Redis Key Schema

| Key | Value | TTL | Purpose |
|-----|-------|-----|---------|
| `oauth:client:<client_id>` | JSON: `{ redirect_uris: [], created_at }` | none | DCR registry |
| `oauth:code:<nonce>` | `1` | 600s | Single-use code tracking |
| `oauth:csrf:<token>` | JSON: `{ client_id, redirect_uri, code_challenge }` | 600s | Approve-action binding |
| `oauth:pkce:<nonce>` | JSON: `{ challenge }` | 600s | PKCE verifier binding (S256 only) |

All keys prefixed `oauth:` for namespacing. All key components are
server-generated (client_id, nonce, CSRF token) or HMAC-verified —
no user input is interpolated into key names.

## 4. Endpoint Specifications

### 4.1 `GET /.well-known/oauth-authorization-server`

Returns metadata JSON. `code_challenge_methods_supported: ["S256"]`
only — `plain` is removed (weak).

### 4.2 `POST /oauth/register` (DCR, RFC 7591) — CLOSED REGISTRATION

**Fixes:** H5 (arbitrary redirect_uris, no storage)

**Closed registration:** Only Meta's connector callback domains are
accepted. Allowlist configured via `OAUTH_ALLOWED_REDIRECT_PATTERNS`
env var (comma-separated). **Matching MUST be host-based, not string
prefix:** parse each candidate URI, extract the hostname, and compare
against the allowlist. A pattern `agent.meta.ai` matches exactly that
hostname or (if suffixed with `*.`) its subdomains. Raw string-prefix
matching is forbidden — pattern `https://agent.meta.ai` must NOT match
`https://agent.meta.ai.evil.com/cb`. Defaults to empty (deny-all).
Document the required values once known.

Request: JSON body with `redirect_uris: string[]`.

Validation (reject with `400 { error: "invalid_redirect_uri" }` if):
- Empty array
- Any URI missing `https:` scheme (allow `http://localhost` for dev
  when `NODE_ENV=development`)
- Any URI containing a fragment (`#`)
- Any URI with `javascript:`, `data:`, or other non-https scheme
- Any URI not matching an allowlisted pattern

On success:
- Generate `client_id = "mh_" + randomBytes(12).hex()`
- `SET oauth:client:<client_id>` = `{ redirect_uris, created_at }`
- Return `201` with `client_id`, `redirect_uris` (echo validated list)

**Rate limit:** 10 requests/min per IP (in-memory sliding window).

### 4.3 `GET /oauth/authorize`

**Fixes:** C2 (XSS), C3 (CSRF bypass), L3 (unvalidated client_id),
H4 (PKCE now mandatory)

Query params: `client_id`, `redirect_uri`, `state`, `scope`,
`code_challenge`, `code_challenge_method`.

Validation — on any failure, render a **400 error page** (not a
redirect). The error page MUST HTML-escape all reflected values
(`client_id`, `redirect_uri`, `state`). It must not echo raw input.

1. `client_id` not found in Redis → "Unknown client"
   (distinguish Redis-down → 503 per §2)
2. `redirect_uri` not exact-match in client's registered URIs →
   "Redirect URI not registered"
3. `redirect_uri` scheme is not `https` (or localhost in dev) → reject
4. **`code_challenge` is REQUIRED.** If absent → "PKCE required"
   (fixes H4 — public clients must use PKCE per RFC 8252)
5. `code_challenge_method` must be `"S256"` → reject otherwise

On success:
- Generate CSRF token: `randomBytes(32).hex()`
- `SETEX oauth:csrf:<token> 600` =
  `{ client_id, redirect_uri, code_challenge }`
  (S256 only — no method field needed)
- Render approval page as POST form (not GET links):
  ```html
  <form method="POST" action="/oauth/approve">
    <input type="hidden" name="csrf_token" value="<token>">
    <input type="hidden" name="state" value="<html-escaped state>">
    <button type="submit" name="decision" value="approve">Connect</button>
    <button type="submit" name="decision" value="deny">Cancel</button>
  </form>
  ```
- All interpolated values HTML-escaped. Headers:
  `Content-Security-Policy: default-src 'self'`,
  `X-Frame-Options: DENY`.

### 4.4 `POST /oauth/approve`

**Fixes:** C1 (open redirect), C3 (CSRF), M4 (GET for state change)

Body (form-encoded): `csrf_token`, `state`, `decision`.

Processing:
1. `GET oauth:csrf:<csrf_token>` → if missing/expired: `403`
   (distinguish Redis-down → 503 per §2)
2. `DEL oauth:csrf:<csrf_token>` (single-use)
3. Validate `decision`:
   - `"approve"` → continue to step 4
   - `"deny"` → redirect to `redirect_uri` (from Redis) with
     `?error=access_denied&state=<encodeURIComponent(state)>`
   - **anything else → treat as deny** (safe default)
4. Generate auth code nonce: `randomBytes(16).hex()`
5. `SETEX oauth:code:<nonce> 600` = `1`
6. `SETEX oauth:pkce:<nonce> 600` = `{ challenge }`
   (from CSRF record)
7. Sign code payload: `{ type: "authcode", nonce, client_id,
   redirect_uri, exp }` (HMAC-SHA256)
8. 302 redirect to `redirect_uri` (**from Redis, never from request**)
   with `?code=<encodeURIComponent(signed)>&state=<encodeURIComponent(state)>`

All query-string values use `encodeURIComponent` (not HTML escaping —
different context). This fixes the `state` injection issue.

`GET /oauth/approve` → `405 Method Not Allowed`, no code issued.

### 4.5 `POST /oauth/token`

**Fixes:** H2 (replayable codes), H3 (no client binding), H4 (PKCE)

Body (form-encoded): `grant_type`, `code`, `redirect_uri`,
`client_id`, `code_verifier`.

Processing:
1. `grant_type` must be `authorization_code`, else `400`
2. Verify HMAC signature (using `crypto.timingSafeEqual` after
   length check) and expiry on `code` → `400 invalid_grant` if invalid
3. `client_id` in body must exact-match `client_id` in code payload →
   `400` if mismatch (fixes H3)
4. `redirect_uri` in body must exact-match `redirect_uri` in code
   payload → `400` if mismatch (fixes H3, RFC 6749 §4.1.3)
5. Atomic check-and-delete `oauth:code:<nonce>` via Lua script
   (key passed as `KEYS[1]`, never interpolated):
   ```lua
   if redis.call("GET", KEYS[1]) then
     redis.call("DEL", KEYS[1])
     return 1
   else
     return 0
   end
   ```
   Returns 0 → `400 invalid_grant` (already used or expired).
   Fixes H2.
6. PKCE verification (fixes H4):
   - `GET oauth:pkce:<nonce>` → `{ challenge }`
   - Compute `base64url(sha256(code_verifier))`, compare with
     `timingSafeEqual` against `challenge`
   - Mismatch → `DEL oauth:pkce:<nonce>`, then `400 invalid_grant`
   - Match → `DEL oauth:pkce:<nonce>`, continue
7. Issue access token: HMAC-signed `{ type: "access", scope: "mcp",
   exp: now + 3600 }` (1 hour)
8. Return `200`:
   ```json
   {
     "access_token": "<signed>",
     "token_type": "Bearer",
     "expires_in": 3600,
     "scope": "mcp"
   }
   ```

**Rate limit:** 30 requests/min per IP.

## 5. HMAC Implementation

**Fixes:** H1 (public fallback key), M1 (timing attack), L1 (base64url)

```js
import { timingSafeEqual, randomBytes, createHmac } from "node:crypto";

const SIGNING_KEY = process.env.OAUTH_SIGNING_KEY;
if (!SIGNING_KEY && process.env.NODE_ENV !== "development") {
  throw new Error("OAUTH_SIGNING_KEY is required (set NODE_ENV=development to bypass)");
}
const KEY = SIGNING_KEY || randomBytes(32).toString("hex");

function verifySignature(body, sig) {
  const expected = base64url(createHmac("sha256", KEY).update(body).digest());
  const a = Buffer.from(sig, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Base64url encode/decode implemented explicitly:
```js
function base64urlEncode(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}
```

## 6. What This Deliberately Does NOT Do

- **No token enforcement on `/mcp`.** The endpoint stays public.
  OAuth is connector-UX compliance. Documented in code header.
- **No refresh tokens.** 1-hour access tokens; the connector
  re-runs the code flow on expiry.
- **No persistent audit log.** Redis TTLs auto-expire.
- **No multi-instance coordination beyond Redis.** All state is in
  Redis. In-memory rate limiter is per-instance (acceptable).

## 7. Railway Setup

1. Provision managed Redis via Railway dashboard.
2. Set env vars:
   - `REDIS_URL` (auto-injected when Redis is linked)
   - `OAUTH_SIGNING_KEY` (generate: `openssl rand -hex 32`)
   - `OAUTH_ALLOWED_REDIRECT_PATTERNS` (comma-separated, Meta's
     callback domains — obtain from Muse connector docs)
3. `npm install redis`
4. Deploy. Verify `/.well-known/oauth-authorization-server` → 200.

## 8. Testing Checklist

### Registration
- [ ] DCR rejects `javascript:` redirect URI
- [ ] DCR rejects URI with fragment (`#`)
- [ ] DCR rejects empty `redirect_uris` array
- [ ] DCR rejects non-allowlisted domain (closed registration)
- [ ] DCR accepts valid Meta callback URI

### Authorize
- [ ] Authorize with unregistered client_id → 400 page, no redirect
- [ ] Authorize with mismatched redirect_uri → 400 page
- [ ] Authorize without `code_challenge` → 400 (PKCE mandatory)
- [ ] Authorize with `code_challenge_method=plain` → 400 (S256 only)
- [ ] 400 error page doesn't reflect unescaped user input
- [ ] Approval page has `X-Frame-Options: DENY`
- [ ] Approval page has restrictive CSP

### Approve
- [ ] `GET /oauth/approve` → 405, no code issued
- [ ] Approve without valid CSRF token → 403
- [ ] CSRF token reuse (second POST) → 403
- [ ] `decision=deny` → redirects to registered URI with
      `error=access_denied`, no code issued
- [ ] `decision` with unexpected value → treated as deny
- [ ] `state` containing `&`, `=`, `#` → correctly encoded in
      redirect, doesn't break query parsing

### Token
- [ ] Redeem same auth code twice → second attempt `400 invalid_grant`
- [ ] Concurrent double-redeem → exactly one succeeds (Lua atomicity)
- [ ] Token request with wrong `redirect_uri` → `400`
- [ ] Token request with wrong `client_id` → `400`
- [ ] Token request with wrong `code_verifier` → `400`

### Infrastructure
- [ ] Redis down → 503 on OAuth endpoints, `/mcp` still 200
- [ ] Server refuses to start without `OAUTH_SIGNING_KEY`
      (unless `NODE_ENV=development`)
- [ ] Full connector flow via `credentials.request_api_access`
      with `oauth2_code` completes end-to-end

## 9. Resolved Open Questions (from v1)

1. **Closed vs open registration?** → Closed. `OAUTH_ALLOWED_REDIRECT_PATTERNS`
   env var, defaults to deny-all.
2. **Token lifetime?** → 1 hour, no refresh tokens.
3. **Audit logging?** → Not now. Revisit if tokens get enforced.

## Appendix: Changes from v1 (critic round 1)

| # | Finding | Fix in v2 |
|---|---------|-----------|
| 1 | H4 gap: PKCE optional | `code_challenge` required at authorize; S256 only |
| 2 | N1: `state` query injection | `encodeURIComponent` on all redirect params |
| 3 | C2 gap: 400 page XSS | Error page HTML-escapes all reflected values |
| 4 | N2: unexpected `decision` | Defaults to deny |
| 5 | N3: Redis-down ambiguity | 503 vs 400 distinguished explicitly |
| 6 | Typo C4/M4 | Fixed → M4 |
| 7 | H1 nit: `NODE_ENV` check | Inverted: require key unless `NODE_ENV=development` |
| + | N5: PKCE orphan on failure | `DEL oauth:pkce:<nonce>` on verification failure |
| + | N6: Lua hygiene | Key via `KEYS[1]`, never interpolated |
| + | Q1 | Closed registration via env allowlist |
| + | Testing gaps | 11 new checklist items added |
