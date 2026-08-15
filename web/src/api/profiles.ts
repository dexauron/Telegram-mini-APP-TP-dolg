/** Управление профилями (FR-008…FR-012). */
import { db, callRpc, type Profile } from "./client";

export async function listProfiles(userId: string): Promise<Profile[]> {
  const { data, error } = await db()
    .from("profiles").select("id,name,kind,is_default")
    .eq("owner_user_id", userId).is("archived_at", null)
    .order("is_default", { ascending: false }).order("created_at");
  if (error) throw new Error(error.message);
  return (data ?? []) as Profile[];
}

export const createProfile = (name: string, kind: Profile["kind"]) =>
  callRpc<Profile>("rpc_create_profile", { p_name: name, p_kind: kind });

export const setDefaultProfile = (profileId: string) =>
  callRpc("rpc_set_default_profile", { p_profile_id: profileId });

export const archiveProfile = (profileId: string) =>
  callRpc("rpc_archive_profile", { p_profile_id: profileId });

export const updateProfile = (profileId: string, name?: string, kind?: Profile["kind"]) =>
  callRpc("rpc_update_profile", {
    p_profile_id: profileId, p_name: name ?? null, p_kind: kind ?? null,
  });

export const KIND_LABEL: Record<Profile["kind"], string> = {
  supplier: "Поставщик",
  store: "Магазин",
  both: "Поставщик и магазин",
};
