-- migrations/0031_course_component_product.sql
--
-- The Course Modules HubDB table identifies a module by its HubSpot Product ID.
-- Store that same ID on the child Event Engine event so a course page can resolve
-- the correct individually bookable module without inferring it from a title.

ALTER TABLE events ADD COLUMN course_module_product_id TEXT;

-- One scheduled child event per module product within one parent course event.
-- A different course run has a different parent event and can use the same product.
CREATE UNIQUE INDEX idx_events_parent_module_product
  ON events (portal_id, parent_event_id, course_module_product_id)
  WHERE course_module_product_id IS NOT NULL;
