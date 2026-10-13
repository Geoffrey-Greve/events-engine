# Deployment: D1 Migration + wrangler.toml
**Part of:** event-engine · **Consumer:** Weld Australia (first tenant)

Consolidates every schema fragment scattered across the spec/modules into one migration, plus the worker config that binds D1, the Durable Object, the queue, KV, and cron.

> **Status: reference and runbook.** The migration-convention and renumbering sections are
> current and operationally important. The consolidated schema block and the module map
> below are historical: the numbered files in `packages/worker/migrations/` are what
> actually apply, and [data-model.md](data-model.md) describes the schema as it stands.
> `packages/worker/wrangler.toml` is the live config; the block quoted here is illustrative.

> **Phase 18 additions (applied as separate ordered migrations, not folded into 0001):**
> `0009_pricing_rules.sql` — `pricing_rules` table + tenant membership-config columns
> (`membership_level_property`, `member_category_property`, `membership_value_maps`,
> `xero_gst_free_rate_id`). `0010_refund_transfer.sql` — `refund_policies` + `transfers`
> tables; `events.refund_policy_id` + `events.category`; `orders.refunded_cents`.
> `0011_pending_decisions.sql` — `pending_decisions` table + `events.hubspot_owner_id`
> (orders also use the logical status `needs_review`). The numbered `migrations/` files are
> what actually apply, in order; this consolidated block is reference only.

---

## Migration conventions

One file per change, named `NNNN_snake_case.sql`, four digits, never reused.
`wrangler d1 migrations apply` runs files in **filename order**, so two files sharing a
number have their apply order decided by the rest of the name rather than by intent —
which stays invisible until one of them depends on the other.

`pnpm check:migrations` enforces this and runs in CI. It fails on a duplicate numeric
prefix or a malformed filename, and warns on a gap in the sequence. CI also applies the
whole sequence to an empty local D1 on every PR, so "works on my dev database" is not
enough to merge.

### Renumbering already-applied migrations

D1 tracks applied migrations by **filename** in the `d1_migrations` table. Renaming a file
that a database has already applied makes wrangler treat it as new and re-run it — fine for
an idempotent `CREATE TABLE IF NOT EXISTS` or `UPDATE`, fatal for `ALTER TABLE ADD COLUMN`
(SQLite has no `IF NOT EXISTS` for columns). After a renumber, rewrite the recorded names on
every existing database *before* the next apply:

```sh
wrangler d1 execute event-engine-db-staging --remote \
  --command "UPDATE d1_migrations SET name='0014_crm_writeback_routing.sql' WHERE name='0009_crm_writeback_routing.sql';
             UPDATE d1_migrations SET name='0015_normalize_gst_treatment.sql' WHERE name='0014_normalize_gst_treatment.sql';
             UPDATE d1_migrations SET name='0016_corporate_team_audit.sql'   WHERE name='0014_corporate_team_audit.sql';"
```

Run the same against `event-engine-db` for production. Verify with
`wrangler d1 migrations list <db> --remote` — it should report nothing left to apply.

---

## `migrations/0001_init.sql`

