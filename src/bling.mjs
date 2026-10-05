/**
 * bling.mjs — the Bling shop's payment backend.
 *
 * - GET  /api/bling/catalog  → the catalog (public, no keys needed)
 * - POST /api/bling/checkout { item_id } → Stripe Checkout Session URL
 * - POST /api/bling/webhook  → Stripe webhook; verifies the signature,
 *   then pings the support inbox so the delight gets fulfilled.
 *
 * Env:
 *   STRIPE_SECRET_KEY     — required for checkout + webhook verification.
 *   STRIPE_WEBHOOK_SECRET — required for webhook verification.
 *   BLING_TO              — fulfillment inbox (default support@mymuse.house).
 *   SITE_URL              — public base URL (default https://mymuse.house).
 *   SKILLS_REPO_TOKEN     — GitHub token with read access to the private
 *                           0xRayAI/muse-house-skills repo. Used only by the
 *                           install_skill MCP tool, and only AFTER a paid
 *                           entitlement is verified (verifySkillEntitlement).
 *                           Without it, install_skill refuses and skill-backed
 *                           items fall back to the email fulfillment path.
 *
 * Without STRIPE_SECRET_KEY every checkout attempt returns
 * { error: "payments_not_configured" } — the shop shows "coming soon"
 * instead of breaking. Card numbers never touch this service: Stripe
 * Checkout hosts the payment form; we only ever see session ids.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";

const SITE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "site");
const SITE_URL = (process.env.SITE_URL || "https://mymuse.house").replace(/\/$/, "");

function json(status, body) {
  return { status, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) };
}

export function getCatalog() {
  try {
    return JSON.parse(readFileSync(join(SITE_DIR, "bling-catalog.json"), "utf8"));
  } catch {
    return { currency: "usd", items: [] };
  }
}

export function handleBlingCatalog() {
  return json(200, getCatalog());
}

async function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  const { default: Stripe } = await import("stripe");
  return new Stripe(key);
}

/**
 * POST /api/bling/checkout — body: { item_id, house? }.
 * `house` is the buyer's house tag (e.g. "blazeyboi") so the purchase
 * tracks back to their house. Self-reported — it's for delivery, not
 * security. Returns { url } (the Stripe Checkout page) or an honest error.
 */
export async function handleBlingCheckout(body) {
  const itemId = body && typeof body.item_id === "string" ? body.item_id : "";
  const item = getCatalog().items.find((i) => i.id === itemId);
  if (!item) return json(400, { error: "unknown_item" });
  if (item.coming_soon) return json(409, { error: "coming_soon", message: "This delight isn't ready yet." });
  const rawHouse = body && typeof body.house === "string" ? body.house.trim() : "";
  const house = rawHouse.replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 60);
  const stripe = await stripeClient().catch(() => null);
  if (!stripe) return json(503, { error: "payments_not_configured" });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: getCatalog().currency || "usd",
            product_data: { name: `Muse House Bling — ${item.name}`, description: item.description },
            unit_amount: item.price_cents,
          },
          quantity: 1,
        },
      ],
      success_url: `${SITE_URL}/bling.html?bought=1&item=${encodeURIComponent(item.id)}${house ? `&house=${encodeURIComponent(house)}` : ""}`,
      cancel_url: `${SITE_URL}/bling.html?cancelled=1`,
      metadata: { bling_item_id: item.id, bling_item_name: item.name, bling_house: house || "(untagged)" },
    });
    return json(200, { url: session.url });
  } catch (e) {
    console.error("bling: checkout session creation failed:", String((e && e.message) || e));
    return json(502, { error: "checkout_failed" });
  }
}

