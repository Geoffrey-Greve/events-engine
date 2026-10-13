# Worker API reference

Base path prefixes and their auth models, defined in `packages/worker/src/index.ts`:

| Prefix | Auth | Consumer |
| --- | --- | --- |
| `/api/v1/events/*`, `/api/v1/orders/*` | none. `X-Portal-Id` header plus an `Idempotency-Key` on reserve. Rate limited | the CMS registration module, in the buyer's browser |
| `/api/v1/checkin/*` | device token (`Authorization: Bearer`), except device-token issuance which needs the admin key | the check-in PWA |
| `/api/v1/manage/*` | `X-Portal-Id` plus `ADMIN_API_KEY_{portalId}` as `Authorization: Bearer` or `X-Admin-Key` | tenant admin tooling and App Cards with a server-side key |
| `/api/v1/app-home/*` | HubSpot v3 request signature. Portal id comes from signed query metadata | HubSpot App Home and cards, calling directly from the extension |
| `/api/v1/corporate/*` | per-portal HubSpot token server side, plus an actor-permission check against HubSpot | the Weld member portal |
| `/admin/*` | `ADMIN_SECRET` as `Authorization: Bearer` | Refuel platform operations |
| `/webhooks/*` | per-provider signature verification | HubSpot, Microsoft Graph, Zoom |
| `/oauth/*`, `/install`, `/connect/*` | signed state, or admin auth to start a flow | install and connect flows |
| `/health` | none | uptime checks |

CORS is applied to `/api/v1/*` only. The allow-list comes from `CMS_ALLOWED_ORIGIN`
(comma separated); unset or `*` reflects the request origin. Credentials are never sent,
so reflecting is safe. Allowed headers are `Authorization`, `Content-Type`,
`Idempotency-Key` and `X-Portal-Id`.

Unhandled errors return JSON, never plain text, with an 8-character `ref` that also
appears in the Worker log as `event: "unhandled_error"`. Ask a reporting buyer for the
`ref`.

## Public registration

### `GET /api/v1/events/:slug/availability`

`:slug` is the internal `events.id`, not a URL slug and not the HubSpot id.

Headers: `X-Portal-Id`. Rate limit: 60 per minute per IP.

Read live from the `EventCapacity` DO. Never from D1 counters, never from HubDB.

```jsonc
{
  "status": "ok",
  "eventFull": false,
  "ticketTypes": [
    { "ticketTypeId": "tt_dev_002", "available": 21, "soldOut": false, "waitlistAvailable": false }
  ]
}
```

`available: null` means uncapped. A sold-out type reports `waitlistAvailable: true`,
because reserve auto-waitlists when full. If the DO is unreachable the endpoint degrades to
`available: null` rather than failing; the DO is still authoritative at reserve time, so
this cannot cause an oversell.

Errors: 400 `X-Portal-Id header required`, 404 `event_not_found`, 429 `rate_limited`.

### `POST /api/v1/events/:slug/reserve`

Headers: `X-Portal-Id` and `Idempotency-Key`, both required. Rate limit: 20 per minute per IP.

Request body is `ReserveRequest` from `@paddock/shared`:

```jsonc
{
  "buyer": { "email": "a@b.com", "name": "A B", "hubspotContactId": "123", "abn": "12345678901" },
  "attendees": [                        // one registration per entry
    { "email": "c@d.com", "name": "C D", "ticketTypeId": "tt_1", "hubspotContactId": "456" }
  ],
  "ticketTypeId": "tt_1",               // used only when attendees is absent (buyer takes the seat)
  "offerToken": "…",                    // signed waitlist offer, when claiming one
  "memberTier": "gold",                 // advisory only
  "expectedUnitCents": 9900,            // advisory: triggers a price_mismatch if it drifts
  "memberCompanyId": "789",             // guest company-id unlock, re-validated server side
  "turnstileToken": "…"                 // required for ALL public bookings when configured
}
```

`memberTier`, `expectedUnitCents` and `memberCompanyId` never set the charged amount.
Pricing is resolved server side. `expectedUnitCents` exists so a drift between the
displayed and charged price fails loudly instead of silently invoicing a different number.

