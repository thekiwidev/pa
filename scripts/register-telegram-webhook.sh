#!/usr/bin/env bash
# Point a Telegram bot at this project's webhook. One bot per deployment,
# each with its own secret — never share a bot between dev and prod.
#
#   ./scripts/register-telegram-webhook.sh dev
#   ./scripts/register-telegram-webhook.sh prod
#   ./scripts/register-telegram-webhook.sh dev --info     # just show current state
#
# Reads the token and secret from .env.<env>, which is gitignored. Neither is
# ever printed.
set -euo pipefail

ENVIRONMENT="${1:?usage: $0 <dev|prod> [--info]}"
ENV_FILE=".env.${ENVIRONMENT}"
[[ -f "$ENV_FILE" ]] || { echo "missing $ENV_FILE" >&2; exit 1; }

read_var() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'"'\r'; }

TOKEN="$(read_var TELEGRAM_BOT_TOKEN)"
SECRET="$(read_var TELEGRAM_WEBHOOK_SECRET)"
[[ -n "$TOKEN" && -n "$SECRET" ]] || { echo "TELEGRAM_BOT_TOKEN or TELEGRAM_WEBHOOK_SECRET missing from $ENV_FILE" >&2; exit 1; }

# Convex serves HTTP actions from .convex.site, NOT .convex.cloud.
if [[ "$ENVIRONMENT" == "prod" ]]; then
  SITE_URL="$(bunx convex env get --prod CONVEX_SITE_URL 2>/dev/null || true)"
  [[ -n "$SITE_URL" ]] || SITE_URL="$(bunx --silent convex deploy --dry-run 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.convex\.site' | head -1 || true)"
else
  SITE_URL="$(grep -E '^CONVEX_SITE_URL=' .env.local | head -1 | cut -d= -f2- | tr -d '"'"'"'\r')"
fi
[[ -n "$SITE_URL" ]] || { echo "could not determine the .convex.site URL for $ENVIRONMENT" >&2; exit 1; }

if [[ "${2:-}" == "--info" ]]; then
  curl -s "https://api.telegram.org/bot${TOKEN}/getWebhookInfo" | jq '.result'
  exit 0
fi

# allowed_updates MUST include callback_query, or Telegram silently drops
# every inline-keyboard button tap — the bot never receives it, the button
# spins until the client times out, and nothing appears in any log because
# no request was ever made. Phase 5's cards are unusable without this.
echo "Registering ${SITE_URL}/webhooks/telegram for the ${ENVIRONMENT} bot..."
curl -s -X POST "https://api.telegram.org/bot${TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --arg url "${SITE_URL}/webhooks/telegram" --arg secret "$SECRET" \
        '{url: $url, secret_token: $secret, allowed_updates: ["message", "callback_query"]}')" | jq

echo
echo "Current state:"
curl -s "https://api.telegram.org/bot${TOKEN}/getWebhookInfo" \
  | jq '.result | {url, pending_update_count, last_error_message}'

# From this point getUpdates returns 409 Conflict on this bot. That is correct:
# a webhook and polling are mutually exclusive.
