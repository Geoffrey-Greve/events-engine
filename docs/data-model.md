# Data model

Four stores, each with one job.

| Store | Binding | Holds |
| --- | --- | --- |
| D1 | `DB` | the durable record: tenants, catalog, orders, registrations, tickets, outbox, audit |
| Durable Object | `EVENT_CAPACITY` | live seat math for one event: capacity, per-type inventory, holds, confirmed |
| KV | `KV` | short-lived caches and counters: Graph tokens, subscription reverse map, rate-limit windows |
| Queue | `QUEUE` | in-flight jobs: outbox signals, hold expiry, payment confirm and refund, attendance pulls |

Conventions that hold everywhere:

- Every data row carries `portal_id`. Every query filters on it.
- All timestamps are ISO 8601 UTC text. Display timezone defaults to `Australia/Adelaide`,
  and is a presentation concern only.
- Money is integer cents, currency AUD. Stored ticket prices are **GST inclusive**.
- Booleans are SQLite `INTEGER` 0 or 1. Row types keep them as `number`; callers coerce
  with `!!row.field`.
- Ids are `crypto.randomUUID()` unless a HubSpot id is the natural key.

Row types for the tables the worker reads most are in `packages/worker/src/db.ts`
(`EventRow`, `TicketTypeRow`, `OrderRow`). The authoritative schema is always the numbered
files in `packages/worker/migrations/`, applied in filename order.

## D1 tables

### tenants

One row per HubSpot portal. Both tenant configuration and encrypted OAuth tokens.

| Column | Notes |
| --- | --- |
| `portal_id` | primary key, the HubSpot portal id as text |
| `display_name` | |
| `status` | `installed`, `active`, `past_due`, `cancelled`. Only `active` allows publishing |
| `installed_at` | |
| `hs_access_token`, `hs_refresh_token`, `hs_token_expires_at` | AES-GCM encrypted, refreshed when under 5 minutes remain |
| `hubdb_events_table_id`, `hubdb_ticket_types_table_id` | filled by provisioning |
| `hubdb_dynamic_page_domain` | the customer CMS domain for the events listing page |
| `refuel_plan`, `refuel_billing_status`, `refuel_hs_deal_id`, `trial_ends_at` | Refuel-side subscription state, driven by `POST /webhooks/refuel` |
| `stripe_processor_connected` | 0 or 1. A paid reserve refuses to hold a seat while this is 0 |
| `xero_gst_rate_id` | HubSpot tax-rate id imported from Xero. Also required before a paid reserve |
| `xero_gst_free_rate_id` | the GST-free rate, for `tax_treatment = 'gst_free'` lines |
| `webinar_provider`, `webinar_creds_enc` | provider name and the legacy encrypted credential blob |
| `membership_status_property`, `membership_level_property`, `member_category_property` | which HubSpot contact properties carry membership. Status falls back to `membership_status` |
| `membership_value_maps` | JSON `{ status, level, category }`: raw HubSpot value to canonical value |
| `events_pipeline_id`, `events_registered_stage_id`, `events_registered_stage_label` | deal routing for `booking_kind = 'event'` |
| `training_pipeline_id`, `training_invoice_sent_stage_id`, `training_invoice_sent_stage_label` | deal routing for `booking_kind = 'course'` |
| `deal_type_property_name`, `event_deal_type_label`, `course_deal_type_label` | deal-type property mapping |

`getPortalConfig()` in `config.ts` projects a subset of this into the shared
`PortalConfig` type. Anything not in that projection is read directly by the module that
needs it.

### events

The worker's mirror of the catalog. The worker and the DO are the capacity authority;
HubDB holds the content.

