# Domain flows

Every path a booking can take, in the order you are likely to need them. Each section
names the files, so you can read the code alongside it.

## Paid booking, the happy path

Files: `routes/reserve.ts`, `do/EventCapacity.ts`, `hubspot-writeback.ts`,
`routes/webhooks-hubspot.ts`, `payment.ts`.

```
buyer submits the CMS registration module
  │
  ├─ POST /api/v1/events/:id/reserve   (X-Portal-Id, Idempotency-Key)
  │     1  load event
  │     2  validate body, normalise attendees
  │     3  claim a signed waitlist offer, if presented
  │     4  membership gate, then the duplicate-attendee gate
  │     5  price line items server side (resolvePrice per ticket type)
  │        · reject on price_mismatch if expectedUnitCents drifted
  │        · reject on payment_not_configured if Stripe or the GST rate is missing
  │     6  DO /reserve  ──► hold granted, TTL 15 minutes
  │     7  (if full: join the waitlist and return "waitlisted")
  │     8  online events: provision the webinar, register attendees, capture join URLs
  │     9  build ONE D1 batch:
  │           reservations, reservation_items, orders (pending), registrations,
  │           outbox me.register per attendee,
  │           outbox contact.set_join_url per attendee (online only),
  │           outbox deal.create, outbox invoice.create,
  │           idempotency_keys
  │    10  env.DB.batch(...)  ← the atomic commit
  │    11  send best-effort queue signals
  │
  └─ 200 { status: "reserved", orderId, registrationIds, pollUrl }

queue: deal.create      ─► HubSpot deal + line items, associated to contact and marketing event
queue: invoice.create   ─► draft invoice, associate contact + fresh line items + tax rate,
                           PATCH status to "open", write hubspot_invoice_id and _url to the order
queue: me.register      ─► Marketing Event attendance "register" (stable interactionDateTime)

buyer polls GET /api/v1/orders/:id until paymentUrl appears, then is redirected
  │
  └─ HubSpot-hosted invoice ─► Stripe (AUD) ─► HubSpot marks the invoice paid
        │
        └─ POST /webhooks/hubspot  (INVOICE hs_invoice_status = paid,
                                    or PAYMENT succeeded resolved to its invoice)
              dedup on eventId, then enqueue confirm_payment
                 │
                 └─ payment.ts confirmPayment()
                       DO /confirm with orderItems
                       │
                       ├─ committed ─► one D1 batch:
                       │                orders → paid, reservation → confirmed,
                       │                mint a signed ticket per registration,
                       │                outbox company.sync_voucher_usage (corporate orders)
                       │
                       └─ expired_and_oversold ─► flagOversellForReview() (see below)

HubSpot Data Sync carries the invoice and payment on to Xero. The worker never calls Xero.
```

Two things worth internalising:

- The seat is **held** from step 6 and **committed** only in `confirmPayment`. Nothing
  between those two points counts as a sale.
- Step 10 is the only place state becomes real. Everything before it can throw safely;
  everything after it is best effort with a cron backstop.

## Free and complimentary bookings

Same handler, different branch. `totalCents === 0` means `isFree`.

- The reservation and order are created directly as `confirmed`.
- Tickets are minted and inserted in the same batch, so `POST /reserve` returns
  `{ status: "confirmed", ticketIds }` with no polling.
- The DO hold is confirmed immediately after the D1 commit (best effort; D1 is
  authoritative and reconciliation fixes a missed confirm).
- No `invoice.create`. A `deal.create` is emitted only when the booking is a staff or
  manual complimentary seat, because those need a zero-dollar deal for reporting. Public
  free bookings get no deal.
- EVERY public booking requires a **Turnstile** token, paid or free, when a Turnstile
  secret is configured for the portal (`shouldRequireTurnstile`). The total is not part of
  the test: a paid booking holds its seat to the invoice due date, so leaving it
  unchallenged let a caller park capacity for weeks without paying.

## Membership and tiered pricing

Files: `membership.ts`, `pricing.ts`, `packages/shared/src/pricing.ts`.

`resolveMembership(env, portalId, buyerEmail, { memberCompanyId })` returns
`{ isMember, verified, level, category }`, resolved in this order:

1. the buyer's HubSpot contact, reading the tenant-configured status, level and category
   properties (status falls back to `membership_status`);
2. the associated company, if the contact's status is blank. Which company property fired
   also infers the category (corporate vs industry supplier);
3. the HubDB members directory, by email;
4. still blank, so `verified: false`.

`verified: false` is not the same as a confirmed non-member. It means the status was never
cloned from the company, and it routes the buyer to support with
`membership_unverified` rather than telling them they are not a member.

