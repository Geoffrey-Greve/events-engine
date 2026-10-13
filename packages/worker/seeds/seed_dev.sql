-- seeds/seed_dev.sql
-- Local-dev seed: one test event with two ticket types.
-- Run AFTER the migrations, explicitly:
--   wrangler d1 execute event-engine-db --local --file=seeds/seed_dev.sql
-- NOT a migration, and deliberately outside migrations/: `d1 migrations apply` applies
-- every .sql file in migrations_dir, so while this lived there it was applied as a
-- migration to whatever database the command was pointed at. Do NOT apply to production.

INSERT INTO tenants (portal_id, display_name)
VALUES ('99999999', 'Weld Australia (dev)');

INSERT INTO events (
  id, portal_id, hubspot_event_id,
  title, starts_at, ends_at,
  location, capacity, provider,
  allow_oversell, marketing_event_completed
) VALUES (
  'evt_dev_001', '99999999', 'hs-evt-dev-001',
  'Weld Dev Workshop 2025',
  '2025-08-15T09:00:00Z',
  '2025-08-15T17:00:00Z',
  '123 King William St, Adelaide SA 5000',
  50, NULL,
  0, 0
);

INSERT INTO ticket_types (
  id, portal_id, event_id,
  name, price_cents, currency, capacity,
  tax_treatment, member_only, sort_order
) VALUES
  ('tt_dev_001', '99999999', 'evt_dev_001',
   'Member Early Bird', 9900, 'AUD', 20,
   'gst', 1, 0),
  ('tt_dev_002', '99999999', 'evt_dev_001',
   'General Admission', 14900, 'AUD', 30,
   'gst', 0, 1);
