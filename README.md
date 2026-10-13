# event-engine

Multi-tenant Cloudflare Worker backend for native-feeling event registration on HubSpot CMS sites. HubSpot is the system of record for contacts, marketing events, deals, invoices, and payments, and renders the entire front end. This repo handles only what HubSpot Professional cannot: atomic seat capacity, reservation holds, waitlist, ticket/QR generation, and check-in.

**Codename:** event-engine (this repo). **Product name:** Paddock (HubSpot marketplace app). Use `event-engine` in code; Paddock is brand only.

First tenant: Weld Australia.

## Architecture

Four layers — keep them separate:

| Layer                  | Responsibility                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------- |
| **Participation**      | Native HubSpot Marketing Events (register / attend / cancel / no-show)                  |
| **Content / pages**    | HubDB dynamic pages + CMS module                                                        |
| **Money**              | Deal + line-item Products + HubSpot Invoice → Stripe (AUD) → Xero via HubSpot Data Sync |
| **Capacity / tickets** | This worker (Cloudflare Workers + D1 + Durable Objects + Queues)                        |

```
HubDB events row ──► CMS template + registration module
                              │
                              ▼
                     event-engine worker
                       │  availability / reserve / orders
                       │  payment confirm → tickets + outbox
                       ▼
              HubSpot (ME, contacts, deals, invoices)
                              │
                              ▼
                     Stripe (AUD) → Xero (Data Sync)
```

## Monorepo

pnpm workspace. Root scripts: `pnpm lint`, `pnpm typecheck` (alias: `pnpm type-check`), `pnpm test`.

| Package                | Path                   | Role                                                                                  |
| ---------------------- | ---------------------- | ------------------------------------------------------------------------------------- |
| `@paddock/worker`      | `packages/worker`      | Cloudflare Worker — capacity, reservations, payments, check-in, HubSpot write-back    |
| `@paddock/hubspot`     | `packages/hubspot`     | HubSpot Project — CMS assets, registration module, HubDB schemas, app UI extensions   |
| `@paddock/checkin-pwa` | `packages/checkin-pwa` | Offline-capable door-scan PWA (QR verify + batch sync)                                |
| `@paddock/shared`      | `packages/shared`      | Cross-boundary types and contracts (reserve wire format, outbox kinds, HubDB schemas) |

## Stack

- **Runtime:** Cloudflare Workers, **Hono** router, TypeScript
- **D1** — durable record (orders, registrations, tickets, outbox)
- **Durable Objects** — atomic seat math; one `EventCapacity` instance per event
- **Queues** — drain the outbox (HubSpot write-back) with retry/backoff + DLQ
- **Cron** — subscription renewal, webinar finalize, outbox reconciliation
- **KV** — Graph token + subscription id cache

## Core invariants

Violating these is a bug:

- **Never oversell.** All seat math goes through the `EventCapacity` DO. D1 never decrements a capacity counter on the hot path.
- **Seats commit only on payment confirm**, never on reserve. A reserve is a TTL hold:
  15 minutes for a free booking, or until the HubSpot invoice due date for a paid one
  (per-event / per-portal payment terms, 30-day default, 90-day maximum).
- **Every HubSpot side effect goes through the `outbox` table** in the same D1 transaction as the state change, then drains via the queue. No fire-and-forget HubSpot calls from request handlers.
- **Idempotency everywhere external.** Reserve requires an `Idempotency-Key`. Marketing Event attendance writes use a stable `interactionDateTime`. Webhooks dedup on provider event id.
- **Multi-tenant from day one.** Every row carries `portal_id`. Secrets are resolved per tenant (`{PREFIX}_{portalIdOrTenantId}` via Wrangler).
- **No direct Xero calls.** Invoice + payment reach Xero via HubSpot Data Sync; the worker's money job ends at creating the HubSpot invoice.

Handler pattern: validate → mutate D1 (+ outbox in same txn) → enqueue → respond.

## Worker API

Public registration (CMS module):

| Method | Path                                | Notes                                     |
| ------ | ----------------------------------- | ----------------------------------------- |
| `GET`  | `/api/v1/events/:slug/availability` | Live seat counts from the DO              |
| `GET`  | `/api/v1/events/:slug/questions`    | Custom question definitions (no answers)  |
| `POST` | `/api/v1/events/:slug/reserve`      | Requires `Idempotency-Key`, `X-Portal-Id` |
| `GET`  | `/api/v1/orders/:id`                | Poll for `paymentUrl` after reserve       |

Check-in (device token auth):

| Method | Path                                |
| ------ | ----------------------------------- |
| `POST` | `/api/v1/checkin`                   |
| `POST` | `/api/v1/checkin/batch`             |
| `GET`  | `/api/v1/checkin/manifest/:eventId` |
| `GET`  | `/api/v1/checkin/stats/:eventId`    |
| `POST` | `/api/v1/checkin/device-token`      |

Webhooks: `/webhooks/hubspot`, `/webhooks/graph`, `/webhooks/app-uninstall`, `/webhooks/refuel`

Install / OAuth: `POST /install`, `GET /oauth/callback`

Admin / CRM extensions: `/admin/*`, `/api/v1/manage/*`

Health: `GET /health`

## Local development