Guest checkout can also send `memberCompanyId`, taken from the Find a Member directory.
The worker re-validates that company server side and merges the result, so the invoice
amount matches the member price the buyer was shown.

Gates, in `doReserve` section 4:

- if **every** ticket type on the event is `member_only`, the event is member-only;
- otherwise each attendee's chosen ticket type is checked individually;
- `isPublicImportTicket()` hides data-import-only ticket types from public checkout.

Pricing, in section 5, via `resolvePrice`:

```
non-member, or member with no resolvable level        →  ticket_types.price_cents (standard)
member with a level                                  →  most specific matching pricing_rules row:
                                                          ticket_type  >  event  >  portal
                                                        matched on (member_level, member_category)
                                                          fixed_price_cents  overrides
                                                          discount_percent   off standard
                                                        no matching rule → standard
```

`member_category` `'member'` is the generic fallback for tenants such as Weld that only
expose a level. If the `pricing_rules` table does not exist (a database predating migration
0009), the query is caught and logged as `pricing_rules_unreadable` and the buyer pays
standard. A missing discount table means no discount, not a failed booking.

All attendees on one reserve share the buyer's tier, so each ticket type is priced once
and cached.

## Hold expiry

Files: `do/EventCapacity.ts` (alarm), `expire.ts`.

```
DO alarm fires at the earliest hold expiry
  reapExpired() drops lapsed holds, emits one expire_hold queue job each
    │
    └─ expire.ts expireHold(holdId)      holdId === reservations.id
          one D1 batch:
            · if the order already has a HubSpot invoice, insert a payment.refund
              outbox row (kind "full", reason "expired_hold"), guarded so it is
              inserted only while the reservation and order are still pending, and
              only if no live payment.refund row for this order already exists
            · reservations → expired  (only while still pending)
            · orders       → cancelled (only while still pending)
          │
          ├─ if nothing changed, this was a replay: stop. No seat was freed
          │
          └─ a seat was freed: if anyone is waiting, open a waitlist DECISION
             for the event owner. The worker never auto-offers
```

The double-guarded insert is deliberate: a buyer who paid an invoice attached to a lapsed
hold must be refunded exactly once, and `expireHold` can be replayed.

## Waitlist

Files: `waitlist.ts`, `decisions.ts`.

Joining is automatic. Promotion is not.

```
reserve finds the event full            →  joinWaitlist()
                                            one row per buyer, carrying quantity
                                            (a group waits together)
                                            position per (event, ticket type)
                                            outbox notify.waitlist_joined

a seat frees up (hold lapsed, or a refund)
                                        →  createWaitlistDecision()
                                            pending_decisions row (type "waitlist")
                                            outbox notify.owner_task → HubSpot task
                                                                        for events.hubspot_owner_id

the event owner opens the card and picks who to offer to
  POST /api/v1/manage/decisions/:id/resolve  { waitlistIds: [...] }
                                        →  offerToWaitlisters()
                                            reads live availability from the DO
                                            walks the queue in position order
                                            offers only where the quantity fits
                                            status → offered, offer_expires_at = now + 30 min
                                            outbox notify.waitlist_offer, carrying a signed token

the holder returns with the token
  POST /reserve { offerToken }          →  claimWaitlistOffer()
                                            verify the HMAC, then re-derive validity from
                                            the row: status must be "offered" and the stored
                                            offer_expires_at must equal the token's expiry
                                            a granted hold marks the row "promoted" in the
                                            same batch
```

The offer token is a stateless capability over `${waitlistId}.${expiresAtMs}`, HMAC-SHA256
signed. Because validity is re-derived from the row, a token from a superseded offer round
cannot be replayed once the row is re-offered with a new expiry.

Two claimants racing for one freed seat cannot oversell: the DO re-validates at confirm, so
the loser's confirm fails `expired_and_oversold`. A claimant whose seat was taken gets
`offer_seat_taken` (409) rather than being pushed to the back of the queue.

## Oversell, which is always a human decision

Files: `payment.ts`, `decisions.ts`.

A late payment arrives after the hold lapsed and the seat went to someone else. There is no
`allow_oversell` auto-honour and no auto-refund.

```
confirmPayment → DO /confirm → { confirmed: false, reason: "expired_and_oversold" }
  │  the payment is captured, but the seat is NOT committed
  │
  └─ flagOversellForReview()
        orders → needs_review
        pending_decisions row (type "oversell") holding the order id and amounts
        outbox notify.owner_task → HubSpot task for the event owner

owner decides, via POST /api/v1/manage/decisions/:id/resolve
  { action: "honour" }  →  honourOversell()
                             DO /confirm with force: true
                             markPaidAndIssueTickets(): order → paid, tickets minted
  { action: "refund" }  →  executeRefund()  (policy aware, below)
```

