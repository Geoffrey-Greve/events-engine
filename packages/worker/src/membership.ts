import type { MembershipResult, MembershipValueMaps } from '@paddock/shared';
import { getAccessToken } from './hubspot-oauth';
import type { Env } from './types';

export type { MembershipResult };

export type MembershipStatus = 'member' | 'non_member' | 'membership_unverified';

export interface MembershipProfile {
  status: MembershipStatus;
  memberTier: string | null;
  isGoldMember: boolean;
}

interface MemberDirectoryProfile {
  memberTier: string | null;
  found: boolean;
  isActive: boolean;
  isGoldMember: boolean;
}

interface CompanyMembershipProfile {
  status: MembershipStatus;
  /**
   * The company membership status exactly as HubSpot returned it, before
   * normalisation. `resolveMembershipFromEmail` needs the raw label to tell an
   * explicit "no membership" sentinel ("Not Applicable") apart from a genuinely
   * lapsed one, which `status` collapses together as non_member.
   */
  rawStatus: string | null;
  memberTier: string | null;
  /** Inferred from which company membership property fired (corporate vs industry_supplier). */
  category: string | null;
}

export interface ResolveMembershipOptions {
  /**
   * Optional HubSpot Company ID from guest checkout. Re-validated against CRM
   * company membership and/or the tenant's Find a Member directory (its company id
   * column), whichever of the two the tenant has configured.
   * When valid and active, upgrades the buyer to member pricing even if their
   * email is not itself a member contact (the guest company-ID unlock path).
   */
  memberCompanyId?: string;
}

/**
 * Resolves the buyer's membership from HubSpot, tiered by level + category (Phase 18.1).
 *
 * Returns { isMember, verified, level, category }:
 *   verified = false → status not yet cloned from company / contact missing / API error
 *                      (routes to support; distinct from a confirmed non-member).
 *   isMember         → membership_status maps to "member".
 *   level / category → canonical values read from the tenant-configured contact
 *                      properties, mapped raw → canonical via membership_value_maps.
 *
 * Status semantics (Weld defaults, overridable via value maps):
 *   membership_status = "active" | "member" | "current" | … → member
 *   membership_status = "non_member"|"inactive"|"cancelled"|… → non_member
 *   blank / unknown → fall back to associated company, then HubDB members directory;
 *                     still blank → unverified
 *
 * When `opts.memberCompanyId` is set (guest checkout unlock), that company is
 * re-validated server-side and merged with the email-based result so the charged
 * invoice amount can match the member price shown in CMS checkout.
 *
 * Token resolution prefers `HUBSPOT_API_KEY_{portalId}`, then the tenant OAuth token.
 */
export async function resolveMembership(
  env: Env,
  portalId: string,
  buyerEmail: string,
  opts?: ResolveMembershipOptions,
): Promise<MembershipResult> {
  const UNVERIFIED: MembershipResult = {
    isMember: false,
    verified: false,
    level: null,
    category: null,
  };

  const token = await resolveHubSpotReadToken(env, portalId);
  if (!token) return UNVERIFIED;

  const config = await loadMembershipConfig(env, portalId);
  const fromEmail = await resolveMembershipFromEmail(token, buyerEmail, config);
  const fromCompanyId = opts?.memberCompanyId
    ? await resolveMembershipFromCompanyId(token, opts.memberCompanyId, config)
    : null;

  return mergeMembershipResults(fromEmail, fromCompanyId);
}

/**
 * Email / associated-company / HubDB-by-email path. Extracted so guest
 * `memberCompanyId` can be resolved in parallel and merged.
 *
 * The signal rules here are deliberately the same ones the CMS checkout gate applies
 * (weld-aus-hubspot/theme/modules/checkout-tunnel.module/module.html). If the two ever
 * diverge again, the buyer is quoted a member price on the course page and refused at
 * reserve, which is exactly what the "we couldn't verify your membership" reports were.
 */
