# Architecture

## What this service is

`event-engine` is a multi-tenant Cloudflare Worker that supplies the event-registration
capabilities HubSpot Professional does not have: atomic seat capacity, reservation holds,
waitlist, tiered member pricing, ticket and QR generation, and door check-in.

HubSpot does everything else, and stays the system of record for it:

| Layer | Owner | Notes |
| --- | --- | --- |
| Participation | HubSpot Marketing Events | register, attend, cancel, no-show |
| Content and pages | HubDB dynamic pages plus the CMS module | the buyer never sees a worker-rendered page |
| Money | HubSpot deal, line items, invoice, then Stripe (AUD), then Xero via Data Sync | the worker's money job ends at creating the HubSpot invoice |
| Capacity and tickets | this worker | D1, Durable Objects, Queues, KV, Cron |

The worker makes no direct Xero calls, ever. Invoice and payment reach Xero through
HubSpot Data Sync.

## Runtime shape

```
                    HubSpot CMS page (HubDB dynamic page + event-registration module)
                                     │  GET  /api/v1/events/:id/availability
                                     │  POST /api/v1/events/:id/reserve   (Idempotency-Key)
                                     │  GET  /api/v1/orders/:id           (poll for paymentUrl)
                                     ▼
  ┌──────────────────────────────── Worker (Hono) ─────────────────────────────────┐
  │  routes/reserve.ts        public checkout                                      │
  │  routes/checkin.ts        device-token scanner API                             │
  │  routes/manage.ts         tenant admin API (admin key per portal)              │
  │  routes/app-home.ts       HubSpot App Home / cards (signed requests)           │
  │  routes/corporate-team.ts member-portal team + voucher bulk booking            │
  │  routes/{connect,microsoft-oauth,oauth-*,install}.ts   OAuth and provisioning   │
  │  routes/webhooks-*.ts     HubSpot, Graph, Zoom, app-uninstall, Refuel billing   │
  └───────┬──────────────────────┬──────────────────────┬─────────────────┬────────┘
          │                      │                      │                 │
          ▼                      ▼                      ▼                 ▼
   EventCapacity DO           D1 (durable          Queue                 KV
   one per event             record + outbox)     (outbox drain,        (Graph token,
   atomic seat math                               expire_hold,          subscription
                                                  confirm/refund,       reverse map,
                                                  attendance pulls)     rate-limit counters)
          │                                              │
          │                                              ▼
          │                                    hubspot-writeback.ts
          │                                    (Marketing Events, contacts,
          │                                     deals, invoices, refunds,
          │                                     owner tasks, voucher usage)
          ▼
    Cron: */5 attendance poll + finalize + invoice reconcile
          0 */12 Graph subscription renewal
          */15 outbox reconciliation sweep
```

Entry point: `packages/worker/src/index.ts`. It wires the Hono router, the `queue()`
consumer, the `scheduled()` cron dispatcher, and re-exports the `EventCapacity` class so
Wrangler can bind it.

## Why a Durable Object

A sell-out is a race. Two concurrent reserves both read "one seat left", both pass the
check, both write, and you have oversold. D1 has transactions but no cross-request lock
you can rely on for a hot counter.

A Durable Object is single-threaded per id. Every reserve, confirm, release and refund for
one event funnels through one instance and executes in order. That, plus
`blockConcurrencyWhile` around state load in the constructor, is the entire no-oversell
guarantee. No locks, no compare-and-swap in D1 on the hot path.

The DO id is `idFromName(`${portalId}:${event.hubspot_event_id}`)`, so the instance is
per tenant per HubSpot marketing event.

D1 remains the durable record. If the DO is cold and its storage is empty it rehydrates
from D1 (`rehydrateFromD1`), counting paid and confirmed registrations as committed seats
and unexpired pending reservations as live holds. `POST /api/v1/manage/events/:id/rebuild-capacity`
forces that rebuild after data surgery.

