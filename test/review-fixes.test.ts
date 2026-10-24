/** Regression tests for issues found in the independent code review before Gate 2. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/index.js";
import { recordDecision } from "../src/grants/decide.js";
import { payApprovedGrant } from "../src/grants/payout-guard.js";
import { applyPayoutStatus } from "../src/grants/payout-status.js";
import { valueToCents } from "../src/paypal/orders.js";
import { submitRequest } from "../src/requests.js";
import { handleWebhook } from "../src/webhook-events.js";
import {
  type FakePayPal,
  fakePayPal,
  fundWith,
  makeApp,
  makeDb,
  paypalError,
  settleBackground,
  VALID_REQUEST,
} from "./helpers.js";

let db: Db;
let pp: FakePayPal;
const ORIGIN = { origin: "http://localhost:3000" };
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});
const H = {
  authAlgo: "SHA256withRSA",
  certUrl: "https://api.sandbox.paypal.com/v1/notifications/certs/C",
  transmissionId: "t",
  transmissionSig: "s",
  transmissionTime: "2026-11-01T00:00:00Z",
};

beforeEach(async () => {
  db = await makeDb();
  pp = fakePayPal();
  pp.on("POST", "/v1/notifications/verify-webhook-signature", () => ({
    verification_status: "SUCCESS",
  }));
  pp.on("POST", "/v1/payments/payouts", () => ({
    batch_header: { payout_batch_id: "B1", batch_status: "PENDING" },
  }));
  pp.on("GET", "/v1/payments/payouts/", () => ({
    batch_header: { payout_batch_id: "B1", batch_status: "PENDING" },
    items: [],
  }));
  await fundWith(db, 200_000);
});
afterEach(async () => {
  await settleBackground();
  await db.close();
});

it("the HTTP approve path enforces the configured per-grant cap", async () => {
  const { app, settle } = makeApp(db, pp);
  await app.request("/api/requests", json({ ...VALID_REQUEST, amountUsd: 450 }));
  await settle();
  const login = await app.request(
    "/api/review/login",
    json({ passcode: "test-passcode", name: "Ana" }, ORIGIN),
  );
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const res = await app.request(
    "/api/review/requests/R-0001/decision",
    json({ decision: "approve", reason: "Looks fine." }, { cookie, ...ORIGIN }),
  );
  expect((await res.json()).payout).toMatchObject({ status: "refused", errorCode: "GRANT_CAP" });
  expect(pp.calls.filter((c) => c.path === "/v1/payments/payouts")).toHaveLength(0);
});

it("a 401/429 from PayPal leaves the payout retryable instead of failing it", async () => {
  pp.on("POST", "/v1/payments/payouts", () => {
    throw paypalError(429, "RATE_LIMIT_REACHED");
  });
  const r = await submitRequest(db, "salt-salt-salt-salt", VALID_REQUEST as never, "c");
  const a = await recordDecision(db, {
    requestId: r.id,
    decision: "approve",
    reviewerName: "Ana",
    reason: "ok ok",
  });
  const res = await payApprovedGrant(db, pp, a, {
    dailyCapCents: 1_000_000,
    perGrantCapCents: 50_000,
  });
  expect(res.status).toBe("creating");
});

it("the public status endpoint hides rule outcomes", async () => {
  const { app } = makeApp(db, pp);
  await app.request("/api/requests", json({ ...VALID_REQUEST, amountUsd: 900 })); // R1 block
  const body = await (await app.request("/api/requests/R-0001/status")).json();
  expect(body.status).toBe("in_review");
});

describe("donation webhooks", () => {
  beforeEach(async () => {
    await db.query(
      `insert into donations (public_ref, paypal_order_id, capture_id, amount_cents, status) values ('D-1', 'O1', 'CAP1', 2500, 'created')`,
    );
  });
  const capture = (type: string, value: string, id = type) =>
    handleWebhook(
      db,
      pp,
      "WH",
      H,
      JSON.stringify({
        id,
        event_type: type,
        resource: { id: "CAP1", amount: { value, currency_code: "USD" } },
      }),
    );
  const status = async () =>
    (
      await db.query<{ status: string }>(`select status from donations where public_ref = 'D-1'`)
    )[0]!.status;

  it("only credits a COMPLETED capture whose amount matches", async () => {
    await capture("PAYMENT.CAPTURE.COMPLETED", "1.00", "e1");
    expect(await status()).toBe("created");
    await capture("PAYMENT.CAPTURE.COMPLETED", "25.00", "e2");
    expect(await status()).toBe("captured");
  });

  it("a late PENDING or DENIED can't un-capture a donation", async () => {
    await capture("PAYMENT.CAPTURE.COMPLETED", "25.00", "e1");
    await capture("PAYMENT.CAPTURE.PENDING", "25.00", "e2");
    await capture("PAYMENT.CAPTURE.DENIED", "25.00", "e3");
    expect(await status()).toBe("captured");
  });
});

it("a late batch PROCESSING doesn't overwrite an unclaimed item", async () => {
  const r = await submitRequest(db, "salt-salt-salt-salt", VALID_REQUEST as never, "c");
  const a = await recordDecision(db, {
    requestId: r.id,
    decision: "approve",
    reviewerName: "Ana",
    reason: "ok ok",
  });
  await payApprovedGrant(db, pp, a, { dailyCapCents: 1_000_000, perGrantCapCents: 50_000 });
  await applyPayoutStatus(db, { payoutBatchId: "B1" }, "unclaimed");
  await applyPayoutStatus(db, { payoutBatchId: "B1" }, "processing");
  expect((await db.query<{ status: string }>(`select status from payouts`))[0]!.status).toBe(
    "unclaimed",
  );
});

it("parses PayPal amounts strictly", () => {
  expect(valueToCents("25.00")).toBe(2500);
  expect(valueToCents("0.1")).toBe(10);
  expect(valueToCents("19.99")).toBe(1999);
  expect(valueToCents("1e3")).toBeNaN();
  expect(valueToCents("-5.00")).toBeNaN();
});
