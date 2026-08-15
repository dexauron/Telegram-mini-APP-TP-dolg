/**
 * Вебхук бота: инлайн-режим, deep link, кнопки под карточками.
 *
 * Ключевое ограничение Telegram (Р-11): при инлайн-запросе бот не знает, кому
 * отправлено сообщение. Поэтому контрагентом становится тот, кто нажал
 * «Подтвердить», а право нажать подтверждается токеном приглашения — иначе
 * карточку мог бы перехватить любой, кто узнал её идентификатор.
 */
import { createBotApi } from "../_shared/telegram.ts";
import { signUserToken } from "../_shared/jwt.ts";
import { rpc, todayMsk, json, DbError } from "../_shared/db.ts";
import { parseDealText } from "../_shared/parse.ts";
import { dealCardText, formatMoney, formatDate, escapeHtml } from "../_shared/format.ts";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const BOT_USERNAME = Deno.env.get("TELEGRAM_BOT_USERNAME") ?? "";
const JWT_SECRET = Deno.env.get("SUPABASE_JWT_SECRET")!;
const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET")!;
const MINI_APP_URL = Deno.env.get("MINI_APP_URL") ?? "";

const bot = createBotApi(BOT_TOKEN);

// ---------------------------------------------------------------------------
// Пользователь и его токен
// ---------------------------------------------------------------------------

interface TgUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

interface Session {
  userId: string;
  token: string;
  profileId: string;
  profileName: string;
  profileCount: number;
}

/** Заводит пользователя при первом обращении и выдаёт токен для вызовов RPC. */
async function session(from: TgUser): Promise<Session> {
  const result = await rpc<{
    user: { id: string; telegram_id: number };
    profiles: Array<{ id: string; name: string; is_default: boolean }>;
  }>("upsert_telegram_user", {
    p_telegram_id: from.id,
    p_username: from.username ?? null,
    p_first_name: from.first_name ?? null,
    p_last_name: from.last_name ?? null,
    p_language_code: from.language_code ?? null,
  });

  const profile = result.profiles.find((p) => p.is_default) ?? result.profiles[0];
  const token = await signUserToken({
    sub: result.user.id,
    telegram_id: result.user.telegram_id,
    profile_ids: result.profiles.map((p) => p.id),
  }, JWT_SECRET, 5 * 60);

  return {
    userId: result.user.id,
    token,
    profileId: profile.id,
    profileName: profile.name,
    profileCount: result.profiles.length,
  };
}

// ---------------------------------------------------------------------------
// Тексты
// ---------------------------------------------------------------------------

const LEGAL_LINKS = MINI_APP_URL
  ? `\n\n<a href="${MINI_APP_URL.replace(/\/$/, "")}/terms.html">Пользовательское соглашение</a> · ` +
    `<a href="${MINI_APP_URL.replace(/\/$/, "")}/privacy.html">Политика конфиденциальности</a>`
  : "";

const HELP = [
  "<b>Уговор</b> помогает зафиксировать договорённость об оплате так, чтобы обе стороны видели одно и то же.",
  "",
  "<b>Как записать долг</b>",
  "Напишите мне сумму, срок и за что — обычным текстом:",
  "<code>45000 за молоко, оплата 15 августа</code>",
  "",
  "<b>Как отправить контрагенту</b>",
  BOT_USERNAME
    ? `Наберите в любом чате <code>@${BOT_USERNAME} 45000 15 августа</code> — собеседник увидит карточку с кнопкой «Подтвердить».`
    : "Наберите упоминание бота в любом чате — собеседник увидит карточку с кнопкой «Подтвердить».",
  "",
  "Запись становится действующей только после подтверждения второй стороной. " +
  "Изменить условия в одностороннем порядке нельзя.",
].join("\n") + LEGAL_LINKS;

function miniAppButton() {
  return MINI_APP_URL
    ? { inline_keyboard: [[{ text: "📋 Мои записи", web_app: { url: MINI_APP_URL } }]] }
    : undefined;
}

function previewKeyboard(dealId: string, debtorSide: string, profile?: {
  name: string;
  count: number;
}) {
  const rows = [
    [
      { text: "✓ Создать", callback_data: `s:${dealId}` },
      { text: "✕ Отменить", callback_data: `x:${dealId}` },
    ],
    [{
      text: debtorSide === "partner" ? "🔄 Сейчас: мне должны" : "🔄 Сейчас: я должен",
      callback_data: `t:${dealId}`,
    }],
  ];

  // FR-011: профиль спрашиваем только у тех, у кого их несколько. Кнопка
  // переключает по кругу — два идентификатора в callback_data не помещаются.
  if (profile && profile.count > 1) {
    rows.push([{ text: `👤 От имени: ${profile.name}`, callback_data: `cp:${dealId}` }]);
  }
  return { inline_keyboard: rows };
}

