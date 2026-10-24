import { z } from "zod";
import type { TriageInput } from "./ai/prompt.js";
import type { Db } from "./db/index.js";
import { availableCents } from "./fund.js";
import { hmac } from "./hash.js";
import {
  evaluateRules,
  type HistoryItem,
  ISLANDS,
  isBlocked,
  NEED_TYPES,
  normalizeEmail,
  type RuleResult,
} from "./rules/engine.js";

export const RequestInputSchema = z.object({
  needType: z.enum(NEED_TYPES),
  island: z.enum(ISLANDS),
  // Dollars from the form, converted to integer cents here. Caps are a rule (R1), not a form error,
  // so over-cap requests are recorded and visibly blocked rather than silently rejected.
  amountUsd: z.number().positive().max(100_000),
  description: z.string().trim().min(10).max(1000),
  payeeEmail: z.string().trim().min(3).max(254),
  lang: z.enum(["en", "vi"]).default("en"),
  consent: z.literal(true),
});
export type RequestInput = z.infer<typeof RequestInputSchema>;

export interface SubmitResult {
  id: string;
  publicRef: string;
  status: "submitted" | "blocked";
  rules: RuleResult[];
  triageInput: TriageInput;
}

export async function submitRequest(
  db: Db,
  salt: string,
  input: RequestInput,
  clientKey: string,
  now = new Date(),
): Promise<SubmitResult> {
  const amountCents = Math.round(input.amountUsd * 100);
  const payeeHash = hmac(salt, `payee:${normalizeEmail(input.payeeEmail)}`);
  const clientHash = hmac(salt, `client:${clientKey}`);

  return db.tx(async (t) => {
    // Serialize submissions so two concurrent requests from one payee can't both pass R2.
    await t.query(`select pg_advisory_xact_lock(4242001)`);
    const history = (
      await t.query<{
        public_ref: string;
        payee_hash: string;
        client_hash: string;
        description: string;
        amount_cents: number;
        status: string;
        created_at: Date;
      }>(
        `select public_ref, payee_hash, client_hash, description, amount_cents, status, created_at
           from requests where created_at > $1::timestamptz - interval '30 days'`,
        [now.toISOString()],
      )
    ).map<HistoryItem>((h) => ({
      publicRef: h.public_ref,
      payeeHash: h.payee_hash,
      clientHash: h.client_hash,
      description: h.description,
      amountCents: h.amount_cents,
      status: h.status,
      createdAt: new Date(h.created_at),
    }));

    const rules = evaluateRules(
      {
        needType: input.needType,
        amountCents,
        description: input.description,
        payeeEmail: input.payeeEmail,
        payeeHash,
        clientHash,
        now,
      },
      { history, availableCents: await availableCents(t) },
    );
    const status = isBlocked(rules) ? "blocked" : "submitted";

    const [row] = await t.query<{ id: string; public_ref: string }>(
      `insert into requests (need_type, island, amount_cents, description, payee_email, payee_hash, client_hash, lang, status, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) returning id, public_ref`,
      [
        input.needType,
        input.island,
        amountCents,
        input.description,
        input.payeeEmail.trim(),
        payeeHash,
        clientHash,
        input.lang,
        status,
        now.toISOString(),
      ],
    );
    for (const r of rules) {
      await t.query(
        `insert into rule_results (request_id, rule_id, outcome, detail) values ($1, $2, $3, $4)`,
        [row!.id, r.ruleId, r.outcome, r.detail],
      );
    }
    return {
      id: row!.id,
      publicRef: row!.public_ref,
      status,
      rules,
      triageInput: {
        needType: input.needType,
        island: input.island,
        amountCents,
        description: input.description,
        rules,
      },
    };
  });
}
