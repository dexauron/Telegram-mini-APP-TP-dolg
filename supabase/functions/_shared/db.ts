/**
 * Тонкая обёртка над PostgREST. Клиентская библиотека здесь не нужна: все
 * обращения — это вызовы функций из схемы app, а логика живёт в базе.
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export class DbError extends Error {
  code: string | null;
  status: number;

  constructor(message: string, code: string | null, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }

  /** Наши бизнес-ошибки из RPC приходят с этими кодами и понятным текстом. */
  get isUserFacing(): boolean {
    return this.code === "P0001" || this.code === "P0002" || this.code === "42501";
  }
}

/**
 * @param token JWT пользователя. Без него вызов идёт под service_role — так
 *   можно только то, что не требует авторства (онбординг, очередь рассылки).
 *   Действия от имени человека обязаны передавать его токен, иначе RPC не
 *   найдёт текущего пользователя и откажет.
 */
export async function rpc<T = unknown>(
  fn: string,
  args: Record<string, unknown> = {},
  token?: string,
): Promise<T> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Profile": "app",
      "Accept-Profile": "app",
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${token ?? SERVICE_KEY}`,
    },
    body: JSON.stringify(args),
  });

  const text = await res.text();
  if (!res.ok) {
    let message = text;
    let code: string | null = null;
    try {
      const parsed = JSON.parse(text);
      message = parsed.message ?? text;
      code = parsed.code ?? null;
    } catch { /* ответ не JSON — отдаём как есть */ }
    throw new DbError(message, code, res.status);
  }

  return text ? JSON.parse(text) as T : (null as T);
}

/** Дата «сегодня» по Москве — вся бизнес-логика живёт в этом поясе (Р-11). */
export function todayMsk(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
