# Security model

## Tenant isolation

Multi-tenant from day one, not retrofitted.

- Every data row carries `portal_id`, and every query filters on it. If you write a query
  without a `portal_id` predicate, assume it is a bug.
- Every token and secret is resolved per tenant, through `getSecret(env, name)` and the
  `{PREFIX}_{portalId}` naming convention. `getSecret` throws on a missing or empty value
  rather than returning undefined, so a misconfiguration fails loudly.
- Durable Object instances are keyed `${portalId}:${hubspot_event_id}`, so one tenant's
  seat state is a different object from another's.
- Nothing tenant-specific belongs in a shared layer. If you find yourself writing a Weld
  branch outside a config lookup, that is the smell.
- **A portal id supplied by a caller is never authoritative for a privileged operation.**
  HubSpot's comes from token introspection; the provider connect callback takes it from
  signed state; App Home takes it from signed query metadata; the manage API takes it from
  the verified admin identity. `X-Portal-Id` on public endpoints only scopes a read or a
  reserve, and every such query is still bounded by it.

## Auth surfaces

| Surface | Mechanism | Notes |
| --- | --- | --- |
| Public registration | none, plus `X-Portal-Id` and an `Idempotency-Key` | rate limited: 20 reserves and 60 availability reads per minute per IP. All public bookings also need Turnstile when configured |
| Check-in scan and read | device token, `Authorization: Bearer` | event-scoped, stateless HMAC, 12-hour default TTL and 24-hour maximum. `deviceAuth` middleware |
| Device-token issuance | `X-Portal-Id` plus `ADMIN_API_KEY_{portalId}` (bearer or `X-Admin-Key`) | deliberately **not** device auth: a device cannot mint its own token |
| Tenant admin (`/api/v1/manage/*`) | the same per-portal admin key, via `authenticateAdmin` | compared with a constant-time equality check. The verified portal id is put on the context and used for every query |
| App Home (`/api/v1/app-home/*`) | HubSpot v3 request signature | portal id and acting user from signed query metadata |
| Corporate portal (`/api/v1/corporate/*`) | server-side per-portal HubSpot token, plus a live actor-permission check | see below |
| Platform admin (`/admin/*`) | `ADMIN_SECRET` bearer | 503 when unconfigured, 401 on mismatch |
| Webhooks | per-provider signature verification | HubSpot v3, the older uninstall SHA-256 scheme, Graph `clientState`, Zoom's scheme |
| Provider connect | admin auth to start, HMAC-signed state to finish | 10-minute state TTL |

### Corporate portal, which is the widest surface

`routes/corporate-team.ts` is the only place a request handler calls HubSpot
synchronously, because it has to verify permissions before mutating. The rules it enforces:

- the browser never receives a HubSpot write token;
- every write re-checks against HubSpot immediately before the mutation, not from cached
  state;
- the actor contact must be associated to the submitted company with an Admin or Primary
  Admin association label;
- the target contact must already be linked to that same company;
- the body `portalId` must match the `X-Portal-Id` header;
- contacts are never deleted. Removal archives the contact-to-company association labels
  for that company only;
- self-removal and admin-removal are blocked;
- every attempt, including a blocked one and its reason, writes a `corporate_team_audit`
  row.

## Cryptography

All of it is Web Crypto. There is no crypto dependency in the worker.

### Ticket QR codes

```
code = base64url(JSON{ tid, rid, eid })  "."  base64url(HMAC-SHA256(code_body, eventKey))
```

The signing key is **not** the tenant master secret. It is a per-event key derived from the
master with the label `event-engine/ticket-verify/v1:`. That derivation is the whole reason
offline check-in is safe:

- a door device downloads the derived key for its one event in the manifest;
- it verifies scans locally without the network and without ever holding the master;
- compromising one event's device key exposes neither the master nor any other event.

Master secret resolution, in `masterTicketSecret`: `TICKET_SIGNING_SECRET_{portalId}`,
falling back to `HUBSPOT_WEBHOOK_SECRET` until a dedicated key is provisioned. Provision the
dedicated key for any tenant you care about.

### Device tokens

Stateless HMAC tokens carrying `{ v: 1, portalId, eid, did, iat, exp }`, signed with
`DEVICE_TOKEN_SECRET_{portalId}` (falling back to the master ticket secret). Stateless means
there is no revocation list, which is why the TTL is short and the scope is one event.

