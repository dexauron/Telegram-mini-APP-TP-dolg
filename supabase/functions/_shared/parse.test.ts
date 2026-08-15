/**
 * Тесты парсера сообщений. Запуск: supabase/functions/_shared/run-tests.sh
 *
 * Дата «сегодня» задаётся явно (суббота, 15 августа 2026), поэтому результат
 * не зависит от дня прогона.
 */
import { parseDealText } from "./parse.ts";

const TODAY = "2026-08-15";

let passed = 0;
const failures: string[] = [];

function check(
  input: string,
  expect: { amount?: number | null; date?: string | null; description?: string },
) {
  const got = parseDealText(input, TODAY);
  const problems: string[] = [];

  if ("amount" in expect && got.amountMinor !== expect.amount) {
    problems.push(`сумма: ожидалось ${expect.amount}, получено ${got.amountMinor}`);
  }
  if ("date" in expect && got.dueDate !== expect.date) {
    problems.push(`дата: ожидалось ${expect.date}, получено ${got.dueDate}`);
  }
  if (expect.description !== undefined && got.description !== expect.description) {
    problems.push(`описание: ожидалось "${expect.description}", получено "${got.description}"`);
  }

  if (problems.length) {
    failures.push(`  «${input}»\n    ${problems.join("\n    ")}`);
  } else {
    passed++;
  }
}

// --- Основной сценарий из ТЗ (FR-018) ---------------------------------------
check("@BotName 5000 руб за молоко, оплата 15 августа", {
  amount: 500000, date: "2026-08-15", description: "за молоко",
});

// --- Форматы суммы ----------------------------------------------------------
check("45000 20.09", { amount: 4500000, date: "2026-09-20" });
check("45 000 ₽ 20.09", { amount: 4500000 });
check("1 500,50 руб завтра", { amount: 150050, date: "2026-08-16" });
check("5к завтра", { amount: 500000 });
check("5 тыс завтра", { amount: 500000 });
check("12 000 рублей за хлеб послезавтра", {
  amount: 1200000, date: "2026-08-17", description: "за хлеб",
});

// --- Форматы даты -----------------------------------------------------------
check("3000 15.08.2026", { date: "2026-08-15" });
check("3000 15/08", { date: "2026-08-15" });
check("3000 сегодня", { date: "2026-08-15" });
check("3000 через неделю", { date: "2026-08-22" });
check("3000 через 10 дней", { date: "2026-08-25" });
check("3000 через 2 месяца", { date: "2026-10-15" });
check("3000 в пятницу", { date: "2026-08-21" });   // 15.08.2026 — суббота
check("3000 в понедельник", { date: "2026-08-17" });
check("3000 3 сентября", { date: "2026-09-03" });
check("3000 1 мая", { date: "2027-05-01" });        // прошедшая дата → следующий год
check("3000 31 января", { date: "2027-01-31" });

// --- Число даты не должно приниматься за сумму -------------------------------
check("оплата 15 августа 5000", { amount: 500000, date: "2026-08-15" });
check("20.09 7000 руб", { amount: 700000, date: "2026-09-20" });

// --- Приоритет: сумма с валютой важнее случайного числа -----------------------
check("2 ящика молока 4500 руб до 20.09", {
  amount: 450000, date: "2026-09-20", description: "2 ящика молока",
});

// --- Неполные данные: парсер возвращает что смог -----------------------------
check("за молоко 5000", { amount: 500000, date: null, description: "за молоко" });
check("оплата завтра", { amount: null, date: "2026-08-16", description: "" });
check("просто текст", { amount: null, date: null, description: "просто текст" });

// --- Конец месяца при сдвиге на месяцы ---------------------------------------
check("1000 через 1 месяц", { date: "2026-09-15" });

console.log(`\nПарсер: пройдено ${passed} из ${passed + failures.length}`);
if (failures.length) {
  console.error("\nОшибки:\n" + failures.join("\n"));
  process.exit(1);
}
console.log("=== Все проверки парсера пройдены ===");
