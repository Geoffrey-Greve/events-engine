# event-engine: AGENTS.md

## What this is
A multi-tenant Cloudflare Worker providing native-feeling event registration for
HubSpot CMS sites. HubSpot is the system of record for contacts, marketing events,
deals, invoices, and payments, and renders the entire front end. This worker handles
ONLY what HubSpot Professional can't: atomic seat capacity, reservation holds,
waitlist, ticket/QR generation, and check-in. First tenant: Weld Australia.

Codename: event-engine (this repo). Product/marketing name: Paddock (the HubSpot
marketplace app + Project repo). Use event-engine in all code; Paddock is brand only.

## Architecture (four layers, keep them separate)
1. Participation: native HubSpot **Marketing Events** (register/attend/cancel/no-show).
2. Content/pages: **HubDB** dynamic pages.
3. Money: **Deal + line-item Products + HubSpot Invoice** → Stripe (AUD) → Xero via Data Sync.
4. Capacity/tickets: **this worker** (Cloudflare Workers + D1 + Durable Objects + Queues).

## Stack
- Cloudflare Workers, **Hono** router, TypeScript.
- **D1** = durable record (orders, registrations, tickets, outbox).
- **Durable Objects** = atomic seat math. ONE `EventCapacity` instance per event.
- **Queues** = drain the outbox (HubSpot write-back) with retry/backoff.
- **Cron** = subscription renewal, event finalize, reconciliation sweep.
- **KV** = Graph token + subscription id cache.
- Package manager: **pnpm**.
- Production hostname is `event-engine.refuel-creative.workers.dev`. `event-engine-staging.refuel-creative.workers.dev` is the former name and **does not resolve** — do not put a Worker back there.

## Non-negotiable invariants (violating these is a bug)
- **Never oversell.** All seat math goes through the EventCapacity DO. D1 never
  decrements a counter for capacity. The DO is single-threaded per event: that's
  the concurrency guarantee. No locks, no compare-and-swap in D1 for the hot path.
- **Seats commit only on payment confirm**, never on reserve. A reserve is a TTL hold.
- **Every HubSpot side effect goes through the `outbox` table** in the same D1
  transaction as the state change, then drains via the queue. No fire-and-forget
  HubSpot calls from request handlers.
- **Idempotency everywhere external.** Reserve requires an Idempotency-Key.
  Marketing Event attendance writes use a STABLE interactionDateTime (never Date.now()
  regenerated on retry) so retries are safe. Webhooks dedup on provider event id.
- **Multi-tenant from day one.** Every row carries `portal_id`. Every token/secret is
  resolved per tenant. Nothing Weld-specific in shared layers; this becomes a product.
- **The worker makes no direct Xero calls.** Invoice + payment reach Xero via HubSpot
  Data Sync. The worker's money job ends at creating the HubSpot invoice.

## HubSpot specifics that bite (encode these, don't rediscover)
- HubSpot's own payment processor is NOT available in Australia. Use Stripe connected
  as the processor; collect via HubSpot invoices/payment links in AUD.
- Marketing Events attendance endpoints REQUIRE `externalAccountId` as a query param
  (docs imply optional; it isn't).
- Contact upsert: batch-upsert-by-email is unreliable. Use single-object
  `PATCH /crm/v3/objects/contacts/{email}?idProperty=email` (real create-or-update).
- Invoice creation is multi-step: draft (currency only) → associate contact + line
  items (+ GST tax rate) → PATCH status to `open`. Can't open without a contact and
  ≥1 line item. Never send status `paid` on create.
- Invoice line items are separate objects from deal line items; create fresh ones.
- Use the GST 10% tax rate IMPORTED FROM XERO into HubSpot's tax library; don't
  hard-code 10%, or the synced Xero invoice won't reconcile.
- ATO: invoices ≥ AUD 1,000 must show the buyer's identity/ABN. Capture buyer ABN at
  checkout for company orders (optional field; some buyers are individuals).

## Microsoft Teams (online events): behind a provider abstraction
- Online events go through a `WebinarProvider` interface. Teams is the only MVP
  implementation; Google Meet + Zoom (phase 2) and Wistia/ON24/Vimeo (phase 3) follow.
  Nothing provider-specific leaks past the interface; `events.provider` selects the impl;
  attendance normalizes to a common record shape before matching.
- Teams specifics: create the webinar via Graph (never let an organizer make it ad hoc)
  so the worker owns the IDs. Webinar is created in DRAFT; must be published.
- Attendance is PULL, not push: a tenant-wide change-notification subscription on
  `solutions/virtualEvents/events` (max 1-day lifetime → renew ~12h) signals "report
  ready"; then pull attendanceReports → attendanceRecords ($expand). (Other providers
  may be push/webhook-based; the interface allows both.)
