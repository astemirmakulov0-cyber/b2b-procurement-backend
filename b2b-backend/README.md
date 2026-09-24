# B2B Procurement Platform — Backend (MVP)

Node.js + Express + PostgreSQL (Prisma ORM) backend implementing the full core flow from the project scope:

Регистрация/верификация → RFQ → Котировки (с Bid Credits) → Сравнение и шортлист → Award → LPO → Принятие поставщиком → Заказ → Доставка → Счёт → Оплата.

## 1. Установка

```bash
npm install
cp .env.example .env
# отредактируйте .env: DATABASE_URL (ЛОКАЛЬНАЯ база) и JWT_SECRET
npx prisma migrate deploy   # создаёт схему из prisma/migrations
npm run dev
```

`.env` всегда указывает на **локальную** базу. URL продовой базы хранится только в `.env.production` (в git не попадает, см. `.gitignore`) и передаётся явно в одну команду — см. раздел «Миграции».

Локальный PostgreSQL, например через Docker:
```bash
docker run --name b2b-db -e POSTGRES_PASSWORD=password -e POSTGRES_DB=b2b_procurement -p 5432:5432 -d postgres:16
```

## Миграции базы

Схема меняется только через файлы в `prisma/migrations` (baseline `0_init` — схема прода на 2026-09-24). `prisma db push` больше не используется ни локально для прода, ни на Railway (стартовая команда сервиса — `npm start`).

1. Изменить `prisma/schema.prisma`.
2. Создать миграцию на **локальной** базе: `npx prisma migrate dev --create-only --name <что_меняем>`, затем прочитать и при необходимости поправить `migration.sql` (например, Prisma генерирует `DROP COLUMN`/`ADD COLUMN` при смене типа — такое переписывается вручную на безопасный `ALTER`).
3. `npm test` — поднимает временный локальный PostgreSQL, применяет миграции через `migrate deploy`, проверяет, что они дают ровно `schema.prisma`, и прогоняет интеграционные тесты. Прод не трогает.
4. Применить на проде **до** выкатки кода, которому нужна новая схема (URL передаётся только этой команде):
   ```bash
   DATABASE_URL="$(node -e "require('dotenv').config({path:'.env.production'});process.stdout.write(process.env.DATABASE_URL)")" npx prisma migrate deploy
   ```
   Статус: та же команда с `migrate status` вместо `migrate deploy`.
5. Выкатить код.

Никогда не запускайте против прода `prisma migrate dev`, `prisma migrate reset` и `prisma db push`: первые две могут пересоздать базу, третья расходится с историей миграций.

## 2. Структура данных (Prisma models)

`User` → `Company` (BUYER/SUPPLIER) → `CompanyDocument`, `Wallet`
`RFQ` → `Quote` → `LPO` → `Order` → `Delivery`, `Invoice` → `Payment`
`CatalogItem` (каталог поставщика), `WalletTransaction` (bid credits)

Полная схема: `prisma/schema.prisma`.

## 3. Роли и авторизация

JWT в заголовке `Authorization: Bearer <token>`. Роли: `BUYER`, `SUPPLIER`, `ADMIN` (админа создать вручную через Prisma Studio/SQL — публичной регистрации админа нет).

## 4. Основные эндпоинты

**Auth**
- `POST /api/auth/register` `{ email, password, role: BUYER|SUPPLIER, companyName, country }`
- `POST /api/auth/login`
- `GET /api/auth/me`

**Компания и верификация**
- `GET/PATCH /api/companies/me`
- `POST /api/companies/me/documents` — загрузка документа на верификацию
- `GET /api/admin/companies?status=PENDING` (admin)
- `PATCH /api/admin/companies/:id/verify` `{ status, notes }` (admin)

**RFQ**
- `POST /api/rfqs` (buyer)
- `GET /api/rfqs` — buyer видит свои, supplier видит опубликованные
- `GET /api/rfqs/:id`
- `PATCH /api/rfqs/:id`

**Котировки / Bid Credits**
- `POST /api/rfqs/:rfqId/quotes` (supplier, списывает bid credit с wallet)
- `GET /api/rfqs/:rfqId/quotes` (buyer сравнивает офферы)
- `PATCH /api/quotes/:id/shortlist`
- `PATCH /api/quotes/:id/reject`
- `POST /api/quotes/:id/award` — выбор победителя → создаёт LPO

**LPO / Заказы**
- `GET /api/lpos`
- `PATCH /api/lpos/:id/accept` (supplier) — создаёт Order + Delivery + Invoice
- `PATCH /api/lpos/:id/decline`
- `GET /api/orders`, `GET /api/orders/:id`
- `PATCH /api/orders/:id/status` `{ status }`
- `PATCH /api/orders/:id/delivery` `{ status, trackingInfo }` (supplier)

**Счета и оплата**
- `GET /api/invoices`, `GET /api/invoices/:id`
- `POST /api/invoices/:id/payments` (buyer) — отмечает платёж (PENDING); Biddex платежи не проводит
- `PATCH /api/payments/:id/confirm` / `reject` (supplier) — только подтверждённый платёж меняет статус счёта и заказа

**Каталог поставщика**
- `POST/GET/PATCH/DELETE /api/catalog`

**Wallet (Bid Credits)**
- `GET /api/wallet`
- `POST /api/wallet/topup` `{ companyId, amount, reference }` — только ADMIN (ручное начисление до подключения платёжного шлюза)

## 5. Что не входит в этот MVP-срез (Sprint 4 из сметы)

Chat, уведомления, SLA, Audit Trail — можно добавить следующим этапом как отдельные модули поверх этой структуры (события заказа уже пишутся в БД, поэтому Audit Trail и уведомления подключаются относительно легко).

## 6. Дальше

- Подключить фронтенд к этим эндпоинтам (пришли исходники фронта — состыкую точные контракты/DTO).
- Добавить загрузку файлов (S3/Cloudinary) для документов верификации.
- Подключить реальный платёжный провайдер (Stripe/PayTabs — популярен в Бахрейне) для wallet top-up и оплаты счетов.
