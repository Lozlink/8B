# 8 Ball Lounge — table timer

Times pool tables, works out what to charge, and sends the amount to the Square Terminal. Square handles the money: card payments, cash, receipts, refunds and reporting. This app never sees card data and never creates payments.

Built for the soft launch on 21–22 Nov 2026: 7 tables at $25/h (GST incl.), a counter iPad Air and two floor iPad minis.

## Stack

- Next.js 16 (App Router), TypeScript strict, Tailwind v4, pnpm. Deployed on Vercel in `syd1`.
- Supabase Postgres in the Sydney region. Supabase Realtime is used only as a "something changed" ping.
- Square Node SDK v46 (Terminal API).
- Vitest for unit tests, plus PGlite (in-memory Postgres) for database integration tests.

## Layout

```
lib/pricing/       Pure pricing engine (server source of truth; client uses it for estimates)
lib/domain/        Session state machine, business-day maths, shared DTO types
lib/server/        Auth, sessions service (every transition), queries, admin, audit
lib/square/        Square client, Terminal checkout calls, webhook signature check
lib/client/        Browser-side API client (api.ts is the server/UI contract) and hooks
app/api/           Route handlers (thin wrappers around lib/server)
app/…              Screens: floor (/), /unpaid, /summary, /admin, /login, /enrol
supabase/          Migrations, local seed, CLI config
docs/BRIEF.md      Owner's brief
docs/SQUARE.md     Square behaviour, VERIFY answers, sandbox device IDs
```

## Local development

Prerequisites: Node 22+, pnpm, Docker (for `supabase start`) and the Supabase CLI.

```bash
pnpm install
supabase start                 # local Postgres + Realtime
supabase db reset              # applies migrations + supabase/seed.sql (sets the local timer_app password)
cp .env.example .env.local     # fill in; anon key + URL come from `supabase status`
pnpm dev                       # runs `dotenvx run -f .env.local -- next dev`
```

For Square in local dev, use a sandbox token. To receive webhooks locally you need a tunnel such as `cloudflared` or `ngrok`, and `SQUARE_WEBHOOK_URL` must be the tunnel URL.

First run:

1. Open the app. It sends you to `/enrol`.
2. Enter `DEVICE_ENROL_CODE` and a device label.
3. Because no manager exists yet, the form also creates the first manager. No default PINs exist anywhere.

### Tests

```bash
pnpm test               # unit: pricing engine (incl. DST nights), state machine, business day, webhook signature
pnpm test:integration   # schema + sessions service against the real migrations in in-memory PGlite
pnpm typecheck && pnpm lint
```

## Production checklist

### Supabase

1. Create the project in **Sydney** (ap-southeast-2).
2. Run `supabase link`, then `supabase db push`. This applies the migrations. Don't push `seed.sql`: it sets a local-only password.
3. Give the server role a real password. In the SQL editor, run:
   ```sql
   alter role timer_app with login password '<long random password>';
   ```
4. Build `DATABASE_URL` from the **transaction pooler** (port 6543) using that role. The username is `timer_app.<project-ref>`.

### Vercel

1. Set every variable in `.env.example` for Production.
2. `vercel.json` pins functions to `syd1`.

### Square

1. In the venue's Square account, open the Developer Console and create an application.
2. Copy its **production** access token and location ID into the env vars.
3. Under Webhooks, add a subscription:
   - URL: `https://<domain>/api/square/webhook`
   - Events: `terminal.checkout.updated` and `device.code.paired`
4. Copy the signature key into `SQUARE_WEBHOOK_SIGNATURE_KEY`. The URL must be identical to `SQUARE_WEBHOOK_URL`.

### iPads

1. On each iPad, open the site in Safari.
2. Tap Share → **Add to Home Screen** first.
3. Open the app from the home-screen icon and enrol it there, with the code and its label ("Counter", "Floor 1" or "Floor 2").

Home-screen apps keep cookies separate from Safari. An iPad enrolled in Safari may not be enrolled once installed.

### Terminal

1. On the Admin screen, open the Terminal tab and tap **Pair Terminal**.
2. Enter the 6-character code on the Terminal within 5 minutes.
3. The device ID saves automatically, from the webhook or from the pairing screen's own check.