async function resolveMembershipFromEmail(
  token: string,
  buyerEmail: string,
  config: MembershipConfig,
): Promise<MembershipResult> {
  // Request the (tenant-configurable) status property plus the level/category properties.
  // statusProperty falls back to 'membership_status' for tenants that predate 0012.
  // Always also request associatedcompanyid for company-level fallback.
  // The employer's mirror is only requested when the tenant has mapped it (0046).
  const statusProperty = config.statusProperty || 'membership_status';
  const props = [statusProperty, 'associatedcompanyid'];
  if (config.levelProperty) props.push(config.levelProperty);
  if (config.categoryProperty) props.push(config.categoryProperty);
  if (config.mirrorTierProperty) props.push(config.mirrorTierProperty);
  if (config.mirrorStatusProperty) props.push(config.mirrorStatusProperty);

  const directoryProfile = await resolveMemberDirectoryProfile(
    token,
    buyerEmail,
    config.memberDirectory,
  );

  let resp: Response;
  try {
    resp = await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(buyerEmail)}` +
        `?idProperty=email&properties=${props.map((p) => encodeURIComponent(p)).join(',')}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
  } catch {
    return membershipFromDirectoryFallback(directoryProfile, config);
  }

  // 404 (no contact) or any non-OK response → company unavailable; try HubDB.
  if (resp.status === 404 || !resp.ok) {
    return membershipFromDirectoryFallback(directoryProfile, config);
  }

  const data = (await resp.json()) as {
    id?: string;
    properties?: Record<string, string | undefined>;
  };
  const properties = data.properties ?? {};

  // The employer, found the same two ways the CMS finds it. `associatedcompanyid` is
  // routinely blank on a corporate employee whose contact is linked to the company by an
  // ordinary association and nothing else, and the CMS checkout has traversed that
  // association since the September company-lookup fix. Reading only the property here is
  // what then quoted that employee their employer's Gold rate and refused it at reserve.
  // Neither lookup is worth a request when the tenant maps no company source: there would
  // be nothing to read off the company once found.
  const associatedCompanyId =
    config.companySources.length === 0
      ? null
      : (normalisePropertyString(properties.associatedcompanyid) ??
        (await resolveAssociatedCompanyId(token, normalisePropertyString(data.id))));
  const companyProfile = await resolveCompanyMembershipProfile(
    token,
    associatedCompanyId,
    config.companySources,
  );

  // Scrub the CRM "no membership" sentinels ("Not Applicable", "Non Member", "None", …)
  // before anything reads these. HubSpot stores "no individual membership" as a literal
  // dropdown label, so an unscrubbed read treats the label as a real tier and an
  // unscrubbed status ends the search at the contact instead of falling through to the
  // employer. The CMS has scrubbed them since defect 213
  // (theme/templates/partials/_member-tier.html); the Worker did not, which is half of
  // why corporate employees were quoted a member rate and then refused at reserve.
  const contactRawLevel = config.levelProperty
    ? scrubMembershipSentinel(properties[config.levelProperty])
    : null;
  // The contact's own mirror of its employer's membership, used only where the company
  // record itself said nothing. See `readMirrorProperty` for why the CMS makes this the
  // first thing it reads at checkout.
  const mirrorRawLevel = scrubMembershipSentinel(
    readMirrorProperty(properties, config.mirrorTierProperty),
  );
  const recordRawLevel = scrubMembershipSentinel(companyProfile.memberTier);
  const companyRawLevel = recordRawLevel ?? mirrorRawLevel;

  const contactStatus = resolveStatusSignal(properties[statusProperty], config.valueMaps.status);
  const contactLevel = toCanonicalMemberLevel(contactRawLevel ?? undefined, config.valueMaps.level);
  const contactCategory = config.categoryProperty
    ? toCanonical(
        scrubMembershipSentinel(properties[config.categoryProperty]) ?? undefined,
        config.valueMaps.category,
      )
    : null;
  const recordStatus = resolveStatusSignal(companyProfile.rawStatus, config.valueMaps.status);
  const mirrorStatus = resolveStatusSignal(
    readMirrorProperty(properties, config.mirrorStatusProperty),
    config.valueMaps.status,
  );
  // The record outranks the mirror (the mirror is a synced copy and can lag), exactly as
  // _member-company-resolve.html orders them. A record that says nothing, or only a
  // "no membership" sentinel, leaves the mirror's definite answer standing: the CMS
  // scrubs the sentinel to blank and then keeps the mirror's status.
  const companyStatus =
    (recordStatus === 'blank' || recordStatus === 'none') &&
    (mirrorStatus === 'member' || mirrorStatus === 'inactive')
      ? mirrorStatus
      : recordStatus;
  const companyLevel = toCanonicalMemberLevel(companyRawLevel ?? undefined, config.valueMaps.level);
  // The category belongs to whichever record supplied the tier.
  const companyCategorySource =
    !recordRawLevel && mirrorRawLevel
      ? inferCategoryFromDirectoryTier(mirrorRawLevel, config)
      : companyProfile.category;
  const companyCategory = toCanonical(
    companyCategorySource ?? undefined,
    config.valueMaps.category,
  );
  const directoryTier = inferLevelCategoryFromDirectoryTier(directoryProfile.memberTier, config);
  const crmTier = pickBestCanonicalMemberTier(
    { level: contactLevel, category: contactCategory },
    { level: companyLevel, category: companyCategory },
  );
  const memberTier = crmTier ?? directoryTier;
  const fallbackTier = {
    level: contactLevel ?? companyLevel ?? directoryTier.level,
    category: contactCategory ?? companyCategory ?? directoryTier.category,
  };

  // An explicitly lapsed/expired/cancelled status is a hard no and outranks every other
  // signal, on the contact or on the company. This mirrors the CMS's
  // `not checkout_member_status_is_inactive` term: a lapsed member must not be sold a
  // member-only ticket just because their employer still holds a tier.
  if (contactStatus === 'inactive' || companyStatus === 'inactive') {
    return {
      isMember: false,
      verified: true,
      level: fallbackTier.level,
      category: fallbackTier.category,
    };
  }

  // Any positive membership signal makes them a member. The CMS gate
  // (theme/modules/checkout-tunnel.module/module.html) is the contract here: an active
  // status on the contact OR the company, an active Find a Member row, or a real
  // membership tier on either record. Requiring a status alone, as this did, meant a
  // corporate employee carrying only their employer's Gold tier was quoted the member
  // rate on the course page and then told "we couldn't verify your membership" at
  // checkout.
  const isMember =
    contactStatus === 'member' ||
    companyStatus === 'member' ||
    (directoryProfile.found && directoryProfile.isActive) ||
    Boolean(contactRawLevel) ||
    Boolean(companyRawLevel);
  if (isMember) {
    return {
      isMember: true,
      verified: true,
      level: memberTier.level,
      category: memberTier.category,
    };
  }

  // No positive signal. An explicit "no membership" sentinel, or a directory row that
  // exists but is inactive, is a confirmed non-member: say so, rather than sending a
  // buyer who simply is not a member off to contact support.
  if (contactStatus === 'none' || companyStatus === 'none' || directoryProfile.found) {
    return {
      isMember: false,
      verified: true,
      level: fallbackTier.level,
      category: fallbackTier.category,
    };
  }

  // Nothing said anything at all: genuinely unverified, route to support.
  return { isMember: false, verified: false, level: null, category: null };
}

/**
 * Re-validate a guest-entered company ID the same way CMS checkout previews it:
 * CRM company membership properties and/or an active Find a Member directory row whose
 * company id column matches. Returns unverified when the ID is absent/invalid
 * or neither source confirms an active member company.
 */
async function resolveMembershipFromCompanyId(
  token: string,
  memberCompanyId: string,
  config: MembershipConfig,
): Promise<MembershipResult> {
  const id = memberCompanyId.trim();
  // Mirror CMS validateMemberCompany: only plain integer HubSpot company IDs.
  if (!/^\d+$/.test(id)) {
    return { isMember: false, verified: false, level: null, category: null };
  }

  const [crm, directory] = await Promise.all([
    resolveCompanyMembershipProfile(token, id, config.companySources),
    resolveMemberDirectoryByCompanyId(token, id, config.memberDirectory),
  ]);

  if (crm.status === 'member') {
    const crmTier = {
      level: toCanonicalMemberLevel(crm.memberTier ?? undefined, config.valueMaps.level),
      category: toCanonical(crm.category ?? undefined, config.valueMaps.category),
    };
    const directoryTier = inferLevelCategoryFromDirectoryTier(directory.memberTier, config);
    const resolvedTier = pickBestCanonicalMemberTier(crmTier, directoryTier) ?? crmTier;
    return {
      isMember: true,
      verified: true,
      level: resolvedTier.level,
      category: resolvedTier.category,
    };
  }

  // HubDB is what the public checkout preview uses, so honour an active directory
  // row even when CRM company props are blank/unverified (common for directory-
  // only sync). CRM `non_member` still wins so a lapsed company cannot unlock.
  if (directory.found && directory.isActive && crm.status !== 'non_member') {
    const fromDirectory = inferLevelCategoryFromDirectoryTier(directory.memberTier, config);
    return {
      isMember: true,
      verified: true,
      level: fromDirectory.level,
      category: fromDirectory.category,
    };
  }

  if (crm.status === 'non_member') {
    return {
      isMember: false,
      verified: true,
      level: toCanonicalMemberLevel(crm.memberTier ?? undefined, config.valueMaps.level),
      category: toCanonical(crm.category ?? undefined, config.valueMaps.category),
    };
  }

  return { isMember: false, verified: false, level: null, category: null };
}

