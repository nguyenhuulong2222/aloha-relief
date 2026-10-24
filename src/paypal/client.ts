/**
 * Minimal PayPal REST client (sandbox only).
 * OAuth 2.0 client credentials: POST /v1/oauth2/token
 * https://developer.paypal.com/api/rest/authentication/
 */
export const PAYPAL_SANDBOX_API = "https://api-m.sandbox.paypal.com";

export class PayPalError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly name_: string | undefined,
    readonly debugId: string | undefined,
    readonly details: unknown,
  ) {
    super(message);
  }
}

export interface PayPalClientOptions {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface PayPalRequest {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** JSON-serializable body, or a pre-serialized JSON string (sent byte-for-byte). */
  body?: unknown;
  requestId?: string;
}

export interface PayPalClient {
  request<T>(path: string, req?: PayPalRequest): Promise<T>;
}

export function createPayPalClient(opts: PayPalClientOptions): PayPalClient {
  const baseUrl = opts.baseUrl ?? PAYPAL_SANDBOX_API;
  const doFetch = opts.fetch ?? fetch;
  let token: { value: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    if (token && Date.now() < token.expiresAt) return token.value;
    const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64");
    const res = await doFetch(`${baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
    });
    const json = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
    };
    if (!res.ok || !json.access_token) {
      throw new PayPalError("PayPal auth failed", res.status, json.error, undefined, undefined);
    }
    // Refresh a minute early.
    token = {
      value: json.access_token,
      expiresAt: Date.now() + ((json.expires_in ?? 300) - 60) * 1000,
    };
    return token.value;
  }

  return {
    async request<T>(path: string, req: PayPalRequest = {}): Promise<T> {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${await accessToken()}`,
        Accept: "application/json",
      };
      let body: string | undefined;
      if (req.body !== undefined) {
        headers["Content-Type"] = "application/json";
        body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      }
      if (req.requestId) headers["PayPal-Request-Id"] = req.requestId;
      const res = await doFetch(`${baseUrl}${path}`, {
        method: req.method ?? "GET",
        headers,
        body,
      });
      const text = await res.text();
      const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      if (!res.ok) {
        throw new PayPalError(
          `PayPal ${req.method ?? "GET"} ${path.split("?")[0]} failed`,
          res.status,
          typeof json.name === "string" ? json.name : undefined,
          (typeof json.debug_id === "string" ? json.debug_id : undefined) ??
            res.headers.get("paypal-debug-id") ??
            undefined,
          json.details,
        );
      }
      return json as T;
    },
  };
}
