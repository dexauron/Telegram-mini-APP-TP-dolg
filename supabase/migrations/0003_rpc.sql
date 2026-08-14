-- 0003_rpc.sql — машина состояний сделки.
--
-- Все изменения данных проходят только здесь. Функции SECURITY DEFINER, поэтому
-- каждая сама проверяет, что вызывающий действительно сторона сделки: RLS внутри
-- них не действует.
--
-- Переходы (Р-6, Р-9):
--   draft ──► pending ──► accepted ──► completed
--                │           │  ▲
--                │           ▼  │
--                │      negotiation ──► frozen
--                ▼           │             │
--            cancelled ◄─────┴─────────────┘

-- ---------------------------------------------------------------------------
-- Внутренние помощники
-- ---------------------------------------------------------------------------

create or replace function app.assert_my_profile(p_profile_id uuid) returns void
language plpgsql stable security definer set search_path = app, pg_catalog as $$
begin
  if not (p_profile_id = any (app.my_profile_ids())) then
    raise exception 'Профиль не принадлежит текущему пользователю' using errcode = '42501';
  end if;
end;
$$;

create or replace function app.profile_owner(p_profile_id uuid) returns uuid
language sql stable security definer set search_path = app, pg_catalog as $$
  select owner_user_id from app.profiles where id = p_profile_id;
$$;

create or replace function app.log(
  p_deal_id uuid, p_profile_id uuid, p_action text, p_payload jsonb default null
) returns void
language sql security definer set search_path = app, pg_catalog as $$
  insert into app.audit_log (deal_id, actor_user_id, actor_profile_id, action, payload)
  values (p_deal_id, app.current_user_id(), p_profile_id, p_action, p_payload);
$$;

-- Постановка уведомления в очередь. dedup_key защищает от дублей при повторных
-- вызовах и ретраях CRON.
create or replace function app.enqueue(
  p_user_id uuid, p_kind text, p_payload jsonb, p_dedup_key text default null
) returns void
language plpgsql security definer set search_path = app, pg_catalog as $$
begin
  if p_user_id is null then
    return;
  end if;
  -- FR-061: пользователь может отключить отдельные типы уведомлений.
  if exists (
    select 1 from app.notification_settings s
     where s.user_id = p_user_id and p_kind = any (s.muted_kinds)
  ) then
    return;
  end if;

  insert into app.outbox (user_id, kind, payload, dedup_key)
  values (p_user_id, p_kind, p_payload, p_dedup_key)
  on conflict (dedup_key) do nothing;
end;
$$;

-- Уведомить вторую сторону сделки.
create or replace function app.notify_counterparty(
  p_deal app.deals, p_actor_profile_id uuid, p_kind text, p_payload jsonb default '{}'::jsonb
) returns void
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  other_profile uuid;
begin
  other_profile := case
    when p_deal.initiator_profile_id = p_actor_profile_id then p_deal.partner_profile_id
    else p_deal.initiator_profile_id
  end;

  perform app.enqueue(
    app.profile_owner(other_profile),
    p_kind,
    p_payload || jsonb_build_object('deal_id', p_deal.id),
    p_kind || ':' || p_deal.id || ':' || extract(epoch from now())::bigint
  );
end;
$$;

-- Какой стороной сделки я являюсь. null — я вообще не участник.
create or replace function app.my_side(p_deal app.deals) returns app.deal_side
language sql stable security definer set search_path = app, pg_catalog as $$
  select case
    when p_deal.initiator_profile_id = any (app.my_profile_ids()) then 'initiator'::app.deal_side
    when p_deal.partner_profile_id   = any (app.my_profile_ids()) then 'partner'::app.deal_side
    else null
  end;
$$;

create or replace function app.load_deal(p_deal_id uuid) returns app.deals
language plpgsql stable security definer set search_path = app, pg_catalog as $$
declare
  d app.deals;
begin
  select * into d from app.deals where id = p_deal_id;
  if d.id is null then
    raise exception 'Сделка не найдена' using errcode = 'P0002';
  end if;
  if app.my_side(d) is null then
    raise exception 'Нет доступа к сделке' using errcode = '42501';
  end if;
  return d;
end;
$$;

-- Профиль текущего пользователя в этой сделке.
create or replace function app.my_profile_in_deal(p_deal app.deals) returns uuid
language sql stable security definer set search_path = app, pg_catalog as $$
  select case app.my_side(p_deal)
           when 'initiator' then p_deal.initiator_profile_id
           when 'partner'   then p_deal.partner_profile_id
         end;
