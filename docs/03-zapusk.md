# Запуск: пошагово

Документ доводит проект от исходников до работающего сервиса. Всё, что здесь есть,
укладывается в бесплатные тарифы. По ходу ничего запоминать не нужно — в конце есть
скрипт, который проверит, что поднялось.

Ориентир по времени: полтора-два часа с первого раза.

---

## Что понадобится

| Что | Где | Стоимость |
|---|---|---|
| Бот в Telegram | [@BotFather](https://t.me/BotFather) | 0 ₽ |
| Проект Supabase | [supabase.com](https://supabase.com) | 0 ₽ |
| Хостинг Mini App | [Cloudflare Pages](https://pages.cloudflare.com) | 0 ₽ |
| Репозиторий | GitHub | 0 ₽ |

---

## Шаг 1. Бот

1. Напишите @BotFather команду `/newbot`, укажите имя «Уговор» и адрес `ugovor_pro_bot`.
2. Сохраните токен — он больше нигде не покажется.
3. `/setinline` → выберите бота → подсказка «45000 за молоко, оплата 15 августа».
   **Без этого шага запись из чата создать нельзя.**
4. `/setinlinefeedback` → `Enabled`. Иначе бот не узнает, что карточку отправили,
   и не подставит в неё кнопку подтверждения.
5. `/setcommands` → вставьте:
   ```
   start - Начать работу
   help - Как пользоваться
   terms - Соглашение и политика
   ```
6. Придумайте случайную строку для `TELEGRAM_WEBHOOK_SECRET` — ею подписываются
   запросы Telegram к нашему серверу:
   ```bash
   openssl rand -hex 32
   ```

## Шаг 2. Supabase

1. Создайте проект. Регион — **Frankfurt**: ближайший к России из доступных.
   Если выберете другой, поправьте раздел 5 в `web/public/privacy.html`.
2. **Settings → API**: сохраните `Project URL`, `anon key`, `service_role key`
   и `JWT Secret`.
3. **Settings → API → Exposed schemas**: добавьте `app` к списку. Без этого шага
   приложение не увидит ни одной таблицы.
4. **Database → Extensions**: включите `pg_cron` и `pg_net`.
5. Накатите миграции:
   ```bash
   npx supabase link --project-ref <ваш-ref>
   npx supabase db push
   ```
6. В **SQL Editor** пропишите настройки планировщика:
   ```sql
   insert into app.settings (key, value) values
     ('outbox_worker_url', 'https://<ref>.supabase.co/functions/v1/outbox-worker'),
     ('service_role_key',  '<service_role_key>')
   on conflict (key) do update set value = excluded.value;
   ```

## Шаг 3. Edge Functions

**Settings → Edge Functions → Secrets** — добавьте пять значений:

| Переменная | Что положить |
|---|---|
| `TELEGRAM_BOT_TOKEN` | токен из шага 1 |
| `TELEGRAM_BOT_USERNAME` | `ugovor_pro_bot`, без `@` |
| `TELEGRAM_WEBHOOK_SECRET` | строка из шага 1 |
| `SUPABASE_JWT_SECRET` | JWT Secret из шага 2 |
| `MINI_APP_URL` | адрес из шага 4 — можно вписать позже |

Затем:

```bash
npx supabase functions deploy auth --no-verify-jwt
npx supabase functions deploy telegram-webhook --no-verify-jwt
npx supabase functions deploy outbox-worker --no-verify-jwt
npx supabase functions deploy report --no-verify-jwt
npx supabase functions deploy attachment --no-verify-jwt
```

Флаг `--no-verify-jwt` нужен потому, что ни Telegram, ни Mini App не присылают
Supabase-токен: подпись они проверяют по-своему, внутри самих функций.

## Шаг 4. Mini App

Cloudflare Pages → Create → Connect to Git → выберите репозиторий:

- корневой каталог: `web`
- команда сборки: `npm run build`
- каталог сборки: `dist`

Переменные окружения:

| Переменная | Значение |
|---|---|
| `VITE_SUPABASE_URL` | Project URL из шага 2 |
| `VITE_SUPABASE_ANON_KEY` | anon key из шага 2 |
| `VITE_BOT_USERNAME` | `ugovor_pro_bot` |

`anon key` не секретный: доступ к данным ограничивает RLS, а не знание ключа.

После сборки вернитесь в секреты Supabase и впишите `MINI_APP_URL`, затем у @BotFather
`/setmenubutton` → тот же адрес.

## Шаг 5. Вебхук

```bash
curl -X POST "https://api.telegram.org/bot<ТОКЕН>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<ref>.supabase.co/functions/v1/telegram-webhook",
    "secret_token": "<TELEGRAM_WEBHOOK_SECRET>",
    "allowed_updates": ["message","inline_query","chosen_inline_result","callback_query","my_chat_member"]
  }'
```

## Шаг 6. Резервные копии

На бесплатном тарифе Supabase нет восстановления на точку во времени, поэтому копии
делаем сами. Готовый сценарий уже лежит в `.github/workflows/backup.yml` и запускается
каждую ночь. Добавьте два секрета в **Settings → Secrets and variables → Actions**:

| Секрет | Где взять |
|---|---|
| `SUPABASE_DB_URL` | Supabase → Settings → Database → Connection string (URI) |
| `BACKUP_PASSPHRASE` | придумайте длинную фразу и **сохраните отдельно** |

Дамп шифруется до выгрузки: внутри данные пользователей. Без парольной фразы копия
не восстанавливается — потеряете её, потеряете и бэкапы.

Копия кладётся в артефакты GitHub на 30 дней. Если добавите `S3_ENDPOINT`,
`S3_BUCKET`, `S3_ACCESS_KEY` и `S3_SECRET_KEY`, она уедет ещё и в объектное
хранилище (Cloudflare R2 и Backblaze B2 дают около 10 ГБ бесплатно) — это надёжнее,
потому что артефакты живут ограниченное время.

Проверьте вручную: вкладка Actions → «Резервная копия базы» → Run workflow.

## Шаг 7. Проверка

```bash
export SUPABASE_URL=https://<ref>.supabase.co
export SUPABASE_ANON_KEY=<anon-key>
export TELEGRAM_BOT_TOKEN=<токен>
export MINI_APP_URL=https://<ваш-адрес>.pages.dev
export SUPABASE_DB_URL=<строка подключения>   # необязательно

scripts/check-deploy.sh
```

Скрипт проверит бота, инлайн-режим, вебхук и очередь обновлений, все пять функций,
доступность схемы `app`, отсутствие утечки данных без авторизации, задачи планировщика
и открытие страниц Mini App. Ничего не меняет, только читает.

## Шаг 8. Живая проверка руками

1. Откройте бота, нажмите `/start` — должна прийти справка и кнопка «Мои записи».
2. Напишите боту `45000 за молоко, оплата 20 сентября` — придёт карточка на проверку.
3. Нажмите «Создать», отправьте ссылку со **второго аккаунта** и подтвердите оттуда.
4. С первого аккаунта отметьте оплату, со второго подтвердите — запись закроется.
5. Пришлите боту фотографию — он предложит прикрепить её к записи.
6. В приложении откройте «Профиль» → «Отчёты» → «Отчёт текстом».

Два аккаунта нужны обязательно: контрагентом становится тот, кто нажал «Подтвердить»,
и на себе самом это не проверить.

---

## Если что-то не работает

| Симптом | Причина |
|---|---|
| Приложение пишет «Не удалось войти» | не совпадает `SUPABASE_JWT_SECRET` или не задан `TELEGRAM_BOT_TOKEN` в секретах функций |
| В приложении пусто, в консоли 404 на `deals_view` | схема `app` не добавлена в Exposed schemas |
| Бот молчит на сообщения | вебхук не подключён или не совпадает `TELEGRAM_WEBHOOK_SECRET`; посмотрите `getWebhookInfo` |
| Инлайн-режим не предлагает карточку | не включён `/setinline` |
| Карточка отправилась, но кнопки «Подтвердить» нет | не включён `/setinlinefeedback` |
| Уведомления не приходят | не заполнена `app.settings` либо не задеплоен `outbox-worker` |
| Записи не появляются в календаре | проверьте, что выбран тот же профиль |

## После запуска: за чем следить

Раз в неделю в Supabase:

- **Database → Database size** — приближение к 400 МБ означает, что пора на платный тариф;
- **Reports → Realtime** — пик соединений у отметки 200 означает то же самое;
- `select count(*) from app.outbox where sent_at is null;` — если число растёт,
  рассыльщик не справляется или упал.

Подробнее — в `02-masshtabirovanie.md`.
