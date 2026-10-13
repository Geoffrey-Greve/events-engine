-- migrations/0015_invoice_payment_terms.sql
-- Public + corporate paid bookings hold their seat until the HubSpot invoice due date
-- instead of the 15-minute EventCapacity TTL. Buyers who register on the public website
-- and pay later by bank transfer or card had valid invoices voided minutes after booking
-- (AWS D1.1). Migration 0014 shipped the staff-manual half of this; these columns make
-- the payment window configurable per portal and per event.
--
-- Resolution order (most specific first):
--   staff-supplied invoice due date > events.invoice_due_days > tenants.invoice_due_days
--   > built-in 30-day default, capped at 90 days.
-- NULL in both columns means "use the built-in default" — no backfill required.

-- Portal-level default payment terms, in days.
ALTER TABLE tenants ADD COLUMN invoice_due_days INTEGER;

-- Per-event override, in days. Lets a capacity-tight event keep a shorter window
-- than the portal default without a code change.
ALTER TABLE events ADD COLUMN invoice_due_days INTEGER;