### Waitlist offer tokens

A stateless capability over `${waitlistId}.${expiresAtMs}`, HMAC-SHA256 signed, compared
with a non-short-circuiting equality check. Validity is **re-derived from the waitlist row**
at claim time: the row must be `offered` and its stored `offer_expires_at` must equal the
token's expiry. A token from a superseded offer round therefore cannot be replayed once the
row is re-offered with a new expiry.

The signing key is currently `HUBSPOT_WEBHOOK_SECRET`, as for ticket codes. Add a dedicated
secret when operational separation matters.

### Token encryption at rest

`token-crypto.ts`: AES-GCM with a 256-bit key from `TOKEN_ENCRYPTION_KEY` (64 hex
characters). A random 12-byte IV is generated per encryption and prepended to the
ciphertext; output is base64url. The base64url decoder re-pads correctly for every length
residue, which was a real bug once (see `test/token-crypto.test.ts`).

Encrypted at rest with this key: HubSpot access and refresh tokens on the `tenants` row,
webinar provider tokens and API credentials in `webinar_connections`, and the legacy
`tenants.webinar_creds_enc` blob. The same key also derives the HMAC material for OAuth
connect state.

### Signature verification

Always `crypto.subtle.verify` or a non-short-circuiting compare, never `===` on a
signature string. `constantTimeEqual` in `checkin.ts` and `timingSafeEqual` in `waitlist.ts`
exist for the cases where a raw string compare is unavoidable.

HubSpot v3 verification also enforces a 5-minute timestamp window, which is the replay
defence.

## Abuse controls

**Rate limiting** (`middleware/rate-limit.ts`) is a KV sliding-window counter keyed on
`CF-Connecting-IP`, with a TTL of twice the window. In dev there is no such header and all
requests share the `dev` key. Applied to reserve (20 per minute) and availability (60 per
minute). It is a blunt instrument and it is not a substitute for the gates below.

**Turnstile** (`turnstile.ts`) is required when, and only when, both of these hold:
`source === 'public_checkout'`, and a Turnstile secret is configured for the portal. The
booking total is deliberately NOT part of the test. It used to be — only a zero total was
challenged, on the reasoning that a paid path is self-limiting — but that stopped being
true when a paid booking began holding its seat to the invoice due date (up to 90 days)
rather than for 15 minutes. An unchallenged caller could park an event's capacity with
throwaway emails and never pay. `staff_manual` and `corporate_bulk` are already
authenticated and are not challenged. Verification checks Siteverify's response and
optionally the returned hostname against `TURNSTILE_ALLOWED_HOSTNAMES{_portalId}`. Failures
log `turnstile_failed`; any public booking with no secret configured logs
`turnstile_not_configured` rather than silently passing.

**Server-authoritative pricing.** `memberTier`, `expectedUnitCents` and `memberCompanyId`
in a reserve body are advisory. Membership and price are resolved server side.
`expectedUnitCents` exists only so a mismatch fails with `price_mismatch` (logged as
`price_drift`) instead of quietly invoicing an amount the buyer never saw.
`memberCompanyId` is re-validated against CRM company membership or the HubDB directory
before any discount applies.

**`forceFree` is not reachable from a request body.** It is a `ReserveOptions` field, set
only by protected staff and corporate paths, so a public caller cannot turn a paid ticket
into a free one.

**Import-only ticket types** are hidden from public checkout by `isPublicImportTicket()`
and rejected with `ticket_not_available`.

**Duplicate registrations.** One attendee email may hold only one active registration per
event, where active means an order in `confirmed`, `paid` or `pending`. Cancelled and
refunded orders do not block a fresh booking. Gold members are exempt.

## Error disclosure

`app.onError` returns JSON with a generic message and an 8-character `ref`, and logs the
message, stack, method, path and portal id under `event: "unhandled_error"` with the same
`ref`. Buyers get a reference to quote; they do not get a stack trace. Keep it that way.

`ReserveError` statuses are intentionally specific (`members_only`,
`membership_unverified`, `payment_not_configured`) because the front end branches on them
and the buyer needs actionable copy. None of them leak internal ids.

## Secret inventory

### Platform level (one value for the whole worker)

