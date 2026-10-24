import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTriage } from "../src/ai/triage.js";
import type { Db } from "../src/db/index.js";
import { runNightlyIfDue, seedDemo } from "../src/demo.js";
import { recordDecision } from "../src/grants/decide.js";
import { payApprovedGrant } from "../src/grants/payout-guard.js";
import { submitRequest } from "../src/requests.js";
import {
  type FakePayPal,
  fakePayPal,
  fakeProvider,
  fundWith,
  goodTriage,
  makeDb,
  VALID_REQUEST,
} from "./helpers.js";

const SALT = "salt-salt-salt-salt";
const LIMITS = { dailyCapCents: 50_000, perGrantCapCents: 40_000 };
let db: Db;
let pp: FakePayPal;
let n = 0;

beforeEach(async () => {
  db = await makeDb();
  pp = fakePayPal();
  pp.on("POST", "/v1/payments/payouts", () => ({
    batch_header: { payout_batch_id: `B${++n}`, batch_status: "PENDING" },
  }));
  pp.on("GET", "/v1/payments/payouts/", () => ({
    batch_header: { payout_batch_id: "B", batch_status: "PENDING" },
    items: [],
  }));
  await fundWith(db, 500_000);
});
afterEach(async () => db.close());

let k = 0;
async function approved(over: Partial<typeof VALID_REQUEST> = {}) {
  k++;
  const r = await submitRequest(
    db,
    SALT,
    {
      ...VALID_REQUEST,
      payeeEmail: `p${k}@personal.example.com`,
      description: `Distinct need number ${k}: ${"abcdefghij".repeat(k % 5)} after the fire.`,
      ...over,
    } as never,
    `client-${k}`,
  );
  const a = await recordDecision(db, {
    requestId: r.id,
    decision: "approve",
    reviewerName: "Judge",
    reason: "Testing the demo.",
  });
  return { r, a };
}
const payoutPosts = () =>
  pp.calls.filter((c) => c.method === "POST" && c.path === "/v1/payments/payouts");

describe("public demo payout limits", () => {
  it("refuses a single grant above the per-grant demo cap", async () => {
    const { a } = await approved({ amountUsd: 450 }); // within the $500 shelter rule, above the $400 demo cap
    await expect(payApprovedGrant(db, pp, a, LIMITS)).rejects.toMatchObject({ code: "GRANT_CAP" });
    expect(payoutPosts()).toHaveLength(0);
  });

  it("re-checks the need cap even if the stored amount changed after the rules ran", async () => {
    const { r, a } = await approved({ amountUsd: 100, needType: "food" });
    await db.query(`update requests set amount_cents = 90000 where id = $1`, [r.id]);
    await expect(payApprovedGrant(db, pp, a, { dailyCapCents: 10_000_000 })).rejects.toMatchObject({
      code: "GRANT_CAP",
    });
    expect(payoutPosts()).toHaveLength(0);
  });

  it("stops paying once the day's $500 total is reached", async () => {
    const first = await approved({ amountUsd: 300 });
    const second = await approved({ amountUsd: 250 });
    await payApprovedGrant(db, pp, first.a, LIMITS);
    await expect(payApprovedGrant(db, pp, second.a, LIMITS)).rejects.toMatchObject({
      code: "DAILY_CAP",
    });
    expect(payoutPosts()).toHaveLength(1);
  });

  it("seeded history doesn't count toward the daily cap", async () => {
    await seedDemo(db);
    await db.query(`update payouts set created_at = now() where is_seed`);
    const { a } = await approved({ amountUsd: 300 });
    await expect(payApprovedGrant(db, pp, a, LIMITS)).resolves.toMatchObject({ status: "pending" });
  });
});

