# Isolated development environment

The `dev` environment is a separate Event Engine deployment for the Weld Australia
HubSpot test portal. It must never share data resources, routes, or secrets with
the live Worker or the existing staging environment.

## Resource layout

| Binding | Development resource |
| --- | --- |
| Worker | `event-engine-dev` |
| D1 | `event-engine-db-dev` (new, empty) |
| KV | `event-engine-kv-dev` (new, empty) |
| queue | `event-engine-jobs-dev` |
| dead-letter queue | `event-engine-jobs-dev-dlq` |
| Durable Object | `EVENT_CAPACITY` on the dev Worker |

## Provisioning order

1. Create the D1 database, KV namespace, queues, and Worker in the same Cloudflare
   account as the live service, using the development names above.
2. Record the generated D1 and KV IDs in the `dev` environment section of
   `packages/worker/wrangler.toml`. Do not use the live or staging IDs.
3. Apply the repository migrations to `event-engine-db-dev`.
4. Set development-only Worker secrets. Do not copy live payment, HubSpot, Teams,
   Xero, or webhook secrets unless there is an explicitly approved test equivalent.
   The HubSpot install flow will not start until at least these are set:

   ```sh
   wrangler secret put HUBSPOT_CLIENT_ID --env dev
   wrangler secret put HUBSPOT_CLIENT_SECRET --env dev
   wrangler secret put HUBSPOT_REDIRECT_URI --env dev   # https://event-engine-dev.refuel-creative.workers.dev/oauth/callback
   wrangler secret put TOKEN_ENCRYPTION_KEY --env dev   # 64 hex chars, generated fresh for dev
   ```

   `HUBSPOT_REDIRECT_URI` must match the redirect URL configured on the HubSpot
   developer app exactly. Until they are set, `/oauth/install` and `/oauth/callback`
   answer `503 not_configured` and log the missing names.
5. Deploy a reviewed revision (`main`, or the release tag being tested) to the dev
   Worker and confirm its health endpoint. Do not deploy a local feature branch:
   once it is merged and deleted, a stale copy is indistinguishable from the real thing.
6. Seed only test records after the Worker and database are verified.
7. Point the confirmed HubSpot test portal at the dev Worker only after both sides
   have been reviewed.

## Do not provision an existing-schema tenant

`POST /admin/provision/:portalId` is for a **new** tenant with no HubDB tables. It
creates the `events` and `ticket_types` tables declared in
`packages/shared/src/hubdb.ts`.

Weld is not that. Portal `443253065` already has its own `events` table
(`2209273286`), hand-built, with 25 columns and `useForPages` on, driving the
public event pages. It carries `worker_event_id`, `use_event_engine` and
`ticket_types_json`, which are the bridge to this worker. It shares only its
name with the table the schema declares.

For a tenant like this, record the existing table id against the tenant row and
never run provisioning:

```sh
wrangler d1 execute event-engine-db-dev --env dev --remote --command \
"UPDATE tenants SET hubdb_events_table_id='2209273286' WHERE portal_id='443253065'"
```

Those columns feed the onboarding status display only; nothing reads a tenant's
event rows through them. Provisioning refuses to touch a table whose columns do
not match the declared schema, so a mistaken run fails loudly rather than
bolting a second set of fields onto a tenant's live table.

Weld's ticket types ride on the event row in `ticket_types_json`, so that portal
has no separate ticket_types table and `hubdb_ticket_types_table_id` stays null.

## Safety rules

- Never deploy the `dev` configuration against the live or staging Worker.
- Never bind the dev Worker to a live D1 database, KV namespace, queue, or secret.
- Never copy production bookings, contacts, invoices, or payment data into dev.
- Keep the HubSpot test portal unconnected until the dev Worker passes checks.
