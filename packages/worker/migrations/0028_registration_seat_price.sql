-- migrations/0028_registration_seat_price.sql
-- Phase 3.3: what each SEAT cost, recorded against the seat.
--
-- Until now the worker recorded what a BOOKING cost. `orders.total_cents`,
-- `orders.voucher_seats_redeemed` and `orders.voucher_credit_cents` are all per-order, and
-- `reservation_items` aggregates by ticket type — so a four-seat booking where vouchers
-- covered two of them is two rows (2 × $0, 2 × $250) that never say WHICH registration each
-- zeroed line belongs to.
--
-- That was fine while the smallest unit of change was the whole booking. Phase 3.2 made a
-- single seat cancellable, and it immediately needed two numbers the schema could not
-- answer:
--
--   1. How much money to give back for THIS seat. 3.2 approximated it as the booking's
--      unrefunded value over its live seats — exact for a one-seat booking, and wrong for a
--      mixed-price group (cancel a member seat out of 2 × $100 + 2 × $200 and the even share
--      refunds $150).
--   2. Whether this seat was paid for with a training voucher, and how much of one. Without
--      it a cancelled voucher seat kept consuming the company's balance forever: usage is
--      summed from the ORDER's redemption columns, the order stays 'paid' on behalf of the
--      colleagues still coming, and nothing else ever moved.
--
-- The three columns below are a DECOMPOSITION of the three order columns, one seat at a
-- time, which is what makes them checkable rather than a second opinion:
--
--   SUM(registrations.unit_cents)      = orders.total_cents
--   SUM(registrations.voucher_seats)   = orders.voucher_seats_redeemed
--   SUM(registrations.voucher_cents)   = orders.voucher_credit_cents
--
-- (over a booking's live seats — a cancellation reduces both sides together, which is
-- exactly the point.)

-- What this seat CONTRIBUTED to the order total: its resolved price after member tiering,
-- or 0 when a voucher covered it or staff comped the booking. Deliberately the CHARGED
-- amount and not the list price — it is the money-refund basis, and a comped seat is not
-- owed its ticket type's price back. Nullable with no default: NULL means "booked before
-- this migration and not recoverable below", which the cancel path reads as "fall back to
-- the booking's even share" rather than as $0.
ALTER TABLE registrations ADD COLUMN unit_cents INTEGER;

-- The seat's share of the order's voucher redemption, in the two units `voucher_mode`
-- takes. Exactly one of them is ever non-zero: 'seat' mode spends one voucher per covered
-- seat whatever it costs, 'credit' mode spends the seat's price. Both default to 0, which
-- is the truth for every booking that redeemed nothing — and, for a booking that DID redeem
-- before this migration, is corrected at cancel time from the order's own totals rather than
-- guessed at here (see the backfill note below).
ALTER TABLE registrations ADD COLUMN voucher_seats INTEGER NOT NULL DEFAULT 0;
ALTER TABLE registrations ADD COLUMN voucher_cents INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- Backfill: unit_cents, from the priced record of what was booked
-- ---------------------------------------------------------------------------
-- `reservation_items` already holds the per-seat price that was actually charged (0013),
-- aggregated into one row per (ticket type, priced-or-voucher-covered). Handing those rows
-- out to the registrations that share their ticket type reproduces the per-seat figure
-- exactly in total, which is the property that matters: a booking's seats still sum to its
-- order total afterwards.
--
-- WHICH seat gets the $0 slot inside one ticket type is arbitrary, and unavoidably so — it
-- is the fact this migration exists because nobody recorded. It is also immaterial: every
-- seat of one ticket type on one booking resolved to the SAME price, so any assignment that
-- honours the quantities is equally true of the money. Slots are handed out cheapest-first
-- to the earliest-created registrations purely so the result is deterministic and a re-run
-- is a no-op.
--
-- The voucher columns are NOT backfilled. Their per-seat split is not recoverable from the
-- aggregate (a $0 line could be a voucher seat or a comp, and under 'credit' mode the
-- covered seat's price was replaced by the zero that hides it), and a plausible-looking
-- guess would hand a company back vouchers it had spent. `cancel.ts` detects the legacy
-- shape — the order redeemed something, its seats record none of it — and falls back to the
-- order's own totals, which are still authoritative.
WITH slots AS (
  SELECT ri.reservation_id                                     AS reservation_id,
         ri.ticket_type_id                                     AS ticket_type_id,
         COALESCE(ri.unit_cents, tt.price_cents, 0)            AS unit_cents,
         -- Half-open slot range [cum_start, cum_end) this line covers within its
         -- (reservation, ticket type) queue.
         SUM(ri.quantity) OVER (
           PARTITION BY ri.reservation_id, ri.ticket_type_id
           ORDER BY COALESCE(ri.unit_cents, tt.price_cents, 0) ASC, ri.id ASC
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         ) - ri.quantity                                       AS cum_start,
         SUM(ri.quantity) OVER (
           PARTITION BY ri.reservation_id, ri.ticket_type_id
           ORDER BY COALESCE(ri.unit_cents, tt.price_cents, 0) ASC, ri.id ASC
           ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
         )                                                     AS cum_end
    FROM reservation_items ri
    LEFT JOIN ticket_types tt ON tt.id = ri.ticket_type_id
),
ranked AS (
  SELECT r.id             AS reg_id,
         o.reservation_id AS reservation_id,
         r.ticket_type_id AS ticket_type_id,
         ROW_NUMBER() OVER (
           PARTITION BY o.reservation_id, r.ticket_type_id
           ORDER BY r.created_at ASC, r.id ASC
         ) AS rn
    FROM registrations r
    JOIN orders o ON o.id = r.order_id
   WHERE o.reservation_id IS NOT NULL
)
UPDATE registrations
   SET unit_cents = (
     SELECT s.unit_cents
       FROM ranked g
       JOIN slots s
         ON s.reservation_id = g.reservation_id
        AND s.ticket_type_id = g.ticket_type_id
        AND g.rn >  s.cum_start
        AND g.rn <= s.cum_end
      WHERE g.reg_id = registrations.id
   )
 WHERE unit_cents IS NULL;
