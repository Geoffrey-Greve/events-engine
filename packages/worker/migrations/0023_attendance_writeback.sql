-- migrations/0023_attendance_writeback.sql
-- Phase 2.1: attendance write-back onto the HubSpot contact.
--
-- Certificates are NOT built here. Ollie's Data Hub flow already renders and delivers
-- membership certificates off a contact property; events feed that same mechanism instead
-- of growing a second renderer, so a member never receives two differently-shaped
-- certificates. This migration adds only the property mapping that flow reads from.
--
-- Three contact properties, same convention as the 0021 contact mapping and the 0018
-- voucher property names:
--   NULL  -> the default property name below (what a portal that has expressed no
--            preference gets; unlike phone/city/state there is no HubSpot STANDARD
--            property for "attended an event", so the default is a named custom one the
--            portal creates once).
--   'off' -> the tenant does not want the worker writing that field at all.
--   else  -> the portal keys it somewhere else; use that name.
--
-- Defaults: event_attended / event_last_attended_date / event_last_attended_name.
--
-- These hold the LATEST attendance, not a history: one contact attends many events and a
-- contact property holds one value. The flag is sticky ("has ever attended"), the date and
-- event name track the most recent attendance, and the write-back never moves the date
-- backwards — a late-draining row for an older event must not overwrite a newer one, or a
-- certificate names the wrong course. The per-event history stays in D1 and is read
-- through GET /api/v1/manage/events/:id/attendance.
ALTER TABLE tenants ADD COLUMN contact_attended_property      TEXT;
ALTER TABLE tenants ADD COLUMN contact_attended_date_property TEXT;
ALTER TABLE tenants ADD COLUMN contact_attended_event_property TEXT;
