/**
 * Тесты форматирования, проверки подписи Telegram и выпуска JWT.
 * Запуск: supabase/functions/_shared/run-tests.sh
 */
import { formatMoney, formatDate, plural, statusLabel, dealCardText } from "./format.ts";
import { verifyInitData } from "./telegram.ts";
import { signUserToken } from "./jwt.ts";
import { renderMessage } from "./messages.ts";
import { reportAsText, reportAsCsv, reportFileName } from "./report.ts";

const TODAY = "2026-08-15";
const BOT_TOKEN = "123456:TEST-TOKEN-FOR-TESTS";

let passed = 0;
const failures: string[] = [];

function eq(actual: unknown, expected: unknown, label: string) {
  if (actual === expected) passed++;
  else failures.push(`  ${label}\n    ожидалось: ${expected}\n    получено:  ${actual}`);
}

function ok(condition: boolean, label: string) {
  if (condition) passed++;
  else failures.push(`  ${label}`);
}

// --- Деньги -----------------------------------------------------------------
const NBSP = " ";
eq(formatMoney(4500000), `45${NBSP}000${NBSP}₽`, "45 000 ₽");
eq(formatMoney(150050), `1${NBSP}500,50${NBSP}₽`, "копейки показываются");
eq(formatMoney(100), `1${NBSP}₽`, "рубль без копеек");
eq(formatMoney(120000000), `1${NBSP}200${NBSP}000${NBSP}₽`, "разряды у миллиона");

// --- Даты -------------------------------------------------------------------
eq(formatDate("2026-08-15", TODAY), `15${NBSP}августа`, "дата текущего года без года");
eq(formatDate("2027-01-31", TODAY), `31${NBSP}января 2027`, "чужой год показывается");

// --- Склонения --------------------------------------------------------------
eq(plural(1, ["день", "дня", "дней"]), "день", "1 день");
eq(plural(2, ["день", "дня", "дней"]), "дня", "2 дня");
eq(plural(5, ["день", "дня", "дней"]), "дней", "5 дней");
eq(plural(11, ["день", "дня", "дней"]), "дней", "11 дней");
eq(plural(21, ["день", "дня", "дней"]), "день", "21 день");

// --- Статусы ----------------------------------------------------------------
eq(statusLabel("accepted"), "🟢 Активна", "активная запись");
eq(statusLabel("accepted", true), "🟠 Просрочена", "просрочка перекрывает статус (Р-6)");
eq(statusLabel("completed", true), "✅ Оплачена", "закрытая запись не бывает просроченной");

// --- Карточка ---------------------------------------------------------------
const card = dealCardText({
  amount_minor: 4500000,
  paid_minor: 2000000,
  due_date: "2026-08-10",
  description: "Молоко <200 л>",
  status: "accepted",
  counterparty: "Магазин у дома",
}, TODAY);
ok(card.includes("Оплачено"), "в карточке видна частичная оплата");
ok(card.includes("Просрочено на 5"), "в карточке считается просрочка");
ok(card.includes("&lt;200 л&gt;"), "html в описании экранируется");
ok(!card.includes("🟢"), "просроченная запись не показывается активной");

// --- Проверка подписи initData (NFR-005) ------------------------------------
const encoder = new TextEncoder();

