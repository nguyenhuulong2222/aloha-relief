# Compliance with the hackathon rules

Checked against the PayPal AI Hackathon rules and "What to Submit" on Devpost. Repo links point at `main`.

| Requirement | Status | Evidence |
|---|---|---|
| Uses the PayPal Developer Platform meaningfully (sandbox) | Done | Checkout with JS SDK v6 + Orders v2 ([`web/js/donate.ts`](../web/js/donate.ts), [`src/paypal/orders.ts`](../src/paypal/orders.ts)); grants via Payouts v1 ([`src/paypal/payouts.ts`](../src/paypal/payouts.ts)); verified webhooks ([`src/paypal/webhooks.ts`](../src/paypal/webhooks.ts), [`src/webhook-events.ts`](../src/webhook-events.ts)); balance check via Transaction Search ([`src/paypal/balances.ts`](../src/paypal/balances.ts)) |
| PayPal is central to the project | Done | All money in and out moves through PayPal; the ledger shows only PayPal-backed records and seeded history, labelled by source |
| Uses AI meaningfully | Done | Claude Haiku 5.5 triage with structured output ([`src/ai/`](../src/ai/)); injection detection and flag explanations shown to volunteers |
| Functional demo: hosted URL | Done | https://aloha-relief.onrender.com, kept awake by [`keepwarm.yml`](../.github/workflows/keepwarm.yml) through Dec 16, 2026 |
| Functional demo: setup and run instructions | Done | [README: Run locally](../README.md#run-locally) |
| Demo stays available through judging (Dec 1–15, 2026) | Planned | Render free web service + Neon free Postgres (no expiry, unlike Render's 30-day free Postgres); nightly reset keeps the scenarios fresh |
| Text description of features | Done | [`devpost-submit.md`](devpost-submit.md) |
| Identify AI tools and how they were used | Done | [`devpost-submit.md`: AI tools used](devpost-submit.md#ai-tools-used-and-how), [README: Built with AI](../README.md#built-with-ai) |
| Public repository with all source, assets and instructions | Done | https://github.com/nguyenhuulong2222/aloha-relief (fonts are self-hosted from the OFL Atkinson Hyperlegible package) |
| Open-source license visible in the About section | Done | [`LICENSE`](../LICENSE) (MIT); GitHub detects it as MIT |
| New work created for the hackathon | Done | Repository history starts on Oct 23, 2026; no code copied from other projects |
| Demo video under 3 minutes | Done (Long uploads) | `video/aloha-relief-demo.mp4`, about 2:40; script in [`video-script.md`](video-script.md) |
| Video public on YouTube, link in the form | Long | Upload as Public, paste the link into the form |
| Video shows the project working | Done | Recorded on the hosted site: real sandbox request, payout and donation |
| No third-party trademarks or copyrighted music | Done | No music. The PayPal button and sandbox login appear only as part of the working product; no logos in the cover image or titles |
| AI-generated voice disclosed | Done | [`devpost-submit.md`](devpost-submit.md#ai-tools-used-and-how): "Narration voice is AI-generated (OpenAI TTS)." |
| Sandbox only, no real money | Done | `PAYPAL_ENV` only accepts `sandbox` ([`src/config.ts`](../src/config.ts)); every page shows the demo banner |
| Fictional data only | Done | Seeded data and scenarios in [`src/demo.ts`](../src/demo.ts); no real people |
| No secrets in the repo | Done | Secrets come from macOS Keychain locally and host env vars in production; `.env*` is git-ignored |
| Submit before Nov 12, 2026 12:00 PT | Long | Internal target: Mon Nov 10, 21:00 HST |
