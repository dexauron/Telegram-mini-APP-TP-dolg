#!/usr/bin/env bash
# Проверка развёрнутого сервиса «Уговор».
#
# Запускается после деплоя и отвечает на вопрос «всё ли поднялось». Ничего не
# меняет, только читает. Секреты берутся из окружения и не выводятся.
#
# Использование:
#   export SUPABASE_URL=https://<ref>.supabase.co
#   export SUPABASE_ANON_KEY=...
#   export TELEGRAM_BOT_TOKEN=...
#   export MINI_APP_URL=https://ugovor.pages.dev
#   export SUPABASE_DB_URL=postgresql://...   # необязательно, для проверки CRON
#   scripts/check-deploy.sh

set -uo pipefail

passed=0
failed=0

ok()   { echo "  OK      $1"; passed=$((passed + 1)); }
fail() { echo "  ОШИБКА  $1"; failed=$((failed + 1)); }
warn() { echo "  ПРОПУСК $1"; }

need() {
  if [ -z "${!1:-}" ]; then
    echo "Не задана переменная $1 — см. docs/03-zapusk.md"
    exit 2
  fi
}

need SUPABASE_URL
need SUPABASE_ANON_KEY
need TELEGRAM_BOT_TOKEN

API="${SUPABASE_URL%/}"

echo "==> Бот"

bot_info=$(curl -s --max-time 15 "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getMe")
if echo "$bot_info" | grep -q '"ok":true'; then
  username=$(echo "$bot_info" | grep -o '"username":"[^"]*"' | head -1 | cut -d'"' -f4)
  ok "бот отвечает: @$username"
else
  fail "бот не отвечает — проверьте TELEGRAM_BOT_TOKEN"
fi

# Инлайн-режим обязателен: без него не работает создание записи из чата.
if echo "$bot_info" | grep -q '"supports_inline_queries":true'; then
  ok "инлайн-режим включён"
else
  fail "инлайн-режим выключен — включите /setinline у @BotFather"
fi

hook=$(curl -s --max-time 15 "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getWebhookInfo")
hook_url=$(echo "$hook" | grep -o '"url":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ -n "$hook_url" ]; then
  ok "вебхук подключён: $hook_url"
else
  fail "вебхук не подключён — выполните setWebhook (см. README)"
fi

if echo "$hook" | grep -q '"has_custom_certificate":false'; then :; fi

last_error=$(echo "$hook" | grep -o '"last_error_message":"[^"]*"' | cut -d'"' -f4)
if [ -n "$last_error" ]; then
  fail "последняя ошибка доставки: $last_error"
else
  ok "ошибок доставки обновлений нет"
fi

pending=$(echo "$hook" | grep -o '"pending_update_count":[0-9]*' | cut -d: -f2)
if [ "${pending:-0}" -gt 50 ]; then
  fail "накопилось необработанных обновлений: $pending — вебхук, вероятно, падает"
else
  ok "очередь обновлений в норме (${pending:-0})"
fi

echo "==> Edge Functions"

for fn in auth report attachment; do
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 \
    -X POST "$API/functions/v1/$fn" \
    -H "Content-Type: application/json" -d '{}')
  # 400 или 401 означают, что функция жива и отвергла заведомо неверный запрос.
  case "$code" in
    400|401) ok "функция $fn отвечает" ;;
    404)     fail "функция $fn не задеплоена" ;;
    *)       fail "функция $fn вернула HTTP $code" ;;
  esac
done

worker=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 \
  -X POST "$API/functions/v1/outbox-worker" -H "Content-Type: application/json" -d '{}')
if [ "$worker" = "403" ]; then
  ok "рассыльщик закрыт от посторонних"
elif [ "$worker" = "404" ]; then
  fail "функция outbox-worker не задеплоена"
else
  fail "рассыльщик доступен снаружи (HTTP $worker) — проверьте SUPABASE_SERVICE_ROLE_KEY"
fi

echo "==> База данных"

# Схема app должна быть открыта в API, иначе клиент не увидит таблицы.
schema=$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 \
  "$API/rest/v1/deals_view?select=id&limit=1" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Accept-Profile: app")
case "$schema" in
  200) ok "схема app открыта в API" ;;
  404|406) fail "схема app не открыта — Settings → API → Exposed schemas" ;;
  *)   fail "REST вернул HTTP $schema" ;;
esac

# Без токена данные не должны отдаваться: RLS обязана вернуть пустой список.
rows=$(curl -s --max-time 20 "$API/rest/v1/deals_view?select=id&limit=5" \
  -H "apikey: $SUPABASE_ANON_KEY" -H "Accept-Profile: app")
if [ "$rows" = "[]" ]; then
  ok "без авторизации данные не отдаются"
else
  fail "анонимный запрос вернул данные — проверьте политики RLS"
fi

if [ -n "${SUPABASE_DB_URL:-}" ] && command -v psql >/dev/null; then
  jobs=$(psql "$SUPABASE_DB_URL" -tAc \
    "select count(*) from cron.job where jobname in ('daily-00-01-msk','outbox-worker')" 2>/dev/null)
  if [ "${jobs:-0}" -ge 2 ]; then
    ok "задачи планировщика на месте"
  else
    fail "в планировщике нет ежедневной задачи или рассыльщика"
  fi

  settings=$(psql "$SUPABASE_DB_URL" -tAc \
    "select count(*) from app.settings where key in ('outbox_worker_url','service_role_key')" 2>/dev/null)
  if [ "${settings:-0}" -ge 2 ]; then
    ok "настройки планировщика заполнены"
  else
    fail "не заполнена app.settings — рассыльщик не запустится"
  fi
else
  warn "проверка планировщика (нужны SUPABASE_DB_URL и psql)"
fi

if [ -n "${MINI_APP_URL:-}" ]; then
  echo "==> Mini App"
  for page in "" "terms.html" "privacy.html"; do
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "${MINI_APP_URL%/}/$page")
    if [ "$code" = "200" ]; then
      ok "открывается /${page}"
    else
      fail "/${page} вернул HTTP $code"
    fi
  done
fi

echo
echo "Проверок пройдено: $passed, с ошибками: $failed"
[ "$failed" -eq 0 ]
