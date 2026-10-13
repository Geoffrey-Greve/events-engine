/**
 * The backfill statement from `migrations/0028_registration_seat_price.sql`.
 *
 * A one-shot statement that runs once against live data is exactly the thing worth testing,
 * and a test that retypes it only ever proves the retyping works. TypeScript cannot type a
 * `?raw` import of a relative path (ambient module wildcards do not apply to relative
 * specifiers), so the SQL lives here instead and `scripts/check-migrations.mjs` fails CI if
 * the migration file and this constant ever stop agreeing — which is the guarantee the raw
 * import would have given, enforced somewhere it can actually run.
 */
export const BACKFILL_0028 = `WITH slots AS (
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
 WHERE unit_cents IS NULL;`;
