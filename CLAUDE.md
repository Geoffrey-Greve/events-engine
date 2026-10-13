# event-engine: CLAUDE.md

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

## Worker hostnames
- Production: `https://event-engine.refuel-creative.workers.dev` (`wrangler deploy --env=""`).
- Dev: `https://event-engine-dev.refuel-creative.workers.dev` (`--env dev`).
- `event-engine-staging.refuel-creative.workers.dev` is the **former name of production**. It was renamed; that hostname does not resolve. Do not deploy another Worker (or a reverse proxy) under that name. Anything still pointing at it is supposed to fail so it gets moved onto `event-engine`.

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
- **Stored prices are TAX-EXCLUSIVE, and the worker computes no tax.** A line item is sent
  at the price we hold, carrying the portal's tax rate id, and HubSpot applies the rate on
  top. There is no rate constant anywhere in this codebase, on purpose: `gstExclusiveCents`
  divided every taxable line by 1.1 first, on the reading that stored prices already
  contained GST. They do not: the tenant enters them ex GST (Weld's HubDB columns are
  named `price_gold_aud_ex_gst`, and the website labels every price "ex GST"), so each
  invoice came out a tax fraction below the price the buyer was quoted. And a hard-coded
  Australian 10% in a multi-tenant product is wrong the moment a portal's tax library holds
  15% GST, a 20% VAT or a US sales tax. If a tenant ever does enter prices tax-inclusive,
  the answer is a tenant flag plus HubSpot's own rate, never a number in the code.
  `gst.test.ts` books a line through `invoice.create` and reads the POSTed amount back.
  - **So a refund has to be grossed up, and the invoice supplies the ratio.** D1 records
    what a seat cost EX tax (that is what the line was sent at and what the tenant quoted),
    while the money captured is larger by whatever HubSpot added. A partial refund posted
    at the D1 amount hands back the price and keeps the tax. `grossUpRefundToInvoiceTax`
    scales by the invoice's own total ÷ subtotal, HubSpot's arithmetic at HubSpot's rate,
    the same reasoning that took the rate out of the line builder, and degrades to the
    unscaled amount, logged, when HubSpot cannot be read or the two figures disagree.
    Under-refunding is recoverable by a human; money already returned is not.
  - **The CMS quotes the Worker the EX-GST price.** `expectedUnitCents` /
    `expectedTotalCents` from the checkout tunnel are the HubDB figure, not the buyer's
    inc-GST total. A GST-inclusive quote would read as `price_drift` on every booking.
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
  **The contact's mirror of its employer is read too** (QA Ref 98; the tenant's
  `membership_mirror_tier_property` / `_status_property`, which on Weld's portal are
  `wa_company_membership_tier` / `_status`), as a fallback for a company record that says
  nothing: the record
  outranks it, as in `_member-company-resolve.html`. The checkout page is ungated, so the
  CMS's own `crm_object` company reads come back empty there and the mirror is close to
  the only company signal it has. An employee carrying the mirror with no reachable company
  was quoted the member rate and refused `membership_unverified`.
  **The CMS's QA personas (`portal_test_profiles`) are a signal the worker does NOT see,
  and must not be taught to by email alone**: `buyer.email` is unauthenticated, so honouring
  a `+portal-qa-…@` address here would sell member rates to anyone who types one.
- **Every membership SOURCE is tenant configuration, and an unmapped one is not read.**
  (Migration 0046) The company property families, the contact's mirror of its employer and
  the Find a Member HubDB directory were Weld's names hard-coded in `membership.ts` and asked
  of every portal. They are `tenants.membership_company_sources` (JSON, priority order, of
  `{ category, statusProperty, levelProperty }`: the first family carrying a status decides,
  failing that the first carrying a level), `membership_mirror_status_property` /
  `_tier_property`, and `member_directory_config` (JSON `{ table, emailColumn, tierColumn,
  activeColumn, companyIdColumn }`), set through `PATCH /manage/onboarding/membership-config`
  (`companySources`, `mirrorStatusProperty`, `mirrorTierProperty`, `memberDirectory`; `null`
  clears, a malformed shape is a 400) and reported by `GET /manage/onboarding` under
  `membership`. NULL is no request at all, answering as a source that said nothing, like an
  unmapped HubDB price column: there are no built-in names, because a default here is Weld's
  schema under another label. `category` is one of the canonical three.
  - **The migration backfills every portal that existed on deploy** with exactly the names
    the code read before, so no installed portal changes. It also sets
    `membership_status_property` / `membership_level_property` to
    `individual_membership_status` / `individual_membership_type_2` WHERE they were NULL:
    `resolveMembershipProfile` read those by name regardless of config, and they are what
    the CMS checkout gate reads. A portal that had chosen its own names keeps them.
  - **Deploy step:** after migrating, confirm with `GET /manage/onboarding` that Weld's
    portal carries the backfilled values. A portal installed later must PATCH
    `membership-config` before any company, mirror or directory signal is read; until then
    its corporate employees verify only off their own contact.
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
- **The EVENTS table is a pricing source too, and a tier may be a PERCENTAGE** (migration
  0044, QA ref 73). 0035 called all of this "course" pricing and by 0044 that was only ever
  a name: nothing in `hubdb-pricing.ts` is course-specific, it reads a table with an
  event-id column and some price columns. Weld type `member_price`, `non_member_price` and
  `bronze_/silver_/gold_discount_` into their `events` HubDB rows exactly as they do into
  `courses` rows, and until 0044 nothing read one - so every event priced off
  `pricing_rules`, the separately maintained copy, with the tenant having no way to know
  which of the two numbers they were looking at was live.
  - **A LIST of sources, not a second code path.** `loadHubDbPricingSources` returns the
    configured tables (`hubdb_courses_table`, then `hubdb_events_table`) and the resolver
    takes the FIRST one holding a row for the event. Courses and events go through one
    function; a third table is another row of config. An event costs one extra filtered
    HubDB read per resolution, which is the price of not having two of these.
  - **Every source is asked by event id before ANY of them is asked for a row by id.** The
    by-id fallback reads a row id out of `hubspot_event_id`, and a HubDB row id does not say
    which table it belongs to, so asking `courses` for an id that came out of `events` can
    only mislead. It is the last thing tried, never the second.
  - **Two shapes, because tenants use both.** `courses` names an absolute column per tier
    (`price_gold_aud_ex_gst`); `events` names the public price once and states each tier as a
    percentage off it. Forcing one into the other would leave two columns per tier
    disagreeing the moment somebody edits the wrong one, which is this whole family of
    fault. `hubdb_*_discount_columns` maps a level to its percentage column, and is
    available on BOTH tables so the two sources are genuinely one shape.
  - **The percentage comes off the NON-MEMBER price** (Ryan, 2026-09-20), which is what
    "Gold members get 20% off" means on a page showing one public figure. The chain is:
    the level's own absolute column → the level's own discount → `member` → `individual` →
    `nonMember`. The buyer's tier outranks the generic member price in BOTH its shapes,
    which can cost more than `member_price` and is still right: the page quotes the tier.
  - **A percentage outside (0, 100) is ignored**, not honoured. 0 is "nobody entered one",
    the state of most rows; 100 or more gives a seat away, and a fat-fingered cell is far
    likelier than a tenant meaning it. A free seat is a 0 in the absolute column, where it
    is unambiguous.
  - **A discount column is refused without a `nonMember` price column** to take it off:
    a percentage off nothing can never apply, which is configuration that looks set and
    prices nothing - the same silent inertness `price_columns_required` exists to refuse.
  - **`resolveHubDbPublishedPrices` includes the discount-derived prices**, or
    `reconcileMemberQuote` would refuse exactly the quotes 0044 lets a tenant state.
  - **`resolvePrice` now reads `ticket_types.member_only` itself.** Keeping the public price
    off a member-priced seat was answered by the row's own `member_ticket_type_id`, a column
    that exists on Weld's `courses` table and on no other source - so the guard needed a
    half that reads D1 and works for every table. Reaching it means the CMS and the worker
    disagree about membership; repricing the seat at the public rate would turn that
    disagreement into a refused checkout, which `GET /manage/diagnostics/pricing` exists to
    surface instead.
  - The diagnostic reports `configuredSources` (every table) AND `source` (the one the row
    came out of): "configured but no source held a row" and "found, in the table you did not
    expect" are different answers, and the first is unreadable from the second alone.
  - **No app-card UI yet, deliberately.** Configuration is the admin PATCH. Which price
    source a tenant uses is the "later we give customers an option" half of Ryan's scoping;
    this half is that the number they already typed is the one they get charged.
- **The PUBLIC price comes from the same HubDB row as the member price.** `resolvePrice`
  returned `ticket_types.price_cents` for a non-member without ever reading HubDB, which
  left the standard price as the one number the worker still kept its own copy of - the
  exact second source of truth migration 0035 removed for member prices, surviving on the
  side of the buyer who has no membership to argue about. Nothing reconciled the two
  copies and nothing refused their difference, because the CMS sends a guest's quote as
  `quotedUnitCents`, which only measures.
  - **It surfaces as GST charged twice, not as a price disagreement.** The CMS adds 10% on
    top of the HubDB figure it displays and HubSpot adds the portal's rate on top of the
    figure we invoice, so the moment those are two different numbers held to two different
    tax bases the buyer reads "$5,113.64 + $511.36 = $5,625.00" on the page and is billed
    $6,187.50. Neither side is computing tax twice; they are each computing it once, on a
    different base.
  - `resolveHubDbStandardPrice` reads the `nonMember` column and **nothing else** - no
    fallback chain, unlike `resolveHubDbMemberPrice`, because a member column must never
    price a guest. A blank column, an unmapped column, an unreadable HubSpot: all return
    null and keep `ticket_types.price_cents`, so this cannot fail a booking, and a portal
    that has not mapped its public column is exactly where it was.
  - The member fallback still discounts off `ticket_types.price_cents`, not off the HubDB
    public price: `pricing_rules` percentages were written against the D1 figure.
  - The CMS half is `expectedUnitCents` for a guest now, where it was `quotedUnitCents`
    (weld-aus-hubspot CLAUDE.md § 6.7). Enforcing it was held back while the two stores
    were expected to disagree; they read one row now, so the only way the resolved price
    still exceeds the displayed one is a HubDB read that failed - the exposure the member
    path has always carried - and the guard is directional, refusing only an invoice that
    would come in ABOVE what the buyer was shown.
- **`pricing_rules` falls back by LEVEL as well as by category.** Within each scope the
  buyer's own tier is tried first, then the generic `member` level. A course priced at a
  single `price_member` syncs to one rule at `member_level = 'member'`, so a Gold buyer
  querying `gold` alone would find nothing and drop to the public price, a guaranteed
  `price_mismatch` at precisely the moment HubDB was unreadable and the fallback was
  supposed to save the booking.
