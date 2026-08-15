-- 0005_auth.sql — функции для Edge Functions.
--
-- Вызываются с ключом service_role: это доверенный серверный код, который сам
-- проверил подпись Telegram. Клиенту эти функции не выдаются.

-- ---------------------------------------------------------------------------
-- Онбординг: заводим пользователя и профиль по умолчанию (FR-001, FR-007)
-- ---------------------------------------------------------------------------

create or replace function app.upsert_telegram_user(
  p_telegram_id   bigint,
  p_username      text default null,
  p_first_name    text default null,
  p_last_name     text default null,
  p_photo_url     text default null,
  p_language_code text default null
) returns jsonb
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  u app.users;
begin
  insert into app.users (telegram_id, username, first_name, last_name, photo_url, language_code)
  values (p_telegram_id, p_username, p_first_name, p_last_name, p_photo_url, p_language_code)
  on conflict (telegram_id) do update
    set username      = coalesce(excluded.username, app.users.username),
        first_name    = coalesce(excluded.first_name, app.users.first_name),
        last_name     = coalesce(excluded.last_name, app.users.last_name),
        photo_url     = coalesce(excluded.photo_url, app.users.photo_url),
        language_code = coalesce(excluded.language_code, app.users.language_code),
        last_seen_at  = now(),
        -- Пользователь вернулся — значит, бот снова может ему писать.
        bot_blocked   = false
  returning * into u;

  if u.is_banned then
    raise exception 'Аккаунт заблокирован: %', coalesce(u.banned_reason, 'нарушение правил')
      using errcode = '42501';
  end if;

  -- Профиль по умолчанию: FR-007 разрешает уточнить роль позже, поэтому
  -- заводим универсальный 'both' и не мучаем человека вопросами на входе.
  if not exists (select 1 from app.profiles where owner_user_id = u.id) then
    insert into app.profiles (owner_user_id, kind, name, is_default)
    values (u.id, 'both',
            coalesce(nullif(btrim(concat_ws(' ', u.first_name, u.last_name)), ''),
                     nullif(u.username, ''), 'Мой профиль'),
            true);
  end if;

  insert into app.notification_settings (user_id) values (u.id)
  on conflict (user_id) do nothing;

  return jsonb_build_object(
    'user', jsonb_build_object(
      'id', u.id, 'telegram_id', u.telegram_id, 'username', u.username,
      'first_name', u.first_name, 'last_name', u.last_name, 'photo_url', u.photo_url,
      'tos_accepted', u.tos_accepted_at is not null),
    'profiles', coalesce((
      select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'kind', p.kind,
                                          'is_default', p.is_default)
                        order by p.is_default desc, p.created_at)
        from app.profiles p
       where p.owner_user_id = u.id and p.archived_at is null), '[]'::jsonb)
  );
end;
$$;

-- FR-003: принятие оферты при первом входе.
create or replace function app.rpc_accept_tos() returns void
language sql security definer set search_path = app, pg_catalog as $$
  update app.users set tos_accepted_at = coalesce(tos_accepted_at, now())
   where id = app.current_user_id();
$$;

-- FR-012: переименование профиля и уточнение роли.
create or replace function app.rpc_update_profile(
  p_profile_id uuid, p_name text default null, p_kind app.profile_kind default null
) returns void
language plpgsql security definer set search_path = app, pg_catalog as $$
begin
  perform app.assert_my_profile(p_profile_id);
  update app.profiles
     set name = coalesce(nullif(btrim(p_name), ''), name),
         kind = coalesce(p_kind, kind)
   where id = p_profile_id;
end;
$$;

-- FR-056, FR-057, FR-061, Р-7.
create or replace function app.rpc_update_notification_settings(
  p_remind_days_before smallint[] default null,
  p_overdue_frequency  app.overdue_frequency default null,
  p_payment_auto_confirm_days smallint default null,
  p_muted_kinds        text[] default null
) returns void
language sql security definer set search_path = app, pg_catalog as $$
  insert into app.notification_settings (user_id) values (app.current_user_id())
  on conflict (user_id) do nothing;

  update app.notification_settings
     set remind_days_before = coalesce(p_remind_days_before, remind_days_before),
         overdue_frequency  = coalesce(p_overdue_frequency, overdue_frequency),
         payment_auto_confirm_days =
           coalesce(p_payment_auto_confirm_days, payment_auto_confirm_days),
         muted_kinds        = coalesce(p_muted_kinds, muted_kinds),
         updated_at         = now()
   where user_id = app.current_user_id();
$$;

-- ---------------------------------------------------------------------------
-- Приглашения: карточка по токену (deep link и inline)
-- ---------------------------------------------------------------------------

-- Отдаёт краткое описание сделки предъявителю токена. Токен и есть право
-- увидеть карточку: он приходит из инлайн-сообщения или ссылки-приглашения.
create or replace function app.invite_preview(p_token text) returns jsonb
language sql security definer set search_path = app, pg_catalog as $$
  select jsonb_build_object(
    'deal_id',      d.id,
    'amount_minor', d.amount_minor,
    'due_date',     d.due_date,
    'description',  d.description,
    'debtor_side',  d.debtor_side,
    'status',       d.status,
    'inviter',      jsonb_build_object('profile_id', ip.id, 'name', ip.name,
                                       'telegram_id', iu.telegram_id))
    from app.invites i
    join app.deals d     on d.id = i.deal_id
    join app.profiles ip on ip.id = i.inviter_profile_id
    join app.users iu    on iu.id = ip.owner_user_id
   where i.token = p_token and i.used_at is null and i.expires_at > now();
$$;

-- ---------------------------------------------------------------------------
-- Очередь уведомлений для рассыльщика
-- ---------------------------------------------------------------------------

