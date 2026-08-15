/**
 * Выдача вложения по запросу из Mini App (FR-074, Р-8).
 *
 * Файлы лежат в Telegram, и скачать их напрямую из мини-приложения нельзя:
 * ссылка на файл живёт около часа и содержит токен бота, показывать её клиенту
 * недопустимо. Поэтому бот просто пересылает файл в личный чат по file_id —
 * бесплатно, без ограничений по объёму и без хранения у нас.
 */
import { verifyInitData, createBotApi } from "../_shared/telegram.ts";
import { signUserToken } from "../_shared/jwt.ts";
import { rpc, json, CORS_HEADERS, DbError } from "../_shared/db.ts";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const JWT_SECRET = Deno.env.get("SUPABASE_JWT_SECRET")!;
const bot = createBotApi(BOT_TOKEN);

const SEND_METHOD: Record<string, { method: string; field: string }> = {
  photo: { method: "sendPhoto", field: "photo" },
  video: { method: "sendVideo", field: "video" },
  voice: { method: "sendVoice", field: "voice" },
  audio: { method: "sendAudio", field: "audio" },
  document: { method: "sendDocument", field: "document" },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let body: { initData?: string; attachmentId?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  if (!body.initData || !body.attachmentId) return json({ error: "bad_request" }, 400);

  const tgUser = await verifyInitData(body.initData, BOT_TOKEN);
  if (!tgUser) return json({ error: "invalid_init_data" }, 401);

  try {
    const account = await rpc<{ user: { id: string; telegram_id: number } }>(
      "upsert_telegram_user",
      { p_telegram_id: tgUser.id },
    );
    const token = await signUserToken(
      { sub: account.user.id, telegram_id: account.user.telegram_id },
      JWT_SECRET,
      5 * 60,
    );

    // Право на файл проверяет база: вызывающий должен быть стороной сделки.
    const file = await rpc<{
      kind: string; tg_file_id: string; file_name: string | null; caption: string | null;
    }>("attachment_file", { p_attachment_id: body.attachmentId }, token);

    const send = SEND_METHOD[file.kind] ?? SEND_METHOD.document;
    await bot(send.method, {
      chat_id: tgUser.id,
      [send.field]: file.tg_file_id,
      caption: file.caption ?? file.file_name ?? undefined,
    });

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (error) {
    if (error instanceof DbError && error.isUserFacing) {
      return json({ error: "rejected", message: error.message }, 400);
    }
    console.error("attachment failed", error);
    return json({ error: "internal" }, 500);
  }
});