Full DO endpoint list and state shape: [data-model.md](data-model.md#eventcapacity-durable-object).

## Why an outbox

Request handlers must not call HubSpot. HubSpot is slow, rate-limited, and occasionally
down, and a booking must not fail because a CRM write failed.

So every HubSpot side effect is inserted into the `outbox` table in the **same
`env.DB.batch([...])`** as the state change that caused it. The handler then sends a
best-effort queue signal and returns. The queue consumer picks up the row, calls HubSpot,
and marks it `delivered` or `dead`. The `*/15` cron re-drives anything the signal missed.

That gives three properties for free:

- A state change and its side effect can never disagree, because they commit together.
- Queue signals are pure optimisation. Losing one delays a write-back by up to 15 minutes;
  it never loses it.
- Retries are safe, because attendance write-backs carry a frozen
  `stable_interaction_datetime` and money write-backs are keyed on the order.

Details, kinds and error model: [outbox-queues-cron.md](outbox-queues-cron.md).

## The handler contract

Every mutating handler follows the same shape:

```
validate  →  mutate D1 (+ outbox rows in the same batch)  →  enqueue signals  →  respond
```

`routes/reserve.ts` `doReserve()` is the canonical example, and it is worth reading once
end to end. Its numbered sections are:

1. load the event (`:slug` is the internal `events.id`)
2. parse and validate the body
3. claim a signed waitlist offer, if one was presented
4. membership gate, then the duplicate-attendee gate
5. price the line items server side
6. `EventCapacity` DO `/reserve`
7. capacity full, so join the waitlist and return
8. provision the webinar and register attendees (online events)
9. build the D1 batch: reservation, items, order, registrations, tickets (free only), outbox rows, idempotency key
10. commit the batch atomically
11. post-commit: confirm the DO hold for free orders, send queue signals

## Monorepo layout

pnpm workspace, four packages.

| Package | Path | Role |
| --- | --- | --- |
| `@paddock/worker` | `packages/worker` | the Cloudflare Worker: capacity, reservations, payments, check-in, HubSpot write-back |
| `@paddock/shared` | `packages/shared` | cross-boundary contracts: reserve wire format, outbox kinds, attendance record, HubDB schemas, tenant config, pricing and refund types |
| `@paddock/hubspot` | `packages/hubspot` | HubSpot Project: CMS template, registration module, HubDB table definitions, App Home and card UI extensions |
| `@paddock/checkin-pwa` | `packages/checkin-pwa` | offline-capable door scanner (QR verify plus batch sync) |

`@paddock/shared` exists so a shape cannot drift between the worker and the front end. If
a type crosses the worker boundary, it belongs there. Both other packages depend on it via
`workspace:*`, and `tsconfig.base.json` maps `@paddock/shared` to its source, so there is
no build step between packages.

## Worker module map

`packages/worker/src`, grouped by job rather than alphabetically.

### Entry and infrastructure

| File | Role |
| --- | --- |
| `index.ts` | Hono app, CORS, JSON error handler, queue consumer, cron dispatcher |
| `types.ts` | the `Env` interface: bindings plus every Wrangler secret |
| `config.ts` | `getPortalConfig()` (tenant row to `PortalConfig`) and `getSecret()` (the `{PREFIX}_{portalId}` convention) |
| `db.ts` | typed row interfaces and the handful of shared loaders |
| `middleware/rate-limit.ts` | KV sliding-window limiter for public endpoints |
| `token-crypto.ts` | AES-GCM encrypt and decrypt for tokens stored in D1 |

### Capacity and booking

| File | Role |
| --- | --- |
| `do/EventCapacity.ts` | the Durable Object. Atomic seat math, TTL holds, alarms, rehydrate from D1 |
| `routes/reserve.ts` | public checkout plus availability and order polling. Also `reserveEventWithBody()`, the internal entry used by staff and corporate paths |
| `expire.ts` | queue handler for a lapsed hold: expire the reservation, cancel the order, refund a paid-but-expired invoice, open a waitlist decision |
| `payment.ts` | confirm payment, flag oversell, honour oversell, execute a policy refund, handle a webhook void |
| `waitlist.ts` | join, signed offer tokens, owner-chosen offers, claim, snapshot |
| `decisions.ts` | human-in-the-loop oversell and waitlist decisions, plus the owner task |
| `transfer.ts` | reassign a registration to a new attendee without refunding |

### Pricing, membership, money

| File | Role |
| --- | --- |
| `membership.ts` | resolve `{ isMember, verified, level, category }` from HubSpot contact, company or the HubDB directory |
| `pricing.ts` | tiered member pricing, resolved most specific first: ticket type, event, portal |
| `refund-policy.ts` | resolve the effective refund policy and compute full, partial or none |
| `vouchers.ts` | corporate training voucher accounting, derived from order state |
| `commerce-lines.ts` | invoice and deal line-item naming |

### HubSpot integration

| File | Role |
| --- | --- |
| `hubspot-writeback.ts` | the queue consumer for every outbox kind, plus `reconcileOutbox()`. The largest file in the repo |
| `hubspot-oauth.ts` | token exchange, refresh, storage, introspection |
| `hubspot-oauth-state.ts` | signed OAuth state |
| `hubspot-signature.ts` | HubSpot v3 request-signature verification (used by App Home) |
| `hubspot-contacts-and-finish.ts` | thin re-export so the cron does not import the whole consumer |
| `provision.ts` | idempotent HubDB table creation from the shared schemas |
| `invoice-reconcile.ts` | scheduled poll of known invoices, as a webhook fallback |
| `notify.ts` | `notify.*` outbox kinds. Accepts and no-ops until an email provider is wired |

### Online events

| File | Role |
| --- | --- |
| `providers/types.ts` | the `WebinarProvider` interface |
| `providers/index.ts` | `getWebinarProvider()`, selected by `events.provider` |
| `providers/{teams,meet,zoom,on24,wistia,vimeo}.ts` | implementations |
| `providers/oauth.ts` | per-tenant provider credentials: OAuth tokens or encrypted API keys |
| `attendance.ts` | the provider-agnostic attendance pipeline plus the attendance crons |
| `teams.ts` | the bridge between the reserve flow and the provider interface. Deliberately non-throwing |
| `graph.ts`, `microsoft-graph.ts`, `microsoft-client-assertion.ts` | Microsoft Graph client, virtual-event calls, certificate auth |

### Tickets and check-in

| File | Role |
| --- | --- |
| `checkin.ts` | ticket QR signing, per-event key derivation, device tokens, `deviceAuth` and `authenticateAdmin` |
| `routes/checkin.ts` | the scan, batch, manifest, stats and device-token endpoints |
| `turnstile.ts` | Cloudflare Turnstile verification for all public bookings |

## Naming

The repo codename is `event-engine`; the product and marketplace name is Paddock. Use
`event-engine` in code, config and infrastructure names. Paddock appears in package names
(`@paddock/*`), the HubSpot app, the PWA and customer-facing copy. Do not rename either.
