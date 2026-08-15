/**
 * Сборка отчётов (FR-078…FR-080, FR-099).
 *
 * Текстовый вариант рассчитан на пересылку руководителю прямо в мессенджере,
 * таблица — на бухгалтерию. Оба формата собираются из одних и тех же данных,
 * чтобы цифры не разъезжались.
 */
import { formatMoney, formatDate, plural } from "./format.ts";

export interface ReportRow {
  id: string;
  created_at: string;
  due_date: string;
  counterparty: string;
  amount_minor: number;
  paid_minor: number;
  remaining_minor: number;
  status: string;
  description: string | null;
  i_owe: boolean;
  is_overdue: boolean;
}

export interface Report {
  period: { from: string; to: string };
  profile: { id: string; name: string };
  rows: ReportRow[];
  totals: {
    count: number;
    owed_to_me_minor: number;
    i_owe_minor: number;
    completed_minor: number;
    overdue_count: number;
    overdue_minor: number;
  };
}

const STATUS_TEXT: Record<string, string> = {
  pending: "на согласовании",
  accepted: "активна",
  negotiation: "обсуждение условий",
  frozen: "заморожена",
  completed: "оплачена",
  cancelled: "отменена",
};

function statusText(row: ReportRow): string {
  if (row.is_overdue) return "просрочена";
  return STATUS_TEXT[row.status] ?? row.status;
}

/** FR-080: структурированный текст с эмодзи — пригоден для любого мессенджера. */
export function reportAsText(report: Report, today: string): string {
  const { totals, period } = report;
  const lines: string[] = [
    `📊 Отчёт: ${report.profile.name}`,
    `Период: ${formatDate(period.from, today)} — ${formatDate(period.to, today)}`,
    "",
    `Записей: ${totals.count}`,
    `🟢 Мне должны: ${formatMoney(totals.owed_to_me_minor)}`,
    `🔴 Я должен: ${formatMoney(totals.i_owe_minor)}`,
    `✅ Закрыто за период: ${formatMoney(totals.completed_minor)}`,
  ];

  if (totals.overdue_count) {
    lines.push(
      `🟠 Просрочено: ${totals.overdue_count} ` +
      `${plural(totals.overdue_count, ["запись", "записи", "записей"])} ` +
      `на ${formatMoney(totals.overdue_minor)}`,
    );
  }

  if (report.rows.length) {
    lines.push("", "————————————");
    for (const row of report.rows) {
      const mark = row.is_overdue ? "🟠" : row.status === "completed" ? "✅" : row.i_owe ? "🔴" : "🟢";
      lines.push(
        `${mark} ${formatDate(row.due_date, today)} · ${row.counterparty}`,
        `   ${formatMoney(row.remaining_minor)}` +
        (row.paid_minor ? ` из ${formatMoney(row.amount_minor)}` : "") +
        ` · ${statusText(row)}` +
        (row.description ? `\n   ${row.description}` : ""),
      );
    }
  }

  lines.push("", "Отчёт сформирован приложением «Уговор».");
  return lines.join("\n");
}

/**
 * FR-098, FR-099: таблица для бухгалтерии. CSV с разделителем «;» и BOM —
 * именно так Excel в русской локали открывает файл без плясок с импортом.
 */
export function reportAsCsv(report: Report): string {
  const header = [
    "Номер записи", "Дата создания", "Срок оплаты", "Контрагент", "Направление",
    "Сумма", "Оплачено", "Остаток", "Статус", "Описание",
  ];

  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const money = (minor: number) => (minor / 100).toFixed(2).replace(".", ",");
  const date = (iso: string) => iso.slice(0, 10).split("-").reverse().join(".");

  const lines = [header.map(escape).join(";")];
  for (const row of report.rows) {
    lines.push([
      escape(row.id.slice(0, 8)),
      escape(date(row.created_at)),
      escape(date(row.due_date)),
      escape(row.counterparty),
      escape(row.i_owe ? "Я должен" : "Мне должны"),
      money(row.amount_minor),
      money(row.paid_minor),
      money(row.remaining_minor),
      escape(statusText(row)),
      escape(row.description ?? ""),
    ].join(";"));
  }

  lines.push("");
  lines.push([escape("Итого мне должны"), "", "", "", "", "", "", money(report.totals.owed_to_me_minor)].join(";"));
  lines.push([escape("Итого я должен"), "", "", "", "", "", "", money(report.totals.i_owe_minor)].join(";"));

  return "﻿" + lines.join("\r\n");
}

export function reportFileName(report: Report): string {
  return `ugovor_${report.period.from}_${report.period.to}.csv`;
}