`force: true` on the DO is reachable only through this decision path. Do not add another
caller.

## Refunds

Files: `refund-policy.ts`, `payment.ts`.

Policy resolution, most specific first:

1. `events.refund_policy_id`, an explicit per-event policy;
2. the category-matched default template (`is_default = 1 AND category = events.category`);
3. the portal default template (`is_default = 1 AND category IS NULL`);
4. the built-in fallback: full refund up to 30 days out, transfers allowed.

Outcome, in `computeRefund`:

```
days until the event >= fullRefundCutoffDays  →  full,    amountCents = total_cents
otherwise, partialRefundPercent is set        →  partial, amountCents = round(total * pct / 100)
otherwise                                     →  none,    amountCents = 0
```

Two entry points converge on `applyRefund`:

| Entry | Trigger | HubSpot side |
| --- | --- | --- |
| `handleRefund` | `POST /webhooks/hubspot` reports the invoice `voided` | nothing to issue: the void already happened in HubSpot |
| `executeRefund` | admin or owner initiated, or an oversell refund decision | a `payment.refund` outbox row: full voids the invoice, partial refunds the amount |

`applyRefund` then, in one batch:

- frees the seats in the DO (best effort; D1 is authoritative for refunds);
- sets the order to `refunded`, `partially_refunded` or `cancelled`, and records
  `refunded_cents`;
- cancels the reservation and every ticket on the order;
- writes one `me.cancel` outbox row per attendee and resets
  `registrations.marketing_event_state_synced` to 0;
- writes a `company.sync_voucher_usage` row when the order drew on vouchers, which returns
  them with no compensating write;
- afterwards, if anyone is waiting, opens a waitlist decision.

Refunds are order level: one order, one invoice.

## Transfer

Files: `transfer.ts`.

Reassign a seat to a different person without refunding. The seat is kept, so the DO is
untouched.

1. gate on the resolved policy's `allowTransfer`;
2. for online events, re-register the new attendee with the **same `registrations.id`**, so
   attendance matching stays exact, then cancel the old provider registration;
3. move `attendee_email`, `attendee_name`, `hubspot_contact_id` and the provider ids on the
   registration;
4. reissue the ticket: mint a new signed QR and void the old code;
5. outbox: `contact.upsert` for the new attendee, `me.cancel` for the old contact,
   `me.register` for the new one, plus `contact.set_join_url` for online events;
6. write a `transfers` audit row.

## Corporate training vouchers

Files: `vouchers.ts`, `routes/corporate-team.ts`.

A voucher is a prepaid training seat a company holds in HubSpot (`vouchers_total` and
`vouchers_used` on the company record). **D1 is the source of truth for consumption;
HubSpot's property is a projection.**

Consumption is derived, never incremented:

```
vouchers_used  =  baseline_used + seats on this company's paid|confirmed orders
encumbered     =  vouchers_used + seats on pending|needs_review orders
```

`baseline_used` is captured once per company, with `INSERT OR IGNORE`, from whatever
HubSpot already recorded before the worker first touched it. That means recomputing from D1
never erases usage the worker was not responsible for, and a value read after we started
projecting can never overwrite the true baseline.

Because the write is an absolute value:

- replaying the outbox row PATCHes the same number, so retries are safe;
- a refunded, expired or cancelled order drops out of the count on the next sync, with no
  compensating write.

The `POST /api/v1/corporate/bulk-register` gate charges against **D1, not the HubSpot
property**, and uses `encumbered` rather than `used`. The projection to HubSpot is async, so
a gate reading the property would let two concurrent bulk bookings both pass against the
same stale balance. Counting live holds and undecided oversells closes that window. The
HubSpot projection deliberately reports settled usage only.

`orders.member_company_id` is what ties an order to the company whose balance it draws on.
It is set at reserve time from the request's `memberCompanyId`.

## Attendance for online events

Files: `attendance.ts`, `providers/*`, `routes/webhooks-graph.ts`.

Attendance is pull based, not push, even where a notification exists. The notification only
says "a report is ready".

```
Teams (webhook driven)
  tenant-wide Graph change-notification subscription on solutions/virtualEvents/events
  max 1-day lifetime, renewed by the 0 */12 cron
    │
    └─ POST /webhooks/graph
         validation handshake: echo ?validationToken= verbatim as text/plain
         otherwise group by subscriptionId, resolve the portal from KV,
         let the provider verify clientState and handle lifecycle events,
         then enqueue graph.pull_attendance
              │
              └─ pullAttendanceJob → provider.fetchAttendance(webinarId, sessionId)
                                     → AttendanceRecord[]  (normalised)

Poll-based providers (Meet, ON24, Wistia, Vimeo, and Zoom as a missed-webhook backstop)
  the */5 cron pulls attendance for in-window events (starts_at <= now, not yet completed)
```

