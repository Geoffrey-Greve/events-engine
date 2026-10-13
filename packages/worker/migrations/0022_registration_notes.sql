-- migrations/0022_registration_notes.sql
-- Phase 1.3: staff notes on a registration or an order.
--
-- Internal, staff-entered text: "rang to say she'll be late", "invoice going to head
-- office", "third no-show this year". Distinct from anything the attendee supplies, and
-- deliberately kept OUT of every attendee-facing surface — a ticket, an invoice, a
-- confirmation email or the buyer's order-status poll must never carry one.
--
-- Append-only. There is no UPDATE path and no `updated_at`: an edit writes a new row and
-- the old one stands. A note is a record of what staff believed at a moment, and the
-- reason to keep one at all is that someone can go back and read the sequence.
--
-- The only writer of a staff note before this table was the manual-booking form's
-- `staffNote`, which reached a log line and a deal.create payload field nobody read. It
-- now lands here, against the order it was typed about.

CREATE TABLE registration_notes (
  id              TEXT PRIMARY KEY,
  portal_id       TEXT NOT NULL REFERENCES tenants(portal_id),
  registration_id TEXT REFERENCES registrations(id),
  order_id        TEXT REFERENCES orders(id),
  author          TEXT NOT NULL,   -- HubSpot user id, or 'system'
  body            TEXT NOT NULL,
  -- Projection of this row onto HubSpot's standard Note engagement, stamped by the
  -- note.create write-back. NULL means "not mirrored (yet)"; D1 stays the record.
  hubspot_note_id TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  -- A note about nothing is unreadable later. Both may be set (a note about an attendee
  -- on a particular booking); neither may not.
  CHECK (registration_id IS NOT NULL OR order_id IS NOT NULL)
);

-- Both read paths are "every note for this thing, oldest first" — the thread, in order.
CREATE INDEX idx_registration_notes_registration
  ON registration_notes (portal_id, registration_id, created_at)
  WHERE registration_id IS NOT NULL;
CREATE INDEX idx_registration_notes_order
  ON registration_notes (portal_id, order_id, created_at)
  WHERE order_id IS NOT NULL;

-- Whether staff notes are mirrored onto the HubSpot record as a native Note engagement.
-- Same convention as the 0021 contact property mapping: NULL means the sensible default
-- (mirror them), 'off' means the tenant wants notes kept in the worker only.
--
-- A mirrored note uses HubSpot's OWN note object and its own properties (hs_note_body,
-- hs_timestamp, hubspot_owner_id) rather than a custom property, so it lands on the
-- contact/deal timeline where staff already look for internal commentary. That timeline is
-- CRM-internal: it is not on an invoice, a quote, or anything the attendee is sent.
ALTER TABLE tenants ADD COLUMN note_sync_mode TEXT;
