-- 0004_cron.sql — ежедневная автоматизация (ТЗ-2 разд. III.4, FR-031, FR-038, Р-7)
--
-- pg_cron работает в UTC, вся бизнес-логика — в MSK (Р-11):
--   00:01 МСК = 21:01 UTC предыдущих суток.
--
-- Расширения pg_cron и pg_net включаются один раз в панели Supabase
-- (Database → Extensions) либо командами ниже.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Настройки среды: URL проекта и ключ для вызова Edge Function из планировщика.
-- Заполняется вручную после деплоя (см. README), в репозиторий ключи не попадают.
create table if not exists app.settings (
  key   text primary key,
  value text not null
);
alter table app.settings enable row level security;  -- без политик: только service_role

-- ---------------------------------------------------------------------------
-- Ежедневные задачи
-- ---------------------------------------------------------------------------

-- ТЗ-2 III.4: зависшие споры с прошедшим сроком принудительно замораживаются,
-- пинг-понг предложениями прекращается.
create or replace function app.job_freeze_stale_negotiations() returns integer
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  affected integer := 0;
  d app.deals;
begin
  for d in
    select * from app.deals
     where status = 'negotiation'
       and due_date < app.today_msk()
       and amount_minor > paid_minor
  loop
    update app.deals set status = 'frozen', frozen_at = now() where id = d.id;
    perform app.log(d.id, null, 'deal.frozen',
      jsonb_build_object('reason', 'negotiation_past_due', 'due_date', d.due_date));
    perform app.enqueue(app.profile_owner(d.initiator_profile_id), 'deal.frozen',
      jsonb_build_object('deal_id', d.id), 'deal.frozen:i:' || d.id);
    perform app.enqueue(app.profile_owner(d.partner_profile_id), 'deal.frozen',
      jsonb_build_object('deal_id', d.id), 'deal.frozen:p:' || d.id);
    affected := affected + 1;
  end loop;
  return affected;
end;
$$;

-- FR-031/FR-035 + FR-056/FR-057. При 500 000 пользователей поштучные сообщения
-- («по сделке №1 просрочка», «по сделке №2 просрочка») дали бы миллионы отправок
-- в сутки и упёрлись бы в лимит Telegram (~30 сообщений в секунду от бота).
-- Поэтому плановые напоминания собираются в одну сводку на пользователя в день,
-- а мгновенные уведомления о действиях контрагента остаются поштучными.
create or replace function app.job_build_digests() returns integer
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  affected integer := 0;
  r record;
begin
  for r in
    with visible as (
      -- Каждая незакрытая сделка попадает к обоим участникам.
      select pr.owner_user_id as user_id, d.id as deal_id, d.due_date,
             (d.amount_minor - d.paid_minor) as remaining_minor,
             (app.today_msk() - d.due_date) as days_late,
             (d.due_date - app.today_msk()) as days_left
        from app.deals d
        join app.profiles pr on pr.id in (d.initiator_profile_id, d.partner_profile_id)
       where d.status in ('accepted', 'negotiation', 'frozen')
         and d.amount_minor > d.paid_minor
         -- Р-7: заявленный платёж останавливает напоминания по этой сделке.
         and not exists (select 1 from app.payments p
                          where p.deal_id = d.id and p.status = 'claimed')
    ),
    filtered as (
      select v.*,
             coalesce(s.overdue_frequency, 'daily') as freq,
             coalesce(s.remind_days_before, '{1,3}'::smallint[]) as remind_days
        from visible v
        join app.users u on u.id = v.user_id and not u.is_banned and not u.bot_blocked
        left join app.notification_settings s on s.user_id = v.user_id
    )
    select user_id,
           count(*) filter (where days_late > 0
                              and freq <> 'off'
                              and (freq <> 'every_2_days' or days_late % 2 = 0)
                              and (freq <> 'weekly'       or days_late % 7 = 0)) as overdue_count,
           coalesce(sum(remaining_minor) filter (where days_late > 0), 0)        as overdue_minor,
           count(*) filter (where days_left >= 0 and days_left::smallint = any (remind_days)) as soon_count,
           coalesce(sum(remaining_minor)
                    filter (where days_left >= 0 and days_left::smallint = any (remind_days)), 0) as soon_minor,
           (array_agg(deal_id order by due_date)
              filter (where days_late > 0 or days_left::smallint = any (remind_days)))[1:10] as deal_ids
      from filtered
     group by user_id
  loop
    -- Пустые сводки не рассылаем.
    continue when r.overdue_count = 0 and r.soon_count = 0;

    perform app.enqueue(
      r.user_id, 'digest.daily',
      jsonb_build_object(
        'overdue_count', r.overdue_count, 'overdue_minor', r.overdue_minor,
        'soon_count',    r.soon_count,    'soon_minor',    r.soon_minor,
        'deal_ids',      to_jsonb(r.deal_ids)),
      'digest.daily:' || r.user_id || ':' || app.today_msk(),
      5::smallint
    );
    -- Рассылку разносим по времени: разом её всё равно не отправить.
    update app.outbox
       set scheduled_at = app.digest_slot(r.user_id)
     where dedup_key = 'digest.daily:' || r.user_id || ':' || app.today_msk()
       and sent_at is null;

    affected := affected + 1;
  end loop;
  return affected;
