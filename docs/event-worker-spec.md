# Event Registration Worker — Technical Spec (v1)
**Service:** `event-engine` · **Owner:** Refuel Creative · **Consumer:** Weld Australia (first tenant)
**Role:** the thin, irreducible backend behind the HubSpot-native event system — atomic capacity, reservation holds, waitlist, ticket/QR, check-in, and reliable write-back to HubSpot (Marketing Events + Deals/Invoices) and onward to Xero.

> **Status: original build brief, kept for design intent.** Parts of the schema, the module
> names and the endpoint list have moved on since it was written. For how the code works
> today, see [architecture.md](architecture.md), [data-model.md](data-model.md),
> [api-reference.md](api-reference.md) and [flows.md](flows.md). Where this document and the
> code differ, the code wins.

This is a build brief for Claude Code. HubSpot remains system of record for contacts, marketing events, deals, invoices, payments. The worker is system of record **only** for capacity, holds, tickets, and check-in state. Multi-tenant from day one, keyed by `portal_id`.

---

## 1. Stack

- **Runtime:** Cloudflare Workers, **Hono** router, TypeScript.
- **Relational store:** **D1** (SQLite) — source of truth for capacity/tickets/orders/registrations.
- **Concurrency guard:** **Durable Objects** — one `EventCapacity` DO instance per event; serializes all seat math.
- **Scheduling:** **Cron Triggers** — hold expiry, waitlist decisions (owner-resolved, not auto-promotion — Phase 18.3), `/complete` calls, reconciliation sweep.
- **Async write-back:** **Queues** — drain an outbox of HubSpot/Xero writes with retry/backoff.
- **Secrets:** Wrangler secrets per environment (HubSpot private-app token, Stripe webhook secret, signing keys).
- **Tenancy:** every row carries `portal_id`; every external token resolved per tenant.

### Why a Durable Object (not D1 alone)
A sell-out is a race: two concurrent `reserve` calls both read "1 left", both pass the check, both write — oversell. D1 has transactions but no cross-request locking you can rely on for a hot counter. A **DO is single-threaded per id**, so all reserve/confirm/release for one event funnel through one instance and execute in order. The DO holds the authoritative live counters in storage; D1 holds the durable record. Pure-D1 compare-and-swap (a `version` column with retry) is acceptable for low-concurrency/free events — offer it as the "lite" path, but the DO is the default for paid/capacity-limited events.

---

## 2. D1 schema

> **Source of truth:** the consolidated migration in `deploy-config.md` (`migrations/0001_init.sql`) is authoritative — it includes later-decision columns (`events.provider`, `events.allow_oversell`, `events.marketing_event_completed`, the `teams_*` columns, `ticket_types.member_only`, `ticket_types.tax_treatment`, `registrations.teams_registration_id`, `registrations.teams_join_url`, `marketing_event_state_synced`). The block below is the original reference; where they differ, the migration wins.

