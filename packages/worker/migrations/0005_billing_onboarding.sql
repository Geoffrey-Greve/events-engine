-- migrations/0005_billing_onboarding.sql
-- Refuel-side billing and tenant onboarding state.
--
-- Two distinct merchant relationships (see CLAUDE.md):
--   1. Refuel charges the tenant for Paddock (refuel_* columns).
--   2. Tenant charges their own event customers (handled via hs_access_token et al).
--
-- Tenant status (already exists) doubles as the publishing gate:
--   installed → trial/preview (publishing gated)
--   active    → publishing enabled
--   past_due  → publishing gated (billing issue)
--   cancelled → publishing gated (uninstalled or subscription cancelled)

-- ---------------------------------------------------------------------------
-- Refuel-side subscription billing (Refuel is the merchant)
-- ---------------------------------------------------------------------------
ALTER TABLE tenants ADD COLUMN refuel_plan TEXT;              -- 'starter'|'growth'|'scale'
ALTER TABLE tenants ADD COLUMN refuel_billing_status TEXT NOT NULL DEFAULT 'trial';
ALTER TABLE tenants ADD COLUMN refuel_hs_deal_id TEXT;        -- deal id in REFUEL's portal
ALTER TABLE tenants ADD COLUMN trial_ends_at TEXT;            -- ISO 8601 UTC

-- ---------------------------------------------------------------------------
-- Tenant event-payment config (tenant's own Stripe↔HubSpot connection)
-- ---------------------------------------------------------------------------
ALTER TABLE tenants ADD COLUMN stripe_processor_connected INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tenants ADD COLUMN xero_gst_rate_id TEXT;         -- HubSpot tax rate id imported from Xero

-- ---------------------------------------------------------------------------
-- Webinar provider credentials (AES-GCM encrypted JSON, same key as OAuth tokens)
-- ---------------------------------------------------------------------------
ALTER TABLE tenants ADD COLUMN webinar_provider TEXT;         -- 'teams' | NULL (in-person only)
ALTER TABLE tenants ADD COLUMN webinar_creds_enc TEXT;        -- encrypted JSON blob

-- ---------------------------------------------------------------------------
-- HubDB dynamic-page tracking
-- ---------------------------------------------------------------------------
ALTER TABLE tenants ADD COLUMN hubdb_dynamic_page_domain TEXT; -- customer CMS domain for the events listing page
