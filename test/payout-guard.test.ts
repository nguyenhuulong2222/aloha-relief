import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/index.js";
import { DecisionError, recordDecision } from "../src/grants/decide.js";
import { GuardError, payApprovedGrant, reconcilePayouts } from "../src/grants/payout-guard.js";
import { submitRequest } from "../src/requests.js";
import {
  type FakePayPal,
  fakePayPal,
  fundWith,
  makeDb,
  paypalError,
  VALID_REQUEST,
} from "./helpers.js";

const CAP = { dailyCapCents: 300_000 };
const SALT = "salt-salt-salt-salt";

let db: Db;
let pp: FakePayPal;

async function newRequest(over: Partial<typeof VALID_REQUEST> = {}, client = "client-1") {
  return submitRequest(db, SALT, { ...VALID_REQUEST, ...over } as never, client);
}

const approve = (requestId: string) =>
  recordDecision(db, {
    requestId,
    decision: "approve",
    reviewerName: "Volunteer Ana",
    reason: "Verified shelter need.",
  });

const payoutCalls = () =>
  pp.calls.filter((c) => c.path === "/v1/payments/payouts" && c.method === "POST");

beforeEach(async () => {
  db = await makeDb();
  pp = fakePayPal();
  pp.on("POST", "/v1/payments/payouts", () => ({
    batch_header: { payout_batch_id: "BATCH1", batch_status: "PENDING" },
  }));
  pp.on("GET", "/v1/payments/payouts/", () => ({
    batch_header: { payout_batch_id: "BATCH1", batch_status: "PENDING" },
    items: [{ payout_item_id: "ITEM1", transaction_status: "PENDING" }],
  }));
  await fundWith(db, 100_000);
});
afterEach(async () => db.close());