```sql
-- Tenant + event catalog (mirror of the HubSpot/HubDB source of truth for the fields the worker needs)
CREATE TABLE events (
  id            TEXT PRIMARY KEY,          -- internal uuid
  portal_id     TEXT NOT NULL,
  external_event_id TEXT NOT NULL,         -- binds HubDB row <-> Marketing Event <-> DO
  slug          TEXT NOT NULL,
  title         TEXT NOT NULL,
  starts_at     TEXT NOT NULL,             -- ISO8601
  ends_at       TEXT NOT NULL,
  timezone      TEXT NOT NULL DEFAULT 'Australia/Adelaide',
  capacity      INTEGER,                   -- event-level cap; NULL = uncapped
  status        TEXT NOT NULL DEFAULT 'draft', -- draft|published|closed|completed|cancelled
  mode          TEXT NOT NULL DEFAULT 'in_person', -- in_person|online|hybrid
  marketing_event_synced INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (portal_id, external_event_id),
  UNIQUE (portal_id, slug)
);

CREATE TABLE ticket_types (
  id            TEXT PRIMARY KEY,
  portal_id     TEXT NOT NULL,
  event_id      TEXT NOT NULL REFERENCES events(id),
  hs_product_id TEXT,                      -- HubSpot Product mirror (for invoice line items)
  label         TEXT NOT NULL,
  price_cents   INTEGER NOT NULL DEFAULT 0,
  member_price_cents INTEGER,                 -- SUPERSEDED by Phase 18.1: member pricing is
                                              -- now tiered by level+category via the
                                              -- pricing_rules table (most-specific wins).
                                              -- price_cents is the standard price.
  currency      TEXT NOT NULL DEFAULT 'AUD',
  inventory     INTEGER,                   -- per-type cap; NULL = only event cap applies
  min_per_order INTEGER NOT NULL DEFAULT 1,
  max_per_order INTEGER NOT NULL DEFAULT 10,
  sales_start   TEXT,
  sales_end     TEXT,
  created_at    TEXT NOT NULL
);

-- Reservation hold: short-lived claim on seats before payment
CREATE TABLE reservations (
  id            TEXT PRIMARY KEY,          -- hold id (returned to client)
  portal_id     TEXT NOT NULL,
  event_id      TEXT NOT NULL REFERENCES events(id),
  email         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'held', -- held|confirmed|expired|released
  expires_at    TEXT NOT NULL,            -- ISO8601; ~15 min free, invoice due date if paid
  created_at    TEXT NOT NULL
);

CREATE TABLE reservation_items (
  id            TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL REFERENCES reservations(id),
  ticket_type_id TEXT NOT NULL REFERENCES ticket_types(id),
  qty           INTEGER NOT NULL
);

-- Order = paid (or $0) registration. Maps 1:1 to a HubSpot Deal.
CREATE TABLE orders (
  id            TEXT PRIMARY KEY,
  portal_id     TEXT NOT NULL,
  event_id      TEXT NOT NULL REFERENCES events(id),
  reservation_id TEXT REFERENCES reservations(id),
  contact_email TEXT NOT NULL,
  hs_contact_id TEXT,
  hs_deal_id    TEXT,
  hs_invoice_id TEXT,
  amount_cents  INTEGER NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'AUD',
  status        TEXT NOT NULL DEFAULT 'pending', -- pending|paid|cancelled|refunded
  payment_ref   TEXT,                     -- Stripe/HubSpot payment id
  -- How this booking was to be paid (Phase 4.2, migration 0029). Resolved once, at reserve,
  -- because that is the call that has to pass the right hold to the DO; recorded here so it
  -- is auditable afterwards. 'invoice' = qualified for terms, seat held to the due date;
  -- 'card' = pays at checkout on the DO's 15-minute TTL, invoice due on receipt;
  -- NULL = free/comped, so no payment applies and no seat is held to a date.
  payment_method     TEXT,
  payment_terms_days INTEGER,             -- terms granted; NULL alongside 'card' and free
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Who may pay on invoice terms (Phase 4.2). A RULE, not a flag on a contact: auditable,
-- per-tenant, and resolved most-specific-first exactly as pricing_rules is. Specificity is a
-- property of match_kind, not of the row — contact_property > company_property >
-- membership_level > always — so `priority` (then recency) only breaks ties within a kind and
-- no portal-wide rule can outrank one naming an individual.
--
-- An EMPTY (or wholly inactive) rule set means the portal has not configured this, and every
-- paid booking stays invoice-eligible — Phase 4.1's behaviour. Reading empty as "nobody
-- qualifies" would reinstate the 15-minute hold for every existing tenant on deploy, which is
-- the AWS D1.1 fault rather than the fix. Resolution also fails OPEN: an unreadable table,
-- an unreachable HubSpot or an unverified membership degrade to eligible-with-default-terms.
CREATE TABLE invoice_eligibility_rules (
  id           TEXT PRIMARY KEY,
  portal_id    TEXT NOT NULL REFERENCES tenants(portal_id),
  match_kind   TEXT NOT NULL,   -- 'contact_property'|'company_property'|'membership_level'|'always'
  match_key    TEXT,            -- property name, or 'level'|'category' for membership_level
  match_value  TEXT,            -- qualifying value; empty = "the property is ticked/set"
  terms_days   INTEGER NOT NULL DEFAULT 30,
  hold_ms      INTEGER,         -- hold for an eligible payer; NULL = hold to the due date
  min_cents    INTEGER,         -- floor on the booking total, e.g. invoice only above $1,000
  priority     INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL
);

-- One registration per attendee (an order may cover several attendees).
-- Maps to a Marketing Event participant.
CREATE TABLE registrations (
  id            TEXT PRIMARY KEY,
  portal_id     TEXT NOT NULL,
  event_id      TEXT NOT NULL REFERENCES events(id),
  order_id      TEXT REFERENCES orders(id),
  ticket_type_id TEXT NOT NULL REFERENCES ticket_types(id),
  attendee_email TEXT NOT NULL,
  attendee_name TEXT,
  -- Optional contact capture (Phase 1.2). NULL = never asked. Written back to the
  -- ATTENDEE's HubSpot contact (standard phone/city/state unless the tenant remaps them),
  -- only where that property is empty; a differing stored value opens a contact_conflict
  -- decision rather than being overwritten.
  attendee_phone TEXT,
  attendee_suburb TEXT,
  attendee_state TEXT,
  hs_contact_id TEXT,
  state         TEXT NOT NULL DEFAULT 'registered', -- registered|attended|cancelled|no_show
  marketing_event_state_synced TEXT,      -- last state pushed to HubSpot (drift detection)
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE tickets (
  id            TEXT PRIMARY KEY,
  portal_id     TEXT NOT NULL,
  registration_id TEXT NOT NULL REFERENCES registrations(id),
  code          TEXT NOT NULL UNIQUE,     -- opaque QR payload (signed)
  checked_in_at TEXT,
  checked_in_by TEXT,
  created_at    TEXT NOT NULL
);

-- Internal staff notes (Phase 1.3). Append-only: an edit writes a new row. Never
-- rendered on a ticket, an invoice, or any attendee-facing page or email; mirrored to
-- HubSpot's own Note engagement (hs_note_body) unless tenants.note_sync_mode = 'off'.
CREATE TABLE registration_notes (
  id              TEXT PRIMARY KEY,
  portal_id       TEXT NOT NULL,
  registration_id TEXT REFERENCES registrations(id),
  order_id        TEXT REFERENCES orders(id),
  author          TEXT NOT NULL,          -- HubSpot user id, or 'system'
  body            TEXT NOT NULL,
  hubspot_note_id TEXT,                   -- projection onto the HubSpot Note object
  created_at      TEXT NOT NULL,
  CHECK (registration_id IS NOT NULL OR order_id IS NOT NULL)
);

CREATE TABLE waitlist (
  id            TEXT PRIMARY KEY,
  portal_id     TEXT NOT NULL,
  event_id      TEXT NOT NULL REFERENCES events(id),
  ticket_type_id TEXT NOT NULL REFERENCES ticket_types(id),
  email         TEXT NOT NULL,
  qty           INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'waiting', -- waiting|offered|promoted|expired
  offer_expires_at TEXT,
  position      INTEGER NOT NULL,
  created_at    TEXT NOT NULL
);

-- Reliable write-back: every HubSpot/Xero side effect is enqueued here first.
CREATE TABLE outbox (
  id            TEXT PRIMARY KEY,
  portal_id     TEXT NOT NULL,
  kind          TEXT NOT NULL,            -- me.register|me.attend|me.cancel|me.complete|deal.create|invoice.create|contact.sync_attendee_details|note.create
  target_ref    TEXT NOT NULL,            -- registration_id / order_id / event_id
  payload       TEXT NOT NULL,            -- JSON
  status        TEXT NOT NULL DEFAULT 'pending', -- pending|done|failed
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error    TEXT,
  created_at    TEXT NOT NULL
);

-- Idempotency + webhook dedup
CREATE TABLE idempotency_keys (
  key           TEXT PRIMARY KEY,
  portal_id     TEXT NOT NULL,
  response_json TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE webhook_events (
  id            TEXT PRIMARY KEY,         -- provider event id (Stripe/HubSpot)
  provider      TEXT NOT NULL,
  received_at   TEXT NOT NULL
);

CREATE INDEX idx_res_expiry ON reservations(status, expires_at);
CREATE INDEX idx_outbox_due ON outbox(status, next_attempt_at);
CREATE INDEX idx_reg_event ON registrations(event_id, state);
CREATE INDEX idx_waitlist_pos ON waitlist(event_id, ticket_type_id, status, position);
```

---

## 3. Durable Object: `EventCapacity`

One instance per event, `idFromName(`${portal_id}:${external_event_id}`)`. Owns live seat math; persists to DO storage; mirrors confirmed counts to D1 via the outbox/direct writes.

**In-DO state**
```ts
type Held = { holdId: string; ticketTypeId: string; qty: number; expiresAt: number };
type State = {
  eventCapacity: number | null;                  // null = uncapped
  perType: Record<string, { inventory: number | null; confirmed: number }>;
  held: Held[];
};
// available(typeId) = inventory - confirmed - sum(active held for typeId)
// eventAvailable   = eventCapacity - totalConfirmed - sum(active held)
```

