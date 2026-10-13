-- migrations/0046_membership_source_config.sql
-- Make the company, mirror and Find a Member membership sources tenant configuration.
--
-- 0009 and 0012 made the CONTACT's membership status, level and category properties
-- per-tenant. Everything else resolveMembership reads stayed hard-coded to Weld Australia's
-- schema in packages/worker/src/membership.ts: the company property families
-- (`corporate_membership_status` / `corporate_membership_level_2`, then
-- `industry_supplier_membership_status` / `industry_supplier_membership_level_2`), the
-- contact's mirror of its employer (`wa_company_membership_tier` / `_status`, QA Ref 98),
-- and the Find a Member HubDB table (`members`, with `contact_email`, `member_tier`,
-- `is_active` and `hubspot_company_id`). Every portal was asked for Weld's names, which is
-- the "nothing Weld-specific in shared layers" invariant broken four times over, and a
-- second tenant whose employer membership lives anywhere else could never verify a
-- corporate member at all.
--
-- NULL means the source is NOT READ: no request is made, and it answers exactly as a source
-- that returned nothing, the way an unmapped HubDB price column does. There are no built-in
-- names to fall back on, because a default here is Weld's schema under another label.
--
-- `membership_company_sources` is a JSON array, in PRIORITY order, of
-- {"category","statusProperty","levelProperty"}. The first source carrying a status decides;
-- failing that, the first carrying a level. `category` is the canonical one
-- (corporate / industry_supplier / individual) that pricing_rules and HubDB tiers key on.
-- `member_directory_config` is JSON
-- {"table","emailColumn","tierColumn","activeColumn","companyIdColumn"}.
--
-- BACKFILL, so no installed portal changes on deploy. The names above were applied to every
-- portal that exists today, so copying exactly those values into each existing row keeps
-- every one of them reading what it read yesterday. Rows inserted after this migration get
-- NULL and must PATCH /manage/onboarding/membership-config before any of these is read.
--
-- The contact status and level properties are backfilled too, but ONLY where they are NULL.
-- `resolveMembershipProfile` read `individual_membership_status` and
-- `individual_membership_type_2` by name whatever the tenant had configured, and those are
-- the properties the CMS checkout gate reads, so this puts the main resolver in parity with
-- the CMS (the CLAUDE.md parity rule) on a portal that had never said otherwise. A portal
-- that configured its own names keeps them: COALESCE leaves a set value alone.

-- Company membership property families, JSON, priority order. NULL = do not read the company.
ALTER TABLE tenants ADD COLUMN membership_company_sources TEXT;

-- The contact's own copy of its employer's membership status. NULL = not read.
ALTER TABLE tenants ADD COLUMN membership_mirror_status_property TEXT;

-- The contact's own copy of its employer's membership tier. NULL = not read.
ALTER TABLE tenants ADD COLUMN membership_mirror_tier_property TEXT;

-- The Find a Member HubDB directory, JSON. NULL = no directory lookup.
ALTER TABLE tenants ADD COLUMN member_directory_config TEXT;

UPDATE tenants
   SET membership_company_sources = '[{"category":"corporate","statusProperty":"corporate_membership_status","levelProperty":"corporate_membership_level_2"},{"category":"industry_supplier","statusProperty":"industry_supplier_membership_status","levelProperty":"industry_supplier_membership_level_2"}]',
       membership_mirror_status_property = 'wa_company_membership_status',
       membership_mirror_tier_property = 'wa_company_membership_tier',
       member_directory_config = '{"table":"members","emailColumn":"contact_email","tierColumn":"member_tier","activeColumn":"is_active","companyIdColumn":"hubspot_company_id"}',
       membership_status_property = COALESCE(membership_status_property, 'individual_membership_status'),
       membership_level_property = COALESCE(membership_level_property, 'individual_membership_type_2');
