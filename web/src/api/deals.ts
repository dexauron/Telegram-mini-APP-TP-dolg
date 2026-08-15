/** Запросы к сделкам. Чтение — напрямую с RLS, изменения — только через RPC. */
import { db, callRpc } from "./client";

export type DealStatus =
  | "draft" | "pending" | "accepted" | "negotiation" | "frozen" | "completed" | "cancelled";

export interface Deal {
  id: string;
  parent_deal_id: string | null;
  initiator_profile_id: string;
  partner_profile_id: string | null;
  debtor_profile_id: string | null;
  creditor_profile_id: string | null;
  amount_minor: number;
  paid_minor: number;
  remaining_minor: number;
  due_date: string;
  description: string | null;
  status: DealStatus;
  is_overdue: boolean;
  is_partially_paid: boolean;
  has_claimed_payment: boolean;
  days_past_due: number;
  proposed_changes: { amount_minor?: number; due_date?: string; comment?: string; cancel?: boolean } | null;
  proposed_by_profile_id: string | null;
  created_at: string;
}

export interface Payment {
  id: string;
  deal_id: string;
  amount_minor: number;
  paid_on: string;
  status: "claimed" | "confirmed" | "rejected";
  claimed_by_profile_id: string;
  auto_confirm_after: string;
  auto_confirmed: boolean;
  note: string | null;
}

export interface AuditEntry {
  id: number;
  action: string;
  created_at: string;
  actor_profile_id: string | null;
  payload: Record<string, unknown> | null;
}

export type DealFilter = "all" | "i_owe" | "owed_to_me" | "overdue" | "pending" | "closed";

const PAGE_SIZE = 30;

/**
 * Списки только постранично: при 500 000 пользователей выборка «все мои сделки»
 * на активном профиле — это тысячи строк (см. docs/02-masshtabirovanie.md).
 */
export async function listDeals(
  profileId: string,
  filter: DealFilter,
  page = 0,
): Promise<Deal[]> {
  let query = db()
    .from("deals_view")
    .select("*")
    .or(`initiator_profile_id.eq.${profileId},partner_profile_id.eq.${profileId}`)
    .neq("status", "draft")
    .order("due_date", { ascending: true })
    .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

  switch (filter) {
    case "i_owe":
      query = query.eq("debtor_profile_id", profileId).in("status", ["accepted", "negotiation", "frozen"]);
      break;
    case "owed_to_me":
      query = query.eq("creditor_profile_id", profileId).in("status", ["accepted", "negotiation", "frozen"]);
      break;
    case "overdue":
      query = query.eq("is_overdue", true);
      break;
    case "pending":
      query = query.eq("status", "pending");
      break;
    case "closed":
      query = query.in("status", ["completed", "cancelled"]);
      break;
    case "all":
      query = query.not("status", "in", "(completed,cancelled)");
      break;
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as Deal[];
}

export async function getDeal(dealId: string): Promise<Deal | null> {
  const { data, error } = await db().from("deals_view").select("*").eq("id", dealId).maybeSingle();
  if (error) throw new Error(error.message);
  return data as Deal | null;
}

export async function getPayments(dealId: string): Promise<Payment[]> {
  const { data, error } = await db()
    .from("payments").select("*").eq("deal_id", dealId)
    .order("claimed_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as Payment[];
}

/** FR-034: история статусов в карточке сделки. */
export async function getHistory(dealId: string): Promise<AuditEntry[]> {
  const { data, error } = await db()
    .from("audit_log").select("id,action,created_at,actor_profile_id,payload")
    .eq("deal_id", dealId).order("created_at", { ascending: true }).limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []) as AuditEntry[];
}

export async function getProfileNames(ids: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return {};
  const { data, error } = await db().from("profiles").select("id,name").in("id", unique);
  if (error) throw new Error(error.message);
  return Object.fromEntries((data ?? []).map((p) => [p.id as string, p.name as string]));
}

export interface CalendarMonth {
  days: Array<{
    date: string;
    i_owe_minor: number;
    owed_to_me_minor: number;
    count: number;
    has_overdue: boolean;
    all_paid: boolean;
  }>;
  total_i_owe_minor: number;
  total_owed_to_me_minor: number;
}

export function calendarMonth(profileId: string, month: string): Promise<CalendarMonth> {
  return callRpc<CalendarMonth>("rpc_calendar_month", {
    p_profile_id: profileId,
    p_month: month,
  });
}

// --- Действия ---------------------------------------------------------------

export function createDeal(args: {
  profileId: string;
  amountMinor: number;
  dueDate: string;
  debtorSide: "initiator" | "partner";
  description?: string | null;
  partnerProfileId?: string | null;
}): Promise<{ deal_id: string; invite_token: string | null }> {
  return callRpc("rpc_create_deal", {
    p_profile_id: args.profileId,
    p_amount_minor: args.amountMinor,
    p_due_date: args.dueDate,
    p_debtor_side: args.debtorSide,
    p_description: args.description ?? null,
    p_partner_profile_id: args.partnerProfileId ?? null,
  });
}

export const acceptDeal = (dealId: string, profileId: string) =>
  callRpc("rpc_accept_deal", { p_deal_id: dealId, p_profile_id: profileId });

export const declineDeal = (dealId: string, reason?: string) =>
  callRpc("rpc_decline_deal", { p_deal_id: dealId, p_reason: reason ?? null });

export const claimPayment = (dealId: string, amountMinor: number, method?: string) =>
  callRpc("rpc_claim_payment", {
    p_deal_id: dealId, p_amount_minor: amountMinor, p_method: method ?? null,
  });

export const resolvePayment = (paymentId: string, confirm: boolean, reason?: string) =>
  callRpc("rpc_resolve_payment", {
    p_payment_id: paymentId, p_confirm: confirm, p_reason: reason ?? null,
  });

export const proposeChanges = (
  dealId: string, amountMinor: number | null, dueDate: string | null, comment?: string,
) =>
  callRpc("rpc_propose_changes", {
    p_deal_id: dealId, p_amount_minor: amountMinor, p_due_date: dueDate,
    p_comment: comment ?? null,
  });

export const respondProposal = (dealId: string, accept: boolean) =>
  callRpc("rpc_respond_proposal", { p_deal_id: dealId, p_accept: accept });

export const proposeCancel = (dealId: string, reason?: string) =>
  callRpc("rpc_propose_cancel", { p_deal_id: dealId, p_reason: reason ?? null });

export const proposeSplit = (dealId: string, newDueDate: string) =>
  callRpc<string>("rpc_propose_split", { p_deal_id: dealId, p_new_due_date: newDueDate });

export const dealInviteToken = (dealId: string) =>
  callRpc<string | null>("deal_invite_token", { p_deal_id: dealId });

export const acceptTos = () => callRpc("rpc_accept_tos");
