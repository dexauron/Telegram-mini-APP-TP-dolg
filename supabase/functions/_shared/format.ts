/**
 * Форматирование сумм, дат и карточек сделок для сообщений бота.
 * Без зависимостей и без обращений к среде — модуль покрыт тестами.
 */

const NBSP = " ";

const MONTHS_GENITIVE = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

/** 4500000 → «45 000 ₽», 150050 → «1 500,50 ₽» */
export function formatMoney(minor: number): string {
  const sign = minor < 0 ? "−" : "";
  const abs = Math.abs(Math.round(minor));
  const rubles = Math.floor(abs / 100);
  const kopecks = abs % 100;

  const grouped = String(rubles).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  const tail = kopecks ? `,${String(kopecks).padStart(2, "0")}` : "";
  return `${sign}${grouped}${tail}${NBSP}₽`;
}

/** «2026-08-15» → «15 августа» (или «15 августа 2027», если год не текущий) */
export function formatDate(iso: string, today?: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const label = `${d}${NBSP}${MONTHS_GENITIVE[m - 1]}`;
  const currentYear = today ? Number(today.slice(0, 4)) : y;
  return y === currentYear ? label : `${label} ${y}`;
}

/** Склонение: 1 день, 2 дня, 5 дней */
export function plural(n: number, forms: [string, string, string]): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
}

export function days(n: number): string {
  return `${n}${NBSP}${plural(n, ["день", "дня", "дней"])}`;
}

export interface DealCard {
  amount_minor: number;
  paid_minor?: number;
  due_date: string;
  description?: string | null;
  status?: string;
  counterparty?: string | null;
  /** true — долг на мне, false — должны мне. Не указан для открытых карточек. */
  iAmDebtor?: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  draft: "⚪️ Черновик",
  pending: "🔵 На согласовании",
  accepted: "🟢 Активна",
  negotiation: "🟡 Обсуждение условий",
  frozen: "🧊 Заморожена",
  completed: "✅ Оплачена",
  cancelled: "⚫️ Отменена",
};

export function statusLabel(status: string, isOverdue = false): string {
  if (isOverdue && (status === "accepted" || status === "negotiation")) {
    return "🟠 Просрочена";
  }
  return STATUS_LABEL[status] ?? status;
}

/** Текст карточки сделки для сообщения бота. Разметка — HTML. */
export function dealCardText(deal: DealCard, today: string): string {
  const lines: string[] = [];
  const remaining = deal.amount_minor - (deal.paid_minor ?? 0);
  const overdue = deal.due_date < today && remaining > 0;

  lines.push(`<b>${formatMoney(deal.amount_minor)}</b>`);
  if (deal.paid_minor) {
    lines.push(`Оплачено: ${formatMoney(deal.paid_minor)}, остаток ${formatMoney(remaining)}`);
  }
  lines.push(`Срок: ${formatDate(deal.due_date, today)}`);

  if (overdue) {
    const late = Math.round(
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${deal.due_date}T00:00:00Z`)) / 86400000,
    );
    lines.push(`⚠️ Просрочено на ${days(late)}`);
  }
  if (deal.description) lines.push(`\n${escapeHtml(deal.description)}`);
  if (deal.counterparty) lines.push(`\nКонтрагент: ${escapeHtml(deal.counterparty)}`);
  if (deal.status) lines.push(statusLabel(deal.status, overdue));

  return lines.join("\n");
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
