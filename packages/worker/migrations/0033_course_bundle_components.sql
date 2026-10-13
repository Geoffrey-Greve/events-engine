-- migrations/0033_course_bundle_components.sql
--
-- A complete-course order is charged once at the parent-course price, but holds
-- and later confirms one seat in every required child module. This ledger makes
-- those child reservation IDs durable so payment confirmation, expiry, refund,
-- and cancellation can affect the same set together.

CREATE TABLE course_bundle_components (
  id TEXT PRIMARY KEY,
  portal_id TEXT NOT NULL REFERENCES tenants(portal_id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  reservation_id TEXT NOT NULL REFERENCES reservations(id),
  ticket_type_id TEXT NOT NULL REFERENCES ticket_types(id),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'confirmed', 'released', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (order_id, event_id),
  UNIQUE (reservation_id)
);

CREATE INDEX idx_course_bundle_components_order
  ON course_bundle_components (portal_id, order_id, status);

CREATE INDEX idx_course_bundle_components_reservation
  ON course_bundle_components (portal_id, reservation_id, status);
