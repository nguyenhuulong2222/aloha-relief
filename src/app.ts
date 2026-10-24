import type { Context } from "hono";
import { Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { z } from "zod";
import type { TriageInput } from "./ai/prompt.js";
import type { TriageProvider } from "./ai/provider.js";
import { runTriage } from "./ai/triage.js";
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import { captureDonation, DonationError, startDonation } from "./donations.js";
import { fundHealth } from "./fund.js";
import { DecisionError, recordDecision } from "./grants/decide.js";
import { GuardError, payApprovedGrant, reconcilePayouts } from "./grants/payout-guard.js";
import { safeEqual } from "./hash.js";
import { securityHeaders } from "./http/headers.js";
import { log } from "./http/log.js";
import { RateLimiter } from "./http/ratelimit.js";
import { type PayPalClient, PayPalError } from "./paypal/client.js";
import { readWebhookHeaders } from "./paypal/webhooks.js";
import { RequestInputSchema, submitRequest } from "./requests.js";
import type { RuleResult } from "./rules/engine.js";
import { handleWebhook } from "./webhook-events.js";

export interface AppDeps {
  db: Db;
  pp: PayPalClient;
  provider: TriageProvider | null;
  config: Pick<
    Config,
    | "PAYPAL_CLIENT_ID"
    | "PAYPAL_WEBHOOK_ID"
    | "REVIEWER_PASSCODE"
    | "SESSION_SECRET"
    | "HASH_SALT"
    | "AI_DAILY_CAP_USD"
    | "AI_TOTAL_CAP_USD"
    | "DAILY_PAYOUT_CAP_CENTS"
    | "PER_GRANT_CAP_CENTS"
    | "PUBLIC_BASE_URL"
    | "NODE_ENV"
  >;
  /** Fire-and-forget work (AI triage). Tests pass a collector so they can await it. */
  background?: (p: Promise<unknown>) => void;
}

const SESSION_COOKIE = "ar_reviewer";
const SESSION_HOURS = 12;

function clientKey(c: Context): string {
  // The last X-Forwarded-For hop is appended by the host's proxy; earlier hops are client-supplied.
  const xff = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();
  return `${xff || "local"}|${c.req.header("user-agent") ?? ""}`;
}

export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 2)}${"•".repeat(Math.max(1, Math.min(6, local.length - 2)))}@${domain}`;
}

export function createApp(deps: AppDeps) {
  const { db, pp, config } = deps;
  const background = deps.background ?? ((p) => void p.catch(() => {}));
  const secure = config.NODE_ENV === "production";
  const requestLimiter = new RateLimiter(5, 60 * 60 * 1000);
  const donationLimiter = new RateLimiter(30, 60 * 60 * 1000);
  const loginLimiter = new RateLimiter(10, 15 * 60 * 1000);
  const statusLimiter = new RateLimiter(60, 60 * 60 * 1000);
  const captureLimiter = new RateLimiter(30, 60 * 60 * 1000);
  const budget = { dailyCapUsd: config.AI_DAILY_CAP_USD, totalCapUsd: config.AI_TOTAL_CAP_USD };

  const triage = (requestId: string, input: TriageInput) =>
    runTriage(db, deps.provider, budget, requestId, input);

  const app = new Hono();
  app.use(securityHeaders);

  app.onError((err, c) => {
    const pe = err instanceof PayPalError ? err : null;
    log.error("http.unhandled", {
      path: c.req.path,
      httpStatus: pe?.httpStatus,
      debugId: pe?.debugId,
      code: pe?.name_,
    });
    return c.json({ error: "internal_error" }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  // ---------- public API ----------
  app.get("/api/config", (c) =>
    c.json({
      paypalClientId: config.PAYPAL_CLIENT_ID,
      paypalEnv: "sandbox",
      demoLimits: {
        perGrantCents: config.PER_GRANT_CAP_CENTS,
        dailyCents: config.DAILY_PAYOUT_CAP_CENTS,
      },
    }),
  );

  app.post("/api/donations", async (c) => {
    if (!donationLimiter.allow(clientKey(c))) return c.json({ error: "rate_limited" }, 429);
    const body = z
      .object({ amountCents: z.number().int() })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "invalid_amount" }, 400);
    try {
      return c.json(await startDonation(db, pp, body.data.amountCents));
    } catch (e) {
      if (e instanceof DonationError) return c.json({ error: e.code }, 400);
      throw e;
    }
  });

  app.post("/api/donations/:orderId/capture", async (c) => {
    const orderId = c.req.param("orderId");
    if (!captureLimiter.allow(clientKey(c))) return c.json({ error: "rate_limited" }, 429);
    if (!/^[A-Z0-9]{8,32}$/.test(orderId)) return c.json({ error: "invalid_order" }, 400);
    try {
      return c.json(await captureDonation(db, pp, orderId));
    } catch (e) {
      if (e instanceof DonationError)
        return c.json({ error: e.code }, e.code === "UNKNOWN_ORDER" ? 404 : 400);
      throw e;
    }
  });

  app.post("/api/requests", async (c) => {
    const key = clientKey(c);
    if (!requestLimiter.allow(key)) return c.json({ error: "rate_limited" }, 429);
    const parsed = RequestInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json(
        {
          error: "invalid_request",
          fields: [...new Set(parsed.error.issues.map((i) => i.path.join(".")))],
        },
        400,
      );
    }
    const res = await submitRequest(db, config.HASH_SALT, parsed.data, key);
    log.info("request.submitted", { ref: res.publicRef, status: res.status });
    background(triage(res.id, res.triageInput));
    // The requester sees "received" either way; rule outcomes are for the reviewer.
    return c.json({ ref: res.publicRef, status: "received" }, 201);
  });

  // Coarse public states only: rule outcomes and reviewer actions stay private.
  const PUBLIC_STATUS: Record<string, string> = {
    submitted: "in_review",
    blocked: "in_review",
    needs_info: "in_review",
    approved: "approved",
    paying: "approved",
    paid: "paid",
    failed: "approved",
    declined: "closed",
  };
  app.get("/api/requests/:ref/status", async (c) => {
    if (!statusLimiter.allow(clientKey(c))) return c.json({ error: "rate_limited" }, 429);
    const [r] = await db.query<{ status: string }>(
      `select status from requests where public_ref = $1`,
      [c.req.param("ref")],
    );
    return r
      ? c.json({ ref: c.req.param("ref"), status: PUBLIC_STATUS[r.status] ?? "in_review" })
      : c.json({ error: "not_found" }, 404);
  });

  app.get("/api/ledger", async (c) => {
    const rows = await db.query(
      `select public_ref, kind, need_type, island, amount_cents, status, at, source
         from public_ledger order by at desc limit 1000`,
    );
    return c.json({ rows });
  });

  app.get("/api/fund", async (c) => c.json(await fundHealth(db)));

  app.post("/api/webhooks/paypal", async (c) => {
    const raw = await c.req.text();
    const out = await handleWebhook(
      db,
      pp,
      config.PAYPAL_WEBHOOK_ID,
      readWebhookHeaders((n) => c.req.header(n)),
      raw,
    );
    return c.json({ note: out.note }, out.http);
  });

  // ---------- reviewer ----------
  const sameOrigin = (c: Context) => {
    const origin = c.req.header("origin");
    return !origin || origin === new URL(config.PUBLIC_BASE_URL).origin;
  };

  async function reviewer(c: Context): Promise<string | null> {
    const v = await getSignedCookie(c, config.SESSION_SECRET, SESSION_COOKIE);
    if (!v) return null;
    try {
      const s = JSON.parse(v) as { n: string; e: number };
      return s.e > Date.now() && s.n ? s.n : null;
    } catch {
      return null;
    }
  }

  app.post("/api/review/login", async (c) => {
    if (!sameOrigin(c)) return c.json({ error: "bad_origin" }, 403);
    if (!loginLimiter.allow(clientKey(c))) return c.json({ error: "rate_limited" }, 429);
    const body = z
      .object({ passcode: z.string().max(200), name: z.string().trim().min(1).max(60) })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success || !safeEqual(body.data.passcode, config.REVIEWER_PASSCODE)) {
      return c.json({ error: "invalid_login" }, 401);
    }
    const value = JSON.stringify({ n: body.data.name, e: Date.now() + SESSION_HOURS * 3600_000 });
    await setSignedCookie(c, SESSION_COOKIE, value, config.SESSION_SECRET, {
      httpOnly: true,
      secure,
      sameSite: "Strict",
      path: "/",
      maxAge: SESSION_HOURS * 3600,
    });
    return c.json({ name: body.data.name });
  });

  app.post("/api/review/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  const review = new Hono<{ Variables: { reviewer: string } }>();
  review.use(async (c, next) => {
    const name = await reviewer(c);
    if (!name) return c.json({ error: "unauthorized" }, 401);
    if (c.req.method !== "GET" && !sameOrigin(c)) return c.json({ error: "bad_origin" }, 403);
    c.set("reviewer", name);
    await next();
  });

  review.get("/me", (c) => c.json({ name: c.get("reviewer") }));

  review.get("/requests", async (c) => {
    const rows = await db.query(
      `select r.public_ref, r.need_type, r.island, r.amount_cents, r.status, r.created_at, r.lang,
              t.status as triage_status, (t.result->>'urgency')::int as urgency,
              t.result->>'recommendation' as recommendation,
              (t.result->>'injection_detected')::boolean as injection_detected,
              (select count(*)::int from rule_results x where x.request_id = r.id and x.outcome = 'block') as blocks,
              (select count(*)::int from rule_results x where x.request_id = r.id and x.outcome = 'flag') as flags,
              p.status as payout_status
         from requests r
         left join triage t on t.request_id = r.id
         left join payouts p on p.request_id = r.id
        where r.is_seed = false
        order by case when r.status in ('submitted', 'needs_info', 'blocked') then 0 else 1 end,
                 coalesce((t.result->>'urgency')::int, 3) desc, r.created_at asc
        limit 200`,
    );
    return c.json({ rows });
  });

  async function loadRequest(ref: string) {
    const [r] = await db.query<{
      id: string;
      public_ref: string;
      need_type: string;
      island: string;
      amount_cents: number;
      description: string;
      payee_email: string;
      status: string;
      lang: string;
      created_at: Date;
    }>(
      `select id, public_ref, need_type, island, amount_cents, description, payee_email, status, lang, created_at
         from requests where public_ref = $1 and is_seed = false`,
      [ref],
    );
    return r ?? null;
  }

  review.get("/requests/:ref", async (c) => {
    const r = await loadRequest(c.req.param("ref"));
    if (!r) return c.json({ error: "not_found" }, 404);
    const [rules, triageRows, approvals, payouts] = await Promise.all([
      db.query(
        `select rule_id, outcome, detail from rule_results where request_id = $1 order by rule_id`,
        [r.id],
      ),
      db.query(
        `select status, failure_reason, model, result, cost_usd::float8 as cost_usd, cached, created_at from triage where request_id = $1`,
        [r.id],
      ),
      db.query(
        `select decision, reviewer_name, reason, created_at from approvals where request_id = $1 order by created_at`,
        [r.id],
      ),
      db.query(
        `select status, error_code, amount_cents, payout_batch_id, created_at, updated_at from payouts where request_id = $1`,
        [r.id],
      ),
    ]);
    const { payee_email, id: _id, ...rest } = r;
    return c.json({
      request: { ...rest, payee_masked: maskEmail(payee_email) },
      rules,
      triage: triageRows[0] ?? null,
      approvals,
      payout: payouts[0] ?? null,
    });
  });

  review.post("/requests/:ref/decision", async (c) => {
    const r = await loadRequest(c.req.param("ref"));
    if (!r) return c.json({ error: "not_found" }, 404);
    const body = z
      .object({
        decision: z.enum(["approve", "ask_for_info", "decline"]),
        reason: z.string().trim().min(3).max(500),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "reason_required" }, 400);
    let approvalId: string;
    try {
      approvalId = await recordDecision(db, {
        requestId: r.id,
        decision: body.data.decision,
        reviewerName: c.get("reviewer"),
        reason: body.data.reason,
      });
    } catch (e) {
      if (e instanceof DecisionError) return c.json({ error: e.code }, 409);
      throw e;
    }
    log.info("review.decision", { ref: r.public_ref, outcome: body.data.decision });
    if (body.data.decision !== "approve") return c.json({ ok: true, decision: body.data.decision });
    return c.json({ ok: true, decision: "approve", payout: await pay(approvalId) });
  });

  /** Approval stands even if the guard refuses (e.g. fund empty); "Pay now" retries with the same approval. */
  async function pay(approvalId: string) {
    try {
      return await payApprovedGrant(db, pp, approvalId, {
        dailyCapCents: config.DAILY_PAYOUT_CAP_CENTS,
        perGrantCapCents: config.PER_GRANT_CAP_CENTS,
      });
    } catch (e) {
      if (e instanceof GuardError) return { payoutId: null, status: "refused", errorCode: e.code };
      throw e;
    }
  }

  review.post("/requests/:ref/pay", async (c) => {
    const r = await loadRequest(c.req.param("ref"));
    if (!r) return c.json({ error: "not_found" }, 404);
    const [a] = await db.query<{ id: string }>(
      `select id from approvals where request_id = $1 and decision = 'approve'`,
      [r.id],
    );
    if (!a) return c.json({ error: "NO_APPROVAL" }, 409);
    return c.json({ ok: true, payout: await pay(a.id) });
  });

  review.post("/requests/:ref/retriage", async (c) => {
    const r = await loadRequest(c.req.param("ref"));
    if (!r) return c.json({ error: "not_found" }, 404);
    const rules = await db.query<{
      rule_id: RuleResult["ruleId"];
      outcome: RuleResult["outcome"];
      detail: string;
    }>(`select rule_id, outcome, detail from rule_results where request_id = $1 order by rule_id`, [
      r.id,
    ]);
    const result = await triage(r.id, {
      needType: r.need_type,
      island: r.island,
      amountCents: r.amount_cents,
      description: r.description,
      rules: rules.map((x) => ({ ruleId: x.rule_id, outcome: x.outcome, detail: x.detail })),
    });
    return c.json({ status: result.status });
  });

  review.post("/reconcile", async (c) => c.json({ checked: await reconcilePayouts(db, pp) }));

  app.route("/api/review", review);
  return app;
}