Three success shapes:

```jsonc
{ "status": "reserved",   "orderId": "…", "registrationIds": ["…"], "pollUrl": "/api/v1/orders/…" }
{ "status": "confirmed",  "orderId": "…", "registrationIds": ["…"], "ticketIds": ["…"] }
{ "status": "waitlisted", "waitlistId": "…" }
```

`reserved` is a paid order with a live hold. Poll `pollUrl` for the payment link.
`confirmed` is a free or complimentary order: seats committed and tickets issued already.
`waitlisted` means capacity was full and the buyer was queued.

Errors are `{ status, message }`. The `status` values are stable and safe to branch on:

| Status | HTTP | Cause |
| --- | --- | --- |
| `missing_idempotency_key`, `missing_portal_id` | 400 | header absent |
| `invalid_body`, `invalid_buyer`, `no_attendees`, `invalid_attendee` | 400 | body validation |
| `invalid_ticket_type` | 400 | ticket type not on this event |
| `invalid_invoice_due_date`, `invalid_booking_kind` | 400 | staff paths only |
| `event_not_found`, `no_ticket_types` | 404 | |
| `members_only` | 403 | non-member on a member-only event or ticket type |
| `membership_unverified` | 403 | status not yet cloned from the company. Route to support; this is not the same as a confirmed non-member |
| `ticket_not_available` | 403 | an import-only ticket type on the public path |
| `turnstile_required` | 403 | the bot check failed or was missing on a public booking |
| `duplicate_attendee` | 409 | that email already holds an active registration for this event |
| `price_mismatch` | 409 | the displayed price no longer matches the resolved price |
| `payment_not_configured` | 409 | the tenant has no Stripe flag or no GST rate id |
| `offer_expired`, `offer_not_open`, `offer_invalid`, `offer_seat_taken` | 409 | waitlist offer claim |
| `reserve_failed` | 403 | the DO refused for a reason other than capacity |
| `rate_limited` | 429 | |

**Idempotency.** The `(portal_id, key)` pair is stored with the exact response status and
body in the same batch as the reservation. A replay returns that stored response verbatim,
so a retried submission cannot create a second hold. Keys expire after 24 hours. The
registration module reuses one key across retries of a single submission and clears it on a
terminal outcome.

### `GET /api/v1/orders/:id`

Headers: `X-Portal-Id`.

```jsonc
{ "status": "pending", "paymentUrl": null }
{ "status": "pending", "paymentUrl": "https://app.hubspot.com/payments/…" }
{ "status": "cancelled", "paymentUrl": null, "message": "This reservation has expired. …" }
{ "status": "refunded",  "paymentUrl": null, "message": "This order is no longer payable." }
```

`paymentUrl` is `orders.hubspot_invoice_url`, written by the `invoice.create` write-back
once the invoice is opened. It is null until then, and the module keeps polling. 404
`order_not_found` if the id does not belong to this portal.

## Check-in

Device tokens are event-scoped, short-lived and stateless. Default TTL 12 hours, maximum 24.

### `POST /api/v1/checkin/device-token`

Admin auth, not device auth: devices cannot mint their own tokens. Send `X-Portal-Id` plus
`ADMIN_API_KEY_{portalId}` as a bearer token or `X-Admin-Key`.

Body `{ eventId, deviceId, ttlSeconds? }`. Returns `{ token, eventId, deviceId, expiresAt }`.

### `POST /api/v1/checkin`

Device auth. Body `{ code, scannedAt? }`. `scannedAt` is the device's recorded arrival
time and becomes the stable `interactionDateTime` on the `me.attend` write-back, so a
retry cannot shift the recorded attendance.

```jsonc
{ "code": "…", "status": "checked_in", "ok": true, "checkedInAt": "…", "attendeeName": "…" }
```

`status` is one of `checked_in`, `already_checked_in`, `cancelled`, `invalid_signature`,
`wrong_event`, `not_found`. The HTTP status mirrors the outcome.

### `POST /api/v1/checkin/batch`

