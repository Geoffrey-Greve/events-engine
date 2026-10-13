# Conventions and contributing

## Before you write code

Read [CLAUDE.md](../CLAUDE.md). The invariants there are not style preferences; violating
one is a bug, and a reviewer will send it back. The short version:

1. All seat math goes through the `EventCapacity` DO. D1 never decrements a capacity
   counter on the hot path.
2. Seats commit on payment confirm, never on reserve.
3. Every HubSpot side effect goes through the `outbox` table in the same D1 batch as its
   state change.
4. Idempotency everywhere external.
5. Multi-tenant from day one. Every row carries `portal_id`; every secret resolves per
   tenant.
6. The worker makes no direct Xero calls.
7. Oversell and waitlist promotion stay human in the loop. The worker never auto-resolves.

If a task appears to require breaking one, stop and raise it rather than working around it.

## Code conventions

**Formatting** is Biome, configured in `biome.json`: 2-space indent, 100-character lines,
single quotes, always semicolons, imports auto-organised. Run `pnpm format` or
`pnpm lint:fix`.

**TypeScript** is strict, ES2022, `noEmit`. No build step between packages;
`@paddock/shared` is consumed from source through the path mapping in `tsconfig.base.json`.

**Naming.** D1 row types use `snake_case` to match column names, and are declared where
they are read (`db.ts` for the shared ones, locally otherwise). Everything else is
`camelCase`. `INTEGER` booleans stay `number` in row types; coerce with `!!row.field` at
the point of use.

**Money** is integer cents, currency AUD, and stored ticket prices are GST inclusive. There
is no float money anywhere. **Timestamps** are ISO 8601 UTC strings; `Australia/Adelaide` is
a display default only.

**Comments earn their place.** The house style in this repo is a file-level docblock saying
what the module is for and what the tricky invariant is, then comments only where the code
would otherwise read as arbitrary. Several comments record a real production incident (the
duplicate-line aggregation in the DO, persisting the invoice id before follow-up calls, the
base64url padding fix). Do not delete those; they are the reason the code looks the way it
does.

**Errors.** Use the existing types rather than inventing new ones: `ReserveError(status,
message, httpStatus)` for anything a buyer will see, `RetryableError` and `PermanentError`
in the write-back path, `GraphError` for Graph. A new `ReserveError` status is part of the
public contract, because the CMS module branches on it; add it to
[api-reference.md](api-reference.md) in the same commit.

**Logging** is single-line JSON to `console.log` or `console.error`, with `level` and
`event` fields and no PII beyond an email where it is operationally necessary. Match the
existing event names so log searches keep working.

**Where a type belongs.** If a shape crosses the worker boundary (the CMS module, the
scanner PWA, an App Card), it belongs in `@paddock/shared`. If it does not, keep it local.

## Adding a D1 migration

One file per change, named `NNNN_snake_case.sql`, four digits, never reused.

`wrangler d1 migrations apply` runs files in **filename order**, so two files sharing a
number have their apply order decided by the rest of the name rather than by intent. That
stays invisible until one depends on the other. `pnpm check:migrations` enforces the rule
and runs first in CI: it fails on a duplicate numeric prefix or a malformed name, and warns
on a gap.

Rules that follow from SQLite and from D1's bookkeeping:

- **Additive only.** SQLite has no `IF NOT EXISTS` for columns and limited `ALTER`. Add
  columns, do not rewrite tables.
- **A new column on a populated table must be nullable or have a default.** SQLite cannot
  add a `NOT NULL` column without one. Migration 0013 (`reservation_items.unit_cents`) is
  the pattern: nullable, with readers coalescing for legacy rows.
- **Never edit an already-applied migration.** Add a new one. Migration 0001 carries a
  comment explaining exactly this: putting `reservation_items.portal_id` into it would
  never reach databases that already ran the earlier version, and would break 0006 on
  fresh ones.
- **Renaming an applied migration re-runs it.** D1 tracks applied migrations by filename in
  `d1_migrations`. If you renumber, rewrite the recorded names on every existing database
  *before* the next apply. The runbook is in [deploy-config.md](deploy-config.md).
- Apply to staging and verify before production.
- Document new columns in [data-model.md](data-model.md) in the same commit.

**Only numbered migrations may live in `migrations/`.** `wrangler d1 migrations apply`
applies every `.sql` file in `migrations_dir`, not only the `NNNN_`-prefixed ones, so an
unnumbered helper file there is applied as a migration to whichever database the command
is pointed at. Seeds and one-off scripts go in `packages/worker/seeds/` and are run
explicitly:

```bash
pnpm exec wrangler d1 execute event-engine-db --local --file=seeds/seed_dev.sql
```

`pnpm check:migrations` fails on any filename in `migrations/` that is not
`NNNN_snake_case.sql`, which is what keeps this from recurring.

## Adding an endpoint

1. Pick the right sub-app, which decides the auth model: `manage.ts` for per-portal admin
   key, `app-home.ts` for HubSpot-signed extension calls, `admin.ts` for platform
   operations, `corporate-team.ts` for member-portal actions, `reserve.ts` and
   `checkin.ts` for public and device paths.
2. Follow the handler contract: validate, mutate D1 with outbox rows in the same batch,
   enqueue signals, respond.
3. Scope every query to the verified portal id.
4. Return `{ status, message }` on failure, with a stable `status` string.
5. Add it to [api-reference.md](api-reference.md).

## Adding a HubSpot side effect

1. Add the topic to `OutboxKind` in `packages/shared/src/outbox.ts`.
2. Add the handler and its `case` in `hubspot-writeback.ts`. Without the case the row
   dead-letters through the unknown-kind path.
3. Insert the outbox row in the same batch as the state change, and signal the queue best
   effort afterwards.
4. Carry identifiers in the payload and recompute anything that could go stale at delivery
   time.
5. Classify failures as retryable or permanent; `hs()` already does this for HubSpot
   responses, so let its errors propagate rather than catching them.
6. Add it to the kinds table in [outbox-queues-cron.md](outbox-queues-cron.md).

## Adding a webinar provider

See [webinar-providers.md](webinar-providers.md#adding-a-provider).

## Tests

Every change ships with tests. Anything touching capacity ships with a **concurrent reserve
test**. See [testing.md](testing.md).

## Documentation

Update the reference doc in the same commit as the code. Specifically:

| You changed | Update |
| --- | --- |
| a business rule | the business-rules section of [CLAUDE.md](../CLAUDE.md), so the spec does not drift |
| the schema | [data-model.md](data-model.md) |
| an endpoint or an error status | [api-reference.md](api-reference.md) |
| an outbox kind, queue job or cron task | [outbox-queues-cron.md](outbox-queues-cron.md) |
| a flow's behaviour | [flows.md](flows.md) |
| a secret, or an auth surface | [security.md](security.md) |
| a module's role, or a new module | the module map in [architecture.md](architecture.md) |

## Dependencies

Adding one changes `THIRD-PARTY-NOTICES.md`. Regenerate and commit it:

```bash
pnpm notices
```

`pnpm notices:check` fails if it is stale. The worker's runtime dependency list is
deliberately tiny (Hono, and `@paddock/shared`); everything cryptographic uses Web Crypto.
Keep it that way unless there is a strong reason.

## Before you push

```bash
pnpm check:migrations && pnpm typecheck && pnpm test
```

That is what CI runs. `pnpm lint` is not gated yet, but do not add new Biome errors.

## Licence

Proprietary, copyright Refuel Creative. Repository access grants no right to use, copy or
distribute the code. See [LICENSE](../LICENSE).
