#!/usr/bin/env bash
# Тесты общих модулей Edge Functions.
#
# Модули парсера, форматирования, подписи Telegram и JWT написаны без обращений
# к Deno, поэтому проверяются обычным Node (>= 22, режим снятия типов) — без
# установки зависимостей и без сети.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

node --experimental-strip-types --no-warnings parse.test.ts
node --experimental-strip-types --no-warnings shared.test.ts