**Methods**
- `reserve({ items, email, ttlSeconds })` → validates each ticket type against both per-type and event-level availability **atomically**; on success records holds + sets a DO **alarm** for the earliest expiry; returns `{ holdId, expiresAt }`. On shortfall returns `{ full: true, shortfall }` so the caller can offer the waitlist.
- `confirm({ holdId })` → moves held → confirmed, clears the hold, persists. Idempotent.
- `release({ holdId })` → frees a hold (explicit cancel or expiry).
- `alarm()` → expire stale holds, recompute, then ask the worker to handle freed seats. Phase 18.3: the worker no longer auto-promotes — it opens a waitlist decision + owner task; the owner picks who to offer to.

DO storage is the authority for "seats available right now"; D1 `reservations`/`orders` are the durable audit trail. On cold start, the DO rehydrates counters from D1 if storage is empty.

---

## 4. State machines

**Reservation:** `held → confirmed` (payment ok) · `held → expired` (TTL, via alarm) · `held → released` (user abandons).

**Order/payment:** `pending → paid` (webhook) · `pending → cancelled` (hold expired before pay) · `paid → refunded`/`partially_refunded` (refund per policy — Phase 18.2) · `pending → needs_review` (late-payment oversell awaiting an owner decision — Phase 18.3).

**Registration/attendance:** `registered → attended` (check-in) · `registered → cancelled` (refund/cancel, or a per-registration soft cancel — Phase 3, `registrations.cancelled_at`) · `registered → no_show` (set by post-event `/complete` for anyone not `attended`).

**Waitlist:** `waiting → offered` (seat freed; offer has its own short TTL) · `offered → promoted` (accepts + pays) · `offered → expired` (ignores; seat re-offered to next).

---

## 5. HTTP API (Hono)

### Public (from the HubDB page / form)
- `GET  /api/v1/events/:slug/availability` → live counts per ticket type (reads DO).
- `POST /api/v1/events/:slug/reserve` → body: `{ email, items:[{ticketTypeId, qty}], member?:bool }`. Header: `Idempotency-Key`. Calls DO `reserve`. Returns hold + a payment handoff (HubSpot invoice/payment-link URL) **or** `{ full, waitlistOffered }`.
- `POST /api/v1/reservations/:holdId/release` → user-abandon.
- `POST /api/v1/events/:slug/waitlist` → join waitlist `{ email, items }`.

### Webhooks (verified signatures, deduped via `webhook_events`)
- `POST /webhooks/stripe` → on `payment_intent.succeeded` / invoice paid: dedup → DO `confirm(holdId)` → mark order `paid` → generate registrations + tickets → **enqueue** `me.register` for each attendee → (Xero sync flows from the HubSpot invoice automatically).
- `POST /webhooks/hubspot` → optional: payment/deal status echoes; reconciliation hints.

### Check-in / attendance (staff-authed; bearer or signed device token)
- `POST /api/v1/checkin` → body `{ code }` (scanned QR). Verifies signature, marks `tickets.checked_in_at`, sets registration `attended`, **enqueues** `me.attend` with `joinedAt` and `contact.sync_attendance` (Phase 2.1) in the same batch. Idempotent on code.
- `GET  /api/v1/checkin/stats/:eventId` → live attended/registered counts for the door, from
  the shared Phase 2.2 count — so a hybrid event's online joiners are not listed as still to
  arrive, and staff stop looking for people already in the session.
- `GET  /api/v1/manage/events/:id/attendance` (admin) → per-registration attendance (Phase 2.1),
  derived from the tickets (door scan) and the matched `me.attend` record (webinar join), plus
  the contact property mapping it writes to and the state of each write-back row.
  `?attended=true|false` filters the list; the summary always covers the whole event.

### Amend and cancel one registration (admin — Phase 3)
Per-REGISTRATION, which is the whole point: a corporate booking is one order holding several
seats, and until Phase 3 the smallest thing that could be edited or cancelled was the entire
booking.

- `PATCH  /api/v1/manage/events/:id/registrations/:regId` → amend attendee `name`, `email`,
  the Phase 1.2 `contact` fields (`phone` / `suburb` / `state`) and the Phase 2.3 `answers`,
  without a transfer. Body keys are PARTIAL — an absent key is left alone; an explicitly empty
  contact field or answer CLEARS it. Returns `{ changed, ticketId, ticketReissued }`.
  - **The ticket is reissued when the person it NAMES changes** (name or email), not on every
    amendment: a QR carries `{ ticketId, registrationId, eventId }`, so a corrected suburb
    cannot make an issued code wrong, and reissuing anyway would break the code already in the
    attendee's inbox. The old code is voided and a new one minted when it does reissue.
    `reissueTicket: true` forces it for the reasons the rule cannot see (a leaked code).
    A checked-in ticket is never reissued — it has been used.
  - **An email change moves the Marketing Event registration** (`contact.upsert` +
    `me.cancel` old + `me.register` new, exactly as transfer does) and pushes a corrected
    webinar registration for an online event, carrying OUR registration id again so
    attendance matching stays exact. A name change is D1-only: 1.2 already settled that this
    worker does not rewrite an existing contact's name from booking data.
  - Contact fields go through the 1.2 write-back on 1.2's terms (fill an empty property, open
    a `contact_conflict` on a difference). Answers go through the 2.3 write-back as
    **self-declared** — a staff correction of one named person's answer is a statement about
    them, not the by-product of a bulk booking the "fill only empties" rule guards against.
  - Refuses `duplicate_attendee` for an email already holding a live seat, and
    `registration_cancelled` for a seat that is already gone.
