import { useEffect, useState } from "react";
import { callRpc, db, type AuthResult, type Profile } from "../api/client";
import { formatMoney } from "../lib/format";
import { tg } from "../lib/telegram";

interface Settings {
  remind_days_before: number[];
  overdue_frequency: "daily" | "every_2_days" | "weekly" | "off";
  payment_auto_confirm_days: number;
}

interface Stats {
  counterparty_profile_id: string;
  deals_total: number;
  deals_completed: number;
  deals_completed_on_time: number;
  deals_overdue_now: number;
  outstanding_minor: number;
  volume_completed_minor: number;
}

const REMIND_OPTIONS = [0, 1, 3, 7];
const FREQUENCY_LABEL: Record<Settings["overdue_frequency"], string> = {
  daily: "Ежедневно",
  every_2_days: "Через день",
  weekly: "Раз в неделю",
  off: "Не напоминать",
};

export function ProfileScreen({
  session, profile, onSelectProfile,
}: {
  session: AuthResult;
  profile: Profile;
  onSelectProfile: (profile: Profile) => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [stats, setStats] = useState<Stats[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    void (async () => {
      const { data } = await db()
        .from("notification_settings").select("*").eq("user_id", session.user.id).maybeSingle();
      if (data) setSettings(data as unknown as Settings);

      // Р-2: приватная двусторонняя статистика вместо публичного рейтинга.
      const { data: rows } = await db()
        .from("bilateral_stats").select("*").eq("profile_id", profile.id)
        .order("last_deal_at", { ascending: false }).limit(20);
      const list = (rows ?? []) as unknown as Stats[];
      setStats(list);

      if (list.length) {
        const { data: profiles } = await db()
          .from("profiles").select("id,name")
          .in("id", list.map((s) => s.counterparty_profile_id));
        setNames(Object.fromEntries((profiles ?? []).map((p) => [p.id as string, p.name as string])));
      }
    })();
  }, [session.user.id, profile.id]);

  const save = async (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch } as Settings;
    setSettings(next);
    await callRpc("rpc_update_notification_settings", {
      p_remind_days_before: next.remind_days_before,
      p_overdue_frequency: next.overdue_frequency,
      p_payment_auto_confirm_days: next.payment_auto_confirm_days,
    });
  };

  return (
    <div className="screen">
      <header className="header">
        <h1>Профиль</h1>
      </header>

      <section className="card">
        <h2>{profile.name}</h2>
        <p className="hint">
          {profile.kind === "supplier" ? "Поставщик"
            : profile.kind === "store" ? "Магазин" : "Поставщик и магазин"}
        </p>
        {session.profiles.length > 1 && (
          <ul className="plain">
            {session.profiles.map((p) => (
              <li key={p.id}>
                <button
                  className={p.id === profile.id ? "row compact active" : "row compact"}
                  onClick={() => onSelectProfile(p)}
                >
                  {p.name}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Р-2: никаких звёзд и публичных отзывов — только история с теми,
          с кем реально работали, и видна она только вам двоим. */}
      <section className="card">
        <h2>История с контрагентами</h2>
        {stats.length === 0 ? (
          <p className="hint">Пока нет завершённых сделок.</p>
        ) : (
          <ul className="plain">
            {stats.map((s) => (
              <li key={s.counterparty_profile_id} className="stat">
                <span className="stat-name">
                  {names[s.counterparty_profile_id] ?? "Контрагент"}
                </span>
                <span className="hint">
                  {s.deals_completed} из {s.deals_total} закрыто
                  {s.deals_completed > 0 &&
                    `, вовремя ${Math.round((s.deals_completed_on_time / s.deals_completed) * 100)}%`}
                  {s.deals_overdue_now > 0 && ` · сейчас просрочено ${s.deals_overdue_now}`}
                </span>
                {s.outstanding_minor > 0 && (
                  <span className="hint">Открыто на {formatMoney(s.outstanding_minor)}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {settings && (
        <section className="card">
          <h2>Напоминания</h2>

          <p className="kv-label">Предупреждать до срока</p>
          <div className="chips">
            {REMIND_OPTIONS.map((day) => {
              const on = settings.remind_days_before.includes(day);
              return (
                <button
                  key={day}
                  className={on ? "chip active" : "chip"}
                  onClick={() => save({
                    remind_days_before: on
                      ? settings.remind_days_before.filter((d) => d !== day)
                      : [...settings.remind_days_before, day].sort((a, b) => a - b),
                  })}
                >
                  {day === 0 ? "В день оплаты" : `за ${day}`}
                </button>
              );
            })}
          </div>

          <p className="kv-label">Напоминать о просрочке</p>
          <div className="chips">
            {(Object.keys(FREQUENCY_LABEL) as Settings["overdue_frequency"][]).map((freq) => (
              <button
                key={freq}
                className={settings.overdue_frequency === freq ? "chip active" : "chip"}
                onClick={() => save({ overdue_frequency: freq })}
              >
                {FREQUENCY_LABEL[freq]}
              </button>
            ))}
          </div>

          <p className="hint">
            Если контрагент не отвечает на отметку об оплате{" "}
            {settings.payment_auto_confirm_days} дней, платёж засчитывается автоматически.
          </p>
        </section>
      )}

      <section className="card">
        <h2>О приложении</h2>
        <p className="hint">
          Мы не собираем телефон, ФИО и другие персональные данные — только имя и
          идентификатор из Telegram. Проценты и пени за просрочку не начисляются.
          Записи видны только вам и вашему контрагенту.
        </p>
        <button className="secondary" onClick={() => tg?.close()}>Закрыть приложение</button>
      </section>
    </div>
  );
}
