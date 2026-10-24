import type { TriageProvider } from "../src/ai/provider.js";
import type { TriageResult } from "../src/ai/schema.js";
import { createApp } from "../src/app.js";
import { connectPglite, type Db } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { type PayPalClient, PayPalError, type PayPalRequest } from "../src/paypal/client.js";

export async function makeDb(): Promise<Db> {
  const db = await connectPglite();
  await migrate(db);
  return db;
}

type Handler = (req: PayPalRequest, path: string) => unknown;

export interface FakePayPal extends PayPalClient {
  calls: Array<{ method: string; path: string; req: PayPalRequest }>;
  on(method: string, pathPrefix: string, h: Handler): void;
}

export function fakePayPal(): FakePayPal {
  const handlers: Array<{ method: string; prefix: string; h: Handler }> = [];
  const calls: FakePayPal["calls"] = [];
  return {
    calls,
    on(method, prefix, h) {
      handlers.unshift({ method, prefix, h });
    },
    async request<T>(path: string, req: PayPalRequest = {}) {
      const method = req.method ?? "GET";
      calls.push({ method, path, req });
      const match = handlers.find((x) => x.method === method && path.startsWith(x.prefix));
      if (!match)
        throw new PayPalError(
          `no fake for ${method} ${path}`,
          500,
          "FAKE_MISSING",
          undefined,
          undefined,
        );
      return (await match.h(req, path)) as T;
    },
  };
}

export const paypalError = (status: number, name: string) =>
  new PayPalError("fake", status, name, "dbg", undefined);

export function goodTriage(over: Partial<TriageResult> = {}): TriageResult {
  return {
    urgency: 5,
    urgency_reason: "Family has no shelter tonight.",
    summary: "Family of four lost their rental and needs two weeks of motel stay.",
    flag_explanations: [],
    injection_detected: false,
    injection_note: "",
    recommendation: "approve",
    recommendation_reason: "Clear, urgent shelter need within the cap.",
    questions_for_requester: [],
    ...over,
  };
}

export function fakeProvider(
  fn: () => TriageResult | null = () => goodTriage(),
): TriageProvider & { calls: number; lastUser: string } {
  const p = {
    model: "fake-model",
    calls: 0,
    lastUser: "",
    cost: () => 0.0005,
    async triage(_system: string, user: string) {
      p.calls++;
      p.lastUser = user;
      const result = fn();
      const usage = { inputTokens: 1000, outputTokens: 300 };
      return result
        ? { ok: true as const, result, usage, model: "fake-model" }
        : { ok: false as const, reason: "schema_mismatch", usage, model: "fake-model" };
    },
  };
  return p;
}

export const TEST_CONFIG = {
  PAYPAL_CLIENT_ID: "test-client-id-123",
  PAYPAL_WEBHOOK_ID: "WH-TEST",
  REVIEWER_PASSCODE: "test-passcode",
  SESSION_SECRET: "s".repeat(40),
  HASH_SALT: "salt-salt-salt-salt",
  AI_DAILY_CAP_USD: 0.5,
  AI_TOTAL_CAP_USD: 4,
  DAILY_PAYOUT_CAP_CENTS: 300_000,
  PER_GRANT_CAP_CENTS: 40_000,
  PUBLIC_BASE_URL: "http://localhost:3000",
  NODE_ENV: "test" as const,
};

export function makeApp(
  db: Db,
  pp: PayPalClient,
  provider: TriageProvider | null = fakeProvider(),
) {
  const pending: Promise<unknown>[] = [];
  const app = createApp({
    db,
    pp,
    provider,
    config: TEST_CONFIG,
    background: (p) => pending.push(p),
  });
  return { app, settle: () => Promise.all(pending.splice(0)) };
}

export async function fundWith(db: Db, cents: number) {
  await db.query(
    `insert into donations (paypal_order_id, capture_id, amount_cents, status, captured_at)
     values ('ORDER' || md5(random()::text), 'CAP' || md5(random()::text), $1, 'captured', now())`,
    [cents],
  );
}

export const VALID_REQUEST = {
  needType: "shelter",
  island: "maui",
  amountUsd: 350,
  description: "Our rental in Lahaina burned. We need two weeks at a motel for a family of four.",
  payeeEmail: "keala.demo@personal.example.com",
  lang: "en",
  consent: true,
};
