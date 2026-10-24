import type { Db } from "../db/index.js";

/** PayPal payout item transaction_status -> our payout status. */
export function mapItemStatus(s: string | undefined): string | null {
  switch (s) {
    case "SUCCESS":
      return "succeeded";
    case "PENDING":
      return "pending";
    case "UNCLAIMED":
      return "unclaimed";
    case "ONHOLD":
      return "held";
    case "FAILED":
      return "failed";
    case "RETURNED":
    case "REVERSED":
      return "returned";
    case "REFUNDED":
      return "refunded";
    case "BLOCKED":
      return "blocked";
    default:
      return null;
  }
}

/** Webhook event type -> our payout status. https://developer.paypal.com/api/rest/webhooks/event-names/ */
export const PAYOUT_EVENT_STATUS: Record<string, string> = {
  "PAYMENT.PAYOUTS-ITEM.SUCCEEDED": "succeeded",
  "PAYMENT.PAYOUTS-ITEM.UNCLAIMED": "unclaimed",
  "PAYMENT.PAYOUTS-ITEM.HELD": "held",
  "PAYMENT.PAYOUTS-ITEM.FAILED": "failed",
  "PAYMENT.PAYOUTS-ITEM.BLOCKED": "blocked",
  "PAYMENT.PAYOUTS-ITEM.RETURNED": "returned",
  "PAYMENT.PAYOUTS-ITEM.REFUNDED": "refunded",
  "PAYMENT.PAYOUTS-ITEM.CANCELED": "canceled",
  "PAYMENT.PAYOUTSBATCH.DENIED": "denied",
  "PAYMENT.PAYOUTSBATCH.PROCESSING": "processing",
};

const REQUEST_STATUS: Record<string, string> = {
  succeeded: "paid",
  unclaimed: "paid",
  failed: "failed",
  returned: "failed",
  refunded: "failed",
  blocked: "failed",
  canceled: "failed",
  denied: "failed",
};

/** Final states never move backwards when a late or out-of-order event arrives. */
const FINAL = new Set([
  "succeeded",
  "failed",
  "returned",
  "refunded",
  "blocked",
  "canceled",
  "denied",
]);

export async function applyPayoutStatus(
  db: Db,
  key: { payoutBatchId?: string | null; payoutItemId?: string | null },
  status: string,
): Promise<string | null> {
  return db.tx(async (t) => {
    const [p] = await t.query<{
      id: string;
      request_id: string;
      status: string;
      payout_item_id: string | null;
    }>(
      `select id, request_id, status, payout_item_id from payouts
        where ($1::text is not null and payout_batch_id = $1) or ($2::text is not null and payout_item_id = $2)
        limit 1 for update`,
      [key.payoutBatchId ?? null, key.payoutItemId ?? null],
    );
    if (!p) return null;
    const keepFinal =
      (FINAL.has(p.status) && status !== "returned" && status !== "refunded") ||
      // A late batch PROCESSING must not overwrite a more specific item state.
      (status === "processing" && !["creating", "pending"].includes(p.status));
    if (p.status === status || keepFinal) {
      if (key.payoutItemId && !p.payout_item_id) {
        await t.query(`update payouts set payout_item_id = $2 where id = $1`, [
          p.id,
          key.payoutItemId,
        ]);
      }
    } else {
      await t.query(
        `update payouts set status = $2, payout_item_id = coalesce(payout_item_id, $3), updated_at = now() where id = $1`,
        [p.id, status, key.payoutItemId ?? null],
      );
      const rs = REQUEST_STATUS[status];
      if (rs)
        await t.query(`update requests set status = $2, updated_at = now() where id = $1`, [
          p.request_id,
          rs,
        ]);
    }
    return p.request_id;
  });
}
