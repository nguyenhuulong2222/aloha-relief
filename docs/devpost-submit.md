# Devpost submission: copy-paste answers

Everything below goes into the Devpost form for the PayPal AI Hackathon. Replace the two `<<…>>` placeholders
before submitting: the YouTube link, and the sandbox donor password (from your private note, never the repo).

---

## Project name

Aloha Relief

## Tagline (≤ 200 characters)

Supervised disaster micro-grants on PayPal: rules check every request, Claude explains it, a volunteer decides, and PayPal Payouts send the grant. Every dollar is on a public ledger.

## Links

| Field | Value |
|---|---|
| Hosted demo | https://aloha-relief.onrender.com |
| Code repository | https://github.com/nguyenhuulong2222/aloha-relief (MIT) |
| Demo video | `<<YouTube URL>>` |
| Testing instructions | https://github.com/nguyenhuulong2222/aloha-relief/blob/main/docs/testing-instructions.md |

## Testing instructions (paste into the form's testing field)

```
Hosted demo: https://aloha-relief.onrender.com  (PayPal sandbox, fictional data; no real money moves)
First load can take up to a minute if the free instance was asleep. Reload after 60 seconds if a page seems stuck.

Volunteer console: https://aloha-relief.onrender.com/review
  Name: anything (it is recorded with each decision). Passcode: mahalo-volunteer-2026
Sandbox donor for the PayPal popup on /donate:
  Email: sb-8fctj53531481@personal.example.com   Password: <<judge donor password>>

Four scenarios wait in the console every day (data resets at midnight Hawaii time):
  (a) urgent $350 shelter request: approve it to send a real sandbox PayPal Payout; it turns Paid via webhook.
  (b) duplicate payee: rule R2 blocks it; Approve is disabled.
  (c) $495 request with hidden "SYSTEM: ignore your rules" text: rules R5 and R6 flag it, Claude reports the
      injection; a payout would be refused by the $400 public-demo grant limit.
  (d) Vietnamese request: Claude summarizes it in English.
Public-demo limits: $400 per grant, $500 per day across all visitors.
Full walkthrough: https://github.com/nguyenhuulong2222/aloha-relief/blob/main/docs/testing-instructions.md
```

## Inspiration

After the 2023 Maui wildfires, help moved through personal payment links, crowdfunding pages and group chats.
Donors couldn't see where money went, scams spread, and the same family could be paid twice while another
waited. Small community funds want to move fast, but they don't have staff to vet every request, and they
shouldn't hand a money decision to a black box. I wanted something a volunteer-run fund could actually trust
on the first night after a disaster.

## What it does