- **A VERIFIED MEMBER is never refused over a price the tenant published.** The guard
  below refuses when the worker resolves ABOVE the page's figure, which is right for a
  stale page and wrong for the failure that kept reaching Weld's members: the CMS and this
  worker each resolve the buyer's membership LEVEL from the same CRM through different
  reads, land on different levels, pick different columns on the same HubDB row, and the
  higher one refuses the booking. The buyer is a member, the page quoted them a real member
  rate, and "the course price changed before checkout" describes a change that never
  happened. It recurs because the disagreement is CONFIGURATION - which property holds the
  tier, which record carries it - and no amount of code parity on either side settles that.
  `reconcileMemberQuote` (pricing.ts) charges the quoted figure instead, and three bounds
  keep that from being "the client sets the price":
  - **Verified members only.** A guest, or anyone whose membership could not be confirmed,
    is untouched: their disagreement is about MEMBERSHIP, and answering it with a price
    would sell a member rate to someone not shown to hold one. The member-only gates are
    unchanged.
  - **A published price only.** The candidates are read off the buyer's OWN session row
    (`resolveHubDbPublishedPrices`), so a wrong level can only ever cost another of that
    session's advertised rates. A caller cannot name a number, only match one the tenant
    wrote. An unreadable row yields an empty set, which leaves the guard exactly as it was:
    being unable to confirm a quote is the tenant's own is never permission to charge it.
  - **It is louder, not quieter.** `member_quote_reconciled` logs both figures, the page's
    tier and the level we resolved, so the mapping fault is still there to be found - it
    just stops being found by a customer.
  Scoped to a booking with ONE ticket type (a single per-unit quote means one thing) and to
  `expectedUnitCents` (the measuring field refuses nothing, so it has nothing to rescue).
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
- Reservation hold = 15 minutes for a free booking's transient hold; a booking that
  QUALIFIES FOR INVOICE TERMS (see below) holds its seat until the HubSpot invoice due date
  instead, so a buyer paying by bank transfer keeps both seat and payment link. Terms
  resolve staff-chosen date > `events.invoice_due_days` > the matched eligibility rule's
  `terms_days` > `tenants.invoice_due_days` > 30 days, capped at 90. Waitlist offer TTL =
  30 minutes.
- **The invoice due date never lands after the session starts.** (`capDueDateToEventStart`)
  The hold runs to the due date, so holding a seat past the moment the course begins is
  meaningless whatever anyone configured: a flat 30 days on a course ten weeks out frees the
  seat six weeks early, and the same 30 on a booking taken the day before the course leaves
  an invoice falling due a month after it ran.
  - **A CAP, not config.** `invoice_due_days` is a day COUNT from the booking, so it cannot
    express "hold the seat until the course", and setting it per event is worse rather than
    better: a day count is correct on the day someone types it and stale every day after.
    Nothing to enter per event, and it cannot go stale.
  - **The start is a LOCAL calendar date** in `tenants.display_timezone`, never
    `iso.slice(0, 10)`: a 9am Adelaide start is 23:30 UTC the day before, and a due date a
    day early frees the seat the afternoon before the course.
  - **It never moves a date into the PAST** — a session that has already begun is refused by
    the registration cutoff (migration 0038), not by a due-date error on a booking staff may
    be making deliberately — and **it never overrides a date staff typed**, which is a human
    decision about one booking and outranks a rule, as it does everywhere else terms resolve.
  - `MAX_INVOICE_DUE_DAYS` still applies, so a course more than 90 days out holds for 90.
- **Who may pay on terms is a RULE, not a flag on a contact.** (Phase 4.2, migration 0029)
  Phase 4.1 fixed the AWS D1.1 fault (the hold now runs to the invoice due date) by giving
  the long hold to every paid booking. `invoice_eligibility_rules` decides who it was
  actually for, and `orders.payment_method` (`card` | `invoice`, NULL when free) +
  `orders.payment_terms_days` record what each booking was granted.
  - **Resolved most-specific-first, the way `pricing_rules` is**, and specificity belongs to
    the KIND rather than the row: `contact_property` > `company_property` >
    `membership_level` > `always`. `priority` (then recency) only breaks ties WITHIN a kind,
    so no portal-wide rule can outrank one that names an individual. `min_cents` is a floor
    on the booking total: a rule the booking does not clear simply does not match, which is
    what makes "gold members may invoice anything, everyone else only above $1,000" two
    ordinary rows.
  - **An empty rule set is "not configured", never "nobody qualifies".** A portal with no
    active rule keeps 4.1's behaviour: every paid booking invoice-eligible. Reading empty as
    "everyone pays at checkout" would reinstate the 15-minute hold for every existing tenant
    on deploy, which is the fault, not the fix. A tenant opts in by writing a rule;
    `match_kind = 'always'` is how "everyone qualifies" is said explicitly.
  - **It fails OPEN, and never turns "cannot see" into "not there".** A missing table, an
    unreachable HubSpot, an UNVERIFIED membership: all degrade to eligible-with-default-terms
    plus a warning log. Of the two ways to be wrong, one grants a longer hold on an invoice
    nobody has paid; the other cancels a real booking's seat and voids its invoice fifteen
    minutes after a customer made it. A rule that could not be evaluated is not a rule the
    payer failed, so a LESS specific rule that does match still decides.
  - An INELIGIBLE payer pays at checkout: the DO's own 15-minute TTL, and an invoice raised
    due on receipt rather than not raised at all; HubSpot's hosted invoice is still how the
    money is collected. `hold_ms` may hold an eligible payer's seat for LESS time than the
    invoice runs; the seat returns to sale while the invoice stays payable, and a payment
    landing afterwards takes the existing late-payment route.
  - **Eligibility decides the hold's LENGTH and nothing else.** A hold is still a hold:
    nothing here commits a seat, and no path commits one on invoice issue. Changing that
    would break a documented invariant and needs a written decision from Ryan plus an
    explicit carve-out here.
- **An invoice is issued and falls due on CALENDAR DAYS, and the issue date is never the
  later of the two.** (Ref 40, items 1/3/4/6) `hs_due_date` was pinned to its day's UTC
  midnight while `hs_invoice_date` carried the current INSTANT, so a booking with no
  invoice terms — a guest paying at checkout, due on receipt, i.e. due TODAY — was issued
  an invoice that had fallen due hours earlier. HubSpot permits that on a DRAFT and refuses
  the PATCH to `open`, and everything downstream of opening is what the customer noticed:
  no invoice email, no hosted payment link written back to the order, a buyer left on "your
  place is being held, we'll email you shortly", and a draft the HubSpot UI itself answers
  with "There was a problem with the invoice". Both dates are now that day's UTC midnight —
  the same frame `dateOnly(0)` in `reserve.ts` picks the due date in, because deriving one
  of them in `tenants.display_timezone` and the other in UTC is how they come apart again —
  and UTC midnight rather than end-of-day because HubSpot renders these in the portal's
  timezone, where 23:59:59Z reads as the next day in Adelaide. A due date already in the
  past (reissuing a booking made months ago) is what the customer was told, so the issue
  date gives way to it rather than the other way round.
- **Which HubSpot line item belongs to which booking line is recorded in D1, not read back
  out of HubSpot.** (Ref 40 item 2, migration 0041) `attachExclusiveLineItems`
  answered "have we created this line yet" by listing the invoice's associated line items.
  That makes HubSpot's association index the memory of what this worker did, and an empty
  answer there means "cannot see", never "not there" — the same distinction Phase 6.1
  refuses to blur for properties. With `max_retries = 3` a handler that fails after
  attaching its line runs four times, so one $18,786.36 guest booking was invoiced at
  $75,145.44 across four identical lines. `hubspot_line_items` names each line by the
  `hs_external_id` the write-back already stamps on it, and is written IMMEDIATELY after the
  create and before the retryable association PUT, exactly as `hubspot_invoice_id` and
  `hubspot_deal_id` already are and for the same reason.
  - **It degrades to the old matching rather than failing a booking** when the table is
    absent (Ref 217 schema drift): worse, but not a booking nobody can pay for.
  - **Surplus is cleaned up, and only ours.** A line carrying an external id we just wrote
    for this booking, or a registry row for a ticket type the booking no longer has, is
    archived. A line a human added to the invoice is not ours and is left alone, which is
    also what stops this becoming a way for one booking to rewrite another's invoice.
  - `hs_external_id` is the third place a portal can refuse that property — `createLineItem`
    already had fallbacks for the search and the create — so the batch read has one now too,
    instead of taking the whole write-back down before a single line is attached.
