-- migrations/0021_attendee_contact_capture.sql
-- Phase 1.2: attendee contact capture (phone, suburb, state).
--
-- registrations only ever carried attendee_email + attendee_name, so the details Weld
-- staff need to run a course — a phone number to call on the morning, the suburb/state
-- for regional reporting — lived nowhere. These three columns capture them at reserve
-- time and are nullable with no backfill: every existing registration keeps NULL, which
-- reads as "never asked", not "answered blank".
--
-- Write-back to the HubSpot contact is DELIBERATELY non-destructive (see 0011's
-- human-in-the-loop precedent): the worker fills a mapped property only where HubSpot
-- holds nothing, and a differing value opens a `contact_conflict` decision for the event
-- owner instead of overwriting. A member's own phone number in HubSpot is more
-- trustworthy than whatever a colleague typed into a bulk booking form.

ALTER TABLE registrations ADD COLUMN attendee_phone  TEXT;
ALTER TABLE registrations ADD COLUMN attendee_suburb TEXT;
ALTER TABLE registrations ADD COLUMN attendee_state  TEXT;

-- Which HubSpot CONTACT properties these three map to, per tenant. Same convention as
-- membership_level_property / member_category_property (0009) and the voucher property
-- names (0018) — including their default behaviour:
--   NULL  -> HubSpot's own standard contact property (phone / city / state). That is where
--            these values belong, and where every HubSpot list, workflow, form and export
--            already looks for them. An Australian address's suburb line IS HubSpot's City.
--   'off' -> the tenant does not want the worker writing that field at all.
--   else  -> the portal keys it somewhere non-standard; use that name.
ALTER TABLE tenants ADD COLUMN contact_phone_property  TEXT;
ALTER TABLE tenants ADD COLUMN contact_suburb_property TEXT;
ALTER TABLE tenants ADD COLUMN contact_state_property  TEXT;

-- A contact_conflict decision is about one registration, so pending_decisions needs to
-- name it: order_id is too coarse (a bulk booking is many attendees under one order).
ALTER TABLE pending_decisions ADD COLUMN registration_id TEXT REFERENCES registrations(id);

-- At most one OPEN contact_conflict per registration. The write-back handler is a queue
-- consumer: a transient failure after the decision is created re-runs the whole handler,
-- and without this an owner collects a duplicate task per retry. Scoped to open rows on
-- purpose — once resolved, a later booking that surfaces a NEW conflicting value should
-- be able to ask again.
CREATE UNIQUE INDEX idx_pending_decisions_contact_conflict
  ON pending_decisions (portal_id, registration_id)
  WHERE type = 'contact_conflict' AND status = 'open';
