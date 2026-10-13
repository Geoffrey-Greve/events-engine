# event-registration — HubSpot Project

Distributable, **portal-agnostic** front-end for the event-engine worker. This bundle is
the HubSpot-CMS half of the product: the pages buyers see, the registration widget, the
HubDB content model, and the lifecycle workflows. The capacity/seat/payment brain lives in
the Cloudflare Worker (this repo's `src/`); HubSpot is the system of record and renders the
front end.

> **Nothing tenant-specific lives here.** Every portal value — worker base URL, HubDB table
> ids, brand, GST rate, contact-property internal names — is *configuration*, supplied per
> portal at install time. There is no Weld (or any other tenant) data, copy, colour, or id
> committed to this repo. Brand lives in the **consuming theme**, not in these assets.

## What's in here

```
src/
  cms-assets/                          CMS assets PROJECT COMPONENT (deployed by hs project upload)
    cms-assets-hsmeta.json             Component manifest (uid + type: cms-assets)
    cms-assets.json                    Asset inventory (templates + module + css to deploy)
    README.md                          Component overview
    templates/events.html              Dynamic page template (listing + detail/registration)
    modules/event-registration.module/ The registration widget (live availability + reserve)
    css/events.css                     Minimal, unopinionated structural CSS
    workflows/                         Documented specs for the lifecycle workflows (reference)
      README.md                        Workflow + contact-property setup notes
      confirmation-with-ics.md         Confirmation email + .ics (reads teams_join_url)
      reminder-t7.md / reminder-t1.md  T-7 / T-1 reminders
      no-show-followup.md              No-show follow-up off the native No-Show state
  hubdb/
    events.table.json                  HubDB "events" table definition
    ticket_types.table.json            HubDB "ticket_types" table definition
    README.md                          HubDB setup notes (dynamic pages, references, config)
hsproject.json                         Project anchor (platformVersion 2026.03)
```

## Deploy (HubSpot CLI)

The worker contract is the only hard dependency. Set your per-portal config first, then push.

1. **Auth + project.** `hs init` (or `hs account use <portal>`), then from this folder
   `hs project upload`. The `cms-assets` component (templates, module, css — see
   [`src/cms-assets/cms-assets-hsmeta.json`](src/cms-assets/cms-assets-hsmeta.json)) deploys
   with the project; there is **no separate `hs upload`** step.
2. **HubDB.** Create both tables — see [`src/hubdb/README.md`](src/hubdb/README.md):
   ```
   hs hubdb create src/hubdb/ticket_types.table.json
   hs hubdb create src/hubdb/events.table.json
   ```
   Note the **table ids** that come back — they are portal configuration (see below).
3. **Page.** Create a HubDB-backed site page on `events.html`, bound to the `events`
   table, dynamic pages enabled.
4. **Workflows + contact properties.** Build from [`src/cms-assets/workflows/`](src/cms-assets/workflows/README.md)
   — these are documented as exportable specs because the JSON is portal-scoped (owner ids,
   branch ids, asset ids).

## Per-portal configuration (the only things you set)

| Value | Where it's set | Notes |
| --- | --- | --- |
| Worker base URL | `event-registration` **module field** (or theme/app setting) | e.g. `https://api.example-events.com` — never hard-coded in an asset |
| Portal id sent to the worker | Module field, defaults to `{{ hub_id }}` | Override only if the worker keys tenants on something other than the Hub ID |
| `ticket_types` table id | HubL lookup uses the table **name** by default; override with the id if name-lookup is off | portal-specific |
| `events` ↔ `ticket_types` reference | `foreignTableId` placeholders in the HubDB JSON | filled at create time — see hubdb/README.md |
| Brand (colour, type, logo, copy tone) | The consuming **theme** | this bundle ships structure only |
| GST tax rate, membership property, ABN property | Worker / workflow config | imported from Xero / mapped per portal |

## How the pieces talk

```
HubDB events row ──(hs_path, worker_event_id)──► events.html (detail)
                                                      │ renders
                                                      ▼
                                     event-registration module
                                       │  GET  {worker}/api/v1/events/:slug/availability   ← live seats (never HubDB)
                                       │  POST {worker}/api/v1/events/:slug/reserve         ← Idempotency-Key
                                       │  GET  {worker}/api/v1/orders/:id (poll)            ← paymentUrl
                                       ▼
                              redirect → HubSpot-hosted invoice → Stripe (AUD)
```

The worker is the **only** source of seat truth. HubDB stores content (titles, copy, ticket
names/prices, the worker ids to call) — never live availability or remaining counts.

## Worker endpoint contract (dependency)

This bundle calls three worker endpoints. Two already exist in `src/`; the **availability**
read is the one new endpoint the worker must expose for the widget to show live counts:

| Endpoint | Status | Shape |
| --- | --- | --- |
| `POST /api/v1/events/:slug/reserve` | exists | headers `Idempotency-Key`, `X-Portal-Id`; → `waitlisted` \| `confirmed` \| `reserved` \| error |
| `GET /api/v1/orders/:id` | exists | header `X-Portal-Id`; → `{ status, paymentUrl }` |
| `GET /api/v1/events/:slug/availability` | **to add** | header `X-Portal-Id`; → `{ ticketTypes: [{ ticketTypeId, available, soldOut, waitlistAvailable }], eventFull }` |

The availability read should be served from the **EventCapacity DO** (the same source the
waitlist promotion already reads), never from D1 counters or HubDB. The module degrades
gracefully if the endpoint is missing — it just hides per-ticket counts and still lets the
buyer reserve (the worker stays authoritative at reserve time). The worker must also send
**CORS** headers allowing the CMS origin for the availability + reserve + order routes.