- **A voided HubSpot invoice cannot be un-voided, so reissue mints a new one.** (Phase 4.2)
  HubSpot has no "cancelled" invoice status; `voided` is the only terminal one, so an expired
  hold's unpaid invoice is closed by voiding it. That is irreversible, and D1.1's customer was
  left with nothing to pay. Two halves to the fix:
  - `POST /api/v1/manage/events/:id/orders/:orderId/reissue-invoice` gives the same order a
    fresh invoice (same deal, same lines, priced from `reservation_items` so a booking made
    months ago is not silently re-priced at today's rates) and **re-takes the seat through
    the DO**, which may refuse: a sold-out event fails the reissue with `event_full` rather
    than overselling. The superseded invoice id is closed explicitly, so a portal never holds
    two payable invoices for one booking. Refuses an order that actually took payment:
    undoing that is a refund decision with a policy behind it.
  - The expired-hold void row is enqueued at expiry and DRAINS later, and in that gap the
    booking can come back (a late payment → `needs_review`, or a reissue). So
    `payment.refund` carrying `reason: 'expired_hold'` **re-reads the order at drain time and
    stands down unless it is still `cancelled`**. Every other reason voids as asked: they name
    an invoice a decision already settled.
- **Oversell + waitlist are HUMAN-IN-THE-LOOP: the worker never auto-resolves.** (Phase 18.3)
  - Late-payment oversell: the payment is captured but the seat is NOT committed; the order
    goes `needs_review`, a pending decision is opened and a HubSpot task is assigned to the
    event owner, who HONOURs (force-confirm + issue ticket) or REFUNDs (per policy). There is
    no `allow_oversell` auto-honour and no auto-refund default.
  - Waitlist: a freed seat does NOT auto-offer next-in-line; it opens a waitlist decision +
    owner task. The owner picks who to offer to; the DO re-validates at confirm so a chosen
    offer can't oversell. `joinWaitlist` still records waiters; only promotion is manual.
  - **The decision is the RECORD; the task is only the TELLING.** (migration 0042) The
    `pending_decisions` row is written to D1 first and the App Card lists and resolves it
    either way, so a portal whose credential cannot write tasks loses the notification and
    not the queue. `crm.objects.tasks.write` is unavailable to BOTH 2026.03 project apps and
    account service keys, so such a portal sets `tenants.task_sync_mode = 'off'` (NULL =
    raise the task, so no installed portal changes on deploy) and every decision stops
    enqueuing a `notify.owner_task` row that can only 403 and die. A permanently-firing
    `outbox_dead` is how a REAL dead row stops being noticed, and `outbox_dead` is what
    found the credential fault this column was written for. Turning it off resolves nothing
    and changes no decision's lifecycle.
  - **With tasks off, `GET /api/v1/app-home/pending-decisions` is the notification.** The
    per-event card answers "what does THIS event need", which is only ever asked by someone
    already looking at the event; nothing answered "what needs me, anywhere", because the
    assigned task always had. The App Home list is read-only on purpose: resolving needs the
    order, the refund policy and the waitlist on screen beside it, which is the event card's
    job. Naming a gap and fixing it are different surfaces.
- GST: default `gst`, per-ticket `tax_treatment` toggle surfaced in the admin App Card;
  `gst_free` maps the invoice line to the imported Xero GST-free rate. Both treatments send
  the line at face value: the treatment picks WHICH rate id rides along, never an amount.
  (Phase 18.1, corrected when prices were confirmed tax-exclusive; see above.)
- **Training vouchers are redeemable credit, issued on the HubSpot company record.**
  Two tenant-selectable models (`tenants.voucher_mode`, this is a product not a Weld feature):
  `seat`: one voucher covers one seat outright, whatever it costs; `credit`: a dollar balance
  drawn down by the seats it covers; `off`. The total/used property NAMES are per-tenant
  (`voucher_total_property` / `voucher_used_property`), following the same convention as
  `membership_level_property`. Staff issue vouchers by setting the total in HubSpot; there is
  no purchase flow in the worker.
- **Redemption covers WHOLE seats only, most expensive first.** A covered seat becomes a $0
  invoice line (the attendee still shows on the invoice; the money was taken when the voucher
  was sold) and uncovered seats are invoiced normally. Under `credit`, leftover smaller than the
  cheapest remaining seat carries forward rather than part-paying a seat, and that is what keeps
  every line full price or zero, with no discount lines to reconcile in Xero.
- **The voucher mapping has an endpoint, and the unconfigured state is ON.**
  `PATCH /manage/onboarding/voucher-config` sets `voucher_mode` and the two company
  property names; `GET /manage/onboarding` reports them. Every other per-tenant mapping has
  had one since its feature landed and this did not, so configuring vouchers meant a
  hand-written UPDATE against production D1 — the "fully built, nothing to drive it with"
  gap the 2.3 questions had before the app card rendered them.
  - **`loadVoucherConfig` defaults to `seat` / `vouchers_total` / `vouchers_used`, not
    off.** So a portal that has never configured this is not vouchers-off: it reads an
    allowance property it does not have, resolves every company to a zero balance, covers
    no seats, and its usage write-back dies on a property the portal lacks. Weld is exactly
    that portal — their allowance is `vouchers_allowance`, their usage
    `vouchers_used__training` — so their allowances were not being honoured at all. The
    default is not flipped to `off` here because redemption is opt-in per request, which
    makes the state noisy rather than dangerous; the fix is to configure it.
  - **Turning vouchers on REQUIRES both property names**, the same rule and the same reason
    `PATCH /onboarding/hubdb-pricing` refuses a courses table without its price columns:
    there are no built-in names worth falling back on, and a half-configured portal is
    silently inert rather than visibly broken. `mode: 'off'` needs nothing. The guard is
    about the END state, so a portal that mapped its names earlier can switch mode alone.
  - `source` (`mapped` / `default`) and `usingDefaultProperties` are reported for the
    reason Phase 6.1 reports the same distinction: a default name is a question, not a
    success.
  - **ONE pool per tenant, and that is a present-tense limit.** Weld carries
    `vouchers_used__training` AND `vouchers_used__engineering` against a single
    `vouchers_allowance`. Their vouchers are believed to be all training today, so the
    mapping points at that one; separating the pools needs a selector the worker does not
    have (what decides which pool an event draws on), and guessing it would be a schema
    nobody asked for. Until then the worker's derived usage will disagree with Weld's own
    arithmetic for anything drawn from the engineering pool.
- Redemption is **opt-in per request** (`redeemVouchers`), set by corporate bulk register only:
  `memberCompanyId` alone is also sent to unlock member pricing, and must not let an employee's
  own checkout quietly spend the company balance.
- **Vouchers are credit, NOT a booking quota**: an exhausted balance no longer blocks a
  corporate booking; the seats are simply invoiced. (Changed when redemption landed; the old
  `insufficient_vouchers` 409 is gone.)
- **D1 is the source of truth, the HubSpot property is a projection.** Usage is DERIVED by
  summing `orders.voucher_seats_redeemed` / `voucher_credit_cents` over `paid`/`confirmed`
  orders (`vouchers.ts`), never incremented, so the outbox sync is safe to replay and a
  refund/expiry returns the vouchers with no compensating write. Summing per-order redemption
  (not seat count) is what stays correct when a booking is only partly covered. The used
  property = `baseline` (usage predating this worker, captured once per company) + committed
  redemption. Booking additionally charges against `pending`/`needs_review` so concurrent
  checkouts can't over-allocate the same balance during the hold window.
- **Attendee contact capture (phone, suburb, state) never overwrites HubSpot.** (Phase 1.2)
  Captured at reserve time onto `registrations.attendee_phone/_suburb/_state` (NULL = never
  asked) and written back through the `contact.sync_attendee_details` outbox topic.
  - **Target is the ATTENDEE's contact, never the buyer's**: the buyer is routinely a
    colleague booking on someone else's behalf. Marketing Event registration is likewise
    per attendee (`me.register` upserts the attendee's contact by their own email and
    stamps `registrations.hubspot_contact_id`); either handler may run first, so both
    create the contact if it is missing and both stamp the id.
  - **Default to HubSpot's STANDARD properties**: `phone`, `city`, `state`. An Australian
    address's suburb line IS HubSpot's City field. `tenants.contact_phone_property` /
    `_suburb_` / `_state_` override per field for a portal that keys them elsewhere, and
    `'off'` disables a field; NULL means "use the standard one".
  - Per field: HubSpot empty → write; HubSpot equal after canonicalisation (phone digits
    with +61 folded onto the leading 0, state name ↔ code) → no-op; HubSpot different →
    **open a `contact_conflict` decision and leave the stored value alone**. Creating a
    missing contact carries the attendee's name; an existing contact's name is never
    rewritten, for the same reason its phone number isn't.
  - The owner resolves `keep` (HubSpot wins) or `overwrite` (replays the captured values
    through the outbox with `force`). One decision per registration listing every
    conflicting field, deduped by a partial unique index while open.
- **Staff notes are internal, and append-only.** (Phase 1.3) `registration_notes` holds
  staff-typed text against a registration or the order behind it, with `author` = the
  HubSpot user id (or `'system'`).
  - **Never attendee-facing.** A note must not reach a ticket, an invoice, a confirmation,
    or the buyer's order-status poll. Nothing on the public side of the worker reads the
    table, and `notes.test.ts` books a real seat with a note on it and reads every
    attendee-facing surface back to keep it that way.
  - **No edit, no delete.** A correction is a second note; the first one keeps standing
    next to it. There is no PATCH or DELETE route, by design.
  - **Mirrored to HubSpot's own Note engagement** (`hs_note_body` / `hs_timestamp` /
    `hubspot_owner_id`) through the `note.create` outbox topic, the standard object, not a
    custom property, so the note lands on the timeline staff already read. A registration
    note goes on the **attendee's** contact, an order note on the booking's **deal**
    (falling back to the buyer's contact when a free booking has none).
    `tenants.note_sync_mode = 'off'` keeps a tenant's notes inside the worker; notes write
    access is an optional OAuth scope, so a portal that has not granted it keeps taking
    notes rather than collecting a dead outbox row per note.
  - The note staff type on a manual booking is one of these, stored against the order. It
    is deliberately NOT copied into the `deal.create` payload or the Worker log: internal
    text gets one home, not three.
- **Attendance lands on the contact; certificates are NOT built here.** (Phase 2.1) Ollie's
  Data Hub flow already renders and delivers membership certificates from a contact property,
  and events feed that same mechanism: the worker renders, stores and delivers nothing, or
  members end up with two differently-shaped certificates.
  - A check-in (and a matched webinar attendance record) writes an attended flag, an
    attendance DATE and the event name to the **attendee's** contact through the
    `contact.sync_attendance` outbox topic, using a per-tenant property mapping exactly as
    1.2 does: `tenants.contact_attended_property` / `_attended_date_` / `_attended_event_`,
    NULL = the default name (`event_attended` / `event_last_attended_date` /
    `event_last_attended_name`), `'off'` disables a field. Unlike phone/city/state there is
    no HubSpot STANDARD property for this, so the default is a named custom one, which
    **the worker creates itself**, via the one provisioning routine described under Phase 6.1
    below (`POST /onboarding/properties`). The trio's shape lives here, in
    `ATTENDANCE_PROPERTY_DEFINITIONS`, and `properties.ts` imports it.
  - These properties hold the LATEST attendance, not a history: one contact attends many
    events. **The date never moves backwards:** outbox rows drain out of order, and a
    straggler for last month's course must not overwrite this morning's or the certificate
    names the wrong event. The event name only moves with the date it belongs to.
  - The per-event history stays in D1 and is read through
    `GET /api/v1/manage/events/:id/attendance`, per-registration state derived from the
    tickets (a door scan) and the matched `me.attend` record (a webinar join), so online and
    in-person events answer the same way. Attendance is derived, never a second stored copy.
  - Attending is a fact: a later refund does not un-attend someone who walked in the door.
- **Registration reporting reads D1 and only D1.** (Phase 2.2) The attendee list
  (`GET /api/v1/manage/events/:id/registrations`, paginated), the CSV of the same rows
  (`.../registrations.csv`) and the cross-event roll-up
  (`GET /api/v1/manage/reports/registrations?from=&to=&category=`). Building any of them off
  HubSpot would make the report disagree with the engine that sold the seats, which is the
  argument the surface exists to end.
  - **One derivation, shared.** "Did this seat attend" is `deriveAttendance` in
    `attendance-writeback.ts`, reached through the `ATTENDANCE_DERIVATION_COLUMNS` fragment.
    The roll-up aggregates the same per-registration rows the per-event list returns rather
    than a parallel GROUP BY: a second implementation is the thing that quietly drifts, and
    "the roll-up reconciles to the per-event lists" has to be a property of the code.
  - **Two axes, deliberately not one number.** `confirmed + awaitingPayment + needsReview +
    cancelled = total` partitions seats by BOOKING state, the axis a disagreeing dashboard is
    held against, because a gap can be pointed at. A registration row exists from RESERVE time,
    so `awaitingPayment` is a real seat held against an unpaid invoice (up to 90 days on bank
    transfer) and is exactly the kind of seat two systems count differently.
    `attended` / `registered` / `notYetArrived` are the ATTENDANCE axis and match the Phase 2.1
    endpoint. The two axes do not add up to each other: someone refunded who turned up anyway
    is in `cancelled` AND is not subtracted from `registered`, so `cancelled + registered >
    total` is the arithmetic being right.
  - **Money is summed over DISTINCT orders**, never per attendee row: one corporate booking
    is many registrations carrying the same order total, and summing per row multiplies the
    revenue by the seat count. `collectedCents` includes refunded orders (the money WAS taken;
    the refund is subtracted once, separately) and `needs_review` (Phase 18.3 withholds the
    seat, not the money).
    **And distinct ACROSS events, not only within one**: a complete-course booking holds seats
    on the parent course and on every included module, so its order id appears in several
    events' registration lists. The money is attributed to `orders.event_id` and to nothing
    else: the course is charged once, on the parent, and the modules are $0 entitlement
    seats. Counting it under each module as well would report a three-module course at four
    times its revenue in the roll-up, and would tell a module's own report it earned money
    nobody was ever charged for it.
  - The summary always describes the WHOLE event, never the requested page, and the CSV is
    always the whole event: a hand count is of everybody. CSV free text is neutralised against
    spreadsheet formula injection (staff notes and attendee names go straight into Excel) and
    money is written as an amount, not raw cents.
  - **The gap to HubSpot is NAMED, not just counted.** Each row carries
    `marketing_event_sync` derived from its `me.register` outbox row (`delivered` /
    `pending` / `dead` / `never_enqueued`) and the summary carries
    `notSyncedToMarketingEvent`. A `dead` row is a person the engine sold a seat to whom
    HubSpot has never heard of, which is the mechanical half of "the two systems disagree".
    Outbox rows are never purged, so absence is a real finding rather than a missing record.
  - **One count, three surfaces.** The manage card, the App Home card and the door scanner
    each had their own `registered`/`attended` SQL, and all three were wrong the same two
    ways: `registered` excluded seats held against an unpaid invoice, and `attended` read
    only `tickets.status = 'checked_in'`, so an online event reported nobody as attending no
    matter how many joined the webinar. All three now call
    `summariseEventRegistrations`. `availableSeats` subtracts `seatsHeld`
    (`confirmed + awaitingPayment + needsReview`): a seat held against an unpaid invoice is
    not for sale, and the DO will refuse to sell it.
  - **The CSV needs a token, because a browser download carries no headers.** The admin API
    key is a server secret, and a HubSpot UI extension has no download primitive: it can only
    open a URL. So `POST /events/:id/export-token` mints a short-lived link and
    `GET /api/v1/exports/events/:id/registrations.csv?token=` serves it, outside the uniformly
    admin-authed `manage` sub-app so the weaker query-parameter auth is visible. The token
    names one portal, one scope and one event, all checked before a row is read, signed per
    tenant (`EXPORT_TOKEN_SECRET_{portalId}`, falling back down the device-token chain), and
    expires in minutes. Stateless and therefore replayable while it lives, the same trade the
    device token makes, and the reason the TTL is minutes rather than hours.
  - **Seats and PEOPLE are both reported, because HubSpot counts people.** Marketing Events
    are contact-scoped (one contact holds one participation record however many times they
    book) so a HubSpot registration report counts humans while `total` counts seats. The two
    diverge on a cancel-then-rebook, which the duplicate-attendee guard deliberately allows.
    `distinctContacts` (contact id where known, lowercased email otherwise) is the figure to
    hold a contact-based dashboard against. It is **not additive**: one person on two courses
    is two per-event contacts and one human, so `sumSummaries` takes the union as a required
    argument rather than deriving a plausible sum.
  - **A date is a LOCAL fact; an instant is not a date until you say where.** D1 still stores
    ISO 8601 UTC (that does not change) but `tenants.display_timezone` (NULL = the built-in
    `Australia/Adelaide`; any IANA name honoured, so this is a product setting and not a
    Weld constant) governs the two places an instant has to become a calendar day:
    - The **attendance date** written to the contact, which a certificate prints. This was
      `iso.slice(0, 10)` (the UTC date) so at +9:30 every check-in before 9:30am local
      recorded the PREVIOUS day, and a 9am start with arrivals from 8:30 is the ordinary
      shape of a training course. Certificates issued before this fix may be a day early.
    - A **report's date range**. HubSpot stores datetimes in UTC but its dashboards GROUP by
      the portal's timezone, so a UTC-bounded range is guaranteed to disagree with the
      dashboard it is meant to reconcile against, losing courses that start the morning of
      the 1st and gaining ones from the morning of the next month's 1st. The report echoes
      `range.timeZone` back, because the same request means different things in different
      zones.
    `timezone.ts` does the conversion through `Intl`, so daylight saving comes from the IANA
    database rather than an offset table someone has to maintain. An unusable zone degrades
    to the default everywhere rather than throwing: this is read on the path that writes
    attendance to a contact, and a typo in config must not kill an outbox row.
  - **Financial figures are NOT comparable to Weld's HubSpot financial reporting**, and
    trying to reconcile them produces a second wrong number. Ollie's deals carry modules and
    exams as line items; ours carry ticket types, one deal per booking. That difference is
    Phase 5's open modules question, not a reporting bug, and it answers half of it:
    modules are already separately purchasable in HubSpot today.
  - **Still open:** whether D1 and HubSpot registration counts agree once the write-back gap
    above is accounted for: the brief's pre-build reconciliation with Ollie. The report
    locates a gap; only Ollie can say which side is right where the two still differ.
- **Custom registration questions are the general mechanism; dietary requirements is a case
  of it.** (Phase 2.3) `registration_questions` holds definitions, `registration_answers`
  holds one fact per seat or per booking, and the dietary field is a seeded row rather than
  a feature: migration 0024 seeds it for tenants that already exist, `seedDefaultQuestions`
  for those that install later, both computing the same deterministic id.
  - **Definitions resolve most-specific-first, by `key`.** `event_id IS NULL` = a tenant-wide
    default asked on everything; a row naming an event replaces the tenant-wide one sharing
    its key. Same order `pricing_rules` resolves in.
  - **Validation is server-side, full stop.** The brief is explicit that the form must not be
    the only place `required` is enforced, and the reason is structural: the CMS form is a
    module a marketer can edit, and the staff and corporate booking paths never render it.
    `validateAnswers` runs in reserve BEFORE membership, pricing and the DO: a booking about
    to be rejected must not first take a hold that now runs to the invoice due date.
    An unknown key is an error, not something to ignore: silently discarding it makes a form
    edited to ask something new appear to work while recording nothing.
  - Answers commit in the SAME D1 batch as the registration, so a reservation that expires
    carries them into the same cancelled state; there is no separate answer lifecycle.
    Questions are **archived, never deleted**: an archived question keeps its answers
    readable, which is what lets last year's export still show them.
  - **A mapped question round-trips through the attendee's contact.** `hs_property` is not
    just a reporting convenience: dietary requirements and a coffee order are facts about
    the PERSON, the same in March as in October, so the answer is written back
    (`contact.sync_answers`) and `prefill` says it may be offered as the default next time.
    That is the whole "you should not have to type this again" mechanism.
  - **Who may overwrite what.** Self-declared (the attendee IS the buyer) → the newest answer
    wins; they just told us, about themselves, today. Booked by someone else → fill only what
    HubSpot leaves empty and leave a difference alone. A colleague ticking "no dietary
    requirements" through a bulk form must not erase a coeliac's record. That branch is safe
    rather than merely cautious because **the attendee list, the CSV and therefore the
    caterer read D1**: the contact property is the prefill source for NEXT time, never the
    record for this event. No decision is opened either: an answer that legitimately changes
    between courses would generate an owner task per booking, and unactionable tasks are how
    a review queue stops being read.
  - **The worker hands no unauthenticated caller anybody's answers.** The public
    `GET /api/v1/events/:slug/questions` returns definitions only; public prefill is rendered
    by HubSpot from the known visitor's OWN contact using the `hsProperty` it returns (the CMS
    owns the front end and knows who is logged in; the worker does not). Staff booking on
    someone's behalf use the admin-authed `.../questions/prefill?email=`. An endpoint here
    answering `?email=` with a person's dietary requirements would be a data leak wearing a
    convenience feature's name.
  - `key`, `field_type` and `scope` are **immutable** on PATCH: each changes what stored
    answers MEAN. Archive and add a replacement instead: both stay readable side by side.
  - Answers reach the 2.2 export as **dynamic columns** (`question_<key>`), driven by the
    event's live question set so an asked-but-unanswered question still gets a column, with
    any answered-but-archived key appended after. A multiselect stores its values joined with
    `;`, HubSpot's own encoding, so the write-back is a copy rather than a re-serialisation.
  - **Answers also reach the DOOR.** (Ref 74d) The check-in manifest carries each attendee's
    answers on their own ticket, so the PWA shows them on the scan card and offline — a
    catering answer given weeks earlier is no use if it is only in a CSV somebody has to
    remember to print. Same reader as the export (`listEventAnswers`), so the two cannot
    disagree about scope, archived questions included. **Attendee-scoped only, read from
    `scope` rather than inferred from a missing order id:** an order-scoped answer stamped
    with a registration is a shape a writer could produce, and a purchase order number
    repeated on every seat of a block is not what the door needs. Whoever runs check-in sees
    them, which for a dietary answer is health information — accepted deliberately by the
    tenant, and the lever to keep an answer out of the manifest is not asking it per
    attendee.
    **A manifest without `answers` is normalised on the way in**, in
    `normaliseManifestTickets`, because two of them outlive the deploy: the record already
    in a scanner's IndexedDB, and a worker on an older build — the PWA ships to Pages and
    the worker to Workers on separate commands, so either side can be the stale one. Both
    deserialise into `ManifestEntry`, which declares `answers` required, so nothing objected
    and `ticket.answers.length` threw in the manual search *after* the results list had been
    cleared: door staff got an empty list and no error, on the offline fallback that is the
    whole reason the scanner holds a manifest at all. Normalised at the two doors rather
    than guarded at each read, so a reader written later cannot reintroduce it.
  - **Managed in the app card, or the mechanism is not available to the tenant.** The worker
    has had full CRUD since 2.3 landed and nothing rendered it, so adding a question meant
    someone calling the admin API by hand, which is the QA complaint "no custom registration
    questions available" whatever the schema says. `EventManagement.tsx` lists the RESOLVED
    set for the event (its own plus the tenant-wide defaults it does not override), adds at
    either level, and archives. It says which level a row belongs to on the row, because
    retiring a tenant-wide question from an event card stops it being asked on every event.
  - **A mapped contact property is created through the OUTBOX**, like every other HubSpot
    side effect. The create used to be a direct POST inside the request that stored the
    question, so a timeout left the question saved and the card reporting failure, and the
    retry could only earn `duplicate_key`. `question.ensure_property` is enqueued in the same
    D1 batch as the question row and drains with the queue's retry/backoff. The response
    still reports whether the property was found, so the editor learns immediately that a
    name does not exist yet; what it no longer does is create it inline.
  - The CMS registration module renders whatever `GET /events/{id}/questions` returns
    (`src/shared/components/RegistrationQuestions.tsx` in weld-aus-hubspot). Prefill is not
    wired: the worker hands an unauthenticated caller definitions only, so it has to come
    from HubL reading the logged-in visitor's own contact via the `hsProperty` each
    definition names.
