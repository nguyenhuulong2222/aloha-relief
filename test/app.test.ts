import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/index.js";
import { log } from "../src/http/log.js";
import {
  type FakePayPal,
  fakePayPal,
  fundWith,
  makeApp,
  makeDb,
  settleBackground,
  VALID_REQUEST,
} from "./helpers.js";

let db: Db;
let pp: FakePayPal;
let harness: ReturnType<typeof makeApp>;
const ORIGIN = { origin: "http://localhost:3000" };

beforeEach(async () => {
  db = await makeDb();
  pp = fakePayPal();
  pp.on("POST", "/v1/payments/payouts", () => ({
    batch_header: { payout_batch_id: "B1", batch_status: "PENDING" },
  }));
  pp.on("GET", "/v1/payments/payouts/", () => ({
    batch_header: { payout_batch_id: "B1", batch_status: "SUCCESS" },
    items: [{ payout_item_id: "I1", transaction_status: "SUCCESS" }],
  }));
  harness = makeApp(db, pp);
});
afterEach(async () => {
  await settleBackground();
  await db.close();
});

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

async function login() {
  const res = await harness.app.request(
    "/api/review/login",
    json({ passcode: "test-passcode", name: "Ana" }, ORIGIN),
  );
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

describe("reviewer API", () => {
  it("requires a session", async () => {
    expect((await harness.app.request("/api/review/requests")).status).toBe(401);
    const res = await harness.app.request(
      "/api/review/requests/R-0001/decision",
      json({ decision: "approve", reason: "x" }),
    );
    expect(res.status).toBe(401);
  });

  it("rejects a wrong passcode", async () => {
    const res = await harness.app.request(
      "/api/review/login",
      json({ passcode: "nope", name: "Ana" }, ORIGIN),
    );
    expect(res.status).toBe(401);
  });

  it("rejects cross-origin state changes", async () => {
    const cookie = await login();
    const res = await harness.app.request(
      "/api/review/requests/R-0001/decision",
      json({ decision: "approve", reason: "fine" }, { cookie, origin: "https://evil.example" }),
    );
    expect(res.status).toBe(403);
  });

  it("requires a reason for every decision", async () => {
    await harness.app.request("/api/requests", json(VALID_REQUEST));
    const cookie = await login();
    const res = await harness.app.request(
      "/api/review/requests/R-0001/decision",
      json({ decision: "approve", reason: "" }, { cookie, ...ORIGIN }),
    );
    expect(res.status).toBe(400);
    expect(pp.calls).toHaveLength(0);
  });

  it("runs request → triage → approve → payout end to end", async () => {
    await fundWith(db, 100_000);
    const sub = await harness.app.request("/api/requests", json(VALID_REQUEST));
    expect(await sub.json()).toEqual({ ref: "R-0001", status: "received" });
    await harness.settle();
    const cookie = await login();
    const detail = await (
      await harness.app.request("/api/review/requests/R-0001", { headers: { cookie } })
    ).json();
    expect(detail.triage.status).toBe("ok");
    expect(detail.request.payee_masked).not.toContain("keala");
    const res = await harness.app.request(
      "/api/review/requests/R-0001/decision",
      json({ decision: "approve", reason: "Verified by phone." }, { cookie, ...ORIGIN }),
    );
    const body = await res.json();
    expect(body.payout.status).toBe("succeeded");
    const [a] = await db.query<{ reviewer_name: string; reason: string }>(
      `select reviewer_name, reason from approvals`,
    );
    expect(a).toEqual({ reviewer_name: "Ana", reason: "Verified by phone." });
  });
});

describe("privacy", () => {
  it("public endpoints never expose emails, descriptions or hashes", async () => {
    await fundWith(db, 100_000);
    await harness.app.request("/api/requests", json(VALID_REQUEST));
    await harness.settle();
    const cookie = await login();
    await harness.app.request(
      "/api/review/requests/R-0001/decision",
      json({ decision: "approve", reason: "ok ok" }, { cookie, ...ORIGIN }),
    );
    const bodies = await Promise.all(
      ["/api/ledger", "/api/fund", "/api/requests/R-0001/status", "/api/config"].map(async (p) =>
        (await harness.app.request(p)).text(),
      ),
    );
    const [hash] = await db.query<{ payee_hash: string }>(`select payee_hash from requests`);
    for (const b of bodies) {
      expect(b).not.toContain(VALID_REQUEST.payeeEmail);
      expect(b).not.toContain("Lahaina");
      expect(b).not.toContain(hash!.payee_hash);
      expect(b).not.toContain("B1"); // PayPal batch id
    }
  });

  it("the public ledger view exposes exactly the allowed columns", async () => {
    const cols = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'public_ledger' order by ordinal_position`,
    );
    expect(cols.map((c) => c.column_name)).toEqual([
      "public_ref",
      "kind",
      "need_type",
      "island",
      "amount_cents",
      "status",
      "at",
      "source",
    ]);
  });

  it("the logger drops fields that aren't allowlisted", () => {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (l: string) => lines.push(l);
    log.error("x", { ref: "R-1", email: "a@b.co", description: "secret" } as never);
    console.error = orig;
    expect(lines[0]).toContain("R-1");
    expect(lines[0]).not.toContain("a@b.co");
    expect(lines[0]).not.toContain("secret");
  });

  it("sets security headers", async () => {
    const res = await harness.app.request("/health");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
