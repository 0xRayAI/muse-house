/**
 * feedback.mjs — forwards feedback to the support inbox via Resend.
 * Fire-and-forward: nothing is stored, message content is never logged.
 *
 * Entry points:
 *   handleFeedbackPost(body, ip) — POST /api/feedback (website form; the
 *                                   visitor is the direct author)
 *   send_feedback MCP tool        — the assistant RELAYS user feedback.
 *                                   Relay path is PII-scrubbed server-side:
 *                                   prompt rules alone can't be enforced on
 *                                   a third-party host, regex can.
 *   get_feedback_form MCP tool    — returns the form schema so the host
 *                                   presents fields consistently.
 *
 * Env:
 *   RESEND_API_KEY — required. Without it, sends report "not_configured".
 *   FEEDBACK_TO    — recipient, default "support@mymuse.house".
 *   FEEDBACK_FROM  — sender, default "Muse House <feedback@mymuse.house>"
 *                    (the domain must be verified in Resend).
 */
const RESEND_URL = "https://api.resend.com/emails";
export const FEEDBACK_KINDS = ["Help", "Feedback", "Bug report", "Feature idea"];
export const FEEDBACK_ROOMS = ["money", "travel", "home", "health", "game", "art", "dev", "coach", "bling", "website", "other"];
const MAX_SUMMARY = 150;
const MAX_DETAILS = 2000;

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

/**
 * Shared validation. Accepts the current {kind, room, summary, details}
 * shape; also tolerates the legacy web-form {subject, body} shape during
 * the transition (mapped to summary/details). Returns an error string,
 * or null when valid. Never throws.
 */
export function validateFeedback(input) {
  const b = input || {};
  const kind = b.kind;
  const room = b.room || "other";
  const summary = b.summary || b.subject; // legacy web form compat
  const details = b.details || b.body;    // legacy web form compat
  if (!FEEDBACK_KINDS.includes(kind)) return `kind must be one of: ${FEEDBACK_KINDS.join(", ")}.`;
  if (!FEEDBACK_ROOMS.includes(room)) return `room must be one of: ${FEEDBACK_ROOMS.join(", ")}.`;
  if (!validString(summary, MAX_SUMMARY)) return "summary is required (1-150 chars).";
  if (!validString(details, MAX_DETAILS)) return "details are required (1-2000 chars).";
  return null;
}

/** Normalize any accepted shape to { kind, room, summary, details }. */
export function normalizeFeedback(input) {
  const b = input || {};
  return {
    kind: b.kind,
    room: b.room || "other",
    summary: (b.summary || b.subject || "").trim(),
    details: (b.details || b.body || "").trim(),
  };
}

/**
 * Best-effort PII scrub for the RELAY path (assistant forwarding user
 * speech). The web form's author sends directly and knowingly, so the
 * scrub applies to MCP-relayed text only. Patterns:
 *   emails, 10-digit phone numbers, digit runs of 8+, dollar amounts.
 * Returns { text, redactions }. Deliberately conservative — error codes
 * and short numbers pass through.
 */
const SCRUBS = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted email]"],
  [/\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g, "[redacted phone]"],
  [/\b\d{8,}\b/g, "[redacted number]"],
  [/\$\s?\d[\d,]*(?:\.\d{2})?/g, "[redacted amount]"],
];
export function scrubPII(s) {
  let redactions = 0;
  let out = String(s);
  for (const [re, rep] of SCRUBS) {
    out = out.replace(re, (m) => { redactions++; return rep; });
  }
  return { text: out, redactions };
}

/**
 * Core send. opts.scrub=true for the relay path. Returns
 * { ok: true, redactions } or { error: "not_configured"|"send_failed" }.
 * Never throws for expected failures; never logs content or the API key.
 */
export async function sendFeedbackEmail(input, opts = {}) {
  const { kind, room, summary, details } = normalizeFeedback(input);
  let finalDetails = details;
  let redactions = 0;
  if (opts.scrub) {
    const r = scrubPII(details);
    finalDetails = r.text;
    redactions = r.redactions;
  }
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
        subject: `[Muse House — ${kind}] ${room}: ${summary}`,
        text: `${finalDetails}\n\n—\nSent via Muse House`,
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
  return { ok: true, redactions };
}

/** The form schema, so every host presents the same fields + privacy note. */
export function getFeedbackForm() {
  return {
    fields: [
      { name: "kind", type: "enum", values: FEEDBACK_KINDS, required: true, label: "What kind of feedback is this?" },
      { name: "room", type: "enum", values: FEEDBACK_ROOMS, required: true, label: "Which room (or the website) is this about?" },
      { name: "summary", type: "text", maxLength: MAX_SUMMARY, required: true, label: "One-line summary" },
      { name: "details", type: "textarea", maxLength: MAX_DETAILS, required: true, label: "What happened, or what you'd like to see" },
    ],
    privacy_note:
      "Never include personal or private information: no names, emails, phone numbers, " +
      "addresses, account numbers, or financial figures. Describe the issue, not your data. " +
      "Anything looking like personal data is redacted before sending.",
    flow: "Present the fields conversationally, then show the user the exact text to be sent and get an explicit yes before calling send_feedback.",
  };
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
  const result = await sendFeedbackEmail(body); // direct author: no scrub
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
