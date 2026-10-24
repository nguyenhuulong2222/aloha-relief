# Aloha Relief

Small, supervised disaster micro-grants on PayPal. **Rules check. AI explains. People decide.**

> Demo: PayPal sandbox money and fictional people only ("Kanaloa Relief Fund").

Work in progress for the PayPal "Build What's Next with PayPal and AI" hackathon. The full README, architecture
diagram and hosted URL land before submission. See [docs/PLAN.md](docs/PLAN.md).

## Run locally

Requirements: Node 22+, a PayPal Developer sandbox REST app (client ID + secret) with Payouts enabled, and
optionally an Anthropic API key (without one, AI triage fails closed and reviewers decide manually).

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
same values from Keychain instead of env vars.

Webhooks need a public HTTPS URL. For local testing, run a quick tunnel (for example
`cloudflared tunnel --url http://localhost:3000`), then register it and export the printed ID as `PAYPAL_WEBHOOK_ID`:

```bash
npx tsx scripts/register-webhook.ts https://<your-tunnel>/api/webhooks/paypal
```

## Checks

```bash
npm run lint && npm run typecheck && npm test
```

## License

MIT, see [LICENSE](LICENSE).
