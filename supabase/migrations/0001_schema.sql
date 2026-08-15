-- 0001_schema.sql — базовая схема «Мост долгов»
-- Решения: docs/01-resheniya.md. Суммы — копейки (BIGINT). Даты платежа — DATE.
-- Часовой пояс бизнес-логики — Europe/Moscow.

create extension if not exists pgcrypto;

create schema if not exists app;

-- ---------------------------------------------------------------------------
-- Перечисления
-- ---------------------------------------------------------------------------

-- Р-5 и FR-007: тип профиля. Пользователь может быть поставщиком, магазином или
-- и тем и другим — профиль по умолчанию создаётся как 'both', пока человек не
-- уточнил роль в настройках.
create type app.profile_kind as enum ('supplier', 'store', 'both');

-- Р-6: «просрочена» здесь отсутствует намеренно — это вычисляемый признак,
-- а не статус, иначе теряется факт акцепта сделки.
create type app.deal_status as enum (
  'draft',        -- создана в Mini App, ещё не отправлена (FR-026)
  'pending',      -- отправлена контрагенту, ждём акцепта (FR-027)
  'accepted',     -- обе стороны подтвердили, долг зафиксирован (FR-028)
  'negotiation',  -- есть непринятое предложение об изменении условий (ТЗ-2 III.2)
  'frozen',       -- спор завис после срока, пинг-понг заблокирован (ТЗ-2 III.4)
  'completed',    -- полностью оплачена и подтверждена (FR-030)
  'cancelled'     -- отклонена до акцепта либо аннулирована по согласию (Р-9)
);

-- Сторона сделки. Нужна отдельным типом, потому что должником может быть
-- как инициатор, так и контрагент, а контрагент на момент создания может быть
-- ещё не зарегистрирован (partner_profile_id = null).
create type app.deal_side as enum ('initiator', 'partner');

-- Р-7: жизненный цикл платежа с авто-подтверждением при молчании кредитора.
create type app.payment_status as enum ('claimed', 'confirmed', 'rejected');

create type app.attachment_kind as enum ('photo', 'video', 'document', 'voice', 'audio');

-- FR-057: частота напоминаний о просрочке.
create type app.overdue_frequency as enum ('daily', 'every_2_days', 'weekly', 'off');

-- ---------------------------------------------------------------------------
-- Пользователи и профили
-- ---------------------------------------------------------------------------

-- Р-3: телефон, ФИО и прочие ПДн не хранятся. Только то, что отдаёт Telegram.
create table app.users (
  id                uuid primary key default gen_random_uuid(),
  telegram_id       bigint      not null unique,
  username          text,
  first_name        text,
  last_name         text,
  photo_url         text,
  language_code     text,
  tos_accepted_at   timestamptz,               -- FR-003
  bot_blocked       boolean     not null default false,  -- пользователь заблокировал бота
  is_banned         boolean     not null default false,  -- shadowban за спам (ТЗ-2 IV)
  banned_reason     text,
  anonymized_at     timestamptz,               -- Р-10: удаление аккаунта = обезличивание
  created_at        timestamptz not null default now(),
  last_seen_at      timestamptz not null default now()
);

comment on table app.users is
  'Аккаунт Telegram. Персональные данные (телефон, ФИО, ИНН) не собираются — см. Р-3.';

-- Р-5: сделки привязаны к профилю, а не к аккаунту. В MVP профиль один и создаётся
-- автоматически, но схема готова к мультипрофилю без миграции данных.
create table app.profiles (
  id             uuid primary key default gen_random_uuid(),
  owner_user_id  uuid not null references app.users(id) on delete cascade,
  kind           app.profile_kind not null,
  name           text not null check (length(btrim(name)) between 1 and 120),
  is_default     boolean not null default false,
  archived_at    timestamptz,
  created_at     timestamptz not null default now()
);

create index profiles_owner_idx on app.profiles (owner_user_id) where archived_at is null;
-- Ровно один профиль по умолчанию на аккаунт.
create unique index profiles_one_default_idx on app.profiles (owner_user_id) where is_default;

-- ---------------------------------------------------------------------------
-- Сделки
-- ---------------------------------------------------------------------------

