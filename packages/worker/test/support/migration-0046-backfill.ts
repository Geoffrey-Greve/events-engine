/**
 * The backfill statement from `migrations/0046_membership_source_config.sql`.
 *
 * Mirrored for the same reason as `migration-0028-backfill.ts`: it runs once, against every
 * installed portal, and what it copies in is the whole of the "no installed portal changes
 * on deploy" promise. `scripts/check-migrations.mjs` fails CI if this constant and the
 * migration stop agreeing.
 */
export const BACKFILL_0046 = `UPDATE tenants
   SET membership_company_sources = '[{"category":"corporate","statusProperty":"corporate_membership_status","levelProperty":"corporate_membership_level_2"},{"category":"industry_supplier","statusProperty":"industry_supplier_membership_status","levelProperty":"industry_supplier_membership_level_2"}]',
       membership_mirror_status_property = 'wa_company_membership_status',
       membership_mirror_tier_property = 'wa_company_membership_tier',
       member_directory_config = '{"table":"members","emailColumn":"contact_email","tierColumn":"member_tier","activeColumn":"is_active","companyIdColumn":"hubspot_company_id"}',
       membership_status_property = COALESCE(membership_status_property, 'individual_membership_status'),
       membership_level_property = COALESCE(membership_level_property, 'individual_membership_type_2');`;
