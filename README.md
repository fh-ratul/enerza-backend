# Enerza — Load Shedding & Power Outage Management API

Enerza is the backend of a power-distribution utility: it plans load shedding fairly, turns customer "my power is out" reports into tracked outages with technician dispatch, and bills customers with a slab tariff they can pay through bKash.

It is a REST API only (no frontend), built for Programming Hero B7A6, assignment 6.

| | |
|---|---|
| Live API | _to be added after deployment_ |
| Postman documentation | _to be added after publishing_ — the collection is in this repo: [`Enerza.postman_collection.json`](Enerza.postman_collection.json) |
| Demo video | _to be added_ |

## What it does

- **Three roles** — customer, technician, admin — with JWT login, refresh tokens and Google sign-in for customers.
- **Grid** — zones → substations → feeders → areas. Feeders have full CRUD with nested areas, search, filters, soft delete and a Redis-cached public list.
- **Load-shedding schedules** — manual schedules with overlap detection, plus a generator that spreads a power deficit fairly across feeders.
- **Outages** — customer reports are deduplicated into one outage per feeder, explained away when a published schedule is the cause, prioritised, and moved through a state machine with manual or automatic technician assignment.
- **Billing and payment** — slab-tariff bills, bKash tokenized checkout, and a verified, idempotent payment callback.
- **Admin** — dashboard (MTTR, SAIFI, SAIDI, revenue), user management, and an audit log of every critical action.
- **Email notifications** — welcome, bill issued, payment receipt, outage resolved and schedule published, sent over SMTP.
- **Photo uploads** — profile photos and photos attached to outage reports, stored on Cloudinary.

## Tech stack

Express 5 · TypeScript (ESM) · Prisma 7 with the `pg` driver adapter · PostgreSQL · Redis · Zod 4 · JWT + bcryptjs · google-auth-library · bKash tokenized checkout · Nodemailer (Gmail SMTP) · Cloudinary + Multer · helmet · express-rate-limit with a Redis store · Biome · tsup · Vercel.

## Getting started

Requirements: Node.js 22+, a PostgreSQL database, and (optionally) Redis.

```bash
npm install
cp .env.example .env              # then fill it in, see below
npx prisma generate
npx prisma migrate deploy         # creates the tables
npx prisma db seed                # demo grid, users and history (safe to run again)
npm run dev                       # http://localhost:5000
```

Other commands:

```bash
npm test                # unit tests (node:test)
npm run typecheck       # tsc --noEmit
npm run lint:check      # Biome
npm run build           # tsup → dist/server.js
npm start               # run the build
```

### Environment variables

The server validates these at startup and refuses to boot if one is missing or malformed.

| Variable | Notes |
|---|---|
| `NODE_ENV`, `PORT` | `development` / `production`; port defaults to 5000 |
| `DATABASE_URL` | A `postgres://` connection string. The app uses the `pg` driver adapter, so a `prisma+postgres://` Accelerate URL will not work |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | At least 32 characters each |
| `JWT_ACCESS_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN` | Default `1d` and `7d` |
| `BCRYPT_SALT_ROUNDS` | Default 10 |
| `FRONTEND_URL` | The only origin CORS allows |
| `GOOGLE_CLIENT_ID` | OAuth client id used to verify Google ID tokens |
| `ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` | The admin account the seed creates |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_USER`, `REDIS_PASSWORD` | Caching and rate limiting. If Redis is unreachable the API keeps working: reads go to the database and rate limits fall back to memory |
| `BKASH_BASE_URL`, `BKASH_USERNAME`, `BKASH_PASSWORD`, `BKASH_APP_KEY`, `BKASH_APP_SECRET` | bKash tokenized checkout (sandbox) credentials |
| `BKASH_CALLBACK_URL` | This API's public base URL including `/api/v1`, e.g. `http://localhost:5000/api/v1` |
| `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_SENDER` | Gmail account, its app password, and the "from" address for notification emails |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Cloudinary account for photo uploads |

### Demo accounts (created by the seed)

| Role | Email | Password |
|---|---|---|
| Admin | value of `ADMIN_EMAIL` (`admin@enerza.com`) | value of `ADMIN_PASSWORD` |
| Technician, Dhaka North | `tech.north@enerza.com` | `Enerza@12345` |
| Technician, Dhaka South | `tech.south@enerza.com` | `Enerza@12345` |
| Customer, residential, Mirpur-10 | `customer1@enerza.com` | `Enerza@12345` |
| Customer, commercial, Dhanmondi 27 | `customer2@enerza.com` | `Enerza@12345` |

