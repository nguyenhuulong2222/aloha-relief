/**
 * Runs against a real Postgres (postgres.js driver) when TEST_DATABASE_URL is set, because PGlite and
 * postgres.js serialize parameters differently (e.g. jsonb). Skipped otherwise.
 */
import { describe, expect, it } from "vitest";
import { runTriage } from "../src/ai/triage.js";
import { connectPostgres } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { fakeProvider } from "./helpers.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("postgres.js driver", () => {
  it("stores triage results as JSON objects, not strings", async () => {
    const db = await connectPostgres(url!);
    await migrate(db);
    const [r] = await db.query<{ id: string }>(
      `insert into requests (need_type, island, amount_cents, description, payee_email, payee_hash, client_hash, is_seed)
       values ('food', 'maui', 100, 'driver probe', 'probe@example.invalid', 'probe-' || gen_random_uuid(), 'probe', true) returning id`,
    );
    try {
      await runTriage(db, fakeProvider(), { dailyCapUsd: 1, totalCapUsd: 100 }, r!.id, {
        needType: "food",
        island: "maui",
        amountCents: 100 + Math.floor(Math.random() * 1e6),
        description: "driver probe",
        rules: [],
      });
      const [t] = await db.query<{ kind: string; urgency: number }>(
        `select jsonb_typeof(result) as kind, (result->>'urgency')::int as urgency from triage where request_id = $1`,
        [r!.id],
      );
      expect(t).toEqual({ kind: "object", urgency: 5 });
    } finally {
      await db.query(`delete from triage where request_id = $1`, [r!.id]);
      await db.query(`delete from rule_results where request_id = $1`, [r!.id]);
      await db.query(`delete from requests where id = $1`, [r!.id]);
    }
    await db.close();
  });
});
