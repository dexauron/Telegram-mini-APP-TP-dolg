/**
 * Проверка подписи Telegram и вызовы Bot API.
 *
 * initData Mini App подписан ключом бота, поэтому доверять его содержимому
 * можно только после проверки HMAC (NFR-005). Без этой проверки любой мог бы
 * представиться чужим telegram_id.
 */

const encoder = new TextEncoder();

async function hmac(key: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Сравнение за постоянное время: длина подписи известна, утечки по таймингу не нужны. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  language_code?: string;
}

/**
 * Проверяет подпись initData и возвращает пользователя.
 * @param maxAgeSeconds окно жизни initData; Telegram рекомендует не доверять старым данным.
 */
export async function verifyInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds = 24 * 60 * 60,
): Promise<TelegramUser | null> {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const checkString = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");

  const secret = await hmac(encoder.encode("WebAppData"), botToken);
  const computed = toHex(await hmac(secret, checkString));
  if (!safeEqual(computed, hash)) return null;

  const authDate = Number(params.get("auth_date") ?? 0);
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSeconds) return null;

  const rawUser = params.get("user");
  if (!rawUser) return null;
  try {
    return JSON.parse(rawUser) as TelegramUser;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Bot API
// ---------------------------------------------------------------------------

export class TelegramApiError extends Error {
  errorCode: number;
  description: string;

  constructor(message: string, errorCode: number, description: string) {
    super(message);
    this.errorCode = errorCode;
    this.description = description;
  }

  /** Пользователь заблокировал бота или удалил аккаунт — писать ему больше нельзя. */
  get userUnreachable(): boolean {
    return this.errorCode === 403 ||
      /bot was blocked|user is deactivated|chat not found/i.test(this.description);
  }

  /** Слишком часто — Telegram просит подождать. */
  get retryAfter(): number | null {
    const m = this.description.match(/retry after (\d+)/i);
    return m ? Number(m[1]) : null;
  }
}

export function createBotApi(token: string) {
  return async function call<T = unknown>(
    method: string,
    payload: Record<string, unknown> = {},
  ): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!data.ok) {
      throw new TelegramApiError(
        `${method}: ${data.description}`,
        data.error_code ?? res.status,
        data.description ?? "",
      );
    }
    return data.result as T;
  };
}
