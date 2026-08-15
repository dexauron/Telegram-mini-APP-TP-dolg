/**
 * Доступ к данным.
 *
 * Схема из Р-11: initData меняется на JWT в Edge Function, дальше клиент ходит
 * в Supabase напрямую с этим токеном — работают и RLS, и Realtime. Изменения
 * данных идут только через RPC, прямые UPDATE клиенту запрещены политиками.
 */
import { createClient } from "@supabase/supabase-js";
import { tg } from "../lib/telegram";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export interface Profile {
  id: string;
  name: string;
  kind: "supplier" | "store" | "both";
  is_default: boolean;
}

export interface AuthResult {
  token: string;
  expires_in: number;
  user: { id: string; telegram_id: number; tos_accepted: boolean };
  profiles: Profile[];
}

export class ApiError extends Error {}

let session: AuthResult | null = null;
let expiresAt = 0;
let refreshing: Promise<AuthResult> | null = null;

async function exchangeInitData(): Promise<AuthResult> {
  const initData = tg?.initData;
  if (!initData) {
    throw new ApiError("Приложение открывается только внутри Telegram");
  }

  const res = await fetch(`${SUPABASE_URL}/functions/v1/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (body.error === "banned") throw new ApiError("Аккаунт заблокирован за нарушение правил");
    throw new ApiError("Не удалось войти. Попробуйте открыть приложение заново");
  }
  return res.json() as Promise<AuthResult>;
}

/** Токен живёт час; обновляем заранее, чтобы запрос не упал посреди действия. */
function isFresh(): boolean {
  return Boolean(session) && Date.now() < expiresAt - 60_000;
}

async function refreshSession(): Promise<AuthResult> {
  // Параллельные запросы не должны дёргать Edge Function по разу каждый.
  refreshing ??= exchangeInitData()
    .then((result) => {
      session = result;
      expiresAt = Date.now() + result.expires_in * 1000;
      return result;
    })
    .finally(() => { refreshing = null; });

  return refreshing;
}

function makeClient() {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    db: { schema: "app" },
    // supabase-js сам спрашивает свежий токен перед каждым запросом и для
    // Realtime, поэтому пересоздавать клиента при обновлении не нужно.
    accessToken: async () => {
      if (!isFresh()) await refreshSession();
      return session?.token ?? null;
    },
    realtime: { params: { eventsPerSecond: 2 } },
  });
}

let client: ReturnType<typeof makeClient> | null = null;

export async function auth(): Promise<AuthResult> {
  if (!isFresh()) await refreshSession();
  client ??= makeClient();
  return session!;
}

export function db(): ReturnType<typeof makeClient> {
  if (!client) throw new ApiError("Нет соединения с сервером");
  return client;
}

export function currentSession(): AuthResult | null {
  return session;
}

export async function callRpc<T = unknown>(
  fn: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const { data, error } = await db().rpc(fn, args);
  if (error) throw new ApiError(error.message);
  return data as T;
}