async function notifyFulfillment({ itemName, amountTotal, currency, customerEmail, sessionId, house, deliverable, skill }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error("bling: RESEND_API_KEY missing — cannot notify fulfillment");
    return;
  }
  const to = process.env.BLING_TO || process.env.FEEDBACK_TO || "support@mymuse.house";
  const from = process.env.FEEDBACK_FROM || "Muse House <feedback@mymuse.house>";
  const amount = ((amountTotal || 0) / 100).toFixed(2);
  const deliverLine = deliverable
    ? `\nDeliver it here: ${SITE_URL}${deliverable}\n`
    : `\nMade-to-order: reply to the customer email to arrange delivery.\n`;
  const skillLine = skill
    ? `\nSkill: ${skill} — the buyer's Bling room can call the install_skill MCP tool with skill_id="${skill}" and session_id="${sessionId}" (paid Stripe Checkout session required; dev grants do not unlock skill files).\n`
    : "";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [to],
        subject: `[Muse House Bling] Order: ${itemName} (${house || "untagged"})`,
        text:
          `A Bling delight was purchased.\n\n` +
          `Item: ${itemName}\n` +
          `House: ${house || "(no house tag given)"}\n` +
          `Amount: $${amount} ${String(currency || "usd").toUpperCase()}\n` +
          `Customer email: ${customerEmail || "(not provided)"}\n` +
          `Stripe session: ${sessionId}\n` + deliverLine + skillLine +
          `\n—\nSent via Muse House Bling`,
      }),
    });
    if (!res.ok) console.error("bling: fulfillment email rejected, status", res.status);
  } catch (e) {
    console.error("bling: fulfillment email failed:", String((e && e.message) || e));
  }
}

/**
 * GET /api/bling/orders?token=… — the order feed rooms poll.
 *
 * Token-protected (BLING_API_TOKEN env): returns recent completed
 * checkouts so a Bling room knows what its human bought without asking.
 * Stateless proxy over Stripe — nothing stored. Only order metadata
 * (item, amount, house tag); card data never exists here.
 */
function tokensEqual(a, b) {
  const ab = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export async function handleBlingOrders(searchParams) {
  const expected = process.env.BLING_API_TOKEN;
  if (!expected) return json(503, { error: "orders_not_configured" });
  const given = searchParams ? searchParams.get("token") : "";
  if (!tokensEqual(given, expected)) return json(401, { error: "unauthorized" });
  const stripe = await stripeClient().catch(() => null);
  if (!stripe) return json(503, { error: "payments_not_configured" });
  try {
    const sessions = await stripe.checkout.sessions.list({ limit: 25 });
    const items = getCatalog().items || [];
    const orders = sessions.data
      .filter((s) => s.payment_status === "paid" || s.status === "complete")
      .map((s) => {
        const itemId = (s.metadata || {}).bling_item_id || null;
        const item = items.find((i) => i.id === itemId);
        return {
          session_id: s.id,
          item_id: itemId,
          item_name: (s.metadata || {}).bling_item_name || null,
          skill: (item && item.skill) || null,
          payment_status: s.payment_status || null,
          house: (s.metadata || {}).bling_house && (s.metadata || {}).bling_house !== "(untagged)"
            ? s.metadata.bling_house
            : null,
          amount_cents: s.amount_total,
          currency: s.currency,
          email: (s.customer_details || {}).email || null,
          created: s.created,
        };
      })
      .sort((a, b) => b.created - a.created);
    return json(200, { orders });
  } catch (e) {
    console.error("bling: orders list failed:", String((e && e.message) || e));
    return json(502, { error: "orders_failed" });
  }
}

/**
 * POST /api/bling/dev/grant — dev backdoor. Grants an item without payment.
 *
 * Body: { dev_token, item_id, house?, email? }
 * Validates dev_token against BLING_DEV_TOKEN env (timing-safe), then runs
 * the same fulfillment path as a Stripe webhook (notifyFulfillment) with a
 * dev session id. Returns the deliverable URL directly for verification.
 * NOT for production use — gate with a strong token and rotate it.
 */
export async function handleBlingDevGrant(body) {
  const expected = process.env.BLING_DEV_TOKEN;
  if (!expected) return json(503, { error: "dev_grant_not_configured" });
  const given = body && body.dev_token;
  if (!tokensEqual(given, expected)) return json(401, { error: "unauthorized" });
  const itemId = body && body.item_id;
  if (!itemId) return json(400, { error: "missing_item_id" });
  const catalog = getCatalog();
  const item = (catalog.items || []).find((i) => i.id === itemId);
  if (!item) return json(404, { error: "unknown_item" });
  const house = (body && body.house) || "dev";
  const email = (body && body.email) || "dev@mymuse.house";
  const sessionId = `dev_${Date.now()}`;
  await notifyFulfillment({
    itemName: item.name,
    amountTotal: 0,
    currency: "usd",
    customerEmail: email,
    sessionId,
    house,
    deliverable: item.deliverable || "",
  });
  return json(200, {
    granted: true,
    item_id: item.id,
    item_name: item.name,
    house,
    deliverable: item.deliverable ? `${SITE_URL}${item.deliverable}` : null,
    session_id: sessionId,
  });
}

/**
 * POST /api/bling/webhook — raw body + Stripe-Signature header required.
 * Verifies the signature; on checkout.session.completed, pings the
 * fulfillment inbox. Always 200 to Stripe on verified events (even if the
 * email fails — the Stripe dashboard remains the source of truth).
 */
export async function handleBlingWebhook(rawBody, signature) {
  const stripe = await stripeClient().catch(() => null);
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!stripe || !whSecret) return json(503, { error: "payments_not_configured" });
  if (!signature) return json(400, { error: "missing_signature" });

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, whSecret);
  } catch (e) {
    console.error("bling: webhook signature verification failed");
    return json(400, { error: "bad_signature" });
  }

  if (event.type === "checkout.session.completed") {
    const s = event.data.object || {};
    const meta = s.metadata || {};
    const itemId = meta.bling_item_id || "?";
    const item = getCatalog().items.find((i) => i.id === itemId);
    console.log(`bling: order completed — ${itemId} (${s.id})`);
    await notifyFulfillment({
      itemName: meta.bling_item_name || itemId,
      amountTotal: s.amount_total,
      currency: s.currency,
      customerEmail: s.customer_details && s.customer_details.email,
      sessionId: s.id,
      house: meta.bling_house && meta.bling_house !== "(untagged)" ? meta.bling_house : "",
      deliverable: item && item.deliverable ? item.deliverable : "",
      skill: item && item.skill ? item.skill : "",
    });
  }
  return json(200, { received: true });
}

