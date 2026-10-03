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
 *
 * Without STRIPE_SECRET_KEY every checkout attempt returns
 * { error: "payments_not_configured" } — the shop shows "coming soon"
 * instead of breaking. Card numbers never touch this service: Stripe
 * Checkout hosts the payment form; we only ever see session ids.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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
 * POST /api/bling/checkout — body: { item_id }.
 * Returns { url } (the Stripe Checkout page) or an honest error.
 */
export async function handleBlingCheckout(body) {
  const itemId = body && typeof body.item_id === "string" ? body.item_id : "";
  const item = getCatalog().items.find((i) => i.id === itemId);
  if (!item) return json(400, { error: "unknown_item" });
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
      success_url: `${SITE_URL}/bling.html?bought=1&item=${encodeURIComponent(item.id)}`,
      cancel_url: `${SITE_URL}/bling.html?cancelled=1`,
      metadata: { bling_item_id: item.id, bling_item_name: item.name },
    });
    return json(200, { url: session.url });
  } catch (e) {
    console.error("bling: checkout session creation failed:", String((e && e.message) || e));
    return json(502, { error: "checkout_failed" });
  }
}

async function notifyFulfillment({ itemName, amountTotal, currency, customerEmail, sessionId }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error("bling: RESEND_API_KEY missing — cannot notify fulfillment");
    return;
  }
  const to = process.env.BLING_TO || process.env.FEEDBACK_TO || "support@mymuse.house";
  const from = process.env.FEEDBACK_FROM || "Muse House <feedback@mymuse.house>";
  const amount = ((amountTotal || 0) / 100).toFixed(2);
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [to],
        subject: `[Muse House Bling] Order: ${itemName}`,
        text:
          `A Bling delight was purchased.\n\n` +
          `Item: ${itemName}\n` +
          `Amount: $${amount} ${String(currency || "usd").toUpperCase()}\n` +
          `Customer email: ${customerEmail || "(not provided)"}\n` +
          `Stripe session: ${sessionId}\n\n` +
          `Fulfill it: deliver the delight to the customer email above.\n\n—\nSent via Muse House Bling`,
      }),
    });
    if (!res.ok) console.error("bling: fulfillment email rejected, status", res.status);
  } catch (e) {
    console.error("bling: fulfillment email failed:", String((e && e.message) || e));
  }
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
    console.log(`bling: order completed — ${meta.bling_item_id || "?"} (${s.id})`);
    await notifyFulfillment({
      itemName: meta.bling_item_name || meta.bling_item_id || "unknown item",
      amountTotal: s.amount_total,
      currency: s.currency,
      customerEmail: s.customer_details && s.customer_details.email,
      sessionId: s.id,
    });
  }
  return json(200, { received: true });
}
