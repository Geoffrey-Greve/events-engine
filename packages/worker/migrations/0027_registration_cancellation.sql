-- migrations/0027_registration_cancellation.sql
-- Phase 3.2: soft-cancel ONE registration out of a booking.
--
-- Everything before this cancelled at ORDER granularity: a refund voided the invoice,
-- flipped orders.status and took every seat on the booking with it. That is the wrong
-- shape for the case Weld actually has — a four-seat corporate booking where one person
-- can no longer come — and there was no way to express it: cancelling the order would
-- have cancelled three colleagues who are still coming.
--
-- Hence a per-registration soft cancel. Soft, not a DELETE, for the same reason the
-- questions table archives rather than deletes: the seat was sold, it appears on an
-- invoice, someone may have attended before cancelling, and last year's attendee list has
-- to still be able to say what happened. The row stays and carries when and why.
--
-- The SEAT is released through the EventCapacity DO (CLAUDE.md: D1 never decrements a
-- counter for capacity). These columns record the fact, they do not perform it — the two
-- readers below are what makes the fact visible:
--   * deriveAttendance (attendance-writeback.ts) folds cancelled_at into `seat_cancelled`,
--     so the seat leaves `confirmed`/`awaitingPayment` in every 2.2 surface at once even
--     though its order is still 'paid' on behalf of the colleagues who remain;
--   * rehydrateFromD1 (do/EventCapacity.ts) subtracts cancelled seats when it rebuilds
--     seat state from D1, so a cold start or an admin rebuild does not re-hold them.
ALTER TABLE registrations ADD COLUMN cancelled_at        TEXT;
-- Free text, staff-supplied ("attendee unwell", "duplicate booking"). Internal, and unlike
-- a staff note (0022) there is exactly one of them: it is the reason THIS seat went away,
-- not a thread about the attendee.
ALTER TABLE registrations ADD COLUMN cancellation_reason TEXT;

-- The reads that care are "the live seats for this event" and "the live seats on this
-- order" — the duplicate-attendee guard, the sibling count that decides whether a
-- cancellation empties its booking, and the capacity rebuild. Partial on purpose: the
-- overwhelming majority of registrations are never cancelled, so indexing only the
-- cancelled ones keeps this small.
CREATE INDEX idx_registrations_cancelled
  ON registrations (portal_id, event_id, cancelled_at)
  WHERE cancelled_at IS NOT NULL;
