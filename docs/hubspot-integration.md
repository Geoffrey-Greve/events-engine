# HubSpot integration

HubSpot is the system of record and renders the whole front end. The worker's job is to
write back to it reliably, and never to be in the critical path of a HubSpot outage.

Everything here is implemented in `hubspot-writeback.ts` (the queue consumer),
`hubspot-oauth.ts`, `hubspot-signature.ts`, `provision.ts` and `invoice-reconcile.ts`.

## Authentication

Tokens are per tenant, stored AES-GCM encrypted in the `tenants` row, and refreshed
transparently by `getAccessToken(env, portalId)` when fewer than 5 minutes remain.

Two things the install flow gets right and must keep getting right:

- **The portal id comes from token introspection**
  (`GET /oauth/v1/access-tokens/{token}` → `hub_id`), never from a redirect query
  parameter. `POST /install` rejects a mismatch between the claimed and introspected id.
- Refresh uses the date-versioned token endpoint, `POST /oauth/2026-03/token`.

Some read paths prefer a per-portal private-app token when one exists
(`HUBSPOT_API_KEY_{portalId}`) and fall back to the tenant OAuth token. `membership.ts`
does this, and the corporate team API requires a per-portal token because it must call
HubSpot inside the request.

### Scopes

The consent URL is built from `HUBSPOT_OAUTH_SCOPES` in `routes/oauth-install.ts`:

```
crm.objects.marketing_events.read      crm.objects.marketing_events.write
hubdb
crm.objects.contacts.read              crm.objects.contacts.write
crm.objects.deals.read                 crm.objects.deals.write
crm.objects.line_items.read            crm.objects.line_items.write
crm.objects.invoices.read              crm.objects.invoices.write
crm.objects.products.read
tax_rates.read
```

`tax_rates.read` is not optional: it is how the worker resolves and validates the
Xero-imported tax-rate id used on invoice lines.

## Request signatures

| Surface | Scheme |
| --- | --- |
| `POST /webhooks/hubspot`, `POST /webhooks/refuel` | v3: HMAC-SHA256 over `method + url + rawBody + timestamp`, base64 in `X-HubSpot-Signature-v3`. Requests more than 5 minutes old are rejected. Verified with `crypto.subtle.verify`, which is constant time |
| `/api/v1/app-home/*` | the same v3 scheme, against `HUBSPOT_CLIENT_SECRET`, in `hubspot-signature.ts`. The portal id and acting user come from **signed query metadata**, not from headers |
| `POST /webhooks/app-uninstall` | the older scheme: `sha256(clientSecret + rawBody)` hex in `X-HubSpot-Signature` |

Webhook handlers always return 200 (or 202 for Graph) so HubSpot does not retry, and defer
work to `waitUntil` or the queue. An invalid signature is the exception: 401.

## Association type ids

Never hard-code an association type id. `resolveAssocTypeId(token, fromObject, toObject,
label)` looks them up through the v4 labels API and caches per isolate. Portal-specific ids
change; the label does not.

## Contacts

`upsertContact(token, email, properties)`:

1. `POST /crm/v3/objects/contacts/search` filtered on `email`;
2. found, so `PATCH /crm/v3/objects/contacts/{id}`;
3. not found, so `POST /crm/v3/objects/contacts`. A 409 (another queue worker created it
   between the search and the create) is caught, re-resolved by email, and treated as
   success.

Names are split into `firstname` and `lastname` by `nameToContactProperties`.

> **Known divergence from the repo convention, not an endorsement.** CLAUDE.md and
> AGENTS.md mandate the single-object create-or-update,
> `PATCH /crm/v3/objects/contacts/{email}?idProperty=email`, which is atomic and has no
> search-then-create window at all. `upsertContact` does not use it. The 409 re-resolve
> above narrows the window rather than closing it, and it depends on HubSpot answering a
> duplicate create with a 409. Bookings, transfers and concurrent queue retries all reach
> this path, so moving it to the mandated endpoint is the right fix; it is a behaviour
> change to a payment-adjacent path and is deliberately not bundled into a documentation
> change. Do not copy the search-then-create shape into new code.

Batch upsert by email is unreliable and must not be used. Membership reads already use the
single-object read by email (`GET /crm/v3/objects/contacts/{email}?idProperty=email`).

## Marketing Events

Attendance state changes go through one helper, `meAttendance`:

```
POST /marketing/v3/marketing-events/attendance/{externalEventId}/{state}/email-create
     ?externalAccountId={externalAccountId}

body: { inputs: [ { email, interactionDateTime } ] }
```

