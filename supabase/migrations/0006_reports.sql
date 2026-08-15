-- 0006_reports.sql — отчёты и экспорт (FR-077…FR-085, FR-098…FR-102)

-- Выборка за период по одному профилю. FR-083: чужие данные в отчёт не попадают,
-- потому что функция сверяет профиль с профилями вызывающего.
create or replace function app.rpc_report(
  p_profile_id uuid,
  p_from       date,
  p_to         date
) returns jsonb
language plpgsql security definer set search_path = app, pg_catalog as $$
declare
  result jsonb;
begin
  perform app.assert_my_profile(p_profile_id);

  if p_to < p_from then
    raise exception 'Конец периода раньше начала' using errcode = 'P0001';
  end if;
  -- Отчёт формируется на лету и уходит одним сообщением: без верхней границы
  -- запрос за десять лет положил бы и функцию, и Telegram.
  if p_to - p_from > 730 then
    raise exception 'Период не больше двух лет' using errcode = 'P0001';
  end if;

  with rows as (
    select d.id,
           d.created_at,
           d.due_date,
           d.amount_minor,
           d.paid_minor,
           (d.amount_minor - d.paid_minor) as remaining_minor,
           d.status,
           d.description,
           (d.debtor_profile_id = p_profile_id) as i_owe,
           (d.status in ('accepted','negotiation','frozen')
            and d.due_date < app.today_msk()
            and d.amount_minor > d.paid_minor)  as is_overdue,
           coalesce(cp.name, 'Ждёт контрагента') as counterparty
      from app.deals d
      left join app.profiles cp
        on cp.id = case when d.initiator_profile_id = p_profile_id
                        then d.partner_profile_id else d.initiator_profile_id end
     where (d.initiator_profile_id = p_profile_id or d.partner_profile_id = p_profile_id)
       and d.status <> 'draft'
       and d.due_date between p_from and p_to
  )
  select jsonb_build_object(
    'period', jsonb_build_object('from', p_from, 'to', p_to),
    'profile', (select jsonb_build_object('id', id, 'name', name)
                  from app.profiles where id = p_profile_id),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', id, 'created_at', created_at, 'due_date', due_date,
               'counterparty', counterparty, 'amount_minor', amount_minor,
               'paid_minor', paid_minor, 'remaining_minor', remaining_minor,
               'status', status, 'description', description,
               'i_owe', i_owe, 'is_overdue', is_overdue)
             order by due_date) from rows), '[]'::jsonb),
    'totals', jsonb_build_object(
      'count',              (select count(*) from rows),
      'owed_to_me_minor',   coalesce((select sum(remaining_minor) from rows
                                       where not i_owe and status not in ('completed','cancelled')), 0),
      'i_owe_minor',        coalesce((select sum(remaining_minor) from rows
                                       where i_owe and status not in ('completed','cancelled')), 0),
      'completed_minor',    coalesce((select sum(amount_minor) from rows
                                       where status = 'completed'), 0),
      'overdue_count',      (select count(*) from rows where is_overdue),
      'overdue_minor',      coalesce((select sum(remaining_minor) from rows where is_overdue), 0))
  ) into result;

  return result;
end;
$$;

grant execute on function app.rpc_report(uuid, date, date) to authenticated;
