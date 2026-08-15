/**
 * Разбор сообщения вида «5000 руб за молоко, оплата 15 августа» (FR-018, FR-040).
 *
 * Модуль намеренно без зависимостей и без обращений к среде: он одинаково
 * работает и в Edge Function, и в тестах. Текущая дата передаётся аргументом,
 * иначе тесты зависели бы от дня запуска.
 *
 * Парсер не обязан быть безошибочным: результат всегда показывается человеку
 * карточкой-предпросмотром, и запись создаётся только после подтверждения
 * (FR-019). Поэтому лучше вернуть частичный результат, чем ничего.
 */

export interface ParsedDeal {
  amountMinor: number | null;
  /** Срок оплаты в формате YYYY-MM-DD. */
  dueDate: string | null;
  description: string;
  /** Что именно удалось распознать — для подсказок в карточке. */
  matched: { amount: boolean; date: boolean };
}

/**
 * Границы слова. Штатный \b в JavaScript опирается на латиницу (\w — это
 * [A-Za-z0-9_]), поэтому с русским текстом он не срабатывает вовсе: между
 * пробелом и буквой «с» границы для него нет. Отсюда — собственные границы
 * через просмотр вперёд и назад по любым буквам и цифрам Unicode.
 */
const NB = String.raw`(?<![\p{L}\p{N}])`;
const NA = String.raw`(?![\p{L}\p{N}])`;
const LETTERS = String.raw`[\p{L}]*`;

const MONTHS: Array<[string, number]> = [
  ["январ", 1], ["феврал", 2], ["март", 3], ["апрел", 4], ["ма", 5], ["июн", 6],
  ["июл", 7], ["август", 8], ["сентябр", 9], ["октябр", 10], ["ноябр", 11], ["декабр", 12],
];

const WEEKDAYS: Array<[string, number]> = [
  ["понедельник", 1],
  ["вторник", 2],
  ["сред[ауы]", 3],
  ["четверг", 4],
  ["пятниц[ауы]", 5],
  ["суббот[ауы]", 6],
  ["воскресень", 0],
];

interface Span { start: number; end: number }

function toIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function fromIso(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function addDays(iso: string, days: number): string {
  const d = fromIso(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toIso(d);
}

function addMonths(iso: string, months: number): string {
  const d = fromIso(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  // 31 января плюс месяц — это конец февраля, а не 3 марта.
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return toIso(d);
}

/**
 * Собирает дату из дня и месяца. Если такая дата уже прошла, считаем, что
 * человек имеет в виду следующий год: «15 января», сказанное в декабре, — это
 * январь следующего года, а не прошедший.
 */
function buildDate(today: string, day: number, month: number, year?: number): string | null {
  if (month < 1 || month > 12) return null;
  const base = fromIso(today);
  let y = year ?? base.getUTCFullYear();
  if (year !== undefined && year < 100) y += 2000;

  const lastDay = new Date(Date.UTC(y, month, 0)).getUTCDate();
  if (day < 1 || day > lastDay) return null;

  const fmt = (yy: number) =>
    `${yy}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  const iso = fmt(y);
  return year === undefined && iso < today ? fmt(y + 1) : iso;
}

function parseDate(text: string, today: string): { date: string; span: Span } | null {
  const span = (m: RegExpMatchArray): Span =>
    ({ start: m.index!, end: m.index! + m[0].length });

  // 1. Числовой формат: 15.08, 15.08.2026, 15/08
  const numeric = text.match(/\b(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?\b/);
  if (numeric) {
    const date = buildDate(today, +numeric[1], +numeric[2],
      numeric[3] ? +numeric[3] : undefined);
    if (date) return { date, span: span(numeric) };
  }

  // 2. «15 августа», «до 3 сентября».
  // Перебираем все пары «число + слово»: первая такая пара запросто окажется
  // хвостом суммы («5000 руб» даёт «00 руб»), а месяц будет дальше по тексту.
  const byMonth = text.matchAll(
    new RegExp(`${NB}(\\d{1,2})\\s+([а-яё]{3,})`, "giu"),
  );
  for (const m of byMonth) {
    const word = m[2].toLowerCase();
    for (const [stem, month] of MONTHS) {
      // «мая» и «марта» начинаются одинаково, поэтому май проверяем строже.
      if (!word.startsWith(stem)) continue;
      if (stem === "ма" && !/^ма[йея]/.test(word)) continue;
      const date = buildDate(today, +m[1], month);
      if (date) return { date, span: span(m) };
    }
  }

  // 3. «сегодня», «завтра», «послезавтра»
  const relWord = text.match(new RegExp(`${NB}(сегодня|завтра|послезавтра)${NA}`, "iu"));
  if (relWord) {
    const shift = { сегодня: 0, завтра: 1, послезавтра: 2 }[relWord[1].toLowerCase()]!;
    return { date: addDays(today, shift), span: span(relWord) };
  }

  // 4. «через 10 дней», «через неделю», «через 2 месяца»
  const through = text.match(
    new RegExp(`${NB}через\\s+(\\d+)?\\s*(дн${LETTERS}|день|недел${LETTERS}|месяц${LETTERS})${NA}`, "iu"),
  );
  if (through) {
    const n = through[1] ? +through[1] : 1;
    const unit = through[2].toLowerCase();
    const date = unit.startsWith("месяц")
      ? addMonths(today, n)
      : addDays(today, unit.startsWith("недел") ? n * 7 : n);
    return { date, span: span(through) };
  }

  // 5. «в пятницу» — ближайший такой день недели, сегодняшний не считается.
  for (const [stem, weekday] of WEEKDAYS) {
    const m = text.match(new RegExp(`${NB}во?\\s+${stem}${LETTERS}${NA}`, "iu"));
    if (m) {
      const current = fromIso(today).getUTCDay();
      const shift = ((weekday - current + 7) % 7) || 7;
      return { date: addDays(today, shift), span: span(m) };
    }
  }

  return null;
}

function parseAmount(text: string): { minor: number; span: Span } | null {
  // Число с разделителями тысяч и необязательной дробной частью:
  // 5000, 5 000, 1 500,50 — с суффиксом тысяч и/или знаком валюты.
  const re = new RegExp(
    String.raw`(\d[\d\s .,]*\d|\d)\s*(тыс${LETTERS}|к${NA}|k${NA})?\s*(₽|руб(?:л(?:ей|я|ь))?\.?|р\.)?`,
    "giu",
  );
  const candidates: Array<{ minor: number; span: Span; weight: number }> = [];

  for (const m of text.matchAll(re)) {
    const matched = m[0].trimEnd();
    if (!matched) continue;

    let raw = m[1].replace(/[\s ]/g, "");
    // Дробная часть — только если после запятой или точки ровно одна-две цифры.
    const fraction = raw.match(/^(.*)[.,](\d{1,2})$/);
    let kopecks = 0;
    if (fraction) {
      raw = fraction[1];
      kopecks = +fraction[2].padEnd(2, "0");
    }
    raw = raw.replace(/[.,]/g, "");
    if (!raw) continue;

    let minor = +raw * 100 + kopecks;
    if (m[2]) minor *= 1000;                 // «5 тыс», «5к»
    if (!Number.isFinite(minor) || minor <= 0) continue;

    // Приоритет: явный знак валюты важнее суффикса тысяч, тот важнее голого числа.
    candidates.push({
      minor,
      span: { start: m.index!, end: m.index! + matched.length },
      weight: m[3] ? 3 : m[2] ? 2 : 1,
    });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.weight - a.weight || b.minor - a.minor);
  return { minor: candidates[0].minor, span: candidates[0].span };
}

function cleanDescription(text: string, spans: Span[]): string {
  let out = "";
  let cursor = 0;
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    if (s.start < cursor) continue;
    out += text.slice(cursor, s.start) + " ";
    cursor = s.end;
  }
  out += text.slice(cursor);

  const stopWords = new RegExp(
    `${NB}(оплата|оплатить|оплату|оплаты|срок|до|числа|числу)${NA}`, "giu",
  );

  return out
    .replace(stopWords, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,.;:—–-]+|[\s,.;:—–-]+$/g, "")
    .trim();
}

/**
 * @param text  текст сообщения без упоминания бота
 * @param today текущая дата в MSK, формат YYYY-MM-DD
 */
export function parseDealText(text: string, today: string): ParsedDeal {
  const normalized = text.replace(/@\w+/g, " ").replace(/\s{2,}/g, " ").trim();

  const date = parseDate(normalized, today);

  // Число, уже отданное дате, деньгами быть не может: закрываем его пробелами,
  // сохраняя позиции символов, чтобы описание собиралось по исходному тексту.
  const masked = date
    ? normalized.slice(0, date.span.start) +
      " ".repeat(date.span.end - date.span.start) +
      normalized.slice(date.span.end)
    : normalized;

  const amount = parseAmount(masked);

  const spans: Span[] = [];
  if (date) spans.push(date.span);
  if (amount) spans.push(amount.span);

  return {
    amountMinor: amount ? amount.minor : null,
    dueDate: date ? date.date : null,
    description: cleanDescription(normalized, spans),
    matched: { amount: !!amount, date: !!date },
  };
}
