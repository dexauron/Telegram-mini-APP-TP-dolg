/**
 * Обмен Telegram initData на JWT (Р-11, NFR-005).
 *
 * Единственная дверь в систему: Mini App присылает подписанный initData,
 * функция проверяет подпись ключом бота, заводит пользователя при первом входе
 * и выдаёт короткоживущий токен, с которым клиент ходит в Supabase напрямую.
 */
import { verifyInitData } from "../_shared/telegram.ts";
import { signUserToken } from "../_shared/jwt.ts";
import { rpc, json, CORS_HEADERS } from "../_shared/db.ts";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const JWT_SECRET = Deno.env.get("SUPABASE_JWT_SECRET")!;
const TOKEN_TTL_SECONDS = 60 * 60;

interface Profile { id: string; name: string; kind: string; is_default: boolean }
interface UpsertResult {
  user: { id: string; telegram_id: number; tos_accepted: boolean };
  profiles: Profile[];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  let initData: string;
  try {
    ({ initData } = await req.json());
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  if (!initData) return json({ error: "init_data_required" }, 400);

  const tgUser = await verifyInitData(initData, BOT_TOKEN);
  if (!tgUser) {
    // Подпись не сошлась или данные просрочены — внутрь не пускаем.
    return json({ error: "invalid_init_data" }, 401);
  }

  try {
    const result = await rpc<UpsertResult>("upsert_telegram_user", {
      p_telegram_id: tgUser.id,
      p_username: tgUser.username ?? null,
      p_first_name: tgUser.first_name ?? null,
      p_last_name: tgUser.last_name ?? null,
      p_photo_url: tgUser.photo_url ?? null,
      p_language_code: tgUser.language_code ?? null,
    });

    const token = await signUserToken({
      sub: result.user.id,
      telegram_id: result.user.telegram_id,
      profile_ids: result.profiles.map((p) => p.id),
    }, JWT_SECRET, TOKEN_TTL_SECONDS);

    return new Response(
      JSON.stringify({
        token,
        expires_in: TOKEN_TTL_SECONDS,
        user: result.user,
        profiles: result.profiles,
      }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  } catch (error) {
    // Забаненному аккаунту (shadowban, ТЗ-2 IV) отвечаем честно и без деталей.
    const message = error instanceof Error ? error.message : String(error);
    if (/заблокирован/i.test(message)) return json({ error: "banned" }, 403);

    console.error("auth failed", message);
    return json({ error: "internal" }, 500);
  }
});