| Column | Notes |
| --- | --- |
| `id` | internal id. This is the `:slug` path parameter on the public endpoints |
| `hubspot_event_id` | HubSpot marketing event `externalEventId`. Unique per portal, and the second half of the DO id name |
| `hubspot_marketing_event_object_id` | the CRM object id, when resolved |
| `title`, `starts_at`, `ends_at`, `location` | |
| `capacity` | event-level cap |
| `booking_kind` | `event` or `course`, default `course`. Selects the deal pipeline and deal type |
| `provider` | webinar provider name, or `NULL` for in person. Non-null means online |
| `allow_oversell` | legacy column. Phase 18.3 removed auto-honour; oversell is now always a human decision |
| `marketing_event_completed` | 0 or 1. Set when `me.complete` is enqueued, so finalisation happens once |
| `teams_webinar_id`, `teams_session_id`, `teams_join_url` | provider ids. Named `teams_*` for history; every provider uses them |
| `refund_policy_id` | explicit per-event policy, else resolution falls back |
| `category` | event category, used to pick a category default refund template |
| `hubspot_owner_id` | who pending decisions get assigned to |

### ticket_types

| Column | Notes |
| --- | --- |
| `id`, `portal_id`, `event_id` | |
| `name` | |
| `price_cents` | the **standard** price, GST inclusive. Member pricing comes from `pricing_rules`, not from a second column |
| `currency` | `AUD` |
| `capacity` | per-ticket-type seat limit, enforced alongside the event cap |
| `tax_treatment` | `gst` (default, 10% included) or `gst_free`. Migration 0015 normalised legacy `gst_inclusive` to `gst`; `isGstFreeTreatment()` also accepts legacy `exempt` |
| `member_only` | 0 or 1. If every type on an event is member-only, the event itself is member-only |
| `hs_tax_rate_id` | the tax-rate id put on the invoice line. Defaults to the tenant GST rate at reserve time when blank |
| `hs_product_id` | HubSpot product id for line items |
| `sort_order` | |

### reservations and reservation_items

A reservation is the D1 record of a DO hold. `reservations.id` **is** the DO `holdId`.

| `reservations` column | Notes |
| --- | --- |
| `id` | also the DO hold id |
| `idempotency_key` | unique per portal |
| `status` | `pending`, `confirmed`, `expired`, `cancelled` |
| `expires_at` | 15 minutes from creation for public checkout. A staff manual paid booking gets an invoice due date instead |

| `reservation_items` column | Notes |
| --- | --- |
| `reservation_id`, `ticket_type_id`, `quantity` | |
| `portal_id` | added by migration 0006 |
| `unit_cents` | added by 0013, nullable. The price actually charged, so an invoice rebuild reproduces the discount rather than the standard price. Readers coalesce to `ticket_types.price_cents` for legacy rows |

### orders

| Column | Notes |
| --- | --- |
| `id`, `portal_id`, `event_id`, `reservation_id` | |
| `status` | see the state machine below |
| `buyer_email`, `buyer_name`, `buyer_abn` | ABN is captured for company orders; the ATO requires buyer identity on invoices at or above AUD 1,000 |
| `total_cents`, `refunded_cents`, `currency` | |
| `hubspot_deal_id`, `hubspot_invoice_id`, `hubspot_invoice_url` | filled by the write-back. `hubspot_invoice_url` is what the CMS module polls for |
| `member_company_id` | the HubSpot company whose training vouchers this order draws on |

Order status is the spine of the whole system:

```
                     ┌─ free / complimentary ─────────────────► confirmed
reserve ─► pending ──┤
                     └─ paid invoice webhook ─────────────────► paid
                            │                                    │
       hold lapses ─────────┤                                    ├─ policy refund (full) ──► refunded
                            ▼                                    ├─ policy refund (partial) ► partially_refunded
                        cancelled                                └─ policy refund (none) ──► cancelled
                            
       late payment after the hold lapsed, and committing
       would oversell ─────────────────────────────────────────► needs_review
                                                                    │
                                                     owner honours ─┤─► paid
                                                     owner refunds ─┘─► refunded / partially_refunded / cancelled
```

`pending` and `needs_review` are "encumbered but not committed". Seat commitment and
voucher consumption both key off `paid` and `confirmed` only.

### registrations

One row per attendee, which may differ from the buyer.

