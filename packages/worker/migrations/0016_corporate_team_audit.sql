-- migrations/0016_corporate_team_audit.sql
-- Audit trail for corporate self-service team-management actions.
-- Stores IDs only; HubSpot remains the source of truth for contact/company data.

CREATE TABLE IF NOT EXISTS corporate_team_audit (
  id                 TEXT PRIMARY KEY,
  portal_id          TEXT NOT NULL,
  company_id         TEXT NOT NULL,
  actor_contact_id   TEXT NOT NULL,
  target_contact_id  TEXT NOT NULL,
  action             TEXT NOT NULL,
  outcome            TEXT NOT NULL,
  message            TEXT,
  created_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_corporate_team_audit_company
  ON corporate_team_audit (portal_id, company_id, created_at);

CREATE INDEX IF NOT EXISTS idx_corporate_team_audit_actor
  ON corporate_team_audit (portal_id, actor_contact_id, created_at);
