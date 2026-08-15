/**
 * Дымовой тест интерфейса: собранное приложение открывается в браузере с
 * подставленными данными и проверяется, что экраны действительно рисуются,
 * суммы и просрочка считаются, а исключений JavaScript нет.
 *
 * Запуск:
 *   npm run build
 *   npm run smoke
 *
 * Нужен Chromium: npx playwright install chromium (в готовых окружениях он
 * обычно уже стоит — путь можно задать через PLAYWRIGHT_CHROMIUM).
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "dist");
const OUT = process.env.SMOKE_OUT ?? join(dirname(fileURLToPath(import.meta.url)), "smoke-shots");
await mkdir(OUT, { recursive: true });
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };

const server = createServer(async (req, res) => {
  const path = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  try {
    const body = await readFile(join(ROOT, path));
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404).end("not found"); }
});
await new Promise((r) => server.listen(4173, r));

const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const day = (shift) => new Date(Date.now() + shift * 86400e3).toISOString().slice(0, 10);

const DEALS = [
  { id: "d1", parent_deal_id: null, initiator_profile_id: "p1", partner_profile_id: "p2",
    debtor_profile_id: "p2", creditor_profile_id: "p1", amount_minor: 4500000, paid_minor: 0,
    remaining_minor: 4500000, due_date: day(-4), description: "Молоко, 200 л", status: "accepted",
    is_overdue: true, is_partially_paid: false, has_claimed_payment: false, days_past_due: 4,
    proposed_changes: null, proposed_by_profile_id: null, created_at: today },
  { id: "d2", parent_deal_id: null, initiator_profile_id: "p3", partner_profile_id: "p1",
    debtor_profile_id: "p1", creditor_profile_id: "p3", amount_minor: 1280000, paid_minor: 500000,
    remaining_minor: 780000, due_date: day(2), description: "Хлеб, поставка от 12.08",
    status: "accepted", is_overdue: false, is_partially_paid: true, has_claimed_payment: false,
    days_past_due: -2, proposed_changes: null, proposed_by_profile_id: null, created_at: today },
  { id: "d3", parent_deal_id: null, initiator_profile_id: "p4", partner_profile_id: "p1",
    debtor_profile_id: "p4", creditor_profile_id: "p1", amount_minor: 9000000, paid_minor: 0,
    remaining_minor: 9000000, due_date: day(9), description: "Сыр, 3 короба", status: "negotiation",
    is_overdue: false, is_partially_paid: false, has_claimed_payment: false, days_past_due: -9,
    proposed_changes: { due_date: day(20), comment: "просим отсрочку" },
    proposed_by_profile_id: "p4", created_at: today },
];
const PROFILES = [
  { id: "p2", name: "Магазин «Заря»" },
  { id: "p3", name: "Оптбаза «Восток»" },
  { id: "p4", name: "ИП Сафаров" },
];

const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
);
const crashes = [];
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
page.on("pageerror", (e) => crashes.push(String(e)));

await page.addInitScript(() => {
  window.Telegram = {
    WebApp: {
      initData: "user=%7B%22id%22%3A1%7D&hash=x",
      colorScheme: "light", themeParams: {},
      ready() {}, expand() {}, close() {}, openTelegramLink() {},
      BackButton: { show() {}, hide() {}, onClick() {}, offClick() {} },
      MainButton: { setText() {}, show() {}, hide() {}, showProgress() {}, hideProgress() {},
        onClick() {}, offClick() {}, enable() {}, disable() {} },
      showConfirm(_m, cb) { cb(true); }, showAlert(_m, cb) { cb?.(); },
    },
  };
});

const jsonRoute = (route, body) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

await page.route("**/api/**", async (route) => {
  const url = route.request().url();
  if (url.includes("/functions/v1/auth")) {
    return jsonRoute(route, {
      token: "test-token", expires_in: 3600,
      user: { id: "u1", telegram_id: 1, tos_accepted: false },
      profiles: [{ id: "p1", name: "ИП Алиса", kind: "supplier", is_default: true }],
    });
  }
  if (url.includes("/rpc/rpc_accept_tos")) return jsonRoute(route, null);
  if (url.includes("/rpc/rpc_calendar_month")) {
    return jsonRoute(route, {
      days: DEALS.map((d) => ({
        date: d.due_date, i_owe_minor: d.debtor_profile_id === "p1" ? d.remaining_minor : 0,
        owed_to_me_minor: d.creditor_profile_id === "p1" ? d.remaining_minor : 0,
        count: 1, has_overdue: d.is_overdue, all_paid: false,
      })),
      total_i_owe_minor: 780000, total_owed_to_me_minor: 13500000,
    });
  }
  if (url.includes("/deals_view")) {
    // maybeSingle() ждёт объект, а не массив — как и настоящий PostgREST.
    const match = /id=eq\.([^&]+)/.exec(url);
    if (match) return jsonRoute(route, DEALS.find((d) => d.id === match[1]) ?? null);
    return jsonRoute(route, DEALS);
  }
  if (url.includes("/audit_log")) {
    return jsonRoute(route, [
      { id: 1, action: "deal.created", created_at: new Date(Date.now() - 6 * 86400e3).toISOString(),
        actor_profile_id: "p1", payload: null },
      { id: 2, action: "deal.accepted", created_at: new Date(Date.now() - 6 * 86400e3 + 3600e3).toISOString(),
        actor_profile_id: "p2", payload: null },
    ]);
  }
  if (url.includes("/profiles")) return jsonRoute(route, PROFILES);
  if (url.includes("/bilateral_stats")) return jsonRoute(route, []);
  if (url.includes("/notification_settings")) {
    return jsonRoute(route, {
      user_id: "u1", remind_days_before: [1, 3], overdue_frequency: "daily",
      payment_auto_confirm_days: 7,
    });
  }
  return jsonRoute(route, []);
});

await page.goto("http://localhost:4173/", { waitUntil: "domcontentloaded" });
await page.waitForSelector("text=Принять и начать", { timeout: 5000 });
console.log("OK: экран оферты отрисован");
await page.screenshot({ path: `${OUT}/01-oferta.png` });

await page.click("text=Принять и начать");
await page.waitForSelector("text=Магазин «Заря»", { timeout: 5000 });
console.log("OK: список записей отрисован");
await page.screenshot({ path: `${OUT}/02-zapisi.png` });

const overdue = await page.locator("text=/просрочка 4 дня/").count();
console.log(overdue ? "OK: просрочка посчитана и подписана верно" : "ОШИБКА: нет отметки просрочки");

await page.click("text=Календарь");
await page.waitForSelector(".calendar", { timeout: 5000 });
console.log("OK: календарь отрисован");
await page.screenshot({ path: `${OUT}/03-kalendar.png` });

await page.click("text=Записи");
await page.click("text=Магазин «Заря»");
await page.waitForSelector("text=История", { timeout: 5000 });
console.log("OK: карточка сделки отрисована");
await page.screenshot({ path: `${OUT}/04-kartochka.png` });

console.log(crashes.length ? "ОШИБКИ JS:\n" + crashes.join("\n") : "OK: исключений JavaScript нет");
await browser.close();
server.close();
process.exit(crashes.length === 0 && overdue > 0 ? 0 : 1);