| Column | Notes |
| --- | --- |
| `id` | stamped onto the provider registration so attendance matching is exact |
| `order_id`, `event_id`, `ticket_type_id` | |
| `attendee_email`, `attendee_name`, `hubspot_contact_id` | |
| `ticket_id` | filled after issuance |
| `teams_registration_id`, `teams_join_url` | provider registration id and the personal join URL |
| `marketing_event_state_synced` | 0 not synced, 1 registered, 2 attended. The `*/15` cron re-enqueues `me.register` for any paid or confirmed registration still at 0 |

Registrations have no status of their own. The order's status is what moves.

### tickets

| Column | Notes |
| --- | --- |
| `id` | the `tid` inside the QR payload |
| `qr_code` | the signed token: `base64url(JSON{tid,rid,eid}) + "." + base64url(HMAC-SHA256)` |
| `status` | `issued`, `checked_in`, `cancelled`, `voided` |
| `checked_in_at` | |

### waitlist

| Column | Notes |
| --- | --- |
| `email`, `hubspot_contact_id` | |
| `ticket_type_id` | `NULL` means any type |
| `quantity` | one row per buyer, so a group waits together and the offer must fit the whole quantity |
| `position` | per event and ticket type |
| `status` | `waiting`, `offered`, `promoted`, `expired`, `converted`, `cancelled` |
| `offer_expires_at` | 30 minutes when offered. Re-derived at claim time, so a token from a superseded offer round cannot be replayed |

### outbox

Every HubSpot side effect, written in the same batch as its state change.

| Column | Notes |
| --- | --- |
| `topic` | one of the `OutboxKind` values in `@paddock/shared` |
| `payload` | JSON |
| `status` | `pending`, `processing`, `delivered`, `failed`, `dead` |
| `attempts`, `next_attempt_at`, | retry bookkeeping |
| `stable_interaction_datetime` | frozen at insert, never regenerated. This is what makes Marketing Event attendance retries idempotent |

A `dead` row records why in `payload._dead_reason`. See
[outbox-queues-cron.md](outbox-queues-cron.md).

### Reliability and audit tables

| Table | Purpose |
| --- | --- |
| `idempotency_keys` | `(portal_id, key)` unique. Stores the exact response status and body so a replayed reserve returns the original response verbatim. 24-hour expiry |
| `webhook_events` | `(provider, provider_event_id)` unique. `INSERT OR IGNORE` returning zero changes means already processed |
| `attendance_unmatched` | attendance records that matched no registration, with the raw provider record kept for re-matching |
| `pending_decisions` | open oversell and waitlist decisions: `type`, `status`, `order_id`, `context` JSON, `assigned_owner_id`, `resolution` JSON |
| `transfers` | audit of attendee reassignments: `registration_id`, `from_email`, `to_email`, `reason` |
| `corporate_team_audit` | corporate self-service team actions: actor, target, action, outcome. Ids only; HubSpot stays the source of truth for contact data |
| `corporate_voucher_accounts` | `(portal_id, company_id)` with `baseline_used`: voucher usage that predates this worker, captured once |

### Configuration tables

| Table | Purpose |
| --- | --- |
| `pricing_rules` | tiered member discounts. `scope` is `portal`, `event` or `ticket_type`; `scope_id` is the event or ticket-type id, `NULL` for portal. Matched on `(member_level, member_category)`. `fixed_price_cents` overrides `discount_percent` |
| `refund_policies` | policy templates. `is_default` plus optional `category`. `full_refund_cutoff_days`, `partial_refund_percent`, `allow_transfer` |
| `webinar_connections` | `(portal_id, provider)` primary key. Encrypted OAuth access and refresh tokens, or an encrypted API-credential JSON blob for key-only providers such as ON24 |

## EventCapacity Durable Object

`packages/worker/src/do/EventCapacity.ts`. One instance per event, addressed by
`idFromName(`${portalId}:${event.hubspot_event_id}`)`.

### In-memory and persisted state

