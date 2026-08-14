-- 0002_rls.sql — изоляция данных (NFR-001, ТЗ-2 разд. II.3)
--
-- Модель доступа:
--   * Клиент ходит в Supabase с собственным JWT, который выдаёт Edge Function `auth`
--     после проверки подписи Telegram initData. Claim `sub` = app.users.id.
--   * Клиенту разрешено только чтение (SELECT) — этого достаточно для Realtime.
--   * Любое изменение данных идёт через SECURITY DEFINER RPC (см. 0003_rpc.sql),
--     чтобы машину состояний нельзя было обойти прямым UPDATE из браузера.

-- ---------------------------------------------------------------------------
-- Кто я
-- ---------------------------------------------------------------------------

create or replace function app.current_user_id() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid;
$$;

-- SECURITY DEFINER: обходит RLS самой app.profiles, иначе политики зациклятся.
create or replace function app.my_profile_ids() returns uuid[]
language sql stable security definer set search_path = app, pg_catalog as $$
  select coalesce(array_agg(p.id), '{}'::uuid[])
    from app.profiles p
   where p.owner_user_id = app.current_user_id();
$$;

-- Видима ли мне сделка: я по любую её сторону.
create or replace function app.can_see_deal(p_deal_id uuid) returns boolean
language sql stable security definer set search_path = app, pg_catalog as $$
  select exists (
    select 1
      from app.deals d
     where d.id = p_deal_id
       and (d.initiator_profile_id = any (app.my_profile_ids())
         or d.partner_profile_id  = any (app.my_profile_ids()))
  );
$$;

revoke all on function app.my_profile_ids() from public;
revoke all on function app.can_see_deal(uuid) from public;
grant execute on function app.current_user_id() to authenticated;
grant execute on function app.my_profile_ids() to authenticated;
grant execute on function app.can_see_deal(uuid) to authenticated;
grant execute on function app.today_msk() to authenticated;

-- ---------------------------------------------------------------------------
-- Включаем RLS везде. Таблиц без политик клиент не увидит вовсе.
-- ---------------------------------------------------------------------------

alter table app.users                 enable row level security;
alter table app.profiles              enable row level security;
alter table app.deals                 enable row level security;
alter table app.payments              enable row level security;
alter table app.attachments           enable row level security;
alter table app.invites               enable row level security;
alter table app.audit_log             enable row level security;
alter table app.notification_settings enable row level security;
alter table app.outbox                enable row level security;

-- Свой профиль пользователя.
create policy users_select_self on app.users
  for select to authenticated
  using (id = app.current_user_id());

-- Контрагента нужно видеть по имени и аватару, поэтому вторая политика открывает
-- строку пользователя, если у нас есть общая сделка. Ничего сверх карточки Telegram
-- там всё равно не хранится (Р-3).
create policy users_select_counterparty on app.users
  for select to authenticated
  using (
    exists (
      select 1
        from app.deals d
        join app.profiles p
          on p.id = case
                      when d.initiator_profile_id = any (app.my_profile_ids())
                        then d.partner_profile_id
                      else d.initiator_profile_id
                    end
       where (d.initiator_profile_id = any (app.my_profile_ids())
           or d.partner_profile_id  = any (app.my_profile_ids()))
         and p.owner_user_id = app.users.id
    )
  );

-- Свои профили.
create policy profiles_select_own on app.profiles
  for select to authenticated
  using (owner_user_id = app.current_user_id());

-- Профили контрагентов по общим сделкам. NFR-001: чужие профили, с которыми
-- сделок не было, невидимы — конкуренты не находят друг друга.
create policy profiles_select_counterparty on app.profiles
  for select to authenticated
  using (
    exists (
      select 1
        from app.deals d
       where (d.initiator_profile_id = app.profiles.id and d.partner_profile_id  = any (app.my_profile_ids()))
          or (d.partner_profile_id   = app.profiles.id and d.initiator_profile_id = any (app.my_profile_ids()))
    )
  );

-- Сделки: только свои, по любую сторону (условие из ТЗ-2, исправленное под мультипрофиль).
create policy deals_select_participant on app.deals
  for select to authenticated
  using (
    initiator_profile_id = any (app.my_profile_ids())
    or partner_profile_id = any (app.my_profile_ids())
  );

create policy payments_select_participant on app.payments
  for select to authenticated
  using (app.can_see_deal(deal_id));

create policy attachments_select_participant on app.attachments
  for select to authenticated
  using (app.can_see_deal(deal_id));

-- FR-034: история статусов видна обеим сторонам сделки.
create policy audit_select_participant on app.audit_log
  for select to authenticated
  using (deal_id is not null and app.can_see_deal(deal_id));

create policy invites_select_own on app.invites
  for select to authenticated
  using (inviter_profile_id = any (app.my_profile_ids()));

create policy notification_settings_select_own on app.notification_settings
  for select to authenticated
  using (user_id = app.current_user_id());

-- app.outbox остаётся без политик: очередь доставки — внутренняя кухня,
-- клиенту она не нужна и не видна.

-- ---------------------------------------------------------------------------
-- Права. Никаких INSERT/UPDATE/DELETE клиенту — только через RPC.
-- ---------------------------------------------------------------------------

grant usage on schema app to authenticated;

grant select on
  app.users,
  app.profiles,
  app.deals,
  app.payments,
  app.attachments,
  app.invites,
  app.audit_log,
  app.notification_settings
to authenticated;

grant select on app.deals_view, app.bilateral_stats to authenticated;

-- Роль anon не получает ничего: без валидного JWT приложение пустое.
revoke all on schema app from anon;

-- ---------------------------------------------------------------------------
-- Realtime (ТЗ-2 разд. I): подписка на изменения своих сделок.
-- Realtime применяет те же RLS-политики, поэтому чужие строки не утекут.
-- ---------------------------------------------------------------------------

alter publication supabase_realtime add table app.deals;
alter publication supabase_realtime add table app.payments;
