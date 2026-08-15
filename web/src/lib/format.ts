/** Форматирование для интерфейса. Копия серверных правил, но без HTML. */

const NBSP = " ";

const MONTHS_GENITIVE = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

const MONTHS_NOMINATIVE = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];

export const WEEKDAY_SHORT = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

export function formatMoney(minor: number, withSign = false): string {
  const sign = minor < 0 ? "−" : withSign ? "+" : "";
  const abs = Math.abs(Math.round(minor));
  const grouped = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  const kopecks = abs % 100;
  const tail = kopecks ? `,${String(kopecks).padStart(2, "0")}` : "";
  return `${sign}${grouped}${tail}${NBSP}₽`;
}

/** Сумма без знака валюты — для полей ввода. */
export function moneyToInput(minor: number): string {
  const kopecks = minor % 100;
  return kopecks ? (minor / 100).toFixed(2).replace(".", ",") : String(Math.floor(minor / 100));
}

/** «1 500,50» или «1500» → копейки. Возвращает null, если разобрать не вышло. */
export function inputToMinor(value: string): number | null {
  const cleaned = value.replace(/[\s ]/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(parseFloat(cleaned) * 100);
}

export function formatDate(iso: string, today?: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const label = `${d}${NBSP}${MONTHS_GENITIVE[m - 1]}`;
  const currentYear = today ? Number(today.slice(0, 4)) : new Date().getFullYear();
  return y === currentYear ? label : `${label} ${y}`;
}

export function monthTitle(iso: string): string {
  const [y, m] = iso.split("-").map(Number);
  const current = new Date().getFullYear();
  return y === current ? MONTHS_NOMINATIVE[m - 1] : `${MONTHS_NOMINATIVE[m - 1]} ${y}`;
}

export function plural(n: number, forms: [string, string, string]): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
}

export function todayMsk(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function addMonths(iso: string, delta: number): string {
  const [y, m] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1 + delta, 1));
  return date.toISOString().slice(0, 10);
}

/** Приложение Б исходного ТЗ: цвета статусов. */
export const STATUS_META: Record<string, { label: string; color: string }> = {
  draft: { label: "Черновик", color: "#8e8e93" },
  pending: { label: "На согласовании", color: "#007aff" },
  accepted: { label: "Активна", color: "#34c759" },
  negotiation: { label: "Обсуждение условий", color: "#ffcc00" },
  frozen: { label: "Заморожена", color: "#5ac8fa" },
  completed: { label: "Оплачена", color: "#30d158" },
  cancelled: { label: "Отменена", color: "#636366" },
};

export const OVERDUE_META = { label: "Просрочена", color: "#ff9500" };

export function statusMeta(status: string, isOverdue: boolean) {
  if (isOverdue && (status === "accepted" || status === "negotiation" || status === "frozen")) {
    return OVERDUE_META;
  }
  return STATUS_META[status] ?? { label: status, color: "#8e8e93" };
}
