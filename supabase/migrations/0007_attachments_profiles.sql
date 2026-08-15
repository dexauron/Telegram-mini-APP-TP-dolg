-- 0007_attachments_profiles.sql
-- Вложения (FR-071…FR-076, Р-8) и мультипрофиль в интерфейсе (FR-008…FR-012, Р-5).

-- ---------------------------------------------------------------------------
-- Вложения
-- ---------------------------------------------------------------------------

-- Файл сначала приходит боту, и только потом человек выбирает, к какой записи
-- его прикрепить. Между этими двумя шагами данные о файле живут здесь:
-- в callback-кнопку Telegram они не помещаются (лимит 64 байта).
create table app.pending_uploads (
  id                bigserial primary key,
  user_id           uuid not null references app.users(id) on delete cascade,
  kind              app.attachment_kind not null,
  tg_file_id        text not null,
  tg_file_unique_id text,
  file_name         text,
  mime_type         text,
  size_bytes        bigint,
  caption           text,
  created_at        timestamptz not null default now()
);

create index pending_uploads_user_idx on app.pending_uploads (user_id, created_at desc);
alter table app.pending_uploads enable row level security;  -- политик нет: только сервер

-- Сохраняет присланный боту файл до выбора записи.
create or replace function app.save_pending_upload(
  p_user_id           uuid,
  p_kind              app.attachment_kind,
  p_tg_file_id        text,
  p_tg_file_unique_id text default null,
  p_file_name         text default null,
  p_mime_type         text default null,
  p_size_bytes        bigint default null,
  p_caption           text default null
) returns void
language plpgsql security definer set search_path = app, pg_catalog as $$
begin
  -- Держим только последний файл: иначе «прикрепить» после нескольких отправок
  -- становится лотереей.
  delete from app.pending_uploads where user_id = p_user_id;

  insert into app.pending_uploads (
    user_id, kind, tg_file_id, tg_file_unique_id, file_name, mime_type, size_bytes, caption
  ) values (
    p_user_id, p_kind, p_tg_file_id, p_tg_file_unique_id, p_file_name, p_mime_type,
    p_size_bytes, p_caption
  );
end;
$$;

-- Прикрепляет отложенный файл к записи. Доступ проверяется тем же способом,
-- что и везде: вызывающий должен быть стороной сделки.
create or replace function app.rpc_attach_pending(p_deal_id uuid) returns jsonb
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  d       app.deals;
  me      uuid;
  pending app.pending_uploads;
  new_id  uuid;
begin
  d := app.load_deal(p_deal_id);
  me := app.my_profile_in_deal(d);

  select * into pending from app.pending_uploads
   where user_id = app.current_user_id()
   order by created_at desc limit 1;

  if pending.id is null then
    raise exception 'Сначала пришлите файл боту' using errcode = 'P0001';
  end if;

  -- FR-073: своих ограничений на размер не вводим, лимиты определяет Telegram.
  insert into app.attachments (
    deal_id, uploaded_by_profile_id, kind, tg_file_id, tg_file_unique_id,
    file_name, mime_type, size_bytes, caption
  ) values (
    d.id, me, pending.kind, pending.tg_file_id, pending.tg_file_unique_id,
    pending.file_name, pending.mime_type, pending.size_bytes, pending.caption
  )
  returning id into new_id;

  delete from app.pending_uploads where id = pending.id;

  perform app.log(d.id, me, 'attachment.added',
    jsonb_build_object('attachment_id', new_id, 'kind', pending.kind,
                       'file_name', pending.file_name));
  perform app.notify_counterparty(d, me, 'attachment.added',
    jsonb_build_object('kind', pending.kind, 'file_name', pending.file_name));

  return jsonb_build_object('attachment_id', new_id, 'kind', pending.kind,
                            'file_name', pending.file_name);
end;
$$;

-- Отдаёт file_id для пересылки файла тому, кто его запросил. RLS сюда не
-- достаёт (функция SECURITY DEFINER), поэтому право доступа проверяем сами.
create or replace function app.attachment_file(p_attachment_id uuid) returns jsonb
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  a app.attachments;
begin
  select * into a from app.attachments where id = p_attachment_id;
  if a.id is null then
    raise exception 'Вложение не найдено' using errcode = 'P0002';
  end if;
  if not app.can_see_deal(a.deal_id) then
    raise exception 'Нет доступа к вложению' using errcode = '42501';
  end if;

  return jsonb_build_object('kind', a.kind, 'tg_file_id', a.tg_file_id,
                            'file_name', a.file_name, 'caption', a.caption);
end;
$$;

-- FR-076: запись и вложение удаляются только из нашей базы; файл остаётся
-- в переписке Telegram, мы его оттуда не трогаем.
create or replace function app.rpc_delete_attachment(p_attachment_id uuid) returns void
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  a app.attachments;
begin
  select * into a from app.attachments where id = p_attachment_id;
  if a.id is null then return; end if;

  if not (a.uploaded_by_profile_id = any (app.my_profile_ids())) then
    raise exception 'Удалить вложение может только тот, кто его прикрепил'
      using errcode = '42501';
  end if;

  delete from app.attachments where id = a.id;
  perform app.log(a.deal_id, a.uploaded_by_profile_id, 'attachment.removed',
    jsonb_build_object('attachment_id', a.id));
end;
$$;