$$;

-- ---------------------------------------------------------------------------
-- Создание и согласование
-- ---------------------------------------------------------------------------

-- Генератор токена приглашения: 24 символа из алфавита deep-link Telegram.
-- search_path включает и public, и extensions: pgcrypto в Supabase живёт в
-- extensions, в обычном Postgres — в public.
create or replace function app.new_invite_token() returns text
language sql volatile set search_path = public, extensions, pg_catalog as $$
  select translate(encode(gen_random_bytes(18), 'base64'), '+/', '-_');
$$;

-- FR-013, FR-019: запись создаёт любая сторона, отправка контрагенту — отдельным шагом.
-- p_partner_profile_id может быть null: контрагент определится тем, кто нажмёт
-- «Подтвердить» (единственный способ в inline-режиме, см. Р-11). Для такой открытой
-- карточки выпускается одноразовый токен: принять сделку сможет только тот, кому
-- карточка или ссылка действительно попала, а не любой, кто угадал её id.
create or replace function app.rpc_create_deal(
  p_profile_id         uuid,
  p_amount_minor       bigint,
  p_due_date           date,
  p_debtor_side        app.deal_side,
  p_description        text default null,
  p_partner_profile_id uuid default null,
  p_payment_method     text default null,
  p_as_draft           boolean default false
) returns jsonb
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  new_id uuid;
  token  text;
begin
  perform app.assert_my_profile(p_profile_id);

  if p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'Сумма должна быть больше нуля' using errcode = 'P0001';
  end if;
  if p_due_date is null then
    raise exception 'Не указан срок оплаты' using errcode = 'P0001';
  end if;
  if p_partner_profile_id is not null and p_partner_profile_id = p_profile_id then
    raise exception 'Нельзя создать сделку с самим собой' using errcode = 'P0001';
  end if;
  -- NFR-008: примитивный rate limit против спама инлайн-карточками.
  if (select count(*) from app.deals
       where initiator_profile_id = p_profile_id
         and created_at > now() - interval '1 minute') >= 10 then
    raise exception 'Слишком много записей за минуту, попробуйте позже' using errcode = 'P0001';
  end if;

  insert into app.deals (
    initiator_profile_id, partner_profile_id, debtor_side, amount_minor,
    due_date, description, payment_method, status, created_by_user_id, sent_at
  ) values (
    p_profile_id, p_partner_profile_id, p_debtor_side, p_amount_minor,
    p_due_date, p_description, p_payment_method,
    case when p_as_draft then 'draft'::app.deal_status else 'pending'::app.deal_status end,
    app.current_user_id(),
    case when p_as_draft then null else now() end
  )
  returning id into new_id;

  perform app.log(new_id, p_profile_id, 'deal.created',
    jsonb_build_object('amount_minor', p_amount_minor, 'due_date', p_due_date,
                       'debtor_side', p_debtor_side, 'draft', p_as_draft));

  if p_partner_profile_id is null then
    -- FR-092: ссылка живёт 7 дней.
    token := app.new_invite_token();
    insert into app.invites (token, deal_id, inviter_profile_id, expires_at)
    values (token, new_id, p_profile_id, now() + interval '7 days');
  elsif not p_as_draft then
    perform app.enqueue(app.profile_owner(p_partner_profile_id), 'deal.pending',
      jsonb_build_object('deal_id', new_id), 'deal.pending:' || new_id);
  end if;

  return jsonb_build_object('deal_id', new_id, 'invite_token', token);
end;
$$;

-- FR-026: черновик отправляется контрагенту.
create or replace function app.rpc_send_deal(p_deal_id uuid) returns void
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  d app.deals;
begin
  d := app.load_deal(p_deal_id);
  if d.status <> 'draft' then
    raise exception 'Отправить можно только черновик' using errcode = 'P0001';
  end if;
  if app.my_side(d) <> 'initiator' then
    raise exception 'Отправить может только создатель' using errcode = '42501';
  end if;

  update app.deals set status = 'pending', sent_at = now() where id = d.id;
  perform app.log(d.id, d.initiator_profile_id, 'deal.sent');

  if d.partner_profile_id is not null then
    perform app.enqueue(app.profile_owner(d.partner_profile_id), 'deal.pending',
      jsonb_build_object('deal_id', d.id), 'deal.pending:' || d.id);
  end if;
