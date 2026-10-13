-- migrations/0039_unnamed_seats.sql
--
-- A company books ten seats and supplies the names later. (Ref 74b.)
--
-- There is no new "block" state and no pre-commitment: a block IS an ordinary paid
-- booking. It prices, holds and invoices exactly as any other, so it drops public
-- availability the moment it is placed, through the seat math that already exists. The one
-- thing it does not have is people, and the one thing this migration adds is the ability
-- to say so.
--
--   seat_unnamed — this seat is sold and held but nobody is on it yet. Names arrive
--     through the ordinary Phase 3 amend, one at a time or all at once, and a seat leaves
--     this state the moment it has an email; the seat itself never moves.
--
-- An explicit FLAG rather than a NULL or an empty-string sentinel, for the reason
-- migration 0020 gave for `capacity_unlimited`: a consumer should not have to infer intent
-- from the shape of a value. Every path that does something person-shaped — the Marketing
-- Event write-back, the ticket, the contact write-backs, the duplicate-attendee guard —
-- reads the flag. The stored email and name are '' only because the columns are NOT NULL
-- and four tables carry foreign keys into `registrations`, which makes rebuilding it to
-- drop that constraint a far larger risk than the flag is worth.
ALTER TABLE registrations ADD COLUMN seat_unnamed INTEGER NOT NULL DEFAULT 0
  CHECK (seat_unnamed IN (0, 1));

-- The unnamed seats a staff member still has to chase, per event.
CREATE INDEX idx_registrations_unnamed
  ON registrations (portal_id, event_id)
  WHERE seat_unnamed = 1;

-- ---------------------------------------------------------------------------
-- Who decides when an unpaid invoice is voided
-- ---------------------------------------------------------------------------
-- When a hold lapses with the invoice unpaid, the worker voids that invoice — and a void
-- is terminal in HubSpot (Phase 4.2), so the customer is left with nothing to pay. That is
-- right for a stranger's abandoned checkout and wrong for a company block: the invoice is
-- the commercial instrument the booking IS, and when to cancel one is a decision the
-- tenant's finance team makes, not a timer.
--
--   NULL / 'auto_void'    — what the worker has always done. The default, so no installed
--                           portal changes behaviour on deploy.
--   'manual_review'       — do not void. Open a decision and assign the event owner a task,
--                           and let a human void it (or leave it payable) from there.
--
-- This governs the INVOICE only. The seat still returns to sale when its hold lapses,
-- under either mode: that is already the documented behaviour whenever `hold_ms` runs
-- shorter than the invoice, and a payment landing afterwards still takes the late-payment
-- route into `needs_review`. Holding a seat indefinitely off the back of an unpaid invoice
-- is a different decision and is not this one.
ALTER TABLE tenants ADD COLUMN unpaid_invoice_mode TEXT;
