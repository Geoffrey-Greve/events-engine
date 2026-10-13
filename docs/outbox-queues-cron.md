# Outbox, queues and cron

## The rule

> Every HubSpot side effect goes through the `outbox` table in the same D1 transaction as
> the state change, then drains via the queue. No fire-and-forget HubSpot calls from
> request handlers.

If you are about to `fetch()` HubSpot from a route handler, stop. The only code that talks
to HubSpot synchronously in a request is the corporate team API (which must verify actor
permissions before mutating) and diagnostics.

## Writing a side effect

Build the outbox row as a prepared statement and push it into the **same** batch as the
state change:

```ts
const outboxId = crypto.randomUUID();
const now = new Date().toISOString();

stmts.push(
  env.DB.prepare(
    `INSERT INTO outbox (id, portal_id, topic, payload, stable_interaction_datetime, created_at)
     VALUES (?1, ?2, 'me.register', ?3, ?4, ?5)`,
  ).bind(outboxId, portalId, JSON.stringify(payload), interactionDateTime, now),
);

await env.DB.batch(stmts);       // the atomic commit

try {                            // signal is best effort; the cron is the backstop
  await env.QUEUE.send({ kind: 'me.register', portalId, outboxId });
} catch {
  // swallow
}
```

Three rules that follow from this:

1. **Pre-generate the outbox id** before the batch, so the queue signal can name the row.
2. **Never `await` a queue send inside a try that would abort the response.** A lost signal
   costs up to 15 minutes of latency. A failed response costs a booking.
3. **Freeze `stable_interaction_datetime` at insert time.** Marketing Event attendance
   endpoints are idempotent only if the same interaction timestamp is replayed. Never use
   `Date.now()` at delivery time.

For a payload that could go stale between insert and delivery, carry identifiers only and
recompute at delivery time. `company.sync_voucher_usage` is the model: the payload is just
`{ portalId, companyId }`, and the handler recomputes usage from D1, so a delayed or
retried row always writes the current value.

## Outbox kinds

The closed set is `OutboxKind` in `packages/shared/src/outbox.ts`. Adding a topic means
adding it there **and** adding a `case` in the `handleOutboxMessage` switch, or the row
dead-letters through the unknown-kind path.

| Kind | Handler | What it does |
| --- | --- | --- |
| `me.create` | `handleMeCreate` | create the HubSpot marketing event, and record its object id |
| `me.register` | `handleMeAttendance('register')` | Marketing Event attendance: registered |
| `me.attend` | `handleMeAttendance('attend')` | attendance: attended |
| `me.cancel` | `handleMeAttendance('cancel')` | attendance: cancelled |
| `me.complete` | `handleMeComplete` | mark the marketing event complete |
| `contact.set_join_url` | `handleContactSetJoinUrl` | write the personal join URL to the contact, before HubSpot's confirmation workflow fires |
| `contact.upsert` | `handleContactUpsert` | standalone create-or-update by email. Used by transfer |
| `deal.create` | `handleDealCreate` | deal, line items, associations, pipeline and stage routing by `booking_kind` |
| `invoice.create` | `handleInvoiceCreate` | draft invoice, associate contact and fresh line items with the tax rate, PATCH to `open`, store the id and URL on the order |
| `payment.refund` | `handlePaymentRefund` | full voids the invoice; partial refunds the amount |
| `notify.waitlist_joined` | `handleNotify` | accepted and no-op until an email provider is wired |
| `notify.waitlist_offer` | `handleNotify` | same. The signed offer token travels in `payload.offerToken` |
| `notify.owner_task` | `handleOwnerTask` | HubSpot task assigned to the event owner for a pending decision |
| `company.sync_voucher_usage` | `handleCompanyVoucherUsage` | recompute voucher usage from D1 and PATCH the absolute value onto the company |

`notify.waitlist_joined` and `notify.waitlist_offer` are dispatched **before** the HubSpot
token is resolved, because they make no HubSpot call and token resolution would otherwise
throw for those rows.

## Queue job kinds

Not everything on the queue is an outbox signal. `index.ts` routes by `kind`, and these
four are handled before the outbox dispatcher. They are deliberately **not** in
`OutboxKind`.

| Kind | Handler | Notes |
| --- | --- | --- |
| `expire_hold` | `expire.ts expireHold` | emitted by the DO alarm when a hold lapses |
| `confirm_payment` | `payment.ts confirmPayment` | from the HubSpot payment webhook or the invoice reconcile cron. An `oversold` result then calls `flagOversellForReview` |
| `refund_payment` | `payment.ts handleRefund` | from the invoice-voided webhook |
| `graph.pull_attendance` | `attendance.ts pullAttendanceJob` | from the Graph webhook or a provider's notification parse |

