-- migrations/0034_internal_ticket_types.sql
--
-- Package enrolment tickets reserve module capacity but must never appear as a
-- separate product in public checkout. This flag is generic so it can also be
-- used for staff-only or migration-only ticket types without name conventions.

ALTER TABLE ticket_types ADD COLUMN internal_only INTEGER NOT NULL DEFAULT 0
  CHECK (internal_only IN (0, 1));

CREATE INDEX idx_ticket_types_public
  ON ticket_types (event_id, internal_only, sort_order);