Device auth. Body `{ scans: [{ code, scannedAt? }] }`. Used by the PWA to flush its offline
queue. Scans are processed sequentially so a duplicate code within one batch observes the
first scan's committed state.

```jsonc
{ "status": "processed", "total": 12, "accepted": 11, "results": [ … ] }
```

### `GET /api/v1/checkin/manifest/:eventId`

Device auth. `:eventId` must match the token's scope, else 403.

Returns every `issued` or `checked_in` ticket for the event, plus the **derived per-event
verify key** so the scanner can verify codes offline without ever holding the tenant master
secret.

```jsonc
{
  "eventId": "…",
  "algorithm": "HMAC-SHA256",
  "verifyKey": "base64url raw key bytes",
  "generatedAt": "…",
  "count": 120,
  "tickets": [
    {
      "code": "…",
      "name": "…",
      "status": "issued",
      "checkedInAt": null,
      "answers": [
        { "key": "dietary_requirements", "label": "Dietary requirements", "value": "Coeliac" }
      ]
    }
  ]
}
```

`answers` carries this attendee's registration answers in the questions' display order,
and is `[]` when they answered nothing. Attendee-scoped only: an order-scoped answer (a
purchase order number) is not door information and on a company block would repeat on
every seat. Each entry carries the question's `label` as well as its `key`, because the
scanner holds no question definitions once it is offline. A blank answer is omitted rather
than sent as an empty line.

### `GET /api/v1/checkin/stats/:eventId`

Device auth, same scope check. `{ eventId, registered, attended, notYetArrived }`.
`registered` counts registrations on `paid` or `confirmed` orders.

## Tenant admin (`/api/v1/manage`)

Every route is behind `authenticateAdmin`: `X-Portal-Id` plus `ADMIN_API_KEY_{portalId}`.
The portal id is taken from the verified identity, and every query is scoped to it.
Responses are `{ status, message }` on failure.

### Events and ticket types

| Method and path | Body highlights |
| --- | --- |
| `GET /events` | optional `?hubspotEventId=` returns a single row |
| `POST /events` | `hubspotEventId`, `title`, `startsAt`, `endsAt`, `capacity` required; `location`, `bookingKind` (`event` or `course`), `provider`, `allowOversell` optional |
| `PATCH /events/:id` | partial update. A capacity change reaches the DO on the next reserve or availability read, which both call DO `/sync` from D1 first. Use `rebuild-capacity` if you need it applied immediately |
| `GET /events/:id/ticket-types` | |
| `POST /events/:id/ticket-types` | `name`, `priceCents`, `capacity` required; `currency`, `taxTreatment` (`gst` or `gst_free`), `memberOnly`, `sortOrder`, `hsTaxRateId`, `hsProductId` optional |
| `PATCH /events/:id/ticket-types/:ttId` | partial update |
| `POST /events/:id/rebuild-capacity` | forces the DO to discard its counters and rebuild from D1 |
| `GET /events/:id/stats` | capacity, registered, attended, not yet arrived |

### Pricing rules

| Method and path | Notes |
| --- | --- |
| `GET /events/:id/pricing-rules` | |
| `POST /events/:id/pricing-rules` | `scope`, `scopeId`, `memberLevel`, `memberCategory`, and one of `discountPercent` or `fixedPriceCents` |
| `DELETE /events/:id/pricing-rules/:ruleId` | |

### Registrations, refunds, transfers

| Method and path | Notes |
| --- | --- |
| `GET /events/:id/registrations` | joined with order status and amounts |
| `POST /events/:id/registrations` | staff manual booking. Requires `Idempotency-Key`. `mode` is `paid` or `complimentary`; then `ticketTypeId`, `attendeeEmail`, `attendeeName`, optional `buyerEmail`, `buyerName`, `hubspotContactId`, `memberCompanyId`, `invoiceDueDate`, `staffActor`, `staffNote`. Runs through `reserveEventWithBody` with `source: 'staff_manual'` |
| `POST /events/:id/registrations/:regId/refund` | applies the resolved policy |
| `POST /events/:id/registrations/:regId/transfer` | `toEmail` and `toName` required, `reason` optional. Gated on the policy's `allowTransfer` |