/** Ссылка-приглашение для WhatsApp и прочих внешних каналов (ТЗ-2 III.1). */
function inviteLink(token: string): string {
  return `https://t.me/${BOT_USERNAME}?start=${token}`;
}

// ---------------------------------------------------------------------------
// Обработчики
// ---------------------------------------------------------------------------

async function handleStart(from: TgUser, chatId: number, payload: string) {
  const s = await session(from);

  if (!payload) {
    await bot("sendMessage", {
      chat_id: chatId,
      text: HELP,
      parse_mode: "HTML",
      reply_markup: miniAppButton(),
    });
    return;
  }

  // Переход по ссылке-приглашению: показываем карточку на подтверждение.
  const preview = await rpc<null | {
    deal_id: string;
    amount_minor: number;
    due_date: string;
    description: string | null;
    status: string;
    inviter: { name: string; telegram_id: number };
  }>("invite_preview", { p_token: payload });

  if (!preview) {
    await bot("sendMessage", {
      chat_id: chatId,
      text: "Ссылка недействительна или истекла. Попросите контрагента прислать новую.",
      reply_markup: miniAppButton(),
    });
    return;
  }

  if (preview.inviter.telegram_id === from.id) {
    await bot("sendMessage", {
      chat_id: chatId,
      text: "Это ваша собственная запись — её должен подтвердить контрагент.",
    });
    return;
  }

  await bot("sendMessage", {
    chat_id: chatId,
    text: `📝 <b>${escapeHtml(preview.inviter.name)} предлагает зафиксировать договорённость</b>\n\n` +
      dealCardText({
        amount_minor: preview.amount_minor,
        due_date: preview.due_date,
        description: preview.description,
      }, todayMsk()),
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[
        { text: "✓ Подтвердить", callback_data: `at:${payload}` },
        { text: "✕ Отклонить", callback_data: `dt:${payload}` },
      ]],
    },
  });
}

async function handleText(from: TgUser, chatId: number, text: string) {
  const today = todayMsk();
  const parsed = parseDealText(text, today);

  if (!parsed.matched.amount) {
    await bot("sendMessage", {
      chat_id: chatId,
      text: "Не понял сумму. Напишите, например: <code>45000 за молоко, оплата 15 августа</code>",
      parse_mode: "HTML",
    });
    return;
  }

  const s = await session(from);
  // Черновик создаётся сразу: так кнопки под карточкой обходятся коротким
  // идентификатором, а не тащат все данные в callback_data (лимит 64 байта).
  const created = await rpc<{ deal_id: string; invite_token: string | null }>(
    "rpc_create_deal",
    {
      p_profile_id: s.profileId,
      p_amount_minor: parsed.amountMinor,
      p_due_date: parsed.dueDate ?? today,
      p_debtor_side: "partner",
      p_description: parsed.description || null,
      p_as_draft: true,
    },
    s.token,
  );

  const warning = parsed.matched.date
    ? ""
    : "\n\n⚠️ Срок не распознан, поставил сегодня — измените в приложении, если нужно.";

  await bot("sendMessage", {
    chat_id: chatId,
    text: "<b>Проверьте запись</b>\n\n" +
      dealCardText({
        amount_minor: parsed.amountMinor!,
        due_date: parsed.dueDate ?? today,
        description: parsed.description,
      }, today) + warning,
    parse_mode: "HTML",
    reply_markup: previewKeyboard(created.deal_id, "partner",
      { name: s.profileName, count: s.profileCount }),
  });
}

/**
 * Файл приходит боту отдельным сообщением, а уже потом человек выбирает запись.
 * Иначе никак: Telegram не даёт мини-приложению отправить файл в чат, а в
 * callback-кнопку идентификатор файла не помещается (Р-8).
 */