The seed also creates 2 zones, 4 substations, 8 feeders, 14 areas, a week of load-shedding history, one ongoing and one upcoming schedule, 4 resolved outages and 1 open one, and one unpaid bill per customer.

## API

Base path: `/api/v1`. **C** = customer, **T** = technician, **A** = admin.

| # | Method | Path | Who | What |
|---|---|---|---|---|
| 1 | POST | `/auth/register` | Public | Register a customer with area and meter |
| 2 | POST | `/auth/login` | Public | Email and password login |
| 3 | POST | `/auth/google` | Public | Login with a Google ID token |
| 4 | POST | `/auth/refresh-token` | Public | New access and refresh tokens |
| 5 | GET | `/users/me` | C/T/A | Own profile |
| 6 | PATCH | `/users/me` | C/T/A | Update profile and profile photo; technicians go on or off duty |
| 7 | GET | `/users` | A | List users with search, filters, pagination |
| 8 | PATCH | `/users/:id` | A | Block, unblock, or promote to technician |
| 9 | POST | `/feeders` | A | Create a feeder with nested areas |
| 10 | GET | `/feeders` | Public | Search, filter, sort, paginate (cached) |
| 11 | PATCH | `/feeders/:id` | A | Update a feeder, add areas |
| 12 | DELETE | `/feeders/:id` | A | Soft delete, refused while in use |
| 13 | POST | `/schedules` | A | Manual load-shedding or maintenance schedule |
| 14 | POST | `/schedules/generate` | A | Fair load-shedding plan, dry run or saved |
| 15 | GET | `/schedules` | C/A | Admin: all. Customer: their feeder |
| 16 | PATCH | `/schedules/:id/status` | A | Publish or cancel |
| 17 | POST | `/outages` | C/A | Report an outage (optionally with a photo), or log an incident |
| 18 | GET | `/outages` | C/T/A | Role-aware list with timeline |
| 19 | PATCH | `/outages/:id/status` | T/A | Assign, start, resolve, cancel |
| 20 | POST | `/bills` | A | Issue a monthly bill |
| 21 | GET | `/bills` | C/A | Bills with payments and `isOverdue` |
| 22 | POST | `/payments/initiate` | C | Start a bKash checkout |
| 23 | GET | `/payments/bkash/callback` | Public | bKash redirect: verify and settle |
| 24 | GET | `/admin/stats` | A | Dashboard (cached) |
| 25 | GET | `/admin/audit-logs` | A | Audit trail with filters |

Send the access token as `Authorization: Bearer <token>` (it is also set as an HTTP-only cookie).

### Response format

```jsonc
// success
{ "success": true, "statusCode": 200, "message": "…", "data": {}, "meta": { "page": 1, "limit": 10, "total": 42, "totalPages": 5 } }

// error — `errors` is always an array
{ "success": false, "statusCode": 400, "message": "Validation failed", "errors": [{ "path": "email", "message": "Invalid email address" }] }
```

List endpoints take `page`, `limit` (max 100), `sortBy` (whitelisted per endpoint) and `sortOrder`.

### Postman

Import [`Enerza.postman_collection.json`](Enerza.postman_collection.json), run the three **Login as …** requests, then run the folders top to bottom. Requests save the tokens and ids that later requests need, and a pre-request script looks up the seeded grid ids.

Each request's description states the expected status code and the other outcomes it can return (400, 401, 403, 404, 409). For the two upload requests, switch the body to form-data and pick your own image file.

## How the main rules work

**Time.** A datetime without an offset (`2026-10-10T18:00`) is read as Asia/Dhaka; everything is stored in UTC.

**Schedule conflicts.** Creating schedules locks the affected feeder rows (`SELECT … FOR UPDATE`, in id order) before checking for overlaps, so two simultaneous requests cannot both book the same feeder. A schedule's phase (upcoming, ongoing, completed) is computed from the clock when it is read; there is no cron job.

**Fair load shedding.** The generator takes a zone or substation, a time window, a slot length and the MW to shed. For each slot it never picks a CRITICAL feeder, never cuts a feeder in two slots in a row or for more than 4 hours in a day, and orders the rest by priority (LOW first), then by who was shed least in the previous 7 days, then by load. Whatever it cannot cover is reported as unmet MW.