- **Amend and cancel are per-REGISTRATION, and they are three different things.** (Phase 3)
  A corporate booking is one order holding several seats, and until now the smallest thing that
  could be edited or cancelled was the whole booking: cancelling one attendee would have
  cancelled three colleagues who are still coming.
  - **Transfer / amend / cancel are not variations of each other.** `transfer` (18.2) is a
    DIFFERENT PERSON taking the seat: gated on `allow_transfer`, audited in `transfers`, because
    it is the buyer exercising a right. `amend` (`PATCH .../registrations/:regId`) is the same
    booking recorded wrongly (a typo, a married name, an answer a colleague guessed) so there
    is no policy to consult and nothing to audit as a reassignment. `cancel`
    (`DELETE .../registrations/:regId`) is the seat going away.
  - **The ticket is reissued when the person it NAMES changes, not on every amendment.** A QR
    carries `{ ticketId, registrationId, eventId }`, so nothing about a phone number or a
    dietary answer can make an issued code wrong: reissuing anyway would break the code in the
    wallet of someone whose suburb was corrected, and door staff would find out at 8:30 in the
    morning. `reissueTicket: true` forces it; a CHECKED-IN ticket is never reissued.
  - **What an amendment touches in HubSpot is decided field by field.** An email change moves
    the Marketing Event participation (`me.cancel` old + `me.register` new + `contact.upsert`)
    and re-registers with the webinar provider carrying OUR registration id, because
    participation is keyed on the CONTACT. A name change is D1-only: 1.2 already settled that
    an existing contact's name is not rewritten from booking data. Contact fields go through
    1.2 unchanged (fill an empty property, `contact_conflict` on a difference). Answers go
    through 2.3 as **self-declared**: the rule that fills only empties exists to stop a
    colleague's bulk form erasing a coeliac's record, and someone who opened this seat and
    retyped this answer for this person is the opposite of that.
  - **`cancelled_at` RECORDS the cancellation; the DO performs it.** `/cancel-seats` shrinks a
    live HOLD or a COMMIT, whichever the seat sits in: `release` drops a whole hold, which
    would free the colleagues too. The DO's D1 rebuild subtracts the same cancelled rows, so a
    cold start does not silently re-take every seat ever cancelled out of a booking whose order
    is still `paid`.
  - **Cancelling one of several seats never cancels the order.** The order moves only when the
    cancelled seat was its LAST live one; otherwise it keeps its status and only accrues
    `refunded_cents`. A full refund of the whole remaining booking voids the invoice; anything
    less refunds an amount: voiding an invoice over one seat of four wipes three colleagues'
    payment record in HubSpot and, through Data Sync, in Xero.
  - **The refund is the event's policy applied to what THAT seat cost, and nothing is
    defaulted.** The seat says what it cost (see the seat record below) so cancelling a
    member seat out of a mixed-price group refunds the member price, and a voucher-covered or
    comped seat refunds nothing because nothing was charged for it. `refundAmountCents`
    overrides it; `refund: 'none'` is a stated staff choice, not a fallback.
  - **A freed seat opens a waitlist decision and is offered to nobody**, as every other freeing
    path does. **An ISSUED ticket is cancelled, a CHECKED-IN one is not**: attending is a fact,
    so a seat can be `cancelled` on the booking axis and `attended` on the attendance axis at
    once. **A second cancel is refused**, not silently absorbed: it would give the seat back
    twice and refund the share again.
  - **One derivation, again.** `seat_cancelled` folds `cancelled_at` in inside
    `ATTENDANCE_DERIVATION_COLUMNS`, so the seat leaves `confirmed`/`seatsHeld` in the manage
    card, the App Home card, the door scanner, the CSV and the roll-up at once, while its order
    is still `paid` on behalf of the colleagues who remain. Cancelled seats also leave the
    duplicate-attendee guard, because cancel-then-rebook is supported and order status alone
    cannot tell a given-back seat from a live one.
