# Testing

```bash
pnpm test                                    # every package
pnpm --filter @paddock/worker test           # the worker only
cd packages/worker && pnpm exec vitest run test/waitlist.test.ts
cd packages/worker && pnpm exec vitest       # watch mode
```

## The setup, and why it looks unusual

`packages/worker/vitest.config.ts` uses `@cloudflare/vitest-pool-workers`. Tests run in the
**real Workers runtime** under Miniflare, with the real bindings read from
`wrangler.toml`: `DB` is real D1, `QUEUE` is a real queue, and `EVENT_CAPACITY` gives you
real Durable Object instances.

Nothing about the runtime is mocked. That is the point. The no-oversell guarantee comes from
the DO's single-threaded-per-event behaviour, and a mocked DO would prove nothing about it.

Three config choices to know about:

**`singleWorker: true`** keeps every test in one isolate, so concurrent fetches to a DO
exercise its real gating rather than talking to separate instances.

**`isolatedStorage: false`** is off deliberately. The per-test storage snapshot trips a
known vitest-pool-workers bug on D1's WAL `-shm` file. The consequence is that **storage
persists across tests within a run**, so:

> Every test must use unique ids. There is no per-test rollback.

The convention across the suite is a counter plus a timestamp:

```ts
let counter = 0;
const freshIds = () => {
  const n = `${Date.now()}-${counter++}`;
  return { portalId: `p-${n}`, eventId: `evt-${n}`, hsEvent: `hs-${n}` };
};
```

If a test intermittently fails when run with the whole suite but passes alone, a shared id
is almost always the cause. One isolate also means one module registry, so `test/setup.ts`
calls `vi.resetModules()` before each file is imported: without it a `vi.mock()` for a
module some earlier file already imported for real silently does not apply, which had
`providers.test.ts` reaching for a D1 on an env that deliberately has none, in about one
run in three.

**`miniflare.bindings`** supplies fixed non-production secret values, because the crypto and
token helpers need something to sign with. That block is also the practical inventory of
what the worker cannot start without: `HUBSPOT_WEBHOOK_SECRET`, `HUBSPOT_CLIENT_ID`,
`HUBSPOT_CLIENT_SECRET`, `HUBSPOT_REDIRECT_URI`, `TOKEN_ENCRYPTION_KEY` (64 hex
characters), `ZOOM_OAUTH_CLIENT_ID` and `_SECRET`, `WEBINAR_OAUTH_REDIRECT_BASE`,
`OAUTH_SUCCESS_REDIRECT_URI`. Add a binding here when you add a secret a test path reads.

`test/env.d.ts` extends `cloudflare:test`'s `ProvidedEnv` with the worker's own `Env`, so
`env` is typed. Most tests still do `const E = env as unknown as Env` to get the narrower
type.

## Schema in tests

The schema is **`packages/worker/migrations`**, applied once before the first test file
runs (`test/setup.ts` → `test/support/migrate.ts`). Test files declare no DDL of their own,
and `test/schema-is-migrations.test.ts` fails the build if one starts to.

That is a correctness fix, not tidiness. Every file used to hand-roll its own
`CREATE TABLE IF NOT EXISTS` for the tables it read. The suite runs every file in ONE
worker against ONE D1 (`singleWorker`, `isolatedStorage: false`, both above), so whichever
file created a table first decided its columns and every later CREATE was a silent no-op.
Each file's DDL was a different subset of the real thing, so the schema the suite ran
against depended on the order vitest happened to pick: adding one test to one file was
enough to move another file to the front of the run and fail 145 tests in four suites
nobody had touched. A wider hand-rolled copy was not the fix; having a copy at all was the
fault.

Two consequences worth knowing before you write a fixture.

**Foreign keys and NOT NULL are live.** D1 enforces foreign keys and ignores
`PRAGMA foreign_keys = OFF`, so a row cannot reference one that is not there. Every
portal-scoped table REFERENCES `tenants(portal_id)`, which means a test that mints a fresh
portal has to register it. `test/support/fixtures.ts` makes that a one-liner:

```ts
const freshIds = async () => {
  const n = `${Date.now()}-${counter++}`;
  const portalId = `p-${n}`;
  await seedTenant(E.DB, portalId);      // also: seedEvent, seedTicketType
  return { portalId, eventId: `evt-${n}`, hsEvent: `hs-${n}` };
};
```

Seeding inside the id minter rather than remembering it per test is the convention, and it
is why most `freshIds` helpers in the suite are `async`.

**A state the schema refuses cannot be fixtured.** Two tests met this and say so where they
sit: a registration naming a deleted ticket type (`reporting.test.ts`, which now asserts the
LEFT JOIN against the shipped SQL instead), and a pending decision for a portal with no
`tenants` row (`decisions.test.ts`, which now covers the row that reaches production — one
with nothing configured on it). If a fixture will not go in, check whether you are testing
something the database would never hold before you work around it.

`test/schema-drift.test.ts` is the one file allowed to break the schema, because that is
what it tests: reading optional config must degrade rather than throw a plain-text 500 at
the buyer. It drops the whole schema (`tenants` cannot go on its own while everything
points at it) and rebuilds it from the migrations in `afterAll`. Do not "fix" that test by
adding the missing tables.

