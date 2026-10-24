# Aloha Relief: notes for AI coding agents

Solo entry for the PayPal "Build What's Next with PayPal and AI" hackathon (Devpost).
Principle: **Rules check. AI explains. People decide.**

## Hard facts (from the official rules; don't change)

- Deadline Nov 12, 2026 12:00 PT (10:00 HST). Internal deadline Mon Nov 10, 21:00 HST.
- Judging Dec 1–15, 2026: the hosted demo and DB must stay up until Dec 15.
- Must meaningfully use PayPal (sandbox) and AI; PayPal is central. Stage One is pass/fail on this.
- Functional demo: hosted URL and local run instructions. Public repo, MIT license.
- Video < 3 min, no copyrighted music or third-party trademarks.
- Prize targets: Most Impactful / Best Use of PayPal + AI, plus Best Use of AG Grid (sponsor).
- All demo data is fictional ("Kanaloa Relief Fund"). Every page shows the sandbox/fictional banner.

## Invariants

1. No invented APIs. PayPal and AG Grid code follows the official docs; cite URL + version in code comments.
2. Secrets come from macOS Keychain locally (`scripts/dev.sh`) and from host env vars in production.
   Never print, log or commit them.
3. No code path creates a Payout without a recorded human approval (reviewer, timestamp, reason).
   `src/grants/payout-guard.ts` is the only importer of `src/paypal/payouts.ts`; tests enforce it.
   The DB also enforces it (`payouts.approval_id` FK + trigger).
4. Privacy: no names, emails, descriptions, hashes or PayPal IDs in the public ledger, logs or analytics.
   Request text is untrusted input to the AI: it's data, never instructions.
5. Deterministic first: rules are plain code with unit tests. The AI explains and prioritizes;
   it can't clear a BLOCK.
6. Cost: free tiers only. AI via Claude Haiku 5.5, cached, with an in-app spend cap ($4 total, $0.50/day).
7. Small conventional commits, no force pushes. English for user-facing text (Vietnamese toggle on the
   request form only).
8. WCAG AA basics, mobile-friendly.

## Decisions (Gate 0, approved 2026-10-24)

- PayPal JS SDK v6 (`https://www.sandbox.paypal.com/web-sdk/v6/core`); server calls via plain `fetch`.
- No PayPal MCP / Agent Toolkit (it has no payouts tool, and agents must not move money).
- AI: Anthropic `claude-haiku-5-5` through `@anthropic-ai/sdk`, `messages.parse` + `zodOutputFormat`
  (`output_config.format`), `effort: "low"`. Behind a provider interface; fail closed.
- Host: Render free web service. DB: Neon free Postgres (Render's free Postgres expires in 30 days).
  Tests and local dev without `DATABASE_URL` use PGlite.
- Deploy early (Phase 2) so webhooks hit a public HTTPS URL. Keep-warm GitHub Action until Dec 16.
- Reviewer auth: one shared demo passcode, signed HttpOnly cookie, reviewer name recorded per decision.

## Commands

- `npm run dev`: local server with secrets from Keychain (PGlite unless `neon-database-url` is used).
- `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`.

## Layout

- `src/paypal/*`: OAuth, Orders v2, Payouts v1, webhook verification.
- `src/rules/*`: deterministic checks. `src/ai/*`: triage provider, prompt, schema, cache, budget.
- `src/grants/*`: approvals and the payout guard. `src/ledger/*`: public PII-free projections.
- `web/*`: static pages, bundled by esbuild into `dist/web`.
