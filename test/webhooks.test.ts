import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/index.js";
import { recordDecision } from "../src/grants/decide.js";
import { payApprovedGrant } from "../src/grants/payout-guard.js";
import { submitRequest } from "../src/requests.js";
import { handleWebhook } from "../src/webhook-events.js";
import { type FakePayPal, fakePayPal, fundWith, makeDb, VALID_REQUEST } from "./helpers.js";

const H = {
  authAlgo: "SHA256withRSA",
  certUrl: "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
  transmissionId: "t-1",
  transmissionSig: "sig",
  transmissionTime: "2026-11-01T00:00:00Z",
};

let db: Db;
let pp: FakePayPal;
let verified = true;

beforeEach(async () => {
  db = await makeDb();
  pp = fakePayPal();
  verified = true;
  pp.on("POST", "/v1/notifications/verify-webhook-signature", () => ({
    verification_status: verified ? "SUCCESS" : "FAILURE",
  }));
  pp.on("POST", "/v1/payments/payouts", () => ({
    batch_header: { payout_batch_id: "BATCH9", batch_status: "PENDING" },
  }));
  pp.on("GET", "/v1/payments/payouts/", () => ({
    batch_header: { payout_batch_id: "BATCH9", batch_status: "PENDING" },
    items: [{ payout_item_id: "ITEM9", transaction_status: "PENDING" }],
  }));
});
afterEach(async () => db.close());

const send = (event: object, headers = H) =>
  handleWebhook(db, pp, "WH-1", headers, JSON.stringify(event));

async function paidRequest() {
  await fundWith(db, 100_000);
  const r = await submitRequest(db, "salt-salt-salt-salt", VALID_REQUEST as never, "c1");
  const a = await recordDecision(db, {
    requestId: r.id,
    decision: "approve",
    reviewerName: "Ana",
    reason: "Verified.",
  });
  await payApprovedGrant(db, pp, a, { dailyCapCents: 1_000_000 });
  return r;
}

const itemEvent = (type: string, id = "WH-EVT-1") => ({
  id,
  event_type: type,
  resource: { payout_item_id: "ITEM9", payout_batch_id: "BATCH9", transaction_status: "SUCCESS" },
});

describe("webhooks", () => {
  it("rejects unverified events and changes nothing", async () => {
    const r = await paidRequest();
    verified = false;
    const out = await send(itemEvent("PAYMENT.PAYOUTS-ITEM.SUCCEEDED"));
    expect(out.http).toBe(400);
    const [row] = await db.query<{ status: string }>(`select status from requests where id = $1`, [
      r.id,
    ]);
    expect(row!.status).toBe("paying");
  });

  it("rejects certs not hosted by PayPal without calling the postback", async () => {
    const out = await send(itemEvent("PAYMENT.PAYOUTS-ITEM.SUCCEEDED"), {
      ...H,
      certUrl: "https://evil.example.com/cert",
    });
    expect(out.http).toBe(400);
    expect(pp.calls.some((c) => c.path.includes("verify-webhook-signature"))).toBe(false);
  });

  it("sends the raw event body byte-for-byte to the verify endpoint", async () => {
    const raw = '{"id":"E1","event_type":"X.Y","resource":{"amount":"10.50"}}';
    await handleWebhook(db, pp, "WH-1", H, raw);
    const call = pp.calls.find((c) => c.path.includes("verify-webhook-signature"))!;
    expect(call.req.body as string).toContain(`"webhook_event":${raw}}`);
    expect(JSON.parse(call.req.body as string).webhook_id).toBe("WH-1");
  });

  it("marks a payout succeeded and the request paid, once", async () => {
    const r = await paidRequest();
    expect((await send(itemEvent("PAYMENT.PAYOUTS-ITEM.SUCCEEDED"))).http).toBe(200);
    expect((await send(itemEvent("PAYMENT.PAYOUTS-ITEM.SUCCEEDED"))).note).toBe("duplicate");
    const [row] = await db.query<{ status: string; p: string }>(
      `select r.status, p.status as p from requests r join payouts p on p.request_id = r.id where r.id = $1`,
      [r.id],
    );
    expect(row).toEqual({ status: "paid", p: "succeeded" });
  });

  it("a late PENDING-type event can't move a succeeded payout backwards", async () => {
    await paidRequest();
    await send(itemEvent("PAYMENT.PAYOUTS-ITEM.SUCCEEDED", "a"));
    await send(itemEvent("PAYMENT.PAYOUTS-ITEM.HELD", "b"));
    const [p] = await db.query<{ status: string }>(`select status from payouts`);
    expect(p!.status).toBe("succeeded");
  });

  it("marks failed payouts and their requests", async () => {
    const r = await paidRequest();
    await send(itemEvent("PAYMENT.PAYOUTS-ITEM.FAILED"));
    const [row] = await db.query<{ status: string }>(`select status from requests where id = $1`, [
      r.id,
    ]);
    expect(row!.status).toBe("failed");
  });

  it("captures an approved order server-side if the browser never did", async () => {
    await db.query(
      `insert into donations (public_ref, paypal_order_id, amount_cents, status) values ('D-0100', 'ORDER1', 2500, 'created')`,
    );
    pp.on("POST", "/v2/checkout/orders/ORDER1/capture", () => ({
      id: "ORDER1",
      status: "COMPLETED",
      purchase_units: [
        {
          payments: { captures: [{ id: "CAP1", status: "COMPLETED", amount: { value: "25.00" } }] },
        },
      ],
    }));
    await send({ id: "E2", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: "ORDER1" } });
    const [d] = await db.query<{ status: string; capture_id: string }>(
      `select status, capture_id from donations`,
    );
    expect(d).toEqual({ status: "captured", capture_id: "CAP1" });
  });

  it("refuses a capture whose amount differs from the order we created", async () => {
    await db.query(
      `insert into donations (public_ref, paypal_order_id, amount_cents, status) values ('D-0101', 'ORDER2', 2500, 'created')`,
    );
    pp.on("POST", "/v2/checkout/orders/ORDER2/capture", () => ({
      id: "ORDER2",
      status: "COMPLETED",
      purchase_units: [
        {
          payments: { captures: [{ id: "CAP2", status: "COMPLETED", amount: { value: "1.00" } }] },
        },
      ],
    }));
    await send({ id: "E3", event_type: "CHECKOUT.ORDER.APPROVED", resource: { id: "ORDER2" } });
    const [d] = await db.query<{ status: string }>(`select status from donations`);
    expect(d!.status).toBe("created");
  });

  it("applies capture refunds via the 'up' link", async () => {
    await db.query(
      `insert into donations (public_ref, paypal_order_id, capture_id, amount_cents, status) values ('D-0102', 'O3', 'CAP3', 2500, 'captured')`,
    );
    await send({
      id: "E4",
      event_type: "PAYMENT.CAPTURE.REFUNDED",
      resource: {
        id: "REFUND1",
        links: [{ rel: "up", href: "https://api.sandbox.paypal.com/v2/payments/captures/CAP3" }],
      },
    });
    const [d] = await db.query<{ status: string }>(`select status from donations`);
    expect(d!.status).toBe("refunded");
  });
});
