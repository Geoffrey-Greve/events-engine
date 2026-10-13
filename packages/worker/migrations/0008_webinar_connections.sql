-- migrations/0008_webinar_connections.sql
-- Per-tenant webinar-provider credentials, captured via OAuth (Zoom, Google/Meet,
-- Vimeo, Wistia) or as encrypted API keys (ON24, which has no OAuth).
--
-- Why a table instead of the single tenants.webinar_creds_enc blob:
--   * A tenant may connect more than one provider over time.
--   * OAuth needs access+refresh tokens with independent expiry per provider.
--   * Disconnect = delete one row, no read-modify-write of a shared blob.
--
-- All token/secret material is AES-GCM encrypted with TOKEN_ENCRYPTION_KEY — the
-- SAME key and helpers (encryptToken/decryptToken) used for HubSpot OAuth tokens,
-- so nothing sensitive is ever stored in plaintext (CLAUDE.md multi-tenant +
-- secrets invariants).
CREATE TABLE webinar_connections (
  portal_id          TEXT NOT NULL REFERENCES tenants(portal_id),
  provider           TEXT NOT NULL,              -- 'zoom'|'meet'|'vimeo'|'wistia'|'on24'
  -- OAuth providers: encrypted access/refresh tokens + expiry.
  access_token_enc   TEXT,                       -- AES-GCM; null for key-only providers
  refresh_token_enc  TEXT,                       -- AES-GCM; null if provider issues none
  token_expires_at   TEXT,                       -- ISO 8601 UTC; null = non-expiring
  -- Key-only providers (ON24): encrypted JSON { clientId, tokenKey, tokenSecret }.
  api_creds_enc      TEXT,                       -- AES-GCM
  -- Display/audit only — the authoritative account the token belongs to.
  account_ref        TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (portal_id, provider)
);

CREATE INDEX idx_webinar_connections_portal ON webinar_connections (portal_id);