/**
 * verifySkillEntitlement — the purchase gate in front of install_skill.
 *
 * Stateless: nothing is stored here. The proof of purchase is the buyer's
 * Stripe Checkout session id (what /api/bling/orders and the fulfillment
 * email already carry). We ask Stripe for that session and only entitle when
 * ALL of these hold:
 *   - Stripe is configured on this deployment (otherwise: fail closed);
 *   - session_id looks like a real Checkout session (cs_live_… / cs_test_…);
 *     dev grants (dev_…) never unlock skill files;
 *   - Stripe returns the session with payment_status === "paid";
 *   - the session's bling_item_id is a catalog item whose `skill` is the
 *     requested skill_id.
 *
 * Honest limits: the session id is a bearer proof — anyone holding a paid
 * session id for that item can install the skill, and with no server state
 * there is no one-time redemption. Returns { ok: true, item, session_id } or
 * { ok: false, reason, message }.
 */
export async function verifySkillEntitlement({ skill_id = "", session_id = "" } = {}) {
  const skill = String(skill_id || "").trim();
  const sid = String(session_id || "").trim();
  const items = getCatalog().items || [];
  const skillItems = items.filter((i) => i.skill && i.skill === skill);
  if (!skill || !skillItems.length) {
    return { ok: false, reason: "unknown_skill", message: `no Bling catalog item sells skill \`${skill || "(empty)"}\`.` };
  }
  if (!sid) {
    return { ok: false, reason: "no_entitlement", message: "missing session_id — skill files are only returned for a paid Bling purchase (pass the Stripe Checkout session id from /api/bling/orders)." };
  }
  if (!/^cs_(live|test)_[A-Za-z0-9]{8,200}$/.test(sid)) {
    return { ok: false, reason: "no_entitlement", message: "session_id is not a Stripe Checkout session id (cs_live_… / cs_test_…). Dev grants and other ids do not unlock skill files." };
  }
  const stripe = await stripeClient().catch(() => null);
  if (!stripe) {
    return { ok: false, reason: "payments_not_configured", message: "payments are not configured on this deployment, so the purchase cannot be verified — no skill files returned." };
  }
  let s;
  try {
    s = await stripe.checkout.sessions.retrieve(sid);
  } catch (e) {
    console.error("bling: entitlement lookup failed:", String((e && e.message) || e));
    return { ok: false, reason: "no_entitlement", message: "that Checkout session could not be verified with Stripe — no skill files returned." };
  }
  if (!s || s.payment_status !== "paid") {
    return { ok: false, reason: "not_paid", message: `that Checkout session is not paid (payment_status: ${(s && s.payment_status) || "unknown"}) — no skill files returned.` };
  }
  const itemId = (s.metadata || {}).bling_item_id || "";
  const item = skillItems.find((i) => i.id === itemId);
  if (!item) {
    return { ok: false, reason: "wrong_item", message: `that purchase (${itemId || "unknown item"}) does not include skill \`${skill}\` — no skill files returned.` };
  }
  return { ok: true, item, session_id: s.id };
}
