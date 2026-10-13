-- migrations/0004_tenant_provisioning.sql
-- Tenant provisioning: status machine, OAuth tokens, HubDB table IDs.

ALTER TABLE tenants ADD COLUMN status TEXT NOT NULL DEFAULT 'installed';
ALTER TABLE tenants ADD COLUMN hubdb_events_table_id TEXT;
ALTER TABLE tenants ADD COLUMN hubdb_ticket_types_table_id TEXT;
-- OAuth tokens stored AES-GCM encrypted (base64url), key from TOKEN_ENCRYPTION_KEY secret.
ALTER TABLE tenants ADD COLUMN hs_access_token  TEXT;
ALTER TABLE tenants ADD COLUMN hs_refresh_token TEXT;
ALTER TABLE tenants ADD COLUMN hs_token_expires_at TEXT;  -- ISO 8601 UTC
ALTER TABLE tenants ADD COLUMN installed_at TEXT;
