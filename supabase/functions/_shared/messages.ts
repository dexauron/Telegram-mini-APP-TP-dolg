/**
 * Тексты уведомлений и кнопки к ним.
 *
 * Формулировки нейтрально-деловые: религиозных напоминаний и морализаторства
 * быть не должно (FR-060, NFR-028).
 */
import { dealCardText, formatMoney, formatDate, plural, escapeHtml } from "./format.ts";

export interface OutboxItem {
  id: number;
  kind: string;
  telegram_id: number;
  payload: Record<string, unknown>;
  deal?: {
    amount_minor: number;
    paid_minor: number;
    due_date: string;
    description: string | null;
    status: string;
    counterparty: string | null;
  } | null;
}

export interface RenderedMessage {
  text: string;
  keyboard?: { inline_keyboard: Array<Array<Record<string, unknown>>> };
}

const btn = (text: string, data: string) => ({ text, callback_data: data });

export function renderMessage(item: OutboxItem, today: string): RenderedMessage | null {
  const dealId = String(item.payload.deal_id ?? "");
  const card = item.deal ? dealCardText(item.deal, today) : "";

  switch (item.kind) {
    case "deal.pending":
      return {
        text: `📝 <b>Вам предложили зафиксировать договорённость</b>\n\n${card}`,
        keyboard: {
          inline_keyboard: [[
            btn("✓ Подтвердить", `a:${dealId}`),
            btn("✕ Отклонить", `d:${dealId}`),
          ]],
        },
      };

    case "deal.accepted":
      return { text: `✅ <b>Запись подтверждена контрагентом</b>\n\n${card}` };

    case "deal.declined":
      return { text: `✕ <b>Контрагент отклонил запись</b>\n\n${card}` };

    case "deal.proposed": {
      // ТЗ-2 III.2: показываем «было / стало», иначе непонятно, на что соглашаться.
      const was = item.payload.was as { amount_minor?: number; due_date?: string } | undefined;
      const now = item.payload.now as
        { amount_minor?: number; due_date?: string; comment?: string } | undefined;
      const lines = ["🟡 <b>Контрагент предлагает изменить условия</b>", ""];

      if (now?.amount_minor && was?.amount_minor) {
        lines.push(`Сумма: ${formatMoney(was.amount_minor)} → <b>${formatMoney(now.amount_minor)}</b>`);
      }
      if (now?.due_date && was?.due_date) {
        lines.push(`Срок: ${formatDate(was.due_date, today)} → <b>${formatDate(now.due_date, today)}</b>`);
      }
      if (now?.comment) lines.push(`\n${escapeHtml(now.comment)}`);

      return {
        text: lines.join("\n"),
        keyboard: {
          inline_keyboard: [[
            btn("✓ Принять", `pa:${dealId}`),
            btn("✕ Не согласен", `pd:${dealId}`),
          ]],
        },
      };
    }

    case "deal.proposal_accepted":
      return { text: `✅ <b>Контрагент принял новые условия</b>\n\n${card}` };

    case "deal.proposal_rejected":
      return { text: `↩️ <b>Контрагент не принял предложение</b>\nУсловия остались прежними.\n\n${card}` };

    case "deal.cancel_proposed":
      return {
        text: `🚫 <b>Контрагент предлагает аннулировать запись</b>\n\n${card}`,
        keyboard: {
          inline_keyboard: [[
            btn("✓ Согласиться", `pa:${dealId}`),
            btn("✕ Отказать", `pd:${dealId}`),
          ]],
        },
      };

    case "deal.cancelled":
      return { text: `⚫️ <b>Запись аннулирована по согласию сторон</b>\n\n${card}` };

    case "deal.frozen":
      return {
        text: `🧊 <b>Запись заморожена</b>\n\nСрок прошёл, а условия так и не согласованы. ` +
          `Теперь доступно только принять предложенное или договориться об аннулировании.\n\n${card}`,
      };

    case "deal.split_proposed":
      return {
        text: `➗ <b>Предложена запись на остаток</b>\n\n` +
          `Остаток ${formatMoney(Number(item.payload.remaining_minor ?? 0))}, ` +
          `новый срок — ${formatDate(String(item.payload.new_due_date), today)}.`,
        keyboard: {
          inline_keyboard: [[
            btn("✓ Подтвердить", `a:${String(item.payload.child_deal_id ?? "")}`),
            btn("✕ Отклонить", `d:${String(item.payload.child_deal_id ?? "")}`),
          ]],
        },
      };

    case "payment.claimed":
      return {
        text: `💰 <b>Контрагент отметил оплату</b>\n\n` +
          `Сумма: ${formatMoney(Number(item.payload.amount_minor ?? 0))}\n\n` +
          `Подтвердите получение. Если не ответить, через неделю платёж будет ` +
          `засчитан автоматически.`,
        keyboard: {
          inline_keyboard: [[
            btn("✓ Подтвердить", `pc:${String(item.payload.payment_id ?? "")}`),
            btn("✕ Не получал", `pr:${String(item.payload.payment_id ?? "")}`),
          ]],
        },
      };

    case "payment.confirmed":
      return {
        text: `✅ <b>Оплата подтверждена</b>\n\n` +
          `Сумма: ${formatMoney(Number(item.payload.amount_minor ?? 0))}\n\n${card}`,
      };

    case "payment.rejected":
      return {
        text: `⚠️ <b>Контрагент не подтвердил оплату</b>\n\n` +
          `Сумма: ${formatMoney(Number(item.payload.amount_minor ?? 0))}` +
          (item.payload.reason ? `\nПричина: ${escapeHtml(String(item.payload.reason))}` : ""),
      };

    case "deal.completed":
      return { text: `🎉 <b>Запись закрыта</b>\n\n${card}` };

    case "digest.daily": {
      // Р-1 масштабирование: одна сводка вместо письма на каждую сделку.
      const overdue = Number(item.payload.overdue_count ?? 0);
      const soon = Number(item.payload.soon_count ?? 0);
      const lines: string[] = ["📋 <b>Сводка на сегодня</b>", ""];

      if (overdue) {
        lines.push(
          `🟠 Просрочено: ${overdue} ${plural(overdue, ["запись", "записи", "записей"])} ` +
          `на ${formatMoney(Number(item.payload.overdue_minor ?? 0))}`,
        );
      }
      if (soon) {
        lines.push(
          `🔵 Скоро к оплате: ${soon} ${plural(soon, ["запись", "записи", "записей"])} ` +
          `на ${formatMoney(Number(item.payload.soon_minor ?? 0))}`,
        );
      }
      return { text: lines.join("\n") };
    }

    default:
      return null;
  }
}
