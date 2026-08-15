/**
 * Рассыльщик очереди уведомлений.
 *
 * Вызывается планировщиком раз в минуту (app.kick_outbox_worker). Забирает
 * порции сообщений и отправляет их, соблюдая лимит Telegram — порядка 30
 * сообщений в секунду от бота. Очередь и пометки об отправке живут в базе,
 * поэтому падение функции посреди работы не теряет и не дублирует сообщения.
 */
import { createBotApi, TelegramApiError } from "../_shared/telegram.ts";
import { rpc, todayMsk, json } from "../_shared/db.ts";
import { renderMessage, type OutboxItem } from "../_shared/messages.ts";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const BATCH_SIZE = 25;
/** 25 сообщений в секунду — с запасом под лимит Telegram. */
const SEND_INTERVAL_MS = 40;
/** Бюджет одного запуска: функция должна успеть завершиться до таймаута. */
const RUN_BUDGET_MS = 20_000;

const bot = createBotApi(BOT_TOKEN);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  // Функцию дёргает планировщик с сервисным ключом. Снаружи её вызывать нельзя.
  const auth = req.headers.get("Authorization");
  if (auth !== `Bearer ${SERVICE_KEY}`) return json({ error: "forbidden" }, 403);

  const startedAt = Date.now();
  const today = todayMsk();
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  while (Date.now() - startedAt < RUN_BUDGET_MS) {
    const batch = await rpc<OutboxItem[]>("outbox_take", { p_limit: BATCH_SIZE });
    if (!batch.length) break;

    const delivered: number[] = [];

    for (const item of batch) {
      if (Date.now() - startedAt > RUN_BUDGET_MS) break;

      const message = renderMessage(item, today);
      if (!message) {
        // Неизвестный тип уведомления: помечаем отправленным, чтобы очередь
        // не забивалась им вечно, но оставляем след в логах.
        console.warn("unknown outbox kind", item.kind);
        delivered.push(item.id);
        skipped++;
        continue;
      }

      try {
        await bot("sendMessage", {
          chat_id: item.telegram_id,
          text: message.text,
          parse_mode: "HTML",
          reply_markup: message.keyboard,
          link_preview_options: { is_disabled: true },
        });
        delivered.push(item.id);
        sent++;
      } catch (error) {
        failed++;
        if (error instanceof TelegramApiError) {
          const retryAfter = error.retryAfter;
          if (retryAfter) {
            // Telegram просит притормозить — слушаемся и выходим до следующего запуска.
            await rpc("outbox_mark_failed", { p_id: item.id, p_error: error.description });
            await sleep(Math.min(retryAfter, 5) * 1000);
            break;
          }
          // Заблокировал бота или удалил аккаунт — больше не пишем (FR-055).
          await rpc("outbox_mark_failed", {
            p_id: item.id,
            p_error: error.description,
            p_blocked: error.userUnreachable,
          });
        } else {
          await rpc("outbox_mark_failed", {
            p_id: item.id,
            p_error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      await sleep(SEND_INTERVAL_MS);
    }

    if (delivered.length) {
      await rpc("outbox_mark_sent", { p_ids: delivered });
    }
    if (batch.length < BATCH_SIZE) break;
  }

  return json({ sent, failed, skipped, ms: Date.now() - startedAt });
});
