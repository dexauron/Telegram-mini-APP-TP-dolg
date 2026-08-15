-- state_machine_test.sql — сквозной тест машины состояний и изоляции данных.
--
-- Запуск: supabase/tests/run.sh — поднимает чистый Postgres, накатывает миграции
-- и прогоняет этот файл. Тест самопроверяющийся: несовпадение роняет скрипт.
--
-- Смена пользователя имитирует то, что происходит в бою: роль `authenticated`
-- плюс claim `sub` в request.jwt.claims, который проставляет Supabase из JWT.

\set ON_ERROR_STOP on
\pset pager off

-- ---------------------------------------------------------------------------
-- Подготовка: поставщик (Алиса), магазин (Борис) и посторонний (Виктор)
-- ---------------------------------------------------------------------------
reset role;

insert into app.users (telegram_id, first_name) values (1001, 'Алиса')  returning id \gset ua_
insert into app.users (telegram_id, first_name) values (1002, 'Борис')  returning id \gset ub_
insert into app.users (telegram_id, first_name) values (1003, 'Виктор') returning id \gset uc_

insert into app.profiles (owner_user_id, kind, name, is_default)
  values (:'ua_id', 'supplier', 'ИП Алиса, молоко', true) returning id \gset pa_
insert into app.profiles (owner_user_id, kind, name, is_default)
  values (:'ub_id', 'store', 'Магазин у дома', true) returning id \gset pb_
insert into app.profiles (owner_user_id, kind, name, is_default)
  values (:'uc_id', 'store', 'Конкурент', true) returning id \gset pc_

select set_config('test.profile_a', :'pa_id', false),
       set_config('test.profile_b', :'pb_id', false),
       set_config('test.profile_c', :'pc_id', false),
       set_config('test.user_a',    :'ua_id', false),
       set_config('test.user_b',    :'ub_id', false) \gset _

-- ---------------------------------------------------------------------------
-- 1. Алиса создаёт сделку: магазин должен ей 45 000 ₽ через 5 дней.
--    Контрагент не указан — им станет тот, кто нажмёт «Подтвердить» (Р-11).
-- ---------------------------------------------------------------------------
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ua_id')::text, false) \gset _

select r ->> 'deal_id' as id, r ->> 'invite_token' as token
  from app.rpc_create_deal(
    p_profile_id   => :'pa_id',
    p_amount_minor => 4500000,
    p_due_date     => (app.today_msk() + 5),
    p_debtor_side  => 'partner',
    p_description  => 'Молоко, 200 л'
  ) as r \gset deal_
select set_config('test.deal', :'deal_id', false) \gset _

do $$
declare d app.deals;
begin
  select * into d from app.deals where id = current_setting('test.deal')::uuid;
  assert d.status = 'pending', 'ожидался статус pending, получен ' || d.status;
  assert d.partner_profile_id is null, 'контрагент не должен быть известен заранее';
  assert d.debtor_profile_id is null, 'должник неизвестен, пока нет контрагента';
  raise notice 'OK 1: сделка создана в статусе pending';
end $$;

-- ---------------------------------------------------------------------------
-- 2. Изоляция данных (NFR-001): посторонний не видит сделку.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub', :'uc_id')::text, false) \gset _

do $$
begin
  assert (select count(*) from app.deals) = 0, 'посторонний не должен видеть чужие сделки';
  assert (select count(*) from app.profiles) = 1, 'посторонний видит только свой профиль';
  raise notice 'OK 2: RLS изолирует данные от посторонних';
end $$;

-- Без токена из карточки открытую сделку не перехватить, даже зная её id.
do $$
begin
  begin
    perform app.rpc_accept_deal(current_setting('test.deal')::uuid,
                                current_setting('test.profile_c')::uuid);
    raise exception 'ожидалась ошибка доступа, но вызов прошёл';
  exception when sqlstate '42501' then
    raise notice 'OK 2.1: перехват открытой карточки без приглашения отклонён';
  end;
end $$;

-- И с выдуманным токеном тоже.
do $$
begin
  begin
    perform app.rpc_accept_deal(current_setting('test.deal')::uuid,
                                current_setting('test.profile_c')::uuid, 'poddelnyj-token');
    raise exception 'ожидалась ошибка доступа, но вызов прошёл';
  exception when sqlstate '42501' then
    raise notice 'OK 2.2: поддельный токен отклонён';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Борис подтверждает — он и становится контрагентом-должником.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub', :'ub_id')::text, false) \gset _
select app.rpc_accept_deal(:'deal_id', :'pb_id', :'deal_token');

