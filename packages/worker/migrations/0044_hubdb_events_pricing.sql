-- migrations/0044_hubdb_events_pricing.sql
-- Extend "HubDB is the source of truth for prices" from the courses table to the EVENTS
-- table, and give a table's per-tier prices a second shape: a DISCOUNT PERCENTAGE.
--
-- 0035 pointed the Worker at the tenant's HubDB course table so a member is charged the
-- number the page quoted them. Events were left on `pricing_rules`, which is a second,
-- separately maintained copy of the same figures, and the tenant has no way of knowing
-- that: they type a member price into the events row in HubDB exactly as they do for a
-- course, and nothing reads it. Weld's live `events` table carries `member_price`,
-- `non_member_price` AND `bronze_discount_` / `silver_discount_` / `gold_discount_`, all
-- entered by hand, none of which has ever priced a booking (QA ref 73).
--
-- There is nothing course-specific about any of the 0035 machinery: it reads a table
-- with an event-id column and some price columns. So this adds a second SOURCE rather
-- than a second code path — `loadHubDbPricingSources` returns the configured tables in
-- order and the resolver takes the first one holding a row for the event. Courses and
-- events are priced by the same function, and a third table later is another row of
-- config, not another branch.
--
-- WHY A DISCOUNT COLUMN AND NOT JUST MORE ABSOLUTE ONES. Because that is how the tenant
-- already entered it. `courses` prices each tier absolutely (`price_gold_aud_ex_gst`);
-- `events` prices the public rate once and states each tier as a percentage off it. Both
-- are legitimate ways to run a price list and we do not get to make Weld re-key one into
-- the other — that would leave two columns per tier per row disagreeing the moment
-- someone edits the wrong one, which is the whole family of fault this path exists to end.
--
-- The percentage comes off the NON-MEMBER price (confirmed with Ryan, 2026-09-20), which
-- is what "Gold members get 20% off" means on a page showing one public figure.
--
-- All columns are nullable. A tenant with none configured keeps the pre-0044 behaviour
-- exactly: courses price from HubDB if 0035 was configured, events price from
-- `pricing_rules`.

-- HubDB table holding one row per bookable EVENT. Same contract as
-- `hubdb_courses_table`: a table id or a name, e.g. 'events'.
ALTER TABLE tenants ADD COLUMN hubdb_events_table TEXT;

-- Column on that table carrying the Event Engine event id. Defaults to
-- 'worker_event_id' when NULL, for the same reason the courses one does: that column
-- holds OUR id, not the tenant's own data, so it is the one name we may guess.
ALTER TABLE tenants ADD COLUMN hubdb_events_event_id_column TEXT;

-- JSON map of canonical member level -> HubDB column holding that level's ABSOLUTE
-- price, plus 'nonMember' for the public column. Required alongside
-- hubdb_events_table, exactly as hubdb_course_price_columns is: these are the tenant's
-- schema and the worker ships no defaults, because a guessed column name reads as "this
-- event has no member price" and drops the buyer onto the stale pricing_rules copy.
-- Weld's events table is:
--   {"member":"member_price","nonMember":"non_member_price"}
ALTER TABLE tenants ADD COLUMN hubdb_event_price_columns TEXT;

-- JSON map of canonical member level -> HubDB column holding that level's PERCENTAGE off
-- the non-member price. Optional on both tables: a source may price absolutely, by
-- discount, or both. An absolute column for the buyer's own level wins over a discount
-- for that same level (it is the more direct statement of the price); a discount for
-- their level wins over the GENERIC `member` column, because their tier is the more
-- specific answer. Weld's events table is:
--   {"gold":"gold_discount_","silver":"silver_discount_","bronze":"bronze_discount_"}
ALTER TABLE tenants ADD COLUMN hubdb_event_discount_columns TEXT;

-- The same, for the courses table. Weld does not use it — courses price every tier
-- absolutely — and it exists so the two sources are genuinely ONE shape rather than one
-- shape with an exception carved out of it. A tenant who prices courses by discount
-- needs no code change.
ALTER TABLE tenants ADD COLUMN hubdb_course_discount_columns TEXT;