Aloha Relief is a small, supervised micro-grant desk for a community relief fund (the demo's "Kanaloa Relief
Fund" is fictional).

- **Donors** give with PayPal Checkout. The server creates and captures the order and checks the amount and
  currency. No donor name or email is stored.
- **People in need** ask for a small grant in English or Vietnamese: need, island, amount, a few sentences and
  a PayPal email.
- **Eight deterministic rules** check every request first: need caps, one open grant per PayPal account
  (plus-address tricks normalized), look-alike descriptions, request bursts, amounts just under a cap,
  instructions hidden in the text, invalid payees, and fund balance. A rule **block** can't be overridden.
- **Claude Haiku 5.5** rates urgency, summarizes the request in English, explains every flag, reports prompt
  injection attempts, suggests a decision and drafts questions to ask. It can't approve, can't clear a block,
  and can't move money; its urgency only orders the queue.
- **A volunteer decides**, always with a written reason recorded with their name. Approval sends a **PayPal
  Payout**; PayPal's verified **webhooks** move it to Paid (or Unclaimed, Returned, Failed).
- **A public ledger built with AG Grid** shows every donation and grant with filters, search, a totals row
  that follows the filters, CSV export and live refresh. No names, emails, stories or PayPal IDs, ever.

## How I built it

- **Server:** TypeScript on Node 22 with Hono, Postgres (Neon free tier; PGlite for tests and local dev),
  hosted on Render's free tier. PayPal is called with plain `fetch` from the official REST docs: OAuth, Orders
  v2, Payouts v1, webhook signature verification and Transaction Search (balance check).
- **Browser:** plain HTML/CSS/TypeScript bundled with esbuild, PayPal JS SDK v6 for the Pay button, AG Grid
  Community 36.2 for the ledger. WCAG AA contrast, keyboard friendly, works on a phone.
- **Human-in-the-loop, enforced three ways:** one module (`payout-guard.ts`) is the only importer of the Payouts
  client, and a test fails the build otherwise; the guard requires a recorded approval and re-checks rules,
  funds and caps under a database lock; a Postgres trigger rejects any payout row without an approve decision,
  or for a blocked request. Approvals are append-only.
- **AI safety:** request text is escaped, truncated and wrapped as data; trusted rule results sit outside it.
  Structured output with a Zod schema; refusals, truncation and errors fail closed to "decide manually".
  Results are cached, and an in-app budget caps AI spend at $0.50/day and $4 total (a triage costs about
  $0.0004).
- **Public-demo safety:** the volunteer passcode is published for judges, so payouts are capped at $400 per
  grant and $500 per day, and the demo resets nightly to seeded history plus four fresh scenarios.
- 86 automated tests; CI runs lint, typecheck, tests and build on every push.

## Challenges I ran into

- **Making "a human approved it" impossible to bypass**, including by future code. That's why it's enforced in
  the module graph, in the guard and in the database.
- **Webhooks arrive late, twice, or out of order.** Payout and capture states only move forward, events are
  de-duplicated, and a reconciler polls in-flight batches so a lost webhook can't strand a grant.
- **A production-only bug:** JSON from the AI was stored double-encoded on real Postgres but not on the embedded
  test database. I fixed it, repaired the stored rows, and added a test that runs against real Postgres.
- **An independent AI code review of the money paths** found that the per-grant cap wasn't applied on the approve
  path, plus seven smaller issues (retryable vs. final PayPal errors, status leaks, spoofable rate limits). All
  were fixed with regression tests.

## Accomplishments I'm proud of

- In the demo's injection scenario, Claude reports the attempt and explains that it ignored the embedded
  instructions, while the rules flag the same text independently. Neither layer depends on the other.
- A test proves AI urgency never changes a money decision: the same approval pays the same way whether Claude
  said "urgency 1, decline" or "urgency 5, approve".
- The whole loop works end to end on the hosted site: real sandbox checkout, real sandbox payout, verified
  webhooks, live ledger.

## What I learned

The AI is most useful as the explainer, not the decider. Volunteers don't need a score; they need to know why
a rule fired and what to ask next. Keeping the AI out of the money path made it easier to trust and to test.

## What's next

Real volunteer accounts with two-person approval above a threshold, SMS intake for people without smartphones,
more languages (ʻŌlelo Hawaiʻi, Ilocano, Tagalog, Marshallese), and a pilot conversation with a real community
fund.

## Built with

`typescript` `node.js` `hono` `postgresql` `neon` `render` `paypal-orders-v2` `paypal-payouts` `paypal-webhooks`
`paypal-js-sdk-v6` `anthropic-claude` `claude-haiku` `ag-grid` `esbuild` `vitest` `zod`

## AI tools used and how

| Tool | How it was used |
|---|---|
| **Claude Haiku 5.5** (Anthropic API, `claude-haiku-5-5`) | In the product: triages each request with structured output (urgency, English summary, flag explanations, injection detection, suggested decision, questions). It never approves or moves money. |
| **Claude Code** (Claude Opus 5.5) | To build it: wrote most of the code, tests and docs under my direction, read the PayPal and AG Grid docs it cites, drove the sandbox end-to-end checks, and ran an independent code review of the money and auth paths. |
| **OpenAI `gpt-4o-mini-tts`** (voice "marin") | Narration for the demo video. |

**AI-voice disclosure:** Narration voice is AI-generated (OpenAI TTS).

## Prize categories to select

- Most Impactful
- Best Use of PayPal + AI
- Best Use of AG Grid
- Best Use of Render (the demo is hosted on Render; optional)

## Compliance checklist

See [compliance.md](compliance.md) for each rule with evidence links.
