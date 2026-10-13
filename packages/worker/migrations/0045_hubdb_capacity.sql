-- migrations/0045_hubdb_capacity.sql
-- Let the tenant's HubDB row set an event's CAPACITY, the way 0035/0044 let it set price.
--
-- Staff run their timetable in HubDB. When a course needs more seats they change a
-- number there and expect the course to reopen, and nothing read it: `events.capacity`
-- only moved through the app card, so the page said "20 places" while the Event Engine
-- said sold out (QA ref 87, AS1796 Cert 10 and IWS). Two copies of one number, with
-- the one staff actually edit being the one that did nothing: the same fault 0035
-- removed for member prices.
--
-- HubDB decides the NUMBER; the EventCapacity DO still decides every seat. The Worker
-- copies a changed cell into D1 and re-syncs the DO, so lowering a capacity below what
-- has sold makes the event sold out and cancels nobody, and nothing here can oversell.
--
-- The column names are the TENANT's schema and default to nothing, like the price
-- columns: a portal that has not mapped one keeps managing capacity in the app card
-- exactly as before. The mapped column is read as the TOTAL seats; for Weld that is their
-- existing `seats_remaining` column, which staff already use as the course's capacity.

-- HubDB column holding the session's TOTAL seats on the courses table. NULL = do not sync.
ALTER TABLE tenants ADD COLUMN hubdb_courses_capacity_column TEXT;

-- The same for the events table.
ALTER TABLE tenants ADD COLUMN hubdb_events_capacity_column TEXT;

-- When this event's capacity was last read from HubDB. Throttles the public availability
-- read, which the course pages call on every render, to one HubDB read a minute per
-- event. Reserve does not throttle: it is the moment the number has to be right.
ALTER TABLE events ADD COLUMN capacity_synced_at TEXT;