Both paths land in the same place, `processAttendance()`, which is the only code that
touches attendance state:

1. skip records whose `role` is not `Attendee`;
2. collapse the record's intervals to earliest join, latest leave, summed duration;
3. match to a registration by `ourRegistrationId`, then `providerRegistrationId`, then
   `email`, in that order. Our id is stamped onto the provider registration at register
   time, which is why the first match is usually exact;
4. no match, so insert an `attendance_unmatched` row with the raw provider record and log
   `attendance_unmatched`;
5. matched, and not already attended and with no queued `me.attend`, so insert a
   `me.attend` outbox row whose `stable_interaction_datetime` is the earliest join.

Recorded-media providers (Wistia, Vimeo) have no real join and leave window, so they
populate `VideoEngagement` and synthesise an interval with `syntheticInterval()`. The
shared pipeline stays provider agnostic.

The `*/5` `finalizeEndedWebinars` cron then pulls once more after `ends_at` (missed-webhook
safety), enqueues `me.complete`, and sets `marketing_event_completed = 1` in the same
batch, so an event finalises exactly once.

## Check-in

Files: `checkin.ts`, `routes/checkin.ts`, `packages/checkin-pwa/src/*`.

A ticket QR code is a signed, self-describing token:

```
base64url(JSON{ tid, rid, eid })  "."  base64url(HMAC-SHA256)
```

The HMAC key is **not** the tenant master secret. It is a per-event key derived from the
master (`deriveEventVerifyKey`, label `event-engine/ticket-verify/v1:`). That is what makes
offline verification possible without shipping the master secret to a door device, and it
means compromising one event's device key exposes neither the master nor any other event.

```
staff mint a device token (admin auth, event-scoped, 12h default / 24h max)
  │
  └─ PWA setup: worker URL + device token
       GET /manifest/:eventId   → every issued or checked-in ticket code, plus the
                                  derived verify key, stored in IndexedDB
       │
       ├─ ONLINE   POST /checkin { code, scannedAt }
       │
       └─ OFFLINE  verify the HMAC locally against the manifest key
                   catch same-device double scans locally
                   queue the scan in IndexedDB
                     │
                     └─ on reconnect: POST /checkin/batch { scans: [...] }
```

Server side, a scan that is valid and not already checked in writes, in one D1 batch, the
ticket status change and the `me.attend` outbox row. The recorded `scannedAt` becomes the
stable `interactionDateTime`, so a batch replay cannot shift the recorded attendance time.

Outcomes: `checked_in`, `already_checked_in`, `cancelled`, `invalid_signature`,
`wrong_event`, `not_found`. The device token's event scope is enforced on manifest and
stats reads, so a door device cannot read another event.

## Tenant install and provisioning

Files: `routes/oauth-install.ts`, `routes/oauth-callback.ts`, `routes/install.ts`,
`provision.ts`, `routes/webhooks-refuel.ts`, `routes/webhooks-app-uninstall.ts`.

```
GET /oauth/install?portalId=…    signed state, redirect to HubSpot consent
  │
  └─ GET /oauth/callback?code=…&state=…
        verify state
        exchange the code for tokens
        INTROSPECT the token to learn the real portal id  ← never trust the query param
        upsert the tenants row (status "installed")
        store tokens encrypted (AES-GCM)
        if OAUTH_AUTO_PROVISION_HUBDB=true → provisionHubDbTables()
        redirect to OAUTH_SUCCESS_REDIRECT_URI (the App Home page)
```

`provisionHubDbTables` is idempotent, and order matters: `ticket_types` first (no foreign
references), then `events` with its `FOREIGN_ID` resolved to the concrete table id, then
`useForPages`, then publish both, then persist the ids to the tenants row. Re-running reuses
an existing table by name rather than creating a duplicate.

Onboarding then continues through `PATCH /api/v1/manage/onboarding/*`: Stripe connected,
the Xero-imported GST rate id, CRM routing, membership property mapping, the webinar
provider, and the dynamic-page domain. A paid reserve stays blocked until Stripe and the
GST rate are both set.

Billing runs off Refuel's own portal: `POST /webhooks/refuel` activates the tenant when the
subscription invoice is paid, and moves it to `past_due` or `cancelled` when voided. The
customer portal is resolved from the `paddock_portal_id` property on the associated deal.

`POST /webhooks/app-uninstall` sets both the tenant status and the Refuel billing status to
`cancelled`.