async function handleAttachment(
  from: TgUser,
  chatId: number,
  file: {
    kind: string;
    file_id: string;
    file_unique_id?: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  },
  caption: string | undefined,
) {
  const s = await session(from);

  await rpc("save_pending_upload", {
    p_user_id: s.userId,
    p_kind: file.kind,
    p_tg_file_id: file.file_id,
    p_tg_file_unique_id: file.file_unique_id ?? null,
    p_file_name: file.file_name ?? null,
    p_mime_type: file.mime_type ?? null,
    p_size_bytes: file.file_size ?? null,
    p_caption: caption ?? null,
  });

  const deals = await rpc<Array<{
    deal_id: string; amount_minor: number; due_date: string; counterparty: string;
  }>>("recent_open_deals", { p_limit: 5 }, s.token);

  if (!deals.length) {
    await bot("sendMessage", {
      chat_id: chatId,
      text: "Файл получил, но открытых записей нет. Создайте запись — и пришлите файл ещё раз.",
    });
    return;
  }

  await bot("sendMessage", {
    chat_id: chatId,
    text: "Файл получил. К какой записи прикрепить?",
    reply_markup: {
      inline_keyboard: deals.map((d) => [{
        text: `${formatMoney(d.amount_minor)} · ${d.counterparty}`,
        callback_data: `pf:${d.deal_id}`,
      }]),
    },
  });
}

async function handleInlineQuery(from: TgUser, queryId: string, query: string) {
  const today = todayMsk();
  const trimmed = query.trim();

  // Карточка уже созданной записи: пересылаем её в чат, ничего не создавая.
  if (trimmed.startsWith("#")) {
    const token = trimmed.slice(1);
    const preview = await rpc<null | {
      amount_minor: number; due_date: string; description: string | null;
    }>("invite_preview", { p_token: token });

    if (preview) {
      await bot("answerInlineQuery", {
        inline_query_id: queryId,
        cache_time: 0,
        is_personal: true,
        results: [{
          type: "article",
          id: "share",
          title: `Отправить запись на ${formatMoney(preview.amount_minor)}`,
          description: `Срок: ${formatDate(preview.due_date, today)}`,
          input_message_content: {
            message_text: "📝 <b>Предложение зафиксировать договорённость</b>\n\n" +
              dealCardText(preview, today),
            parse_mode: "HTML",
          },
          reply_markup: {
            inline_keyboard: [[
              { text: "✓ Подтвердить", callback_data: `at:${token}` },
              { text: "✕ Отклонить", callback_data: `dt:${token}` },
            ]],
          },
        }],
      });
      return;
    }
  }

  const parsed = parseDealText(trimmed, today);
  if (!parsed.matched.amount) {
    await bot("answerInlineQuery", {
      inline_query_id: queryId,
      cache_time: 0,
      is_personal: true,
      results: [],
      button: { text: "Укажите сумму, например: 45000 15 августа", start_parameter: "help" },
    });
    return;
  }

  const dueDate = parsed.dueDate ?? today;
  // Сама запись здесь не создаётся: пользователь ещё печатает, и на каждое
  // нажатие клавиши плодить сделки нельзя. Создаём в chosen_inline_result.
  await bot("answerInlineQuery", {
    inline_query_id: queryId,
    cache_time: 0,
    is_personal: true,
    results: [{
      type: "article",
      id: `new:${parsed.amountMinor}:${dueDate}`,
      title: `Записать ${formatMoney(parsed.amountMinor!)}`,
      description: `Срок: ${formatDate(dueDate, today)}` +
        (parsed.description ? ` · ${parsed.description}` : ""),
      input_message_content: {
        message_text: "📝 <b>Предложение зафиксировать договорённость</b>\n\n" +
          dealCardText({
            amount_minor: parsed.amountMinor!,
            due_date: dueDate,
            description: parsed.description,
          }, today),
        parse_mode: "HTML",
      },
      // Клавиатура-заглушка нужна, чтобы Telegram прислал inline_message_id:
      // без неё отредактировать отправленную карточку невозможно.
      reply_markup: { inline_keyboard: [[{ text: "⏳ Секунду…", callback_data: "noop" }]] },
    }],
  });
}

async function handleChosenInlineResult(
  from: TgUser,
  resultId: string,
  inlineMessageId: string | undefined,
  query: string,
) {
  if (!resultId.startsWith("new:") || !inlineMessageId) return;

  const today = todayMsk();
  const parsed = parseDealText(query, today);
  if (!parsed.matched.amount) return;

  const s = await session(from);
  const created = await rpc<{ deal_id: string; invite_token: string }>(
    "rpc_create_deal",
    {
      p_profile_id: s.profileId,
      p_amount_minor: parsed.amountMinor,
      p_due_date: parsed.dueDate ?? today,
      p_debtor_side: "partner",
      p_description: parsed.description || null,
    },
    s.token,
  );

  // Заменяем заглушку на рабочую кнопку с токеном.
  await bot("editMessageReplyMarkup", {
    inline_message_id: inlineMessageId,
    reply_markup: {
      inline_keyboard: [[
        { text: "✓ Подтвердить", callback_data: `at:${created.invite_token}` },
        { text: "✕ Отклонить", callback_data: `dt:${created.invite_token}` },
      ]],
    },
  });
}

