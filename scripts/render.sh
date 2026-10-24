#!/usr/bin/env bash
# Deploys to Render with secrets read from Keychain into this process only. Never echoes values.
set -euo pipefail
kc() { security find-generic-password -s "$1" -w 2>/dev/null || true; }
export RENDER_API_KEY="$(kc render-api-key)"
export PAYPAL_CLIENT_ID="$(kc paypal-sandbox-client-id)"
export PAYPAL_CLIENT_SECRET="$(kc paypal-sandbox-secret)"
export ANTHROPIC_API_KEY="$(kc anthropic-api-key)"
export DATABASE_URL="$(kc neon-database-url)"
export REVIEWER_PASSCODE="$(kc aloha-relief-reviewer-passcode)"
export SESSION_SECRET="$(kc aloha-relief-prod-session-secret)"
export HASH_SALT="$(kc aloha-relief-prod-hash-salt)"
export PAYPAL_WEBHOOK_ID="$(kc aloha-relief-webhook-id-prod)"
export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-https://aloha-relief.onrender.com}"
exec npx tsx scripts/deploy-render.ts
