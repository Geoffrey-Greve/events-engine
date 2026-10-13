-- migrations/0010_refund_transfer.sql
-- Phase 18.2: per-event refund policy (full / partial / transfer) with category default
-- templates, and the transfer-to-another-attendee capability.
-- All timestamps ISO 8601 UTC; money integer cents AUD; every row carries portal_id.

-- An event resolves its policy: events.refund_policy_id → category-matched default
-- template → portal default template → built-in fallback (full-to-30-days, transfer on).
ALTER TABLE events ADD COLUMN refund_policy_id TEXT;
-- Event category ("team"): used to pick a category default refund template.
ALTER TABLE events ADD COLUMN category TEXT;

-- Records how much of an order has been refunded (full or partial).
ALTER TABLE orders ADD COLUMN refunded_cents INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Refund policy templates.
-- ---------------------------------------------------------------------------
CREATE TABLE refund_policies (
  id                      TEXT    PRIMARY KEY,
  portal_id               TEXT    NOT NULL REFERENCES tenants(portal_id),
  name                    TEXT    NOT NULL,           -- e.g. 'Events default', 'Training default'
  is_default              INTEGER NOT NULL DEFAULT 0, -- 1 = default template for its category/portal
  category                TEXT,                       -- optional: applies to an event category ("team")
  full_refund_cutoff_days INTEGER,                    -- full refund if >= N days before (default 30)
  partial_refund_percent  REAL,                       -- e.g. 50 = 50% after the cutoff; null = none
  allow_transfer          INTEGER NOT NULL DEFAULT 1,
  created_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_refund_policies_portal  ON refund_policies (portal_id);
CREATE INDEX idx_refund_policies_default ON refund_policies (portal_id, is_default, category);

-- ---------------------------------------------------------------------------
-- Transfers — audit of attendee reassignments (seat kept, person changed).
-- ---------------------------------------------------------------------------
CREATE TABLE transfers (
  id              TEXT PRIMARY KEY,
  portal_id       TEXT NOT NULL REFERENCES tenants(portal_id),
  registration_id TEXT NOT NULL,
  from_email      TEXT NOT NULL,
  to_email        TEXT NOT NULL,
  reason          TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_transfers_registration ON transfers (registration_id);
CREATE INDEX idx_transfers_portal       ON transfers (portal_id);