- **What a SEAT cost is recorded against the seat, as a decomposition of the order.** (Phase 3.3,
  migration 0028) The worker recorded what a BOOKING cost: `orders.total_cents`,
  `voucher_seats_redeemed`, `voucher_credit_cents`, and a `reservation_items` row per ticket
  type. That was enough while the smallest unit of change was the whole booking, and stopped
  being enough the moment one seat became cancellable.
  - **Three columns, each the per-seat half of an order column**, which is what makes them
    checkable rather than a second opinion: `SUM(unit_cents) = total_cents`,
    `SUM(voucher_seats) = voucher_seats_redeemed`, `SUM(voucher_cents) = voucher_credit_cents`
    over a booking's live seats. Cancelling seats one at a time therefore cannot refund or
    return more than was taken: that is arithmetic, not a clamp.
  - **`unit_cents` is the amount CHARGED, not the list price.** A voucher-covered seat and a
    comped seat both record 0: neither is owed its ticket type's price back. Exactly one of
    `voucher_seats` / `voucher_cents` is ever non-zero, because the two are the units the two
    `voucher_mode`s spend in, and the mode is captured at booking time, so a tenant switching
    mode later cannot retroactively change what a sold seat consumed.
  - **A cancelled voucher seat gives the voucher back.** Its `voucher_seats`/`voucher_cents`
    come off the ORDER's redemption totals and its own record is zeroed, so the decomposition
    still holds and a replay cannot return the same voucher twice. Usage stays DERIVED: still
    summed over `orders`, never incremented; what changed is the order's record of what it
    redeems, because one of the seats it redeemed for is gone. Before this the balance was
    consumed forever: the order stayed `paid` for the colleagues still coming, so nothing moved.
  - **The backfill fills `unit_cents` and deliberately not the voucher columns.**
    `reservation_items` can be handed out to the registrations sharing its ticket type, which
    reproduces the money exactly (WHICH seat got a $0 slot is arbitrary and unrecoverable, and
    immaterial: every seat of one ticket type on one booking resolved to the same price). The
    voucher split is not recoverable at all: a $0 line could be a voucher seat or a comp, and a
    plausible guess would hand a company back vouchers it had spent. So pre-0028 bookings are
    detected by SHAPE at cancel time (the order redeemed something, none of its seats accounts
    for any of it) and fall back to the order's own totals. `refund.basis` says which was used
    (`seat` / `order_share` / `override`), because one is exact and one is an estimate.
  - **Not built:** there is no amendment audit table: an amendment is reconstructible from
    `updated_at` and its outbox rows, and a staff note is where a reason belongs.

- **HubSpot sends the registration confirmation; the worker only decides WHEN.** (Ref 61,
  migration 0040) The booking's ORDER id is stamped onto the attendee's contact through the
  `contact.sync_registration_confirmation` outbox topic, and a workflow watching that
  property sends the email: the worker renders and delivers nothing, exactly as Phase 2.1
  builds no certificate.
  - **The ORDER id, not the registration id.** A course package or a ten-seat corporate
    checkout is one order across many registration rows. The registration id would change
    the property once per seat and enrol the workflow once per seat, so one booking would
    send one attendee several emails.
  - **Its own topic, because it rode `me.register` first and both halves of that were
    wrong.** `me.register` is enqueued at RESERVE time, free or paid, so the confirmation
    reached a card buyer who then abandoned the checkout and lost the seat at hold expiry.
    And it sat ahead of the `marketing_event_state_synced` mirror: in a portal that had
    never been asked to create the property, the 400 killed the whole row AFTER the
    Marketing Event registration had succeeded, which 2.2 reporting then read as a real
    `dead` sync gap and `reconcileOutbox` re-drove forever with a fresh
    `interactionDateTime`, the exact stable-timestamp invariant the retry path exists to
    hold. One side effect, one row, one failure domain.
  - **Enqueued on the split `orders.payment_method` already records.** Free and
    invoice-terms bookings are confirmed at reserve: the seat is held to the invoice due
    date and there is an invoice to pay, and a bank-transfer buyer waiting up to 90 days for
    an acknowledgement is worse than the problem. A card-at-checkout booking is confirmed
    when the money lands. `shouldStampConfirmation` states that rule once, and the handler
    re-reads the order at DRAIN time, so the amend and transfer paths can raise a row
    whenever the person on a seat changes without knowing any of it.
  - **It never moves backwards**, on the same principle as the attendance date: outbox rows
    drain out of order and a reconcile sweep re-drives old ones, so a contact who booked
    course A and then course B must not be re-stamped with A: that is a real value change,
    and the workflow would send a confirmation naming last month's booking. An existing
    value belonging to a NEWER order wins; an unchanged value sends no PATCH at all.
  - **Tenant-mapped and provisioned**, like every contact write-back since 0026:
    `tenants.contact_registration_confirmation_property` (NULL → `last_event_engine_registration_id`,
    `'off'` → do not write), and `POST /manage/onboarding/properties` creates it. A
    write-back target the app never asks the portal for is the Phase 6.1 failure by name.

- **The online-event join URL is tenant-mappable too.** (0026) It was the one contact
  write-back that hardcoded its property name, against the rule 1.2 established.
  `contact_join_url_property`: NULL → `teams_join_url` (what the worker has always written
  and what the shipped workflow specs read, so no portal is affected), `'off'` → do not write
  it, else the portal's own name. The default name stays Teams-flavoured on purpose:
  every provider behind the `WebinarProvider` interface writes through it, and renaming it
  would strand every portal's existing data.
  - **It is OVERWRITTEN, not filled-if-empty**: the opposite of the 1.2 fields it sits
    beside. That value was minted by this worker for this registration; HubSpot's copy is a
    stale link to whatever event the contact registered for last, so there is no sense in
    which the stored one is more trustworthy. Preserving it would send an attendee to a
    webinar that finished last month.
- **The app provisions the HubSpot properties its write-backs target.** (Phase 6.1) Every
  write-back PATCHes a named property, and nothing used to create them: in a portal without
  `event_attended` the 2.1 write died as a `dead` outbox row weeks from its cause, read as
  "D1 and HubSpot disagree" when the truth was that the app never asked for the field.
  `properties.ts` asks, through `GET`/`POST /api/v1/manage/onboarding/properties`.
  - **It follows the tenant's MAPPING, never the defaults.** The list is built from the same
    loaders the write-backs read (`loadAttendanceContactConfig`, `loadAttendeeContactConfig`,
    `loadVoucherConfig`, the 2.3 questions' `hs_property`), so it cannot describe a different
    portal from the one the writes target. `'off'` creates nothing. A 1.2 field left on
    HubSpot's standard `phone`/`city`/`state` creates nothing either: a custom twin would
    strand the data outside HubSpot's address block.
  - **It never modifies a property that already exists.** An existing one is ADOPTED and left
    exactly as it is; a type it cannot hold is REPORTED, never resolved. Re-typing a property
    that holds data is data loss with a progress bar, and is not an installer's decision.
    `adopted` stays distinct from `created` because nothing the app adopted is the app's to
    change later.
  - **It provisions only what the worker WRITES.** The membership properties are read, and
    hold the portal's own data: an empty `membership_status` we created would resolve exactly
    as many members as an absent one while implying we own the field. Reported as
    expected-to-exist, never created.
  - **It degrades, never fails.** A revoked or ungranted schema scope produces a per-property
    list for a human plus a re-authorise instruction: "cannot see" is never treated as "not
    there", because creating blind would duplicate what the portal already has. One rejected
    property does not abort the rest.
  - Idempotent by construction: the only write is a create, and a create only happens for a
    name the portal's property list did not contain. Re-running writes nothing, which is what
    makes the same endpoint the "repair setup" button.
  - **One routine, and the definitions live with the feature.** The attendance trio's shape
    stays in `attendance-writeback.ts` (`ATTENDANCE_PROPERTY_DEFINITIONS`) and `properties.ts`
    imports it; a second provisioning routine that briefly existed in `provision.ts` was
    removed rather than kept in step. Every report entry carries the `definition` to create
    by hand, because the ops runbook's answer to a missing property is to create it from
    that, and guessing the DATE one's type wrong is the failure that only shows up on a
    printed certificate.
  - **A default name is a question, not a success.** Each report entry carries `source`
    (`default` = the app invented the name, `mapped` = someone chose it) and the summary
    carries `defaultsToCreate`. Weld's vouchers live in `vouchers_allowance` /
    `vouchers_used__training`; an unconfigured provision would have created
    `vouchers_total` / `vouchers_used`, reported success, and left every corporate booking
    reading a zero balance off two empty fields beside the real allowance. **Map before
    provisioning** wherever a portal already holds the data under its own name.
  - **Schema scopes are REQUIRED, not optional** (`crm.schemas.contacts.*`,
    `crm.schemas.companies.*`). Promoting a scope from optional to required later forces every
    installed portal to re-consent; there was no cheaper moment than while the installed base
    was one portal. **A portal that authorised earlier must re-authorise before provisioning
    can create anything.** `scripts/check-hubspot-app.mjs` fails CI if the app manifest and the
    worker's install URL ever disagree about the scope list again: they already had.
- **A property the portal does not have must not cost a booking its write-back.** (Ref 78)
  HubSpot answers a write naming an unknown property with a 400, a 400 is a `PermanentError`,
  so ONE stray field killed the whole outbox row. Weld's live portal authorised long before
  migration 0040, so every booking's `contact.sync_registration_confirmation` died on
  `last_event_engine_registration_id does not exist` — the Phase 6.1 failure arriving one
  booking at a time, because nobody re-runs the installer on a portal that has been live for
  months. `writeProperties` (hubspot-writeback.ts) is now how every property write goes out.
  - **And "every" was one handler for a while.** `contact.set_join_url`,
    `contact.sync_attendee_details`, `contact.sync_answers`, `contact.sync_attendance` and
    `company.sync_voucher_usage` all still PATCHed through a bare `hs()`, so the repair
    built for this could not see them. Weld's portal has three dead `contact.set_join_url`
    rows reading `teams_join_url does not exist`, and `contact.sync_attendance` was the same
    fault armed and waiting: `event_attended`, `event_last_attended_date` and
    `event_last_attended_name` are all absent from that portal, so the next check-in would
    have died the same way weeks from its cause.
    `outbox-property-resilience.test.ts` fails the build if a bare `hs()` PATCH against a
    contact or a company appears again. Invoices are deliberately out of scope: those are
    HubSpot's own standard properties and `hs_invoice_status` has no repair to attempt.
  - **The voucher write goes through it WITHOUT the `provision` hook**, alone among them.
    Every other managed property is the app's to create on demand; this family is the one
    a human must map FIRST, because Weld's allowance lives in `vouchers_allowance` /
    `vouchers_used__training` and an unmapped portal would have us create an empty
    `vouchers_used` beside it and report success. A missing property there still fails the
    row, now naming the property and the remedy instead of arriving as a bare 400.
  - **It reads the STRUCTURED error**, `errors[].code === 'PROPERTY_DOESNT_EXIST'` and
    `context.propertyName`, never the formatted message. Any other 400 rethrows: a bad value,
    a missing scope and a malformed body are not things a retry can route around, and
    treating them as such would hide the real cause.
  - **Ours → create it and write again.** `repairMissingProperty` resolves the SAME managed
    list through the SAME tenant mapping and creates through the same call as
    `provisionProperties` — this is not a second provisioning routine, it just starts from
    the name HubSpot rejected. A `managed: false` property is still never created; that one
    holds the portal's own data.
  - **Not ours → drop it and write again**, logged at error as `hubspot_property_missing`
    with the names and the remedy. A portal with no `abn` contact property gets a contact
    without an ABN and an invoice that exists, which is the right trade every time.
  - **Everything dropped → the original error stands.** A call that writes nothing is not a
    write, and reporting the confirmation row delivered would mean an attendee who never got
    an email and nothing anywhere saying why. Exactly one retry, ever: a loop that keeps
    dropping fields would eventually PATCH nothing and call it success.
- **An outbox payload that will not parse is PERMANENT, and it must not raise for anything
  else.** (Ref 78) Two halves, both seen on Weld's live portal.
  - The dispatcher's `JSON.parse(row.payload)` sat outside every try, so such a row threw
    straight out of `handleOutboxMessage`: never marked, never logged `outbox_dead`, left
    `pending` for `reconcileOutbox` to re-send every fifteen minutes — burning its four queue
    attempts and dead-lettering again each time, for good. A row nobody can parse is a row no
    retry will ever deliver, which is the definition of permanent; it is marked dead with the
    parse error as its reason. `markDead` falls back to a bare status write when `json_patch`
    cannot touch the payload, which is precisely the row it is most needed for.
  - **SQLite RAISES on `json_extract` of malformed JSON, for the WHOLE statement.** One such
    row anywhere in a portal's outbox took down the expiring-hold batch (a seat that then
    never went back on sale), the staff-note write-back, the attendance derivation and the
    2.2 registration report, none of which have anything to do with that row. Every
    `json_extract` over `outbox` reads through `IIF(json_valid(payload), payload, '{}')`, and
    `outbox-property-resilience.test.ts` fails the build if one goes bare again.