### Smoke test

1. Run a $1 test charge.
   - To get a $1 bill, temporarily add a high-priority $2/h rate card and keep the session under the minimum. Deactivate the card afterwards.
2. Confirm the session flips to Paid by itself.
3. Refund the $1 in Square.
4. Check the receipt options on the Terminal screen.

## How money moves

- **Card on the Terminal:**
  1. Staff tap Stop, then Charge card. The server re-prices from the rates captured at stop and sends the exact amount to the Terminal.
  2. When the customer pays, Square's webhook marks the session paid. If the webhook is late or lost, the server's own Square check catches it.
  3. Staff can still Cancel, Resend, or Mark paid – card.
- **Cash:**
  1. Ring "Table hire" at the shown amount as Cash in Square POS. The drawer pops.
  2. Tap **Mark paid – cash**. The app never sends cash to the Terminal.
- **Card taken some other way** (e.g. the Stand reader): tap **Mark paid – card** and confirm it shows as approved in Square.
- **Conflicts are flagged, never hidden.** Two examples:
  - A card payment that completes after a cash mark-paid is recorded as a payment conflict.
  - Marking paid while a checkout is live cancels it first. If Square says it already completed, the session is recorded as paid by card, and staff are told not to take cash.
- **Leave unpaid** frees the table and moves the bill to the Unpaid list.

**Launch fallback:** if the Terminal push isn't ready, leave the Terminal unpaired. Staff key the amount into Square POS ("Table hire", variable price) and tap Mark paid. Everything else works the same.

## Security and record-keeping

- **No hard deletes.** Sessions, intervals and checkout history can't be deleted by any role: privileges are revoked and triggers raise on DELETE/TRUNCATE. Voids keep the row with a reason.
- **Append-only audit log.** UPDATE, DELETE and TRUNCATE are blocked for every role, including the owner, by trigger. Every action writes its audit row in the same transaction as the change.
- **Least-privilege database access.**
  - The browser never queries the database. `anon`/`authenticated` have RLS enabled with no policies and no grants.
  - The server connects as `timer_app`: SELECT, INSERT and UPDATE only, and INSERT-only on the audit log. No service key is used.
- **Realtime carries no data.** A trigger broadcasts "floor changed" on a public channel and clients refetch through authenticated routes.
- **Devices must be enrolled before PIN login works.** So a 4-digit PIN can't be brute-forced from the internet.
  - PINs are bcrypt-hashed.
  - Wrong-PIN attempts are throttled per person and per device.
  - Managers can revoke a device.
- **Manager actions** (edit times, void, reverse paid, admin) need a manager PIN and a written reason. The audit row records both the person on the device and the approving manager.
- **The server is authoritative** for prices and state transitions. Every transition locks the session row and is checked against the state machine.

## Things to check on the real hardware

- **Realtime:** a change on one iPad should appear on the others within 2 seconds.
  - The app listens to a public database broadcast. Supabase's docs don't explicitly confirm public database broadcasts reach anon clients without a `realtime.messages` policy.
  - If they don't, the 20-second poll still keeps iPads correct, just slower. Tell me and I'll switch to server-sent broadcasts.
- **Receipt options:** what the Terminal's post-payment screen offers (see docs/SQUARE.md).
- **Layout:** iPad Air landscape and iPad mini portrait, plus the Add to Home Screen icon.

## Deviations from the brief (deliberate)

- `sessions` has extra columns:
  - `current_table_id`: which table the bill is on, plus a unique index so a table has one session.
  - `checkout_attempt`, `voided_at`, `voided_by`.
- `terminal_checkouts` keeps every Terminal attempt. These are the same kind of ID as `square_checkout_id`; there are still no payment or card IDs.
- `settled_via` has a third value, `square_api`. It records "paid, confirmed by asking Square" (when a webhook was late or lost), as distinct from the webhook itself.
- `settings.business_day_start` (default 06:00) makes the cut-over in §11 configurable.
- Device enrolment (`devices`) and `login_attempts` were added to protect PIN login on a public URL.
- A stop that comes to $0 (zero time or within the grace period) is closed as a void with the reason "No charge". It stays visible in the daily summary.
- A paid session can't be voided directly. A manager reverses it first, so the trail shows both steps.