describe("only the guard can reach the Payouts API", () => {
  it("no module except payout-guard imports paypal/payouts", async () => {
    const offenders: string[] = [];
    async function walk(dir: string) {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (
          /\.(ts|js)$/.test(e.name) &&
          !p.endsWith(join("grants", "payout-guard.ts")) &&
          !p.endsWith(join("paypal", "payouts.ts"))
        ) {
          if (/paypal\/payouts(\.js)?["']/.test(await readFile(p, "utf8"))) offenders.push(p);
        }
      }
    }
    await walk("src");
    await walk("scripts");
    await walk("web");
    expect(offenders).toEqual([]);
  });
});

describe("no payout without a recorded human approval", () => {
  it("refuses an unknown approval id and never calls PayPal", async () => {
    await expect(
      payApprovedGrant(db, pp, "00000000-0000-0000-0000-000000000000", CAP),
    ).rejects.toMatchObject({
      code: "NO_APPROVAL",
    });
    expect(payoutCalls()).toHaveLength(0);
  });

  it.each(["decline", "ask_for_info"] as const)("refuses a %s decision", async (decision) => {
    const r = await newRequest();
    const id = await recordDecision(db, {
      requestId: r.id,
      decision,
      reviewerName: "Ana",
      reason: "Need more info.",
    });
    await expect(payApprovedGrant(db, pp, id, CAP)).rejects.toBeInstanceOf(GuardError);
    expect(payoutCalls()).toHaveLength(0);
  });

  it("requires a reviewer name and a reason", async () => {
    const r = await newRequest();
    await expect(
      recordDecision(db, {
        requestId: r.id,
        decision: "approve",
        reviewerName: " ",
        reason: "ok ok",
      }),
    ).rejects.toMatchObject({ code: "INVALID" });
    await expect(
      recordDecision(db, {
        requestId: r.id,
        decision: "approve",
        reviewerName: "Ana",
        reason: " ",
      }),
    ).rejects.toMatchObject({ code: "INVALID" });
  });

  it("a request blocked by a hard rule cannot be approved", async () => {
    const r = await newRequest({ amountUsd: 900 }); // shelter cap is $500 -> R1 block
    expect(r.status).toBe("blocked");
    await expect(approve(r.id)).rejects.toBeInstanceOf(DecisionError);
    expect(payoutCalls()).toHaveLength(0);
  });

  it("pays an approved request exactly once, with an idempotent sender_batch_id", async () => {
    const r = await newRequest();
    const approvalId = await approve(r.id);
    const res = await payApprovedGrant(db, pp, approvalId, CAP);
    expect(res.status).toBe("pending");
    expect(payoutCalls()).toHaveLength(1);
    const call = payoutCalls()[0]!;
    const body = call.req.body as {
      sender_batch_header: { sender_batch_id: string };
      items: Array<{ receiver: string; amount: { value: string } }>;
    };
    expect(call.req.requestId).toBe(body.sender_batch_header.sender_batch_id);
    expect(body.items[0]!.amount.value).toBe("350.00");
    expect(body.items[0]!.receiver).toBe(VALID_REQUEST.payeeEmail);

    await expect(payApprovedGrant(db, pp, approvalId, CAP)).rejects.toMatchObject({
      code: "ALREADY_PAID",
    });
    expect(payoutCalls()).toHaveLength(1);
  });

  it("parallel double-clicks still produce one payout", async () => {
    const r = await newRequest();
    const approvalId = await approve(r.id);
    const results = await Promise.allSettled([
      payApprovedGrant(db, pp, approvalId, CAP),
      payApprovedGrant(db, pp, approvalId, CAP),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(payoutCalls()).toHaveLength(1);
  });

  it("refuses when the fund cannot cover the grant", async () => {
    await db.query(`delete from donations`);
    await fundWith(db, 20_000);
    const r = await newRequest(); // $350 > $200 available (R8 only flags; the guard refuses)
    await expect(payApprovedGrant(db, pp, await approve(r.id), CAP)).rejects.toMatchObject({
      code: "INSUFFICIENT_FUNDS",
    });
    expect(payoutCalls()).toHaveLength(0);
  });

  it("enforces the daily payout cap", async () => {
    const r = await newRequest();
    const approvalId = await approve(r.id);
    await expect(
      payApprovedGrant(db, pp, approvalId, { dailyCapCents: 10_000 }),
    ).rejects.toMatchObject({ code: "DAILY_CAP" });
  });
});

describe("database enforces the same invariant", () => {
  it("rejects a payout row whose approval is not 'approve'", async () => {
    const r = await newRequest();
    const id = await recordDecision(db, {
      requestId: r.id,
      decision: "decline",
      reviewerName: "Ana",
      reason: "Duplicate.",
    });
    await expect(
      db.query(
        `insert into payouts (request_id, approval_id, amount_cents, sender_batch_id) values ($1, $2, 100, 'x')`,
        [r.id, id],
      ),
    ).rejects.toThrow(/approve decision/);
  });

  it("rejects a payout row pointing at another request's approval", async () => {
    const a = await newRequest();
    const b = await newRequest(
      {
        payeeEmail: "b@personal.example.com",
        description: "Groceries for a week after the fire in Kula.",
      },
      "client-2",
    );
    const approvalA = await approve(a.id);
    await expect(
      db.query(
        `insert into payouts (request_id, approval_id, amount_cents, sender_batch_id) values ($1, $2, 100, 'y')`,
        [b.id, approvalA],
      ),
    ).rejects.toThrow(/approve decision/);
  });

  it("approvals are append-only", async () => {
    const r = await newRequest();
    const id = await approve(r.id);
    await expect(
      db.query(`update approvals set reason = 'changed' where id = $1`, [id]),
    ).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from approvals where id = $1`, [id])).rejects.toThrow(
      /append-only/,
    );
  });
});

describe("PayPal failures", () => {
  it("a 4xx refusal marks the payout and request failed", async () => {
    pp.on("POST", "/v1/payments/payouts", () => {
      throw paypalError(422, "INSUFFICIENT_FUNDS");
    });
    const r = await newRequest();
    const res = await payApprovedGrant(db, pp, await approve(r.id), CAP);
    expect(res).toMatchObject({ status: "failed", errorCode: "INSUFFICIENT_FUNDS" });
    const [row] = await db.query<{ status: string }>(`select status from requests where id = $1`, [
      r.id,
    ]);
    expect(row!.status).toBe("failed");
  });

  it("a 5xx keeps the row for reconcile, which retries with the same sender_batch_id", async () => {
    let fail = true;
    pp.on("POST", "/v1/payments/payouts", () => {
      if (fail) throw paypalError(503, "SERVICE_UNAVAILABLE");
      return { batch_header: { payout_batch_id: "BATCH1", batch_status: "PENDING" } };
    });
    const r = await newRequest();
    const res = await payApprovedGrant(db, pp, await approve(r.id), CAP);
    expect(res.status).toBe("creating");
    fail = false;
    await db.query(`update payouts set updated_at = now() - interval '5 minutes'`);
    await reconcilePayouts(db, pp);
    const ids = payoutCalls().map((c) => c.req.requestId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    const [p] = await db.query<{ status: string }>(`select status from payouts`);
    expect(p!.status).toBe("pending");
  });
});