Everything else falls through to `handleOutboxMessage`.

## Error model

`hubspot-writeback.ts` classifies every HubSpot response in one place, in `hs()`:

| HubSpot response | Thrown | Queue action | Outbox row |
| --- | --- | --- | --- |
| 2xx | nothing | `ack()` | `delivered`, `attempts + 1` |
| 429 | `RetryableError` with `retryAfterMs` from `Retry-After`, default 60s | `retry({ delaySeconds })` | `failed`, `next_attempt_at` set |
| 5xx | `RetryableError` | `retry()` | `failed` |
| other 4xx | `PermanentError` | `ack()` | `dead`, with the reason recorded |
| anything else thrown | treated as retryable, 60s | `retry()` | `failed` |

A `dead` row is terminal and will not be retried by the queue or the cron. Re-driving one
is a deliberate operator action:

```sql
UPDATE outbox SET status = 'pending', next_attempt_at = datetime('now') WHERE id = '<outboxId>';
```

The next `*/15` sweep picks it up. Log events to search for in the Worker logs:
`outbox_retry`, `outbox_dead`, `attendance_unmatched`, `price_drift`, `turnstile_failed`,
`pricing_rules_unreadable`, `staff_manual_registration`, `unhandled_error`.

Queue-level configuration is in `wrangler.toml`: `max_retries = 3` and a dead-letter queue
(`event-engine-jobs-dlq`, and the `-staging` pair). The outbox's own `status`, `attempts`
and `next_attempt_at` are the durable record; the queue's retry count is just transport.

## Cron

Three triggers, dispatched by `controller.cron` in the `scheduled()` handler. Each task is
wrapped in `ctx.waitUntil`.

| Schedule | Tasks |
| --- | --- |
| `*/5 * * * *` | `pollLiveAttendance` (poll-based providers plus Zoom as a missed-webhook backstop), `finalizeEndedWebinars` (pull once after `ends_at`, then `me.complete` and mark complete), `reconcileHubSpotInvoices` (poll known invoice statuses as a webhook fallback) |
| `0 */12 * * *` | `renewSubscriptions`: `provider.ensureSubscription()` per portal with online events. Graph subscriptions last at most one day, so 12 hours gives a full cycle of slack |
| `*/15 * * * *` | `reconcileOutbox` |

An unrecognised cron string falls through to `reconcileOutbox`, so a schedule added to
`wrangler.toml` without a matching case still does something useful rather than nothing.

`reconcileOutbox` does two jobs:

1. re-drive up to 50 `pending` or `failed` rows whose `next_attempt_at` has passed, by
   sending a fresh queue signal;
2. re-enqueue drifted registrations: any registration on a `paid` or `confirmed` order
   still at `marketing_event_state_synced = 0` gets a fresh `me.register`.

That second job is why a lost queue signal is only a latency problem. It also means a
registration that HubSpot rejected permanently will keep being re-enqueued until the
underlying cause is fixed, which is intended: it stays visible instead of silently
disappearing.

Per-tenant loops swallow individual failures so one tenant's outage cannot block the
others. The next cron retries.

## Idempotency and dedup, in one place

| Surface | Mechanism |
| --- | --- |
| `POST /reserve` | `idempotency_keys` unique on `(portal_id, key)`, storing the exact response status and body. Written in the same batch as the reservation. 24-hour expiry |
| Inbound webhooks | `webhook_events` unique on `(provider, provider_event_id)`. `INSERT OR IGNORE`, and zero changes means already processed |
| Marketing Event attendance | frozen `stable_interaction_datetime` on the outbox row |
| DO reserve | the same `holdId` returns the existing hold with `idempotent: true` |
| DO confirm | a hold already in `confirmedHolds` returns success without re-committing |
| Payment confirm | an order already `paid` is a no-op |
| Refund | an order already `refunded` or `cancelled` is a no-op |
| Voucher usage | absolute value derived from order state, so a replay writes the same number |
| Attendance | `processAttendance` skips a registration already at `marketing_event_state_synced = 2`, or with a live `me.attend` row |
| Hold expiry | guarded on `status = 'pending'`, and a replay that changes nothing exits early |
| Voucher baseline | `INSERT OR IGNORE`, so the first capture wins |
| HubDB provisioning | reuses a table by name |
| Graph subscription | `ensureSubscription` is safe to call from the renewal cron |

If you add an external side effect, work out which row on this list it belongs to before
you write the handler.
