-- migrations/0035_hubdb_course_pricing.sql
-- Make the tenant's HubDB course table the source of truth for member pricing.
--
-- Until now the CMS quoted member prices from its own HubDB table (Weld's `courses`,
-- columns price_gold_aud_ex_gst / price_silver_aud_ex_gst / …) while the Worker priced
-- the same seat from `pricing_rules` in D1. Nothing kept the two in step, so any event
-- with a missing or stale rule resolved to the standard price, the buyer's quoted
-- amount no longer matched, and reserve rejected the booking with `price_mismatch`
-- (packages/worker/src/routes/reserve.ts). Live portal 441838610 had 11 upcoming events
-- with no pricing rules at all and ragged per-tier coverage on the rest.
--
-- The tenant adds events in HubDB, so HubDB is the price the buyer was shown and the
-- price we must charge. These columns tell the Worker where to read it. `pricing_rules`
-- stays as the fallback for tenants that price in D1 and for when the HubDB read fails.
--
-- All columns are nullable: a tenant with none configured keeps the pre-0035 behaviour.

-- HubDB table holding one row per bookable session. Accepts a table id or a name
-- (HubSpot's rows API takes either), e.g. 'courses'.
ALTER TABLE tenants ADD COLUMN hubdb_courses_table TEXT;

-- Column on that table carrying the Event Engine event id, used to find the row for
-- the event being reserved. Defaults to 'worker_event_id' when NULL.
ALTER TABLE tenants ADD COLUMN hubdb_courses_event_id_column TEXT;

-- JSON map of canonical member level -> HubDB column name, plus the shared fallback
-- columns. REQUIRED alongside hubdb_courses_table: these are the tenant's own schema and
-- the worker ships no defaults for them, because a guessed column name reads as "this
-- course has no member price" in every portal that names things differently. A level with
-- no entry here is simply not read. The example below is Weld's table:
--   {"gold":"price_gold_aud_ex_gst","silver":"price_silver_aud_ex_gst",
--    "bronze":"price_bronze_aud_ex_gst","student":"price_student_aud_ex_gst",
--    "individual":"price_individual","member":"price_member",
--    "nonMember":"price_non_member"}
ALTER TABLE tenants ADD COLUMN hubdb_course_price_columns TEXT;
