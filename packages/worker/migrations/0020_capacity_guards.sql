-- migrations/0020_capacity_guards.sql
-- Phase 1.1: capacity guards.
--
-- Capacity itself already works (events.capacity, ticket_types.capacity, the EventCapacity
-- DO). What bit Weld was setup data: placeholder capacities entered during onboarding and
-- never replaced, one of them left at zero, so a course silently closed sales.
--
-- Two changes stop that recurring:
--   1. "Unlimited" becomes an EXPLICIT flag rather than a sentinel value, so the write
--      paths can reject an unset/zero capacity without also breaking genuinely uncapped
--      events. capacity_unlimited = 1 maps to the DO's `null` (uncapped) inventory.
--   2. events.first_published_at records when the event first went live with a valid
--      capacity, which is the clock a suspiciously fast sell-out is measured against.

ALTER TABLE events       ADD COLUMN capacity_unlimited INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ticket_types ADD COLUMN capacity_unlimited INTEGER NOT NULL DEFAULT 0;

-- First moment the event was live with a capacity that passes the guard. Backfilled to
-- created_at: every existing event is long outside the fast-sell-out window, so this can
-- only ever suppress a retrospective false positive, never hide a live one.
ALTER TABLE events ADD COLUMN first_published_at TEXT;
UPDATE events SET first_published_at = created_at WHERE first_published_at IS NULL;

-- At most one fast-sell-out decision per event, ever (resolved ones included — the owner
-- has already looked). Concurrent bookings racing to raise it collide here rather than
-- spamming the owner with duplicate HubSpot tasks.
CREATE UNIQUE INDEX idx_pending_decisions_fast_sellout
  ON pending_decisions (portal_id, event_id)
  WHERE type = 'fast_sellout';