create table app.deals (
  id                    uuid primary key default gen_random_uuid(),

  -- Р-4: дочерняя сделка на остаток при переносе срока (модель сплита из ТЗ-2).
  parent_deal_id        uuid references app.deals(id) on delete restrict,

  initiator_profile_id  uuid not null references app.profiles(id) on delete restrict,
  -- null, пока контрагент не зарегистрировался по приглашению (FR-021).
  partner_profile_id    uuid references app.profiles(id) on delete restrict,

  -- Кто из двух сторон должен деньги. Хранится стороной, а не profile_id,
  -- потому что на момент создания партнёр может быть ещё неизвестен.
  debtor_side           app.deal_side not null,

  debtor_profile_id uuid generated always as (
    case when debtor_side = 'initiator' then initiator_profile_id else partner_profile_id end
  ) stored,
  creditor_profile_id uuid generated always as (
    case when debtor_side = 'initiator' then partner_profile_id else initiator_profile_id end
  ) stored,

  amount_minor          bigint not null check (amount_minor > 0),   -- Р-11: копейки
  paid_minor            bigint not null default 0 check (paid_minor >= 0), -- сумма confirmed-платежей
  currency              char(3) not null default 'RUB',

  due_date              date not null,          -- Р-11: срок без времени суток
  description           text check (length(description) <= 2000),
  payment_method        text,                   -- FR-016, необязательное

  status                app.deal_status not null default 'draft',

  -- ТЗ-2 III.2: предложение об изменении условий, ждущее ответа второй стороны.
  proposed_changes      jsonb,
  proposed_by_profile_id uuid references app.profiles(id),
  proposed_at           timestamptz,
  negotiation_round     integer not null default 0,

  created_by_user_id    uuid not null references app.users(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  sent_at               timestamptz,
  accepted_at           timestamptz,
  frozen_at             timestamptz,
  completed_at          timestamptz,
  cancelled_at          timestamptz,

  -- Целостность
  constraint deals_paid_not_over_amount check (paid_minor <= amount_minor),
  constraint deals_parties_differ check (
    partner_profile_id is null or partner_profile_id <> initiator_profile_id
  ),
  -- Сделка без партнёра может висеть только в ожидании акцепта или быть черновиком.
  constraint deals_partner_required check (
    partner_profile_id is not null or status in ('draft', 'pending', 'cancelled')
  ),
  -- Предложение об изменении существует ровно в статусе negotiation/frozen.
  constraint deals_proposal_consistent check (
    (proposed_changes is null and proposed_by_profile_id is null)
    or (proposed_changes is not null and proposed_by_profile_id is not null)
  )
);

comment on column app.deals.paid_minor is
  'Денормализованная сумма подтверждённых платежей. Поддерживается триггером app.sync_deal_paid().';

create index deals_initiator_idx on app.deals (initiator_profile_id, status, due_date);
create index deals_partner_idx   on app.deals (partner_profile_id, status, due_date);
create index deals_parent_idx    on app.deals (parent_deal_id) where parent_deal_id is not null;
-- Для ежедневного CRON: быстро найти незакрытые сделки с прошедшим сроком.
create index deals_open_due_idx  on app.deals (due_date)
  where status in ('accepted', 'negotiation');

-- ---------------------------------------------------------------------------
-- Платежи (Р-4, Р-7)
-- ---------------------------------------------------------------------------

create table app.payments (
  id                    uuid primary key default gen_random_uuid(),
  deal_id               uuid not null references app.deals(id) on delete cascade,
  amount_minor          bigint not null check (amount_minor > 0),
  paid_on               date not null,
  status                app.payment_status not null default 'claimed',
  method                text,
  note                  text check (length(note) <= 500),

  claimed_by_profile_id uuid not null references app.profiles(id),
  claimed_at            timestamptz not null default now(),
  -- Р-7: после этой даты молчание кредитора трактуется как согласие.
  auto_confirm_after    timestamptz not null,
  resolved_by_profile_id uuid references app.profiles(id),
  resolved_at           timestamptz,
  auto_confirmed        boolean not null default false,
  reject_reason         text
);

create index payments_deal_idx on app.payments (deal_id, status);
-- Для CRON авто-подтверждения.
create index payments_pending_idx on app.payments (auto_confirm_after) where status = 'claimed';

-- ---------------------------------------------------------------------------
-- Вложения (Р-8: только file_id Telegram, файлы не копируем к себе)
-- ---------------------------------------------------------------------------

create table app.attachments (
  id                     uuid primary key default gen_random_uuid(),
  deal_id                uuid not null references app.deals(id) on delete cascade,
  uploaded_by_profile_id uuid not null references app.profiles(id),
  kind                   app.attachment_kind not null,
  tg_file_id             text not null,
  tg_file_unique_id      text,
  file_name              text,
  mime_type              text,
  size_bytes             bigint,
  caption                text,
  created_at             timestamptz not null default now()
);

create index attachments_deal_idx on app.attachments (deal_id, created_at);

-- ---------------------------------------------------------------------------
-- Приглашения (FR-021, FR-086; deep link payload ограничен 64 символами)
-- ---------------------------------------------------------------------------

create table app.invites (
  id                  uuid primary key default gen_random_uuid(),
  token               text not null unique check (token ~ '^[A-Za-z0-9_-]{8,48}$'),
  deal_id             uuid references app.deals(id) on delete cascade,
  inviter_profile_id  uuid not null references app.profiles(id) on delete cascade,
  expires_at          timestamptz not null,     -- FR-092: срок жизни ссылки
  used_at             timestamptz,
  used_by_user_id     uuid references app.users(id),
  created_at          timestamptz not null default now()
);

create index invites_deal_idx on app.invites (deal_id) where used_at is null;

-- ---------------------------------------------------------------------------
-- Журнал действий (NFR-003, FR-034, NFR-036)
-- ---------------------------------------------------------------------------

create table app.audit_log (
  -- Первичный ключ включает ключ секционирования — этого требует Postgres.
  id               bigserial,
  deal_id          uuid,
  actor_user_id    uuid references app.users(id),
  actor_profile_id uuid references app.profiles(id),
  action           text not null,
  payload          jsonb,
  created_at       timestamptz not null default now(),
  primary key (id, created_at)
) partition by range (created_at);

-- Журнал — самая быстрорастущая таблица: на 500 000 пользователей это десятки
-- миллионов строк в год. Секционирование по месяцам делает архивацию и удаление
-- старых периодов мгновенными (drop партиции вместо delete по строкам).
-- Партиции создаёт app.ensure_audit_partitions(), см. 0004_cron.sql.
-- FK на deals намеренно нет: он мешал бы отцеплять старые партиции, а связь
-- гарантируется тем, что журнал пишется только из RPC-функций.
create table app.audit_log_default partition of app.audit_log default;

create index audit_deal_idx on app.audit_log (deal_id, created_at);
create index audit_created_idx on app.audit_log (created_at);

-- ---------------------------------------------------------------------------
-- Уведомления: настройки (FR-056, FR-057, FR-061) и очередь доставки
-- ---------------------------------------------------------------------------

create table app.notification_settings (
  user_id            uuid primary key references app.users(id) on delete cascade,
  remind_days_before smallint[] not null default '{1,3}',   -- FR-056: 0,1,3,7
  overdue_frequency  app.overdue_frequency not null default 'daily',  -- FR-057
  payment_auto_confirm_days smallint not null default 7      -- Р-7
    check (payment_auto_confirm_days between 1 and 30),
  muted_kinds        text[] not null default '{}',           -- FR-061
  updated_at         timestamptz not null default now()
);

-- Очередь исходящих сообщений бота: гарантирует, что уведомление не потеряется,
-- если Telegram временно недоступен, и не отправится дважды (dedup_key).
create table app.outbox (
  id             bigserial primary key,
  user_id        uuid not null references app.users(id) on delete cascade,
  kind           text not null,
  payload        jsonb not null,
  dedup_key      text unique,
  -- 1 — реакция на действие человека (её ждут прямо сейчас), 5 — плановая рассылка.
  priority       smallint not null default 5,
  scheduled_at   timestamptz not null default now(),
  sent_at        timestamptz,
  attempts       smallint not null default 0,
  last_error     text,
  created_at     timestamptz not null default now()
);

-- Telegram принимает от бота порядка 30 сообщений в секунду, поэтому рассыльщик
-- забирает очередь порциями строго в этом порядке: сначала срочное, потом плановое.
create index outbox_pending_idx on app.outbox (priority, scheduled_at)
  where sent_at is null;

-- ---------------------------------------------------------------------------
-- Служебные функции и триггеры
-- ---------------------------------------------------------------------------

-- Р-11: «сегодня» всегда по Москве, независимо от таймзоны сервера.
create or replace function app.today_msk() returns date
language sql stable as $$
  select (now() at time zone 'Europe/Moscow')::date;
$$;

create or replace function app.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger deals_touch_updated_at
  before update on app.deals
  for each row execute function app.touch_updated_at();

-- Поддерживает deals.paid_minor в согласии с подтверждёнными платежами.
create or replace function app.sync_deal_paid() returns trigger
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  target_deal uuid := coalesce(new.deal_id, old.deal_id);
begin
  update app.deals d
     set paid_minor = coalesce((
           select sum(p.amount_minor)
             from app.payments p
            where p.deal_id = target_deal
              and p.status = 'confirmed'
         ), 0)
   where d.id = target_deal;
  return null;
end;
$$;

create trigger payments_sync_deal_paid
  after insert or update or delete on app.payments
  for each row execute function app.sync_deal_paid();

-- ---------------------------------------------------------------------------
-- Представления для клиента
-- ---------------------------------------------------------------------------

-- Р-6: просрочка — вычисляемый признак. Заявленный, но ещё не подтверждённый
-- платёж останавливает счётчик просрочки (Р-7, п. 2).
create or replace view app.deals_view
with (security_invoker = on) as
select
  d.*,
  (d.amount_minor - d.paid_minor) as remaining_minor,
  (d.paid_minor > 0 and d.paid_minor < d.amount_minor) as is_partially_paid,
  exists (
    select 1 from app.payments p
     where p.deal_id = d.id and p.status = 'claimed'
  ) as has_claimed_payment,
  (
    d.status in ('accepted', 'negotiation')
    and d.due_date < app.today_msk()
    and d.amount_minor > d.paid_minor
    and not exists (
      select 1 from app.payments p
       where p.deal_id = d.id and p.status = 'claimed'
    )
  ) as is_overdue,
  (app.today_msk() - d.due_date) as days_past_due
from app.deals d;

-- Р-2: приватная двусторонняя статистика вместо публичного рейтинга.
-- Строка существует только для пар, между которыми были сделки, и видна
-- (через RLS нижележащей таблицы) только этим двум сторонам.
create or replace view app.bilateral_stats
with (security_invoker = on) as
with pairs as (
  select
    d.initiator_profile_id as profile_id,
    d.partner_profile_id   as counterparty_profile_id,
    d.*
  from app.deals d
  where d.partner_profile_id is not null
  union all
  select
    d.partner_profile_id   as profile_id,
    d.initiator_profile_id as counterparty_profile_id,
    d.*
  from app.deals d
  where d.partner_profile_id is not null
)
select
  profile_id,
  counterparty_profile_id,
  count(*) filter (where status <> 'draft')                        as deals_total,
  count(*) filter (where status = 'completed')                     as deals_completed,
  count(*) filter (where status = 'completed' and completed_at is not null
                     and (completed_at at time zone 'Europe/Moscow')::date <= due_date)
                                                                   as deals_completed_on_time,
  count(*) filter (where status = 'cancelled')                     as deals_cancelled,
  count(*) filter (where status in ('accepted','negotiation')
                     and due_date < app.today_msk()
                     and amount_minor > paid_minor)                as deals_overdue_now,
  coalesce(sum(amount_minor) filter (where status = 'completed'), 0) as volume_completed_minor,
  coalesce(sum(amount_minor - paid_minor)
             filter (where status in ('accepted','negotiation','frozen')), 0) as outstanding_minor,
  max(created_at)                                                  as last_deal_at
from pairs
group by profile_id, counterparty_profile_id;