describe("AI urgency orders the queue; it never decides money", () => {
  it("money modules never read triage, urgency or recommendations", async () => {
    const files = [
      ...(await readdir("src/grants")).map((f) => join("src/grants", f)),
      "src/donations.ts",
      "src/paypal/payouts.ts",
      "src/fund.ts",
    ];
    for (const f of files) {
      const src = await readFile(f, "utf8");
      expect(src, f).not.toMatch(/urgency|recommendation|triage|ai\//i);
    }
  });

  it("the same approval pays the same way whatever the AI said", async () => {
    const outcomes: unknown[] = [];
    for (const ai of [
      goodTriage({ urgency: 1, recommendation: "decline" }),
      goodTriage({ urgency: 5, recommendation: "approve" }),
    ]) {
      const { r, a } = await approved({ amountUsd: 120 });
      await runTriage(
        db,
        fakeProvider(() => ai),
        { dailyCapUsd: 1, totalCapUsd: 1 },
        r.id,
        {
          needType: "shelter",
          island: "maui",
          amountCents: 12_000 + k, // distinct cache key per request
          description: "x",
          rules: [],
        },
      );
      const res = await payApprovedGrant(db, pp, a, {
        dailyCapCents: 10_000_000,
        perGrantCapCents: 40_000,
      });
      outcomes.push({ status: res.status, errorCode: res.errorCode });
    }
    expect(outcomes[0]).toEqual(outcomes[1]);
    const amounts = payoutPosts().map(
      (c) => (c.req.body as { items: Array<{ amount: { value: string } }> }).items[0]!.amount.value,
    );
    expect(amounts).toEqual(["120.00", "120.00"]);
  });

  it("an urgent 'approve' from the AI moves no money without a human approval", async () => {
    const r = await submitRequest(db, SALT, VALID_REQUEST as never, "c-x");
    await runTriage(
      db,
      fakeProvider(() => goodTriage({ urgency: 5, recommendation: "approve" })),
      { dailyCapUsd: 1, totalCapUsd: 1 },
      r.id,
      {
        needType: "shelter",
        island: "maui",
        amountCents: 35_000,
        description: "y",
        rules: [],
      },
    );
    const [row] = await db.query<{ status: string }>(`select status from requests where id = $1`, [
      r.id,
    ]);
    expect(row!.status).toBe("submitted");
    expect(await db.query(`select 1 from approvals`)).toHaveLength(0);
    expect(payoutPosts()).toHaveLength(0);
  });

  it("outside the AI module, urgency is only read by the reviewer queue (display and sort)", async () => {
    const hits: string[] = [];
    async function walk(dir: string) {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (
          p.endsWith(".ts") &&
          !p.startsWith(join("src", "ai")) &&
          !p.endsWith(join("rules", "engine.ts"))
        ) {
          for (const line of (await readFile(p, "utf8")).split("\n"))
            if (/urgency/.test(line)) hits.push(`${p}: ${line.trim()}`);
        }
      }
    }
    await walk("src");
    expect(hits.every((h) => h.startsWith(join("src", "app.ts")))).toBe(true);
    expect(
      hits.some(
        (h) => /order by/.test(h) || /coalesce\(\(t\.result->>'urgency'\)::int, 3\) desc/.test(h),
      ),
    ).toBe(true);
  });
});

describe("nightly demo reset", () => {
  const at = (iso: string) => () => new Date(iso);

  it("restores seeded data once per Hawaii day, keeps AI spend, and checks the balance", async () => {
    await seedDemo(db);
    await approved({ amountUsd: 50 });
    await db.query(`insert into ai_usage (day, calls, cost_usd) values ('2026-11-01', 3, 0.01)`);
    const warnings: string[] = [];
    const deps = {
      db,
      balanceCents: async () => 50_000,
      warn: (m: string) => warnings.push(m),
    };

    expect(await runNightlyIfDue({ ...deps, now: at("2026-11-02T10:30:00Z") })).toBe(true); // 00:30 HST
    const [counts] = await db.query<{ live: number; seed: number; usage: number }>(
      `select (select count(*)::int from requests where not is_seed) as live,
              (select count(*)::int from requests where is_seed) as seed,
              (select count(*)::int from ai_usage) as usage`,
    );
    expect(counts).toEqual({ live: 0, seed: 24, usage: 1 });
    expect(warnings).toEqual(["paypal.balance_low"]);

    expect(await runNightlyIfDue({ ...deps, now: at("2026-11-03T09:59:00Z") })).toBe(false); // still Nov 2 in HST
    expect(await runNightlyIfDue({ ...deps, now: at("2026-11-03T10:01:00Z") })).toBe(true);
  });

  it("warns when the balance can't be read", async () => {
    const warnings: string[] = [];
    await runNightlyIfDue({
      db,
      balanceCents: async () => {
        throw new Error("NOT_AUTHORIZED");
      },
      warn: (m) => warnings.push(m),
    });
    expect(warnings).toEqual(["paypal.balance_unavailable"]);
  });
});