CI separately proves that the numbered migrations build the current schema from nothing
(the `migrations-from-empty` job), and `pnpm check:migrations` guards their sequence.

To check for yourself that the run no longer depends on file order:

```bash
cd packages/worker && pnpm exec vitest run --sequence.shuffle.files=true
```

CI stays in deterministic order, because a failure there has to be reproducible; the shuffle
is the thing to reach for when a suite starts passing alone and failing together.

## What is mocked, and what is not

Mocked: outbound `fetch` (HubSpot, Graph, provider APIs) with `vi.stubGlobal`, and the
credential layer where token storage is not what is under test. `test/providers.test.ts`
mocks `../src/providers/oauth` for exactly that reason: it tests request shaping and
response normalisation, and `oauth.test.ts` covers token storage and refresh separately.

Not mocked: D1, KV, Queues, Durable Objects, Web Crypto, or any of the worker's own modules.

## Test map

| File | Covers |
| --- | --- |
| `EventCapacity.test.ts` | the DO. Real concurrent fetches against real instances, plus the rebuild-from-D1 regression |
| `waitlist.test.ts` | join, sign, offer, claim, promote, end to end against a real DO |
| `reserve-duplicates.test.ts` | the duplicate-attendee gate, including the gold-member exemption |
| `manual-registration.test.ts` | staff manual and complimentary bookings |
| `corporate-team.test.ts` | actor permission checks and bulk registration |
| `vouchers.test.ts` | derived voucher accounting, baseline capture, refund return |
| `pricing.test.ts` | most-specific-wins rule resolution, member and non-member |
| `membership.test.ts` | contact, company and HubDB directory resolution. The largest suite |
| `gst.test.ts` | GST-exclusive line maths for HubSpot product lines |
| `commerce-lines.test.ts` | line-item naming |
| `refund-policy.test.ts` | policy resolution order and full, partial, none |
| `transfer.test.ts` | attendee reassignment |
| `decisions.test.ts` | oversell and waitlist decision resolution |
| `expired-invoice-lifecycle.test.ts` | a paid invoice attached to a lapsed hold |
| `invoice-reconcile.test.ts` | the scheduled invoice-status fallback |
| `attendance.test.ts` | `collapseIntervals`, pure, no runtime needed |
| `providers.test.ts` | every provider's request shaping and normalisation |
| `graph.test.ts` | the Graph client |
| `oauth.test.ts`, `connect.test.ts`, `hubspot-oauth-state.test.ts`, `microsoft-oauth.test.ts` | token exchange, refresh, storage, signed state, the connect flow |
| `checkin.test.ts` | ticket signing, per-event key derivation, device tokens |
| `token-crypto.test.ts` | AES-GCM round trip at every base64url length residue |
| `turnstile.test.ts` | when the bot check applies, and verification handling |
| `schema-drift.test.ts` | optional config reads degrading instead of failing a booking |
| `schema-is-migrations.test.ts` | the suite's schema being the shipped migrations, and staying that way |

## Writing a test

**Anything touching capacity ships with a concurrent reserve test.** That is a standing rule
from `CLAUDE.md`, not a suggestion. Fire real parallel fetches at one DO and assert the
seat maths:

```ts
const stub = doStub(freshEvent());
await call(stub, '/sync', { eventCapacity: 1, perType: { tt_general: { inventory: 1 } } });

const [a, b] = await Promise.all([
  call(stub, '/reserve', { items: seat(1) }),
  call(stub, '/reserve', { items: seat(1) }),
]);

// exactly one wins; the loser reports full
expect([a.body.ok, b.body.ok].filter(Boolean)).toHaveLength(1);
```

Checklist for a new test:

1. unique ids, always;
2. no DDL — the migrations are already applied. Seed rows through
   `test/support/fixtures.ts`, and add a column in `migrations/` if you need one;
3. stub `fetch` for external calls; do not stub the worker's own modules unless the thing
   you are testing genuinely sits above them;
4. assert on the **outbox rows**, not on outbound HTTP, when the behaviour is a write-back.
   The contract is "a row exists in the same batch as the state change";
5. for anything payment shaped, assert the idempotent replay too: run it twice and check
   nothing doubled.

## CI

`.github/workflows/ci.yml`, on push to `main` and on every pull request. Node 22, pnpm,
`--frozen-lockfile`.

| Job and step | Notes |
| --- | --- |
| `check` → migration sequence | `pnpm check:migrations`. First, because it is cheap and independent of the install graph |
| `check` → typecheck | `pnpm typecheck` |
| `check` → test | `pnpm test` |
| `migrations-from-empty` | applies every migration to an empty local D1, proving the sequence still builds the current schema from nothing |

`pnpm lint` is **not** gated yet. Biome reports pre-existing errors across the repo, and a
step that is red from its first run only teaches people to ignore CI. Do not add new lint
errors, and wire the step in once the backlog is clear.

Before pushing, run what CI runs:

```bash
pnpm check:migrations && pnpm typecheck && pnpm test
```