-- Список последних открытых записей — бот показывает его кнопками, когда
-- нужно выбрать, куда прикрепить присланный файл.
create or replace function app.recent_open_deals(p_limit integer default 5) returns jsonb
language sql security definer set search_path = app, pg_catalog as $$
  select coalesce(jsonb_agg(x order by x->>'due_date'), '[]'::jsonb)
    from (
      select jsonb_build_object(
               'deal_id',      d.id,
               'amount_minor', d.amount_minor,
               'due_date',     d.due_date,
               'counterparty', coalesce(cp.name, 'без контрагента')) as x
        from app.deals d
        left join app.profiles cp
          on cp.id = case when d.initiator_profile_id = any (app.my_profile_ids())
                          then d.partner_profile_id else d.initiator_profile_id end
       where (d.initiator_profile_id = any (app.my_profile_ids())
           or d.partner_profile_id  = any (app.my_profile_ids()))
         and d.status in ('pending', 'accepted', 'negotiation', 'frozen')
       order by d.updated_at desc
       limit p_limit
    ) t;
$$;

-- ---------------------------------------------------------------------------
-- Мультипрофиль (FR-006, FR-008…FR-012)
-- ---------------------------------------------------------------------------

create or replace function app.rpc_create_profile(
  p_name text, p_kind app.profile_kind default 'both'
) returns jsonb
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  new_id uuid;
  total  integer;
begin
  if app.current_user_id() is null then
    raise exception 'Нужна авторизация' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_name, ''))) = 0 then
    raise exception 'Укажите название профиля' using errcode = 'P0001';
  end if;

  select count(*) into total from app.profiles
   where owner_user_id = app.current_user_id() and archived_at is null;
  -- Разумный потолок: мультипрофиль нужен для нескольких точек или юрлиц,
  -- а не для обхода изоляции данных созданием сотни личин.
  if total >= 10 then
    raise exception 'Больше десяти профилей на аккаунт не нужно' using errcode = 'P0001';
  end if;

  insert into app.profiles (owner_user_id, kind, name, is_default)
  values (app.current_user_id(), p_kind, btrim(p_name), false)
  returning id into new_id;

  return jsonb_build_object('id', new_id, 'name', btrim(p_name), 'kind', p_kind);
end;
$$;

-- FR-009: профиль по умолчанию — тот, что подставляется в боте и при открытии.
create or replace function app.rpc_set_default_profile(p_profile_id uuid) returns void
language plpgsql security definer set search_path = app, pg_catalog as $$
begin
  perform app.assert_my_profile(p_profile_id);
  update app.profiles set is_default = false
   where owner_user_id = app.current_user_id() and is_default;
  update app.profiles set is_default = true where id = p_profile_id;
end;
$$;

create or replace function app.rpc_archive_profile(p_profile_id uuid) returns void
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  is_default boolean;
begin
  perform app.assert_my_profile(p_profile_id);

  select p.is_default into is_default from app.profiles p where p.id = p_profile_id;
  if is_default then
    raise exception 'Сначала сделайте основным другой профиль' using errcode = 'P0001';
  end if;
  if exists (select 1 from app.deals d
              where (d.initiator_profile_id = p_profile_id or d.partner_profile_id = p_profile_id)
                and d.status in ('pending', 'accepted', 'negotiation', 'frozen')) then
    raise exception 'По профилю есть незакрытые записи' using errcode = 'P0001';
  end if;

  update app.profiles set archived_at = now() where id = p_profile_id;
end;
$$;

-- FR-011: в боте профиль переключается по кругу кнопкой под карточкой —
-- идентификаторы двух сущностей в callback_data не помещаются.
create or replace function app.rpc_cycle_draft_profile(p_deal_id uuid) returns jsonb
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  d       app.deals;
  ids     uuid[];
  current integer;
  next_id uuid;
begin
  d := app.load_deal(p_deal_id);
  if d.status <> 'draft' then
    raise exception 'Профиль меняется только до отправки' using errcode = 'P0001';
  end if;

  select array_agg(p.id order by p.is_default desc, p.created_at) into ids
    from app.profiles p
   where p.owner_user_id = app.current_user_id() and p.archived_at is null;

  if array_length(ids, 1) < 2 then
    raise exception 'У вас один профиль' using errcode = 'P0001';
  end if;

  current := array_position(ids, d.initiator_profile_id);
  next_id := ids[(coalesce(current, 0) % array_length(ids, 1)) + 1];

  update app.deals set initiator_profile_id = next_id where id = d.id;
  update app.invites set inviter_profile_id = next_id where deal_id = d.id and used_at is null;

  return (select jsonb_build_object('id', p.id, 'name', p.name)
            from app.profiles p where p.id = next_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Уборка и права
-- ---------------------------------------------------------------------------

create or replace function app.job_expire_pending_uploads() returns integer
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  affected integer;
begin
  delete from app.pending_uploads where created_at < now() - interval '1 day';
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
    'uploads_expired',  app.job_expire_pending_uploads(),
    'ran_at',           now()
  );
  insert into app.audit_log (action, payload) values ('cron.daily', result);
  return result;
end;
$$;

grant execute on function
  app.rpc_attach_pending(uuid),
  app.attachment_file(uuid),
  app.rpc_delete_attachment(uuid),
  app.recent_open_deals(integer),
  app.rpc_create_profile(text, app.profile_kind),
  app.rpc_set_default_profile(uuid),
  app.rpc_archive_profile(uuid),
  app.rpc_cycle_draft_profile(uuid)
to authenticated;
