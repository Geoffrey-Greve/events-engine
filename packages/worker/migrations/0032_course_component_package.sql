-- migrations/0032_course_component_package.sql
--
-- A parent-course checkout must know exactly which child events are included in
-- the approved package. Existing children stay individually bookable only until
-- staff explicitly mark them as part of the parent course package. Exams and
-- practicals can therefore remain separate.

ALTER TABLE events ADD COLUMN course_package_required INTEGER NOT NULL DEFAULT 0
  CHECK (course_package_required IN (0, 1));

CREATE INDEX idx_events_parent_package_required
  ON events (portal_id, parent_event_id, course_package_required, course_component_order);
