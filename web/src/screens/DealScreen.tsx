import { useCallback, useEffect, useState } from "react";
import {
  getDeal, getPayments, getHistory, getProfileNames,
  acceptDeal, declineDeal, claimPayment, resolvePayment,
  proposeChanges, respondProposal, proposeCancel, proposeSplit,
  type Deal, type Payment, type AuditEntry,
} from "../api/deals";
import { db } from "../api/client";
import type { Profile } from "../api/client";
import { formatMoney, formatDate, todayMsk, inputToMinor, plural } from "../lib/format";
import { StatusBadge } from "../components/StatusBadge";
import { Loader, Group } from "../components/Loader";
import { confirm, haptic } from "../lib/telegram";

const ACTION_LABEL: Record<string, string> = {
  "deal.created": "Запись создана",
  "deal.sent": "Отправлена контрагенту",
  "deal.accepted": "Подтверждена обеими сторонами",
  "deal.declined": "Отклонена",
  "deal.proposed": "Предложено изменение условий",
  "deal.proposal_accepted": "Новые условия приняты",
  "deal.proposal_rejected": "Предложение отклонено",
  "deal.cancel_proposed": "Предложено аннулировать",
  "deal.cancelled_by_agreement": "Аннулирована по согласию",
  "deal.frozen": "Заморожена из-за спора",
  "deal.split_proposed": "Создана запись на остаток",
  "deal.split_closed": "Закрыта на внесённую сумму",
  "deal.completed": "Полностью оплачена",
  "payment.claimed": "Отмечена оплата",
  "payment.confirmed": "Оплата подтверждена",
  "payment.rejected": "Оплата не подтверждена",
  "payment.auto_confirmed": "Оплата засчитана автоматически",
};

