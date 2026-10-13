-- migrations/0014_crm_writeback_routing.sql
-- CRM write-back routing for Weld's separate Events and Training pipelines.
--
-- `booking_kind` lets the worker distinguish course enrolments from event
-- registrations before creating HubSpot Deals. Existing staging rows are course
-- enrolments, so the safe default is `course`.

ALTER TABLE events ADD COLUMN booking_kind TEXT NOT NULL DEFAULT 'course';
ALTER TABLE events ADD COLUMN hubspot_marketing_event_object_id TEXT;

-- HubSpot Deal routing defaults. Stage IDs can be configured explicitly, but
-- the worker can also resolve stage labels from the pipeline metadata.
ALTER TABLE tenants ADD COLUMN events_pipeline_id TEXT NOT NULL DEFAULT '1012448712';
ALTER TABLE tenants ADD COLUMN events_registered_stage_id TEXT;
ALTER TABLE tenants ADD COLUMN events_registered_stage_label TEXT NOT NULL DEFAULT 'Registered';

ALTER TABLE tenants ADD COLUMN training_pipeline_id TEXT NOT NULL DEFAULT '1874500055';
ALTER TABLE tenants ADD COLUMN training_invoice_sent_stage_id TEXT;
ALTER TABLE tenants ADD COLUMN training_invoice_sent_stage_label TEXT NOT NULL DEFAULT 'Invoice sent';

-- Deal Type property routing. The worker resolves dropdown labels to internal
-- option values and skips the property if the tenant has not configured matching
-- options yet, so Deal creation is not blocked by reporting setup.
ALTER TABLE tenants ADD COLUMN deal_type_property_name TEXT NOT NULL DEFAULT 'dealtype';
ALTER TABLE tenants ADD COLUMN event_deal_type_label TEXT NOT NULL DEFAULT 'Event';
ALTER TABLE tenants ADD COLUMN course_deal_type_label TEXT NOT NULL DEFAULT 'Course';
