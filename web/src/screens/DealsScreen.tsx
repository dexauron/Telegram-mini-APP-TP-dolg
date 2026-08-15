import { useEffect, useMemo, useState } from "react";
import { listDeals, getProfileNames, type Deal, type DealFilter } from "../api/deals";
import type { Profile } from "../api/client";
import { formatMoney, formatDate, todayMsk, plural } from "../lib/format";
import { StatusBadge } from "../components/StatusBadge";
import { Loader, Empty } from "../components/Loader";

const FILTERS: Array<{ id: DealFilter; label: string }> = [
  { id: "all", label: "Все" },
  { id: "owed_to_me", label: "Мне должны" },
  { id: "i_owe", label: "Я должен" },
  { id: "overdue", label: "Просрочены" },
  { id: "pending", label: "На согласовании" },
  { id: "closed", label: "Закрытые" },
];

export function DealsScreen({
  profile, onOpen, onCreate,
}: {
  profile: Profile;
  onOpen: (dealId: string) => void;
  onCreate: () => void;
}) {
  const [filter, setFilter] = useState<DealFilter>("all");
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const today = todayMsk();

  useEffect(() => {
    let cancelled = false;
    setDeals(null);

    // Realtime здесь намеренно не подключается: список обновляется при открытии
    // экрана, а постоянная подписка на все свои сделки — самый дорогой ресурс
    // при росте (docs/02-masshtabirovanie.md).
    listDeals(profile.id, filter)
      .then(async (rows) => {
        if (cancelled) return;
        setDeals(rows);
        const counterparties = rows.map((d) =>
          d.initiator_profile_id === profile.id ? d.partner_profile_id : d.initiator_profile_id,
        );
        setNames(await getProfileNames(counterparties.filter(Boolean) as string[]));
      })
      .catch(() => !cancelled && setDeals([]));

    return () => { cancelled = true; };
  }, [profile.id, filter]);

  // FR-093: поиск по сумме, описанию и контрагенту.
  const visible = useMemo(() => {
    if (!deals) return null;
    const q = search.trim().toLowerCase();
    if (!q) return deals;
    return deals.filter((d) => {
      const counterparty = names[
        (d.initiator_profile_id === profile.id ? d.partner_profile_id : d.initiator_profile_id) ?? ""
      ] ?? "";
      return (
        (d.description ?? "").toLowerCase().includes(q) ||
        counterparty.toLowerCase().includes(q) ||
        String(Math.floor(d.amount_minor / 100)).includes(q)
      );
    });
  }, [deals, search, names, profile.id]);

  const totals = useMemo(() => {
    if (!deals) return { owed: 0, owe: 0 };
    return deals.reduce(
      (acc, d) => {
        if (d.status === "completed" || d.status === "cancelled") return acc;
        if (d.debtor_profile_id === profile.id) acc.owe += d.remaining_minor;
        else if (d.creditor_profile_id === profile.id) acc.owed += d.remaining_minor;
        return acc;
      },
      { owed: 0, owe: 0 },
    );
  }, [deals, profile.id]);

  return (
    <div className="screen">
      <header className="header">
        <div className="header-row">
          <h1>Записи</h1>
          <button className="header-action" onClick={onCreate}>Новая</button>
        </div>
      </header>

      <div className="search-wrap">
        <input
          className="search"
          type="search"
          placeholder="Поиск"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="summary" style={{ marginTop: 14 }}>
        <div className="summary-item">
          <span className="summary-label">Мне должны</span>
          <span className="summary-value positive">{formatMoney(totals.owed)}</span>
        </div>
        <div className="summary-item">
          <span className="summary-label">Я должен</span>
          <span className="summary-value negative">{formatMoney(totals.owe)}</span>
        </div>
      </div>

      <div className="filters">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className={filter === f.id ? "filter active" : "filter"}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {!visible ? (
        <Loader />
      ) : visible.length === 0 ? (
        <Empty text={search ? "Ничего не найдено" : "Пока нет записей"} />
      ) : (
        <section className="group">
          <div className="card">
            <ul className="list">
              {visible.map((deal) => {
                const counterpartyId =
                  deal.initiator_profile_id === profile.id
                    ? deal.partner_profile_id
                    : deal.initiator_profile_id;
                const iOwe = deal.debtor_profile_id === profile.id;

                return (
                  <li key={deal.id}>
                    <button className="cell" onClick={() => onOpen(deal.id)}>
                      <span className="cell-main">
                        <span className="cell-title strong">
                          {counterpartyId ? names[counterpartyId] ?? "Контрагент" : "Ждёт контрагента"}
                        </span>
                        <span className="cell-sub">
                          {formatDate(deal.due_date, today)}
                          {deal.description ? ` · ${deal.description}` : ""}
                        </span>
                        <span className="cell-sub" style={{ marginTop: 4 }}>
                          <StatusBadge status={deal.status} isOverdue={deal.is_overdue} />
                          {deal.is_overdue && (
                            <span className="warning" style={{ marginLeft: 8 }}>
                              {deal.days_past_due}{" "}
                              {plural(deal.days_past_due, ["день", "дня", "дней"])} просрочки
                            </span>
                          )}
                        </span>
                      </span>
                      <span className="cell-right">
                        <span className="cell-main" style={{ alignItems: "flex-end" }}>
                          <span className={iOwe ? "amount negative" : "amount positive"}>
                            {formatMoney(deal.remaining_minor)}
                          </span>
                          {deal.is_partially_paid && (
                            <span className="cell-sub">из {formatMoney(deal.amount_minor)}</span>
                          )}
                        </span>
                        <span className="chevron">›</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </section>
      )}
    </div>
  );
}
