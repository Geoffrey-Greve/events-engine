-- migrations/0009_pricing_rules.sql
-- Phase 18.1: tiered member pricing (by membership level + category) and the
-- GST-free tenant tax rate. Replaces the implicit "single price IS the member price"
-- model with explicit, most-specific-wins discount rules.
-- All timestamps ISO 8601 UTC; money integer cents AUD; every row carries portal_id.

-- ---------------------------------------------------------------------------
-- Pricing rules — most-specific wins (ticket_type override > event > portal default),
-- matched on (member_level, member_category). discount_percent applies to the standard
-- price; fixed_price_cents (if set) is an absolute member price that overrides percent.
-- ---------------------------------------------------------------------------
CREATE TABLE pricing_rules (
  id                TEXT    PRIMARY KEY,
  portal_id         TEXT    NOT NULL REFERENCES tenants(portal_id),
  scope             TEXT    NOT NULL,            -- 'portal' | 'event' | 'ticket_type'
  scope_id          TEXT,                        -- event_id or ticket_type_id; NULL for portal
  member_level      TEXT    NOT NULL,            -- canonical level e.g. 'standard','premium','fellow'
  member_category   TEXT    NOT NULL,            -- canonical category e.g. 'corporate','industry_supplier','individual'
  discount_percent  REAL,                        -- applied to standard price; OR
  fixed_price_cents INTEGER,                     -- absolute member price (overrides percent)
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX idx_pricing_rules_lookup ON pricing_rules (portal_id, scope, scope_id);
CREATE INDEX idx_pricing_rules_portal ON pricing_rules (portal_id);

-- ---------------------------------------------------------------------------
-- Tenant membership config: which HubSpot contact properties hold the membership
-- level + category, and the raw HubSpot value → canonical value maps (JSON).
-- NULL property names fall back to the legacy single membership_status behaviour.
-- ---------------------------------------------------------------------------
ALTER TABLE tenants ADD COLUMN membership_level_property TEXT;
ALTER TABLE tenants ADD COLUMN member_category_property  TEXT;
ALTER TABLE tenants ADD COLUMN membership_value_maps     TEXT;   -- JSON: { status, level, category }

-- GST-free tax rate imported from Xero (distinct from the 10% GST rate). Used for
-- ticket types flagged tax_treatment = 'gst_free'.
ALTER TABLE tenants ADD COLUMN xero_gst_free_rate_id TEXT;