- `DELETE /api/v1/manage/events/:id/registrations/:regId` → soft cancel. Body (optional):
  `{ reason, refund: 'policy' | 'none', refundAmountCents }`. Returns
  `{ remainingOnOrder, orderStatus, refund, waitlistDecisionId }`.
  - **The seat is released through the EventCapacity DO** (`/cancel-seats`), never by
    decrementing a count in D1. That operation shrinks a live HOLD or a COMMIT, whichever the
    seat is sitting in — `release` would have dropped the whole hold, taking the colleagues
    still coming with it. `registrations.cancelled_at` records the cancellation; it does not
    perform it, and the DO's D1 rebuild subtracts the same rows so a cold start agrees.
  - **Cancelling one of several seats does not cancel the order.** The order moves only when
    the cancelled seat was its last live one → `refunded` / `partially_refunded` / `cancelled`.
    Otherwise it keeps its status and only accrues `refunded_cents`.
  - **Refunds follow the event's `refund_policy_id`**, applied to what THAT seat cost;
    nothing is defaulted. A full refund of the whole remaining booking voids the invoice,
    anything less refunds the amount against the payment — voiding an invoice over one seat
    of four would wipe three colleagues' payment record in HubSpot and, via Data Sync, in
    Xero. The seat amount comes from `registrations.unit_cents` (below); a booking taken
    before that column existed falls back to the booking's unrefunded value over its live
    seats. `refund.basis` reports which — `seat`, `order_share` or `override` — and
    `refundAmountCents` overrides both.
  - **A voucher-covered seat refunds no money and returns its voucher** to the company, and
    `vouchers` in the response says how much went back.
  - **A freed seat opens a waitlist decision and is offered to nobody** (Phase 18.3), the same
    `createWaitlistDecision` the refund and hold-expiry paths raise.
  - An ISSUED ticket is cancelled; a CHECKED-IN one is left alone. Attending is a fact, and a
    later cancellation does not un-attend someone who walked in the door — so a cancelled seat
    can be `cancelled` on the booking axis and `attended` on the attendance axis at once.
  - Idempotent by refusal: a second cancel answers `already_cancelled` rather than giving the
    seat back twice.

#### The per-seat record (Phase 3.3, migration 0028)
`registrations.unit_cents`, `voucher_seats` and `voucher_cents` are the per-seat halves of the
three order money columns, so over a booking's live seats:

    SUM(unit_cents)    = orders.total_cents
    SUM(voucher_seats) = orders.voucher_seats_redeemed
    SUM(voucher_cents) = orders.voucher_credit_cents

Cancelling seats one at a time therefore cannot refund or return more than the booking took —
that is arithmetic, not a clamp. `unit_cents` is the amount CHARGED (0 for a voucher-covered or
comped seat, which are owed nothing back), and exactly one voucher column is ever non-zero
because the two are the units the two `voucher_mode`s spend in — captured at booking time, so a
tenant switching mode later cannot change what a sold seat consumed.

Cancelling a covered seat subtracts its voucher record from the ORDER's redemption totals and
zeroes its own, so the company's balance recovers and a replay cannot return the same voucher
twice. Usage stays derived: still summed over `orders`, never incremented.

The migration backfills `unit_cents` by handing `reservation_items` out to the registrations
sharing its ticket type — exact in total, arbitrary in which seat gets a $0 slot, and
immaterial because every seat of one ticket type on one booking resolved to the same price. The
voucher split is NOT backfilled: a $0 line could be a voucher seat or a comp, and a guess would
hand a company back vouchers it had spent. Pre-0028 bookings are detected by shape at cancel
time (the order redeemed something, none of its seats accounts for any of it) and fall back to
the order's totals. `scripts/check-migrations.mjs` fails CI if the statement the tests execute
ever drifts from the one the migration will run.

The cancelled seat leaves `confirmed` / `awaitingPayment` and joins `cancelled` in every
Phase 2.2 surface at once, because `seat_cancelled` is derived from `cancelled_at` inside the
one shared `ATTENDANCE_DERIVATION_COLUMNS` fragment — and it stops counting against
`seatsHeld`, so the seat is genuinely back on sale. Cancelled seats are also excluded from the
duplicate-attendee guard: cancel-then-rebook is supported, and the booking is usually still
`paid` on behalf of colleagues, so order status alone cannot tell the two apart.

### Reporting and export (admin — Phase 2.2)
Read from **D1 directly, never from HubSpot**. A report built off HubSpot disagrees with the
engine that sold the seats, and the argument the reporting surface exists to end just repeats
with a new set of numbers.

- `GET /api/v1/manage/events/:id/registrations` → the full attendee list: ticket type, order,
  payment status, Phase 1.2 contact capture, Phase 1.3 staff notes and check-in state.
  Paginated with `?limit=` (default 100, max 500) and `?offset=`. The `summary` and `money`
  blocks always describe the **whole event**, never the page.
- `POST /api/v1/manage/events/:id/export-token` → mint a short-lived, event-scoped download
  link (`{ url, expiresAt, expiresInSeconds }`). The CSV route below is admin-bearer-authed and
  a browser download is a plain navigation that carries no headers, so a staff member cannot
  reach it directly; a HubSpot UI extension has no download primitive either and can only open
  a URL. The App Card mints on click and renders the link.
- `GET /api/v1/exports/events/:id/registrations.csv?token=…` → the token-authed download.
  Deliberately OUTSIDE `/api/v1/manage`, which is uniformly admin-authed — query-parameter auth
  is a weaker posture than a header and lives somewhere it can be reviewed on its own. The
  token names one portal, one scope and one event, and all three are checked before a row is
  read; it is signed with `EXPORT_TOKEN_SECRET_{portalId}` and expires in minutes. Stateless,
  so replayable within its lifetime — the same trade the check-in device token makes.
  Responds `no-store`, `no-referrer`, `nosniff`. The body is produced by the same code as the
  admin-authed route: two doors, one report.
- `GET /api/v1/manage/events/:id/registrations.csv` → the same rows as a download, always the
  whole event (a hand count is of everybody, so `?limit` does not truncate it). `no-store`:
  a reconciliation answered out of cache with yesterday's numbers is the failure mode.
  Free text is neutralised against spreadsheet formula injection, and money is written as an
  amount rather than raw cents — a column of `83500` summed by a finance person is out by
  100x and still looks plausible.
- `GET /api/v1/manage/reports/registrations?from=&to=&category=` → cross-event roll-up grouped
  by course category over a range of `events.starts_at`. A bare date as `to` means through the
  END of that day. Every figure is aggregated from the same per-event lists above, so the
  roll-up reconciles to them by construction.

**Two axes, deliberately not one number.** `confirmed + awaitingPayment + needsReview +
cancelled = total` partitions the seats by BOOKING state — the axis to hold a disagreeing
dashboard against, because a gap can be pointed at. `attended` / `registered` /
`notYetArrived` are the ATTENDANCE axis and match the Phase 2.1 endpoint exactly. The two do
not add up to each other: someone refunded who turned up anyway is counted in `cancelled` and
is *not* subtracted from `registered`, because attending is a fact. `cancelled + registered >
total` is the arithmetic being right, not the report being broken.

Money is summed over **distinct orders**, never per attendee row — a three-seat corporate
booking carries one order total across three rows, and summing it per row triples the revenue.