/**
 * Merge email-based membership with an optional guest company-ID unlock.
 * Company ID can upgrade a non-member/unverified guest to member pricing and
 * fill missing level/category on an already-verified member. It never downgrades
 * a verified contact member to non-member.
 */
function mergeMembershipResults(
  fromEmail: MembershipResult,
  fromCompanyId: MembershipResult | null,
): MembershipResult {
  if (!fromCompanyId) return fromEmail;

  if (fromCompanyId.isMember && fromCompanyId.verified) {
    if (!fromEmail.isMember) {
      return fromCompanyId;
    }
    const resolvedTier = pickBestCanonicalMemberTier(
      { level: fromEmail.level, category: fromEmail.category },
      { level: fromCompanyId.level, category: fromCompanyId.category },
    ) ?? {
      level: fromEmail.level ?? fromCompanyId.level,
      category: fromEmail.category ?? fromCompanyId.category,
    };
    return {
      isMember: true,
      verified: true,
      level: resolvedTier.level,
      category: resolvedTier.category,
    };
  }

  // Company path didn't unlock, but still let it fill tier gaps on a contact member.
  if (fromEmail.isMember && fromEmail.verified) {
    const resolvedTier = pickBestCanonicalMemberTier(
      { level: fromEmail.level, category: fromEmail.category },
      { level: fromCompanyId.level, category: fromCompanyId.category },
    ) ?? {
      level: fromEmail.level ?? fromCompanyId.level,
      category: fromEmail.category ?? fromCompanyId.category,
    };
    return {
      isMember: true,
      verified: true,
      level: resolvedTier.level,
      category: resolvedTier.category,
    };
  }

  // Prefer a verified company determination (e.g. lapsed CRM company) over an
  // unverified guest email, so reserve/price_drift logs stay accurate.
  if (fromCompanyId.verified && !fromEmail.verified) {
    return fromCompanyId;
  }

  return fromEmail;
}

/**
 * Resolve the buyer's membership status plus their member directory tier.
 *
 * Tier precedence is the strongest live CRM tier across contact + associated
 * CRM company, then the tenant's Find a Member directory as a final fallback. That
 * keeps checkout in sync with the HubSpot-rendered course cards without trusting
 * browser-submitted pricing. Used for gold-duplicate overrides.
 *
 * Reads the same tenant mapping as `resolveMembership`. It used to ask every portal for
 * Weld's `individual_membership_status` / `individual_membership_type_2` by name, whatever
 * the tenant had configured; 0046 backfilled those names into the config of every portal
 * that had not set its own, so no installed portal reads anything different.
 */
