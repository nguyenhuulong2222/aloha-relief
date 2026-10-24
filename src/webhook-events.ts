/**
 * PayPal webhook processing. Events: https://developer.paypal.com/api/rest/webhooks/event-names/
 * Verified by postback before anything is read. Idempotent per event id.
 */
import type { Db } from "./db/index.js";
import { captureDonation, markDonationByCapture } from "./donations.js";
import { applyPayoutStatus, PAYOUT_EVENT_STATUS } from "./grants/payout-status.js";
import { log } from "./http/log.js";
import type { PayPalClient } from "./paypal/client.js";
import { valueToCents } from "./paypal/orders.js";
import { verifyWebhookSignature, type WebhookHeaders } from "./paypal/webhooks.js";

interface WebhookEvent {
  id?: string;
  event_type?: string;
  resource?: Record<string, unknown>;
}

const str = (v: unknown) => (typeof v === "string" ? v : null);

function upLinkId(resource: Record<string, unknown>, segment: string): string | null {
  const links = Array.isArray(resource.links)
    ? (resource.links as Array<{ rel?: string; href?: string }>)
    : [];
  for (const l of links) {
    if (l.rel === "up" && l.href) {
      const m = l.href.match(new RegExp(`/${segment}/([^/?]+)`));
      if (m?.[1]) return m[1];
    }
  }
  return null;
}

export type WebhookOutcome = { http: 200 | 400 | 503; note: string };

export async function handleWebhook(
  db: Db,
  pp: PayPalClient,
  webhookId: string | undefined,
  headers: WebhookHeaders,
  rawBody: string,
): Promise<WebhookOutcome> {
  if (!webhookId) return { http: 503, note: "webhook id not configured" };
  let event: WebhookEvent;
  try {
    event = JSON.parse(rawBody) as WebhookEvent;
  } catch {
    return { http: 400, note: "invalid json" };
  }
  if (!event.id || !event.event_type || !event.resource)
    return { http: 400, note: "missing fields" };

  const verified = await verifyWebhookSignature(pp, headers, rawBody, webhookId).catch(() => false);
  if (!verified) {
    log.warn("webhook.unverified", { eventType: event.event_type });
    return { http: 400, note: "signature not verified" };
  }

  const seen = await db.query(`select 1 from webhook_events where event_id = $1`, [event.id]);
  if (seen.length > 0) return { http: 200, note: "duplicate" };

  const type = event.event_type;
  const r = event.resource;
  let resourceId: string | null = str(r.id);

  if (type === "CHECKOUT.ORDER.APPROVED" && resourceId) {
    // The donor approved but the browser may have closed before capture: capture server-side.
    await captureDonation(db, pp, resourceId).catch((e: Error) =>
      log.warn("webhook.order_capture_skipped", { reason: e.message }),
    );
  } else if (
    type === "PAYMENT.CAPTURE.COMPLETED" ||
    type === "PAYMENT.CAPTURE.PENDING" ||
    type === "PAYMENT.CAPTURE.DENIED" ||
    type === "PAYMENT.CAPTURE.DECLINED"
  ) {
    const related = (r.supplementary_data as { related_ids?: { order_id?: string } } | undefined)
      ?.related_ids;
    const status = type.endsWith("COMPLETED")
      ? "captured"
      : type.endsWith("PENDING")
        ? "pending"
        : "denied";
    const amt = r.amount as { value?: string; currency_code?: string } | undefined;
    const amount =
      amt?.value && amt.currency_code
        ? { cents: valueToCents(amt.value), currency: amt.currency_code }
        : undefined;
    if (resourceId)
      await markDonationByCapture(db, resourceId, related?.order_id ?? null, status, amount);
  } else if (type === "PAYMENT.CAPTURE.REFUNDED" || type === "PAYMENT.CAPTURE.REVERSED") {
    const captureId = upLinkId(r, "captures") ?? resourceId;
    if (captureId) await markDonationByCapture(db, captureId, null, "refunded");
    resourceId = captureId;
  } else if (PAYOUT_EVENT_STATUS[type]) {
    const status = PAYOUT_EVENT_STATUS[type]!;
    if (type.startsWith("PAYMENT.PAYOUTSBATCH.")) {
      const batchId = str((r.batch_header as Record<string, unknown> | undefined)?.payout_batch_id);
      if (batchId) await applyPayoutStatus(db, { payoutBatchId: batchId }, status);
      resourceId = batchId;
    } else {
      const itemId = str(r.payout_item_id);
      const batchId = str(r.payout_batch_id);
      await applyPayoutStatus(db, { payoutBatchId: batchId, payoutItemId: itemId }, status);
      resourceId = itemId;
    }
  }

  await db.query(
    `insert into webhook_events (event_id, event_type, resource_id) values ($1, $2, $3) on conflict do nothing`,
    [event.id, type, resourceId],
  );
  log.info("webhook.processed", { eventType: type });
  return { http: 200, note: "ok" };
}
