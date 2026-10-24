/**
 * Seeds fictional demo history. Idempotent. --reset wipes all demo data first (keeps AI cache and spend).
 * Usage: DATABASE_URL=... npx tsx scripts/seed.ts [--reset]   (without DATABASE_URL: local .pglite)
 */
import { connectPglite, connectPostgres } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { resetDemo, seedDemo } from "../src/demo.js";

const db = process.env.DATABASE_URL
  ? await connectPostgres(process.env.DATABASE_URL)
  : await connectPglite(".pglite");
await migrate(db);
if (process.argv.includes("--reset")) await resetDemo(db);
console.log((await seedDemo(db)) ? "Seeded fictional history." : "Seed data already present.");
await db.close();
