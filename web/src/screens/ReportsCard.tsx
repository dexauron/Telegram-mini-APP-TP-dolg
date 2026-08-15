import { useState } from "react";
import type { Profile } from "../api/client";
import { requestReport } from "../api/reports";
import { todayMsk, formatDate } from "../lib/format";
import { haptic } from "../lib/telegram";
import { Group } from "../components/Loader";

type Period = "week" | "month" | "quarter" | "custom";

const PERIODS: Array<{ id: Period; label: string }> = [
  { id: "week", label: "Неделя" },
  { id: "month", label: "Месяц" },
  { id: "quarter", label: "Квартал" },
  { id: "custom", label: "Свой" },
];

function shiftDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function rangeFor(period: Period, today: string): { from: string; to: string } {
  switch (period) {
    case "week": return { from: shiftDays(today, -7), to: shiftDays(today, 7) };
    case "month": return { from: `${today.slice(0, 7)}-01`, to: shiftDays(today, 45) };
    case "quarter": return { from: shiftDays(today, -90), to: shiftDays(today, 90) };
    default: return { from: today, to: today };
  }
}

/**
 * FR-081, FR-085: отчёт приходит от бота в личный чат, откуда пересылается
 * руководителю одним касанием — без выдачи ему доступа к системе.
 */
export function ReportsCard({ profile }: { profile: Profile }) {
  const today = todayMsk();
  const [period, setPeriod] = useState<Period>("month");
  const [custom, setCustom] = useState(rangeFor("custom", today));
  const [busy, setBusy] = useState<null | "text" | "csv">(null);
  const [done, setDone] = useState<string | null>(null);

  const range = period === "custom" ? custom : rangeFor(period, today);

  const send = async (format: "text" | "csv") => {
    setBusy(format);
    setDone(null);
    try {
      const result = await requestReport(profile.id, range.from, range.to, format);
      haptic("success");
      setDone(
        result.rows === 0
          ? "За этот период записей нет — бот прислал пустой отчёт"
          : format === "csv"
            ? "Таблица отправлена вам в чат с ботом"
            : "Отчёт отправлен вам в чат с ботом",
      );
    } catch (e) {
      haptic("error");
      setDone(e instanceof Error ? e.message : "Не получилось сформировать отчёт");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Group
      title="Отчёты"
      footer="Отчёт приходит в чат с ботом. Оттуда его можно переслать кому угодно — доступ к приложению получателю не нужен."
      padded
    >
      <div className="filters" style={{ padding: 0 }}>
        {PERIODS.map((p) => (
          <button
            key={p.id}
            className={period === p.id ? "filter active" : "filter"}
            onClick={() => setPeriod(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>

      {period === "custom" ? (
        <div className="form">
          <div className="field" style={{ padding: "11px 0" }}>
            <label>С какого числа</label>
            <input type="date" value={custom.from}
              onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
          </div>
          <div className="field" style={{ padding: "11px 0" }}>
            <label>По какое</label>
            <input type="date" value={custom.to}
              onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
          </div>
        </div>
      ) : (
        <p className="hint">
          {formatDate(range.from, today)} — {formatDate(range.to, today)}
        </p>
      )}

      <div className="actions column">
        <button className="filled" disabled={busy !== null} onClick={() => send("text")}>
          {busy === "text" ? "Формируем…" : "Отчёт текстом"}
        </button>
        <button className="tinted" disabled={busy !== null} onClick={() => send("csv")}>
          {busy === "csv" ? "Формируем…" : "Таблица для бухгалтерии"}
        </button>
      </div>

      {done && <p className="hint">{done}</p>}
    </Group>
  );
}
