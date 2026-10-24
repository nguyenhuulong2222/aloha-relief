# Aloha Relief

Small, supervised disaster micro-grants on PayPal. **Rules check. AI explains. People decide.**

**Live demo:** https://aloha-relief.onrender.com · **Judges:** see [docs/testing-instructions.md](docs/testing-instructions.md)

> Demo only: PayPal **sandbox** money and fictional people ("Kanaloa Relief Fund"). No real payments happen.

![Volunteer console: rule checks and Claude's triage of a request that tries to inject instructions](docs/screenshots/review-injection.png)

## The problem

After the 2023 Maui wildfires, help moved through personal payment links, crowdfunding pages and group chats.
Donors couldn't see where money went, scams spread, and the same family could be paid twice while another
waited. Small community funds don't have the staff to vet every request, and they can't hand that decision
to a black box either.

## What it does

| Who | What they do | Built on |
|---|---|---|
| Donor | Gives to one shared fund. No donor name or email is stored. | PayPal JS SDK v6 + **Orders v2** (server-side create and capture) |
| Requester | Asks for a small grant in English or **Vietnamese**: need, island, amount, a few sentences, a PayPal email. | Plain form, rate limited |
| Rules | Eight deterministic checks run first (table below). A **block** can't be overridden by anyone. | Plain TypeScript, unit tested |
| Claude | Rates urgency 1–5, summarizes the request in English, explains every rule flag, spots prompt injection, suggests a decision and questions to ask. | **Claude Haiku 5.5**, structured output |
| Volunteer | Approves, asks for info or declines, always with a written reason recorded with their name. | Volunteer console |
| PayPal | Approval sends a grant; delivery status comes back by webhook. | **Payouts v1** + verified **webhooks** |
| Everyone | Sees every donation and grant, with no names, emails or stories. | **AG Grid** Community public ledger |

### Rules

| ID | Check | Outcome |
|---|---|---|
| R1 | Amount within the cap for that need (food $200 … shelter $500) | Block |
| R2 | One open or paid request per PayPal account in 30 days (plus-addresses and case normalized) | Block |
| R3 | Near-duplicate description (trigram similarity ≥ 0.8) | Flag |
| R4 | Request bursts from one device | Flag |
| R5 | Amount just under a cap, or the same odd amount across payees | Flag |
| R6 | Instructions embedded in the text ("ignore your rules…", role labels) | Flag |
| R7 | Invalid payee email (block) or disposable domain (flag) | Block / Flag |
| R8 | Fund can't cover the amount right now | Flag |

## Architecture

```mermaid
flowchart LR
  subgraph Browser
    D[Donor<br/>/donate] 
    Q[Requester<br/>/request EN/VI]
    V[Volunteer<br/>/review]
    L[Anyone<br/>/ledger AG Grid]
  end

  subgraph Server["Node 22 + Hono (Render)"]
    O[Orders: create/capture]
    RQ[Request intake]
    RU[Rules R1–R8<br/>deterministic]
    AI[AI triage<br/>cache + spend cap<br/>fail closed]
    DEC[Decision<br/>name + reason]
    G[Payout guard<br/>only importer of Payouts]
    WH[Webhook verifier]
    PL[Public ledger view<br/>no PII]
  end

  DB[(Neon Postgres<br/>append-only approvals<br/>payout trigger)]
  PP[PayPal sandbox<br/>Orders v2 · Payouts v1 · Webhooks]
  CL[Claude Haiku 5.5]

  D -- PayPal JS SDK v6 --> O --> PP
  Q --> RQ --> RU --> AI --> CL
  V --> DEC --> G --> PP
  PP -- signed events --> WH --> DB
  RU --> DB
  AI --> DB
  DEC --> DB
  G --> DB
  L --> PL --> DB
```

### Money can only move after a person says yes

- `src/grants/payout-guard.ts` is the **only** module that imports `src/paypal/payouts.ts`. A test fails the
  build if anything else does.
- The guard needs a recorded **approve** decision (reviewer name, timestamp, reason) and re-checks, under a
  database lock, that no rule blocks the request, that it hasn't been paid, and that the fund, the per-grant
  cap and the daily cap all allow it.
- The **database** enforces it too: a trigger rejects any payout row without an approve decision for the same
  request, or for a request a rule blocked. Approvals are append-only.
- Payouts use `sender_batch_id` and `PayPal-Request-Id` for idempotency. Only definitive PayPal errors fail a
  grant; anything else stays retryable and a reconciler checks in-flight batches every minute.

### How Claude is used, and how it's fenced in

- One call per request, `client.messages.parse` with a Zod schema (`output_config.format`), `effort: "low"`.
- Request text is untrusted. It's escaped, truncated and wrapped in `<request_data>`; the trusted rule results
  sit outside it. The system prompt tells Claude to treat anything inside as data and to report injection
  attempts. In the demo's injection scenario it does exactly that.
- Claude's urgency only **orders the queue**. A test proves the same approval pays the same way whether Claude
  said "urgency 1, decline" or "urgency 5, approve". Any rule block forces the suggestion to "decline".
- Refusals, truncation, schema failures and API errors **fail closed**: the volunteer sees "AI triage
  unavailable" and decides manually.
- Results are cached by input hash. An in-app budget stops AI calls at $0.50 a day and $4 in total. A typical
  triage costs about $0.0004.

### Webhooks

`POST /api/webhooks/paypal` verifies every event with PayPal's `verify-webhook-signature` postback, using the
raw body byte for byte, before it does anything. Events are de-duplicated by ID. Handled:
`CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.COMPLETED/PENDING/DENIED/REFUNDED/REVERSED`, `PAYMENT.PAYOUTSBATCH.*`,
`PAYMENT.PAYOUTS-ITEM.*`. Late or out-of-order events can't move a status backwards.

### Privacy

The public ledger reads one database view with fixed columns: reference, type, need, island, amount, status,
time, source. No names, emails, descriptions, hashes or PayPal IDs. Logs use an allowlisted logger. Payee
emails are stored for the payout and shown masked to volunteers; duplicate checks use salted HMACs.

### Screens

| Paid grant with its audit trail | Ledger filtered to Maui grants |
|---|---|
| ![Volunteer console after approval: status Paid, history shows the reviewer, reason and PayPal Payout](docs/screenshots/review-paid.png) | ![AG Grid ledger filtered to grants on Maui with the totals line](docs/screenshots/ledger-filtered.png) |

## Public-demo safety

The volunteer passcode is published for judges, so anyone can approve **sandbox** payouts. The demo limits that:

- At most **$400 per grant** and **$500 per day** (Hawaii time) across all visitors, enforced in the payout guard.
- **Nightly reset** at midnight Hawaii time restores the seeded history and four fresh scenarios (urgent,
  duplicate, prompt injection, Vietnamese), then checks the sandbox business balance and logs a warning if low.
- A GitHub Action pings `/health` every 10 minutes through December 16, 2026, so the free Render instance stays
  awake for judging.

## PayPal and AI APIs used

| API | Where | Docs |
|---|---|---|
| OAuth 2.0 client credentials | `src/paypal/client.ts` | https://developer.paypal.com/api/rest/authentication/ |
| JS SDK v6 (PayPal one-time payment session) | `web/js/donate.ts` | https://developer.paypal.com/docsai/payments/methods/paypal/sdk/js/v6/paypal-checkout |
| Orders v2: create, capture, get | `src/paypal/orders.ts` | https://developer.paypal.com/docs/api/orders/v2/ |
| Payouts v1: create batch, get batch | `src/paypal/payouts.ts` | https://developer.paypal.com/docs/payouts/standard/integrate-api/ |
| Webhooks: verify signature, manage | `src/paypal/webhooks.ts`, `scripts/register-webhook.ts` | https://developer.paypal.com/api/rest/webhooks/rest/ |
| Transaction Search: balances | `src/paypal/balances.ts` | https://developer.paypal.com/docs/api/transaction-search/v1/ |
| Claude Messages API, structured outputs | `src/ai/anthropic.ts` | https://platform.claude.com/docs/en/build-with-claude/structured-outputs |
| AG Grid Community 36.2 (MIT) | `web/js/ledger.ts` | https://www.ag-grid.com/javascript-data-grid/ |

## Run locally

Requirements: Node 22+, a PayPal Developer sandbox REST app (client ID + secret) with **Payouts** enabled
(and **Transaction search** for the balance check), and optionally an Anthropic API key (without one, AI triage
fails closed and reviewers decide manually).

```bash
git clone https://github.com/nguyenhuulong2222/aloha-relief && cd aloha-relief
npm ci
export PAYPAL_CLIENT_ID=...            # sandbox app
export PAYPAL_CLIENT_SECRET=...
export ANTHROPIC_API_KEY=...           # optional
export REVIEWER_PASSCODE=kanaloa-local
export SESSION_SECRET=$(openssl rand -hex 32)
export HASH_SALT=$(openssl rand -hex 16)
npm run build && npx tsx scripts/seed.ts && node dist/server.js
# open http://localhost:3000  (volunteer console: /review)
```

Without `DATABASE_URL` the app uses an embedded Postgres (PGlite) in `.pglite/`. On macOS, `npm run dev` reads the
same values from Keychain instead of env vars. See [.env.example](.env.example) for every setting.

Webhooks need a public HTTPS URL. For local testing, run a quick tunnel (for example
`cloudflared tunnel --url http://localhost:3000`), then register it and export the printed ID as `PAYPAL_WEBHOOK_ID`:

```bash
npx tsx scripts/register-webhook.ts https://<your-tunnel>/api/webhooks/paypal
```

### Deploy

`render.yaml` describes the Render free web service. Secrets are set as environment variables on the host;
`npm run deploy` (`scripts/render.sh`) pushes them from macOS Keychain through the Render API and starts a deploy.
The database is Neon free Postgres; the schema migrates itself on boot.

## Checks

```bash
npm run lint && npm run typecheck && npm test
```

86 tests cover the rules, the payout guard and its caps, the database trigger, webhook verification and
ordering, AI fail-closed paths and prompt-injection handling, the public ledger's columns and the demo reset.
`TEST_DATABASE_URL=... npm test` also runs the suite's real-Postgres check.

## Known limits

- Sandbox only. A real fund would need identity checks, KYC for recipients and a second approver for large grants.
- One shared demo passcode; production would use real volunteer accounts.
- Free hosting: the first request after a long idle can take up to a minute.
- Payouts to emails without a sandbox account stay "Sent, unclaimed", as PayPal intends.

## Built with AI

- **In the product:** Claude Haiku 5.5 (Anthropic API) triages requests as described above.
- **To build it:** Claude Code (Claude Opus 5.5) wrote most of the code, tests and docs under the author's direction,
  with an independent AI code review of the money and auth paths. The demo video's narration is AI-generated
  (OpenAI `gpt-4o-mini-tts`).

## License

MIT, see [LICENSE](LICENSE).