async function handleCallback(
  from: TgUser,
  id: string,
  data: string,
  chatId: number | undefined,
  messageId: number | undefined,
  inlineMessageId: string | undefined,
) {
  const answer = (text: string, alert = false) =>
    bot("answerCallbackQuery", { callback_query_id: id, text, show_alert: alert });

  const replaceMarkup = (text: string) =>
    inlineMessageId
      ? bot("editMessageText", {
        inline_message_id: inlineMessageId,
        text,
        parse_mode: "HTML",
      })
      : chatId && messageId
      ? bot("editMessageText", { chat_id: chatId, message_id: messageId, text, parse_mode: "HTML" })
      : Promise.resolve(undefined);

  if (data === "noop") {
    await answer("Запись ещё готовится, повторите через секунду");
    return;
  }

  const [action, argument] = [data.slice(0, data.indexOf(":")), data.slice(data.indexOf(":") + 1)];
  const s = await session(from);

  try {
    switch (action) {
      case "s": {   // отправить черновик контрагенту
        await rpc("rpc_send_deal", { p_deal_id: argument }, s.token);
        const token = await rpc<string | null>("deal_invite_token", { p_deal_id: argument }, s.token);
        await answer("Запись создана");
        await replaceMarkup(
          "✅ <b>Запись создана и ждёт подтверждения</b>\n\n" +
          (token
            ? `Перешлите ссылку контрагенту:\n${inviteLink(token)}`
            : "Контрагент получит уведомление в боте."),
        );
        return;
      }

      case "x":     // отменить черновик
        await rpc("rpc_decline_deal", { p_deal_id: argument }, s.token);
        await answer("Черновик удалён");
        await replaceMarkup("⚫️ Черновик отменён");
        return;

      case "t": {   // переключить, кто кому должен
        const side = await rpc<string>("rpc_toggle_draft_side", { p_deal_id: argument }, s.token);
        await answer(side === "partner" ? "Теперь: мне должны" : "Теперь: я должен");
        await bot("editMessageReplyMarkup", {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: previewKeyboard(argument, side),
        });
        return;
      }

      case "pf": {  // прикрепить присланный файл к выбранной записи
        const attached = await rpc<{ kind: string; file_name: string | null }>(
          "rpc_attach_pending", { p_deal_id: argument }, s.token,
        );
        await answer("Файл прикреплён");
        await replaceMarkup(
          `📎 <b>Файл прикреплён к записи</b>\n\n${
            attached.file_name ? escapeHtml(attached.file_name) : "Вложение"
          } теперь видно обеим сторонам.`,
        );
        return;
      }

      case "cp": {  // выбрать, от имени какого профиля создаётся запись
        const next = await rpc<{ id: string; name: string }>(
          "rpc_cycle_draft_profile", { p_deal_id: argument }, s.token,
        );
        await answer(`От имени: ${next.name}`);
        await bot("editMessageReplyMarkup", {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: previewKeyboard(argument, "partner",
            { name: next.name, count: s.profileCount }),
        });
        return;
      }

      case "at": {  // подтвердить открытую карточку по токену приглашения
        const preview = await rpc<null | { deal_id: string }>("invite_preview", {
          p_token: argument,
        });
        if (!preview) {
          await answer("Ссылка недействительна или запись уже подтверждена", true);
          return;
        }
        await rpc("rpc_accept_deal", {
          p_deal_id: preview.deal_id,
          p_profile_id: s.profileId,
          p_invite_token: argument,
        }, s.token);
        await answer("Подтверждено");
        await replaceMarkup("✅ <b>Договорённость зафиксирована</b>\n\nОбе стороны видят одну запись.");
        return;
      }

      case "dt": {  // отклонить открытую карточку
        const preview = await rpc<null | { deal_id: string }>("invite_preview", {
          p_token: argument,
        });
        if (!preview) {
          await answer("Ссылка недействительна", true);
          return;
        }
        await rpc("rpc_decline_deal", { p_deal_id: preview.deal_id }, s.token);
        await answer("Отклонено");
        await replaceMarkup("✕ <b>Предложение отклонено</b>");
        return;
      }

      case "a":     // подтвердить адресную запись
        await rpc("rpc_accept_deal", {
          p_deal_id: argument,
          p_profile_id: s.profileId,
        }, s.token);
        await answer("Подтверждено");
        await replaceMarkup("✅ <b>Договорённость зафиксирована</b>");
        return;

      case "d":
        await rpc("rpc_decline_deal", { p_deal_id: argument }, s.token);
        await answer("Отклонено");
        await replaceMarkup("✕ <b>Запись отклонена</b>");
        return;

      case "pa":    // принять предложение об изменении или об аннулировании
        await rpc("rpc_respond_proposal", { p_deal_id: argument, p_accept: true }, s.token);
        await answer("Принято");
        await replaceMarkup("✅ <b>Новые условия приняты</b>");
        return;

      case "pd":
        await rpc("rpc_respond_proposal", { p_deal_id: argument, p_accept: false }, s.token);
        await answer("Отклонено");
        await replaceMarkup("↩️ <b>Предложение отклонено</b>\nУсловия остались прежними.");
        return;

      case "pc":    // подтвердить платёж
        await rpc("rpc_resolve_payment", { p_payment_id: argument, p_confirm: true }, s.token);
        await answer("Оплата подтверждена");
        await replaceMarkup("✅ <b>Оплата подтверждена</b>");
        return;

      case "pr":
        await rpc("rpc_resolve_payment", { p_payment_id: argument, p_confirm: false }, s.token);
        await answer("Отмечено, что платёж не получен");
        await replaceMarkup("⚠️ <b>Платёж не подтверждён</b>");
        return;

      default:
        await answer("Неизвестная команда");
    }
  } catch (error) {
    // Ошибки бизнес-правил написаны по-русски и понятны человеку — показываем их.
    if (error instanceof DbError && error.isUserFacing) {
      await answer(error.message, true);
      return;
    }
    console.error("callback failed", data, error);
    await answer("Не получилось. Попробуйте ещё раз", true);
  }
}

