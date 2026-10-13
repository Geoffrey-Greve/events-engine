-- migrations/0001_init.sql
-- Initial schema for event-engine.
-- All timestamps: ISO 8601 UTC text. Money: integer cents AUD.
-- Every data row carries portal_id for multi-tenant isolation.

-- ---------------------------------------------------------------------------
-- Tenants (one row per HubSpot portal)
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
  portal_id    TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- ---------------------------------------------------------------------------
-- Events
-- ---------------------------------------------------------------------------
CREATE TABLE events (
  id                        TEXT    PRIMARY KEY,
  portal_id                 TEXT    NOT NULL REFERENCES tenants(portal_id),
  hubspot_event_id          TEXT    NOT NULL,  -- HubSpot marketing event externalEventId
  title                     TEXT    NOT NULL,
  starts_at                 TEXT    NOT NULL,  -- ISO 8601 UTC
  ends_at                   TEXT    NOT NULL,
  location                  TEXT,
  capacity                  INTEGER NOT NULL,
  provider                  TEXT,              -- 'teams' | NULL (in-person)
  -- late-payment oversell behaviour: 0 = auto-refund (default), 1 = force-honour
  allow_oversell            INTEGER NOT NULL DEFAULT 0,
  -- set to 1 once the HubSpot marketing event is marked complete
  marketing_event_completed INTEGER NOT NULL DEFAULT 0,
  -- Microsoft Teams webinar fields (provider = 'teams' only)
  teams_webinar_id          TEXT,
  teams_session_id          TEXT,
  teams_join_url            TEXT,              -- generic (non-personal) join URL
  created_at                TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at                TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (portal_id, hubspot_event_id)
);

CREATE INDEX idx_events_portal        ON events (portal_id);
CREATE INDEX idx_events_starts_at     ON events (starts_at);
CREATE INDEX idx_events_portal_hs     ON events (portal_id, hubspot_event_id);