- Match attendance records to registrations by `externalRegistrationInformation
  .registrationId` (OUR id, stamped at register time) → provider registrationId →
  email, in that order. Stamp our id at register time so matching is exact.
- HubSpot generates the calendar invite + emails, so write the personal join URL to the
  contact BEFORE the confirmation workflow fires.

## Business rules (Weld), updated by Phase 18
> This file mirrors CLAUDE.md. CLAUDE.md is the authoritative copy: make a rule change
> there first, then mirror it here. This section had drifted a full phase behind (it still
> described auto-refund on late-payment oversell and automatic next-in-line waitlist
> offers, both removed by Phase 18.3), which is worth knowing if you are reading an older
> checkout.

- Members are identified by a company-level status that clones to the contact. Read it
  from the buyer's contact. Non-members CANNOT buy member-only events or member-priced
  tickets. An UNVERIFIED membership (nothing in CRM said anything at all) routes to
  support, distinct from a confirmed non-member.
- **The worker's membership gate must stay in parity with the CMS gate** in
  `weld-aus-hubspot/theme/modules/checkout-tunnel.module/module.html`. Any positive signal
  verifies membership: an active status on the contact OR the associated company, an active
  Find a Member row, or a real membership tier on either record. The CRM "no membership"
  sentinels ("Not Applicable", "Non Member", "None", "N/A"; see `MEMBERSHIP_SENTINELS`,
  kept identical to the CMS `_member-tier.html` list) scrub to blank so a corporate
  employee falls through to their employer's tier. An explicitly lapsed/expired/cancelled
  status on either record is a hard no and outranks every other signal. A narrower gate on
  the worker side is what produced the "we couldn't verify your membership" failures after
  the CMS had already quoted the buyer a member price.
  **The associated company is found the same two ways the CMS finds it**: `associatedcompanyid`,
  and failing that the contact → company association. That property is only ever set for a
  PRIMARY association and much of Weld's corporate membership has none, so reading it alone
  priced those employees as non-members and the reserve guard then refused the member price
  the page had quoted, surfacing as `price_mismatch`, "the course price changed before
  checkout", rather than as anything about membership. Equally, a signal the CMS counts and
  the worker cannot see is the same bug from the other side: a CAMS person id and a
  membership EXPIRY DATE are not membership, and the CMS checkout gate counting them is what
  quoted every logged-in migrated contact a member rate they were then refused.
- **Member pricing is TIERED by membership level + category** (corporate / industry
  supplier / individual), not a single binary member price. `resolveMembership` returns
  `{ isMember, verified, level, category }`. Non-members always pay standard. (Phase 18.1)
- **HubDB is the source of truth for member prices** (migration 0035). The tenant adds
  their sessions in HubDB and the CMS quotes the buyer from that row, so the worker reads
  the price from the same row: `hubdb-pricing.ts` finds it by `worker_event_id`, falling
  back to the HubDB row id embedded in `events.hubspot_event_id`. `pricing_rules` (resolved
  most-specific-first: ticket_type > event > portal) is now the FALLBACK for when the HubDB
  read cannot happen, and `POST /manage/onboarding/hubdb-pricing/sync` mirrors HubDB into
  it. Two independently maintained price tables is what produced the `price_mismatch`
  checkout failures; do not reintroduce a second source of truth.
