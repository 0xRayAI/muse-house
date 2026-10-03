/**
 * feedback.mjs — POST /api/feedback → forwards help-form messages to the
 * support inbox via Resend. Fire-and-forward: nothing is stored, message
 * content is never logged.
 *
 * Env:
 *   RESEND_API_KEY — required. Without it the endpoint answers 503 and the
 *                    web form falls back to a mailto: draft.
 *   FEEDBACK_TO    — recipient, default "support@mymuse.house".
 *   FEEDBACK_FROM  — sender, default "Muse House <feedback@mymuse.house>"
 *                    (the domain must be verified in Resend).
 */
const RESEND_URL = "https://api.resend.com/emails";
const KINDS = ["Help", "Feedback", "Bug report", "Feature idea"];
const MAX_SUBJECT = 150;
const MAX_BODY = 6000;

// Abuse guard: max N submissions per IP per rolling hour. In-memory only,
// lost on restart — never persisted, consistent with the stateless design.
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX = 5;
const hits = new Map(); // ip -> number[]

function rateLimited(ip) {
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

const json = (data, status = 200) => ({
  status,
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify(data),
});

function validString(v, max) {
  return typeof v === "string" && v.trim().length > 0 && v.length <= max;
}

export async function handleFeedbackPost(body, ip) {
  const kind = body && body.kind;
  const subject = body && body.subject;
  const text = body && body.body;

  if (!KINDS.includes(kind) || !validString(subject, MAX_SUBJECT) || !validString(text, MAX_BODY)) {
    return json({ error: "invalid_request", detail: "kind, subject (1-150 chars) and body (1-6000 chars) are required." }, 400);
  }
  if (rateLimited(ip || "unknown")) {
    return json({ error: "rate_limited", detail: "Too many messages — try again in an hour." }, 429);
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return json({ error: "email_service_not_configured" }, 503);
  }
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
        text: `${text.trim()}\n\n—\nSent from mymuse.house/help.html`,
      }),
    });
  } catch (e) {
    console.error("feedback: resend request failed:", String((e && e.message) || e));
    return json({ error: "send_failed" }, 502);
  }
  if (!res.ok) {
    // Log the status only — never the message content or the API key.
    console.error("feedback: resend rejected the send, status", res.status);
    return json({ error: "send_failed" }, 502);
  }
  return json({ ok: true });
}