-- ---------------------------------------------------------------------------
-- Ticket types (price tiers per event, each with its own capacity)
-- ---------------------------------------------------------------------------
CREATE TABLE ticket_types (
  id             TEXT    PRIMARY KEY,
  portal_id      TEXT    NOT NULL REFERENCES tenants(portal_id),
  event_id       TEXT    NOT NULL REFERENCES events(id),
  name           TEXT    NOT NULL,
  price_cents    INTEGER NOT NULL DEFAULT 0,    -- AUD cents
  currency       TEXT    NOT NULL DEFAULT 'AUD',
  capacity       INTEGER NOT NULL,              -- per-ticket-type seat limit
  -- Tax / HubSpot product integration
  tax_treatment  TEXT    NOT NULL DEFAULT 'gst', -- 'gst' | 'exempt'
  member_only    INTEGER NOT NULL DEFAULT 0,    -- 1 = members only
  hs_tax_rate_id TEXT,                          -- HubSpot GST tax-rate id (from Xero import)
  hs_product_id  TEXT,                          -- HubSpot product id for invoice line items
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_ticket_types_event     ON ticket_types (event_id);
CREATE INDEX idx_ticket_types_portal    ON ticket_types (portal_id);

-- ---------------------------------------------------------------------------
-- Reservations (15-minute TTL seat holds; committed only on payment confirm)
-- ---------------------------------------------------------------------------
CREATE TABLE reservations (
  id               TEXT PRIMARY KEY,
  portal_id        TEXT NOT NULL REFERENCES tenants(portal_id),
  event_id         TEXT NOT NULL REFERENCES events(id),
  idempotency_key  TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',  -- pending | confirmed | expired | cancelled
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (portal_id, idempotency_key)
);

CREATE INDEX idx_reservations_event       ON reservations (event_id);
CREATE INDEX idx_reservations_expiry      ON reservations (expires_at) WHERE status = 'pending';
CREATE INDEX idx_reservations_portal_stat ON reservations (portal_id, status);

-- ---------------------------------------------------------------------------
-- Reservation items (one row per ticket type per reservation)
-- ---------------------------------------------------------------------------
-- NOTE: reservation_items.portal_id is added by a later additive migration
-- (0006_reservation_items_portal_id.sql), NOT here. Adding it to this already-shipped
-- initial migration would never reach databases that ran an earlier 0001, and would make
-- 0006's ALTER fail with a duplicate-column error on fresh databases.
CREATE TABLE reservation_items (
  id             TEXT    PRIMARY KEY,
  reservation_id TEXT    NOT NULL REFERENCES reservations(id),
  ticket_type_id TEXT    NOT NULL REFERENCES ticket_types(id),
  quantity       INTEGER NOT NULL CHECK (quantity > 0)
);

CREATE INDEX idx_res_items_reservation  ON reservation_items (reservation_id);
CREATE INDEX idx_res_items_ticket_type  ON reservation_items (ticket_type_id);

-- ---------------------------------------------------------------------------
-- Orders (payment-confirmed; seats are committed here, never at reserve time)
-- ---------------------------------------------------------------------------
CREATE TABLE orders (
  id                 TEXT    PRIMARY KEY,
  portal_id          TEXT    NOT NULL REFERENCES tenants(portal_id),
  event_id           TEXT    NOT NULL REFERENCES events(id),
  reservation_id     TEXT    REFERENCES reservations(id),
  hubspot_invoice_id TEXT,
  hubspot_deal_id    TEXT,
  status             TEXT    NOT NULL DEFAULT 'pending',  -- pending | paid | refunded | cancelled
  buyer_email        TEXT    NOT NULL,
  buyer_name         TEXT    NOT NULL,
  buyer_abn          TEXT,              -- required for invoices >= AUD 1,000
  total_cents        INTEGER NOT NULL DEFAULT 0,
  currency           TEXT    NOT NULL DEFAULT 'AUD',
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_orders_portal        ON orders (portal_id);
CREATE INDEX idx_orders_event         ON orders (event_id);
CREATE INDEX idx_orders_invoice       ON orders (portal_id, hubspot_invoice_id);
CREATE INDEX idx_orders_status        ON orders (portal_id, status);

-- ---------------------------------------------------------------------------
-- Registrations (one per attendee; may differ from buyer)
-- ---------------------------------------------------------------------------
CREATE TABLE registrations (
  id                           TEXT PRIMARY KEY,
  portal_id                    TEXT NOT NULL REFERENCES tenants(portal_id),
  order_id                     TEXT NOT NULL REFERENCES orders(id),
  event_id                     TEXT NOT NULL REFERENCES events(id),
  ticket_type_id               TEXT NOT NULL REFERENCES ticket_types(id),
  hubspot_contact_id           TEXT,
  attendee_email               TEXT NOT NULL,
  attendee_name                TEXT NOT NULL,
  ticket_id                    TEXT,   -- FK to tickets(id), filled after issuance
  -- Teams webinar: stamped at register time so attendance matching is exact
  teams_registration_id        TEXT,
  teams_join_url               TEXT,   -- personal join URL written to contact before invite fires
  -- HubSpot marketing event attendance state sync
  marketing_event_state_synced INTEGER NOT NULL DEFAULT 0,
  created_at                   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at                   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_registrations_order       ON registrations (order_id);
CREATE INDEX idx_registrations_event       ON registrations (event_id);
CREATE INDEX idx_registrations_portal      ON registrations (portal_id);
CREATE INDEX idx_registrations_contact     ON registrations (portal_id, hubspot_contact_id);
CREATE INDEX idx_registrations_teams_regid ON registrations (teams_registration_id)
  WHERE teams_registration_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Tickets (QR / check-in record; id is the QR payload)
-- ---------------------------------------------------------------------------
CREATE TABLE tickets (
  id             TEXT PRIMARY KEY,   -- UUID used as QR code value
  portal_id      TEXT NOT NULL REFERENCES tenants(portal_id),
  registration_id TEXT NOT NULL REFERENCES registrations(id),
  order_id       TEXT NOT NULL REFERENCES orders(id),
  event_id       TEXT NOT NULL REFERENCES events(id),
  ticket_type_id TEXT NOT NULL REFERENCES ticket_types(id),
  status         TEXT NOT NULL DEFAULT 'issued',  -- issued | checked_in | cancelled | voided
  checked_in_at  TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_tickets_registration ON tickets (registration_id);
CREATE INDEX idx_tickets_order        ON tickets (order_id);
CREATE INDEX idx_tickets_event        ON tickets (event_id);
CREATE INDEX idx_tickets_portal       ON tickets (portal_id);

-- ---------------------------------------------------------------------------
-- Waitlist
-- Offers go next-in-line (not notify-all); 30-minute offer TTL.
-- ---------------------------------------------------------------------------
CREATE TABLE waitlist (
  id                 TEXT    PRIMARY KEY,
  portal_id          TEXT    NOT NULL REFERENCES tenants(portal_id),
  event_id           TEXT    NOT NULL REFERENCES events(id),
  ticket_type_id     TEXT    REFERENCES ticket_types(id),  -- NULL = any type
  hubspot_contact_id TEXT,
  email              TEXT    NOT NULL,
  position           INTEGER NOT NULL,
  status             TEXT    NOT NULL DEFAULT 'waiting',   -- waiting | offered | expired | converted | cancelled
  offer_expires_at   TEXT,
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_waitlist_event_pos ON waitlist (event_id, status, position);
CREATE INDEX idx_waitlist_portal    ON waitlist (portal_id);

-- ---------------------------------------------------------------------------
-- Outbox (transactional HubSpot write-backs)
-- State changes + outbox rows are written in the same D1 transaction.
-- Queue drains this table with retry/backoff.
-- ---------------------------------------------------------------------------
CREATE TABLE outbox (
  id                          TEXT    PRIMARY KEY,
  portal_id                   TEXT    NOT NULL REFERENCES tenants(portal_id),
  topic                       TEXT    NOT NULL,   -- e.g. 'hubspot.contact.upsert'
  payload                     TEXT    NOT NULL,   -- JSON
  status                      TEXT    NOT NULL DEFAULT 'pending',  -- pending | processing | delivered | failed | dead
  attempts                    INTEGER NOT NULL DEFAULT 0,
  next_attempt_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  -- frozen at first attempt so retries are idempotent for attendance endpoints
  stable_interaction_datetime TEXT,
  created_at                  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_outbox_drain  ON outbox (status, next_attempt_at)
  WHERE status IN ('pending', 'failed');
CREATE INDEX idx_outbox_portal ON outbox (portal_id);

-- ---------------------------------------------------------------------------
-- Idempotency keys (dedup for external reserve/checkout requests)
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  id              TEXT    PRIMARY KEY,
  portal_id       TEXT    NOT NULL REFERENCES tenants(portal_id),
  key             TEXT    NOT NULL,
  request_hash    TEXT    NOT NULL,
  response_status INTEGER NOT NULL,
  response_body   TEXT    NOT NULL,
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  expires_at      TEXT    NOT NULL,
  UNIQUE (portal_id, key)
);

CREATE INDEX idx_idem_keys_expiry ON idempotency_keys (expires_at);

-- ---------------------------------------------------------------------------
-- Webhook events (provider-level dedup; dedup on provider + provider_event_id)
-- ---------------------------------------------------------------------------
CREATE TABLE webhook_events (
  id                TEXT PRIMARY KEY,
  portal_id         TEXT NOT NULL REFERENCES tenants(portal_id),
  provider          TEXT NOT NULL,              -- 'hubspot' | 'stripe'
  provider_event_id TEXT NOT NULL,
  topic             TEXT NOT NULL,
  payload           TEXT NOT NULL,              -- JSON
  processed_at      TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (provider, provider_event_id)
);

CREATE INDEX idx_webhook_events_portal ON webhook_events (portal_id);

-- ---------------------------------------------------------------------------
-- Unmatched Teams attendance records (queued for manual or automated re-match)
-- ---------------------------------------------------------------------------
CREATE TABLE attendance_unmatched (
  id               TEXT    PRIMARY KEY,
  portal_id        TEXT    NOT NULL REFERENCES tenants(portal_id),
  event_id         TEXT    NOT NULL REFERENCES events(id),
  teams_webinar_id TEXT    NOT NULL,
  display_name     TEXT,
  email            TEXT,
  join_time        TEXT,
  leave_time       TEXT,
  duration_seconds INTEGER,
  raw              TEXT    NOT NULL,  -- JSON original attendance record
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_attendance_unmatched_event  ON attendance_unmatched (event_id);
CREATE INDEX idx_attendance_unmatched_portal ON attendance_unmatched (portal_id);