- **The HubDB column names are the TENANT's schema, and the worker ships no defaults for
  them.** `hubdb_course_price_columns` is required alongside `hubdb_courses_table`, and the
  onboarding PATCH refuses a table without one. Weld's `price_gold_aud_ex_gst` family is
  Weld's, not the product's: as built-in defaults they would have every other portal read
  columns that do not exist, read the emptiness as "no member price for this course", and
  price every member off the stale `pricing_rules` copy, the exact failure this path
  exists to end, arriving silently. An unmapped portal stays on `pricing_rules` and says so
  (`hubdb_pricing_columns_unmapped`). `hubdb_courses_event_id_column` does default
  (`worker_event_id`): that column holds OUR id, not the tenant's data.
- **`pricing_rules` falls back by LEVEL as well as by category.** Within each scope the
  buyer's own tier is tried first, then the generic `member` level. A course priced at a
  single `price_member` syncs to one rule at `member_level = 'member'`, so a Gold buyer
  querying `gold` alone would find nothing and drop to the public price, a guaranteed
  `price_mismatch` at precisely the moment HubDB was unreadable and the fallback was
  supposed to save the booking.
- **The reserve price guard is directional.** `comparePriceQuote` (reserve.ts) rejects only
  when the resolved price is HIGHER than the `expectedUnitCents` the checkout displayed. A
  lower resolved price is honoured and logged (`price_drift` / `honoured_lower`): never
  invoice more than was displayed, never turn a buyer away over a stale page.
- **Refunds are per-event policy** (full / partial / transfer). A policy resolves
  event.refund_policy_id > category default template ("team" = event category) > portal
  default > built-in full-refund-to-30-days. Partial after the cutoff uses
  `partial_refund_percent`. **Transfer** reassigns a registration to a new attendee without
  refunding (seat kept, ticket reissued, Marketing Event reassigned), gated on
  `allow_transfer`. (Phase 18.2)
- Reservation hold: 15 minutes when the buyer pays at checkout (card). A buyer resolved as
  INVOICE-ELIGIBLE holds the seat until the HubSpot invoice due date instead
  (rule termsDays > portal default > 30 days, capped at 90). Eligibility is a per-tenant
  RULE resolved most-specific-first (contact_property > company_property > membership_level
  > always); a portal with no active rules treats every paid booking as eligible, and any
  failure degrades to eligible rather than shortening a live hold. (Phase 4.1 / 4.2)
  Waitlist offer TTL = 30 minutes.
- **Oversell + waitlist are HUMAN-IN-THE-LOOP: the worker never auto-resolves.** (Phase 18.3)
  - Late-payment oversell: the payment is captured but the seat is NOT committed; the order
    goes `needs_review`, a pending decision is opened and a HubSpot task is assigned to the
    event owner, who HONOURs (force-confirm + issue ticket) or REFUNDs (per policy). There is
    no `allow_oversell` auto-honour and no auto-refund default.
  - Waitlist: a freed seat does NOT auto-offer next-in-line; it opens a waitlist decision +
    owner task. The owner picks who to offer to; the DO re-validates at confirm so a chosen
    offer can't oversell. `joinWaitlist` still records waiters; only promotion is manual.
- GST: default `gst` (10% included), per-ticket `tax_treatment` toggle surfaced in the admin
  App Card; `gst_free` maps the invoice line to the imported Xero GST-free rate. (Phase 18.1)
- **Corporate training vouchers: D1 is the source of truth, HubSpot is the projection.**
  `orders.member_company_id` links a booking to the company whose vouchers it draws on, and
  usage is DERIVED from order state (`vouchers.ts`), never incremented, so the outbox sync is
  safe to replay and a refund/expiry returns the voucher with no compensating write.
