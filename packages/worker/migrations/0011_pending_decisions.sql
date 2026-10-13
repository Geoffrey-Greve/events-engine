-- migrations/0011_pending_decisions.sql
-- Phase 18.3: human-in-the-loop oversell + waitlist decisions. The worker no longer
-- auto-resolves either; it flags the situation and notifies the event owner, who decides.
-- All timestamps ISO 8601 UTC; every row carries portal_id.

-- Event owner (HubSpot owner id) to assign decision tasks to.
ALTER TABLE events ADD COLUMN hubspot_owner_id TEXT;

-- An open decision awaiting an event-owner choice.
-- orders also gain the logical status 'needs_review' (payment captured, seat NOT
-- committed, awaiting an oversell decision) — orders.status is free text, no DDL needed.
CREATE TABLE pending_decisions (
  id                TEXT PRIMARY KEY,
  portal_id         TEXT NOT NULL REFERENCES tenants(portal_id),
  event_id          TEXT NOT NULL REFERENCES events(id),
  type              TEXT NOT NULL,                  -- 'oversell' | 'waitlist'
  status            TEXT NOT NULL DEFAULT 'open',   -- open | resolved | expired
  order_id          TEXT,                           -- for oversell (the late payment)
  context           TEXT,                           -- JSON: freed seats, waitlist snapshot, amounts
  assigned_owner_id TEXT,                            -- HubSpot owner id (event owner)
  resolved_by       TEXT,
  resolution        TEXT,                            -- JSON: chosen action + target
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  resolved_at       TEXT
);

CREATE INDEX idx_pending_decisions_open  ON pending_decisions (portal_id, event_id, status);
CREATE INDEX idx_pending_decisions_type  ON pending_decisions (portal_id, type, status);
