import { useState } from "react";
import { createDeal, dealInviteToken } from "../api/deals";
import type { Profile } from "../api/client";
import { inputToMinor, todayMsk, formatMoney, formatDate } from "../lib/format";
import { haptic, tg } from "../lib/telegram";

export function NewDealScreen({
  profile, onDone, onCancel,
}: {
  profile: Profile;
  onDone: () => void;
  onCancel: () => void;
}) {
  const today = todayMsk();
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState(today);
  const [description, setDescription] = useState("");
  const [iAmDebtor, setIAmDebtor] = useState(false);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<null | { link: string; amountMinor: number }>(null);

  const submit = async () => {
    const minor = inputToMinor(amount);
    if (!minor) {
      alert("Введите сумму, например 45000");
      return;
    }

    setBusy(true);
    try {
      const result = await createDeal({
        profileId: profile.id,
        amountMinor: minor,
        dueDate,
        // Кто должен: по умолчанию контрагент — самый частый случай, когда
        // поставщик фиксирует долг магазина.
        debtorSide: iAmDebtor ? "initiator" : "partner",
        description: description.trim() || null,
      });
      haptic("success");

      const token = result.invite_token ?? (await dealInviteToken(result.deal_id));
      setCreated({
        link: token ? `https://t.me/share/url?url=${encodeURIComponent(inviteUrl(token))}` : "",
        amountMinor: minor,
      });
    } catch (e) {
      haptic("error");
      alert(e instanceof Error ? e.message : "Не получилось создать запись");
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <div className="screen">
        <header className="header">
          <h1>Запись создана</h1>
        </header>
        <section className="card">
          <p>
            {formatMoney(created.amountMinor)}, срок {formatDate(dueDate, today)}.
            Запись начнёт действовать, когда контрагент её подтвердит.
          </p>
          <p className="hint">
            Отправьте карточку контрагенту — он подтвердит её одной кнопкой. Если он ещё
            не пользуется приложением, ссылка приведёт его сюда с готовой записью.
          </p>
          <div className="actions column">
            {created.link && (
              <button className="primary" onClick={() => tg?.openTelegramLink(created.link)}>
                Отправить контрагенту
              </button>
            )}
            <button className="secondary" onClick={onDone}>Готово</button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="screen">
      <header className="header">
        <button className="link" onClick={onCancel}>‹ Отмена</button>
        <h1>Новая запись</h1>
      </header>

      <section className="card">
        <div className="form">
          <label>Сумма, ₽</label>
          <input
            className="amount-input"
            inputMode="decimal"
            autoFocus
            placeholder="45000"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />

          <label>Срок оплаты</label>
          <input type="date" value={dueDate} min={today}
            onChange={(e) => setDueDate(e.target.value)} />

          <label>За что</label>
          <input
            placeholder="Молоко, 200 л"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />

          <div className="switch">
            <button
              className={!iAmDebtor ? "switch-option active" : "switch-option"}
              onClick={() => setIAmDebtor(false)}
            >
              Мне должны
            </button>
            <button
              className={iAmDebtor ? "switch-option active" : "switch-option"}
              onClick={() => setIAmDebtor(true)}
            >
              Я должен
            </button>
          </div>
        </div>
      </section>

      <section className="card">
        <p className="hint">
          Контрагентом станет тот, кто подтвердит запись по вашей ссылке. Проценты и пени
          за просрочку система не начисляет.
        </p>
        <button className="primary" disabled={busy} onClick={submit}>
          {busy ? "Создаём…" : "Создать запись"}
        </button>
      </section>
    </div>
  );
}

function inviteUrl(token: string): string {
  const botUsername = import.meta.env.VITE_BOT_USERNAME as string | undefined;
  return botUsername ? `https://t.me/${botUsername}?start=${token}` : `?start=${token}`;
}