- Certificates: deferred (the data model already supports them, no work now).
- Capacity is event-level + per-ticket-type. No per-session capacity (not in scope).
- **A seat stops being for sale two different ways, and they are two columns.** (0038)
  `events.registration_closes_at` is the CLOCK: NULL resolves to the event's own `starts_at`,
  not to "never", because a course that has begun is not something the website should still
  be selling. A date-only write resolves to the END of that day in `tenants.display_timezone`.
  `events.sales_paused` / `ticket_types.sales_paused` is a PERSON stopping sales by hand;
  reversible, and it leaves capacity alone so no report reads the event as oversold against a
  total of zero. **Closing sales moves no seats**: existing holds run to their own expiry and
  an unpaid invoice stays payable. Staff (`staff_manual`) are exempt from both; `corporate_bulk`
  is not, because a self-service path that ignores the cutoff is the cutoff not existing.
  **Every public booking route checks it, and `/reserve-selected-modules` checks it TWICE**
  (Ref 74): the PARENT course's window and each selected module's own, because a module is a
  separately sold session and a course still selling can carry one that ran last week. The
  per-ticket-type pause too. Both rejections name the module, and all of it lands before the
  DO, so a booking about to be refused never first takes a hold that runs to the invoice due
  date. That route had no gate at all, which was the cutoff not existing for anyone who
  reached the course page's module selector.
- **Custom registration questions are managed in the app card**, or the mechanism is not
  available to the tenant (Ref 74). `EventManagement.tsx` lists the RESOLVED set for an event
  (its own plus the tenant-wide defaults it does not override), adds at either level, and
  archives, saying on each row which level it belongs to: retiring a tenant-wide question from
  an event card stops it being asked everywhere. **The mapped contact property is created
  through the OUTBOX** (`question.ensure_property`, enqueued in the same D1 batch as the
  question), never inline: a direct POST in the request left a timeout looking like a failed
  save on a question that had in fact been written, and the retry could only earn
  `duplicate_key`. The request still READS whether the property exists, because an admin is
  owed that answer while they are looking at the form.
- **`attendeeAnswers` is how the SINGLE-SEAT shorthand answers a per-seat question.** The
  `ticketTypeId` form has the worker synthesise the attendee from the buyer, and a synthesised
  attendee carried no answers, so a required attendee question made every public one-seat
  booking impossible. Kept separate from `answers` (the ORDER scope) because the two validate
  against different question sets and a key in the wrong one is rejected by name.
- **A company block is an INVOICE, not a new state.** (Ref 74b, 0039) `registrations.seat_unnamed`
  marks a seat sold and held with nobody on it. It prices, holds and invoices exactly as any
  other booking, so it drops public availability immediately through the existing seat math.
  Nothing person-shaped runs for it: no `me.register` (participation is keyed on a CONTACT, and
  an empty email would have HubSpot invent one), no webinar registration, no ticket, no contact
  write-back, and it is invisible to the duplicate-attendee guard. Naming a seat is the ordinary
  Phase 3 amend, so partial naming is free. A required question is NOT enforced against an
  unnamed seat; the gap is reported as `unnamedSeats` on the 2.2 summary instead.
- **Who voids an unpaid invoice is a per-portal choice.** (0039) `tenants.unpaid_invoice_mode`:
  NULL/`'auto_void'` is the default and is what the worker has always done; `'manual_review'`
  opens an `unpaid_invoice` decision and an owner task instead of voiding, because a void is
  terminal in HubSpot and for a company block the invoice IS the booking. It governs the
  INVOICE only: the seat still returns to sale when its hold lapses under either mode.
- **Still open:** hybrid events (in-person + Teams attendance dedupe), not yet decided.

## Conventions
- All timestamps ISO 8601 UTC in D1. Display tz default Australia/Adelaide.
- Money in integer cents, currency AUD.
- Secrets via Wrangler, named `{PREFIX}_{portalIdOrTenantId}`.
- Every handler: validate → mutate D1 (+ outbox in same txn) → enqueue → respond.
