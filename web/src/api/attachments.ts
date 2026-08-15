/**
 * Вложения живут в Telegram (Р-8): мы храним только ссылку, а сам файл бот
 * пересылает пользователю в чат по запросу.
 */
import { db, callRpc } from "./client";
import { tg } from "../lib/telegram";
import { ApiError } from "./client";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;

export interface Attachment {
  id: string;
  deal_id: string;
  kind: "photo" | "video" | "document" | "voice" | "audio";
  file_name: string | null;
  caption: string | null;
  size_bytes: number | null;
  uploaded_by_profile_id: string;
  created_at: string;
}

export async function listAttachments(dealId: string): Promise<Attachment[]> {
  const { data, error } = await db()
    .from("attachments").select("*").eq("deal_id", dealId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as Attachment[];
}

/** Просит бота прислать файл в личный чат. */
export async function requestAttachment(attachmentId: string): Promise<void> {
  const initData = tg?.initData;
  if (!initData) throw new ApiError("Файлы доступны только внутри Telegram");

  const res = await fetch(`${SUPABASE_URL}/functions/v1/attachment`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData, attachmentId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.message ?? "Не получилось прислать файл");
  }
}

export const deleteAttachment = (attachmentId: string) =>
  callRpc("rpc_delete_attachment", { p_attachment_id: attachmentId });

export const KIND_LABEL: Record<Attachment["kind"], string> = {
  photo: "Фотография",
  video: "Видео",
  document: "Документ",
  voice: "Голосовое сообщение",
  audio: "Аудио",
};
