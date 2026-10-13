-- migrations/0038_sales_window.sql
--
-- When a seat stops being for sale. Until now: never.
--
-- Nothing in reserve was time-bounded and nothing could be closed by hand, so a course
-- that finished last week still took public bookings, and the only way to stop selling
-- one was to drop its capacity — which Phase 1.1's guard (correctly) refuses, because a
-- zero capacity is indistinguishable from the placeholder that closed Weld's sales
-- silently in the first place. Two separate ideas, deliberately two columns:
--
--   registration_closes_at — the LAST INSTANT a public booking is accepted. NULL is not
--     "never closes": it resolves to the event's own `starts_at` (see
--     resolveSalesWindow), because a course that has begun is not something the website
--     should still be selling. Stored rather than computed so a tenant can close two
--     weeks early for catering numbers, or leave a walk-up window open an hour past the
--     start. Kept as a column of its own rather than folded into `starts_at` so moving
--     the course date carries its default cutoff along with it.
--
--   sales_paused — a human said stop, now, for a reason the clock does not know: the
--     trainer is sick, the venue is unconfirmed, the price is wrong. Reversible with no
--     loss of information, which is exactly what zeroing the capacity was not. It does
--     NOT touch capacity, so already-confirmed seats keep their denominator and no
--     report starts reading the event as oversold against a total of zero.
--
-- Ticket types carry `sales_paused` too, and only that one. Closing a SINGLE ticket type
-- at a time ("early bird is over") is a real thing a tenant does, and expressing it as a
-- per-type cutoff would be a second date to keep in step with the event's. Early bird
-- ending is a price change, and the tenant makes it by pausing one type and unpausing
-- the next.
--
-- What this does NOT do: commit, release or otherwise touch a seat. A closed or paused
-- event stops SELLING; every hold already out there runs to its own expiry, every
-- confirmed seat stays confirmed, and the invoice against an unpaid hold stays payable.
-- Closing sales is not a cancellation, and the two must not be able to be confused.

-- ISO 8601 UTC, as every timestamp in this schema is. Date-only input ("close on the
-- 20th") is resolved to the last moment of that day in the tenant's display timezone by
-- the write path before it lands here — see resolveRegistrationClosesAt. Storing the
-- instant rather than the local date is what keeps the comparison in reserve a plain
-- string compare against `now`.
ALTER TABLE events ADD COLUMN registration_closes_at TEXT;

ALTER TABLE events       ADD COLUMN sales_paused INTEGER NOT NULL DEFAULT 0
  CHECK (sales_paused IN (0, 1));
ALTER TABLE ticket_types ADD COLUMN sales_paused INTEGER NOT NULL DEFAULT 0
  CHECK (sales_paused IN (0, 1));