```sql
-- ===== Catalog (mirror of HubDB; worker/DO are capacity authority) =====
CREATE TABLE events (
  id            TEXT PRIMARY KEY,
  portal_id     TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  slug          TEXT NOT NULL,
  title         TEXT NOT NULL,
  starts_at     TEXT NOT NULL,
  ends_at       TEXT NOT NULL,
  timezone      TEXT NOT NULL DEFAULT 'Australia/Adelaide',
  capacity      INTEGER,
  status        TEXT NOT NULL DEFAULT 'draft',
  mode          TEXT NOT NULL DEFAULT 'in_person',
  provider      TEXT,                              -- webinar provider for online/hybrid: 'teams' (MVP); meet/zoom (p2); wistia/on24/vimeo (p3)
  allow_oversell INTEGER NOT NULL DEFAULT 0,        -- per-event honour-late-payment policy
  marketing_event_synced INTEGER NOT NULL DEFAULT 0,
  marketing_event_completed INTEGER NOT NULL DEFAULT 0,
  teams_webinar_id TEXT,
  teams_session_id TEXT,
  teams_join_url   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (portal_id, external_event_id),
  UNIQUE (portal_id, slug)
);

CREATE TABLE ticket_types (
  id            TEXT PRIMARY KEY,
  portal_id     TEXT NOT NULL,
  event_id      TEXT NOT NULL REFERENCES events(id),
  hs_product_id TEXT,
  hs_tax_rate_id TEXT,
  tax_treatment TEXT NOT NULL DEFAULT 'gst',         -- gst | gst_free
  member_only   INTEGER NOT NULL DEFAULT 0,          -- ticket restricted to members
  label         TEXT NOT NULL,
  price_cents   INTEGER NOT NULL DEFAULT 0,
  member_price_cents INTEGER,                        -- superseded by Phase 18.1 pricing_rules
                                                     -- (tiered by level+category); price_cents
                                                     -- is the standard price
  currency      TEXT NOT NULL DEFAULT 'AUD',
  inventory     INTEGER,
  min_per_order INTEGER NOT NULL DEFAULT 1,
  max_per_order INTEGER NOT NULL DEFAULT 10,
  sales_start   TEXT,
  sales_end     TEXT,
  created_at    TEXT NOT NULL
);

-- ===== Reservations / orders / registrations =====
CREATE TABLE reservations (
  id            TEXT PRIMARY KEY,
  portal_id     TEXT NOT NULL,
  event_id      TEXT NOT NULL REFERENCES events(id),
  email         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'held',        -- held|confirmed|expired|released
  expires_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE TABLE reservation_items (
  id            TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL REFERENCES reservations(id),
  ticket_type_id TEXT NOT NULL REFERENCES ticket_types(id),
  qty           INTEGER NOT NULL
);

CREATE TABLE orders (
  id            TEXT PRIMARY KEY,
  portal_id     TEXT NOT NULL,
  event_id      TEXT NOT NULL REFERENCES events(id),
  reservation_id TEXT REFERENCES reservations(id),
  contact_email TEXT NOT NULL,
  hs_contact_id TEXT,
  hs_deal_id    TEXT,
  hs_invoice_id TEXT,
  amount_cents  INTEGER NOT NULL DEFAULT 0,
  currency      TEXT NOT NULL DEFAULT 'AUD',
  status        TEXT NOT NULL DEFAULT 'pending',     -- pending|paid|cancelled|refunded
  payment_ref   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE registrations (
  id            TEXT PRIMARY KEY,
  portal_id     TEXT NOT NULL,
  event_id      TEXT NOT NULL REFERENCES events(id),
  order_id      TEXT REFERENCES orders(id),
  ticket_type_id TEXT NOT NULL REFERENCES ticket_types(id),
  attendee_email TEXT NOT NULL,
  attendee_name TEXT,
  hs_contact_id TEXT,
  teams_registration_id TEXT,
  teams_join_url TEXT,
  state         TEXT NOT NULL DEFAULT 'registered',  -- registered|attended|cancelled|no_show
  marketing_event_state_synced TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE tickets (
  id            TEXT PRIMARY KEY,
  portal_id     TEXT NOT NULL,
  registration_id TEXT NOT NULL REFERENCES registrations(id),
  code          TEXT NOT NULL UNIQUE,
  checked_in_at TEXT,
  checked_in_by TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE waitlist (
  id            TEXT PRIMARY KEY,
  portal_id     TEXT NOT NULL,
  event_id      TEXT NOT NULL REFERENCES events(id),
  ticket_type_id TEXT NOT NULL REFERENCES ticket_types(id),
  email         TEXT NOT NULL,
  qty           INTEGER NOT NULL DEFAULT 1,
  status        TEXT NOT NULL DEFAULT 'waiting',      -- waiting|offered|promoted|expired
  offer_expires_at TEXT,
  position      INTEGER NOT NULL,
  created_at    TEXT NOT NULL
);

-- ===== Reliability: outbox, idempotency, webhook dedup, unmatched attendance =====
CREATE TABLE outbox (
  id            TEXT PRIMARY KEY,
  portal_id     TEXT NOT NULL,
  kind          TEXT NOT NULL,
  target_ref    TEXT NOT NULL,
  payload       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',      -- pending|done|failed
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error    TEXT,
  created_at    TEXT NOT NULL
);
CREATE TABLE idempotency_keys (
  key           TEXT PRIMARY KEY,
  portal_id     TEXT NOT NULL,
  response_json TEXT,
  created_at    TEXT NOT NULL
);
CREATE TABLE webhook_events (
  id            TEXT PRIMARY KEY,
  provider      TEXT NOT NULL,
  received_at   TEXT NOT NULL
);
CREATE TABLE attendance_unmatched (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  portal_id     TEXT, event_id TEXT, email TEXT, raw TEXT, created_at TEXT
);

-- ===== Per-tenant config (or hold in KV/secrets; here for reference) =====
CREATE TABLE tenants (
  portal_id     TEXT PRIMARY KEY,
  hs_app_id     TEXT,
  external_account_id TEXT,
  event_organizer TEXT,
  events_pipeline_id TEXT,
  reserved_stage_id  TEXT,
  -- Graph / Teams
  ms_tenant_id  TEXT,
  ms_client_id  TEXT,
  ms_organizer_user_id TEXT,
  created_at    TEXT NOT NULL
);
-- Secrets (hs token, ms client secret, signing keys) live in Wrangler secrets, NOT here.

CREATE INDEX idx_res_expiry   ON reservations(status, expires_at);
CREATE INDEX idx_outbox_due   ON outbox(status, next_attempt_at);
CREATE INDEX idx_reg_event    ON registrations(event_id, state);
CREATE INDEX idx_reg_synced   ON registrations(state, marketing_event_state_synced);
CREATE INDEX idx_waitlist_pos ON waitlist(event_id, ticket_type_id, status, position);
CREATE INDEX idx_orders_inv   ON orders(hs_invoice_id);
CREATE INDEX idx_orders_paid  ON orders(status, hs_deal_id, hs_invoice_id);
```

