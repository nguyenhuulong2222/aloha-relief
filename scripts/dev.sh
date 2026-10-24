#!/usr/bin/env bash
# Local dev: loads secrets from macOS Keychain into this process only. Never echoes values.
# Uses in-process PGlite (.pglite/) unless USE_NEON=1.
set -euo pipefail

kc() { security find-generic-password -s "$1" -w 2>/dev/null || true; }
kc_or_create() {
  local v; v="$(kc "$1")"
  if [ -z "$v" ]; then
    v="$(openssl rand -hex 32)"
    security add-generic-password -a "$USER" -s "$1" -w "$v" >/dev/null
  fi
  printf '%s' "$v"
}

export PAYPAL_CLIENT_ID="$(kc paypal-sandbox-client-id)"
export PAYPAL_CLIENT_SECRET="$(kc paypal-sandbox-secret)"
export ANTHROPIC_API_KEY="$(kc anthropic-api-key)"
export PAYPAL_WEBHOOK_ID="${PAYPAL_WEBHOOK_ID:-$(kc aloha-relief-webhook-id-local)}"
export SESSION_SECRET="$(kc_or_create aloha-relief-session-secret)"
export HASH_SALT="$(kc_or_create aloha-relief-hash-salt)"
export REVIEWER_PASSCODE="${REVIEWER_PASSCODE:-kanaloa-local}"
if [ "${USE_NEON:-0}" = "1" ]; then export DATABASE_URL="$(kc neon-database-url)"; fi

for v in PAYPAL_CLIENT_ID PAYPAL_CLIENT_SECRET; do
  if [ -z "${!v}" ]; then echo "Missing Keychain entry for $v" >&2; exit 1; fi
done

npm run build >/dev/null
exec node --enable-source-maps dist/server.js