**Prerequisites:** Node.js, pnpm, [Wrangler](https://developers.cloudflare.com/workers/wrangler/).

```bash
pnpm install

# Worker (local dev server) (for windows users, use pnpm.cmd instead of pnpm to execute code)
cd packages/worker
pnpm dev

# Apply D1 migrations locally, then optional dev seed (for windows users, use npx.cmd infront of the wrangler to execute code)
wrangler d1 migrations apply event-engine-db --local
wrangler d1 execute event-engine-db --local --file=seeds/seed_dev.sql

# Check-in PWA (for windows users, use pnpm.cmd instead of pnpm to execute code)
cd packages/checkin-pwa
pnpm dev

# Typecheck, lint + tests (from repo root) (for windows users, use pnpm.cmd instead of pnpm to execute code)
pnpm install
pnpm lint
pnpm type-check
pnpm test
```

Secrets are set via `wrangler secret put` — never committed. See [docs/deploy-config.md](docs/deploy-config.md) for bindings, migration list, and the full secret naming convention.

## HubSpot Project

The `@paddock/hubspot` package deploys CMS templates, the registration module, HubDB table definitions, and CRM app extensions (onboarding, event management, attendance view).

```bash
cd packages/hubspot
hs project upload
hs hubdb create src/hubdb/ticket_types.table.json
hs hubdb create src/hubdb/events.table.json
```

Per-portal config (worker URL, table ids, brand) is supplied at install time — nothing tenant-specific is hard-coded in assets. See [packages/hubspot/README.md](packages/hubspot/README.md).

## Business rules (Weld — first tenant)

- Members are identified by a company-level status cloned to the contact. Non-members cannot buy member-only events or member-priced tickets. Member pricing is **tiered by level + category** (corporate / industry supplier / individual) via `pricing_rules`, not a single binary member price (Phase 18.1).
- Refunds follow a **per-event policy** (full / partial / transfer), default full-refund-to-30-days; a registration can also be **transferred** to a new attendee without refunding (Phase 18.2).
- **Oversell and waitlist are human-in-the-loop** (Phase 18.3): the worker never auto-resolves. A late-payment oversell parks the order in `needs_review` and assigns the event owner a task to honour or refund; a freed seat opens a waitlist decision for the owner to pick who to offer (30-minute offer TTL). No `allow_oversell` auto-honour, no auto next-in-line offer.
- GST defaults on (10% included); a per-ticket `gst_free` toggle in the admin card maps the line to the imported Xero GST-free rate.
- Capacity is event-level + per-ticket-type. No per-session capacity.
- Money in integer cents (AUD). Timestamps ISO 8601 UTC in D1; display timezone default `Australia/Adelaide`.

## Online events (Microsoft Teams)

Online events use a `WebinarProvider` abstraction. Teams is the MVP implementation. The worker creates webinars via Graph, stamps our registration id at register time, and pulls attendance via change-notification subscriptions (renewed ~every 12h). The personal join URL is written to the contact before HubSpot's confirmation workflow fires.

## Documentation

Start at [docs/README.md](docs/README.md) — the documentation index, which separates the
reference docs (written from the code, kept current) from the specs and briefs (design
intent at a point in time).

Reference:

| Doc                                                        | Contents                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------- |
| [CLAUDE.md](CLAUDE.md)                                     | Invariants, HubSpot gotchas, business rules, conventions            |
| [docs/architecture.md](docs/architecture.md)               | Layers, why the DO and the outbox exist, full module map             |
| [docs/getting-started.md](docs/getting-started.md)         | Local setup, migrations, dev seed, smoke tests, troubleshooting      |
| [docs/data-model.md](docs/data-model.md)                   | D1 schema, order state machine, DO state and endpoints, KV keys      |
| [docs/api-reference.md](docs/api-reference.md)             | Every worker endpoint: auth, headers, bodies, error statuses         |
| [docs/flows.md](docs/flows.md)                             | Booking, waitlist, oversell, refund, transfer, vouchers, attendance  |
| [docs/outbox-queues-cron.md](docs/outbox-queues-cron.md)   | Outbox contract, kinds, retry model, cron tasks, idempotency map     |
| [docs/hubspot-integration.md](docs/hubspot-integration.md) | OAuth, deals, invoices, GST maths, Marketing Events, webhooks, HubDB |
| [docs/webinar-providers.md](docs/webinar-providers.md)     | The provider interface, credentials, Teams specifics, adding one     |
| [docs/security.md](docs/security.md)                       | Auth surfaces, crypto, tenant isolation, secret inventory            |
| [docs/testing.md](docs/testing.md)                         | vitest-pool-workers setup, test map, CI                              |
| [docs/contributing.md](docs/contributing.md)               | Code and migration conventions, PR checklist                         |

Specs, briefs and runbooks:

| Doc                                                                  | Contents                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------ |
| [docs/event-worker-spec.md](docs/event-worker-spec.md)               | Original worker build brief                            |
| [docs/deploy-config.md](docs/deploy-config.md)                       | Migration and wrangler notes, renumbering runbook      |
| [docs/tenant-provisioning-spec.md](docs/tenant-provisioning-spec.md) | Multi-tenant install and provisioning design           |
| [docs/ui-and-onboarding-spec.md](docs/ui-and-onboarding-spec.md)     | CRM app UI and onboarding flows                        |
| [docs/ops-runbook.md](docs/ops-runbook.md)                           | Per-tenant onboarding checklist, incident playbook     |
| [docs/weld-feature-brief.md](docs/weld-feature-brief.md)             | Phase 18 implementation brief                          |
| [packages/hubspot/README.md](packages/hubspot/README.md)             | CMS deploy, module contract, per-portal config         |

## License

Proprietary — copyright Refuel Creative, all rights reserved. See [LICENSE](LICENSE).
Access to this repository grants no right to use, copy or distribute the code.

Third-party open-source dependencies are recorded in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md), generated from the lockfile by
`pnpm notices`. Regenerate and commit it whenever a dependency changes;
`pnpm notices:check` fails if it is stale.