- **D1 caps a LIKE pattern at 50 bytes, and it ERRORS rather than not matching.** (Ref 78)
  `SQLITE_MAX_LIKE_PATTERN_LENGTH`. `%"registrationId":"` plus a UUID and its closing quote
  is 57, so `reconcileOutbox` step 2 threw on every portal, and because it threw, step 3 —
  the one that recreates a missing deal or invoice — never ran at all, since the day it was
  written. Two live Weld bookings sat on `invoice.create` rows waiting for a `deal.create`
  nothing was going to raise, retrying every fifteen minutes; `ctx.waitUntil` swallowed the
  rejection, so the only trace was an unhandled error on a cron nobody reads. Step 3's own
  pattern came to exactly 50 and squeaked through, which is the rest of the argument.
  **Match an outbox payload with `json_extract`, never `LIKE`**: no ceiling, exact instead
  of a substring match, and the same `json_valid` guard as everything else.
- **The repair sweep reaches a booking on INVOICE TERMS, not only a paid one.** (Ref 78) It
  selected `status = 'paid'`. A booking on terms stays `pending` until the money lands, up
  to 90 days, which is the ordinary shape of a Weld booking — so the one sweep that repairs
  a missing deal or invoice never looked at the orders most likely to need it. A `pending`
  order with a `payment_method` is a booking that owes money (NULL = free, migration 0029).
- **A row that RECOVERS stops carrying the reason it failed.** `recordFailureReason` writes
  `_last_error` so a retrying row can say what is wrong with it, and nothing took it off
  again, so a row that failed and then succeeded kept it — and the diagnostic reports
  `_dead_reason ?? _last_error` whatever the status. Weld's `deal.create` for order
  `3843a408` read back a HubSpot 403 `MISSING_SCOPES` on a DELIVERED row, days after the
  scope was granted: a fault named against a booking that does not have one, read during an
  incident, which is the confusion the heartbeat's newest-death age exists to end. Marking
  delivered now strips the same keys the re-drive strips (`DEATH_MARK_KEYS`, one list so the
  two cannot drift), through `json_valid` because SQLite RAISES on `json_remove` of
  malformed JSON and a row that will not parse must still reach a terminal status. `attempts`
  is what records that a row struggled, and a count cannot be mistaken for a live failure;
  the diagnostic also withholds a reason for a delivered row, because every row delivered
  before this still carries one.
- **A retryable row says why, and eventually stops.** (Ref 78) `_dead_reason` only ever
  existed for rows that DIED, and the retry path logs at WARN, so a row that had been
  failing for hours said nothing an error-level log search could find: Weld's live portal
  carried `invoice.create` at 88 and 136 attempts with a blank reason. Every failure now
  writes `_last_error` onto the row, the outbox diagnostic reads it, and a row past
  `MAX_OUTBOX_ATTEMPTS` is marked dead naming the reason it never got past — a row that has
  failed that many times is not going to fix itself, and the useful thing left is to say so
  where a person looks. A `RetryableError` that names no delay waits `DEFAULT_RETRY_MS`
  rather than retrying immediately: `msg.retry()` with no delay spends all four queue
  attempts in milliseconds on a condition that needs seconds, "the deal for this order has
  not been created yet" being the one that matters.
- **An order with nothing to bill raises no invoice.** (Ref 78) HubSpot refuses to open an
  invoice whose `hs_amount_billed` is 0.00, so a $0 order created a DRAFT, failed the PATCH
  to `open`, and died — leaving a junk draft per attempt. Weld's imported CAMS orders are
  all of these. Reserve only enqueues `invoice.create` for a paid booking, so a $0 one here
  is an order whose value did not survive into its lines.
  - **A FREE booking is not that fault, and the log says which it is looking at.** Some of
    Weld's courses and events cost nothing, and reserve declines to raise `invoice.create`
    for one: there is no money to collect and nothing for anyone to go and fix, so
    `invoice_skipped_zero_value` at `warn` with a "check the prices" remedy sends whoever
    reads the logs after a fault that is not there. A free booking logs
    `invoice_not_required_free_booking` at `info` instead; an order that DOES owe money
    (`total_cents > 0` or a `payment_method`) and still bills nothing keeps the warning,
    because its value really did fail to survive into its lines. The sweep is what kept
    handing this handler free bookings to decline — see "An order with nothing to bill is
    not an order MISSING its invoice" below.
  - **The billable total is summed over `totalCents`**, the figure that
    `buildCommerceLineProps` actually bills, not `unitCents * quantity`, so the guard and
    the invoice cannot disagree about whether there is anything to send.
- **`me.complete` sends a body.** (Ref 78) HubSpot's complete endpoint takes the event's
  real start and end; the worker sent none, so every row died on `request body expected,
  none found` and no Weld event has ever been completed in HubSpot. The timestamps ride in
  the payload, falling back to the event row for a row enqueued before that.
- **A cron job that throws says so itself.** (Ref 78) A promise handed to `ctx.waitUntil`
  that rejects is swallowed: no handler, no log line, no failed invocation to notice.
  `reconcileOutbox` threw on every run for months and the only symptom anybody saw was
  bookings quietly not getting an invoice. There is no user in front of a cron to report
  it, so `scheduled` wraps each job on its own (one that throws must not stop the two
  beside it) and emits `cron_job_failed` with the job name, the cron expression, the reason
  and the stack.
