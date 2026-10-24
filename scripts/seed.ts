/**
 * Seeds fictional history for the Kanaloa Relief Fund so the ledger isn't empty on day one.
 * Every seeded row is marked is_seed and shows as "seeded" in the public ledger; none of it touched PayPal.
 * Usage: DATABASE_URL=... npm run seed   (without DATABASE_URL it seeds the local .pglite dev database)
 * Idempotent: does nothing if seeded rows already exist. Pass --reset to wipe ALL data first (demo reset).
 */
import { connectPglite, connectPostgres, type Db } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";

// Deterministic PRNG so every environment gets the same history.
let state = 20230808;
const rand = () => {
  state = (state * 1664525 + 1013904223) % 2 ** 32;
  return state / 2 ** 32;
};
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;

const ISLAND_WEIGHTS = [
  "maui",
  "maui",
  "maui",
  "maui",
  "maui",
  "molokai",
  "lanai",
  "hawaii",
  "oahu",
] as const;
const NEEDS: Array<[string, number[], string]> = [
  ["food", [6000, 8000, 10000, 12000, 15000], "Groceries for the household after evacuation."],
  ["shelter", [25000, 30000, 35000, 40000, 45000], "Short motel stay after losing a rental."],
  ["transport", [8000, 12000, 15000, 20000], "Gas and a car repair to get to work."],
  ["medical", [5000, 9000, 15000, 25000], "Replacement prescriptions and a clinic copay."],
  ["utilities", [10000, 15000, 20000], "Deposit to restart power in temporary housing."],
  ["other", [5000, 8000, 12000], "Replacement school supplies and work boots."],
];
const DONATIONS = [
  1000, 2000, 2500, 2500, 5000, 5000, 5000, 10000, 10000, 15000, 20000, 25000, 50000,
];

async function reset(db: Db) {
  // TRUNCATE bypasses the row-level append-only trigger on approvals by design (demo reset only).
  await db.exec(`truncate payouts, approvals, rule_results, triage, ai_cache, webhook_events, requests, donations restart identity cascade;
                 alter sequence donation_ref_seq restart; alter sequence request_ref_seq restart;`);
}

async function seed(db: Db) {
  const [{ n } = { n: 0 }] = await db.query<{ n: number }>(
    `select count(*)::int as n from donations where is_seed`,
  );
  if (n > 0) {
    console.log("Seed data already present; nothing to do.");
    return;
  }
  const now = Date.now();
  const day = 86_400_000;
  const start = now - 45 * day;

  // Donations spread over 45 days.
  for (let i = 0; i < 46; i++) {
    const at = new Date(start + rand() * 44 * day);
    await db.query(
      `insert into donations (paypal_order_id, capture_id, amount_cents, status, is_seed, created_at, captured_at)
       values ($1, $2, $3, 'captured', true, $4, $4)`,
      [`SEED-ORDER-${i}`, `SEED-CAPTURE-${i}`, pick(DONATIONS), at.toISOString()],
    );
  }

  // Paid grants: request -> approval by a fictional volunteer -> succeeded payout.
  for (let i = 0; i < 24; i++) {
    const [need, amounts, text] = pick(NEEDS);
    const created = new Date(start + 2 * day + rand() * 40 * day);
    const paid = new Date(created.getTime() + (2 + rand() * 30) * 3_600_000);
    const [r] = await db.query<{ id: string }>(
      `insert into requests (need_type, island, amount_cents, description, payee_email, payee_hash, client_hash,
                             status, is_seed, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, 'paid', true, $8, $9) returning id`,
      [
        need,
        pick(ISLAND_WEIGHTS),
        pick(amounts),
        `${text} (seeded example)`,
        `seed-${i}@example.invalid`,
        `seed-payee-${i}`,
        `seed-client-${i}`,
        created.toISOString(),
        paid.toISOString(),
      ],
    );
    const [a] = await db.query<{ id: string }>(
      `insert into approvals (request_id, decision, reviewer_name, reason, created_at)
       values ($1, 'approve', 'Seed volunteer', 'Seeded example grant.', $2) returning id`,
      [r!.id, paid.toISOString()],
    );
    await db.query(
      `insert into payouts (request_id, approval_id, amount_cents, sender_batch_id, status, is_seed, created_at, updated_at)
       select $1, $2, amount_cents, $3, 'succeeded', true, $4, $4 from requests where id = $1`,
      [r!.id, a!.id, `SEED-BATCH-${i}`, paid.toISOString()],
    );
  }
  console.log("Seeded 46 donations and 24 paid grants (all fictional, marked as seeded).");
}

const db = process.env.DATABASE_URL
  ? await connectPostgres(process.env.DATABASE_URL)
  : await connectPglite(".pglite");
await migrate(db);
if (process.argv.includes("--reset")) await reset(db);
await seed(db);
await db.close();