Apply: `wrangler d1 migrations apply event-engine-db`

---

## `wrangler.toml`

```toml
name = "event-engine"
main = "src/index.ts"
compatibility_date = "2026-05-01"
compatibility_flags = ["nodejs_compat"]

# --- D1 ---
[[d1_databases]]
binding = "DB"
database_name = "event-engine-db"
database_id = "<your-d1-id>"

# --- Durable Object: the capacity guard ---
[[durable_objects.bindings]]
name = "EVENT_CAPACITY"
class_name = "EventCapacity"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["EventCapacity"]   # SQLite-backed DO storage

# --- Queue: outbox drain + internal jobs ---
[[queues.producers]]
binding = "QUEUE"
queue = "event-engine-jobs"

[[queues.consumers]]
queue = "event-engine-jobs"
max_batch_size = 10
max_retries = 5
dead_letter_queue = "event-engine-dlq"

# --- KV: Graph token + subscription id cache ---
[[kv_namespaces]]
binding = "KV"
id = "<your-kv-id>"

# --- Cron ---
[triggers]
crons = [
  "*/5 * * * *",    # reconciliation sweep
  "0 */12 * * *",   # Graph subscription renewal
  "*/15 * * * *",   # finalize ended webinars (pull attendance + me.complete)
]

# --- Secrets (set via `wrangler secret put`, never in this file) ---
# HS_TOKEN_<portalId>          HubSpot private app token
# MS_CLIENT_SECRET_<tenantId>  Graph app secret
# TICKET_SIGNING_KEY_<portalId>
# CLIENT_STATE_SECRET_<tenantId>
# HUBSPOT_WEBHOOK_SECRET
# DEVICE_TOKEN_SECRET_<portalId>   check-in device tokens; falls back to the ticket key
# EXPORT_TOKEN_SECRET_<portalId>   CSV download tokens (Phase 2.2); falls back to the
#   device-token key, which falls back to the ticket key. Optional — a portal that sets
#   none still signs with a key specific to it, never a shared one. Set a dedicated key
#   to keep a leaked download link from being signed by the same material as a ticket.
#
#
# --- Operator alerting (PLATFORM-level: REFUEL's own channel, not a tenant's) ---
# REFUEL_OPS_SLACK_WEBHOOK_URL   Slack incoming webhook. Optional: unset = no alerts posted
#   and nothing complains, which is what dev wants. Receives the outbox health heartbeat
#   and cron-job failures, suppressed so a standing problem does not repost every 15
#   minutes. Carries portal ids, topics and counts only — never a buyer email, an attendee
#   name or an answer (see src/ops-alert.ts).
#
# --- Webinar provider OAuth (PLATFORM-level: OUR app, one pair per provider; NOT per-tenant) ---
# ZOOM_OAUTH_CLIENT_ID / ZOOM_OAUTH_CLIENT_SECRET
# MEET_OAUTH_CLIENT_ID / MEET_OAUTH_CLIENT_SECRET      (Google app)
# VIMEO_OAUTH_CLIENT_ID / VIMEO_OAUTH_CLIENT_SECRET
# WISTIA_OAUTH_CLIENT_ID / WISTIA_OAUTH_CLIENT_SECRET
# WEBINAR_OAUTH_REDIRECT_BASE  e.g. https://worker.example.com  → /connect/<provider>/callback
# TOKEN_ENCRYPTION_KEY         64 hex chars; encrypts per-tenant webinar tokens at rest
#   Per-tenant webinar credentials are NOT secrets — each customer authorizes our app via
#   GET /connect/<provider>/start and the resulting tokens are stored (encrypted) in the
#   webinar_connections table. ON24 (no OAuth) creds are pasted via the manage API.
```

