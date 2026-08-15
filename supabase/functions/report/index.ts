/**
 * Отчёты (FR-077…FR-085, FR-098…FR-102).
 *
 * Готовый отчёт бот присылает пользователю в чат: оттуда его можно переслать
 * руководителю одним касанием, а таблица приходит файлом. Скачивание файлов
 * внутри Mini App работает ненадёжно, поэтому доставка идёт через бота.
 */
import { verifyInitData, createBotApi } from "../_shared/telegram.ts";
import { signUserToken } from "../_shared/jwt.ts";
import { rpc, todayMsk, json, CORS_HEADERS, DbError } from "../_shared/db.ts";
import {
  reportAsText, reportAsCsv, reportFileName, type Report,
} from "../_shared/report.ts";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const JWT_SECRET = Deno.env.get("SUPABASE_JWT_SECRET")!;
const bot = createBotApi(BOT_TOKEN);

/** Telegram не принимает сообщения длиннее 4096 символов. */
const MESSAGE_LIMIT = 4000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: { initData?: string; profileId?: string; from?: string; to?: string; format?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }

  const { initData, profileId, from, to, format = "text" } = body;
  if (!initData || !profileId || !from || !to) return json({ error: "bad_request" }, 400);

  const tgUser = await verifyInitData(initData, BOT_TOKEN);
  if (!tgUser) return json({ error: "invalid_init_data" }, 401);

  try {
    // Отчёт запрашивается от имени человека, поэтому нужен его токен: RPC сама
    // проверит, что профиль принадлежит вызывающему (FR-101).
    const account = await rpc<{ user: { id: string; telegram_id: number } }>(
      "upsert_telegram_user",
      { p_telegram_id: tgUser.id },
    );
    const token = await signUserToken(
      { sub: account.user.id, telegram_id: account.user.telegram_id },
      JWT_SECRET,
      5 * 60,
    );

    const report = await rpc<Report>(
      "rpc_report",
      { p_profile_id: profileId, p_from: from, p_to: to },
      token,
    );

    const today = todayMsk();

    if (format === "csv") {
      const file = new Blob([reportAsCsv(report)], { type: "text/csv;charset=utf-8" });
      const form = new FormData();
      form.append("chat_id", String(tgUser.id));
      form.append("caption", `Таблица за период ${from} — ${to}`);
      form.append("document", file, reportFileName(report));

      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
        method: "POST",
        body: form,
      });
      const result = await res.json();
      if (!result.ok) throw new Error(result.description ?? "sendDocument failed");
    } else {
      const text = reportAsText(report, today);
      // Длинный отчёт режем по строкам, чтобы записи не разрывались посередине.
      const chunks: string[] = [];
      let current = "";
      for (const line of text.split("\n")) {
        if (current.length + line.length + 1 > MESSAGE_LIMIT) {
          chunks.push(current);
          current = "";
        }
        current += (current ? "\n" : "") + line;
      }
      if (current) chunks.push(current);

      for (const chunk of chunks) {
        await bot("sendMessage", {
          chat_id: tgUser.id,
          text: chunk,
          link_preview_options: { is_disabled: true },
        });
      }
    }

    return new Response(
      JSON.stringify({ ok: true, rows: report.rows.length }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  } catch (error) {
    if (error instanceof DbError && error.isUserFacing) {
      return json({ error: "rejected", message: error.message }, 400);
    }
    console.error("report failed", error);
    return json({ error: "internal" }, 500);
  }
});
