/**
 * THE ONLY PATH TO MONEY OUT. This is the sole module allowed to import ../paypal/payouts.js
 * (test/payout-guard.test.ts fails the build otherwise). A payout is created only for an
 * 'approve' decision recorded by a named reviewer with a reason, for a request no hard rule blocks.
 * The database trigger payouts_require_approval enforces the same thing a second time.
 */
import type { Db } from "../db/index.js";
import { availableCents } from "../fund.js";
import { log } from "../http/log.js";
import { type PayPalClient, PayPalError } from "../paypal/client.js";
import { createPayout, getPayoutBatch } from "../paypal/payouts.js";
import { NEED_CAPS, type NeedType } from "../rules/engine.js";
import { applyPayoutStatus, mapItemStatus } from "./payout-status.js";

export type GuardCode =
  | "NO_APPROVAL"
  | "NOT_APPROVED_STATE"
  | "BLOCKED"
  | "ALREADY_PAID"
  | "INSUFFICIENT_FUNDS"
  | "DAILY_CAP"
  | "GRANT_CAP";

export class GuardError extends Error {
  constructor(readonly code: GuardCode) {
    super(code);
  }
}

export interface PayResult {
  payoutId: string;
  status: string;
  errorCode: string | null;
}

interface Reserved {
  payoutId: string;
  senderBatchId: string;
  publicRef: string;
  payeeEmail: string;
  amountCents: number;
}

export interface GuardLimits {
  /** Max total paid out per UTC day (public-demo safety). */
  dailyCapCents: number;
  /** Max per single grant, on top of the per-need cap (public-demo safety). */
  perGrantCapCents?: number;
}

async function reserve(db: Db, approvalId: string, limits: GuardLimits): Promise<Reserved> {
  return db.tx(async (t) => {
    await t.query(`select pg_advisory_xact_lock(4242002)`);
    const [a] = await t.query<{
      approval_id: string;
      decision: string;
      reviewer_name: string;
      reason: string;
      request_id: string;
      status: string;
      public_ref: string;
      payee_email: string;
      amount_cents: number;
      need_type: NeedType;
      blocked: boolean;
      has_payout: boolean;
    }>(
      `select a.id as approval_id, a.decision, a.reviewer_name, a.reason, r.id as request_id, r.status,
              r.public_ref, r.payee_email, r.amount_cents, r.need_type,
              exists (select 1 from rule_results x where x.request_id = r.id and x.outcome = 'block') as blocked,
              exists (select 1 from payouts p where p.request_id = r.id) as has_payout
         from approvals a join requests r on r.id = a.request_id
        where a.id = $1
        for update of r`,
      [approvalId],
    );
    if (a?.decision !== "approve" || !a.reviewer_name.trim() || a.reason.trim().length < 3) {
      throw new GuardError("NO_APPROVAL");
    }
    if (a.blocked) throw new GuardError("BLOCKED");
    if (a.has_payout) throw new GuardError("ALREADY_PAID");
    if (a.status !== "approved") throw new GuardError("NOT_APPROVED_STATE");
    // Re-check the amount here, independently of rule R1: the guard trusts nothing upstream.
    const grantCap = Math.min(
      NEED_CAPS[a.need_type] ?? 0,
      limits.perGrantCapCents ?? Number.POSITIVE_INFINITY,
    );
    if (!(a.amount_cents > 0) || a.amount_cents > grantCap) throw new GuardError("GRANT_CAP");
    if ((await availableCents(t)) < a.amount_cents) throw new GuardError("INSUFFICIENT_FUNDS");
    const [today] = await t.query<{ cents: number }>(
      `select coalesce(sum(amount_cents), 0)::int as cents from payouts
        where created_at >= date_trunc('day', now()) and is_seed = false
          and status not in ('failed', 'denied', 'canceled', 'blocked')`,
    );
    if ((today?.cents ?? 0) + a.amount_cents > limits.dailyCapCents)
      throw new GuardError("DAILY_CAP");

    const senderBatchId = `AR-${a.public_ref}-${approvalId.slice(0, 8)}`;
    const [p] = await t.query<{ id: string }>(
      `insert into payouts (request_id, approval_id, amount_cents, sender_batch_id) values ($1, $2, $3, $4) returning id`,
      [a.request_id, approvalId, a.amount_cents, senderBatchId],
    );
    await t.query(`update requests set status = 'paying', updated_at = now() where id = $1`, [
      a.request_id,
    ]);
    return {
      payoutId: p!.id,
      senderBatchId,
      publicRef: a.public_ref,
      payeeEmail: a.payee_email,
      amountCents: a.amount_cents,
    };
  });
}

