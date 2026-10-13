# Getting started

## Prerequisites

- Node.js 22 (CI pins 22; anything older is untested)
- pnpm 11.5.0, pinned by `packageManager` in the root `package.json`
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) 4.x, installed as a dev
  dependency of `@paddock/worker`, so `pnpm exec wrangler` works without a global install
- [HubSpot CLI](https://developers.hubspot.com/docs/guides/cli/overview) 8.x, only if you
  are deploying the `@paddock/hubspot` package

On Windows, use `pnpm.cmd` in place of `pnpm` and prefix wrangler with `npx.cmd`.

## Install

```bash
pnpm install
```

That installs every workspace package. `@paddock/shared` is consumed straight from source
via the `@paddock/shared` path mapping in `tsconfig.base.json`, so there is no build step
between packages.

## Root scripts

Run these from the repo root.

| Script | What it does |
| --- | --- |
| `pnpm typecheck` (alias `pnpm type-check`) | `tsc --noEmit` in every package |
| `pnpm test` | `vitest run` in every package that has tests (currently the worker) |
| `pnpm lint` | `biome check .` |
| `pnpm lint:fix` | `biome check --write .` |
| `pnpm format` | `biome format --write .` |
| `pnpm check:migrations` | guards the D1 migration sequence |
| `pnpm notices` | regenerates `THIRD-PARTY-NOTICES.md` from the lockfile |
| `pnpm notices:check` | fails if the notices file is stale |
| `pnpm deploy:all` / `pnpm deploy:staging` | deploys worker, HubSpot project and PWA |

`pnpm lint` is deliberately not gated in CI yet: Biome currently reports pre-existing
errors across the repo. Do not add new ones, and do not switch it on until the backlog is
clear. Details in `.github/workflows/ci.yml`.

## Run the worker locally

```bash
cd packages/worker

# apply every migration to the local D1
pnpm exec wrangler d1 migrations apply event-engine-db --local

# optional dev seed: one tenant (portal 99999999), one event, two ticket types
pnpm exec wrangler d1 execute event-engine-db --local --file=seeds/seed_dev.sql

pnpm dev
```

`wrangler dev` reads `packages/worker/wrangler.toml`, which binds D1, KV, the queue and
the `EVENT_CAPACITY` Durable Object namespace, and registers the three cron triggers.

The seed gives you:

| Thing | Value |
| --- | --- |
| Portal id | `99999999` |
| Event id (the `:slug` path param) | `evt_dev_001` |
| HubSpot marketing event id | `hs-evt-dev-001` |
| Member-only ticket type | `tt_dev_001`, $99.00, capacity 20 |
| General ticket type | `tt_dev_002`, $149.00, capacity 30 |
| Event capacity | 50 |

### Smoke test

```bash
curl http://localhost:8787/health

curl -H 'X-Portal-Id: 99999999' \
  http://localhost:8787/api/v1/events/evt_dev_001/availability

curl -X POST http://localhost:8787/api/v1/events/evt_dev_001/reserve \
  -H 'X-Portal-Id: 99999999' \
  -H 'Idempotency-Key: dev-001' \
  -H 'Content-Type: application/json' \
  -d '{"buyer":{"email":"dev@example.com","name":"Dev Buyer"},"ticketTypeId":"tt_dev_002"}'
```

The reserve above will fail with `payment_not_configured`, and that is correct: a paid
order refuses to hold a seat until the tenant has `stripe_processor_connected = 1` and an
`xero_gst_rate_id`. To exercise the paid path locally, set both on the seeded tenant:

```bash
pnpm exec wrangler d1 execute event-engine-db --local --command \
  "UPDATE tenants SET stripe_processor_connected = 1, xero_gst_rate_id = 'dev-gst' WHERE portal_id = '99999999'"
```

There is also a dev-only ticket minting endpoint, `POST /dev/seed-ticket`, which is a 404
unless `DEV_SEED_ENABLED=true` is set in the environment. It creates a paid order, a
registration and a signed ticket, and returns the QR code. Use it to test the check-in PWA
without going through checkout.

## Run the check-in PWA locally

```bash
cd packages/checkin-pwa
pnpm dev
```

The PWA needs two things at its setup screen: the worker base URL, and a device token. Mint
one with the admin key for the portal:

```bash
curl -X POST http://localhost:8787/api/v1/checkin/device-token \
  -H 'X-Portal-Id: 99999999' \
  -H 'Authorization: Bearer <ADMIN_API_KEY_99999999>' \
  -H 'Content-Type: application/json' \
  -d '{"eventId":"evt_dev_001","deviceId":"door-1","ttlSeconds":43200}'
```

The token is event-scoped. Everything after that (manifest download, offline verify, scan
queue, batch flush) is described in [flows.md](flows.md#check-in).

## Secrets locally

Production secrets are set with `wrangler secret put` and are never committed. For local
dev and tests:

- Tests get fixed values from the `miniflare.bindings` block in
  `packages/worker/vitest.config.ts`. That is the authoritative list of what the crypto and
  token helpers need to run.
- For `wrangler dev`, put non-production values in `packages/worker/.dev.vars` (gitignored).

Per-tenant secrets follow the `{PREFIX}_{portalId}` convention and are read through
`getSecret(env, name)`, which throws on a missing or empty value. The full inventory is in
[security.md](security.md#secret-inventory).

## HubSpot project

```bash
cd packages/hubspot
hs project upload
hs hubdb create src/hubdb/ticket_types.table.json
hs hubdb create src/hubdb/events.table.json
```

Create `ticket_types` first: the `events` table has a `FOREIGN_ID` column pointing at it.
Per-portal configuration (worker base URL, table ids, brand) is supplied at install time;
nothing tenant-specific is committed. See `packages/hubspot/README.md`.

## Deploying

```bash
# staging
pnpm --filter @paddock/worker deploy:staging      # wrangler deploy --env staging
pnpm deploy:staging                                # worker + hubspot + pwa

# production
pnpm --filter @paddock/worker deploy
pnpm deploy:all
```

Migrations are applied separately, and before the deploy that needs them:

```bash
cd packages/worker
pnpm exec wrangler d1 migrations apply event-engine-db-staging --remote
pnpm exec wrangler d1 migrations apply event-engine-db --remote
```

Staging and production have separate D1 databases, KV namespaces and queues. See the
`[env.staging]` block in `wrangler.toml` and [deploy-config.md](deploy-config.md).

> `wrangler d1 migrations apply` applies **every** `.sql` file in `migrations_dir`, not
> only the `NNNN_`-prefixed ones. That is why the dev seed lives in
> `packages/worker/seeds/` and is run explicitly with `d1 execute`: while it sat in
> `migrations/`, the command above would have inserted the dev tenant and event into
> whichever database it was pointed at. Keep `migrations/` to numbered migrations only;
> `pnpm check:migrations` now fails on anything else.

## Troubleshooting

**`Secret "X" is missing or empty`**: `getSecret()` throws rather than returning
undefined. Add the value to `.dev.vars` locally, or to `vitest.config.ts` bindings for
tests, or `wrangler secret put` for a deployed environment.

**Reserve returns `payment_not_configured`**: the tenant has no Stripe flag or no GST rate
id. See the SQL above.

**Reserve returns `members_only` or `membership_unverified`**: membership resolution calls
HubSpot. With no token configured, `resolveMembership` returns unverified, which blocks
member-only ticket types. Use `tt_dev_002` for local work, or set `HUBSPOT_API_KEY_99999999`.

**Availability shows `null` everywhere**: `null` means uncapped, not zero. It is also the
graceful fallback when the DO is unreachable.

**A migration will not apply**: run `pnpm check:migrations`. If you renamed an
already-applied migration, read the renumbering section of
[deploy-config.md](deploy-config.md); D1 tracks applied migrations by filename.

**Tests hang or leak state between files**: `isolatedStorage` is off by design (a
vitest-pool-workers bug with D1's WAL file). Tests must use unique ids per case. See
[testing.md](testing.md).

**A test fails with `FOREIGN KEY constraint failed` or `NOT NULL constraint failed`**: the
suite runs against the real migrations, so both are enforced exactly as they are in
production. Seed the parent row — `seedTenant`, `seedEvent`, `seedTicketType` in
`packages/worker/test/support/fixtures.ts` — rather than reaching for a laxer table. Test
files declare no DDL, and a guard fails the build if one starts to. See
[testing.md](testing.md).