> Region note (spec §8): D1 and DO placement should target an AU region where available for the member-body data-residency story. Set on database/DO creation.

---

## Env type (shared)

```ts
interface Env {
  DB: D1Database;
  KV: KVNamespace;
  QUEUE: Queue;
  EVENT_CAPACITY: DurableObjectNamespace;
  HUBSPOT_WEBHOOK_SECRET: string;
  // per-tenant secrets resolved by helper from the {prefix}_{id} convention
}
```

---

## Module map (what's built)

| File | Role | Status |
|---|---|---|
| `index.ts` | entry: router + queue + cron | built |
| `event-capacity-do.ts` | Durable Object — atomic seats | built (+refund/force) |
| `registration-flow.ts` | reserve + confirm orchestration | built |
| `teams-attendance.ts` | Graph webinar + attendance pull | built |
| `hubspot-writeback.ts` | outbox → ME/deals/invoices | built |
| `hubspot-contacts-and-finish.ts` | contact upsert, payment URL, refund, oversell | built |
| `waitlist.ts` | join + promote | built |
| `checkin.ts` | QR door app endpoints (spec §12) | built |
| HubDB schema + dynamic pages + module | HubSpot front end | built (markdown) |

All code modules are now built. The `member_only` column on `ticket_types` and a `ticket_types.member_only` flag are used by the membership gate — add `ALTER TABLE ticket_types ADD COLUMN member_only INTEGER NOT NULL DEFAULT 0;` (or include in the table definition). New outbox kinds in use: `contact.set_join_url`, `notify.waitlisted`, `notify.waitlist_offer`, `notify.oversold`, `refund.invoice`, `teams.register_retry`.
```