**Seats vs people.** `total` counts SEATS; `distinctContacts` counts PEOPLE. HubSpot's
Marketing Events are contact-scoped, so a HubSpot registration report counts people — hold it
against `distinctContacts`, not `total`. The two diverge on a cancel-then-rebook. Not additive
across events: `sumSummaries` requires the union as an argument.

**Date ranges are LOCAL days.** `from`/`to` given as bare dates are interpreted in
`tenants.display_timezone` (NULL = `Australia/Adelaide`; any IANA name honoured). HubSpot
stores datetimes in UTC but its dashboards group by the PORTAL's timezone, so a UTC-bounded
range disagrees with the dashboard it is meant to reconcile against at both ends of every
month. The response echoes `range.timeZone`. A value carrying a time is an explicit instant
and is used as given.

**Where a D1/HubSpot gap comes from.** Every row carries `marketing_event_sync`, derived from
its `me.register` outbox row: `delivered` / `pending` / `dead` / `never_enqueued`, with
`notSyncedToMarketingEvent` in the summary. A `dead` row is someone the engine sold a seat to
and HubSpot has never heard of. Outbox rows are never purged, so absence is a finding.

**`/stats` shares this count.** `GET /api/v1/manage/events/:id/stats`,
`GET /api/v1/app-home/events/:id/stats` and `GET /api/v1/checkin/stats/:eventId` all call
`summariseEventRegistrations` and return the same `registered` / `attended` / `notYetArrived`
plus the full `summary`. They previously each had their own SQL, and all three counted
`attended` from checked-in tickets alone — so an online event reported nobody as having
attended. `availableSeats` subtracts `seatsHeld` (`confirmed + awaitingPayment + needsReview`),
because a seat held against an unpaid invoice is not for sale.

### Invoice eligibility and reissue (admin — Phase 4.2)
Phase 4.1 fixed the AWS D1.1 fault — a paid booking's seat is held to the invoice due date
rather than for fifteen minutes — by giving the long hold to every paid booking. These decide
who it was for, and how to recover a booking whose invoice was killed prematurely.

- `GET/POST /api/v1/manage/invoice-eligibility-rules`,
  `PATCH/DELETE /api/v1/manage/invoice-eligibility-rules/:ruleId` → the rule set, portal-level
  because the rule is about the PAYER, not the event. The list is ordered exactly as the
  resolver tests them, and carries `gateActive` — false means no active rule exists and every
  paid booking is invoice-eligible, which is what a portal that has never touched this looks
  like. PATCH accepts only `active` and `priority`: everything else changes which payers a
  rule covers, and a rule that quietly starts covering different people is worse than a second
  row. Deactivate and write the rule you want.
- `POST /api/v1/manage/events/:id/orders/:orderId/reissue-invoice` → a NEW invoice for a
  booking whose invoice was voided. Nothing can un-void a HubSpot invoice (`voided` is the
  only terminal status, and there is no "cancelled"), so recovery is a fresh invoice against
  the same order: same deal, same lines, priced from `reservation_items` so a booking made
  months ago is not re-priced at today's rates. **The seat is re-taken through the DO and may
  be refused** — a sold-out event returns `event_full` and the order is left exactly as it
  was. The superseded invoice id is closed explicitly, so the portal never holds two payable
  invoices for one booking. Refuses `order_not_reissuable` for an order that actually took
  payment: undoing that is a refund decision with a policy behind it. Body (optional):
  `{ invoiceDueDate }`.
- Companion guard, not an endpoint: `payment.refund` rows carrying `reason: 'expired_hold'`
  re-read the order at DRAIN time and stand down unless it is still `cancelled`. The row is
  written at expiry and drains later, and in that gap a late payment (order → `needs_review`)
  or a reissue can revive the booking — voiding then would kill a live invoice irreversibly.

### Admin / lifecycle (Refuel/tenant-authed)
- `POST /api/v1/events` → create event in D1 **and enqueue Marketing Event creation up front** (`me.create`); bind `external_event_id`.
- `POST /api/v1/events/:id/complete` → manual trigger of post-event finalize (also run by cron): enqueue `me.complete` so HubSpot computes attendance duration + **No-Show**.

---

## 6. Write-back (outbox → Queue → HubSpot)

Every HubSpot side effect is written to `outbox` in the same D1 transaction as the state change, then a Queue consumer (or cron drain) processes it with exponential backoff. This is what makes the HubDB ↔ Marketing Event ↔ Deal trio eventually-consistent and self-healing.

**Marketing Events API calls**
- `me.create` (up front): create the marketing event under the private app; store returned id against `external_event_id`.
- `me.register`: `POST /marketing/v3/marketing-events/attendance/{externalEventId}/register/email-create` with attendee email (creates contact if new).
- `me.attend`: `.../attendance/{externalEventId}/attend/create` (or `/email-create`) with `joinedAt` (+`leftAt` for online).
- `me.cancel`: `.../attendance/{externalEventId}/cancel/create`.
- `me.complete`: `POST /marketing/v3/marketing-events/events/{externalEventId}/complete` → triggers duration calc + No-Show.

These endpoints are **idempotent** on contact id + interaction time, so retries are safe.

**Attendance onto the contact (Phase 2.1)**
- `contact.sync_attendance`: PATCH the **attendee's** contact with an attended flag, the
  attendance date and the event name, per the tenant's mapping
  (`tenants.contact_attended_property` / `_attended_date_` / `_attended_event_`; NULL = the
  default `event_attended` / `event_last_attended_date` / `event_last_attended_name`,
  `'off'` = don't write that field). Enqueued by check-in and by `processAttendance` for a
  matched webinar record, in the same D1 batch as the state change.
- The attendance DATE is the calendar day in the tenant's `display_timezone`, not the UTC
  day. It was the UTC day, and at Adelaide's +9:30 that recorded the PREVIOUS day for any
  check-in before 9:30am local — most morning courses. Certificates issued before that fix
  may carry a date one day early.
- This is what **unblocks certificates**: Ollie's Data Hub flow renders and delivers off that
  contact property. The worker builds **no certificate** — rendering one here would give
  members two differently-shaped documents.
- The properties hold the LATEST attendance, not a history. The date **never moves
  backwards**: rows drain out of order, and a straggler for an older event must not overwrite
  a newer one. The event name only moves with the date it belongs to.
- The three properties are **provisioned by the worker**, not by hand:
  `POST /api/v1/manage/onboarding/properties` (also run as part of `/onboarding/provision`)
  creates them in an `Event Attendance` property group with the right types — the date as a
  HubSpot `date`, the flag as a `booleancheckbox`. `GET` the same path reports what is
  missing without changing anything. Idempotent, follows the tenant's mapping, and never
  re-types a property that already exists. Without the schema scope every entry comes back
  `manual`, carrying the definition to create by hand, rather than failing the install.
  The same routine provisions every other property the write-backs target — the join URL,
  remapped 1.2 fields, each 2.3 question's mapped property and the company voucher fields.
- Date format follows the property's HubSpot type (`datetime` → full ISO, anything else →
  `YYYY-MM-DD`, which both date types accept). The property-schema read uses an OPTIONAL
  scope, so an un-granted portal degrades to the calendar date rather than a dead row.