| Secret | Used for |
| --- | --- |
| `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET`, `HUBSPOT_REDIRECT_URI` | HubSpot app OAuth. The client secret also verifies App Home request signatures |
| `HUBSPOT_WEBHOOK_SECRET` | HubSpot webhook v3 HMAC. Also the current fallback signing key for ticket codes and waitlist offers |
| `TOKEN_ENCRYPTION_KEY` | AES-GCM key, 64 hex characters. Encrypts every stored OAuth token, and derives connect-state HMAC material |
| `ADMIN_SECRET` | `/admin/*` bearer |
| `OAUTH_SUCCESS_REDIRECT_URI` | post-install redirect |
| `OAUTH_AUTO_PROVISION_HUBDB` | provisioning runs on install only when this is exactly `"true"` |
| `REFUEL_WEBHOOK_SECRET`, `REFUEL_HS_ACCESS_TOKEN` | Refuel-portal billing webhooks and deal lookups |
| `CMS_ALLOWED_ORIGIN` | comma-separated CORS allow-list for `/api/v1/*` |
| `ZOOM_/MEET_/VIMEO_/WISTIA_OAUTH_CLIENT_ID` and `_SECRET`, `WEBINAR_OAUTH_REDIRECT_BASE` | our app's provider OAuth credentials, shared across tenants |
| `MICROSOFT_OAUTH_REDIRECT_URI`, `MICROSOFT_GRAPH_DELEGATED_SCOPES` | optional Microsoft organiser OAuth overrides |
| `TURNSTILE_SECRET_KEY`, `TURNSTILE_ALLOWED_HOSTNAMES` | fallbacks when no per-portal value is set |
| `GRAPH_CLIENT_CERT_PRIVATE_KEY`, `GRAPH_CLIENT_CERT_THUMBPRINT`, `MICROSOFT_CLIENT_CERT_*` | single-tenant certificate auth fallbacks |
| `DEV_SEED_ENABLED` | `POST /dev/seed-ticket` is a 404 unless this is `"true"`. Never set in production |

### Per tenant (`{PREFIX}_{portalId}`)

| Secret | Used for |
| --- | --- |
| `ADMIN_API_KEY_{portalId}` | the manage API and device-token issuance |
| `TICKET_SIGNING_SECRET_{portalId}` | tenant master ticket key, from which per-event verify keys are derived |
| `DEVICE_TOKEN_SECRET_{portalId}` | device-token signing |
| `HUBSPOT_API_KEY_{portalId}` | optional per-portal private-app token. Preferred for membership reads; **required** by the corporate team API |
| `GRAPH_TENANT_ID_{portalId}`, `GRAPH_CLIENT_ID_{portalId}`, `GRAPH_CLIENT_SECRET_{portalId}` | Microsoft Graph app-only auth |
| `GRAPH_CLIENT_CERT_PRIVATE_KEY_{portalId}`, `GRAPH_CLIENT_CERT_THUMBPRINT_{portalId}`, `MICROSOFT_CLIENT_CERT_*_{portalId}` | certificate auth instead of a client secret |
| `GRAPH_ORGANISER_EMAIL_{portalId}`, `MICROSOFT_ORGANISER_EMAIL_{portalId}` | the organiser identity |
| `GRAPH_SUBSCRIPTION_CLIENT_STATE_{portalId}` | per-tenant value echoed in Graph notifications and verified on receipt |
| `GRAPH_NOTIFICATION_URL_{portalId}` | must be `https://<worker-host>/webhooks/graph` |
| `ZOOM_WEBHOOK_SECRET_{portalId}` | Zoom webhook verification |
| `TURNSTILE_SECRET_KEY_{portalId}`, `TURNSTILE_ALLOWED_HOSTNAMES_{portalId}` | per-tenant widget |

Set them with `wrangler secret put NAME` (add `--env staging` for staging). Never commit a
secret. For local dev use `packages/worker/.dev.vars`; for tests use the
`miniflare.bindings` block in `packages/worker/vitest.config.ts`, which holds fixed
non-production values.

## When adding code

Ask these five questions. If any answer is uncomfortable, the design is wrong.

1. Does every query I added filter on `portal_id`?
2. Where does the portal id come from, and could a caller have chosen it?
3. Is the external side effect in the outbox, in the same batch as its state change?
4. Is anything I signed or compared handled with a constant-time compare?
5. Can this be replayed safely, and which dedup row in
   [outbox-queues-cron.md](outbox-queues-cron.md#idempotency-and-dedup-in-one-place)
   covers it?