export function DealScreen({
  dealId, profile, onBack,
}: {
  dealId: string;
  profile: Profile;
  onBack: () => void;
}) {
  const [deal, setDeal] = useState<Deal | null>(null);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [history, setHistory] = useState<AuditEntry[]>([]);
  const [counterparty, setCounterparty] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<null | "pay" | "propose" | "split">(null);
  const [amountInput, setAmountInput] = useState("");
  const [dateInput, setDateInput] = useState("");
  const today = todayMsk();

  const reload = useCallback(async () => {
    const fresh = await getDeal(dealId);
    setDeal(fresh);
    if (!fresh) return;

    const [pays, hist] = await Promise.all([getPayments(dealId), getHistory(dealId)]);
    setPayments(pays);
    setHistory(hist);

    const otherId = fresh.initiator_profile_id === profile.id
      ? fresh.partner_profile_id
      : fresh.initiator_profile_id;
    if (otherId) {
      const names = await getProfileNames([otherId]);
      setCounterparty(names[otherId] ?? "Контрагент");
    }
  }, [dealId, profile.id]);

  useEffect(() => { void reload(); }, [reload]);

  /**
   * Realtime включается только здесь — на открытой карточке. Именно тут важно
   * увидеть действие контрагента сразу, и именно такая точечная подписка не
   * взрывает число соединений при росте (docs/02-masshtabirovanie.md).
   */
  useEffect(() => {
    const channel = db()
      .channel(`deal:${dealId}`)
      .on("postgres_changes",
        { event: "UPDATE", schema: "app", table: "deals", filter: `id=eq.${dealId}` },
        () => { void reload(); })
      .on("postgres_changes",
        { event: "*", schema: "app", table: "payments", filter: `deal_id=eq.${dealId}` },
        () => { void reload(); })
      .subscribe();

    return () => { void db().removeChannel(channel); };
  }, [dealId, reload]);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
      haptic("success");
      setForm(null);
      setAmountInput("");
      setDateInput("");
      await reload();
    } catch (e) {
      haptic("error");
      const message = e instanceof Error ? e.message : "Не получилось";
      alert(message);
    } finally {
      setBusy(false);
    }
  };

  if (!deal) return <Loader />;

  const iAmDebtor = deal.debtor_profile_id === profile.id;
  const iAmInitiator = deal.initiator_profile_id === profile.id;
  const claimed = payments.find((p) => p.status === "claimed");
  const claimedByMe = claimed?.claimed_by_profile_id === profile.id;
  const proposalIsMine = deal.proposed_by_profile_id === profile.id;
  const isOpen = ["accepted", "negotiation", "frozen"].includes(deal.status);

  return (
    <div className="screen">
      <header className="header">
        <button className="nav-back" onClick={onBack}>‹ Назад</button>
        <h1>{formatMoney(deal.amount_minor)}</h1>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", paddingBottom: 4 }}>
          <StatusBadge status={deal.status} isOverdue={deal.is_overdue} />
          <span className="hint">
            {iAmDebtor ? "Я должен" : "Мне должны"} · {counterparty || "ждёт контрагента"}
          </span>
        </div>
      </header>

      <Group>
        <Row label="Срок оплаты" value={formatDate(deal.due_date, today)} />
        {deal.is_overdue && (
          <Row
            label="Просрочка"
            value={`${deal.days_past_due} ${plural(deal.days_past_due, ["день", "дня", "дней"])}`}
            danger
          />
        )}
        {deal.paid_minor > 0 && (
          <>
            <Row label="Оплачено" value={formatMoney(deal.paid_minor)} />
            <Row label="Остаток" value={formatMoney(deal.remaining_minor)} />
          </>
        )}
        {deal.description && <Row label="Описание" value={deal.description} />}
      </Group>

      {/* ТЗ-2 III.2: «было / стало» — без этого непонятно, на что соглашаешься. */}
      {deal.proposed_changes && (
        <Group title={deal.proposed_changes.cancel ? "Предложено аннулировать" : "Предложены новые условия"}>
          {deal.proposed_changes.amount_minor !== undefined && (
            <Row
              label="Сумма"
              value={`${formatMoney(deal.amount_minor)} → ${formatMoney(deal.proposed_changes.amount_minor)}`}
            />
          )}
          {deal.proposed_changes.due_date && (
            <Row
              label="Срок"
              value={`${formatDate(deal.due_date, today)} → ${formatDate(deal.proposed_changes.due_date, today)}`}
            />
          )}
          {deal.proposed_changes.comment && (
            <Row label="Комментарий" value={deal.proposed_changes.comment} />
          )}
          {proposalIsMine ? (
            <p className="hint" style={{ padding: "11px 16px" }}>Ждём ответа контрагента.</p>
          ) : (
            <div className="actions" style={{ padding: 16 }}>
              <button className="filled" disabled={busy}
                onClick={() => run(() => respondProposal(deal.id, true))}>
                Принять
              </button>
              {deal.status !== "frozen" && (
                <button className="tinted" disabled={busy}
                  onClick={() => run(() => respondProposal(deal.id, false))}>
                  Не согласен
                </button>
              )}
            </div>
          )}
        </Group>
      )}

      {claimed && (
        <Group title={`Заявлена оплата ${formatMoney(claimed.amount_minor)}`} padded>
          {claimedByMe ? (
            <p className="hint">
              Ждём подтверждения контрагента. Если он промолчит, платёж засчитается
              автоматически {formatDate(claimed.auto_confirm_after.slice(0, 10), today)}.
              Пока платёж заявлен, просрочка не начисляется.
            </p>
          ) : (
            <div className="actions">
              <button className="filled" disabled={busy}
                onClick={() => run(() => resolvePayment(claimed.id, true))}>
                Подтвердить получение
              </button>
              <button className="tinted destructive" disabled={busy}
                onClick={() => run(() => resolvePayment(claimed.id, false))}>
                Не получал
              </button>
            </div>
          )}
        </Group>
      )}

      {/* Действия зависят от статуса и от того, кто вы в этой сделке. */}
      <Group padded>
        {deal.status === "pending" && !iAmInitiator && (
          <div className="actions">
            <button className="filled" disabled={busy}
              onClick={() => run(() => acceptDeal(deal.id, profile.id))}>
              Подтвердить запись
            </button>
            <button className="tinted destructive" disabled={busy}
              onClick={() => run(() => declineDeal(deal.id))}>
              Отклонить
            </button>
          </div>
        )}

        {deal.status === "pending" && iAmInitiator && (
          <>
            <p className="hint">Ждём подтверждения контрагента.</p>
            <button className="tinted destructive" disabled={busy}
              onClick={() => run(() => declineDeal(deal.id, "отозвано создателем"))}>
              Отозвать
            </button>
          </>
        )}

        {isOpen && !claimed && (
          <div className="actions column">
            {form !== "pay" ? (
              <button className="filled" onClick={() => {
                setForm("pay");
                setAmountInput(String(Math.floor(deal.remaining_minor / 100)));
              }}>
                {iAmDebtor ? "Отметить оплату" : "Отметить получение денег"}
              </button>
            ) : (
              <div className="form">
                <div className="field amount-field">
                  <label>Сумма, ₽</label>
                  <input inputMode="decimal" value={amountInput}
                    onChange={(e) => setAmountInput(e.target.value)} />
                </div>
                <div className="actions">
                  <button className="filled" disabled={busy} onClick={() => {
                    const minor = inputToMinor(amountInput);
                    if (!minor) return alert("Введите сумму, например 4500");
                    if (minor > deal.remaining_minor) return alert("Больше остатка по записи");
                    void run(() => claimPayment(deal.id, minor));
                  }}>
                    Отметить
                  </button>
                  <button className="tinted" onClick={() => setForm(null)}>Отмена</button>
                </div>
              </div>
            )}

            {deal.status !== "frozen" && !deal.proposed_changes && (
              form !== "propose" ? (
                <button className="tinted" onClick={() => {
                  setForm("propose");
                  setDateInput(deal.due_date);
                  setAmountInput(String(Math.floor(deal.amount_minor / 100)));
                }}>
                  Предложить другие условия
                </button>
              ) : (
                <div className="form">
                  <p className="hint">
                    Изменить условия в одиночку нельзя — контрагент должен согласиться.
                  </p>
                  <div className="field amount-field">
                    <label>Сумма, ₽</label>
                    <input inputMode="decimal" value={amountInput}
                      onChange={(e) => setAmountInput(e.target.value)} />
                  </div>
                  <div className="field">
                    <label>Новый срок</label>
                    <input type="date" value={dateInput}
                      onChange={(e) => setDateInput(e.target.value)} />
                  </div>
                  <div className="actions">
                    <button className="filled" disabled={busy} onClick={() => {
                      const minor = inputToMinor(amountInput);
                      const changedAmount = minor !== deal.amount_minor ? minor : null;
                      const changedDate = dateInput !== deal.due_date ? dateInput : null;
                      if (!changedAmount && !changedDate) return alert("Ничего не изменилось");
                      void run(() => proposeChanges(deal.id, changedAmount, changedDate));
                    }}>
                      Отправить предложение
                    </button>
                    <button className="tinted" onClick={() => setForm(null)}>Отмена</button>
                  </div>
                </div>
              )
            )}

            {/* Р-4: перенос срока по остатку — это отдельная запись с новым акцептом. */}
            {deal.paid_minor > 0 && deal.status === "accepted" && (
              form !== "split" ? (
                <button className="tinted" onClick={() => {
                  setForm("split");
                  setDateInput(deal.due_date);
                }}>
                  Перенести срок по остатку
                </button>
              ) : (
                <div className="form">
                  <p className="hint">
                    Оплаченная часть закроется отдельной записью, а на остаток
                    {" "}{formatMoney(deal.remaining_minor)} создастся новая — с новым сроком,
                    который контрагент должен подтвердить.
                  </p>
                  <div className="field">
                    <label>Новый срок для остатка</label>
                    <input type="date" value={dateInput}
                      onChange={(e) => setDateInput(e.target.value)} />
                  </div>
                  <div className="actions">
                    <button className="filled" disabled={busy}
                      onClick={() => run(() => proposeSplit(deal.id, dateInput))}>
                      Создать запись на остаток
                    </button>
                    <button className="tinted" onClick={() => setForm(null)}>Отмена</button>
                  </div>
                </div>
              )
            )}

            {!deal.proposed_changes && (
              <button className="tinted destructive" disabled={busy} onClick={async () => {
                // Р-9: односторонне долг не обнуляется, это именно предложение.
                if (await confirm("Предложить контрагенту аннулировать запись?")) {
                  void run(() => proposeCancel(deal.id));
                }
              }}>
                Предложить аннулировать
              </button>
            )}
          </div>
        )}

        {deal.status === "completed" && <p className="hint">Запись закрыта, долг погашен.</p>}
        {deal.status === "cancelled" && <p className="hint">Запись аннулирована.</p>}
      </Group>

      {payments.length > 0 && (
        <Group title="Платежи">
          <ul className="list">
            {payments.map((p) => (
              <li key={p.id} className="cell">
                <span className="cell-title">{formatMoney(p.amount_minor)}</span>
                <span className="cell-sub">
                  {formatDate(p.paid_on, today)} ·{" "}
                  {p.status === "confirmed"
                    ? p.auto_confirmed ? "засчитан автоматически" : "подтверждён"
                    : p.status === "claimed" ? "ждёт подтверждения" : "отклонён"}
                </span>
              </li>
            ))}
          </ul>
        </Group>
      )}

      {/* FR-034: история действий как доказательство при споре. */}
      <Group title="История">
        <ul className="timeline">
          {history.map((entry) => (
            <li key={entry.id}>
              <span className="timeline-dot" />
              <div className="timeline-body">
                <span>{ACTION_LABEL[entry.action] ?? entry.action}</span>
                <span className="hint">
                  {new Date(entry.created_at).toLocaleString("ru-RU", {
                    day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
                  })}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </Group>
    </div>
  );
}

function Row({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="cell">
      <span className="cell-title">{label}</span>
      <span className={danger ? "cell-value danger" : "cell-value"}>{value}</span>
    </div>
  );
}
