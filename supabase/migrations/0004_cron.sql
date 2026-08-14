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

-- FR-031/FR-035: просрочка — признак, а не статус (Р-6), поэтому задача не меняет
-- статус, а только напоминает. Частота — по настройке пользователя (FR-057).
create or replace function app.job_notify_overdue() returns integer
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  affected integer := 0;
  r record;
begin
  for r in
    select d.id, d.initiator_profile_id, d.partner_profile_id,
           (app.today_msk() - d.due_date) as days_late
      from app.deals d
     where d.status in ('accepted', 'negotiation', 'frozen')
       and d.due_date < app.today_msk()
       and d.amount_minor > d.paid_minor
       -- Р-7: заявленный платёж останавливает напоминания о просрочке.
       and not exists (select 1 from app.payments p
                        where p.deal_id = d.id and p.status = 'claimed')
  loop
    perform app.enqueue_overdue(app.profile_owner(r.initiator_profile_id), r.id, r.days_late);
    perform app.enqueue_overdue(app.profile_owner(r.partner_profile_id), r.id, r.days_late);
    affected := affected + 1;
  end loop;
  return affected;
end;
$$;

-- FR-057: ежедневно / через день / раз в неделю / отключить.
create or replace function app.enqueue_overdue(p_user_id uuid, p_deal_id uuid, p_days_late integer)
returns void
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  freq app.overdue_frequency;
begin
  if p_user_id is null then
    return;
  end if;
  select coalesce(s.overdue_frequency, 'daily') into freq
    from app.notification_settings s where s.user_id = p_user_id;
  freq := coalesce(freq, 'daily');

  if freq = 'off' then return; end if;
  if freq = 'every_2_days' and p_days_late % 2 <> 0 then return; end if;
  if freq = 'weekly'       and p_days_late % 7 <> 0 then return; end if;

  perform app.enqueue(p_user_id, 'deal.overdue',
    jsonb_build_object('deal_id', p_deal_id, 'days_late', p_days_late),
    'deal.overdue:' || p_user_id || ':' || p_deal_id || ':' || app.today_msk());
end;
$$;

-- FR-056: напоминание за N дней до срока, N настраивается пользователем.
create or replace function app.job_notify_upcoming() returns integer
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  affected integer := 0;
  r record;
begin
  for r in
    select d.id as deal_id, d.due_date, u.id as user_id,
           (d.due_date - app.today_msk()) as days_left
      from app.deals d
      join app.profiles pr
        on pr.id in (d.initiator_profile_id, d.partner_profile_id)
      join app.users u on u.id = pr.owner_user_id
      left join app.notification_settings s on s.user_id = u.id
     where d.status in ('accepted', 'negotiation')
       and d.amount_minor > d.paid_minor
       and d.due_date >= app.today_msk()
       and (d.due_date - app.today_msk())::smallint
             = any (coalesce(s.remind_days_before, '{1,3}'::smallint[]))
  loop
    perform app.enqueue(r.user_id, 'deal.due_soon',
      jsonb_build_object('deal_id', r.deal_id, 'days_left', r.days_left, 'due_date', r.due_date),
      'deal.due_soon:' || r.user_id || ':' || r.deal_id || ':' || r.due_date);
    affected := affected + 1;
  end loop;
  return affected;
end;
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
    'overdue_notified', app.job_notify_overdue(),
    'due_soon_notified', app.job_notify_upcoming(),
    'invites_expired',  app.job_expire_invites(),
    'ran_at',           now()
  );
  insert into app.audit_log (action, payload) values ('cron.daily', result);
  return result;
end;
$$;

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
