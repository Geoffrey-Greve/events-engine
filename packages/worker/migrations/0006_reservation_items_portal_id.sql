-- migrations/0006_reservation_items_portal_id.sql
-- Additive: add portal_id to reservation_items.
--
-- The initial schema (0001_init.sql) created reservation_items WITHOUT portal_id, so any
-- database that already ran it is missing the column the reserve handler and the outbox
-- reconciliation sweep now read/write. This forward migration adds it for those databases
-- and is also applied to fresh ones (which is why 0001 intentionally no longer declares it).
--
-- SQLite cannot ADD a NOT NULL column to a possibly-populated table, so the column is added
-- nullable and backfilled from each row's parent reservation. New inserts always supply
-- portal_id explicitly (see routes/reserve.ts), so it is effectively never null going
-- forward. reservation holds are short-lived (15-minute TTL), so the backfill set is small.

ALTER TABLE reservation_items ADD COLUMN portal_id TEXT REFERENCES tenants(portal_id);

UPDATE reservation_items
   SET portal_id = (
     SELECT r.portal_id FROM reservations r WHERE r.id = reservation_items.reservation_id
   )
 WHERE portal_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_res_items_portal      ON reservation_items (portal_id);
CREATE INDEX IF NOT EXISTS idx_res_items_portal_type ON reservation_items (portal_id, ticket_type_id);