do $$
declare d app.deals;
begin
  select * into d from app.deals where id = current_setting('test.deal')::uuid;
  assert d.status = 'accepted', 'ожидался accepted, получен ' || d.status;
  assert d.partner_profile_id  = current_setting('test.profile_b')::uuid, 'контрагент не проставлен';
  assert d.debtor_profile_id   = current_setting('test.profile_b')::uuid, 'должник вычислен неверно';
  assert d.creditor_profile_id = current_setting('test.profile_a')::uuid, 'кредитор вычислен неверно';
  raise notice 'OK 3: акцепт связал контрагента и вычислил стороны долга';
end $$;

do $$
begin
  begin
    perform app.rpc_accept_deal(current_setting('test.deal')::uuid,
                                current_setting('test.profile_b')::uuid);
    raise exception 'ожидалась ошибка повторного акцепта';
  exception when sqlstate 'P0001' then
    raise notice 'OK 3.1: повторный акцепт отклонён';
  end;
end $$;

-- Р-9: после акцепта односторонняя отмена запрещена.
do $$
begin
  begin
    perform app.rpc_decline_deal(current_setting('test.deal')::uuid, 'передумал');
    raise exception 'ожидался запрет односторонней отмены';
  exception when sqlstate 'P0001' then
    raise notice 'OK 3.2: односторонняя отмена подтверждённой сделки заблокирована';
  end;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Частичная оплата: Борис вносит 20 000 ₽, Алиса подтверждает.
-- ---------------------------------------------------------------------------
select app.rpc_claim_payment(:'deal_id', 2000000, null, 'СБП', 'первый транш') as id \gset pay_
select set_config('test.payment', :'pay_id', false) \gset _

do $$
declare d record; p app.payments;
begin
  select * into p from app.payments where id = current_setting('test.payment')::uuid;
  assert p.status = 'claimed', 'платёж должника ждёт подтверждения кредитора';
  select * into d from app.deals_view where id = current_setting('test.deal')::uuid;
  assert d.paid_minor = 0, 'незаподтверждённый платёж не должен уменьшать долг';
  assert d.has_claimed_payment, 'признак заявленного платежа не выставлен';
  raise notice 'OK 4: платёж зафиксирован как заявленный (FR-033)';
end $$;

do $$
begin
  begin
    perform app.rpc_resolve_payment(current_setting('test.payment')::uuid, true);
    raise exception 'ожидался запрет самоподтверждения';
  exception when sqlstate '42501' then
    raise notice 'OK 4.1: самоподтверждение платежа заблокировано';
  end;
end $$;

select set_config('request.jwt.claims', json_build_object('sub', :'ua_id')::text, false) \gset _
select app.rpc_resolve_payment(:'pay_id', true);

do $$
declare d app.deals;
begin
  select * into d from app.deals where id = current_setting('test.deal')::uuid;
  assert d.paid_minor = 2000000, 'paid_minor не пересчитан, получено ' || d.paid_minor;
  assert d.status = 'accepted', 'частичная оплата не должна закрывать сделку';
  raise notice 'OK 4.2: подтверждение кредитора уменьшило долг';
end $$;

-- ---------------------------------------------------------------------------
-- 5. Переговоры (ТЗ-2 III.2): Алиса предлагает перенести срок.
-- ---------------------------------------------------------------------------
select app.rpc_propose_changes(:'deal_id', null, (current_date + 20), 'подождём до отгрузки');

do $$
declare d app.deals;
begin
  select * into d from app.deals where id = current_setting('test.deal')::uuid;
  assert d.status = 'negotiation', 'ожидался negotiation, получен ' || d.status;
  assert d.negotiation_round = 1, 'счётчик раундов не увеличен';
  raise notice 'OK 5: предложение зафиксировано, статус negotiation';
end $$;

do $$
begin
  begin
    perform app.rpc_respond_proposal(current_setting('test.deal')::uuid, true);
    raise exception 'ожидался запрет ответа самому себе';
  exception when sqlstate 'P0001' then
    raise notice 'OK 5.1: ответ на собственное предложение заблокирован';
  end;
end $$;

select set_config('request.jwt.claims', json_build_object('sub', :'ub_id')::text, false) \gset _
select app.rpc_respond_proposal(:'deal_id', true);

do $$
declare d app.deals;
begin
  select * into d from app.deals where id = current_setting('test.deal')::uuid;
  assert d.status = 'accepted', 'после принятия предложения ожидался accepted';
  assert d.due_date = current_date + 20, 'новая дата не применена';
  assert d.proposed_changes is null, 'предложение не очищено';
  raise notice 'OK 5.2: условия изменены только по согласию обеих сторон';
end $$;

-- ---------------------------------------------------------------------------
-- 6. Сплит остатка (Р-4): дочерняя сделка на 25 000 ₽ с новым сроком.
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub', :'ua_id')::text, false) \gset _
select app.rpc_propose_split(:'deal_id', (current_date + 45)) as id \gset child_
select set_config('test.child', :'child_id', false) \gset _