/** Sends (or re-sends, idempotently by sender_batch_id) the PayPal payout for a reserved row. */
async function send(db: Db, pp: PayPalClient, r: Reserved): Promise<PayResult> {
  try {
    const created = await createPayout(pp, {
      senderBatchId: r.senderBatchId,
      senderItemId: r.publicRef,
      receiverEmail: r.payeeEmail,
      amountCents: r.amountCents,
      note: `Relief grant ${r.publicRef} from Kanaloa Relief Fund (fictional demo).`,
    });
    const batchId = created.batch_header.payout_batch_id;
    await db.query(
      `update payouts set payout_batch_id = $2, status = 'pending', error_code = null, updated_at = now() where id = $1`,
      [r.payoutId, batchId],
    );
    log.info("payout.created", { ref: r.publicRef, status: created.batch_header.batch_status });
    await refreshBatch(db, pp, batchId).catch(() => {});
    const [row] = await db.query<{ status: string }>(`select status from payouts where id = $1`, [
      r.payoutId,
    ]);
    return { payoutId: r.payoutId, status: row?.status ?? "pending", errorCode: null };
  } catch (err) {
    const pe = err instanceof PayPalError ? err : null;
    const code = pe?.name_ ?? "NETWORK_ERROR";
    // 4xx is a definitive refusal from PayPal. Anything else may have gone through: keep the row in
    // 'creating' so reconcile retries with the same sender_batch_id (PayPal dedupes it).
    const definitive = pe !== null && pe.httpStatus >= 400 && pe.httpStatus < 500;
    await db.query(
      `update payouts set status = $2, error_code = $3, updated_at = now() where id = $1`,
      [r.payoutId, definitive ? "failed" : "creating", code],
    );
    if (definitive) {
      await db.query(
        `update requests set status = 'failed', updated_at = now() where id = (select request_id from payouts where id = $1)`,
        [r.payoutId],
      );
    }
    log.error("payout.error", {
      ref: r.publicRef,
      code,
      httpStatus: pe?.httpStatus,
      debugId: pe?.debugId,
    });
    return { payoutId: r.payoutId, status: definitive ? "failed" : "creating", errorCode: code };
  }
}

export async function payApprovedGrant(
  db: Db,
  pp: PayPalClient,
  approvalId: string,
  limits: GuardLimits,
): Promise<PayResult> {
  const reserved = await reserve(db, approvalId, limits);
  return send(db, pp, reserved);
}

/** Pulls item status for a batch and applies it (used when webhooks are late or missed). */
export async function refreshBatch(db: Db, pp: PayPalClient, batchId: string): Promise<void> {
  const batch = await getPayoutBatch(pp, batchId);
  const item = batch.items?.[0];
  if (batch.batch_header.batch_status === "DENIED") {
    await applyPayoutStatus(db, { payoutBatchId: batchId }, "denied");
    return;
  }
  const status = mapItemStatus(item?.transaction_status);
  if (item) {
    await db.query(
      `update payouts set payout_item_id = coalesce(payout_item_id, $2) where payout_batch_id = $1`,
      [batchId, item.payout_item_id],
    );
  }
  if (status) await applyPayoutStatus(db, { payoutBatchId: batchId }, status);
}

/** Retries stuck creates and refreshes in-flight payouts. Safe to run repeatedly. */
export async function reconcilePayouts(db: Db, pp: PayPalClient): Promise<number> {
  const rows = await db.query<{
    id: string;
    payout_batch_id: string | null;
    sender_batch_id: string;
    public_ref: string;
    payee_email: string;
    amount_cents: number;
  }>(
    `select p.id, p.payout_batch_id, p.sender_batch_id, r.public_ref, r.payee_email, p.amount_cents
       from payouts p join requests r on r.id = p.request_id
      where p.is_seed = false and p.status in ('creating', 'pending', 'processing', 'unclaimed', 'held')
        and p.updated_at < now() - interval '30 seconds'
      limit 20`,
  );
  for (const p of rows) {
    try {
      if (!p.payout_batch_id) {
        await send(db, pp, {
          payoutId: p.id,
          senderBatchId: p.sender_batch_id,
          publicRef: p.public_ref,
          payeeEmail: p.payee_email,
          amountCents: p.amount_cents,
        });
      } else {
        await refreshBatch(db, pp, p.payout_batch_id);
      }
    } catch (err) {
      const pe = err instanceof PayPalError ? err : null;
      log.warn("payout.reconcile_error", {
        ref: p.public_ref,
        httpStatus: pe?.httpStatus,
        debugId: pe?.debugId,
      });
    }
  }
  return rows.length;
}
