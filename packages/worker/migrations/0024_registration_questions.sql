-- migrations/0024_registration_questions.sql
-- Phase 2.3: custom registration questions per event.
--
-- Dietary requirements is a CASE of this, not a feature of its own, so nothing below
-- names it: the mechanism is generic and the dietary field is seeded through it at the
-- bottom of this file. The next thing Weld asks for (coffee order, dietary, shirt size,
-- ticket-holder's ticket number) is a row, not a migration.
--
-- Two tables and one idea: a question is a DEFINITION owned by the tenant (optionally
-- narrowed to one event) and an answer is a fact recorded against one seat or one booking.
-- Definitions are long-lived and shared; answers are per-registration and immutable.

-- ---------------------------------------------------------------------------
-- Definitions
-- ---------------------------------------------------------------------------
CREATE TABLE registration_questions (
  id            TEXT PRIMARY KEY,
  portal_id     TEXT NOT NULL REFERENCES tenants(portal_id),
  -- NULL = a tenant-wide default asked on every event. A row naming an event overrides
  -- the tenant-wide row with the same `key` (most-specific-first, the same resolution
  -- order pricing_rules uses), so "ask dietary on everything, but word it differently on
  -- the welding intensive" is two rows rather than a per-event copy of the whole set.
  event_id      TEXT REFERENCES events(id),
  -- Stable slug. This is the join key everywhere: the wire contract keys answers by it,
  -- the CSV column is named after it, and an event-level override finds its tenant-wide
  -- parent through it. It is deliberately NOT editable once answers exist (see the route).
  key           TEXT NOT NULL,
  label         TEXT NOT NULL,
  field_type    TEXT NOT NULL,                    -- text|textarea|select|multiselect|checkbox|phone
  -- JSON array of {value,label} for select/multiselect. NULL for every other type.
  options_json  TEXT,
  required      INTEGER NOT NULL DEFAULT 0,
  -- 'attendee' = asked once per seat (dietary, coffee). 'order' = asked once per booking
  -- (purchase order number, who to invoice). The scope decides which column of
  -- registration_answers the answer lands in, and a bulk booking is the case that makes
  -- the distinction matter: four seats, four dietary answers, one PO number.
  scope         TEXT NOT NULL DEFAULT 'attendee', -- 'attendee' | 'order'

  -- ---- Reuse of an existing HubSpot field ---------------------------------
  -- The HubSpot CONTACT property this question is really about. An attendee's dietary
  -- requirements and their coffee order are facts about the PERSON, not about one course:
  -- they are the same in March and in October, and asking again every time is the thing
  -- that makes a registration form tedious. Naming the property here makes the answer
  -- round-trip:
  --   write  — the answer is written back to the attendee's contact through the outbox
  --            (topic contact.sync_answers), so HubSpot holds the current value;
  --   read   — `prefill` says the stored value may be offered back as the default next
  --            time, which is what the CMS module renders and what the staff-side
  --            prefill lookup returns.
  -- NULL keeps the answer inside the worker: correct for anything that is about the
  -- EVENT rather than the person ("which workshop stream", "arriving Thursday night").
  hs_property   TEXT,
  -- Only meaningful with hs_property set. Defaults to 1 because reuse is the reason to
  -- map a property at all; 0 is for a question that maps to a contact property for
  -- reporting but whose answer must be given fresh each time (a per-event consent).
  prefill       INTEGER NOT NULL DEFAULT 1,

  -- Optional sentence under the field. Free text; carried to the front end, never to
  -- HubSpot.
  help_text     TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  -- Archival IS the delete. An archived question stops being asked and keeps every answer
  -- it ever collected readable, which is the whole point: last year's attendee list has to
  -- still show what people answered on a question nobody asks any more.
  archived_at   TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- One LIVE question per key per scope-target. COALESCE, not the bare column: SQLite treats
-- every NULL as distinct in a unique index, so indexing `event_id` directly would let a
-- tenant accumulate any number of tenant-wide questions sharing one key — and the
-- most-specific-first resolution would then pick between them arbitrarily.
--
-- Restricted to live rows so a key can be retired and later reintroduced: archiving
-- 'dietary_requirements' and adding a differently-worded replacement is the supported way
-- to change a question's meaning.
CREATE UNIQUE INDEX idx_registration_questions_key
  ON registration_questions (portal_id, COALESCE(event_id, ''), key)
  WHERE archived_at IS NULL;

-- The read every registration form performs: this event's questions plus the tenant-wide
-- ones, in display order.
CREATE INDEX idx_registration_questions_event
  ON registration_questions (portal_id, event_id, sort_order);

-- ---------------------------------------------------------------------------
-- Answers
-- ---------------------------------------------------------------------------
CREATE TABLE registration_answers (
  id              TEXT PRIMARY KEY,
  portal_id       TEXT NOT NULL REFERENCES tenants(portal_id),
  -- Exactly one of these is set, decided by the question's scope. An attendee-scoped
  -- answer hangs off the registration and follows its fate: the answers are written in the
  -- same D1 batch as the registration itself, are reachable only through it, and a
  -- reservation that expires carries them into the same cancelled state. There is no
  -- separate answer lifecycle to leave orphans behind.
  registration_id TEXT REFERENCES registrations(id),
  order_id        TEXT REFERENCES orders(id),
  question_id     TEXT NOT NULL REFERENCES registration_questions(id),
  -- Every answer is text, whatever the field type. A checkbox stores 'true'/'false' and a
  -- multiselect stores its values joined with ';' — which is HubSpot's OWN encoding for a
  -- multiple-checkbox property, so the write-back is a copy rather than a re-serialisation
  -- that has to agree with HubSpot's parser.
  value_text      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (registration_id IS NOT NULL OR order_id IS NOT NULL)
);

-- One answer per question per target. Reserve is idempotency-key protected, so this is a
-- backstop rather than the primary guard — but an attendee list that showed someone's
-- dietary requirements twice, differently, would be worse than a failed write.
CREATE UNIQUE INDEX idx_registration_answers_unique
  ON registration_answers (
    portal_id, question_id, COALESCE(registration_id, ''), COALESCE(order_id, '')
  );

-- The two read paths: an attendee's answers, and a booking's.
CREATE INDEX idx_registration_answers_registration
  ON registration_answers (portal_id, registration_id)
  WHERE registration_id IS NOT NULL;
CREATE INDEX idx_registration_answers_order
  ON registration_answers (portal_id, order_id)
  WHERE order_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Seed: the dietary question, for every tenant that already exists
-- ---------------------------------------------------------------------------
-- The brief asks for this as a Weld seed. It is written tenant-neutrally on purpose —
-- nothing Weld-specific belongs in a shared layer, and "do you have any dietary
-- requirements" is a question a catered event asks whoever is running it. A tenant that
-- does not want it archives it, which is one PATCH and leaves no orphaned answers.
--
-- Deterministic id so re-running this against a partially-migrated database is a no-op,
-- and so `defaultQuestionStatements()` (which seeds tenants that install LATER) computes
-- the same id and collides harmlessly instead of adding a duplicate.
--
-- hs_property is the standard-ish contact property name a portal creates once; a portal
-- that keys dietary requirements elsewhere edits this row rather than being stuck with it.
-- prefill = 1: this is precisely the answer nobody should have to type twice.
INSERT OR IGNORE INTO registration_questions
  (id, portal_id, event_id, key, label, field_type, options_json,
   required, scope, hs_property, prefill, help_text, sort_order, archived_at)
SELECT
  'rq-' || t.portal_id || '-dietary_requirements',
  t.portal_id,
  NULL,
  'dietary_requirements',
  'Dietary requirements',
  'textarea',
  NULL,
  0,
  'attendee',
  'dietary_requirements',
  1,
  'Let us know about allergies or dietary needs so catering can be arranged.',
  0,
  NULL
FROM tenants t;
