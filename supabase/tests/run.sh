#!/usr/bin/env bash
# Прогон миграций и сквозного теста на локальном Postgres.
#
# Поднимает временный кластер, имитирует окружение Supabase (роли anon /
# authenticated / service_role, публикация supabase_realtime, заглушки pg_cron
# и pg_net), накатывает миграции и запускает state_machine_test.sql.
#
# Требуется postgresql-16 и права запускать процессы от пользователя postgres.
# Использование: supabase/tests/run.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="${PGTEST_DIR:-/var/tmp/mostdolgov-pgtest}"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PORT="${PGTEST_PORT:-5433}"
DB=mostdolgov

# Локально скрипт запускают под root, в CI — под обычным пользователем с sudo.
if [ "$(id -u)" = "0" ]; then
  as_postgres() { su postgres -c "$1"; }
else
  as_postgres() { sudo -u postgres bash -c "$1"; }
fi

psql_as() { as_postgres "psql -h $WORK/run -p $PORT $*"; }

echo "==> Готовим временный кластер в $WORK"
rm -rf "$WORK"
mkdir -p "$WORK/data" "$WORK/run"
chown -R postgres:postgres "$WORK"
chmod 755 "$WORK"

as_postgres "$PGBIN/initdb -D $WORK/data -A trust" >/dev/null
as_postgres "$PGBIN/pg_ctl -D $WORK/data \
  -o '-k $WORK/run -p $PORT -c listen_addresses=' -l $WORK/pg.log start" >/dev/null
trap 'as_postgres "$PGBIN/pg_ctl -D $WORK/data stop -m immediate" >/dev/null 2>&1 || true' EXIT

echo "==> Создаём роли и базу"
psql_as "-d postgres -q -c \"create role anon nologin\" \
  -c \"create role authenticated nologin\" \
  -c \"create role service_role nologin bypassrls\" \
  -c \"create database $DB\""

cat > "$WORK/stubs.sql" <<'SQL'
create publication supabase_realtime;
create schema if not exists cron;
create function cron.schedule(text, text, text) returns bigint language sql as $$ select 1::bigint $$;
create schema if not exists net;
create function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}')
  returns bigint language sql as $$ select 1::bigint $$;
SQL
chown postgres:postgres "$WORK/stubs.sql"
psql_as "-d $DB -q -v ON_ERROR_STOP=1 -f $WORK/stubs.sql" 2>&1 | grep -v 'wal_level' || true

echo "==> Накатываем миграции"
for f in "$ROOT"/supabase/migrations/*.sql; do
  # pg_cron и pg_net локально недоступны — их заменяют заглушки выше.
  sed '/create extension if not exists pg_cron;/d; /create extension if not exists pg_net;/d' \
    "$f" > "$WORK/$(basename "$f")"
  chown postgres:postgres "$WORK/$(basename "$f")"
  echo "    $(basename "$f")"
  psql_as "-d $DB -q -v ON_ERROR_STOP=1 -f $WORK/$(basename "$f")" >/dev/null
done

echo "==> Запускаем сквозной тест"
psql_as "-d $DB -v ON_ERROR_STOP=1 -f $ROOT/supabase/tests/state_machine_test.sql" 2>&1 \
  | grep -E 'NOTICE:|ERROR:|==='
