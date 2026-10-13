-- migrations/0030_course_components.sql
--
-- A training course can now have separately bookable child events. A child is a
-- teaching module, an exam, or a practical assessment. Each child remains a
-- normal Event Engine event, so it retains the existing event-level capacity,
-- ticket types, pricing, registration, refund, attendance and webinar paths.
--
-- Keeping capacity on each child event deliberately avoids changing the
-- EventCapacity Durable Object's event-wide atomicity invariant. A future
-- whole-course checkout can reserve one seat in each child event as a grouped
-- operation; it must not bypass these child events or their capacity gates.

ALTER TABLE events ADD COLUMN parent_event_id TEXT REFERENCES events(id);

ALTER TABLE events ADD COLUMN course_component_kind TEXT NOT NULL DEFAULT 'standalone'
  CHECK (course_component_kind IN ('standalone', 'module', 'exam', 'practical'));

ALTER TABLE events ADD COLUMN course_component_order INTEGER;

CREATE INDEX idx_events_parent_component
  ON events (portal_id, parent_event_id, course_component_order, starts_at);

CREATE INDEX idx_events_component_kind
  ON events (portal_id, course_component_kind);