**Commerce calls**
- `deal.create`: create Deal, associate Contact/Company, attach ticket **Products** as line items.
- `invoice.create`: create HubSpot Invoice from the deal (GST line via imported Xero tax rate). Payment collected via Stripe (AUD); **invoice + payment sync to Xero via Data Sync by HubSpot** — no direct Xero call from the worker.

**Staff notes**
- `note.create`: mirror a `registration_notes` row onto HubSpot as a native **Note** engagement — `hs_note_body`, `hs_timestamp` (the note's own creation time, so a retry is identical), `hubspot_owner_id` resolved from the author's HubSpot user id — associated to the **attendee's** contact for a registration note, or the booking's **deal** for an order note. `registration_notes.hubspot_note_id` is stamped on success, so a retry cannot post the note twice. Notes write access is an OPTIONAL scope: a 401/403 skips the mirror and leaves the note in D1 rather than dead-lettering the row.

**Reconciliation sweep (cron, ~every 5 min):** find `registrations` where `state != marketing_event_state_synced`, or `orders` paid without `hs_deal_id`/`hs_invoice_id`, and re-enqueue. Re-drive `outbox` rows stuck in `failed` past backoff. Guarantees no silent drift between D1 and HubSpot.

---

## 7. Getting attendance data in (event created up front)

Because the Marketing Event exists from publish, the participation ledger is live immediately and registration writes `registered` on payment. The only missing signal is **`attended`** — five ingestion paths, all converging on the single `me.attend` write:

1. **QR check-in (primary, in-person).** Ticket QR is a signed token; the door device hits `POST /api/v1/checkin` → registration `attended` + `joinedAt`. Works offline-first with a queued sync if venue wifi is poor.
2. **Self-scan / kiosk.** Same endpoint, attendee-facing — a tablet at the door or a "tap to check in" link in the ticket email.
3. **Online events (Microsoft Teams — see §11).** For `mode=online`, the worker creates the Teams webinar via Graph, subscribes to the virtual-event webhook, and on the "attendance report ready" notification **pulls** `attendanceRecords` via Graph, matches each record's email to a registration, and fires `me.attend` with `joinedAt`/`leftAt`. (Teams pushes a "ready" signal, not per-attendee data — it's pull, not push.)
4. **Manual (native fallback).** Staff set status in the HubSpot UI directly on the contact/marketing event — no worker involved. The reconciliation sweep reads this back so D1 doesn't drift.
5. **Bulk CSV (native fallback).** Post-event import of attendance into the Marketing Event for offline/edge cases.

**Finalize:** a cron fires `me.complete` shortly after `ends_at`; HubSpot then computes attendance duration and auto-assigns **No-Show** to registered-but-not-attended contacts — which drives Weld's no-show follow-up workflow with zero extra worker logic.

> Design note: keep `attended` writes idempotent and let HubSpot own No-Show. The worker asserts register/attend; it never tries to compute no-show itself.

---

## 8. Security & multi-tenancy

- **Tenant resolution:** map incoming host/portal to a tenant config (HubSpot token, Stripe acct, signing key). Never share tokens across portals.
- **QR signing:** HMAC the ticket payload (`registration_id`, `event_id`, nonce) with a per-tenant key; verify on check-in to stop forged tickets.
- **Webhook verification:** Stripe signature + HubSpot signature; dedup via `webhook_events`.
- **Idempotency:** required `Idempotency-Key` on `reserve`; cached response in `idempotency_keys`.
- **Rate limiting:** per-IP on public reserve/availability to blunt scalper bursts.
- **Data residency:** pin D1 + DO to an AU region where available; document where registration/ticket PII lives (member-body requirement).

---

## 9. Lite path (no worker)

For uncapped/free events (RSVPs, webinars), skip the DO/D1 entirely: HubSpot form → workflow → `me.register`, manual or webhook `attend`, cron-equivalent `complete`. This is the productised **free tier** — fully native — and the worker tier upsells capacity, ticketing, waitlist, and check-in.

---

## 10. Build order (for Claude Code)

1. **Scaffold:** Hono worker, D1 migrations (schema above), Wrangler config, tenant resolver, secrets.
2. **`EventCapacity` DO:** reserve/confirm/release/alarm + D1 rehydrate; unit-test the oversell race explicitly (N concurrent reserves on 1 seat → exactly 1 winner).
3. **Public API:** availability, reserve (→ payment handoff), release, waitlist.
4. **Outbox + Queue consumer:** generic retry/backoff drainer; `me.create` on event publish.
5. **Stripe webhook → confirm → registrations/tickets → `me.register`.**
6. **Check-in API + QR signing;** `me.attend`.
7. **Teams integration (online events):** create webinar via Graph on publish, subscribe to virtual-event webhook, pull `attendanceRecords` on "report ready", email-match → `me.attend`. (Requires Weld tenant admin to grant the app-access policy first.)
8. **Cron:** hold expiry (via DO alarms), waitlist decisions (owner-resolved — Phase 18.3), `me.complete` after `ends_at`, reconciliation sweep.
9. **Commerce write-back:** deal + invoice creation; verify Xero receives invoice+payment with GST.
10. **Hardening:** idempotency, rate limits, signature verification, AU region pinning, load test the sell-out path.

---

## 11. Microsoft Teams webinar integration (online events)

Weld run online events as **Teams webinars**. Teams does **not** push per-attendee data; attendance comes from the **Microsoft Graph virtual-events APIs** in a two-step, organizer-scoped, pull-based flow. Design accordingly.