- **The outbox health heartbeat is what was actually missing.** (Ref 78, migration 0043)
  Every failure in this incident was already recorded in D1 for days; nothing was looking.
  `reportOutboxHealth` runs on the `*/15` cron beside the sweep and emits one
  `outbox_health` line: per portal, rows dead in the last 24h, rows undelivered for more
  than an hour (`OUTBOX_STUCK_AFTER_MS`), the oldest wait, the worst attempt count and the
  topics, worst portal first.
  - **It logs on a CLEAN run too**, at `info` rather than `error`. A heartbeat that only
    speaks up when something is wrong cannot be told from a cron that has stopped running,
    which is the exact failure that produced it. An alert filters on the level, not on
    absence.
  - **Dead rows are counted over a WINDOW, not all time.** Nothing un-deads a row, so an
    all-time count never goes down and would alert for ever after the first one — the same
    "a permanently-firing signal is how a real one stops being noticed" this file already
    argues for `notify.owner_task`.
  - **The window is measured from when a row DIED, not from when it was created.**
    `created_at` is when the BOOKING happened, and the two come apart in both directions: a
    row that retried for days before giving up was never counted as a recent death at all —
    which is precisely the `invoice.create` at 88 and 136 attempts this heartbeat exists
    for — and a row that died at hour 23 of its life left the alert an hour later, an alert
    you miss by not looking for sixty minutes. `markDead` stamps `_dead_at` beside
    `_dead_reason`, and the window reads `COALESCE(_dead_at, created_at)` so a row that died
    before the stamp existed, or whose payload `json_patch` could not touch, is no worse off
    than it was.
  - **It says how long ago the NEWEST death was** (`newestDeathMinutes`, and "newest 17h
    ago" in the Slack line). Nothing un-deads a row, so a cause that has already been fixed
    keeps this firing at error level every fifteen minutes until its rows age out, and
    `dead: 2` reads identically whether those two died a minute ago or yesterday. That is
    not hypothetical: the `contact.sync_registration_confirmation` deaths on Weld's portal
    were pre-fix corpses — Ref 78's repair had created
    `last_event_engine_registration_id` itself hours earlier and every write since had
    landed — and the only thing left to do with them was re-drive them. A count that keeps
    falling run to run is a backlog; a fresh death is a fault still biting, and the line now
    distinguishes them.
  - **It names the reasons**: the top few `_dead_reason` / `_last_error` values per topic,
    truncated, in the log line itself. They were left to the endpoint on the grounds that
    one line per portal should stay readable — but the endpoint wants the portal's admin
    key, and an error-level alert nobody can act on without first going to find a credential
    is most of the way to an alert nobody acts on. The distinct reasons are few, because a
    fault that hits six rows hits them the same way. They stay OUT of the Slack message: a
    HubSpot 4xx reason is the response body, and that carries the contact URL the write was
    for, which is a buyer's email address.
  - **It reports and changes nothing.** What to do about a dead row depends on why, and the
    diagnostic endpoint is where that is answered with the payload in hand.
  - Migration 0043 indexes dead rows partially and by `created_at`: the outbox is never
    purged, so an unindexed count every fifteen minutes is a full scan of a table that only
    grows. The index still restricts the scan to dead rows; `_dead_at` lives in the payload
    rather than in a column of its own so a portal whose outbox schema has drifted (Ref 217)
    still records it, and so this cannot become one more way for `markDead` to fail on the
    row that most needs it.
- **Operator alerts go to REFUEL's Slack, and are suppressed.** (Ref 78)
  `REFUEL_OPS_SLACK_WEBHOOK_URL`, platform-level (REFUEL operates the worker; this is not a
  tenant's channel, and per-portal routing is a config question for when there is more than
  one operator). Unset = nothing posts and nothing complains. Carries the heartbeat and
  `cron_job_failed`.
  - **A standing problem posts ONCE.** A stuck row stays stuck, so "post when unhealthy" on
    a fifteen-minute cron is 96 identical messages a day, which is how a channel gets muted.
    `alertOps` holds a FINGERPRINT in KV and reposts only when the shape changes (a new
    portal, a new topic) or `renotifyAfterMs` passes; `decideOpsAlert` is pure, so the rule
    is testable without a network. A count ticking from 4 to 5 is deliberately not a change.
  - **Recovery is said once**, then the key is cleared, so the next occurrence is news
    again. An alert with no all-clear leaves someone guessing whether they fixed it.
  - **No PII, ever.** Portal ids, topics and counts. Not a buyer's email, an attendee's
    name or an answer: the worker holds all three and none belong in a chat channel. The
    diagnostic endpoint is where a person who already has access reads the detail. This is
    also the argument against wiring a general exception tracker (2026-09-19): it captures
    request context by default, and this is a multi-tenant product carrying its customers'
    customers' data.
  - **A failed post never suppresses the next attempt**, or one Slack outage silences the
    alert until the fingerprint happens to change; and nothing here may fail the job it
    describes, so every error is caught and logged.
  - Cron failures are keyed per job with a one-hour renotify and no recovery message: a
    success would otherwise cost a KV read on every tick of every cron to find nothing to
    clear. They are posted at all because a dead `reportOutboxHealth` is the one failure
    the heartbeat cannot report.
- **`GET /manage/diagnostics/outbox` answers "why has this booking no invoice".** Every
  HubSpot side effect goes through one table, so that question and "the contact was never
  stamped" have one answer — but until this the only way to read it was Cloudflare's log
  search, which shows what failed at the moment it failed and nothing about what is still
  failing. A dead row is days of silence BY DESIGN: the booking succeeded, the seat is held,
  and only the HubSpot half is missing. Read-only, admin-authed; `?orderId=` traces one
  booking, which is the shape a support ticket actually arrives in. Each row carries
  `deadAt` as well as its reason, because "did this die before or after we shipped the fix"
  is the question asked of a dead row that a creation date cannot answer.
  - **`?topic=` and `?status=` narrow it**, and were accepted and IGNORED until Weld's
    portal was read through them. The row list is the most recent undelivered rows up to
    `limit`; that portal carries 72 dead ones, so a filter that reads as applied and is not
    one can silently omit the rows the responder asked about — during an incident, off the
    endpoint whose whole job is triage. `scope` echoes exactly what was applied and
    `matched` says how many rows it holds, because a list cut off at `limit` and a list that
    is everything look identical otherwise.
  - An unrecognised `status` is a **400**, not an empty list: `?status=died` answering with
    nothing is indistinguishable from a portal with nothing wrong, which is "we did not
    look" rendering as "nothing found".
  - `delivered` rows are excluded unless somebody asked for them, by naming a status or by
    tracing one booking — there they are half the story ("the deal landed, the invoice never
    did"). The summary stays portal-wide whatever the scope, because it is what says where
    else to look.
- **A dead row can be sent round again, by a person, once the cause is fixed.**
  (`POST /manage/diagnostics/outbox/redrive`) Nothing un-deads a row, and only two of the
  topics that die can be re-derived from D1: `reconcileOutbox` step 2 mints a fresh
  `me.register` off `registrations.marketing_event_state_synced = 0`, and step 3 a missing
  deal or invoice off the NULL ids on the order. `contact.sync_registration_confirmation`
  has NO such marker — whether the stamp landed is knowable only from the HubSpot contact —
  so a dead one was an attendee who never got their confirmation email and nothing that
  would ever try again. Four of Weld's bookings were left exactly there by the window
  before Ref 78's missing-property repair shipped, and the heartbeat could only count them.
  - **An operator action, never a sweep**, for the reason `reportOutboxHealth` changes
    nothing: what to do about a dead row depends on WHY it died. Re-driving automatically
    against a cause nobody has fixed re-kills each row, and since the outbox is never
    purged that is a fresh dead row every fifteen minutes, burying the real ones. Read the
    diagnostic, fix the cause, re-drive.
  - **Safe because every handler is idempotent**: the confirmation handler writes nothing
    when the value already matches, the deal and invoice handlers return early once their
    object exists. So a re-drive can only repeat work already done.
  - **`stable_interaction_datetime` is never touched.** Marketing Event attendance writes
    are idempotent only because it is frozen at first attempt; regenerating it on a retry
    is the one thing that invariant forbids.
  - **A malformed payload is skipped, not re-driven.** It is permanent by definition — the
    dispatcher can do nothing with it but record it — so re-driving guarantees a second
    death. It is reported as skipped instead.
  - **Only `dead` rows, and never unscoped.** A `pending` or `failed` row is the sweep's,
    and resetting its attempts erases the one number saying how long it has been failing.
    At least one of `ids` / `topic` / `orderId` is required: replaying a portal's whole
    history has to be something somebody typed.
  - **`remaining` says what the scope still holds**, so a backlog can be cleared in passes
    of `limit` rather than guessed at, and a `remaining` that does not fall names rows
    nothing will move.
  - **Batched, D1 before the queue.** At the 200 ceiling a statement and a send per row is
    400 serial round trips in one request. A row the queue hears about that D1 never
    flipped is still `dead` and the dispatcher cannot drain it; a row flipped but not
    signalled is picked up by `reconcileOutbox` step 1 within fifteen minutes. One of
    those needs a human and the other does not, so the writes go first.
  - **What it is NOT for: a row that will die again.** Re-driving is safe, not useful, for
    a cause still in place. The $0 `invoice.create` rows are the worked example: since
    Ref 78 the handler returns early on a zero billable total, so re-driving them no-ops to
    `delivered` rather than minting junk drafts — which makes it a legitimate way to clear
    them out of the dead count, and no kind of repair. The invoice they never got is one
    they were never owed.
- **An order with nothing to bill is not an order MISSING its invoice.** (Ref 78 follow-up)
  `handleInvoiceCreate` returning early on a $0 order is what stopped the junk drafts, and
  it also leaves `hubspot_invoice_id` NULL for ever — which `reconcileOutbox` step 3 read as
  "still missing". So every $0 order was handed a fresh `invoice.create` every fifteen
  minutes, each delivering as a no-op: not a dead row, but an outbox row per order per sweep
  in a table that is never purged, and a share of the sweep's `LIMIT 50` that the orders
  which CAN be repaired had to compete for. Weld's imported CAMS bookings are all $0, so
  they were most of that budget. The scan and the per-order branch both gate the invoice
  half on `total_cents > 0` now; the DEAL half is untouched, because a $0 booking is a real
  booking and HubSpot takes a $0 deal quite happily.
- **Neither sweep re-raises a row that has already DIED.** (Ref 78 follow-up) Step 2's
  "already queued" check excluded `dead` and step 3's excluded `dead` and `delivered`, so a
  registration or an order whose write-back had died was handed a fresh row every fifteen
  minutes. Against a cause nobody had fixed — a missing scope, a 403 — that row dies again:
  96 dead rows a day for one seat, in a table that is never purged, burying every real
  finding in the heartbeat built to surface them. Little is lost by stopping: a row dies
  after `MAX_OUTBOX_ATTEMPTS` failures or on a 4xx, and neither is a transient blip a sweep
  could ride out. Re-driving a death is a decision about a cause someone has to have fixed
  first, which is what `POST /manage/diagnostics/outbox/redrive` is for.
  - **Step 3 still re-raises over `delivered`, and that asymmetry is load-bearing:** an
    order can have a delivered `deal.create` and still be missing its invoice, and the deal
    handler returns early once the deal exists, so a no-op deal row is the price of the
    invoice being recreated at all. What made that price unbounded was the $0 order, now
    excluded from the scan.
- **`marketing_event_state_synced = 0` is not only "HubSpot has never heard of this
  attendee".** It is also what a seat reads when it SHOULD have no participation, and step 2
  read all three as drift:
  - **An UNNAMED seat is not a person** (Ref 74b). Reserve deliberately raises no
    `me.register` for one, so the mirror stays 0 for ever — and the sweep raised the row
    reserve had refused to, upserting a contact from an empty email and putting somebody
    HubSpot invented onto the event. Migration 0039 names "the Marketing Event write-back"
    as a path that must read `seat_unnamed`; this was the one that did not.
  - **A CANCELLED seat is not a seat to register.** `me.cancel` sets the mirror back to 0,
    the same 0, so a seat cancelled out of a booking whose colleagues are still coming
    looked exactly like one nobody had registered.
  - **A booking on INVOICE TERMS stays `pending`** for up to 90 days, the ordinary shape of
    a Weld booking. Ref 78 fixed that narrowness in step 3 and left step 2 on
    `('paid','confirmed')`, so the repair never looked at most of the bookings it exists
    for. Step 2's condition is now step 3's, verbatim.
- **The queue consumer is paced for HubSpot, not for Cloudflare.** `max_batch_size = 5`,
  `max_concurrency = 3` in `wrangler.toml`. Left unset, consumer concurrency AUTO-SCALES,
  and every outbox message makes several HubSpot calls — at least one a contact search, the
  tightest per-portal limit there is. `queue()` processes a batch sequentially, so
  concurrency IS the number of messages in flight. A burst that outruns the portal earns
  429s which degrade correctly (`hs()` reads `Retry-After`) but spend queue attempts on work
  that was never wrong. Queue-wide, so it paces every tenant together: right while the
  installed base is one portal, and the moment it is not the answer is per-portal pacing,
  not a bigger number.
- Certificates: no rendering, storage or delivery in the worker (see Phase 2.1 above). The
  data model supports the rest; nothing further is planned.
- Capacity is event-level + per-ticket-type. No per-session capacity (not in scope).
- **HubDB sets the capacity NUMBER; the DO still decides every seat.** (Migration 0045,
  QA ref 87) Staff run the timetable in HubDB, so that is where they raise a course from
  24 to 30 seats, and until 0045 nothing read it: `events.capacity` moved only through the
  app card, the page advertised places the checkout refused, and "change it in HubDB" was
  everyone's answer while nothing honoured it. `hubdb-capacity.ts` reads the tenant's
  mapped column (`tenants.hubdb_courses_capacity_column` / `hubdb_events_capacity_column`)
  off the SAME row the price comes from (`fetchHubDbPricingRow`), writes a changed number
  into D1, and the caller's existing `syncCapacityFromD1` hands it to the DO.
  - **It cannot oversell.** Lowering a capacity below the seats already held or sold
    leaves the event sold out and cancels nobody, because the DO counts confirmed seats
    itself. D1 stays the durable record, so a DO cold start agrees with HubDB.
  - **A LOWERED capacity must be acknowledged by the DO before a hold.** The D1-to-DO sync
    is best effort, which is right while the two agree and wrong the moment D1 has just
    gone DOWN: an initialised DO that missed the sync keeps its old, higher limit and would
    sell into it. `syncCapacityBeforeHold` asks the DO to confirm a decrease
    (`syncCapacityFromD1Strict`) and every seat-holding path refuses on no answer:
    `capacity_unconfirmed`, 503, logged as `capacity_decrease_unacknowledged`. A raise or an
    unchanged number keeps the best-effort sync, so nothing about this can cost a booking
    that the old number would have sold.
  - **Tenant schema, no default**, like the price columns: `PATCH
    /manage/onboarding/hubdb-capacity` maps it and refuses a column for a table
    `/onboarding/hubdb-pricing` has not configured. An unmapped portal keeps managing
    capacity in the app card exactly as before. Once mapped, **HubDB wins**: an app-card
    capacity edit is overwritten on the next read, which is the point, one number with one
    place to edit it.
  - **The column is whatever the tenant already types seats into.** For Weld that is
    `seats_remaining` on `courses` (Ryan, 2026-09-23: the field staff treat as the course's
    capacity, already populated), so `coursesCapacityColumn` = `seats_remaining`; their
    `events` table has no such column and stays unmapped. The worker reads the cell as the
    TOTAL. Its name invites a running remainder, and a remainder typed in shrinks the event
    by every seat sold (24 seats, 10 sold, "14 remaining" leaves 4 to sell), so the theme
    documents it as the total and recommends relabelling it in the HubDB UI.
  - **Ticket types that tracked the event move with it**: a type at or above the OLD event
    capacity was never capped on its own, and leaving it would keep a 24-seat member ticket
    capping a course just raised to 30. A type deliberately smaller (ten early-bird seats)
    stays put. The rule runs in D1, not over the caller's list, because the course-bundle
    paths pass a single ticket type.
  - **Degrades to "no change"**: a blank, non-integer or sub-1 cell (Phase 1.1 refuses a
    zero capacity), no token, HubSpot unreachable. None of it can fail a booking
    (`trySyncEventCapacityFromHubDb` never throws).
  - **Reserve reads unthrottled; the availability read at most once a minute per event**
    (`events.capacity_synced_at`), because every course-page render calls it and the page
    is advisory. `POST /manage/onboarding/hubdb-capacity/sync` reconciles every upcoming
    event on demand after a bulk edit. `capacity_synced_from_hubdb` logs from/to.
- **A capacity of 0/null/absent is rejected on create and update** for both events and ticket
  types; genuinely uncapped is the explicit `capacity_unlimited` flag, which maps to the DO's
  `null` inventory. `events.first_published_at` stamps when it first went live with a valid
  capacity, and a sell-out within 30 minutes of that opens a `fast_sellout` pending decision
  + owner task: a placeholder capacity is far likelier than that much demand, and a human
  should see it before members do. Advisory only: nothing is auto-changed. (Phase 1.1)
- **A seat stops being for sale two different ways, and they are two columns.** (migration
  0038) Nothing in reserve was time-bounded and nothing could be closed by hand, so a course
  that finished last week still took public bookings and the only way to stop selling one was
  to zero its capacity, which Phase 1.1 refuses, for the reason above.
  - `events.registration_closes_at` is the CLOCK. NULL is not "never closes": it resolves to
    the event's own `starts_at`, because a course that has begun is not something the website
    should still be selling. Stored rather than computed so a tenant can close two weeks early
    for catering numbers, or leave a walk-up window open an hour past the start. A date-only
    write ("close on the 20th") resolves to the END of that day in `tenants.display_timezone`,
    so an Adelaide portal does not lose its last nine and a half hours to UTC.
  - `events.sales_paused` / `ticket_types.sales_paused` is a PERSON: stop now, for a reason
    the clock does not know: the trainer is sick, the price is wrong. Reversible with no
    loss of information, which is exactly what zeroing a capacity was not, and it leaves
    capacity alone so no report starts reading the event as oversold against a total of zero.
    Ticket types carry only the pause: "early bird is over" is a price change a tenant makes
    by pausing one type and unpausing the next, not a second date to keep in step.
  - **Closing sales moves no seats.** A closed or paused event stops SELLING; every hold
    already out there runs to its own expiry, every confirmed seat stays confirmed, and an
    unpaid invoice stays payable. Closing sales is not a cancellation and the two must not be
    able to be confused.
  - **Staff are exempt, and only staff.** `staff_manual` is a human in the app card booking a
    walk-in or a phone call after the cutoff, already admin-authed and already audited.
    `corporate_bulk` is NOT exempt: that is a customer in the member portal serving
    themselves, and a self-service path that ignores the cutoff is the cutoff not existing.
  - **Every public booking route checks it, and selected-module checkout checks it TWICE.**
    `/reserve-selected-modules` had no gate at all, so a cutoff or a hand-set pause stopped
    the single-session and complete-course checkouts and left the course page's module
    selector selling, which is the cutoff not existing for anyone who reached it. It now
    rejects on the PARENT course's window and on each selected module's own, because a
    module is a separately sold session: a course still selling can carry one that ran last
    week, and the parent's window cannot answer for it. The per-ticket-type pause is checked
    there too. Both rejections name the module, since "one module is unavailable" is not
    something a buyer can act on with twelve tickboxes on the page, and both land before the
    DO: a booking about to be refused must not first take a hold that runs to the invoice
    due date.
  - Reported separately all the way out to the buyer (`registration_closed` vs `sales_paused`,
    and `registrationClosed` / `salesPaused` / `bookable` on the availability read), because
    "sold out" invites a waitlist, "registrations have closed" does not, and "temporarily on
    hold" is worth checking back on. A closed or paused event offers no waitlist either:
    reserve rejects before it reaches one, so the option would be a form that always fails.
- **A refused reserve is LOGGED, and the two duplicate faults are two statuses.** Every
  `ReserveError` was turned into JSON for the buyer and recorded nowhere, so the three
  most-reported checkout defects ("we couldn't verify your membership", "the course price
  changed before checkout", "this attendee email is already registered") each had to be
  re-derived from a customer's description of a sentence they saw. `price_drift` was the
  only one ever traceable, because it logs before it decides. `refuseReserve` now answers
  all four reserve routes and emits `reserve_refused` with the status, the portal, the
  event and the buyer's email - the address is how a support ticket finds the attempt, and
  is the same thing `price_drift` already logs. Answers and attendee details are not.
  - `duplicate_attendee_in_booking` is THIS booking listing one address twice;
    `duplicate_attendee` is somebody already holding a seat from an earlier one. They were
    one status saying "already registered for this event", which is a sentence about a
    brand-new address that is true of nothing: the CMS events widget expanded a quantity
    of N into N attendees all carrying the buyer's own email (its attendee fields were
    hidden inputs nobody could fill), so choosing two tickets failed that way on the
    module's default settings. The widget asks for the other people now
    (weld-aus-hubspot CLAUDE.md § 6.9); the status split is for every other caller that
    gets it wrong, including the ones we do not write. The in-booking message names the
    repeated address, because that is the half the buyer can act on.
- **`attendeeAnswers` is how the SINGLE-SEAT shorthand answers a per-seat question.** The
  `ticketTypeId` form (no `attendees` array) has the worker synthesise the attendee from the
  buyer, and a synthesised attendee carried no answers, so a tenant marking dietary
  requirements `required` would have made every public one-seat booking fail
  `missing_required_answer` with nothing the form could send to fix it. The manage and
  corporate paths escaped it only because they build an explicit `attendees` array. Kept
  separate from `answers` (the ORDER scope) rather than merged, because the two are validated
  against different question sets and a key in the wrong one is rejected by name: one field
  carrying both would have to guess, and guessing wrong on a required answer is a booking
  nobody can complete. Ignored when `attendees` is supplied: there, each seat carries its own.
- **Still open:** hybrid events (in-person + Teams attendance dedupe), not yet decided.
- **A company block is an INVOICE, not a new state.** (Ref 74b, migration 0039) Ten seats
  bought now with the names to follow. Scoped by Ryan, and the scoping is the design: there is
  no pre-commitment and no reservation of a different kind. A block prices, holds and invoices
  exactly as every other booking does, so it drops public availability the moment it is placed
  (through the seat math that already exists, with no new capacity concept) and the company
  is invoiced straight away.
  - `registrations.seat_unnamed` is the whole data model. An explicit FLAG, for the reason
    0020 gave for `capacity_unlimited`: a consumer should not have to infer intent from the
    shape of a value. The stored email and name are `''` only because the columns are NOT NULL
    and four tables carry foreign keys into `registrations`, which makes rebuilding it to drop
    that constraint a far larger risk than the flag is worth.
  - **Nothing person-shaped runs for a seat with no person.** No `me.register` (Marketing
    Event participation is keyed on a CONTACT, and upserting one from an empty email would put
    somebody HubSpot invented onto the event), no webinar registration, no ticket, no contact
    write-back, and the seat is invisible to the duplicate-attendee guard. All of it happens
    when the name arrives.
  - **Naming a seat is the ordinary Phase 3 amend** (same seat, same price, same order) so
    PARTIAL NAMING is free: five of ten now and five later is five amendments, not a special
    case. Both fields must arrive together (half a name is not a person to register), the
    `me.cancel` half is skipped (there is no participation to retire), and the seat gets its
    FIRST ticket rather than a reissue, once the booking is actually paid.
  - **A required question is NOT enforced against an unnamed seat.** A seat with nobody on it
    cannot answer a question about the person on it, and refusing the block instead would make
    it impossible on any event that asks one. The gap is REPORTED: `unnamedSeats` on the 2.2
    summary, in the same place every other "the two systems disagree" gap is named, so it is a
    number staff can chase rather than a silence. Those seats count in `total`, `seatsHeld` and
    the money (they are sold) and are excluded from `distinctContacts` (nobody is on them)
    and from `notSyncedToMarketingEvent` (HubSpot is right not to know about them).
  - Staff-authed (`POST /manage/events/:id/seat-blocks`), never public: an anonymous caller
    taking twenty seats off sale is a denial-of-service with an invoice attached.
- **Who voids an unpaid invoice is a per-portal choice.** (Ref 74b, migration 0039)
  `tenants.unpaid_invoice_mode`: NULL/`'auto_void'` is what the worker has always done and
  stays the default, so no installed portal changes behaviour on deploy. `'manual_review'`
  does not void: it opens an `unpaid_invoice` decision and assigns the event owner a task,
  and a human voids it or leaves it payable. Right for a company block, because the invoice IS
  the booking, a void is terminal in HubSpot (Phase 4.2), and only the tenant can say whether
  a customer who has not paid in 60 days is still coming.
  - It governs the INVOICE only. The seat still returns to sale when its hold lapses under
    either mode, already the documented behaviour whenever `hold_ms` runs shorter than the
    invoice, with the late-payment route into `needs_review` waiting for it. Holding a seat
    indefinitely off an unpaid invoice is a different decision and deliberately not this one.
  - The manual void uses `reason: 'manual_void'`, not `'expired_hold'`: that one re-reads the
    order at drain time and stands down if the booking came back, and this one names an
    invoice a person has already decided about.

## Conventions
- All timestamps ISO 8601 UTC in D1. Display tz per tenant (`tenants.display_timezone`,
  NULL = Australia/Adelaide), applied wherever an instant becomes a calendar date; see
  `timezone.ts`. Never derive a date with `iso.slice(0, 10)`.
- Money in integer cents, currency AUD.
- Secrets via Wrangler, named `{PREFIX}_{portalIdOrTenantId}`.
- Every handler: validate → mutate D1 (+ outbox in same txn) → enqueue → respond.