do $$
declare c app.deals; p app.deals;
begin
  select * into c from app.deals where id = current_setting('test.child')::uuid;
  assert c.status = 'pending', 'дочерняя сделка должна ждать акцепта';
  assert c.amount_minor = 2500000, 'остаток посчитан неверно: ' || c.amount_minor;
  select * into p from app.deals where id = current_setting('test.deal')::uuid;
  assert p.status = 'accepted', 'родительская закрывается только после акцепта дочерней';
  raise notice 'OK 6: дочерняя сделка на остаток создана';
end $$;

select set_config('request.jwt.claims', json_build_object('sub', :'ub_id')::text, false) \gset _
select app.rpc_accept_deal(:'child_id', :'pb_id');

do $$
declare c app.deals; p app.deals;
begin
  select * into p from app.deals where id = current_setting('test.deal')::uuid;
  assert p.status = 'completed', 'родительская сделка должна закрыться, статус ' || p.status;
  assert p.amount_minor = 2000000, 'родительская закрыта не на внесённую сумму: ' || p.amount_minor;
  select * into c from app.deals where id = current_setting('test.child')::uuid;
  assert c.status = 'accepted', 'дочерняя сделка должна быть принята';
  raise notice 'OK 6.1: сплит закрыл историческую сделку и открыл остаток';
end $$;

-- ---------------------------------------------------------------------------
-- 7. Отметка кредитора о получении денег засчитывается сразу (Р-7).
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub', :'ua_id')::text, false) \gset _
select app.rpc_claim_payment(:'child_id', 2500000, null, 'наличные', 'закрыли остаток');

do $$
declare c app.deals;
begin
  select * into c from app.deals where id = current_setting('test.child')::uuid;
  assert c.status = 'completed', 'сделка должна закрыться при полной оплате, статус ' || c.status;
  assert c.paid_minor = c.amount_minor, 'остаток не погашен полностью';
  raise notice 'OK 7: отметка кредитора закрыла сделку без второго подтверждения';
end $$;

-- ---------------------------------------------------------------------------
-- 8. Заморозка зависшего спора (ТЗ-2 III.4) и запрет одностороннего аннулирования.
-- ---------------------------------------------------------------------------
select r ->> 'deal_id' as id
  from app.rpc_create_deal(
    p_profile_id         => :'pa_id',
    p_amount_minor       => 1000000,
    p_due_date           => (app.today_msk() - 3),   -- срок уже прошёл
    p_debtor_side        => 'partner',
    p_partner_profile_id => :'pb_id'
  ) as r \gset old_
select set_config('test.old', :'old_id', false) \gset _

select set_config('request.jwt.claims', json_build_object('sub', :'ub_id')::text, false) \gset _
select app.rpc_accept_deal(:'old_id', :'pb_id');
select app.rpc_propose_changes(:'old_id', 500000, null, 'верните половину');

reset role;
select app.job_freeze_stale_negotiations() as frozen \gset job_

do $$
declare d app.deals;
begin
  select * into d from app.deals where id = current_setting('test.old')::uuid;
  assert d.status = 'frozen', 'просроченный спор должен быть заморожен, статус ' || d.status;
  raise notice 'OK 8: зависший спор с прошедшим сроком заморожен';
end $$;

set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub', :'ub_id')::text, false) \gset _

do $$
begin
  begin
    perform app.rpc_decline_deal(current_setting('test.old')::uuid);
    raise exception 'ожидался запрет одностороннего аннулирования замороженной сделки';
  exception when sqlstate 'P0001' then
    raise notice 'OK 8.1: должник не может обнулить долг в одностороннем порядке (Р-9)';
  end;
end $$;

select app.rpc_propose_cancel(:'old_id', 'договорились разойтись');
select set_config('request.jwt.claims', json_build_object('sub', :'ua_id')::text, false) \gset _
select app.rpc_respond_proposal(:'old_id', true);

do $$
declare d app.deals;
begin
  select * into d from app.deals where id = current_setting('test.old')::uuid;
  assert d.status = 'cancelled', 'сделка должна быть аннулирована по согласию, статус ' || d.status;
  raise notice 'OK 8.2: аннулирование прошло только по согласию обеих сторон';
end $$;

-- ---------------------------------------------------------------------------
-- 9. Двусторонняя статистика (Р-2) и журнал действий (NFR-003).
-- ---------------------------------------------------------------------------
do $$
declare s record; log_count integer;
begin
  select * into s from app.bilateral_stats
   where profile_id = current_setting('test.profile_a')::uuid
     and counterparty_profile_id = current_setting('test.profile_b')::uuid;
  assert s.deals_total = 3, 'ожидалось 3 сделки в паре, получено ' || s.deals_total;
  assert s.deals_completed = 2, 'ожидалось 2 закрытые сделки, получено ' || s.deals_completed;
  assert s.deals_cancelled = 1, 'ожидалась 1 аннулированная, получено ' || s.deals_cancelled;

  select count(*) into log_count from app.audit_log
   where deal_id = current_setting('test.deal')::uuid;
  assert log_count >= 5, 'журнал действий пуст или неполон: ' || log_count;
  raise notice 'OK 9: двусторонняя статистика и audit log заполнены';
