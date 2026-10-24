/**
 * Registers (or finds) the PayPal sandbox webhook for a public URL and prints its webhook ID.
 * Webhooks Management API: https://developer.paypal.com/docs/api/webhooks/v1/
 *   list:   GET    /v1/notifications/webhooks
 *   create: POST   /v1/notifications/webhooks   { url, event_types: [{ name }] }
 *   delete: DELETE /v1/notifications/webhooks/{id}   (use --delete)
 * Usage: PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... npx tsx scripts/register-webhook.ts https://host/api/webhooks/paypal [--delete]
 * The webhook ID is an identifier, not a secret.
 */
import { createPayPalClient } from "../src/paypal/client.js";

export const EVENT_TYPES = [
  "CHECKOUT.ORDER.APPROVED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.PENDING",
  "PAYMENT.CAPTURE.DENIED",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
  "PAYMENT.PAYOUTSBATCH.PROCESSING",
  "PAYMENT.PAYOUTSBATCH.SUCCESS",
  "PAYMENT.PAYOUTSBATCH.DENIED",
  "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
  "PAYMENT.PAYOUTS-ITEM.FAILED",
  "PAYMENT.PAYOUTS-ITEM.BLOCKED",
  "PAYMENT.PAYOUTS-ITEM.CANCELED",
  "PAYMENT.PAYOUTS-ITEM.HELD",
  "PAYMENT.PAYOUTS-ITEM.REFUNDED",
  "PAYMENT.PAYOUTS-ITEM.RETURNED",
  "PAYMENT.PAYOUTS-ITEM.UNCLAIMED",
];

const [url, flag] = process.argv.slice(2);
if (!url?.startsWith("https://")) {
  console.error("Pass the public https URL of /api/webhooks/paypal");
  process.exit(1);
}
const pp = createPayPalClient({
  clientId: process.env.PAYPAL_CLIENT_ID ?? "",
  clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? "",
});

type Hook = { id: string; url: string };
const { webhooks } = await pp.request<{ webhooks: Hook[] }>("/v1/notifications/webhooks");
const existing = webhooks.find((w) => w.url === url);

if (flag === "--delete") {
  if (existing) await pp.request(`/v1/notifications/webhooks/${existing.id}`, { method: "DELETE" });
  console.log(existing ? `Deleted ${existing.id}` : "No webhook for that URL.");
} else if (existing) {
  console.log(existing.id);
} else {
  const created = await pp.request<Hook>("/v1/notifications/webhooks", {
    method: "POST",
    body: { url, event_types: EVENT_TYPES.map((name) => ({ name })) },
  });
  console.log(created.id);
}
