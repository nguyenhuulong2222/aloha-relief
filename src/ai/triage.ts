import { createHash } from "node:crypto";
import type { Db } from "../db/index.js";
import { log } from "../http/log.js";
import type { RuleResult } from "../rules/engine.js";
import { buildUserMessage, PROMPT_VERSION, SYSTEM_PROMPT, type TriageInput } from "./prompt.js";
import type { TriageProvider } from "./provider.js";
import type { TriageResult } from "./schema.js";

export interface Budget {
  dailyCapUsd: number;
  totalCapUsd: number;
}

export type TriageStatus = "ok" | "partial" | "failed";

export interface StoredTriage {
  status: TriageStatus;
  failureReason: string | null;
  result: TriageResult | null;
  cached: boolean;
  costUsd: number;
}

export async function spentUsd(db: Db, day: string): Promise<{ today: number; total: number }> {
  const [row] = await db.query<{ today: string | null; total: string | null }>(
    `select (select cost_usd from ai_usage where day = $1::date)::text as today,
            (select coalesce(sum(cost_usd), 0) from ai_usage)::text as total`,
    [day],
  );
  return { today: Number(row?.today ?? 0), total: Number(row?.total ?? 0) };
}

/**
 * Applies the "AI can't override a hard rule" invariant and checks completeness.
 * Returns the (possibly corrected) result and whether it is partial.
 */
export function postProcess(result: TriageResult, rules: Pick<RuleResult, "ruleId" | "outcome">[]) {
  const fixed: TriageResult = {
    ...result,
    summary: result.summary.slice(0, 400),
    questions_for_requester: result.questions_for_requester.slice(0, 3),
  };
  const blocked = rules.filter((r) => r.outcome === "block").map((r) => r.ruleId);
  if (blocked.length > 0 && fixed.recommendation !== "decline") {
    fixed.recommendation = "decline";
    fixed.recommendation_reason =
      `Blocked by rule ${blocked.join(", ")}. ${fixed.recommendation_reason}`.trim();
  }
  const needExplaining = rules.filter((r) => r.outcome !== "pass").map((r) => r.ruleId);
  const explained = new Set(fixed.flag_explanations.map((f) => f.rule_id));
  const partial = needExplaining.some((id) => !explained.has(id));
  return { result: fixed, partial };
}

export function inputHash(model: string, input: TriageInput): string {
  return createHash("sha256")
    .update(JSON.stringify({ v: PROMPT_VERSION, model, input }))
    .digest("hex");
}

/**
 * Runs AI triage for a stored request and saves the outcome. Fail-closed: any problem stores
 * status "failed" and the reviewer sees "AI unavailable, review manually". Nothing is ever
 * auto-approved, whatever the outcome.
 */
export async function runTriage(
  db: Db,
  provider: TriageProvider | null,
  budget: Budget,
  requestId: string,
  input: TriageInput,
  now = new Date(),
): Promise<StoredTriage> {
  const model = provider?.model ?? "none";
  const hash = inputHash(model, input);

  const save = async (s: StoredTriage, tokens = { inputTokens: 0, outputTokens: 0 }) => {
    await db.query(
      `insert into triage (request_id, status, failure_reason, prompt_version, model, input_hash, result,
                           input_tokens, output_tokens, cost_usd, cached)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)
       on conflict (request_id) do update set status = excluded.status, failure_reason = excluded.failure_reason,
         model = excluded.model, input_hash = excluded.input_hash, result = excluded.result,
         input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
         cost_usd = excluded.cost_usd, cached = excluded.cached, created_at = now()`,
      [
        requestId,
        s.status,
        s.failureReason,
        PROMPT_VERSION,
        model,
        hash,
        s.result ? JSON.stringify(s.result) : null,
        tokens.inputTokens,
        tokens.outputTokens,
        s.costUsd,
        s.cached,
      ],
    );
    return s;
  };

  const [hit] = await db.query<{ result: TriageResult }>(
    `select result from ai_cache where input_hash = $1`,
    [hash],
  );
  if (hit) {
    const { result, partial } = postProcess(hit.result, input.rules);
    return save({
      status: partial ? "partial" : "ok",
      failureReason: null,
      result,
      cached: true,
      costUsd: 0,
    });
  }

  if (!provider)
    return save({
      status: "failed",
      failureReason: "ai_not_configured",
      result: null,
      cached: false,
      costUsd: 0,
    });

  const day = now.toISOString().slice(0, 10);
  const spent = await spentUsd(db, day);
  if (spent.today >= budget.dailyCapUsd || spent.total >= budget.totalCapUsd) {
    log.warn("ai.budget_exhausted", { costUsd: spent.total });
    return save({
      status: "failed",
      failureReason: "budget_exhausted",
      result: null,
      cached: false,
      costUsd: 0,
    });
  }

  const started = Date.now();
  const out = await provider.triage(SYSTEM_PROMPT, buildUserMessage(input));
  const cost = provider.cost(out.usage);
  await db.query(
    `insert into ai_usage (day, calls, cost_usd) values ($1::date, 1, $2)
     on conflict (day) do update set calls = ai_usage.calls + 1, cost_usd = ai_usage.cost_usd + excluded.cost_usd`,
    [day, cost],
  );
  log.info("ai.triage", {
    model: out.model,
    outcome: out.ok ? "ok" : "failed",
    ms: Date.now() - started,
    costUsd: cost,
  });

  if (!out.ok) {
    return save(
      { status: "failed", failureReason: out.reason, result: null, cached: false, costUsd: cost },
      out.usage,
    );
  }
  await db.query(
    `insert into ai_cache (input_hash, result) values ($1, $2::jsonb) on conflict do nothing`,
    [hash, JSON.stringify(out.result)],
  );
  const { result, partial } = postProcess(out.result, input.rules);
  return save(
    {
      status: partial ? "partial" : "ok",
      failureReason: null,
      result,
      cached: false,
      costUsd: cost,
    },
    out.usage,
  );
}
