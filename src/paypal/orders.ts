/**
 * Orders v2: create + capture for donations.
 * https://developer.paypal.com/docs/api/orders/v2/  (create: POST /v2/checkout/orders,
 * capture: POST /v2/checkout/orders/{id}/capture). Amounts are always set server-side.
 */
import type { PayPalClient } from "./client.js";

export function centsToValue(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** "12.34" -> 1234. Strict: anything that isn't a plain decimal amount becomes NaN. */
export function valueToCents(value: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return Number.NaN;
  const [whole = "0", frac = ""] = value.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

export interface CreatedOrder {
  id: string;
  status: string;
}

export async function createDonationOrder(
  pp: PayPalClient,
  args: { amountCents: number; donationRef: string },
): Promise<CreatedOrder> {
  return pp.request<CreatedOrder>("/v2/checkout/orders", {
    method: "POST",
    requestId: `order-${args.donationRef}`,
    body: {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: args.donationRef,
          custom_id: args.donationRef,
          description: "Donation to Kanaloa Relief Fund (fictional demo, sandbox)",
          amount: { currency_code: "USD", value: centsToValue(args.amountCents) },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: "Kanaloa Relief Fund (demo)",
            shipping_preference: "NO_SHIPPING",
            user_action: "PAY_NOW",
          },
        },
      },
    },
  });
}

export interface CaptureResult {
  orderId: string;
  orderStatus: string;
  captureId: string | null;
  captureStatus: string | null;
  amountCents: number | null;
  currency: string | null;
}

interface OrderCaptureResponse {
  id: string;
  status: string;
  purchase_units?: Array<{
    payments?: {
      captures?: Array<{
        id: string;
        status: string;
        amount?: { value: string; currency_code?: string };
      }>;
    };
  }>;
}

export async function captureOrder(pp: PayPalClient, orderId: string): Promise<CaptureResult> {
  const res = await pp.request<OrderCaptureResponse>(
    `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`,
    { method: "POST", requestId: `capture-${orderId}`, body: {} },
  );
  const cap = res.purchase_units?.[0]?.payments?.captures?.[0];
  return {
    orderId: res.id,
    orderStatus: res.status,
    captureId: cap?.id ?? null,
    captureStatus: cap?.status ?? null,
    amountCents: cap?.amount ? valueToCents(cap.amount.value) : null,
    currency: cap?.amount?.currency_code ?? null,
  };
}

export async function getOrderCapture(pp: PayPalClient, orderId: string): Promise<CaptureResult> {
  const res = await pp.request<OrderCaptureResponse>(
    `/v2/checkout/orders/${encodeURIComponent(orderId)}`,
  );
  const cap = res.purchase_units?.[0]?.payments?.captures?.[0];
  return {
    orderId: res.id,
    orderStatus: res.status,
    captureId: cap?.id ?? null,
    captureStatus: cap?.status ?? null,
    amountCents: cap?.amount ? valueToCents(cap.amount.value) : null,
    currency: cap?.amount?.currency_code ?? null,
  };
}
