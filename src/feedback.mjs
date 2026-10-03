/**
 * feedback.mjs — forwards help-form / MCP feedback messages to the support
 * inbox via Resend. Fire-and-forward: nothing is stored, message content
 * is never logged.
 *
 * Two entry points share this core:
 *   handleFeedbackPost(body, ip) — POST /api/feedback (website form)
 *   send_feedback MCP tool        — the assistant relays user feedback
 *                                   from inside a house (see tools.mjs)
 *
 * Env:
 *   RESEND_API_KEY — required. Without it, sends report "not_configured".
 *   FEEDBACK_TO    — recipient, default "support@mymuse.house".
 *   FEEDBACK_FROM  — sender, default "Muse House <feedback@mymuse.house>"
 *                    (the domain must be verified in Resend).
 */
const RESEND_URL = "https://api.resend.com/emails";
const KINDS = ["Help", "Feedback", "Bug report", "Feature idea"];
const MAX_SUBJECT = 150;
const MAX_BODY = 6000;

// Abuse guard for the website endpoint: max N per IP per rolling hour.
// In-memory only, lost on restart — never persisted.
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 5;
const hits = new Map(); // ip -> number[]

// Abuse guard for the MCP tool: calls arrive via the connector proxy, so
// per-IP limiting is unreliable. A modest global bucket instead.
const MCP_RATE_WINDOW_MS = 60 * 60 * 1000;
const MCP_RATE_MAX = 30;
const mcpHits = [];

function validString(v, max) {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max;
}

/** Shared validation. Returns an error string, or null when valid. */
export function validateFeedback({ kind, subject, body }) {
  if (!KINDS.includes(kind)) return `kind must be one of: ${KINDS.join(", ")}.`;
  if (!validString(subject, MAX_SUBJECT)) return "subject is required (1-150 chars).";
  if (!validString(body, MAX_BODY)) return "body is required (1-6000 chars).";
  return null;
}

/**
 * Core send. Returns { ok: true } or { error: "not_configured"|"send_failed" }.
 * Never throws for expected failures; never logs content or the API key.
 */
export async function sendFeedbackEmail({ kind, subject, body }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { error: "not_configured" };
  const to = process.env.FEEDBACK_TO || "support@mymuse.house";
  const from = process.env.FEEDBACK_FROM || "Muse House <feedback@mymuse.house>";

  let res;
  try {
    res = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: `[Muse House — ${kind}] ${subject.trim()}`,
        text: `${body.trim()}\n\n—\nSent via Muse House`,
      }),
    });
  } catch (e) {
    console.error("feedback: resend request failed:", String((e && e.message) || e));
    return { error: "send_failed" };
  }
  if (!res.ok) {
    console.error("feedback: resend rejected the send, status", res.status);
    return { error: "send_failed" };
  }
  return { ok: true };
}

const json = (data, status = 200) => ({
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify(data),
});

function webRateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) {
    hits.set(ip, arr);
    return true;
  }
  arr.push(now);
  hits.set(ip, arr);
  return false;
}

/** POST /api/feedback handler. Returns { status, headers, body }. */
export async function handleFeedbackPost(body, ip) {
  const invalid = validateFeedback(body || {});
  if (invalid) return json({ error: "invalid_request", detail: invalid }, 400);
  if (webRateLimited(ip || "unknown")) {
    return json({ error: "rate_limited", detail: "Too many messages — try again in an hour." }, 429);
  }
  const result = await sendFeedbackEmail(body);
  if (result.error === "not_configured") return json({ error: "email_service_not_configured" }, 503);
  if (result.error) return json({ error: "send_failed" }, 502);
  return json({ ok: true });
}

/** Global rate gate for the MCP send_feedback tool. True when allowed. */
export function mcpFeedbackAllowed() {
  const now = Date.now();
  while (mcpHits.length && now - mcpHits[0] > MCP_RATE_WINDOW_MS) mcpHits.shift();
  if (mcpHits.length >= MCP_RATE_MAX) return false;
  mcpHits.push(now);
  return true;
}
