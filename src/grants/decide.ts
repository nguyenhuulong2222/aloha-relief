import type { Db } from "../db/index.js";

export type Decision = "approve" | "ask_for_info" | "decline";

export class DecisionError extends Error {
  constructor(readonly code: "NOT_FOUND" | "NOT_DECIDABLE" | "BLOCKED" | "INVALID") {
    super(code);
  }
}

const DECIDABLE = new Set(["submitted", "needs_info", "blocked"]);
const NEXT_STATUS: Record<Decision, string> = {
  approve: "approved",
  ask_for_info: "needs_info",
  decline: "declined",
};

/** Records a reviewer decision. Append-only; returns the approval row id. */
export async function recordDecision(
  db: Db,
  args: { requestId: string; decision: Decision; reviewerName: string; reason: string },
): Promise<string> {
  const reviewer = args.reviewerName.trim();
  const reason = args.reason.trim();
  if (!reviewer || reason.length < 3 || reason.length > 500) throw new DecisionError("INVALID");

  return db.tx(async (t) => {
    const [req] = await t.query<{ status: string; blocked: boolean }>(
      `select r.status,
              exists (select 1 from rule_results x where x.request_id = r.id and x.outcome = 'block') as blocked
         from requests r where r.id = $1 for update`,
      [args.requestId],
    );
    if (!req) throw new DecisionError("NOT_FOUND");
    if (!DECIDABLE.has(req.status)) throw new DecisionError("NOT_DECIDABLE");
    if (args.decision === "approve" && (req.blocked || req.status === "blocked"))
      throw new DecisionError("BLOCKED");

    const [a] = await t.query<{ id: string }>(
      `insert into approvals (request_id, decision, reviewer_name, reason) values ($1, $2, $3, $4) returning id`,
      [args.requestId, args.decision, reviewer, reason],
    );
    await t.query(`update requests set status = $2, updated_at = now() where id = $1`, [
      args.requestId,
      NEXT_STATUS[args.decision],
    ]);
    return a!.id;
  });
}
