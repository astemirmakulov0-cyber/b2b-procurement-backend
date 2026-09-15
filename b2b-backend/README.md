# B2B Procurement Platform — Backend (MVP)

Node.js + Express + PostgreSQL (Prisma ORM) backend implementing the full core flow from the project scope:

Регистрация/верификация → RFQ → Котировки (с Bid Credits) → Сравнение и шортлист → Award → LPO → Принятие поставщиком → Заказ → Доставка → Счёт → Оплата.

## 1. Установка

```bash
npm install
cp .env.example .env
# отредактируйте .env: DATABASE_URL и JWT_SECRET
npx prisma migrate dev --name init
npm run dev
```

Требуется PostgreSQL (локально, Docker или облачный — например, Supabase/Neon/Railway).
Пример для Docker:
```bash
docker run --name b2b-db -e POSTGRES_PASSWORD=password -e POSTGRES_DB=b2b_procurement -p 5432:5432 -d postgres:16
```

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
- `POST /api/invoices/:id/payments` (buyer) — фиксирует платёж, при полной оплате закрывает заказ

**Каталог поставщика**
- `POST/GET/PATCH/DELETE /api/catalog`

**Wallet (Bid Credits)**
- `GET /api/wallet`
- `POST /api/wallet/topup` `{ amount, reference }` — ⚠️ в проде подключить реальный платёжный шлюз перед начислением

## 5. Что не входит в этот MVP-срез (Sprint 4 из сметы)

Chat, уведомления, SLA, Audit Trail — можно добавить следующим этапом как отдельные модули поверх этой структуры (события заказа уже пишутся в БД, поэтому Audit Trail и уведомления подключаются относительно легко).

## 6. Дальше

- Подключить фронтенд к этим эндпоинтам (пришли исходники фронта — состыкую точные контракты/DTO).
- Добавить загрузку файлов (S3/Cloudinary) для документов верификации.
- Подключить реальный платёжный провайдер (Stripe/PayTabs — популярен в Бахрейне) для wallet top-up и оплаты счетов.