**Create the webinar via Graph (don't let organizers create ad hoc).**
On event publish for `mode in (online, hybrid)`, the worker calls Graph to create a `virtualEventWebinar`; it stores `teams_webinar_id` + `teams_session_id` against the event and binds them to `external_event_id`. This sidesteps the hard ID-mapping problem — the Graph object model separates calendar events from online meetings, so a join link alone can't resolve the meeting or its report. Owning the IDs from birth means no reverse-lookup by join URL later.

Creation payload (`POST https://graph.microsoft.com/v1.0/solutions/virtualEvents/webinars`):
```jsonc
{
  "displayName": "Weld Australia — Welding Standards Update",
  "description": { "contentType": "text", "content": "Live online session…" },
  "startDateTime": { "dateTime": "2026-07-15T10:00:00", "timeZone": "Australia/Adelaide" },
  "endDateTime":   { "dateTime": "2026-07-15T11:30:00", "timeZone": "Australia/Adelaide" },
  "audience": "everyone",                 // "everyone" for public events; "organization" = internal only
  "coOrganizers": [                        // the service organizer used for attendance pulls
    { "id": "<entra-user-objectId>", "tenantId": "<weld-tenant-id>" }
  ],
  "settings": { "isAttendeeEmailNotificationEnabled": false }  // HubSpot owns comms, not Teams
}
```
Returns a `virtualEventWebinar`; created in **draft** — call **publish** before it's joinable. A Graph-created webinar has a **single session** that inherits online-meeting properties; capture that `sessionId`.

> **Don't use Teams' own registration.** Teams *can* take registrations (`POST …/webinars/{id}/registrations`, which returns a per-registrant join URL), but registration is owned by **our worker** — it's the capacity/payment authority. Two systems both owning registration is the failure mode to avoid. Our flow: worker registers the attendee in Teams *programmatically* (so each gets a valid personalised join URL emailed via HubSpot), but capacity/payment/state all live worker-side. Note registration permissions differ by whether the registrant has a Microsoft Entra account; for public/anonymous attendees you need the anon registration permission.

**Disable Teams email notifications** (`isAttendeeEmailNotificationEnabled: false`) so attendees get one consistent set of comms from HubSpot, not duplicate emails from Teams.

**Get attendance out (pull, triggered by webhook).**
1. **One tenant-wide subscription** on `solutions/virtualEvents/events` (covers all our webinars for the app+tenant — not one sub per event). Virtual-event subscriptions max out at **1 day**, so a cron renews ~every 12h. Handle the **validation handshake** (echo `validationToken` on create) and **lifecycle notifications** (`reauthorizationRequired`, `subscriptionRemoved`, `missed`).
2. On an attendance-report-ready change notification: verify `clientState`, then **re-pull from Graph** (don't trust the payload). `GET /solutions/virtualEvents/webinars/{webinarId}/sessions/{sessionId}/attendanceReports` (legacy `/meetingAttendanceReport` path is deprecated).
3. For each report, fetch records **with `$expand=attendanceRecords`** (the nav prop isn't returned by default). Each record carries `emailAddress`, `role`, `totalAttendanceInSeconds`, `attendanceIntervals[]`, `registrationId`, and `externalRegistrationInformation.registrationId`.
4. **Match record → registration via a cascade:** (a) `externalRegistrationInformation.registrationId` = *our* id, stamped when we registered the attendee in Teams — exact, the preferred key; (b) Teams `registrationId` if we stored the mapping; (c) email, case-insensitive — weakest fallback. Filter to `role == "Attendee"` (skip presenters/organizers). Then enqueue `me.attend` with collapsed `joinedAt`/`leftAt`.
5. Records may log multiple join intervals (reconnects); **collapse to earliest-join / latest-leave** (use `totalAttendanceInSeconds` if you need true watched-duration). A registered attendee with **no** intervals never joined — leave them for No-Show.

> **Stamp our registration id at Teams-register time.** Set `externalRegistrationInformation.registrationId = registrations.id` when calling Teams' registration API. This makes matching exact and removes the "joined with a different email" failure mode — email becomes a fallback, not the primary key.

> **Safety net:** a cron also runs `pullAttendance()` once shortly after `ends_at` in case a webhook was missed, then fires `me.complete`. Full implementation in `teams-attendance.ts`.

**Auth / access (Weld-IT setup task — flag early):**
- Attendance APIs are accessible **only to the webinar organizer or co-organizer**.
- For unattended app access, a Weld **tenant admin must create an application access policy** granting the worker's app permission to fetch meeting artifacts on behalf of the organizer user. This is an admin action, not a self-serve OAuth scope — budget for an IT ticket.
- Decide the organizer identity: a dedicated Weld service/organizer account is cleaner than a staff member's, so reports don't break when people leave.

**Fallbacks** (unchanged): tracked "Join now" link click can flip `attended` if Graph access is delayed; manual status set or CSV import as native backstops. `me.complete` still runs post-`ends_at` so HubSpot assigns **No-Show** to registered-but-not-attended.

**Schema additions:**
```sql
ALTER TABLE events ADD COLUMN teams_webinar_id  TEXT;
ALTER TABLE events ADD COLUMN teams_session_id  TEXT;
ALTER TABLE events ADD COLUMN teams_join_url    TEXT;
-- dedicated tenant config: Graph app creds + designated organizer userId (per portal)
```

---

## 12. QR check-in (door app)

In-person attendance flows through a staff-operated check-in surface. Keep it dumb, fast, and offline-tolerant — venue wifi is the enemy.

**Ticket QR payload (signed, opaque).**
At ticket issue, the worker mints a code = base64url of `{ tid, eid, n }` (ticket id, event id, nonce) plus an **HMAC-SHA256** signature using a **per-tenant signing key**. The QR encodes `code.signature`. Nothing sensitive is in the payload; the signature is what makes it unforgeable. Optionally add a short `exp` so screenshots can't be reused across events.

**Verify on scan.**
`POST /api/v1/checkin { code }`:
1. Split code/signature; recompute HMAC with the tenant key; reject on mismatch (forged/edited).
2. Look up the ticket; confirm it belongs to this `event_id` and the registration is `registered` (not `cancelled`/`refunded`).
3. If `checked_in_at` already set → return `already_checked_in` with the original timestamp (idempotent, not an error — handles double-scans).
4. Set `tickets.checked_in_at` + `checked_in_by` (device/staff id); set registration `attended`; **enqueue `me.attend`** with `joinedAt = now`.
5. Return attendee name + ticket type for the door screen ("✓ Jane Smith — Full Conference").

**Offline-first device flow.**
The door app (PWA or thin mobile screen) must keep working when the connection drops:
- **Pre-sync:** on event open, device pulls the event's ticket manifest (hashed code list + names) into local storage. Verification is HMAC, so the device can validate a signature **locally without the server** using a device-scoped verify key (a derived key, not the master signing key).
- **Queue offline:** scans recorded locally with timestamp; on reconnect, flush to `/api/v1/checkin` in batch. Server stays idempotent so re-sends are safe.
- **Duplicate guard offline:** local store marks a code checked-in immediately so a second scan on the same device is caught even without network. Cross-device dupes resolve server-side via the idempotent write (first timestamp wins).

**Endpoints.**
- `POST /api/v1/checkin` — single scan (online or queued).
- `POST /api/v1/checkin/batch` — flush queued offline scans.
- `GET  /api/v1/checkin/manifest/:eventId` — pre-sync ticket list (auth: device token).
- `GET  /api/v1/checkin/stats/:eventId` — live attended/registered for the door dashboard.

**Auth.** Door devices use a short-lived, event-scoped **device token** (not a staff login, not the master key), issued from an authenticated admin session and revocable per event. Limits blast radius if a device is lost.

**Self-check-in variant.** Same endpoint, attendee-facing: a "tap to check in" link in the HubSpot ticket email (carrying the signed code) or a kiosk tablet. Useful for low-staff events; rate-limit to blunt abuse.

---

## 13. Deal → Invoice → Xero, and GST mapping

The money path must emit a **compliant Australian tax invoice** and reconcile cleanly to Xero. The worker creates the Deal + line items; HubSpot generates the Invoice; Stripe collects (AUD); **Data Sync by HubSpot** carries invoice + payment to Xero. The worker makes **no direct Xero call**.

**GST mechanics.**
- Installing Data Sync **imports Xero tax rates into HubSpot's tax library**. Use the imported **GST 10%** rate as the tax on each taxable ticket line item — don't hand-roll a tax percentage, or the synced Xero invoice won't reconcile to the right tax account.
- Each ticket-type **Product** carries its tax treatment. Most event tickets are **taxable (GST 10%)**; some may be **GST-free** (rare — confirm per Weld's tax advice). Store the treatment on the ticket type so the line item maps correctly:
```sql
ALTER TABLE ticket_types ADD COLUMN tax_treatment TEXT NOT NULL DEFAULT 'gst'; -- gst | gst_free
ALTER TABLE ticket_types ADD COLUMN hs_tax_rate_id TEXT;  -- imported Xero rate id from HubSpot tax library
```
- Member vs non-member pricing changes the **amount**, not the tax treatment — both are still GST-taxable at 10% unless advised otherwise.

**What makes it a valid ATO tax invoice (the invoice template/output must show all of these):**
1. The words **"Tax invoice"**.
2. **Seller identity + ABN** — Weld Australia's ABN. (Set on the HubSpot invoice/Xero org; verify it flows onto the rendered invoice.)
3. **Date of issue**.
4. **Brief description** of each item, with quantity and price (the ticket line items).
5. **GST amount** — shown separately, or the statement **"Total price includes GST"** where GST is exactly 1/11 of the total.
6. **Extent to which each sale is taxable** (matters if any line is GST-free — mixed invoices must distinguish).
7. **For invoices ≥ $1,000 (GST-inclusive): the buyer's identity or ABN.** Group/corporate registrations will routinely cross this — so **capture buyer ABN at checkout** when the order is a company purchase, and ensure it lands on the invoice. Build this in now; it's the most-missed requirement.

> Thresholds worth coding to: tax invoice must be provided on request for sales **≥ $82.50 inc GST**; the **≥ $1,000** rule adds the buyer-identity requirement. A single multi-ticket corporate order easily exceeds $1,000.

**Reconciliation states (worker-side, guarding the sync):**
- `order.paid` but no `hs_deal_id` → deal create failed; re-enqueue `deal.create`.
- `hs_deal_id` set but no `hs_invoice_id` → invoice create failed; re-enqueue `invoice.create`.
- `hs_invoice_id` set but Xero shows no matching invoice → Data Sync lag or failure; alert after N minutes (don't silently assume).
- **Refund:** per-event refund policy (Phase 18.2) — full / partial% / none from days-until-event vs the policy cutoff. Full refunds void the HubSpot invoice; partial refunds refund the computed amount on the payment. Either way order `refunded`/`partially_refunded` → registration `cancelled` → `me.cancel` → the **credit note / negative sync** reaches Xero via Data Sync. The webhook-driven Stripe void path still maps to a full refund.
- **One paid order = one Deal = one Xero invoice.** Dedup on `order_id`; never let a retry create a second deal/invoice (idempotency key on the outbox row).

**Free events ($0):** no invoice needed; optionally a $0 deal for consistent reporting. Don't emit a "tax invoice" for a $0 taxable supply — issue nothing, or a plain confirmation (not a tax invoice).

---

## 14. Open questions

- **Teams organizer identity** — dedicated service account vs named staff (affects Graph app-access-policy setup and long-term report access).
- **Hybrid events** — STILL OPEN (Q6). If an event is both in-person and Teams, attendance can arrive from QR *and* Graph; dedupe on registration so `attend` isn't double-counted (idempotent write already guards HubSpot, but reconcile `joinedAt` source).
- **Offline check-in** tolerance at venues — how robust must the queued-sync door app be?
- **Group registration** (one buyer, many named attendees) — MVP or phase 2? Schema supports order→many registrations; UI/flow is the question. For Teams, each named attendee needs their own join identity/email.
- **Queues vs cron-only drain** for the outbox at Weld's volume — start cron, add Queues if throughput needs it.

### Resolved by Phase 18 (Weld's confirmed answers)
- **Member pricing** — tiered by membership **level + category** (corporate / industry
  supplier / individual), not a single `member_price_cents`. See `pricing_rules`
  (most-specific wins: ticket_type > event > portal). `price_cents` is the standard price.
- **Refunds** — per-event policy (full / partial / **transfer**), default full-to-30-days,
  resolved event policy > category default ("team" = event category) > portal default. Transfer
  reassigns a registration to a new attendee without refunding (seat kept, ticket reissued).
- **Late-payment oversell** — **no automation.** Order → `needs_review`, a pending decision +
  HubSpot task is assigned to the event owner who honours or refunds. The old "auto-refund
  default + `allow_oversell` force-honour" is removed.
- **Waitlist promotion** — **no automation.** A freed seat opens a waitlist decision + owner
  task; the owner picks who to offer to (signed offer token, 30-min TTL). `joinWaitlist` still
  records waiters. (Replaces "auto-promotion policy: first-come vs notify-all".)
- **GST** — default-on (`gst`), per-ticket `tax_treatment` toggle in the admin App Card;
  `gst_free` maps to the imported Xero GST-free rate.
- **Certificates** — deferred; the data model already supports them (no work now).