-- Забирает порцию сообщений. SKIP LOCKED позволяет запустить несколько
-- рассыльщиков параллельно, не рассылая дубли.
create or replace function app.outbox_take(p_limit integer default 25) returns jsonb
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  result jsonb;
begin
  with picked as (
    select o.id
      from app.outbox o
     where o.sent_at is null
       and o.scheduled_at <= now()
       and o.attempts < 5
     order by o.priority, o.scheduled_at
     limit p_limit
       for update skip locked
  ),
  bumped as (
    update app.outbox o
       set attempts = o.attempts + 1
      from picked
     where o.id = picked.id
    returning o.id, o.kind, o.payload, o.user_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', b.id, 'kind', b.kind, 'payload', b.payload,
           'telegram_id', u.telegram_id,
           'deal', case when b.payload ? 'deal_id' then (
             select jsonb_build_object(
                      'amount_minor',  d.amount_minor,
                      'paid_minor',    d.paid_minor,
                      'due_date',      d.due_date,
                      'description',   d.description,
                      'status',        d.status,
                      'counterparty',  cp.name)
               from app.deals d
               left join app.profiles mine on mine.owner_user_id = u.id
                 and mine.id in (d.initiator_profile_id, d.partner_profile_id)
               left join app.profiles cp on cp.id = case
                    when d.initiator_profile_id = mine.id then d.partner_profile_id
                    else d.initiator_profile_id end
              where d.id = (b.payload ->> 'deal_id')::uuid
              limit 1) end)), '[]'::jsonb)
    into result
    from bumped b
    join app.users u on u.id = b.user_id
   where not u.bot_blocked and not u.is_banned;

  return result;
end;
$$;

create or replace function app.outbox_mark_sent(p_ids bigint[]) returns void
language sql security definer set search_path = app, pg_catalog as $$
  update app.outbox set sent_at = now(), last_error = null
   where id = any (p_ids);
$$;

-- Пользователь заблокировал бота — больше ему не пишем (иначе очередь будет
-- бесконечно долбиться в Telegram и жечь лимиты).
create or replace function app.outbox_mark_failed(
  p_id bigint, p_error text, p_blocked boolean default false
) returns void
language plpgsql security definer set search_path = app, pg_catalog as $$
begin
  update app.outbox set last_error = left(p_error, 500) where id = p_id;

  if p_blocked then
    update app.users u set bot_blocked = true
      from app.outbox o where o.id = p_id and u.id = o.user_id;
    update app.outbox set sent_at = now() where id = p_id;
  end if;
end;
$$;

-- Ничего из перечисленного клиенту не выдаём: работает только service_role,
-- кроме трёх функций, которые вызывает сам пользователь из Mini App.
grant execute on function
  app.rpc_accept_tos(),
  app.rpc_update_profile(uuid, text, app.profile_kind),
  app.rpc_update_notification_settings(smallint[], app.overdue_frequency, smallint, text[])
to authenticated;

-- ---------------------------------------------------------------------------
-- Правка черновика до отправки (FR-018: «Изменить» в карточке-предпросмотре)
-- ---------------------------------------------------------------------------

create or replace function app.rpc_update_draft(
  p_deal_id      uuid,
  p_amount_minor bigint default null,
  p_due_date     date default null,
  p_description  text default null,
  p_debtor_side  app.deal_side default null
) returns void
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  d app.deals;
begin
  d := app.load_deal(p_deal_id);
  if d.status <> 'draft' then
    raise exception 'Править можно только черновик' using errcode = 'P0001';
  end if;
  if app.my_side(d) <> 'initiator' then
    raise exception 'Править может только создатель' using errcode = '42501';
  end if;

  update app.deals
     set amount_minor = coalesce(p_amount_minor, amount_minor),
         due_date     = coalesce(p_due_date, due_date),
         description  = coalesce(p_description, description),
         debtor_side  = coalesce(p_debtor_side, debtor_side)
   where id = d.id;
end;
$$;

grant execute on function
  app.rpc_update_draft(uuid, bigint, date, text, app.deal_side)
to authenticated;

-- Токен приглашения по сделке: нужен боту, чтобы отдать создателю ссылку
-- для пересылки контрагенту (ТЗ-2 III.1, внешний канал).
create or replace function app.deal_invite_token(p_deal_id uuid) returns text
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  d app.deals;
begin
  d := app.load_deal(p_deal_id);   -- заодно проверяет, что вызывающий — сторона сделки
  return (select i.token from app.invites i
           where i.deal_id = d.id and i.used_at is null and i.expires_at > now()
           order by i.created_at desc limit 1);
end;
$$;

-- Переключатель «мне должны / я должен» под карточкой-предпросмотром.
create or replace function app.rpc_toggle_draft_side(p_deal_id uuid) returns text
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  d        app.deals;
  new_side app.deal_side;
begin
  d := app.load_deal(p_deal_id);
  if d.status <> 'draft' then
    raise exception 'Менять стороны можно только до отправки' using errcode = 'P0001';
  end if;
  if app.my_side(d) <> 'initiator' then
    raise exception 'Править может только создатель' using errcode = '42501';
  end if;

  new_side := case when d.debtor_side = 'partner' then 'initiator' else 'partner' end;
  update app.deals set debtor_side = new_side where id = d.id;
  return new_side::text;
end;
$$;

-- Пользователь заблокировал бота: писать ему больше нельзя (FR-055).
create or replace function app.mark_bot_blocked(p_telegram_id bigint) returns void
language sql security definer set search_path = app, pg_catalog as $$
  update app.users set bot_blocked = true where telegram_id = p_telegram_id;
$$;

grant execute on function
  app.deal_invite_token(uuid),
  app.rpc_toggle_draft_side(uuid)
to authenticated;
