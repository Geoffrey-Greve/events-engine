# Operating workflows — who does what, in what order

[flows.md](flows.md) traces the code path a booking takes. This document answers the other
question: **which human does what, on which surface, in what order**, and what has to exist
before any of it works.

Read it before staging UAT. Where this document and the code disagree, the code wins and
this document is the bug.

> ## Scope: read this first
>
> This document lands on **`Dev-Portal`**, and it is not yet uniformly written against it.
>
> **Verified against `Dev-Portal`:** the roles table, the tenant-status note, the corporate
> voucher and audit sections, and the staging scenarios. Differences from `main` are called
> out inline where they matter.
>
> **Still written against `main`, and therefore incomplete here:** the creating-an-event and
> invoice sections do not yet cover what `Dev-Portal` adds — roughly 12,000 lines across 40
> worker source files. The ones that change the workflows in this document are:
>
> - **Course components.** Registering for individual modules. Modules are child `events`
>   rows (`parent_event_id`, `course_component_kind`, `course_component_order`,
>   `course_module_product_id`, `course_package_required`), each created like any other
>   event, held atomically across every child's own capacity DO by `course-bundle.ts`, and
>   exposed as `POST /api/v1/events/:slug/reserve-course-package` and
>   `GET /api/v1/events/:slug/course-components`. **No CMS asset in this repo calls either
>   endpoint**, so the front end for it is either in Weld's theme or not yet built.
> - **Invoice eligibility (Phase 4.1 / 4.2).** Which buyer may pay on terms rather than at
>   checkout, and so whether the seat is held for 15 minutes or until the invoice due date.
>   Eligibility resolves most-specific-first (contact property > company property >
>   membership level > always); a portal with no rules treats every paid booking as eligible,
>   and any failure degrades to eligible rather than shortening a live hold.
> - **Two more decision types**, `fast_sellout` and `contact_conflict`, alongside `oversell`
>   and `waitlist`.
> - `cancel.ts`, `questions.ts`, `reissue-invoice.ts`, `reporting.ts`, `exports.ts`,
>   `notes.ts`, `properties.ts`, `timezone.ts`, `attendance-writeback.ts`,
>   `attendee-contact.ts`, `amend.ts`, `capacity-guard.ts`, unlimited capacity, and
>   `ticket_types.internal_only`.
>
> **`claude/membership-price-errors-7q4fiv` (PR #34)**, not merged anywhere yet, makes HubDB
> the source of truth for **member prices** via `hubdb-pricing.ts`, read live at reserve time
> with `pricing_rules` as the fallback.

### One thing that is true on all three refs

**Nothing creates a D1 `events` row from HubDB.** `loadEvent` is a plain
`SELECT * FROM events WHERE portal_id = ?1 AND id = ?2` on `main`, on `Dev-Portal`
(`db.ts:112`) and on PR #34, and a miss throws `event_not_found` with no fallback. The only
in-repo writer is `POST /api/v1/manage/events`. Existing Weld rows whose `hubspot_event_id`
carries a HubDB row id (`course-session-…`, `course-…`, `hubdb-event-…`) were written by
**importers that live outside this repo** — see the docstring on `resolveHubDbCourseRowId`.
PR #34 reads HubDB at reserve time for **price only**, and requires the D1 event to exist
already.

`:slug` is always the D1 UUID on every ref, never a HubDB row id, and the same `SELECT`
backs `/availability`. The CMS module reads the slug from the HubDB row's `worker_event_id`
cell, so a blank cell means an empty slug and a 404 from both endpoints, with nothing
recovering and no error shown to the buyer. Expect a population of rows to have it blank:
it is the same empty cell PR #34 works around for pricing.

---

## 0. Roles

There is no user account system in the worker. A "role" is **which credential the request
carries**, and there are only six. Every organiser-facing surface lives inside HubSpot, so
HubSpot's own permissions decide who can open a card; the worker checks the credential
behind it and nothing else.

| Role | How the worker identifies them | Surface | Reach |
| --- | --- | --- | --- |
| **Buyer / attendee** | nothing. `X-Portal-Id`, plus `Idempotency-Key` on reserve. IP rate limited | public CMS event page, HubSpot-hosted invoice page, confirmation email | `GET /api/v1/events/:slug/availability`, `POST /api/v1/events/:slug/reserve`, `GET /api/v1/orders/:id` |
| **Tenant admin** — in practice also the event owner | `ADMIN_API_KEY_{portalId}` as `Authorization: Bearer` or `X-Admin-Key`, plus `X-Portal-Id`, compared constant-time (`checkin.ts:362`) | the **Event Capacity & Tickets** App Card on the Marketing Event record, which sends this key from the iframe | all of `/api/v1/manage/*` — events, ticket types, pricing rules, manual bookings, refunds, transfers, decisions, onboarding config, diagnostics. Also mints check-in device tokens and starts provider connect flows |
| **HubSpot portal user** (App Home) | HubSpot v3 request signature over method + URL + body + timestamp, 5-minute replay window. Portal id and acting user come from **signed query metadata**, never a header | App Home page | six read-mostly endpoints plus staff manual booking (`app-home.ts:376`) |
| **Corporate team manager** | **no worker credential.** `actorContactId` is supplied in the body and verified live against HubSpot: the actor must hold an `Admin` or `Primary Admin` association label on the company | Weld private member portal | `POST /api/v1/corporate/add-employee`, `/remove-employee`, `/bulk-register` |
| **Door staff** | event-scoped **device token**, 12h default / 24h max, minted with the admin key | check-in PWA — the only non-HubSpot UI, because it has to work offline | `POST /api/v1/checkin`, `/checkin/batch`, `GET /manifest/:eventId`, `/stats/:eventId`, own event only (403 otherwise) |
| **Refuel ops** | `ADMIN_SECRET` bearer | curl / wrangler | `POST /admin/provision/:portalId`, `PATCH /admin/tenants/:portalId/status` |
| **Machines** | per-provider signature on `/webhooks/*`, plus the `*/5`, `*/15` and `0 */12` crons | — | HubSpot invoice and payment, app uninstall, Graph, Zoom, Refuel billing |

### Four things about roles that will otherwise surprise you

1. **"Event owner" is not an authorisation identity.** `events.hubspot_owner_id` is used
   only to *assign* the HubSpot task for an oversell or waitlist decision
   (`decisions.ts:66,80`). `resolveDecision` authorises on nothing but the portal id from
   the admin key, and `resolvedBy` is unvalidated free text. Any holder of the admin key can
   resolve any decision on that portal.
2. **The App Card is a shared tenant key, not a per-user identity.** The card embeds
   `adminApiKey` as a card property and sends it as a bearer token
   (`cards/shared/use-extension-props.ts:29`). Any HubSpot user who can load the card — or
   anyone who extracts the key — is a full tenant admin. There is no owner check, no per-user
   check, no role table. Only App Home uses a real signed request, and even that proves
   "HubSpot, this portal", not "this user is allowed".
3. **The corporate endpoints have no worker-level auth at all** — no bearer, no signature,
   no rate limit. `X-Portal-Id` must match `body.portalId`, which is an integrity check, not
   authentication. Anyone knowing `portalId` + `companyId` + an admin contact id can add or
   remove employees and spend that company's vouchers. `corporate_team_audit` records
   authorisation and business-rule outcomes — self-removal, unauthorised actor, contact not
   linked, missing employee email — but **not every attempt**.
   Requests rejected by the pre-authorisation validation return before any audit write:
   an unparseable body, malformed ids, a `X-Portal-Id` / `body.portalId` mismatch, a missing
   session, an empty employee list, a missing `Idempotency-Key`, a missing HubSpot token,
   and later a missing actor email. Do not read the table as a complete access log.
4. **`GET /api/v1/orders/:id` is unauthenticated and not rate limited.** A portal id and an
   order UUID return the order status and the HubSpot payment URL. Cancelled and refunded
   orders deliberately return `paymentUrl: null`.

There is also **no public ticket endpoint**. A QR code is only ever exposed through the
device-authenticated check-in manifest and through whatever HubSpot puts in the
confirmation email. Do not write a test that expects a buyer-facing ticket URL.

---

## 1. Creating an event

There are **three separate "event" records and no automated sync between them.** This is
the single most common source of "I created the event and nothing happened".

| Record | Lives in | Created by |
| --- | --- | --- |
| HubSpot **Marketing Event** | HubSpot CRM | a human, in HubSpot. Exists first |
| D1 **`events` row** | Cloudflare D1 | `POST /api/v1/manage/events` — the only entry point |
| HubDB **`events` row** | HubSpot HubDB | a human, in the HubDB editor. **The worker never writes HubDB rows** |
| **EventCapacity** Durable Object | Cloudflare | itself, lazily, on the first availability or reserve call |

The join key is `events.hubspot_event_id`. When the App Card creates the event it is the
Marketing Event's CRM `objectId`, read off the record the card is mounted on. When an
out-of-repo importer created it, it is the **HubDB row id** instead
(`course-session-<id>`, `course-<id>`, `hubdb-event-<id>`, or bare), which is how most of
Weld's live events are addressable. Both shapes are valid; `resolveHubDbCourseRowId` exists
to tell them apart.

**The HubSpot Marketing Event is created lazily, on the first registration**, not when the
event is created — the first `me.register` job upserts it using `hubspot_event_id` as the
`externalEventId` and back-fills `hubspot_marketing_event_object_id`. So an event can be
live and bookable with no Marketing Event in HubSpot yet, and that is correct.

### Step 0 — tenant prerequisites (once per portal, not per event)

| Setting | Consequence if missing |
| --- | --- |
| `stripe_processor_connected = 1` | every paid reserve returns **`payment_not_configured` (409)** |
| `xero_gst_rate_id`, the **Xero-imported** rate | same 409. A hard-coded 10% produces an invoice Xero will not reconcile |
| CRM routing (pipeline, stage, deal type) | deals land in the wrong pipeline |
| membership property mapping | every buyer resolves unverified or non-member, so member pricing never applies |
| webinar provider credentials | online events cannot be provisioned |

Tenant `status` does **not** gate booking. Nothing in reserve, manage or the corporate
handlers reads it; the only read is `manage.ts:2457`, which maps `status === 'active'` to
the onboarding response's `publishingEnabled` flag. A tenant sitting at `installed`,
`past_due` or `cancelled` can still be booked through if its events and payment mapping
exist. Treat `status` as a lifecycle label for the onboarding UI, not access control.
`GET /api/v1/manage/diagnostics/hubspot/tax-rates` lists the portal's rate library so you
can find the imported id.

### Step 1 — create the HubSpot Marketing Event

Native HubSpot. This is the system of record for participation (register, attend, cancel,
no-show). Create it in HubSpot; never let an organiser create a Teams webinar ad hoc,
because the worker has to own the webinar ids.

Note: `externalAccountId` is **the portal id itself** — there is no separate field to
configure for Weld's single-portal setup.

### Step 2 — register the event with the worker

On the Marketing Event record open the **Event Capacity & Tickets** tab. If no worker event
exists the card renders a create form, which posts `POST /api/v1/manage/events`:

```jsonc
{
  "hubspotEventId": "…",   // required — the Marketing Event objectId
  "title": "…",            // required
  "startsAt": "…",         // required, ISO 8601 UTC
  "endsAt": "…",           // required
  "capacity": 50,          // required — event-level cap
  "location": "…",         // optional
  "bookingKind": "course", // optional, "event" | "course", default "course" — drives CRM routing
  "provider": "teams",     // optional — omit for in-person
  "allowOversell": false   // optional, and effectively inert: oversell is human-resolved
}
```

All five required fields or **400 `missing_fields`**. One event per
`(portal_id, hubspot_event_id)`; a second create is **409 `conflict`**, which is what a
re-run test script will hit.

The response `id` is the **worker event id**. It is the `:slug` in every public URL. Not the
HubSpot id, not a URL slug. There is **no DELETE** for events or ticket types anywhere.

### Step 3 — ticket types. This is the step that gets skipped

`POST /api/v1/manage/events/:id/ticket-types` — `name`, `priceCents`, `capacity` required;
`currency` (default AUD), `taxTreatment` (`gst` default, or `gst_free` — anything else is
400 `invalid_tax_treatment`), `memberOnly`, `sortOrder`, `hsProductId`, `hsTaxRateId`
optional.

**An event with zero ticket types returns `no_ticket_types` (404) on every reserve.** That
is the most common cause of "the event exists but isn't bookable".

Capacity is enforced at **both** levels — the event cap and the per-type cap. There is no
per-session capacity. `hs_tax_rate_id` is back-filled from the tenant's `xero_gst_rate_id`
at reserve time when it is null and the type is not GST-free.

There is no `is_public` column. Import-only ticket types are identified by a **naming
heuristic** (`turnstile.ts:42`): an id matching `tt_cams_import_*` or a name matching
`imported cams registration`. They are hidden from `/availability` and rejected on public
checkout with `ticket_not_available`, but remain usable for staff manual bookings.

### Step 4 — member pricing (optional)

`POST /api/v1/manage/events/:id/pricing-rules` — `scope` (`ticket_type` | `event` |
`portal`), `scopeId`, `memberLevel`, `memberCategory`, and one of `discountPercent` or
`fixedPriceCents`. Most specific wins: ticket_type > event > portal. No matching rule means
the buyer pays standard, which is the intended failure mode, not a bug.

Keep the two mechanisms distinct: `memberOnly` on a ticket type is the **gate**; a pricing
rule is the **discount**.

### Step 5 — policy, category, owner (optional, but set them)

`PATCH /api/v1/manage/events/:id` with `refundPolicyId`, `category`, `hubspotOwnerId`. All
three are nullable and **none of them blocks a reserve**:

- no `refundPolicyId` → falls through category default → portal default → the built-in
  fallback (full refund to 30 days, transfers allowed);
- no `category` → no category-default policy match and no category-scoped pricing rule;
- no `hubspotOwnerId` → **oversell and waitlist decisions are still created, but no HubSpot
  task is assigned to anybody.** The first symptom is a customer asking where their seat
  went. Set it.

### Step 6 — online events only

Set `provider`, then `POST /api/v1/manage/events/:id/provision-webinar`. Reserve also
provisions lazily on first use, but that path races and swallows failures — a provisioning
failure **does not fail the reserve**, it just leaves a null join URL. Pre-provision so a
failure is visible. Teams creates the webinar in **draft**; it must be published or nobody
can join.

### Step 7 — publish the public page (entirely manual)

Nothing syncs D1 to HubDB. In the HubDB editor:

- `events` row: `worker_event_id` = the id from step 2, `hs_path` set, status published;
- `ticket_types` rows: `worker_ticket_type_id` = each D1 ticket type id, and
  `event_path` = the event row's `hs_path` — ticket types join by **path, not FOREIGN_ID**,
  and you have to keep that in sync by hand (`packages/hubspot/src/hubdb/README.md`);
- publish both tables.

The registration module reads `event.worker_event_id` and refuses to initialise without it
(`module.html:31`, `module.js:55`). A blank or stale value means the form renders and
silently does nothing — no error, no network call. HubDB carries **no counts**; all
availability comes from the worker.

> **Weld portal (`443253065`):** it has its own hand-built `events` table (`2209273286`, 25
> columns, `useForPages` on) and its ticket types ride on the event row in
> `ticket_types_json`. **Never run provisioning against it** — record the table id on the
> tenant row instead. See `docs/dev-environment.md` on the `Dev-Portal` branch.

### Step 8 — nothing to do for the DO, or for the Marketing Event upsert

The Durable Object seeds itself: every `/availability` and every `/reserve` calls
`syncCapacityFromD1` first, and a cold DO rehydrates from D1 on construction.
`POST /api/v1/manage/events/:id/rebuild-capacity` forces a full rebuild — use it after a
bulk import or a capacity edit you want applied immediately, not routinely.

**The HubSpot Marketing Event is upserted lazily, on the first `me.register` job** — not at
event creation, as noted at the top of this section. So
`events.hubspot_marketing_event_object_id` stays **null until somebody registers**. That is
expected; do not raise it as a defect. (The `me.create` outbox topic is declared and handled
but never enqueued; the spec describes an earlier design.)

### Step 9 — verify

```bash
curl -H 'X-Portal-Id: <portalId>' \
  https://<worker-host>/api/v1/events/<workerEventId>/availability
```

A 200 listing your ticket types with `soldOut: false` means it is bookable end to end.
`available: null` means uncapped, not broken.

---

## 2. Booking a seat

Four entry points. All converge on the same reserve logic and the same Durable Object, so
the seat guarantee is identical; what differs is auth, pricing input and hold length.

### 2a. Public paid checkout — the default

```
buyer submits the registration module
  → POST /api/v1/events/:workerEventId/reserve   (X-Portal-Id, Idempotency-Key)
      validate → membership gate → duplicate gate → server-side pricing
      → EventCapacity DO grants a HOLD, TTL 15 minutes
      → one D1 batch: reservation, order (pending), registrations,
        outbox me.register / deal.create / invoice.create
  → 200 { status: "reserved", orderId, pollUrl }

queue drains: deal + line items, then invoice draft → associate → OPEN
buyer polls GET /api/v1/orders/:id until paymentUrl appears
  → HubSpot-hosted invoice → Stripe (AUD) → HubSpot marks it paid
  → POST /webhooks/hubspot → confirm_payment
      → DO commits the seat → order paid, ticket minted
```

**The seat is a hold, not a sale, until payment confirms.** Nothing between reserve and
confirm counts. That is what makes the oversell case in §3 both possible and correct.

Three terminal shapes: `reserved` (poll for payment), `confirmed` (free or complimentary,
tickets already issued), `waitlisted` (event was full).

Stable refusal codes worth branching on: `no_ticket_types`, `members_only`,
`membership_unverified`, `duplicate_attendee`, `price_mismatch`, `payment_not_configured`,
`ticket_not_available`, `turnstile_required`, `offer_expired`. Full table in
[api-reference.md](api-reference.md).

### 2b. Free / public complimentary

Same handler, `totalCents === 0`. Order and reservation are created **confirmed**, tickets
minted in the same batch and returned in the response — no polling, no invoice. This is the
one path that requires a **Turnstile** token, and only when a Turnstile secret is configured
for the portal. Paid public checkout has no bot gate.

### 2c. Staff manual booking — the invoice-terms path

App Card or App Home → manual registration.
`POST /api/v1/manage/events/:id/registrations` (or the App Home equivalent), with `mode`:

- **`complimentary`** — confirmed immediately, ticket issued, zero-dollar deal for
  reporting, no invoice.
- **`paid`** — invoice raised as usual, but the seat is held **until the invoice due date**
  rather than 15 minutes. `invoiceDueDate` (`YYYY-MM-DD`) defaults to **+30 days**, is capped
  at **90**, must be in the future, and expires at `23:59:59.999Z` on that date. Anything
  else is `invalid_invoice_due_date` (400). The same date is written to HubSpot as
  `hs_due_date`.

That is the closest thing in the system to an invoice being "approved": a staff member
extending credit by holding a seat against an unpaid invoice. It is a decision about the
**hold**, not about the invoice. Public checkout and complimentary bookings never reach it.

### 2d. Corporate bulk register — vouchers

`POST /api/v1/corporate/bulk-register`. The actor must hold an `Admin` or `Primary Admin`
association label on the company, re-read from HubSpot on every call, and each target
contact must already be linked to that company.

**Vouchers are credit, not a quota.** A company short of balance is **not** blocked. Its
vouchers cover whole seats, most expensive first, and any remaining seats are invoiced at
the normal price. There is no `insufficient_vouchers` rejection — do not write a test that
expects one.

`tenants.voucher_mode` picks the unit: `seat` counts whole seats (the default), `credit`
counts cents, `off` disables redemption. `loadVoucherConfig` also names which company
properties hold the total and the used figure, so they are not necessarily
`vouchers_total` / `vouchers_used`.

Balance is computed against **D1, not the HubSpot property**, and `encumbered` counts
`pending` and `needs_review` alongside settled usage, so a seat counts from the moment it is
held rather than only once it settles. The HubSpot property is a lagging projection — never
reason about a failure from it.

**Redemption is not serialised.** `resolveVoucherBalance` is a read, and several HubSpot
round-trips separate it from the D1 batch that creates the orders. Nothing locks a company's
balance: the EventCapacity DO serialises seats on an *event*, which is a different key. Two
`/bulk-register` calls for the same company that overlap in that window can both read the
same `available` figure and both redeem against it, so the company can redeem more credit
than it holds. Counting `pending` narrows the window; it does not close it. Seat capacity is
unaffected — the DO enforces that — so the failure mode is an over-redeemed balance, not an
oversold event.

---

## 3. Invoices: there is no approval step

**Nothing in the worker accepts or rejects an invoice, and no role performs that action.**
There is no endpoint, no outbox topic, no queue kind, no order status and no
`pending_decisions` type that expresses invoice approval. No intermediate "awaiting
approval" state exists. If a test plan is written around an approve/reject screen, that
screen does not exist and the test maps to nothing.

What happens instead: the queue creates the invoice and **opens it automatically**, and the
buyer pays it.

```
deal.create    → HubSpot deal + line items, associated to contact and marketing event
invoice.create → requires the deal (retries if it hasn't landed yet)
                 upsert buyer contact
                 POST /crm/v3/objects/invoices, currency + dates only     → DRAFT
                 ►► persist hubspot_invoice_id IMMEDIATELY
                 associate contact (PRIMARY)
                 create FRESH line items (not the deal's) + the Xero-imported GST rate
                 associate deal
                 re-check order status — void instead of open if it was cancelled meanwhile
                 PATCH hs_invoice_status → OPEN
                 GET hs_invoice_link → orders.hubspot_invoice_url
```

Step 7 is what the buyer's poll waits on. An invoice cannot be opened without a contact and
at least one line item, and `paid` is never sent on create. Persisting the id before the
follow-up calls is what stops a retry creating a second payable invoice.

Invoice status is only ever set by the worker (`draft` → `open`, or `voided`) or read back
from HubSpot via the webhook and the reconcile cron. `voided` is the only negative state
the worker recognises; "rejected" does not exist as a state.

### Where a human actually intervenes

Four real mechanisms. Map any "accept / reject" requirement onto one of these.

| What you might mean | Actual mechanism | Who | Where |
| --- | --- | --- | --- |
| Buyer never pays | the hold lapses on its own — 15 min public, the due date for a staff invoice. Reservation → `expired`, order → `cancelled`, seat freed. If an invoice was already issued, a double-guarded `payment.refund` outbox row (`kind: full`, `reason: expired_hold`) voids it exactly once | nobody. Automatic, DO alarm | — |
| Cancel an issued invoice | **void it natively in HubSpot.** The webhook (`hs_invoice_status = voided`) enqueues `refund_payment` → seats freed, order refunded or cancelled, tickets voided, `me.cancel` per attendee. No HubSpot-side refund is issued, because the void already happened there | event owner or finance | the HubSpot invoice record |
| Refund after payment | `POST /api/v1/manage/events/:id/registrations/:regId/refund`. The resolved policy decides full / partial / none; full voids the invoice, partial refunds the amount against the payment | anyone holding the tenant admin key | App Card |
| Payment landed after the seat was gone | **oversell decision** — payment captured, seat *not* committed, order → `needs_review`, HubSpot task to `events.hubspot_owner_id`. Owner picks **honour** (force-commit + issue ticket) or **refund** (per policy) | the same admin key; the owner id only routes the task | App Card → pending decisions, or `POST /api/v1/manage/decisions/:id/resolve` |

`GET /api/v1/manage/events/:id/pending-decisions` lists what is waiting. There is no dual
control on refunds: a single admin-key call executes one.

### The two genuine human gates in the whole system

Deliberate, from Phase 18.3. `pending_decisions` has exactly two types and the worker never
auto-resolves either:

1. **Oversell** — no `allow_oversell` auto-honour, no auto-refund default.
2. **Waitlist promotion** — a freed seat does **not** auto-offer to the next person. It opens
   a waitlist decision and an owner task; a human chooses who to offer to. Joining the
   waitlist is automatic; only promotion is manual. The DO re-validates at confirm, so a
   chosen offer still cannot oversell.

Both are **seat** decisions, not invoice decisions. The refund branch happens to void an
invoice as a side effect of releasing a seat.

Everything else — invoice opening, payment confirmation, seat commit, ticket issue,
attendance write-back, voucher accounting — is automatic and idempotent. There is also no
approval on staff manual bookings and none on corporate bulk registration beyond the
voucher-balance gate.

### The self-healing paths

`reconcileHubSpotInvoices` on the `*/5` cron polls up to 25 orders that are `pending` or
`cancelled` and carry an invoice id, reads the real status from HubSpot, and drives the same
`confirmPayment` / `handleRefund` paths as the webhook. It is a poll of HubSpot's status, not
a human review queue. A missed payment webhook self-heals within five minutes. The `*/15`
reconcile sweep re-enqueues stalled outbox rows. Do not call either a defect until a cycle
has passed.

---

## 4. End to end, by role

| # | Stage | Actor | Role | Surface | System of record |
| --- | --- | --- | --- | --- | --- |
| 1 | Portal onboarding | Weld admin | tenant admin | App Home wizard | D1 `tenants` |
| 2 | Create Marketing Event | Weld staff | HubSpot user | HubSpot, native | HubSpot Marketing Event |
| 3 | Register capacity, ticket types, pricing, policy, owner | Weld staff | tenant admin key, via the App Card | App Card on the Marketing Event | D1 `events`, `ticket_types`, `pricing_rules` |
| 4 | Publish the page | Weld marketing | HubDB editor | HubDB row + CMS dynamic page | HubDB |
| 5 | Browse and reserve | attendee or buyer | buyer | CMS page + registration module | D1 `reservations`, EventCapacity DO |
| 6 | Pay | buyer | buyer | HubSpot-hosted invoice → Stripe (AUD) | HubSpot invoice, Stripe |
| 7 | Confirm seat, issue ticket | — | machine | webhook or `*/5` cron → queue | D1 `orders`, `tickets` |
| 8 | Confirmation, `.ics`, reminders, QR | — | machine | HubSpot workflows and emails | HubSpot |
| 9 | Oversell or waitlist decision | Weld staff | tenant admin key; task assigned to the event owner | App Card → pending decisions | D1 `pending_decisions` |
| 10 | Refund or transfer | Weld staff | tenant admin key | App Card | D1, plus a `payment.refund` outbox row |
| 11 | Corporate seats | member company admin | corporate team manager | Weld member portal | D1 `orders.member_company_id`; HubSpot projected |
| 12 | Attendance, online | — | machine | Graph notification → pull → `me.attend` | HubSpot Marketing Event |
| 13 | Check-in, in person | venue staff | door staff, device token | check-in PWA, offline capable | D1 `tickets`, `me.attend` |
| 14 | Finalise | — | machine, `*/5` cron | `me.complete` | HubSpot Marketing Event |
| 15 | Accounting | — | machine | HubSpot Data Sync → Xero | Xero |

**The worker makes no direct Xero calls.** Its money job ends at opening the HubSpot invoice.

---

## 5. Staging test plan

### 5.0 Confirm which environment

Three deployments, and they must never share resources: **production**, **staging**
(`event-engine-db-staging`, `event-engine-jobs-staging`), and the newer isolated **dev**
environment for the Weld HubSpot test portal (`event-engine-dev` / `event-engine-db-dev`,
documented in `docs/dev-environment.md` on the `Dev-Portal` branch). Establish which one you
are testing first — the HubSpot portal, the Stripe mode and the secrets all differ.

Never copy production bookings, contacts, invoices or payment data into either.

### 5.1 Prerequisites

Worker:

- [ ] revision deployed (`pnpm deploy:staging`), `GET /health` green
- [ ] migrations applied (`wrangler d1 migrations apply event-engine-db-staging --remote`)
- [ ] `ADMIN_API_KEY_{portalId}` set — without it the App Card and every manage call 401
- [ ] `ADMIN_SECRET` set for ops calls. It is Worker-global and grants access across every
      tenant in the deployment, so do not hand it round as a shared UAT credential
- [ ] `TOKEN_ENCRYPTION_KEY` (64 hex), `HUBSPOT_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI`,
      `HUBSPOT_WEBHOOK_SECRET`
- [ ] `CMS_ALLOWED_ORIGIN` includes the test CMS domain, or CORS blocks the module
- [ ] Turnstile secret — note this now gates EVERY public booking, not just free ones, so
      with it set every public reserve below needs a token, and with it unset none do

Tenant row:

- [ ] `stripe_processor_connected = 1`, `xero_gst_rate_id` = the **Xero-imported** rate id,
      `xero_gst_free_rate_id` if testing `gst_free`. These two **are** enforced: a paid
      reserve without both returns `payment_not_configured` (409)
- [ ] `status = 'active'` so the App Card reports `publishingEnabled`. It does not gate
      booking (§1), so leaving it at `installed` will not fail a reserve
- [ ] CRM routing and membership property mapping configured
- [ ] `hubdb_events_table_id` **recorded, not provisioned**, for an existing-schema portal

HubSpot test portal:

- [ ] app installed with the scopes in [ops-runbook.md](ops-runbook.md) §1.2
- [ ] webhook subscriptions on Invoice `hs_invoice_status` **and** Payment object change,
      endpoint `https://<worker-host>/webhooks/hubspot`
- [ ] Stripe connected in **test mode**, AUD
- [ ] `GET /api/v1/manage/diagnostics/hubspot` clean

App Card:

- [ ] `workerBaseUrl` and `adminApiKey` card properties set, or the card renders
      "workerBaseUrl card property is not configured"

### 5.2 Test data

There is **no staging seed file** — `seeds/seed_dev.sql` is local-only and is deliberately
outside `migrations/`. Staging events are created through the App Card, so building the
fixtures below is itself the first test of §1.

| Data | Why |
| --- | --- |
| Event A: in-person, capacity **2**, one member-only ticket type and one general | a small cap is what makes sold-out, waitlist and oversell reachable in minutes |
| Event B: online (Teams), capacity 5 | attendance pull, join URL, `me.complete` |
| Event C: free, capacity 5 | the immediate-confirm branch (Turnstile gates every public booking, not only this one) |
| Event D: created with **no ticket type** | proves the `no_ticket_types` failure mode |
| Contact: **confirmed member**, level + category matching a pricing rule | tiered pricing |
| Contact: **unverified member** — blank status on the contact, set on the company | must return `membership_unverified`, not `members_only` |
| Contact: **non-member** | standard price, blocked from member-only |
| Company with a voucher total set on the property `loadVoucherConfig` resolves, plus a contact labelled **Admin** on it. Exercise `tenants.voucher_mode` in both `seat` and `credit` | corporate bulk register |
| A real HubSpot user id on `events.hubspot_owner_id` for A and B | decision tasks land somewhere |
| A device token for Event A | check-in |
| Refund policies: full-to-30-days, partial, and one with `allow_transfer` | policy resolution |

`POST /dev/seed-ticket` (404 unless `DEV_SEED_ENABLED=true`) mints a paid order,
registration and signed ticket against an **existing** event — use it to exercise the PWA
without going through checkout.

### 5.3 Scenarios

Run in order; later ones depend on state earlier ones leave. Each names where to verify,
because a 200 is not evidence the write-back happened.

**Reset seats before each capacity case.** Event A holds only two seats, and the scenarios
before #12 consume both — #5 commits one, #8 leaves a live hold on the other. Run #12, #13,
#14 and #17 against a **fresh capacity-2 event** each (A2, A3, A4, A5), or expire and refund
Event A's outstanding orders and confirm `GET /availability` reads 2 again before starting.
Run in order without doing so and #12 is `waitlisted` rather than expiring, and every
later capacity assertion inherits the ambiguity.

| # | Scenario | Expect | Verify in |
| --- | --- | --- | --- |
| 1 | Reserve on Event D | **`no_ticket_types` (404)** | response |
| 2 | `GET /availability` on Event A | counts match `capacity`, per ticket type | response |
| 3 | Public paid reserve, non-member, general ticket | `reserved` + `pollUrl`, DO hold, order `pending` | `orders`, `reservations` |
| 4 | Poll `GET /orders/:id` | `paymentUrl` appears once `invoice.create` drains | `orders.hubspot_invoice_url` |
| 5 | Pay with a Stripe test card | order → `paid`, reservation → `confirmed`, ticket minted, `me.register` delivered, **`hubspot_marketing_event_object_id` now back-filled** | `tickets`, HubSpot Marketing Event |
| 6 | Replay the same reserve with the **same** `Idempotency-Key` | byte-identical stored response, **no** second hold | `idempotency_keys` |
| 7 | Reserve with a stale `expectedUnitCents` | `price_mismatch` (409) | response |
| 8 | Member buyer on a member-priced ticket | charged the tiered price, not standard | `orders.total_cents`, invoice lines |
| 9 | Unverified member | **`membership_unverified`** (403), not `members_only` | response |
| 10 | Non-member on a member-only ticket | `members_only` (403) | response |
| 11 | Same attendee email twice on one event | `duplicate_attendee` (409) | response |
| 12 | Reserve, then wait out the 15-minute hold | reservation `expired`, order `cancelled`, seat back in `/availability` | DO, `orders` |
| 13 | **Two parallel reserves for the last seat** | exactly one wins; the other is `waitlisted`. This is the no-oversell guarantee | responses |
| 14 | Reserve the last seat, let the hold lapse, let someone else take it, **then pay the first invoice**. Requires setup — see below | order → `needs_review`, oversell decision opened, HubSpot task on the owner, seat **not** committed, **no ticket issued** | `pending_decisions`, HubSpot tasks |
| 15 | Resolve 14 with `{ action: "honour" }` | seat force-committed, order `paid`, ticket issued | `tickets` |
| 16 | Repeat 14, resolve with `{ action: "refund" }` | policy applied, invoice voided or amount refunded, seats freed | `orders.refunded_cents` |
| 17 | Reserve on a full event | `waitlisted`, `notify.waitlist_joined` outbox row | `waitlist` |
| 18 | Free a seat with someone waiting | a **waitlist decision** opens — confirm **no** automatic offer went out | `pending_decisions` |
| 19 | Resolve 18 with `{ waitlistIds: [...] }` | offer sent, 30-minute TTL, signed token | `waitlist.status = 'offered'` |
| 20 | Claim the offer via reserve with `offerToken` | hold granted, row → `promoted` | `waitlist` |
| 21 | Claim an expired or superseded token | `offer_expired` / `offer_not_open` | response |
| 22 | Two claimants race for one freed seat | loser gets `offer_seat_taken` (409), not a silent oversell | responses |
| 23 | Free booking on Event C | `confirmed` with `ticketIds`, no invoice; without a Turnstile token → `turnstile_required` | response |
| 23b | **Paid** public booking on Event A with the Turnstile secret set, no token | `turnstile_required` (403) and **no hold taken** — the seat must not be parked to the invoice due date by an unchallenged caller | response, `reservations` |
| 24 | Staff manual `paid`, `invoiceDueDate` +14 days | hold runs to `23:59:59.999Z` that day, not 15 min; `hs_due_date` on the HubSpot invoice | `reservations.expires_at` |
| 25 | Staff manual `complimentary` | confirmed, ticket issued, zero-dollar deal, no invoice | `orders`, HubSpot deal |
| 26 | Manual booking, due date > 90 days or in the past | `invalid_invoice_due_date` (400) | response |
| 27 | Corporate bulk register within balance | seats booked and fully covered, usage derived from order state | `vouchers.ts` maths vs the company's used property |
| 28 | Bulk register **over** balance | **not rejected.** Vouchers cover whole seats, most expensive first; the remainder is invoiced at the normal price | `orders.total_cents`, invoice lines |
| 28a | Repeat 28 with `voucher_mode = 'credit'`, then `'off'` | credit redeems in cents; `off` redeems nothing and the whole booking is invoiced | `orders`, `tenants.voucher_mode` |
| 28b | Two bulk-register calls for one company, overlapping | **known gap — both can redeem against the same balance and over-redeem it.** Record what happened; do not raise it as a new defect | `vouchers.ts` maths vs `orders` |
| 29 | Corporate self-removal, and removing another admin | both blocked, both audited | `corporate_team_audit` |
| 30 | Refund a voucher-funded order | the redemption returns with no compensating write; the next sync PATCHes a lower absolute number | the company's used property |
| 31 | Refund before and after the policy cutoff | full vs partial vs none, matching the resolved policy | `orders` |
| 32 | Transfer a registration | same registration id, ticket reissued, old code void, `me.cancel` + `me.register`, `transfers` audit row | `transfers` |
| 33 | Transfer where the policy sets `allow_transfer = 0` | refused | response |
| 34 | Ticket type with `tax_treatment = gst_free` | the invoice line carries the imported **GST-free** rate, not 10% | HubSpot invoice, then Xero |
| 35 | Online event: provision, register, confirm | join URL written to the contact **before** the confirmation workflow fires | contact property, email |
| 36 | Online event attendance | Graph notification → pull → `me.attend` with a stable `interactionDateTime`; unmatched records land in `attendance_unmatched` | HubSpot Marketing Event |
| 37 | After `ends_at` | `me.complete` once, `marketing_event_completed = 1` | `events` |
| 38 | Check-in online, then the **same code again** | `checked_in`, then `already_checked_in` | response |
| 39 | Check-in offline: kill the network, scan, reconnect | queued scans flush via `/checkin/batch`; the recorded `scannedAt` is the attendance time and a replay does not shift it | `tickets`, `outbox` |
| 40 | Event A's device token used against Event B's manifest | 403 | response |
| 41 | Void an invoice natively in HubSpot | `refund_payment` → seats freed, tickets voided, `me.cancel` | `orders`, `tickets` |
| 42 | Disable the HubSpot webhook, pay an invoice, wait 5 minutes | the `*/5` invoice reconcile confirms it anyway | `orders` |
| 43 | Outbox health at the end of the run | nothing in `status = 'dead'` | query below |

#### Setting up scenario 14

Scenario 14 does not reproduce on a normally running queue. When the hold lapses,
`expireHold` sets the order to `cancelled` and enqueues a `payment.refund` with
`kind: 'full'`; that handler PATCHes the HubSpot invoice to `hs_invoice_status = 'voided'`
(`hubspot-writeback.ts:861`). By the time the second buyer takes the seat, the first
invoice is no longer payable, so paying it is not something the tester can simply do.

Force the branch one of two ways:

- **Pause the cleanup.** Stop the queue consumer (or hold the `payment.refund` row) before
  the hold expires, so the invoice stays `open` while the seat is freed and retaken, then
  pay it and resume the consumer.
- **Replay the confirmation.** Let the cycle run normally, then re-deliver the paid
  webhook for the first order — or wait for the `*/5` invoice reconcile to pick it up,
  since it polls `cancelled` orders as well as `pending` ones — after the seat has gone.
- **Starve the DO instead of the invoice**, if you would rather not touch the queue at all.
  Leave the order `pending`, so nothing voids its invoice, then set that reservation's
  `reservations.expires_at` into the past in D1 and `POST /events/:id/rebuild-capacity`.
  The rebuild only restores holds where `expires_at > now`, so the DO forgets this one.
  Take the freed seat with a comped booking, which confirms instantly, then pay invoice #1:
  `confirmPayment` finds the hold gone and returns `expired_and_oversold`. This is the
  deterministic one — no race, no paused consumer.

Either way the assertion is the same: the payment is captured, the seat is **not**
committed, the order lands in `needs_review`, and a decision plus owner task is opened.

### 5.4 How to verify, not just observe

Assert on the **outbox rows**, not on outbound HTTP. The contract everywhere is "a row
exists in the same D1 batch as the state change"; the HTTP call is the queue's problem and
retries make its timing meaningless.

```sql
-- in flight or stuck
SELECT topic, status, attempts, json_extract(payload,'$._dead_reason') AS reason
FROM outbox WHERE status != 'delivered' ORDER BY created_at DESC LIMIT 50;

-- paid but not synced to the Marketing Event
SELECT r.id, r.attendee_email, o.status
FROM registrations r JOIN orders o ON o.id = r.order_id
WHERE o.status IN ('paid','confirmed') AND r.marketing_event_state_synced = 0;

-- waiting on a human
SELECT id, status FROM orders WHERE status = 'needs_review';
SELECT id, type, status FROM pending_decisions WHERE status = 'open';
```

Give the `*/15` reconcile a cycle before calling a write-back a defect, and the `*/5`
invoice reconcile a cycle before calling a missed payment webhook a defect. Both self-heal;
anything still wrong after two cycles is real, and [ops-runbook.md](ops-runbook.md) §2 has
the triage.

Unhandled errors return JSON with an 8-character `ref` that also appears in the Worker log
as `event: "unhandled_error"`. Capture the `ref` in any bug report.

### 5.5 What staging cannot prove

- A HubSpot **service key cannot authenticate webhooks or UI extension calls**, and is
  single-account. On a service-key deployment, `/webhooks/hubspot` and the App Cards need a
  real OAuth app, so scenarios 5, 14, 35–37, 41 and 42 are unreachable without it.
- Marketplace install and Refuel billing (`/webhooks/refuel`) run against Refuel's own
  portal, not the tenant's.
- Xero reconciliation is HubSpot Data Sync's job and lands on its own schedule. Confirm the
  invoice carries the imported rate id and treat the Xero side as a separate check.
