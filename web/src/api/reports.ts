/**
 * Отчёты формируются на сервере и доставляются ботом в чат: скачивание файлов
 * внутри Mini App работает ненадёжно, а пересылка сообщения — привычное действие.
 */
import { tg } from "../lib/telegram";
import { ApiError } from "./client";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;

export async function requestReport(
  profileId: string,
  from: string,
  to: string,
  format: "text" | "csv",
): Promise<{ ok: boolean; rows: number }> {
  const initData = tg?.initData;
  if (!initData) throw new ApiError("Отчёты доступны только внутри Telegram");

  const res = await fetch(`${SUPABASE_URL}/functions/v1/report`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData, profileId, from, to, format }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(body.message ?? "Не получилось сформировать отчёт");
  }
  return body;
}