States: `register`, `attend`, `cancel`, `noshow`.

Two gotchas encoded here that the docs get wrong or omit:

- **`externalAccountId` is required** as a query parameter. The docs imply it is optional.
  It is not. For a single-portal tenant such as Weld, `portal_id` doubles as the external
  account id.
- **`interactionDateTime` must be stable across retries.** It comes from the outbox row's
  frozen `stable_interaction_datetime`, never from `Date.now()` at delivery. For a
  registration that is the reserve time; for attendance it is the earliest join or the
  recorded scan time.

`me.complete` marks the event complete and is emitted exactly once, in the same batch that
sets `events.marketing_event_completed = 1`.

Deal-to-marketing-event association is best effort and lives in
`associateDealToMarketingEvent` / `associateExistingDealsToMarketingEvent`: the Marketing
Events API is external-id based while CRM associations need the object id, so the object id
is resolved and cached on `events.hubspot_marketing_event_object_id`.

## Deals

`handleDealCreate` resolves routing per tenant and per booking kind, then builds the deal.

| `events.booking_kind` | Pipeline | Stage | Deal type label |
| --- | --- | --- | --- |
| `event` | `tenants.events_pipeline_id` | `events_registered_stage_id`, else resolved from `events_registered_stage_label` | `tenants.event_deal_type_label` |
| `course` (default) | `tenants.training_pipeline_id` | `training_invoice_sent_stage_id`, else resolved from `training_invoice_sent_stage_label` | `tenants.course_deal_type_label` |

Stages can be configured by id or by label; a label is resolved against the pipeline, so a
tenant who renames a stage does not silently break routing. The deal-type property name is
also configurable (`deal_type_property_name`, default `dealtype`), and its value is
resolved against the property's actual options.

`handleDealCreate` is resumable, not just idempotent: if a previous attempt created and
persisted the deal but failed on a follow-up association or line item, it reuses the deal
id and resumes the remaining calls.

## Invoices

This is the fiddliest part of the integration. Order matters, and each step exists for a
reason.

```
0  load the order and the tenant tax-rate ids. Bail out early if the order is
   cancelled (void an existing invoice) or already refunded
1  ensure the deal exists (invoice.create can run before deal.create finishes)
2  POST /crm/v3/objects/invoices  with currency-only properties  → DRAFT
   ►► persist hubspot_invoice_id IMMEDIATELY, before any retryable follow-up call
3  PUT invoice → contact association (PRIMARY)
4  create fresh line items and associate each to the invoice
5  PUT invoice → deal association
6  re-check the order status, then PATCH hs_invoice_status to "open"
7  GET the invoice's hs_invoice_link and store it as orders.hubspot_invoice_url
```

The rules behind that sequence:

- **An invoice cannot be opened** without an associated contact and at least one line item.
  Hence draft first.
- **Never send `paid` on create.** Payment arrives from Stripe via HubSpot.
- **Persist the invoice id before the follow-up calls.** If it were deferred and a later
  call hit a 429 or a 5xx, the retry would see a null `hubspot_invoice_id` and create a
  second payable invoice. This is the single most expensive mistake available in this file.
- **Invoice line items are separate objects from deal line items.** Create fresh ones;
  reusing the deal's does not work.
- **Step 7 is what the buyer's poll waits on.** Without `hubspot_invoice_url`, the CMS
  module never sees a `paymentUrl` and checkout dead-ends.
- The order status is re-checked at step 6 because a hold can lapse mid-flight. A cancelled
  order gets its invoice voided and its payment URL cleared instead of being opened.

Line items are created by `createLineItem`, keyed on `hs_external_id`
(`inv:{orderId}:{ticketTypeId}` for invoice lines, `{orderId}:{ticketTypeId}` for deal
lines) so retries reuse rather than duplicate. If the found line's properties differ from
the desired ones it is PATCHed rather than left alone, because earlier write-back builds
created untaxed or wrongly priced lines and short-circuiting froze them permanently. Some
portals reject `hs_external_id` on the search API with a vague 400, so both the search and
the create have a documented fall-through.

## GST and tax rates

Stored prices are **GST inclusive**. HubSpot computes tax **on top of** the line price it
is given. Send an inclusive price with a 10% tax rate attached and you charge 21%.

So `buildCommerceLineProps` strips the embedded GST when a taxable rate is attached:

```ts
const gstFree = isGstFreeTreatment(li.taxTreatment);
const appliesGstRate = !gstFree && !!taxRateId;
const lineTotalCents = appliesGstRate ? gstExclusiveCents(li.totalCents) : li.totalCents;
```

`gstExclusiveCents(585000)` is `531818`, that is $5,318.18, plus 10% GST equals $5,850.00.
`packages/worker/test/gst.test.ts` guards this; do not change the maths without reading it.

Rate selection per line:

```
tax_treatment = 'gst_free'  →  tenants.xero_gst_free_rate_id
otherwise                   →  ticket_types.hs_tax_rate_id, else tenants.xero_gst_rate_id
```

The rate is attached as `hs_tax_rate_group_id`, which is what puts GST under the subtotal
rather than folding it into the line price.

Two hard requirements:

- **Use the tax rate imported from Xero into HubSpot's tax library.** Do not hard-code 10%.
  A hard-coded rate produces an invoice that will not reconcile once Data Sync carries it
  into Xero.
- `isGstFreeTreatment` accepts legacy `exempt` and treats anything else (including historic
  `gst_inclusive`) as taxable. Migration 0015 normalised stored values to `gst` and
  `gst_free`; the tolerant reader stays because staging data predates it.

A paid reserve refuses to hold a seat unless `stripe_processor_connected = 1` and
`xero_gst_rate_id` is set, returning `payment_not_configured`. That is the guard that stops
an untaxed or misrouted invoice being created at all. Reserve also backfills a blank
`hsTaxRateId` on taxable lines from the tenant rate.

## Payments and refunds

HubSpot's own payment processor is **not available in Australia**. Stripe is connected as
the processor inside the tenant's HubSpot portal, and collection happens through
HubSpot invoices and payment links in AUD.

Confirmation arrives at `POST /webhooks/hubspot` as either:

- `INVOICE` with `propertyName = hs_invoice_status` and value `paid`; or
- `PAYMENT` with value `SUCCEEDED`, whose invoice is then resolved through
  `GET /crm/v4/objects/payments/{id}/associations/invoices`.

A void (`hs_invoice_status = voided`) enqueues `refund_payment`.

`reconcileHubSpotInvoices`, on the `*/5` cron, polls the status of known invoice ids and
drives the same payment and refund lifecycle. Webhooks are the fast path; this exists
because webhook configuration is easy to get wrong while onboarding a tenant.

`handlePaymentRefund` voids the invoice for a full refund and refunds the amount for a
partial one.

## Buyer identity and ABN

The ATO requires the buyer's identity or ABN on an invoice of AUD 1,000 or more. `buyer.abn`
is captured at checkout as an optional field (some buyers are individuals) and carried
through the deal and invoice payloads.

## HubDB

The `events` and `ticket_types` table schemas live in `packages/shared/src/hubdb.ts` and are
the single source of truth: the worker's provisioning routine and the HubSpot Project
tooling both import them, so the deployed table shape cannot drift from what the worker
expects.

Cross-table references are declared by the foreign table's **name** and resolved to a
concrete table id at deploy time.

`provisionHubDbTables` (`provision.ts`) is idempotent:

1. list the portal's HubDB tables to detect a prior run;
2. create `ticket_types` first (no foreign references);
3. create `events`, resolving the `FOREIGN_ID` to the concrete id;
4. enable `useForPages` on `events` if not already set;
5. publish both;
6. persist the ids on the tenants row.

An existing table with the expected name has its id reused rather than a duplicate created.

HubDB holds content: titles, copy, ticket names and prices, and the worker ids to call
(`worker_event_id`, `worker_ticket_type_id`). It never holds live availability or remaining
counts. Availability comes from the DO, always.

## Xero

The worker makes **no** direct Xero calls. Invoice and payment reach Xero through HubSpot
Data Sync. The worker's money job ends at creating and opening the HubSpot invoice. The
only Xero coupling is the tax-rate id imported into HubSpot's tax library, which is what
makes the synced invoice reconcile.

## App Home and cards

`packages/hubspot/src/app` holds the React UI extensions: App Home (`pages/Home.tsx`) and
the cards (`cards/EventManagement.tsx`, `cards/AttendanceView.tsx`). They call the worker
directly, so the worker's domain must be listed in the app's `permittedUrls`.

Extensions authenticate with HubSpot's v3 request signature against `/api/v1/app-home/*`.
Tooling with a server-side key uses `/api/v1/manage/*` instead. The worker never trusts an
unsigned portal id from a card.