export async function resolveMembershipProfile(
  env: Env,
  portalId: string,
  buyerEmail: string,
): Promise<MembershipProfile> {
  const token = await resolveHubSpotReadToken(env, portalId);
  if (!token) {
    return unverifiedProfile();
  }

  const config = await loadMembershipConfig(env, portalId);
  const statusProperty = config.statusProperty || 'membership_status';
  const props = [statusProperty, 'associatedcompanyid'];
  if (config.levelProperty) props.push(config.levelProperty);

  const directoryProfile = await resolveMemberDirectoryProfile(
    token,
    buyerEmail,
    config.memberDirectory,
  );
  const fallbackStatus = statusFromDirectoryProfile(directoryProfile);

  let resp: Response;
  try {
    resp = await fetch(
      `https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(buyerEmail)}` +
        `?idProperty=email&properties=${props.map((p) => encodeURIComponent(p)).join(',')}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
  } catch {
    return {
      status: fallbackStatus,
      memberTier: directoryProfile.memberTier,
      isGoldMember: directoryProfile.isGoldMember,
    };
  }

  if (resp.status === 404 || !resp.ok) {
    return {
      status: fallbackStatus,
      memberTier: directoryProfile.memberTier,
      isGoldMember: directoryProfile.isGoldMember,
    };
  }

  const data = (await resp.json()) as {
    properties?: Record<string, string | undefined>;
  };
  const properties = data.properties ?? {};
  const contactTier = config.levelProperty
    ? normalisePropertyString(properties[config.levelProperty])
    : null;
  const companyProfile = await resolveCompanyMembershipProfile(
    token,
    properties.associatedcompanyid,
    config.companySources,
  );
  const crmTier = pickBestMemberTierLabel(contactTier, companyProfile.memberTier);
  const resolvedTier = crmTier ?? directoryProfile.memberTier;
  const resolvedIsGoldMember =
    isGoldTier(resolvedTier) || (!crmTier && directoryProfile.isGoldMember);

  const raw = normalisePropertyString(properties[statusProperty]);

  if (!raw || raw === '') {
    if (companyProfile.status !== 'membership_unverified') {
      return {
        status: companyProfile.status,
        memberTier: resolvedTier,
        isGoldMember: resolvedIsGoldMember,
      };
    }
    return {
      status: fallbackStatus,
      memberTier: resolvedTier,
      isGoldMember: resolvedIsGoldMember,
    };
  }
  const normalizedStatus = normalizeMembershipStatus(raw);
  if (normalizedStatus === 'member') {
    return {
      status: 'member',
      memberTier: resolvedTier,
      isGoldMember: resolvedIsGoldMember,
    };
  }
  if (normalizedStatus === 'non_member') {
    return {
      status: 'non_member',
      memberTier: resolvedTier,
      isGoldMember: resolvedIsGoldMember,
    };
  }

  return {
    status:
      companyProfile.status !== 'membership_unverified' ? companyProfile.status : fallbackStatus,
    memberTier: resolvedTier,
    isGoldMember: resolvedIsGoldMember,
  };
}

export async function resolveHubSpotReadToken(env: Env, portalId: string): Promise<string | null> {
  // getAccessToken already prefers the per-portal static token over OAuth.
  try {
    return await getAccessToken(env, portalId);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The canonical membership categories a company source may declare. The same three
 * `pricing_rules.member_category` and the HubDB tier columns key on, so a source can only
 * ever name a category something downstream will match.
 */
export const MEMBER_CATEGORIES = ['corporate', 'industry_supplier', 'individual'] as const;
export type MemberCategory = (typeof MEMBER_CATEGORIES)[number];

/**
 * One family of company membership properties (0046). A portal can hold more than one kind
 * of company membership (Weld has corporate and industry supplier), each in its own pair of
 * properties, so the sources are a LIST in priority order rather than one mapping.
 */
export interface CompanyMembershipSource {
  category: MemberCategory;
  statusProperty: string;
  /** null = this family states a status only, with no tier to price by. */
  levelProperty: string | null;
}

/** The tenant's Find a Member HubDB directory (0046): its table and the columns read off it. */
export interface MemberDirectoryConfig {
  /** HubDB table name or id. */
  table: string;
  emailColumn: string;
  tierColumn: string;
  activeColumn: string;
  companyIdColumn: string;
}

export interface MembershipConfig {
  statusProperty: string | null;
  levelProperty: string | null;
  categoryProperty: string | null;
  valueMaps: MembershipValueMaps;
  /**
   * Company property families, priority order. Empty = the company record is never read,
   * which answers exactly as a company that said nothing.
   */
  companySources: CompanyMembershipSource[];
  /** The contact's mirror of its employer. null = not read. */
  mirrorStatusProperty: string | null;
  mirrorTierProperty: string | null;
  /** null = no directory lookup at all. */
  memberDirectory: MemberDirectoryConfig | null;
}

/**
 * A HubSpot property, HubDB table or HubDB column name as the tenant config may hold it.
 * Internal names are letters, digits and underscores; anything else is a label pasted in
 * where a name belongs, and would only ever be asked for and found missing.
 */
const CONFIG_NAME = /^[A-Za-z0-9_]{1,100}$/;

export function isConfigName(value: unknown): value is string {
  return typeof value === 'string' && CONFIG_NAME.test(value);
}

/**
 * Validate a company source list. Returns null for anything that is not exactly the
 * documented shape, so the loader and the PATCH agree about what counts as configured:
 * a list that is half right is refused at the door and read as not configured if it ever
 * reaches D1 some other way. Never a partial list, because silently dropping one family
 * would stop that family's members verifying with nothing to say why.
 */
export function parseCompanySources(raw: unknown): CompanyMembershipSource[] | null {
  if (!Array.isArray(raw)) return null;
  const sources: CompanyMembershipSource[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null;
    const { category, statusProperty, levelProperty } = entry as Record<string, unknown>;
    if (!MEMBER_CATEGORIES.includes(category as MemberCategory)) return null;
    if (!isConfigName(statusProperty)) return null;
    if (levelProperty != null && !isConfigName(levelProperty)) return null;
    sources.push({
      category: category as MemberCategory,
      statusProperty,
      levelProperty: (levelProperty as string | null | undefined) ?? null,
    });
  }
  return sources;
}

/** Validate a directory config. null for anything but the full documented shape. */
export function parseMemberDirectoryConfig(raw: unknown): MemberDirectoryConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { table, emailColumn, tierColumn, activeColumn, companyIdColumn } = raw as Record<
    string,
    unknown
  >;
  if (
    !isConfigName(table) ||
    !isConfigName(emailColumn) ||
    !isConfigName(tierColumn) ||
    !isConfigName(activeColumn) ||
    !isConfigName(companyIdColumn)
  ) {
    return null;
  }
  return { table, emailColumn, tierColumn, activeColumn, companyIdColumn };
}

/** JSON text from D1 → parsed, or undefined when absent or malformed. */
function parseJsonColumn(raw: string | null | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

type MembershipConfigRow = {
  membership_status_property: string | null;
  membership_level_property: string | null;
  member_category_property: string | null;
  membership_value_maps: string | null;
  membership_company_sources?: string | null;
  membership_mirror_status_property?: string | null;
  membership_mirror_tier_property?: string | null;
  member_directory_config?: string | null;
};

const BASE_MEMBERSHIP_COLUMNS =
  'membership_status_property, membership_level_property, member_category_property, membership_value_maps';
const SOURCE_MEMBERSHIP_COLUMNS =
  'membership_company_sources, membership_mirror_status_property, membership_mirror_tier_property, member_directory_config';

function logMembershipConfigUnreadable(portalId: string, err: unknown, columns: string): void {
  console.error(
    JSON.stringify({
      level: 'warn',
      event: 'membership_config_unreadable',
      portalId,
      columns,
      message: err instanceof Error ? err.message : String(err),
    }),
  );
}

export async function loadMembershipConfig(env: Env, portalId: string): Promise<MembershipConfig> {
  // Reading tenant config must never be able to fail a booking: against a tenants table
  // that predates a migration this query throws "no such column", and - before this guard -
  // that propagated out of reserve as an unhandled 500, blocking checkout entirely. So the
  // read steps down: every column, then the 0012 set alone (a database not yet at 0046
  // keeps its contact mapping and reads no other source), then the built-in defaults,
  // which are the same ones used when a tenant has no config.
  let row: MembershipConfigRow | null = null;
  try {
    row = await env.DB.prepare(
      `SELECT ${BASE_MEMBERSHIP_COLUMNS}, ${SOURCE_MEMBERSHIP_COLUMNS} FROM tenants WHERE portal_id = ?1`,
    )
      .bind(portalId)
      .first<MembershipConfigRow>();
  } catch (err) {
    logMembershipConfigUnreadable(portalId, err, 'membership_sources');
    try {
      row = await env.DB.prepare(
        `SELECT ${BASE_MEMBERSHIP_COLUMNS} FROM tenants WHERE portal_id = ?1`,
      )
        .bind(portalId)
        .first<MembershipConfigRow>();
    } catch (baseErr) {
      logMembershipConfigUnreadable(portalId, baseErr, 'membership_contact');
      return emptyMembershipConfig();
    }
  }

  let valueMaps: MembershipValueMaps = {};
  if (row?.membership_value_maps) {
    try {
      valueMaps = JSON.parse(row.membership_value_maps) as MembershipValueMaps;
    } catch {
      // Malformed config → fall back to built-in defaults.
    }
  }

  return {
    statusProperty: row?.membership_status_property ?? null,
    levelProperty: row?.membership_level_property ?? null,
    categoryProperty: row?.member_category_property ?? null,
    valueMaps,
    // Malformed JSON reads as not configured: nothing is read, rather than a guess.
    companySources: parseCompanySources(parseJsonColumn(row?.membership_company_sources)) ?? [],
    mirrorStatusProperty: configNameOrNull(row?.membership_mirror_status_property),
    mirrorTierProperty: configNameOrNull(row?.membership_mirror_tier_property),
    memberDirectory: parseMemberDirectoryConfig(parseJsonColumn(row?.member_directory_config)),
  };
}

function configNameOrNull(value: string | null | undefined): string | null {
  return isConfigName(value) ? value : null;
}

function emptyMembershipConfig(): MembershipConfig {
  return {
    statusProperty: null,
    levelProperty: null,
    categoryProperty: null,
    valueMaps: {},
    companySources: [],
    mirrorStatusProperty: null,
    mirrorTierProperty: null,
    memberDirectory: null,
  };
}

function membershipFromDirectoryFallback(
  directoryProfile: MemberDirectoryProfile,
  config: MembershipConfig,
  contactLevel: string | null = null,
  contactCategory: string | null = null,
): MembershipResult {
  const status = statusFromDirectoryProfile(directoryProfile);
  if (status === 'membership_unverified') {
    return { isMember: false, verified: false, level: null, category: null };
  }
  const fromDirectory = inferLevelCategoryFromDirectoryTier(directoryProfile.memberTier, config);
  return {
    isMember: status === 'member',
    verified: true,
    level: contactLevel ?? fromDirectory.level,
    category: contactCategory ?? fromDirectory.category,
  };
}

type CanonicalMemberTier = {
  level: string | null;
  category: string | null;
};

const MEMBER_LEVEL_RANK: Record<string, number> = {
  member: 10,
  individual: 20,
  student: 30,
  bronze: 40,
  silver: 50,
  gold: 60,
};

function memberLevelRank(canonicalLevel: string | null): number {
  if (!canonicalLevel) return 0;
  return MEMBER_LEVEL_RANK[canonicalLevel] ?? 0;
}

function pickBestCanonicalMemberTier(...tiers: CanonicalMemberTier[]): CanonicalMemberTier | null {
  let best: CanonicalMemberTier | null = null;
  let bestRank = 0;
  for (const tier of tiers) {
    const rank = memberLevelRank(tier.level);
    if (rank > bestRank) {
      best = tier;
      bestRank = rank;
    }
  }
  return best;
}

function pickBestMemberTierLabel(...tiers: Array<string | null>): string | null {
  let best: string | null = null;
  let bestRank = 0;
  for (const tier of tiers) {
    const trimmed = normalisePropertyString(tier);
    const canonical = toCanonicalMemberLevel(trimmed ?? undefined, undefined);
    const rank = memberLevelRank(canonical);
    if (trimmed && rank > bestRank) {
      best = trimmed;
      bestRank = rank;
    }
  }
  return best;
}

/**
 * Map a Find a Member directory tier label (Gold / Silver / …) onto the
 * canonical (level, category) pair pricing_rules expects. Directory rows are
 * company memberships, so Gold/Silver/Bronze → corporate; Industry Supplier
 * and Reciprocal keep their own category.
 */
function inferLevelCategoryFromDirectoryTier(
  memberTier: string | null,
  config: MembershipConfig,
): { level: string | null; category: string | null } {
  return {
    level: toCanonicalMemberLevel(memberTier ?? undefined, config.valueMaps.level),
    category: inferCategoryFromDirectoryTier(memberTier, config),
  };
}

function inferCategoryFromDirectoryTier(
  memberTier: string | null,
  config: MembershipConfig,
): string | null {
  if (!memberTier) return null;
  const label = memberTier.trim().toLowerCase();
  if (!label) return null;

  // Prefer an explicit value-map hit on the raw tier label first.
  const mapped = toCanonical(memberTier, config.valueMaps.category);
  if (
    mapped &&
    (mapped === 'corporate' ||
      mapped === 'industry_supplier' ||
      mapped === 'individual' ||
      mapped === 'reciprocal')
  ) {
    return mapped;
  }

  if (label.includes('industry')) return 'industry_supplier';
  if (label.includes('reciprocal')) return 'reciprocal';
  if (label.includes('individual')) return 'individual';
  // Gold / Silver / Bronze / Corporate * → corporate member company.
  if (
    label.includes('gold') ||
    label.includes('silver') ||
    label.includes('bronze') ||
    label.includes('corporate')
  ) {
    return 'corporate';
  }
  return 'corporate';
}

/**
 * The contact-level mirror of the employer's membership, written onto the contact by the
 * tenant's company-to-contact sync.
 *
 * The CMS checkout reads these FIRST (checkout-tunnel.module and
 * _member-company-resolve.html), and on the checkout page they are close to the only CRM
 * company signal it has: that page is deliberately ungated for guest checkout, and HubSpot
 * returns an empty record from `crm_object` on an ungated page, so the company lookup the
 * module goes on to attempt comes back with nothing. A corporate employee whose mirror
 * says "Corporate Silver" but whose company is not reachable by `associatedcompanyid` or
 * an association was therefore quoted the member rate there and refused here with
 * `membership_unverified` (QA Ref 98): a signal the CMS counts and the worker could not
 * see.
 *
 * The property names are the tenant's (`membership_mirror_status_property` /
 * `membership_mirror_tier_property`, 0046); Weld's `wa_company_membership_*` pair is
 * backfilled for the portals installed before then. Unmapped reads as a mirror that says
 * nothing, and either way it is only a fallback for a company record that says nothing.
 */
function readMirrorProperty(
  properties: Record<string, string | undefined>,
  property: string | null,
): string | undefined {
  return property ? properties[property] : undefined;
}

/**
 * The CRM "no membership" sentinels. HubSpot stores the absence of a membership as a
 * literal dropdown label rather than an empty cell, so these must be collapsed to blank
 * before any tier or status is read.
 *
 * Kept identical to the CMS list in
 * weld-aus-hubspot/theme/templates/partials/_member-tier.html (macro `is_real_tier`).
 * Adding a value on one side without the other reintroduces exactly the split that had
 * the same buyer quoted a member price on the course page and refused at checkout.
 */
const MEMBERSHIP_SENTINELS = new Set([
  'not_applicable',
  'non_member',
  'nonmember',
  'never_member',
  'none',
  'n/a',
]);

/**
 * How a membership status property reads, with the four outcomes the checkout gate needs
 * to tell apart:
 *
 *   'member'   = active / current / grace / honorary. They are a member.
 *   'inactive' = lapsed / expired / cancelled. A hard no that outranks every other
 *                signal, including their employer's tier.
 *   'none'     = a "no membership" sentinel ("Not Applicable", "Non Member"). Not a
 *                member in their own right, but keep looking: this is how HubSpot marks
 *                a corporate employee who holds no individual membership.
 *   'blank'    = empty or unrecognised. Says nothing either way.
 *
 * Collapsing 'none' into 'inactive' (which a plain non_member mapping does) is what
 * stopped the employer lookup and charged corporate employees the public rate.
 *
 * A tenant's own `membership_value_maps` entry always wins: if a portal has explicitly
 * mapped a value, that mapping is the answer, sentinel list or not.
 */
function resolveStatusSignal(
  raw: string | undefined | null,
  map: MembershipValueMaps['status'],
): 'member' | 'inactive' | 'none' | 'blank' {
  const trimmed = normalisePropertyString(raw ?? undefined);
  if (!trimmed) return 'blank';

  const normalized = trimmed.toLowerCase().replace(/[-\s]+/g, '_');
  const explicit = map?.[trimmed] ?? map?.[normalized];
  if (explicit === 'member') return 'member';
  if (explicit === 'non_member') return 'inactive';

  if (MEMBERSHIP_SENTINELS.has(normalized)) return 'none';

  const builtin = normalizeMembershipStatus(trimmed);
  if (builtin === 'member') return 'member';
  if (builtin === 'non_member') return 'inactive';
  return 'blank';
}

function isMembershipSentinel(raw: string | null | undefined): boolean {
  const trimmed = normalisePropertyString(raw ?? undefined);
  if (!trimmed) return false;
  return MEMBERSHIP_SENTINELS.has(trimmed.toLowerCase().replace(/[-\s]+/g, '_'));
}

/** `raw` with the CRM sentinels collapsed to null. Mirrors the CMS `scrub` macro. */
function scrubMembershipSentinel(raw: string | null | undefined): string | null {
  const trimmed = normalisePropertyString(raw ?? undefined);
  if (!trimmed) return null;
  return isMembershipSentinel(trimmed) ? null : trimmed;
}

/** Map a raw HubSpot value to its canonical form, via the value map or a normalized fallback. */
function toCanonical(
  raw: string | undefined,
  map: Record<string, string> | undefined,
): string | null {
  if (!raw || raw === '') return null;
  const trimmed = raw.trim();
  if (map?.[trimmed]) return map[trimmed];
  const normalized = trimmed.toLowerCase().replace(/[-\s]+/g, '_');
  if (map?.[normalized]) return map[normalized];
  return normalized;
}

/**
 * Canonicalise membership level labels for pricing. HubSpot can surface these
 * as "Corporate Silver", "Silver Corporate", "Individual", etc.; D1 pricing
 * rules are keyed by the level token only: silver/gold/bronze/student/individual.
 */
export function toCanonicalMemberLevel(
  raw: string | undefined,
  map: Record<string, string> | undefined,
): string | null {
  if (!raw || raw === '') return null;
  const trimmed = raw.trim();
  if (map?.[trimmed]) return map[trimmed];
  const normalizedKey = trimmed.toLowerCase().replace(/[-\s]+/g, '_');
  if (map?.[normalizedKey]) return map[normalizedKey];

  const normalizedWords = trimmed.toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  if (map?.[normalizedWords]) return map[normalizedWords];
  if (normalizedWords.includes('gold')) return 'gold';
  if (normalizedWords.includes('silver')) return 'silver';
  if (normalizedWords.includes('bronze')) return 'bronze';
  if (normalizedWords.includes('student') || normalizedWords.includes('apprentice')) {
    return 'student';
  }
  if (
    normalizedWords.includes('individual') ||
    normalizedWords.includes('reciprocal') ||
    normalizedWords.includes('associate') ||
    normalizedWords.includes('honorary') ||
    normalizedWords.includes('honourary') ||
    normalizedWords.includes('industry supplier')
  ) {
    return 'individual';
  }
  if (normalizedWords === 'member' || normalizedWords.includes('member')) return 'member';
  return normalizedKey;
}

function normalizeMembershipStatus(raw: string): MembershipStatus {
  const value = raw
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');

  if (['current', 'active', 'member', 'grace_period', 'honorary'].includes(value)) {
    return 'member';
  }
  if (
    [
      'non_member',
      'nonmember',
      'never_member',
      'inactive',
      'cancelled',
      'canceled',
      'lapsed',
      'expired',
      'pending',
      'not_applicable',
    ].includes(value)
  ) {
    return 'non_member';
  }

  return 'membership_unverified';
}

function statusFromDirectoryProfile(profile: MemberDirectoryProfile): MembershipStatus {
  if (!profile.found) return 'membership_unverified';
  return profile.isActive ? 'member' : 'non_member';
}

function unverifiedProfile(): MembershipProfile {
  return {
    status: 'membership_unverified',
    memberTier: null,
    isGoldMember: false,
  };
}

/**
 * The Find a Member row for a buyer's email, or "not in the directory".
 *
 * This read decides whether a buyer is quoted a member price, so getting it wrong is
 * visible to a customer either as a refused member rate or as a discount they should
 * not have. Two properties have to hold, and the obvious implementation broke the
 * second one:
 *
 *  - It must find the row WHEREVER it is in the table. This used to be a single
 *    unfiltered `limit=1000` read scanned in memory, with no paging. Weld's directory
 *    grows by a row per corporate member, so the day it passes 1,000 the members past
 *    that point silently stop verifying: the page quotes them a member rate off HubDB
 *    and the worker then prices them as a non-member. Nothing would have said why.
 *
 *  - It must tell "in the directory but lapsed" apart from "not in the directory".
 *    `statusFromDirectoryProfile` maps the first to `non_member` (a definite answer)
 *    and the second to `membership_unverified` (routes to support). So this must NOT
 *    filter on the active flag, the way the company-id lookup below can afford to: doing
 *    that would turn every lapsed member into an unverified one and send a stream of
 *    settled cases to the support queue.
 *
 * Filtered read first because it is one request and exact. The paged scan is the
 * fallback, because HubDB's `__eq` on a text column is case-sensitive and a row stored
 * as "Person@Example.com" would miss a filter built from a lowercased address — which
 * is precisely what the old in-memory `normaliseEmail` comparison was tolerating.
 *
 * The table and its columns are the tenant's (`member_directory_config`, 0046). A portal
 * with no directory configured makes no request and reads as "not in the directory".
 */
async function resolveMemberDirectoryProfile(
  apiKey: string,
  buyerEmail: string,
  directory: MemberDirectoryConfig | null,
): Promise<MemberDirectoryProfile> {
  if (!directory) return emptyDirectoryProfile();
  const email = buyerEmail.trim().toLowerCase();
  if (!email) return emptyDirectoryProfile();

  // Fast path: one filtered request. Deliberately no active-flag filter (see above).
  const filtered = await fetchMemberDirectoryRows(
    apiKey,
    directory,
    `${directory.emailColumn}__eq=${encodeURIComponent(email)}&limit=2`,
  );
  const filteredMatch = filtered?.find(
    (row) => normaliseEmail(row.values?.[directory.emailColumn]) === email,
  )?.values;
  if (filteredMatch) return directoryProfileFromRow(filteredMatch, directory);

  // Fallback: walk the whole table. Covers a stored address whose case differs, and a
  // portal whose column config rejects the filter (fetchMemberDirectoryRows returns
  // null there, which is not the same as "no match").
  const all = await fetchAllMemberDirectoryRows(apiKey, directory);
  if (!all) return emptyDirectoryProfile();

  const values = all.find(
    (row) => normaliseEmail(row.values?.[directory.emailColumn]) === email,
  )?.values;
  if (!values) return emptyDirectoryProfile();

  return directoryProfileFromRow(values, directory);
}

/** One directory row → the profile shape, so both lookups above agree by construction. */
function directoryProfileFromRow(
  values: Record<string, unknown>,
  directory: MemberDirectoryConfig,
): MemberDirectoryProfile {
  const memberTier = normaliseMemberTier(values[directory.tierColumn]);
  return {
    memberTier,
    found: true,
    isActive: normaliseActiveFlag(values[directory.activeColumn]),
    isGoldMember: isGoldTier(memberTier),
  };
}

/**
 * Look up an active Find a Member directory row by HubSpot company ID, the same
 * key CMS `validateMemberCompany` uses for the guest unlock preview.
 */
async function resolveMemberDirectoryByCompanyId(
  apiKey: string,
  companyId: string,
  directory: MemberDirectoryConfig | null,
): Promise<MemberDirectoryProfile> {
  if (!directory) return emptyDirectoryProfile();
  const id = companyId.trim();
  if (!id) return emptyDirectoryProfile();

  // Prefer a filtered HubDB read; fall back to scanning the first page if the
  // filter param isn't accepted for this portal's column config.
  const filtered = await fetchMemberDirectoryRows(
    apiKey,
    directory,
    `${directory.companyIdColumn}__eq=${encodeURIComponent(id)}&${directory.activeColumn}__eq=true&limit=1`,
  );
  if (filtered) {
    const values = filtered[0]?.values;
    if (values) return directoryProfileFromRow(values, directory);
    // Filter succeeded with zero rows → no active match.
    return emptyDirectoryProfile();
  }

  // Same paged walk the email lookup falls back to: `limit=1000` silently stopped at
  // the first page, so a company past row 1,000 could not unlock its member rate.
  const all = await fetchAllMemberDirectoryRows(apiKey, directory);
  if (!all) return emptyDirectoryProfile();

  const values = all.find(
    (row) => normaliseCompanyId(row.values?.[directory.companyIdColumn]) === id,
  )?.values;
  if (!values) return emptyDirectoryProfile();

  return directoryProfileFromRow(values, directory);
}

interface MemberDirectoryPage {
  rows: Array<{ values?: Record<string, unknown> }>;
  /** HubDB's paging cursor, or null on the last page. */
  after: string | null;
}

/**
 * One page of the member directory. `null` means the read FAILED (network, a non-2xx,
 * a filter this portal's column config rejects) and is deliberately distinct from an
 * empty page, which means "looked, found nothing": callers must not read the first as
 * the second. Same "cannot see is never not there" rule the outbox holds.
 */
async function fetchMemberDirectoryPage(
  apiKey: string,
  directory: MemberDirectoryConfig,
  query: string,
): Promise<MemberDirectoryPage | null> {
  let resp: Response;
  try {
    resp = await fetch(
      `https://api.hubapi.com/cms/v3/hubdb/tables/${encodeURIComponent(directory.table)}/rows?${query}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
  } catch {
    return null;
  }
  if (!resp.ok) return null;
  const data = (await resp.json()) as {
    results?: Array<{ values?: Record<string, unknown> }>;
    paging?: { next?: { after?: string } };
  };
  return { rows: data.results ?? [], after: data.paging?.next?.after ?? null };
}

async function fetchMemberDirectoryRows(
  apiKey: string,
  directory: MemberDirectoryConfig,
  query: string,
): Promise<Array<{ values?: Record<string, unknown> }> | null> {
  const page = await fetchMemberDirectoryPage(apiKey, directory, query);
  return page ? page.rows : null;
}

/**
 * Pages HubDB gives us per request, and the ceiling on how many pages we will walk.
 * The cap exists so a misconfigured table cannot turn one checkout into an unbounded
 * run of HubDB reads; hitting it is logged rather than absorbed, because a silent
 * truncation here is the original bug wearing a larger number.
 */
const MEMBER_DIRECTORY_PAGE_SIZE = 1000;
const MEMBER_DIRECTORY_MAX_PAGES = 10;

/** Every row in the member directory, following HubDB's paging cursor. */
async function fetchAllMemberDirectoryRows(
  apiKey: string,
  directory: MemberDirectoryConfig,
): Promise<Array<{ values?: Record<string, unknown> }> | null> {
  const rows: Array<{ values?: Record<string, unknown> }> = [];
  let after: string | null = null;

  for (let page = 0; page < MEMBER_DIRECTORY_MAX_PAGES; page++) {
    const query = `limit=${MEMBER_DIRECTORY_PAGE_SIZE}${
      after ? `&after=${encodeURIComponent(after)}` : ''
    }`;
    const result: MemberDirectoryPage | null = await fetchMemberDirectoryPage(
      apiKey,
      directory,
      query,
    );
    // A failure mid-walk is a failure: returning what we have so far would report
    // "not in the directory" for a member who may well be on the next page.
    if (!result) return null;

    rows.push(...result.rows);
    if (!result.after) return rows;
    after = result.after;
  }

  console.error(
    JSON.stringify({
      level: 'warn',
      event: 'member_directory_scan_truncated',
      table: directory.table,
      scanned: rows.length,
      maxPages: MEMBER_DIRECTORY_MAX_PAGES,
      message:
        'Member directory is larger than the scan cap. A member past this point cannot ' +
        'be verified by email and will be priced as a non-member. Raise the cap or fix ' +
        'the email column filter for this portal.',
    }),
  );
  return rows;
}

/**
 * The company's membership, read from the tenant's company property families (0046) in
 * priority order: the first family carrying a status decides, and failing that the first
 * carrying a level supplies the tier (with its family's category) and no verdict.
 *
 * No families configured is no request: the company answers as one that said nothing.
 */
async function resolveCompanyMembershipProfile(
  apiKey: string,
  companyId: string | null | undefined,
  sources: CompanyMembershipSource[],
): Promise<CompanyMembershipProfile> {
  if (sources.length === 0) return emptyCompanyProfile();
  const id = normalisePropertyString(companyId);
  if (!id) return emptyCompanyProfile();

  const requested = new Set<string>();
  for (const source of sources) {
    requested.add(source.statusProperty);
    if (source.levelProperty) requested.add(source.levelProperty);
  }

  let resp: Response;
  try {
    resp = await fetch(
      `https://api.hubapi.com/crm/v3/objects/companies/${encodeURIComponent(id)}` +
        `?properties=${[...requested].map((p) => encodeURIComponent(p)).join(',')}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
  } catch {
    return emptyCompanyProfile();
  }

  if (!resp.ok) return emptyCompanyProfile();

  const data = (await resp.json()) as { properties?: Record<string, string | undefined> };
  const properties = data.properties ?? {};
  const levelOf = (source: CompanyMembershipSource): string | null =>
    source.levelProperty ? normalisePropertyString(properties[source.levelProperty]) : null;

  for (const source of sources) {
    const status = normalisePropertyString(properties[source.statusProperty]);
    if (status) {
      return {
        status: normalizeMembershipStatus(status),
        rawStatus: status,
        memberTier: levelOf(source),
        category: source.category,
      };
    }
  }

  for (const source of sources) {
    const memberTier = levelOf(source);
    if (memberTier) {
      return {
        status: 'membership_unverified',
        rawStatus: null,
        memberTier,
        category: source.category,
      };
    }
  }

  return emptyCompanyProfile();
}

/**
 * The company a contact is associated with, when `associatedcompanyid` is blank.
 *
 * That property is only ever set for HubSpot's PRIMARY company association, and a large
 * part of Weld's corporate membership is contacts linked to their employer by an ordinary
 * (unlabelled or labelled) association with no primary among them. The CMS checkout
 * traverses the association for exactly this reason; the worker read the property alone,
 * so the same employee was quoted their employer's member rate on the page and priced as
 * a non-member at reserve, which reaches the buyer as "the course price changed before
 * checkout".
 *
 * Read-only and failure-tolerant: anything other than a usable id returns null and the
 * caller carries on with no company, exactly as it did before.
 */
async function resolveAssociatedCompanyId(
  apiKey: string,
  contactId: string | null,
): Promise<string | null> {
  if (!contactId) return null;

  let resp: Response;
  try {
    resp = await fetch(
      `https://api.hubapi.com/crm/v4/objects/contacts/${encodeURIComponent(contactId)}` +
        `/associations/companies?limit=10`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
    );
  } catch {
    return null;
  }
  if (!resp.ok) return null;

  let results: Array<{ toObjectId?: string | number }> = [];
  try {
    const data = (await resp.json()) as { results?: Array<{ toObjectId?: string | number }> };
    results = data.results ?? [];
  } catch {
    return null;
  }

  for (const result of results) {
    const id = normaliseId(result.toObjectId);
    if (id) return id;
  }
  return null;
}

/** A HubSpot object id as a plain digit string, or null. */
function normaliseId(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  const trimmed = normalisePropertyString(value);
  return trimmed && /^\d+$/.test(trimmed) ? trimmed : null;
}

function emptyCompanyProfile(): CompanyMembershipProfile {
  return {
    status: 'membership_unverified',
    rawStatus: null,
    memberTier: null,
    category: null,
  };
}

function emptyDirectoryProfile(): MemberDirectoryProfile {
  return {
    memberTier: null,
    found: false,
    isActive: false,
    isGoldMember: false,
  };
}

function normaliseEmail(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normaliseCompanyId(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value === 'string' && value.trim()) return value.trim();
  return '';
}

function normalisePropertyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normaliseMemberTier(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'object') {
    const option = value as { label?: unknown; name?: unknown };
    const label = typeof option.label === 'string' ? option.label : '';
    const name = typeof option.name === 'string' ? option.name : '';
    return (label || name).trim() || null;
  }
  return null;
}

function isGoldTier(memberTier: string | null): boolean {
  return toCanonicalMemberLevel(memberTier ?? undefined, undefined) === 'gold';
}

function normaliseActiveFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    return ['true', '1', 'yes', 'active'].includes(value.trim().toLowerCase());
  }
  return false;
}
