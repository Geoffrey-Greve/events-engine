-- migrations/0013_reservation_items_unit_cents.sql
-- Additive: persist the resolved per-seat unit price on each reservation item.
--
-- reservation_items previously stored only quantity. The invoice-rebuild path in
-- hubspot-writeback.ts reconstructs line items from ticket_types.price_cents (the STANDARD
-- price), so a correctly tier-discounted order is rebuilt at full price whenever its
-- original outbox rows are regenerated. Storing the unit price that was actually charged
-- lets the rebuild reproduce the discounted amount.
--
-- Added nullable (SQLite cannot ADD a NOT NULL column to a populated table). New inserts
-- always supply unit_cents (see routes/reserve.ts); readers COALESCE to price_cents for any
-- legacy row.

ALTER TABLE reservation_items ADD COLUMN unit_cents INTEGER;
