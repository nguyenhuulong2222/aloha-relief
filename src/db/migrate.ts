import { readFile } from "node:fs/promises";
import type { Db } from "./index.js";

/** Applies the idempotent schema. In the bundle, schema.sql is copied next to server.js. */
export async function migrate(db: Db): Promise<void> {
  const sql = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
  await db.exec(sql);
}