end;
$$;

-- Плановая сводка уходит с 9:00 МСК, равномерно размазанная на два часа:
-- 100 000 сообщений при лимите ~30/сек занимают около часа, поэтому очередь
-- должна быть растянута, а не свалена в одну минуту.
create or replace function app.digest_slot(p_user_id uuid) returns timestamptz
language sql stable set search_path = app, pg_catalog as $$
  select ((app.today_msk() + time '09:00') at time zone 'Europe/Moscow')
         + make_interval(secs => (abs(hashtext(p_user_id::text)) % 7200));
$$;

-- Р-7: молчание кредитора дольше N дней трактуется как согласие. Иначе должник
-- вечно висит в просрочке из-за бездействия второй стороны.
create or replace function app.job_auto_confirm_payments() returns integer
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  affected integer := 0;
  p app.payments;
begin
  for p in
    select * from app.payments
     where status = 'claimed' and auto_confirm_after <= now()
  loop
    update app.payments
       set status = 'confirmed', resolved_at = now(), auto_confirmed = true
     where id = p.id;

    perform app.log(p.deal_id, null, 'payment.auto_confirmed',
      jsonb_build_object('payment_id', p.id, 'amount_minor', p.amount_minor));
    perform app.close_if_fully_paid(p.deal_id);
    affected := affected + 1;
  end loop;
  return affected;
end;
$$;

-- FR-092: протухшие приглашения.
create or replace function app.job_expire_invites() returns integer
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  affected integer;
begin
  delete from app.invites where used_at is null and expires_at < now();
  get diagnostics affected = row_count;
  return affected;
end;
$$;

create or replace function app.job_daily() returns jsonb
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  result jsonb;
begin
  result := jsonb_build_object(
    'frozen',           app.job_freeze_stale_negotiations(),
    'auto_confirmed',   app.job_auto_confirm_payments(),
    'digests',          app.job_build_digests(),
    'invites_expired',  app.job_expire_invites(),
    'ran_at',           now()
  );
  insert into app.audit_log (action, payload) values ('cron.daily', result);
  return result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Обслуживание секций журнала действий
-- ---------------------------------------------------------------------------

-- Создаёт помесячные партиции на несколько месяцев вперёд. Без этого записи
-- падают в партицию default, и она со временем становится узким местом.
create or replace function app.ensure_audit_partitions(p_months_ahead integer default 3)
returns integer
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  created integer := 0;
  m       date;
  part    text;
begin
  for i in 0..p_months_ahead loop
    m := date_trunc('month', app.today_msk() + make_interval(months => i))::date;
    part := 'audit_log_' || to_char(m, 'YYYY_MM');
    if not exists (select 1 from pg_class where relname = part) then
      execute format(
        'create table app.%I partition of app.audit_log for values from (%L) to (%L)',
        part, m, (m + interval '1 month')::date);
      created := created + 1;
    end if;
  end loop;
  return created;
end;
$$;

-- Журнал старше двух лет отцепляется и удаляется целой партицией — мгновенно,
-- без нагрузки на базу. Сами сделки при этом остаются нетронутыми.
create or replace function app.drop_old_audit_partitions(p_keep_months integer default 24)
returns integer
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  dropped integer := 0;
  r       record;
  cutoff  date := date_trunc('month', app.today_msk() - make_interval(months => p_keep_months))::date;
begin
  for r in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'app'
       and c.relname ~ '^audit_log_[0-9]{4}_[0-9]{2}$'
       and to_date(right(c.relname, 7), 'YYYY_MM') < cutoff
  loop
    execute format('drop table app.%I', r.relname);
    dropped := dropped + 1;
  end loop;
  return dropped;
end;
$$;

select app.ensure_audit_partitions(3);

-- ---------------------------------------------------------------------------
-- Доставка уведомлений: планировщик пингует Edge Function, та разбирает outbox
-- и шлёт сообщения ботом.
-- ---------------------------------------------------------------------------

create or replace function app.kick_outbox_worker() returns void
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  fn_url  text;
  fn_key  text;
begin
  if not exists (select 1 from app.outbox where sent_at is null and scheduled_at <= now()) then
    return;   -- нечего отправлять — не тратим вызовы Edge Function
  end if;

  select value into fn_url from app.settings where key = 'outbox_worker_url';
  select value into fn_key from app.settings where key = 'service_role_key';
  if fn_url is null or fn_key is null then
    return;   -- проект ещё не сконфигурирован, см. README
  end if;

  perform net.http_post(
    url     := fn_url,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || fn_key),
    body    := '{}'::jsonb
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Расписание
-- ---------------------------------------------------------------------------

select cron.schedule('daily-00-01-msk', '1 21 * * *', $$ select app.job_daily(); $$);
select cron.schedule('outbox-worker',   '* * * * *',  $$ select app.kick_outbox_worker(); $$);
-- Бесплатный тариф Supabase усыпляет проект после недели простоя — держим его живым.
select cron.schedule('keepalive',       '0 */6 * * *', $$ select 1; $$);
-- Партиции журнала: создаём заранее, старые убираем раз в месяц.
select cron.schedule('audit-partitions', '30 21 28 * *',
  $$ select app.ensure_audit_partitions(3), app.drop_old_audit_partitions(24); $$);
