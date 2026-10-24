import { randomUUID } from "node:crypto";
import type { Db } from "./db/index.js";
import { log } from "./http/log.js";
import { type PayPalClient, PayPalError } from "./paypal/client.js";
import {
  type CaptureResult,
  captureOrder,
  createDonationOrder,
  getOrderCapture,
} from "./paypal/orders.js";

export const MIN_DONATION_CENTS = 100;
export const MAX_DONATION_CENTS = 50_000;

export class DonationError extends Error {
  constructor(
    readonly code: "INVALID_AMOUNT" | "UNKNOWN_ORDER" | "AMOUNT_MISMATCH" | "CAPTURE_FAILED",
  ) {
    super(code);
  }
}

export async function startDonation(db: Db, pp: PayPalClient, amountCents: number) {
  if (
    !Number.isInteger(amountCents) ||
    amountCents < MIN_DONATION_CENTS ||
    amountCents > MAX_DONATION_CENTS
  ) {
    throw new DonationError("INVALID_AMOUNT");
  }
  const [seq] = await db.query<{ ref: string }>(
    `select 'D-' || lpad(nextval('donation_ref_seq')::text, 4, '0') as ref`,
  );
  const ref = seq!.ref;
  const order = await createDonationOrder(pp, {
    amountCents,
    donationRef: ref,
    requestKey: randomUUID(),
  });
  await db.query(
    `insert into donations (public_ref, paypal_order_id, amount_cents, status) values ($1, $2, $3, 'created')`,
    [ref, order.id, amountCents],
  );
  log.info("donation.order_created", { ref });
  return { ref, orderId: order.id };
}

const CAPTURE_STATUS: Record<string, string> = {
  COMPLETED: "captured",
  PENDING: "pending",
  DECLINED: "denied",
  FAILED: "denied",
};

async function applyCapture(db: Db, ref: string, expectedCents: number, c: CaptureResult) {
  const status = c.captureStatus ? CAPTURE_STATUS[c.captureStatus] : undefined;
  if (!status || !c.captureId) return null;
  if (c.amountCents !== expectedCents || (c.currency !== null && c.currency !== "USD")) {
    throw new DonationError("AMOUNT_MISMATCH");
  }
  await db.query(
    `update donations set status = $2, capture_id = $3,
            captured_at = case when $2 = 'captured' then coalesce(captured_at, now()) else captured_at end
      where public_ref = $1 and status <> 'refunded'`,
    [ref, status, c.captureId],
  );
  log.info("donation.capture", { ref, status });
  return status;
}

/** Captures an approved order we created. Idempotent; safe to call from the browser and the webhook. */
export async function captureDonation(db: Db, pp: PayPalClient, orderId: string) {
  const [d] = await db.query<{ public_ref: string; amount_cents: number; status: string }>(
    `select public_ref, amount_cents, status from donations where paypal_order_id = $1`,
    [orderId],
  );
  if (!d) throw new DonationError("UNKNOWN_ORDER");
  if (d.status === "captured" || d.status === "refunded")
    return { ref: d.public_ref, status: d.status };

  let result: CaptureResult;
  try {
    result = await captureOrder(pp, orderId);
  } catch (err) {
    // e.g. ORDER_ALREADY_CAPTURED after a webhook beat the browser: read the order and sync.
    if (!(err instanceof PayPalError)) throw err;
    log.warn("donation.capture_error", {
      ref: d.public_ref,
      httpStatus: err.httpStatus,
      debugId: err.debugId,
    });
    result = await getOrderCapture(pp, orderId);
  }
  const status = await applyCapture(db, d.public_ref, d.amount_cents, result);
  if (!status) throw new DonationError("CAPTURE_FAILED");
  return { ref: d.public_ref, status };
}

export async function markDonationByCapture(
  db: Db,
  captureId: string,
  orderId: string | null,
  status: string,
  amount?: { cents: number; currency: string },
) {
  // Never move backwards (a late PENDING/DENIED after COMPLETED), and only credit a capture whose
  // amount and currency match the order we created.
  await db.query(
    `update donations set status = $3, capture_id = coalesce(capture_id, $1),
            captured_at = case when $3 = 'captured' then coalesce(captured_at, now()) else captured_at end
      where (capture_id = $1 or ($2::text is not null and paypal_order_id = $2))
        and (status not in ('captured', 'refunded') or $3 = 'refunded')
        and ($3 <> 'captured' or ($4::int is not null and amount_cents = $4 and currency = $5))`,
    [captureId, orderId, status, amount?.cents ?? null, amount?.currency ?? null],
  );
}