// ---------------------------------------------------------------------------
// Точка входа
// ---------------------------------------------------------------------------

Deno.serve(async (req) => {
  // Telegram присылает этот заголовок, если вебхук установлен с secret_token.
  // Без проверки кто угодно мог бы слать боту поддельные обновления.
  if (req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== WEBHOOK_SECRET) {
    return json({ error: "forbidden" }, 403);
  }

  let update: Record<string, any>;
  try {
    update = await req.json();
  } catch {
    return json({ ok: true });
  }

  try {
    if (update.message?.text) {
      const { from, chat, text } = update.message;
      if (chat.type !== "private") return json({ ok: true });

      const start = text.match(/^\/start(?:\s+(\S+))?/);
      if (start) {
        await handleStart(from, chat.id, start[1] ?? "");
      } else if (text.startsWith("/help") || text.startsWith("/terms")) {
        await bot("sendMessage", {
          chat_id: chat.id, text: HELP, parse_mode: "HTML", reply_markup: miniAppButton(),
        });
      } else if (!text.startsWith("/")) {
        await handleText(from, chat.id, text);
      }
    } else if (update.message && (update.message.photo || update.message.document ||
               update.message.video || update.message.voice || update.message.audio)) {
      const m = update.message;
      if (m.chat.type !== "private") return json({ ok: true });

      // У фотографии Telegram присылает несколько размеров — берём самый крупный.
      const file = m.photo
        ? { kind: "photo", ...m.photo[m.photo.length - 1] }
        : m.document ? { kind: "document", ...m.document }
        : m.video ? { kind: "video", ...m.video }
        : m.voice ? { kind: "voice", ...m.voice }
        : { kind: "audio", ...m.audio };

      await handleAttachment(m.from, m.chat.id, file, m.caption);
    } else if (update.inline_query) {
      const { from, id, query } = update.inline_query;
      await handleInlineQuery(from, id, query);
    } else if (update.chosen_inline_result) {
      const { from, result_id, inline_message_id, query } = update.chosen_inline_result;
      await handleChosenInlineResult(from, result_id, inline_message_id, query);
    } else if (update.callback_query) {
      const cq = update.callback_query;
      await handleCallback(
        cq.from,
        cq.id,
        cq.data ?? "",
        cq.message?.chat?.id,
        cq.message?.message_id,
        cq.inline_message_id,
      );
    } else if (update.my_chat_member?.new_chat_member?.status === "kicked") {
      // Пользователь заблокировал бота — помечаем, чтобы не жечь лимиты рассылкой.
      await rpc("mark_bot_blocked", { p_telegram_id: update.my_chat_member.from.id });
    }
  } catch (error) {
    // Telegram повторяет доставку при ошибке, поэтому всегда отвечаем 200:
    // иначе одно сломанное обновление будет возвращаться бесконечно.
    console.error("update failed", error);
  }

  return json({ ok: true });
});
