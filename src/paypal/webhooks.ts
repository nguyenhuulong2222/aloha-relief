/**
 * Webhook signature verification by postback.
 * https://developer.paypal.com/api/rest/webhooks/rest/  (POST /v1/notifications/verify-webhook-signature)
 * The docs require sending webhook_event exactly as received, so the raw body is spliced into the
 * request JSON byte-for-byte rather than parsed and re-serialized.
 */
import type { PayPalClient } from "./client.js";

export interface WebhookHeaders {
  authAlgo: string | undefined;
  certUrl: string | undefined;
  transmissionId: string | undefined;
  transmissionSig: string | undefined;
  transmissionTime: string | undefined;
}

export function readWebhookHeaders(get: (name: string) => string | undefined): WebhookHeaders {
  return {
    authAlgo: get("paypal-auth-algo"),
    certUrl: get("paypal-cert-url"),
    transmissionId: get("paypal-transmission-id"),
    transmissionSig: get("paypal-transmission-sig"),
    transmissionTime: get("paypal-transmission-time"),
  };
}

export async function verifyWebhookSignature(
  pp: PayPalClient,
  h: WebhookHeaders,
  rawBody: string,
  webhookId: string,
): Promise<boolean> {
  if (!h.authAlgo || !h.certUrl || !h.transmissionId || !h.transmissionSig || !h.transmissionTime) {
    return false;
  }
  // Only trust PayPal-hosted certs.
  let certHost: string;
  try {
    certHost = new URL(h.certUrl).hostname;
  } catch {
    return false;
  }
  if (!(certHost === "paypal.com" || certHost.endsWith(".paypal.com"))) return false;

  const head = JSON.stringify({
    auth_algo: h.authAlgo,
    cert_url: h.certUrl,
    transmission_id: h.transmissionId,
    transmission_sig: h.transmissionSig,
    transmission_time: h.transmissionTime,
    webhook_id: webhookId,
  });
  const body = `${head.slice(0, -1)},"webhook_event":${rawBody}}`;
  const res = await pp.request<{ verification_status?: string }>(
    "/v1/notifications/verify-webhook-signature",
    { method: "POST", body },
  );
  return res.verification_status === "SUCCESS";
}