end $$;

select set_config('request.jwt.claims', json_build_object('sub', :'uc_id')::text, false) \gset _
do $$
begin
  assert (select count(*) from app.bilateral_stats) = 0,
    'посторонний не должен видеть статистику чужой пары';
  raise notice 'OK 9.1: статистика приватна для пары (Р-2)';
end $$;

-- ---------------------------------------------------------------------------
-- 10. Плановые напоминания: одна сводка на пользователя в день, а не письмо
--     на каждую сделку (иначе 500 000 пользователей упрут бота в лимиты).
-- ---------------------------------------------------------------------------
select set_config('request.jwt.claims', json_build_object('sub', :'ua_id')::text, false) \gset _

-- Три просроченные сделки у одной и той же пары.
select r ->> 'deal_id' as id from app.rpc_create_deal(
  p_profile_id => :'pa_id', p_amount_minor => 100000,
  p_due_date => (app.today_msk() - 1), p_debtor_side => 'partner',
  p_partner_profile_id => :'pb_id') as r \gset d1_
select r ->> 'deal_id' as id from app.rpc_create_deal(
  p_profile_id => :'pa_id', p_amount_minor => 200000,
  p_due_date => (app.today_msk() - 2), p_debtor_side => 'partner',
  p_partner_profile_id => :'pb_id') as r \gset d2_
select r ->> 'deal_id' as id from app.rpc_create_deal(
  p_profile_id => :'pa_id', p_amount_minor => 300000,
  p_due_date => (app.today_msk() - 4), p_debtor_side => 'partner',
  p_partner_profile_id => :'pb_id') as r \gset d3_

select set_config('request.jwt.claims', json_build_object('sub', :'ub_id')::text, false) \gset _
select app.rpc_accept_deal(:'d1_id', :'pb_id');
select app.rpc_accept_deal(:'d2_id', :'pb_id');
select app.rpc_accept_deal(:'d3_id', :'pb_id');

reset role;
select app.job_build_digests() as n \gset digest_

do $$
declare
  digests   integer;
  a_payload jsonb;
begin
  select count(*) into digests from app.outbox where kind = 'digest.daily';
  assert digests = 2, 'ожидались две сводки (обоим участникам), получено ' || digests;

  select payload into a_payload from app.outbox
   where kind = 'digest.daily' and user_id = current_setting('test.user_a')::uuid;
  assert (a_payload ->> 'overdue_count')::int = 3,
    'в сводке должно быть 3 просроченные сделки, а не ' || (a_payload ->> 'overdue_count');
  assert (a_payload ->> 'overdue_minor')::bigint = 600000,
    'сумма просрочки в сводке неверна: ' || (a_payload ->> 'overdue_minor');
  raise notice 'OK 10: три просрочки свернулись в одну сводку на пользователя';
end $$;

-- Повторный запуск в тот же день не должен создавать дубли (dedup_key).
select app.job_build_digests();
do $$
declare digests integer;
begin
  select count(*) into digests from app.outbox where kind = 'digest.daily';
  assert digests = 2, 'повторный прогон продублировал сводки: ' || digests;
  raise notice 'OK 10.1: повторный прогон CRON не дублирует рассылку';
end $$;

-- Рассылка разнесена по времени: два пользователя не получают сообщения
-- в одну и ту же секунду.
do $$
declare spread integer;
begin
  select count(distinct scheduled_at) into spread
    from app.outbox where kind = 'digest.daily';
  assert spread = 2, 'плановая рассылка не разнесена по времени';
  raise notice 'OK 10.2: очередь рассылки размазана по окну отправки';
end $$;

-- ---------------------------------------------------------------------------
-- 11. Журнал действий пишется в помесячные секции, а не в default.
-- ---------------------------------------------------------------------------
do $$
declare in_default integer; in_month integer;
begin
  select count(*) into in_default from app.audit_log_default;
  assert in_default = 0, 'записи попали в секцию по умолчанию: ' || in_default;

  execute format('select count(*) from app.%I',
                 'audit_log_' || to_char(app.today_msk(), 'YYYY_MM'))
     into in_month;
  assert in_month > 0, 'месячная секция журнала пуста';
  raise notice 'OK 11: журнал секционирован по месяцам';
end $$;

reset role;
\echo ''
\echo '=== Все проверки пройдены ==='