### Decisions

| Method and path | Notes |
| --- | --- |
| `GET /events/:id/pending-decisions` | open decisions with their `context` JSON |
| `POST /decisions/:id/resolve` | oversell: `{ action: 'honour' \| 'refund' }`. Waitlist: `{ waitlistIds: ["…"] }`. Optional `resolvedBy` |

### Refund policies

`GET`, `POST`, `PATCH /refund-policies/:id`, `DELETE /refund-policies/:id`. Body fields:
`name`, `isDefault`, `category`, `fullRefundCutoffDays`, `partialRefundPercent`,
`allowTransfer`.

### Onboarding and diagnostics

| Method and path | Notes |
| --- | --- |
| `GET /onboarding` | the tenant's onboarding state |
| `PATCH /onboarding/stripe` | marks the Stripe processor connected |
| `PATCH /onboarding/xero-gst` | stores the Xero-imported GST rate id, and the GST-free rate id |
| `PATCH /onboarding/crm-routing` | deal pipeline, stage and deal-type mapping for events and courses |
| `PATCH /onboarding/membership-config` | `membershipStatusProperty`, `membershipLevelProperty`, `memberCategoryProperty`, `valueMaps`, `xeroGstFreeRateId`, and (0046) `companySources`, `mirrorStatusProperty`, `mirrorTierProperty`, `memberDirectory`; `null` clears a source, which stops it being read |
| `PATCH /onboarding/webinar-creds` | `provider`; for `teams` also `tenantId`, `clientId`, `clientSecret`. Stored encrypted |
| `GET /onboarding/webinar-creds` | non-secret status only |
| `GET /onboarding/connections` | per-provider connection status |
| `PUT /onboarding/connections/on24` | ON24 has no OAuth, so its credentials are pasted here |
| `DELETE /onboarding/connections/:provider` | disconnect |
| `POST /onboarding/provision` | re-runs idempotent HubDB provisioning |
| `PATCH /onboarding/dynamic-page` | stores the customer CMS domain |
| `GET /diagnostics/hubspot` | token, scope and object reachability checks |
| `GET /diagnostics/hubspot/tax-rates` | lists the portal's tax-rate library, to find the Xero-imported ids |
| `GET /diagnostics/outbox` | what the HubSpot write-back is stuck on right now: counts by topic/status, plus every row that is not `delivered` with its order id and the reason it died. `?orderId=` traces one booking; `?limit=` (default 50, max 200) |

### Webinar operations

`POST /events/:id/provision-webinar` and `POST /events/:id/register-webinar-attendee` drive
the provider directly, for repair and testing.

## HubSpot App Home (`/api/v1/app-home`)

Read-mostly endpoints for the App Home page and cards. Auth is HubSpot's v3 request
signature (`X-HubSpot-Request-Timestamp` plus `X-HubSpot-Signature-v3`), verified against
`HUBSPOT_CLIENT_SECRET`. The portal id and acting user come from **signed query metadata**
(`portalId`, `userEmail`, `userId`), never from an unsigned header.

| Method and path |
| --- |
| `GET /events` (optional `?hubspotEventId=`) |
| `GET /pending-decisions` (every OPEN decision in the portal, across all events, with its event title) |
| `GET /events/:id/ticket-types` |
| `GET /events/:id/registrations` |
| `GET /events/:id/stats` |
| `POST /events/:id/registrations` (staff manual booking, same body as the manage route plus an optional `idempotencyKey` in the body) |
| `GET /orders/:id` |

## Corporate member portal (`/api/v1/corporate`)

Used by the Weld private member portal. The browser never receives a HubSpot write token;
the worker holds it and re-checks permissions against HubSpot immediately before every
mutation. The actor must be associated to the submitted company with an Admin or Primary
Admin label, and the target contact must already be linked to that company. Contacts are
never deleted: removal archives the contact-to-company association labels only.
Self-removal and admin-removal are blocked.

