-- migrations/0012_membership_status_property.sql
-- Additive: make the membership STATUS contact property tenant-configurable.
--
-- Phase 18.1 (0009_pricing_rules.sql) made the membership LEVEL and CATEGORY properties
-- configurable per tenant, but the STATUS property name stayed hardcoded to
-- 'membership_status' in resolveMembership (packages/worker/src/membership.ts). Tenants
-- whose HubSpot schema exposes membership status under a different property name (e.g.
-- Weld Australia's 'individual_membership_status') can never be resolved as members, so
-- every buyer falls through to the standard (non-member) price.
--
-- This adds the configurable column. resolveMembership falls back to 'membership_status'
-- when it is NULL, so existing tenants keep their current behaviour.

ALTER TABLE tenants ADD COLUMN membership_status_property TEXT;
