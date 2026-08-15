import { useEffect, useMemo, useState } from "react";
import { calendarMonth, listDeals, type CalendarMonth, type Deal } from "../api/deals";
import type { Profile } from "../api/client";
import { formatMoney, formatDate, monthTitle, addMonths, todayMsk, WEEKDAY_SHORT } from "../lib/format";
import { Loader } from "../components/Loader";
import { StatusBadge } from "../components/StatusBadge";

export function CalendarScreen({
  profile, onOpen,
}: {
  profile: Profile;
  onOpen: (dealId: string) => void;
}) {
  const today = todayMsk();
  const [month, setMonth] = useState(`${today.slice(0, 7)}-01`);
  const [data, setData] = useState<CalendarMonth | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [dayDeals, setDayDeals] = useState<Deal[] | null>(null);

  // Тянем агрегаты, а не сами сделки: на активном профиле их сотни в месяц.
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setSelected(null);
    calendarMonth(profile.id, month)
      .then((result) => !cancelled && setData(result))
      .catch(() => !cancelled && setData({ days: [], total_i_owe_minor: 0, total_owed_to_me_minor: 0 }));
    return () => { cancelled = true; };
  }, [profile.id, month]);

  // Список за конкретный день подгружается по тапу — это FR-050 «Подробнее».
  useEffect(() => {
    if (!selected) { setDayDeals(null); return; }
    let cancelled = false;
    listDeals(profile.id, "all")
      .then((rows) => !cancelled && setDayDeals(rows.filter((d) => d.due_date === selected)))
      .catch(() => !cancelled && setDayDeals([]));
    return () => { cancelled = true; };
  }, [selected, profile.id]);

  const byDate = useMemo(
    () => Object.fromEntries((data?.days ?? []).map((d) => [d.date, d])),
    [data],
  );

  const cells = useMemo(() => {
    const [y, m] = month.split("-").map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1));
    // Неделя начинается с понедельника, как принято в России.
    const offset = (first.getUTCDay() + 6) % 7;
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();

    const result: Array<string | null> = Array(offset).fill(null);
    for (let day = 1; day <= daysInMonth; day++) {
      result.push(`${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
    }
    return result;
  }, [month]);

  return (
    <div className="screen">
      <header className="header calendar-header">
        <button className="link" onClick={() => setMonth(addMonths(month, -1))}>‹</button>
        <h1>{monthTitle(month)}</h1>
        <button className="link" onClick={() => setMonth(addMonths(month, 1))}>›</button>
      </header>

      {!data ? <Loader /> : (
        <>
          <div className="calendar">
            {WEEKDAY_SHORT.map((w) => <div key={w} className="weekday">{w}</div>)}
            {cells.map((date, index) => {
              if (!date) return <div key={`empty-${index}`} />;
              const info = byDate[date];
              const isToday = date === today;
              return (
                <button
                  key={date}
                  className={[
                    "day",
                    isToday ? "today" : "",
                    selected === date ? "selected" : "",
                  ].filter(Boolean).join(" ")}
                  onClick={() => setSelected(selected === date ? null : date)}
                >
                  <span className="day-number">{Number(date.slice(-2))}</span>
                  {info && (
                    <span
                      className="day-dot"
                      style={{
                        background: info.has_overdue ? "#ff9500"
                          : info.all_paid ? "#30d158"
                          : info.i_owe_minor > 0 ? "#ff3b30" : "#34c759",
                      }}
                    />
                  )}
                </button>
              );
            })}
          </div>

          {selected && (
            <section className="card">
              <h2>{formatDate(selected, today)}</h2>
              {byDate[selected] ? (
                <>
                  {byDate[selected].owed_to_me_minor > 0 && (
                    <div className="kv">
                      <span className="kv-label">Мне должны</span>
                      <span className="kv-value positive">
                        {formatMoney(byDate[selected].owed_to_me_minor)}
                      </span>
                    </div>
                  )}
                  {byDate[selected].i_owe_minor > 0 && (
                    <div className="kv">
                      <span className="kv-label">К выплате</span>
                      <span className="kv-value negative">
                        {formatMoney(byDate[selected].i_owe_minor)}
                      </span>
                    </div>
                  )}
                  {dayDeals === null ? <Loader text="…" /> : (
                    <ul className="plain">
                      {dayDeals.map((deal) => (
                        <li key={deal.id}>
                          <button className="row compact" onClick={() => onOpen(deal.id)}>
                            <span>{deal.description || "Без описания"}</span>
                            <span className="row-right">
                              <StatusBadge status={deal.status} isOverdue={deal.is_overdue} />
                              <span className={
                                deal.debtor_profile_id === profile.id
                                  ? "amount negative" : "amount positive"
                              }>
                                {formatMoney(deal.remaining_minor)}
                              </span>
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : (
                <p className="hint">На этот день записей нет.</p>
              )}
            </section>
          )}

          <div className="totals sticky">
            <div className="total">
              <span className="total-label">Мне должны за месяц</span>
              <span className="total-value positive">
                {formatMoney(data.total_owed_to_me_minor)}
              </span>
            </div>
            <div className="total">
              <span className="total-label">На выплату</span>
              <span className="total-value negative">
                {formatMoney(data.total_i_owe_minor)}
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