| Field | Meaning |
| --- | --- |
| `eventCapacity` | event-level cap. `null` means uncapped |
| `perType` | map of ticket-type id to `{ inventory, confirmed }`. `inventory: null` means uncapped for that type |
| `holds` | array of `{ holdId, expiresAt, items[] }`. `expiresAt` is epoch ms |
| `confirmedHolds` | map of hold id to items, kept for confirm idempotency and refund-by-hold |
| `idName` | the `portalId:hubspotEventId` string, so a cold start can rehydrate |
| `initialized` | false means storage was empty and D1 rehydration has not succeeded yet |

The constructor wraps the load in `blockConcurrencyWhile`, so no request or alarm is
served before state is consistent. Construction never throws: if D1 is unreachable or the
event is not there yet, the DO stays lazily uninitialised and waits for `/init` or `/sync`.

### Endpoints

Called with `stub.fetch('https://do/<path>', { method: 'POST', body: JSON })`.

| Path | Body | Behaviour |
| --- | --- | --- |
| `/reserve` | `{ holdId?, items[], ttlMs?, expiresAt? }` | garbage-collect expired holds, then check per-type and event availability together. On success push a hold and arm the alarm at the earliest expiry. Returns `{ ok, holdId, expiresAt }` or 409 `{ full: true, shortfall }`. Same `holdId` again is idempotent |
| `/confirm` | `{ holdId, orderItems?, force? }` | commit the hold's seats. This is the only place seats commit. Idempotent |
| `/release` | `{ holdId }` | drop a hold without committing |
| `/refund` | `{ holdId }` or `{ orderItems[] }` | subtract from `confirmed`, floored at 0 |
| `/availability` | none | reap expired holds, then return the snapshot |
| `/sync` | `{ eventCapacity?, perType? }` | admin capacity and inventory edits. Never touches `confirmed` or `holds` |
| `/init` | `{ idName? }` | store the id name and rehydrate if still uninitialised |
| `/rebuild` | `{ idName? }` | discard the persisted counters and rebuild from D1. Maintenance only |

Two details in `/reserve` that exist because of real bugs, and must not be simplified away:

- quantities are aggregated by ticket type **before** the availability check, so a request
  listing the same ticket type on two lines is gated on the combined quantity;
- nothing mutates until every constraint passes.

Two details in `/confirm`:

- a live hold commits exactly what was held, never caller-supplied `orderItems`. Supplying
  mismatched `orderItems` returns 409 `orderItems_mismatch` and leaves the hold live;
- if the hold has lapsed and committing would breach a cap, it refuses with
  `{ confirmed: false, reason: 'expired_and_oversold' }` unless `force: true`. `force` is
  reachable only through an owner honour decision.

### Alarms

Each hold arms a storage alarm at the earliest expiry. On fire, `reapExpired()` drops
lapsed holds and emits one `expire_hold` queue job per reaped hold, so D1 can catch up.
Whoever reaps a hold first owns its event; `reserve` and `availability` share the same
path, so a hold is never double-emitted. If the queue is unbound, seats are still freed in
the DO and the reconciliation cron picks up the orphaned D1 row.

### Availability snapshot

```jsonc
{
  "ok": true,
  "eventCapacity": 50,          // null = uncapped
  "confirmed": 12,
  "held": 3,
  "available": 35,              // null when eventCapacity is null
  "holds": 2,
  "perType": {
    "tt_dev_002": { "inventory": 30, "confirmed": 8, "held": 1, "available": 21 }
  }
}
```

## KV keys

| Key | Written by | Notes |
| --- | --- | --- |
| `graph:sub-portal:{subscriptionId}` | `providers/teams.ts` `ensureSubscription` | reverse map so the Graph webhook can resolve a notification to a portal |
| Graph token cache entries | `graph.ts` | per-tenant client-credentials token, cached until expiry |
| `rl:{prefix}:{ip}:{window}` | `middleware/rate-limit.ts` | sliding-window counter, TTL twice the window |

KV is a cache and a counter store. Nothing in it is authoritative, and losing the namespace
costs an extra token fetch and a re-subscribe, not data.
