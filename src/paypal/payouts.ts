/**
 * Payouts v1. ONLY src/grants/payout-guard.ts may import this module (enforced by a test).
 * https://developer.paypal.com/docs/payouts/standard/integrate-api/ (updated 2026-09-10)
 *   create: POST /v1/payments/payouts      (sender_batch_id gives idempotency)
 *   batch:  GET  /v1/payments/payouts/{payout_batch_id}
 *   item:   GET  /v1/payments/payouts-item/{payout_item_id}
 */
import type { PayPalClient } from "./client.js";
import { centsToValue } from "./orders.js";

export interface PayoutArgs {
  senderBatchId: string;
  senderItemId: string;
  receiverEmail: string;
  amountCents: number;
  note: string;
}

export interface PayoutBatchCreated {
  batch_header: { payout_batch_id: string; batch_status: string };
}

export async function createPayout(pp: PayPalClient, a: PayoutArgs): Promise<PayoutBatchCreated> {
  return pp.request<PayoutBatchCreated>("/v1/payments/payouts", {
    method: "POST",
    requestId: a.senderBatchId,
    body: {
      sender_batch_header: {
        sender_batch_id: a.senderBatchId,
        email_subject: "You have a relief grant from Kanaloa Relief Fund (demo)",
        email_message: "A volunteer approved your request. This is a sandbox demo.",
      },
      items: [
        {
          recipient_type: "EMAIL",
          receiver: a.receiverEmail,
          amount: { currency: "USD", value: centsToValue(a.amountCents) },
          note: a.note,
          sender_item_id: a.senderItemId,
          recipient_wallet: "PAYPAL",
        },
      ],
    },
  });
}

export interface PayoutBatch {
  batch_header: { payout_batch_id: string; batch_status: string };
  items?: Array<{ payout_item_id: string; transaction_status?: string }>;
}

export async function getPayoutBatch(pp: PayPalClient, batchId: string): Promise<PayoutBatch> {
  return pp.request<PayoutBatch>(`/v1/payments/payouts/${encodeURIComponent(batchId)}`);
}