end;
$$;

-- FR-020, ТЗ-2 III.1. Если контрагент был неизвестен, им становится тот, кто принял.
create or replace function app.rpc_accept_deal(
  p_deal_id uuid, p_profile_id uuid, p_invite_token text default null
) returns void
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  d          app.deals;
  parent     app.deals;
  invite_row app.invites;
begin
  perform app.assert_my_profile(p_profile_id);

  select * into d from app.deals where id = p_deal_id for update;
  if d.id is null then
    raise exception 'Сделка не найдена' using errcode = 'P0002';
  end if;
  if d.status <> 'pending' then
    raise exception 'Сделка уже не ожидает подтверждения' using errcode = 'P0001';
  end if;
  if d.initiator_profile_id = p_profile_id then
    raise exception 'Нельзя подтвердить собственную запись' using errcode = 'P0001';
  end if;
  if d.partner_profile_id is not null and d.partner_profile_id <> p_profile_id then
    raise exception 'Запись адресована другому контрагенту' using errcode = '42501';
  end if;

  -- Открытая карточка: контрагент неизвестен, поэтому право принять подтверждается
  -- токеном из инлайн-карточки или deep-link. Без него сделку не перехватить.
  if d.partner_profile_id is null then
    select * into invite_row from app.invites
     where deal_id = d.id and token = p_invite_token and used_at is null
       and expires_at > now()
     for update;
    if invite_row.id is null then
      raise exception 'Нужна действующая ссылка-приглашение на эту запись'
        using errcode = '42501';
    end if;
    update app.invites
       set used_at = now(), used_by_user_id = app.current_user_id()
     where id = invite_row.id;
  end if;

  update app.deals
     set partner_profile_id = p_profile_id,
         status = 'accepted',
         accepted_at = now()
   where id = d.id;

  perform app.log(d.id, p_profile_id, 'deal.accepted');
  perform app.enqueue(app.profile_owner(d.initiator_profile_id), 'deal.accepted',
    jsonb_build_object('deal_id', d.id), 'deal.accepted:' || d.id);

  -- Р-4: акцепт дочерней сделки на остаток закрывает родительскую на внесённую сумму.
  if d.parent_deal_id is not null then
    select * into parent from app.deals where id = d.parent_deal_id for update;
    if parent.id is not null and parent.status not in ('completed', 'cancelled') then
      update app.deals
         set amount_minor = parent.paid_minor,
             status = 'completed',
             completed_at = now()
       where id = parent.id;
      perform app.log(parent.id, p_profile_id, 'deal.split_closed',
        jsonb_build_object('child_deal_id', d.id, 'closed_amount_minor', parent.paid_minor));
    end if;
  end if;
end;
$$;