**Outage reports.** A report ends in one of three ways: explained by a schedule that is running on the customer's feeder, linked to the outage already open on that feeder, or a new outage. The feeder lock guarantees at most one open outage per feeder. Priority follows the feeder (a hospital feeder is urgent from the first report) and moves up one level at 10 reports.

**Technician assignment.** Claiming a technician is one conditional `UPDATE` (on duty and below their job limit), so two admins cannot over-assign the same person. Auto-assign picks, within the outage's zone, the technician with the fewest active jobs and then the one assigned least recently.

**Bills.** Amounts are calculated in integer paisa: residential units are billed slab by slab, commercial units at a flat rate, plus a demand charge per kW and 5% VAT. A bill is "overdue" when it is unpaid past its due date; this is computed, not stored. The tariff rates in `bill.constant.ts` are illustrative, not an official BERC schedule.

**bKash payments.** No bKash call is made inside a database transaction. The callback does not trust `status=success`: it executes the payment with bKash, falls back to a status query, and settles only when bKash reports success, `Completed` and the billed amount. Settlement uses conditional updates, so a replayed callback changes nothing. If bKash gives no usable answer, the payment stays pending and the same callback can be opened again. A payment captured for a bill that was already paid is flagged `requiresRefund`.

**Audit.** Feeder changes, user status and role changes, schedule actions, every outage transition, bill issuing and payment results are written to the audit log in the same transaction as the change.

**Emails.** Five events send an email: registration (welcome), a bill being issued, a payment being settled (receipt), an outage being resolved (to everyone who reported it) and a schedule being published (to the customers on that feeder). Emails go out after the database transaction has committed and are best-effort: if SMTP fails, the action still succeeds and the failure is logged. Each one adds a second or two to its request, because a serverless function cannot keep working after it has responded. The seeded demo accounts (`@enerza.com`) have no mailbox, so nothing is sent to them; register with a real address to receive mail.

**Photo uploads.** `PATCH /users/me` and `POST /outages` accept `multipart/form-data` as well as JSON. The image goes in `profilePhoto` or `photo` (JPEG, PNG or WebP, up to 5 MB); other fields are sent as form fields, or as JSON in a field named `data`. The file is held in memory, validated with the rest of the request, uploaded to Cloudinary before the database transaction, and removed again if the request then fails. Replacing a profile photo deletes the old image.

**Deleting.** Users, feeders and areas are soft-deleted. Schedules and outages are cancelled. Bills, payments, reports, timelines and audit logs are never deleted.

**Security.** helmet, CORS limited to `FRONTEND_URL`, bcrypt-hashed passwords that are never returned, Zod validation on every input with unknown body fields rejected, and Redis-backed rate limits: 100 requests a minute overall, 10 per 15 minutes on register and login, 5 a minute per customer on payment initiation.

## Project structure

```
prisma/
  schema/            one .prisma file per area (14 models)
  migrations/
  seed.ts
src/
  server.ts          starts the server (or exports the app on Vercel)
  app.ts             middleware and route mounting
  app/
    config/          zod-validated environment
    lib/             prisma, redis, googleAuth, bkash, cloudinary, multer, nodemailer
    middleware/      auth, validation, rate limiting, error handling
    utils/           AppError, pagination, time, cache, audit log, feeder lock, email …
    module/
      auth/  user/  feeder/  schedule/  outage/  bill/  payment/  admin/
```

Each module has `<name>.route.ts`, `.controller.ts`, `.service.ts`, `.validation.ts`, `.interface.ts`, and where needed `.constant.ts` and `.utils.ts` (pure functions, covered by the unit tests).

## Testing

`npm test` runs 65 unit tests over the pure logic: the tariff calculation, the load-shedding generator, the outage state machine and priority rules, and the reliability indices.

## Deployment (Vercel)

The API is bundled into one file and deployed with the Vercel CLI:

```bash
npm run build          # tsup → dist/server.js
vercel --prod
```

1. Set every variable from the table above in the Vercel project. `BKASH_CALLBACK_URL` must be the deployed URL plus `/api/v1`, and `NODE_ENV` should be `production`.
2. Run `npx prisma migrate deploy` and `npx prisma db seed` once against the production database.
3. `vercel.json` routes every request to `dist/server.js`. `dist/` is not committed, so deploy from a machine that has run the build.

On Vercel, rate limits and caches live in Redis because serverless instances do not share memory.

## Future work

- SMS notifications, and a queue so emails do not add to request time.
- A refund flow for payments flagged `requiresRefund`.
- Meter-reading photo uploads.
- Integration tests that run against a disposable database.
- Password reset and email verification.