async function hmacRaw(key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey(
    "raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return crypto.subtle.sign("HMAC", k, encoder.encode(msg));
}

async function makeInitData(user: object, authDate: number, token = BOT_TOKEN): Promise<string> {
  const params = new URLSearchParams({
    user: JSON.stringify(user),
    auth_date: String(authDate),
    query_id: "AAE",
  });
  const checkString = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = await hmacRaw(encoder.encode("WebAppData"), token);
  const hash = [...new Uint8Array(await hmacRaw(secret, checkString))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  params.set("hash", hash);
  return params.toString();
}

const now = Math.floor(Date.now() / 1000);
const validUser = { id: 777, first_name: "Алиса", username: "alisa" };

const good = await verifyInitData(await makeInitData(validUser, now), BOT_TOKEN);
eq(good?.id, 777, "корректный initData принимается");

const wrongToken = await verifyInitData(await makeInitData(validUser, now, "999:OTHER"), BOT_TOKEN);
eq(wrongToken, null, "подпись чужим ботом отклоняется");

const tampered = (await makeInitData(validUser, now)).replace("%22id%22%3A777", "%22id%22%3A888");
eq(await verifyInitData(tampered, BOT_TOKEN), null, "подмена telegram_id отклоняется");

const stale = await verifyInitData(await makeInitData(validUser, now - 90000), BOT_TOKEN);
eq(stale, null, "просроченный initData отклоняется");

eq(await verifyInitData("user=%7B%7D&auth_date=1", BOT_TOKEN), null, "данные без подписи отклоняются");

// --- JWT --------------------------------------------------------------------
const token = await signUserToken(
  { sub: "00000000-0000-0000-0000-000000000001", telegram_id: 777 },
  "super-secret",
  60,
);
const [, payloadPart] = token.split(".");
const claims = JSON.parse(
  Buffer.from(payloadPart.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
);
eq(token.split(".").length, 3, "токен состоит из трёх частей");
eq(claims.role, "authenticated", "роль authenticated — иначе RLS не применится");
eq(claims.sub, "00000000-0000-0000-0000-000000000001", "sub указывает на пользователя");
ok(claims.exp - claims.iat === 60, "срок жизни токена проставлен");

// --- Тексты уведомлений -----------------------------------------------------
const pending = renderMessage({
  id: 1, kind: "deal.pending", telegram_id: 1, payload: { deal_id: "d1" },
  deal: {
    amount_minor: 4500000, paid_minor: 0, due_date: "2026-08-20",
    description: "Молоко", status: "pending", counterparty: "ИП Алиса",
  },
}, TODAY);
ok(!!pending?.keyboard, "у запроса на подтверждение есть кнопки");
eq(pending?.keyboard?.inline_keyboard[0][0].callback_data, "a:d1", "кнопка подтверждения ведёт к сделке");

const digest = renderMessage({
  id: 2, kind: "digest.daily", telegram_id: 1,
  payload: { overdue_count: 3, overdue_minor: 600000, soon_count: 0, soon_minor: 0 },
}, TODAY);
ok(digest!.text.includes("3 записи"), "в сводке правильное склонение");
ok(!digest?.keyboard, "у сводки кнопок нет");

eq(renderMessage({ id: 3, kind: "unknown.kind", telegram_id: 1, payload: {} }, TODAY), null,
  "неизвестный тип уведомления не роняет рассыльщик");

// --- Отчёты -----------------------------------------------------------------
const report = {
  period: { from: "2026-08-01", to: "2026-08-31" },
  profile: { id: "p1", name: "ИП Алиса" },
  rows: [
    {
      id: "11111111-2222-3333-4444-555555555555",
      created_at: "2026-08-01T10:00:00Z", due_date: "2026-08-10",
      counterparty: "Магазин «Заря»", amount_minor: 4500000, paid_minor: 0,
      remaining_minor: 4500000, status: "accepted",
      description: 'Молоко "отборное"', i_owe: false, is_overdue: true,
    },
    {
      id: "66666666-7777-8888-9999-000000000000",
      created_at: "2026-08-05T10:00:00Z", due_date: "2026-08-20",
      counterparty: "Оптбаза", amount_minor: 1280000, paid_minor: 500000,
      remaining_minor: 780000, status: "accepted",
      description: null, i_owe: true, is_overdue: false,
    },
  ],
  totals: {
    count: 2, owed_to_me_minor: 4500000, i_owe_minor: 780000,
    completed_minor: 0, overdue_count: 1, overdue_minor: 4500000,
  },
};

const text = reportAsText(report, TODAY);
ok(text.includes("ИП Алиса"), "в отчёте есть название профиля");
ok(text.includes("Просрочено: 1 запись"), "в отчёте правильное склонение просрочек");
ok(text.includes("Магазин «Заря»"), "в отчёте перечислены записи");
ok(!text.includes("<b>"), "текстовый отчёт без разметки — его шлют в любой мессенджер");

const csv = reportAsCsv(report);
const csvLines = csv.split("\r\n");
ok(csv.startsWith("\ufeff"), "CSV начинается с BOM, иначе Excel ломает кириллицу");
ok(csvLines[0].split(";").length === 10, "в шапке таблицы все колонки");
ok(csvLines[1].includes("10.08.2026"), "даты в привычном формате");
ok(csvLines[1].includes("45000,00"), "суммы с запятой как разделителем");
ok(csvLines[1].includes('""отборное""'), "кавычки в описании экранированы");
ok(csv.includes("Итого мне должны"), "в таблице есть итоги");
eq(reportFileName(report), "ugovor_2026-08-01_2026-08-31.csv", "имя файла с периодом");

console.log(`\nОбщие модули: пройдено ${passed} из ${passed + failures.length}`);
if (failures.length) {
  console.error("\nОшибки:\n" + failures.join("\n"));
  process.exit(1);
}
console.log("=== Все проверки общих модулей пройдены ===");