-- FR-023: отклонение на этапе согласования, либо отзыв своей же записи инициатором.
create or replace function app.rpc_decline_deal(p_deal_id uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  d app.deals;
  me uuid;
begin
  d := app.load_deal(p_deal_id);
  me := app.my_profile_in_deal(d);

  if d.status not in ('draft', 'pending') then
    raise exception 'После подтверждения сделка аннулируется только по согласию сторон'
      using errcode = 'P0001';
  end if;

  update app.deals set status = 'cancelled', cancelled_at = now() where id = d.id;
  perform app.log(d.id, me, 'deal.declined', jsonb_build_object('reason', p_reason));
  perform app.notify_counterparty(d, me, 'deal.declined', jsonb_build_object('reason', p_reason));
end;
$$;

-- ---------------------------------------------------------------------------
-- Переговоры (ТЗ-2 III.2)
-- ---------------------------------------------------------------------------

-- Односторонняя правка подтверждённой сделки запрещена: сюда попадает только
-- предложение, которое вторая сторона должна принять.
create or replace function app.rpc_propose_changes(
  p_deal_id    uuid,
  p_amount_minor bigint default null,
  p_due_date   date default null,
  p_comment    text default null
) returns void
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  d      app.deals;
  me     uuid;
  patch  jsonb;
begin
  d := app.load_deal(p_deal_id);
  me := app.my_profile_in_deal(d);

  if d.status not in ('accepted', 'negotiation') then
    raise exception 'Предлагать изменения можно только по действующей сделке' using errcode = 'P0001';
  end if;
  if d.status = 'negotiation' and d.proposed_by_profile_id = me then
    raise exception 'Ваше предложение уже на рассмотрении' using errcode = 'P0001';
  end if;
  if p_amount_minor is null and p_due_date is null then
    raise exception 'Нечего предлагать: не указаны ни сумма, ни дата' using errcode = 'P0001';
  end if;
  if p_amount_minor is not null and p_amount_minor < d.paid_minor then
    raise exception 'Новая сумма меньше уже оплаченной' using errcode = 'P0001';
  end if;

  patch := jsonb_strip_nulls(jsonb_build_object(
    'amount_minor', p_amount_minor,
    'due_date',     p_due_date,
    'comment',      p_comment
  ));

  update app.deals
     set status = 'negotiation',
         proposed_changes = patch,
         proposed_by_profile_id = me,
         proposed_at = now(),
         negotiation_round = d.negotiation_round + 1
   where id = d.id;

  perform app.log(d.id, me, 'deal.proposed', patch);
  perform app.notify_counterparty(d, me, 'deal.proposed',
    jsonb_build_object('was', jsonb_build_object('amount_minor', d.amount_minor, 'due_date', d.due_date),
                       'now', patch));
end;
$$;

-- Ответ на предложение. Отклонение возвращает сделку к прежним условиям —
-- встречное предложение делается повторным вызовом rpc_propose_changes.
create or replace function app.rpc_respond_proposal(p_deal_id uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  d  app.deals;
  me uuid;
begin
  d := app.load_deal(p_deal_id);
  me := app.my_profile_in_deal(d);

  if d.status not in ('negotiation', 'frozen') then
    raise exception 'По этой сделке нет предложения на рассмотрении' using errcode = 'P0001';
  end if;
  if d.proposed_by_profile_id = me then
    raise exception 'Нельзя отвечать на собственное предложение' using errcode = 'P0001';
  end if;

  if p_accept then
    -- Р-9: предложение аннулировать действует только с согласия второй стороны.
    if coalesce((d.proposed_changes ->> 'cancel')::boolean, false) then
      update app.deals
         set status = 'cancelled', cancelled_at = now(),
             proposed_changes = null, proposed_by_profile_id = null, proposed_at = null
       where id = d.id;
      perform app.log(d.id, me, 'deal.cancelled_by_agreement');
      perform app.notify_counterparty(d, me, 'deal.cancelled');
      return;
    end if;

    update app.deals
       set amount_minor = coalesce((d.proposed_changes ->> 'amount_minor')::bigint, amount_minor),
           due_date     = coalesce((d.proposed_changes ->> 'due_date')::date, due_date),
           status       = 'accepted',
           frozen_at    = null,
           proposed_changes = null, proposed_by_profile_id = null, proposed_at = null
     where id = d.id;

    perform app.log(d.id, me, 'deal.proposal_accepted', d.proposed_changes);
    perform app.notify_counterparty(d, me, 'deal.proposal_accepted');
  else
    if d.status = 'frozen' then
      raise exception 'Замороженную сделку можно только принять или предложить аннулировать'
        using errcode = 'P0001';
    end if;
    update app.deals
       set status = 'accepted',
           proposed_changes = null, proposed_by_profile_id = null, proposed_at = null
     where id = d.id;
    perform app.log(d.id, me, 'deal.proposal_rejected', d.proposed_changes);
    perform app.notify_counterparty(d, me, 'deal.proposal_rejected');
  end if;
end;
$$;

-- Р-9: аннулирование подтверждённой сделки — предложение, а не действие.
create or replace function app.rpc_propose_cancel(p_deal_id uuid, p_reason text default null) returns void
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  d  app.deals;
  me uuid;
begin
  d := app.load_deal(p_deal_id);
  me := app.my_profile_in_deal(d);

  if d.status not in ('accepted', 'negotiation', 'frozen') then
    raise exception 'Сделку в этом статусе аннулировать нельзя' using errcode = 'P0001';
  end if;

  update app.deals
     set status = case when d.status = 'frozen' then 'frozen'::app.deal_status else 'negotiation'::app.deal_status end,
         proposed_changes = jsonb_build_object('cancel', true, 'comment', p_reason),
         proposed_by_profile_id = me,
         proposed_at = now(),
         negotiation_round = d.negotiation_round + 1
   where id = d.id;

  perform app.log(d.id, me, 'deal.cancel_proposed', jsonb_build_object('reason', p_reason));
  perform app.notify_counterparty(d, me, 'deal.cancel_proposed',
    jsonb_build_object('reason', p_reason));
end;
$$;

-- ---------------------------------------------------------------------------
-- Оплата (FR-030, FR-033, FR-037, Р-4, Р-7)
-- ---------------------------------------------------------------------------

create or replace function app.rpc_claim_payment(
  p_deal_id      uuid,
  p_amount_minor bigint,
  p_paid_on      date default null,
  p_method       text default null,
  p_note         text default null
) returns uuid
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  d           app.deals;
  me          uuid;
  remaining   bigint;
  confirm_days smallint;
  is_creditor boolean;
  payment_id  uuid;
begin
  d := app.load_deal(p_deal_id);
  me := app.my_profile_in_deal(d);

  if d.status not in ('accepted', 'negotiation', 'frozen') then
    raise exception 'По этой сделке нельзя отметить оплату' using errcode = 'P0001';
  end if;

  remaining := d.amount_minor - d.paid_minor
             - coalesce((select sum(amount_minor) from app.payments
                          where deal_id = d.id and status = 'claimed'), 0);
  if p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'Сумма платежа должна быть больше нуля' using errcode = 'P0001';
  end if;
  if p_amount_minor > remaining then
    raise exception 'Сумма платежа превышает остаток по сделке' using errcode = 'P0001';
  end if;

  is_creditor := (me = d.creditor_profile_id);

  select coalesce(s.payment_auto_confirm_days, 7) into confirm_days
    from app.notification_settings s
   where s.user_id = app.profile_owner(d.creditor_profile_id);
  confirm_days := coalesce(confirm_days, 7);

  insert into app.payments (
    deal_id, amount_minor, paid_on, method, note,
    claimed_by_profile_id, auto_confirm_after,
    -- Кредитор, подтверждающий получение денег, действует против своего интереса,
    -- поэтому его отметка засчитывается сразу (FR-030 не нарушается).
    status, resolved_by_profile_id, resolved_at
  ) values (
    d.id, p_amount_minor, coalesce(p_paid_on, app.today_msk()), p_method, p_note,
    me, now() + make_interval(days => confirm_days),
    case when is_creditor then 'confirmed'::app.payment_status else 'claimed'::app.payment_status end,
    case when is_creditor then me end,
    case when is_creditor then now() end
  )
  returning id into payment_id;

  perform app.log(d.id, me, case when is_creditor then 'payment.confirmed' else 'payment.claimed' end,
    jsonb_build_object('payment_id', payment_id, 'amount_minor', p_amount_minor));
  perform app.notify_counterparty(d, me,
    case when is_creditor then 'payment.confirmed' else 'payment.claimed' end,
    jsonb_build_object('payment_id', payment_id, 'amount_minor', p_amount_minor));

  perform app.close_if_fully_paid(d.id);
  return payment_id;
end;
$$;

create or replace function app.rpc_resolve_payment(
  p_payment_id uuid, p_confirm boolean, p_reason text default null
) returns void
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  p  app.payments;
  d  app.deals;
  me uuid;
begin
  select * into p from app.payments where id = p_payment_id for update;
  if p.id is null then
    raise exception 'Платёж не найден' using errcode = 'P0002';
  end if;

  d := app.load_deal(p.deal_id);
  me := app.my_profile_in_deal(d);

  if p.status <> 'claimed' then
    raise exception 'Платёж уже обработан' using errcode = 'P0001';
  end if;
  -- FR-033: подтверждает именно вторая сторона.
  if p.claimed_by_profile_id = me then
    raise exception 'Подтвердить платёж должна вторая сторона' using errcode = '42501';
  end if;

  update app.payments
     set status = case when p_confirm then 'confirmed'::app.payment_status else 'rejected'::app.payment_status end,
         resolved_by_profile_id = me,
         resolved_at = now(),
         reject_reason = case when p_confirm then null else p_reason end
   where id = p.id;

  perform app.log(d.id, me,
    case when p_confirm then 'payment.confirmed' else 'payment.rejected' end,
    jsonb_build_object('payment_id', p.id, 'amount_minor', p.amount_minor, 'reason', p_reason));
  perform app.notify_counterparty(d, me,
    case when p_confirm then 'payment.confirmed' else 'payment.rejected' end,
    jsonb_build_object('payment_id', p.id, 'amount_minor', p.amount_minor, 'reason', p_reason));

  if p_confirm then
    perform app.close_if_fully_paid(d.id);
  end if;
end;
$$;

create or replace function app.close_if_fully_paid(p_deal_id uuid) returns void
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  d app.deals;
begin
  select * into d from app.deals where id = p_deal_id;
  if d.id is null or d.status = 'completed' then
    return;
  end if;
  if d.paid_minor >= d.amount_minor then
    update app.deals set status = 'completed', completed_at = now() where id = d.id;
    perform app.log(d.id, null, 'deal.completed',
      jsonb_build_object('amount_minor', d.amount_minor));
    perform app.enqueue(app.profile_owner(d.initiator_profile_id), 'deal.completed',
      jsonb_build_object('deal_id', d.id), 'deal.completed:i:' || d.id);
    perform app.enqueue(app.profile_owner(d.partner_profile_id), 'deal.completed',
      jsonb_build_object('deal_id', d.id), 'deal.completed:p:' || d.id);
  end if;
end;
$$;

-- Р-4: перенос срока по остатку порождает дочернюю сделку. Родительская закроется
-- на внесённую сумму, когда контрагент примет дочернюю (см. rpc_accept_deal).
create or replace function app.rpc_propose_split(p_deal_id uuid, p_new_due_date date) returns uuid
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  d         app.deals;
  me        uuid;
  remaining bigint;
  child_id  uuid;
begin
  d := app.load_deal(p_deal_id);
  me := app.my_profile_in_deal(d);

  if d.status not in ('accepted', 'negotiation') then
    raise exception 'Разделить можно только действующую сделку' using errcode = 'P0001';
  end if;
  if d.paid_minor <= 0 then
    raise exception 'Разделение имеет смысл только после частичной оплаты' using errcode = 'P0001';
  end if;
  if exists (select 1 from app.deals where parent_deal_id = d.id and status <> 'cancelled') then
    raise exception 'По этой сделке уже есть запись на остаток' using errcode = 'P0001';
  end if;

  remaining := d.amount_minor - d.paid_minor;
  if remaining <= 0 then
    raise exception 'Остаток отсутствует' using errcode = 'P0001';
  end if;

  insert into app.deals (
    parent_deal_id, initiator_profile_id, partner_profile_id, debtor_side,
    amount_minor, due_date, description, currency, status, created_by_user_id, sent_at
  ) values (
    d.id, d.initiator_profile_id, d.partner_profile_id, d.debtor_side,
    remaining, p_new_due_date,
    'Остаток по сделке от ' || to_char(d.created_at at time zone 'Europe/Moscow', 'DD.MM.YYYY'),
    d.currency, 'pending', app.current_user_id(), now()
  )
  returning id into child_id;

  perform app.log(d.id, me, 'deal.split_proposed',
    jsonb_build_object('child_deal_id', child_id, 'remaining_minor', remaining,
                       'new_due_date', p_new_due_date));
  perform app.notify_counterparty(d, me, 'deal.split_proposed',
    jsonb_build_object('child_deal_id', child_id, 'remaining_minor', remaining,
                       'new_due_date', p_new_due_date));

  return child_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Права на вызов
-- ---------------------------------------------------------------------------

revoke all on function
  app.assert_my_profile(uuid), app.profile_owner(uuid),
  app.log(uuid, uuid, text, jsonb), app.enqueue(uuid, text, jsonb, text),
  app.notify_counterparty(app.deals, uuid, text, jsonb),
  app.my_side(app.deals), app.load_deal(uuid), app.my_profile_in_deal(app.deals),
  app.close_if_fully_paid(uuid)
from public;

grant execute on function
  app.new_invite_token(),
  app.rpc_create_deal(uuid, bigint, date, app.deal_side, text, uuid, text, boolean),
  app.rpc_send_deal(uuid),
  app.rpc_accept_deal(uuid, uuid, text),
  app.rpc_decline_deal(uuid, text),
  app.rpc_propose_changes(uuid, bigint, date, text),
  app.rpc_respond_proposal(uuid, boolean),
  app.rpc_propose_cancel(uuid, text),
  app.rpc_claim_payment(uuid, bigint, date, text, text),
  app.rpc_resolve_payment(uuid, boolean, text),
  app.rpc_propose_split(uuid, date)
to authenticated;