| Method and path | Notes |
| --- | --- |
| `POST /add-employee` | `portalId`, `companyId`, `actorContactId`, `email`, `firstName`, `lastName`, `jobTitle`. Body `portalId` must match the `X-Portal-Id` header |
| `POST /remove-employee` | `portalId`, `companyId`, `actorContactId`, `employeeId`, `reason` |
| `POST /bulk-register` | `portalId`, `companyId`, `actorContactId`, `sessionId`, `workerEventId`, `ticketTypeId`, `employeeIds[]`, optional `session` metadata, optional `dryRun`. Requires `Idempotency-Key` unless `dryRun`. Gated on the company's training voucher balance, charged against D1 |

Every action writes a `corporate_team_audit` row, including blocked attempts and the reason.

## Platform admin (`/admin`)

`ADMIN_SECRET` as a bearer token. Returns 503 if the secret is not configured, 401 if it
does not match.

| Method and path | Notes |
| --- | --- |
| `POST /provision/:portalId` | runs HubDB provisioning for a portal that already has stored OAuth tokens. Idempotent. Returns `{ ok, eventsTableId, ticketTypesTableId, created }` |
| `PATCH /tenants/:portalId/status` | `{ status: 'installed' \| 'active' \| 'past_due' \| 'cancelled' }` |

## Install and OAuth

| Method and path | Notes |
| --- | --- |
| `GET /oauth/install` | builds the HubSpot consent URL with a signed `state` and 302s to it. Scope list is `HUBSPOT_OAUTH_SCOPES` in `routes/oauth-install.ts` |
| `GET /oauth/callback` | verifies `state`, exchanges the code, **introspects the token to learn the real portal id**, stores encrypted tokens, optionally provisions HubDB, then redirects to `OAUTH_SUCCESS_REDIRECT_URI` |
| `POST /install` | server-to-server variant. Body `{ code, portalId, displayName? }`. Rejects a mismatch between the claimed portal id and the introspected one |
| `GET /connect/:provider/start` | admin auth. Returns `{ authorizeUrl }` for the onboarding SPA to navigate to. The portal id comes from the verified admin identity, never the query string |
| `GET /connect/:provider/callback` | verifies the signed state (10-minute TTL), exchanges the code, stores encrypted tokens, redirects to the success page |
| `GET /oauth/microsoft/start`, `/callback`, `/status` | Microsoft organiser delegated OAuth |

The portal id from a redirect query parameter is never trusted. HubSpot's is taken from
token introspection; the provider connect flow takes it from signed state.

## Webhooks

All of them verify a signature and then return 200 or 202 quickly, so the sender does not
retry. Heavy work is deferred to `waitUntil` or the queue.

| Path | Verification | Effect |
| --- | --- | --- |
| `POST /webhooks/hubspot` | v3 HMAC over method, URL, raw body and timestamp, against `HUBSPOT_WEBHOOK_SECRET`. Requests older than 5 minutes are rejected | dedups on `eventId`, then detects payment (`INVOICE.hs_invoice_status = paid`, or `PAYMENT` succeeded resolved to its invoice) and refund (`voided`), and enqueues `confirm_payment` or `refund_payment` |
| `POST /webhooks/graph` | echoes `?validationToken=` verbatim as `text/plain` on subscription create and renew. Otherwise resolves each `subscriptionId` to a portal via KV and lets the provider verify `clientState` | enqueues `graph.pull_attendance` jobs |
| `POST /webhooks/zoom` | Zoom's signature scheme | enqueues attendance pulls |
| `POST /webhooks/app-uninstall` | `sha256(clientSecret + rawBody)` hex in `X-HubSpot-Signature` | sets tenant status and Refuel billing status to `cancelled` |
| `POST /webhooks/refuel` | v3 HMAC against `REFUEL_WEBHOOK_SECRET` | Refuel-side subscription billing. A paid invoice activates the tenant; a voided one moves it to `past_due` or `cancelled`. The customer portal is resolved from the `paddock_portal_id` property on the associated deal in Refuel's portal |

## Dev only

`POST /dev/seed-ticket` is a 404 unless `DEV_SEED_ENABLED=true`. It inserts a paid order, a
registration and a signed ticket, and returns `{ orderId, regId, ticketId, qrCode }`.
Never enable it in production.
