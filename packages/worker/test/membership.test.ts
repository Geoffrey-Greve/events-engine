import { env } from 'cloudflare:test';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveMembership, resolveMembershipProfile } from '../src/membership';
import type { Env } from '../src/types';
import { configureWeldMembership, seedTenant } from './support/fixtures';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// resolveMembershipProfile: Weld CRM / company / HubDB tier resolution (PR)
// ---------------------------------------------------------------------------

// Its own portal, configured the way 0046 backfilled every installed one, so these cases
// keep proving Weld's resolution while the code itself names none of Weld's properties.
const PROFILE_PORTAL = 'mp-weld-profile';

function makeEnv(withToken = true): Env {
  return {
    ...(env as unknown as Record<string, unknown>),
    ...(withToken ? { [`HUBSPOT_API_KEY_${PROFILE_PORTAL}`]: 'test-token' } : {}),
  } as unknown as Env;
}

beforeAll(async () => {
  const db = (env as unknown as Env).DB;
  await seedTenant(db, PROFILE_PORTAL);
  await configureWeldMembership(db, PROFILE_PORTAL, {
    membership_status_property: 'individual_membership_status',
    membership_level_property: 'individual_membership_type_2',
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockHubSpot({
  directoryRows = [],
  contactStatus = '',
  contactTier = '',
  associatedCompanyId = '',
  companyStatus = '',
  companyTier = '',
  contactStatusCode = 200,
}: {
  directoryRows?: Array<Record<string, unknown>>;
  contactStatus?: string;
  contactTier?: string;
  associatedCompanyId?: string;
  companyStatus?: string;
  companyTier?: string;
  contactStatusCode?: number;
}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes('/cms/v3/hubdb/tables/members/rows')) {
      return jsonResponse({
        results: directoryRows.map((values) => ({ values })),
      });
    }

    if (url.includes('/crm/v3/objects/contacts/')) {
      if (contactStatusCode === 404) return jsonResponse({ message: 'not found' }, 404);
      return jsonResponse({
        properties: {
          individual_membership_status: contactStatus,
          individual_membership_type_2: contactTier,
          associatedcompanyid: associatedCompanyId,
        },
      });
    }

    if (url.includes('/crm/v3/objects/companies/')) {
      return jsonResponse({
        properties: {
          corporate_membership_status: companyStatus,
          corporate_membership_level_2: companyTier,
        },
      });
    }

    throw new Error(`Unexpected HubSpot URL: ${url}`);
  });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('resolveMembershipProfile', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('treats Weld CRM Current status as a member', async () => {
    mockHubSpot({
      contactStatus: 'Current',
      contactTier: 'Individual',
    });

    await expect(
      resolveMembershipProfile(makeEnv(), PROFILE_PORTAL, 'member@example.com'),
    ).resolves.toMatchObject({
      status: 'member',
      memberTier: 'Individual',
      isGoldMember: false,
    });
  });

  it('falls back to any active HubDB member row when CRM status is blank', async () => {
    mockHubSpot({
      directoryRows: [
        {
          contact_email: 'member@example.com',
          member_tier: { label: 'Bronze' },
          is_active: true,
        },
      ],
      contactStatus: '',
    });

    await expect(
      resolveMembershipProfile(makeEnv(), PROFILE_PORTAL, 'member@example.com'),
    ).resolves.toMatchObject({
      status: 'member',
      memberTier: 'Bronze',
      isGoldMember: false,
    });
  });

  it('uses the associated company tier before a legacy HubDB directory tier', async () => {
    mockHubSpot({
      directoryRows: [
        {
          contact_email: 'member@example.com',
          member_tier: { label: 'Gold' },
          is_active: true,
        },
      ],
      contactStatus: '',
      contactTier: '',
      associatedCompanyId: '123',
      companyStatus: 'Current',
      companyTier: 'Silver',
    });

    await expect(
      resolveMembershipProfile(makeEnv(), PROFILE_PORTAL, 'member@example.com'),
    ).resolves.toMatchObject({
      status: 'member',
      memberTier: 'Silver',
      isGoldMember: false,
    });
  });

  it('uses a stronger associated company tier over an individual contact tier', async () => {
    mockHubSpot({
      contactStatus: 'Current',
      contactTier: 'Individual',
      associatedCompanyId: '123',
      companyStatus: 'Current',
      companyTier: 'Gold',
    });

    await expect(
      resolveMembershipProfile(makeEnv(), PROFILE_PORTAL, 'member@example.com'),
    ).resolves.toMatchObject({
      status: 'member',
      memberTier: 'Gold',
      isGoldMember: true,
    });
  });

  it('still flags active Gold directory members for the duplicate-booking override', async () => {
    mockHubSpot({
      directoryRows: [
        {
          contact_email: 'gold@example.com',
          member_tier: { label: 'Gold' },
          is_active: true,
        },
      ],
      contactStatusCode: 404,
    });

    await expect(
      resolveMembershipProfile(makeEnv(), PROFILE_PORTAL, 'gold@example.com'),
    ).resolves.toMatchObject({
      status: 'member',
      memberTier: 'Gold',
      isGoldMember: true,
    });
  });

  it('treats known lapsed or cancelled CRM status as non-member even when HubDB has an active row', async () => {
    mockHubSpot({
      directoryRows: [
        {
          contact_email: 'lapsed@example.com',
          member_tier: { label: 'Gold' },
          is_active: true,
        },
      ],
      contactStatus: 'Lapsed',
      contactTier: 'Individual',
    });

    await expect(
      resolveMembershipProfile(makeEnv(), PROFILE_PORTAL, 'lapsed@example.com'),
    ).resolves.toMatchObject({
      status: 'non_member',
      memberTier: 'Individual',
      isGoldMember: false,
    });
  });

  it('returns unverified when no HubSpot read token is available', async () => {
    await expect(
      resolveMembershipProfile(makeEnv(false), PROFILE_PORTAL, 'member@example.com'),
    ).resolves.toMatchObject({
      status: 'membership_unverified',
      memberTier: null,
      isGoldMember: false,
    });
  });
});

// ---------------------------------------------------------------------------
// resolveMembership: Phase 18.1 tiered API + tenant-configurable properties
// ---------------------------------------------------------------------------

// Real Workers-runtime D1 (env.DB). We create just the tenants columns resolveMembership
// reads, stub the HubSpot contact fetch, and assert that the STATUS property is honoured
// from the tenant config (Phase: 0012) with a fallback to 'membership_status'.

const E = env as unknown as Env;

let counter = 0;
const freshPortal = () => `p-${Date.now()}-${counter++}`;

/** A tenant row carrying the membership-config columns resolveMembership queries. */
async function insertTenant(args: {
  portalId: string;
  statusProperty?: string | null;
  levelProperty?: string | null;
  categoryProperty?: string | null;
  valueMaps?: unknown;
  /** false = a tenant installed after 0046 that has not mapped its company/mirror/directory. */
  sources?: boolean;
}) {
  await E.DB.prepare(
    `INSERT INTO tenants
       (portal_id, membership_status_property, membership_level_property, member_category_property, membership_value_maps, display_name)
     VALUES (?1, ?2, ?3, ?4, ?5, 'Test Tenant')`,
  )
    .bind(
      args.portalId,
      args.statusProperty ?? null,
      args.levelProperty ?? null,
      args.categoryProperty ?? null,
      args.valueMaps === undefined ? null : JSON.stringify(args.valueMaps),
    )
    .run();
  if (args.sources !== false) await configureWeldMembership(E.DB, args.portalId);
}

/**
 * Stub HubSpot fetches for resolveMembership. Contact reads return `properties`;
 * HubDB / company reads return empty so tenant-config tests stay contact-scoped.
 */
function stubHubSpotContact(properties: Record<string, string>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/cms/v3/hubdb/tables/members/rows')) {
        return new Response(JSON.stringify({ results: [] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/crm/v3/objects/companies/')) {
        return new Response(JSON.stringify({ properties: {} }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ properties }), {
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

function stubHubSpotContactAndCompany(
  contactProperties: Record<string, string>,
  companyProperties: Record<string, string>,
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/cms/v3/hubdb/tables/members/rows')) {
        return new Response(JSON.stringify({ results: [] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/crm/v3/objects/companies/')) {
        return new Response(JSON.stringify({ properties: companyProperties }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ properties: contactProperties }), {
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

/** resolveMembership reads the HubSpot key via getSecret(env, `HUBSPOT_API_KEY_${portalId}`). */
function envWithKey(portalId: string): Env {
  return {
    ...(E as unknown as Record<string, unknown>),
    [`HUBSPOT_API_KEY_${portalId}`]: 'test-key',
  } as unknown as Env;
}

describe('resolveMembership: configurable status property', () => {
  it('resolves a member via the tenant-configured status property', async () => {
    const portalId = freshPortal();
    await insertTenant({
      portalId,
      statusProperty: 'individual_membership_status',
      levelProperty: 'individual_membership_type_2',
      categoryProperty: 'member_category',
      valueMaps: { level: { Gold: 'gold' }, category: { Corporate: 'corporate' } },
    });
    stubHubSpotContact({
      individual_membership_status: 'active',
      individual_membership_type_2: 'Gold',
      member_category: 'Corporate',
    });

    const result = await resolveMembership(envWithKey(portalId), portalId, 'gold@example.com');
    expect(result).toEqual({
      isMember: true,
      verified: true,
      level: 'gold',
      category: 'corporate',
    });
  });

  it('does not resolve a member when the hardcoded property is read but the tenant uses another', async () => {
    const portalId = freshPortal();
    // Tenant has NOT configured a status property → falls back to 'membership_status',
    // which this Weld-shaped contact does not carry → unverified.
    await insertTenant({ portalId, statusProperty: null });
    stubHubSpotContact({ individual_membership_status: 'active' });

    const result = await resolveMembership(envWithKey(portalId), portalId, 'gold@example.com');
    expect(result).toEqual({ isMember: false, verified: false, level: null, category: null });
  });

  it('still honours the built-in "membership_status" fallback for legacy tenants', async () => {
    const portalId = freshPortal();
    await insertTenant({ portalId, statusProperty: null });
    stubHubSpotContact({ membership_status: 'member' });

    const result = await resolveMembership(envWithKey(portalId), portalId, 'legacy@example.com');
    expect(result.isMember).toBe(true);
    expect(result.verified).toBe(true);
  });

  it('normalises Weld "Current" status via built-in synonyms', async () => {
    const portalId = freshPortal();
    await insertTenant({
      portalId,
      statusProperty: 'individual_membership_status',
      levelProperty: 'individual_membership_type_2',
      categoryProperty: 'member_category',
    });
    stubHubSpotContact({
      individual_membership_status: 'Current',
      individual_membership_type_2: 'Gold',
      member_category: 'Individual',
    });

    const result = await resolveMembership(envWithKey(portalId), portalId, 'member@example.com');
    expect(result).toEqual({
      isMember: true,
      verified: true,
      level: 'gold',
      category: 'individual',
    });
  });

  it('uses the stronger associated company level when a Current contact is Individual', async () => {
    const portalId = freshPortal();
    await insertTenant({
      portalId,
      statusProperty: 'individual_membership_status',
      levelProperty: 'individual_membership_type_2',
      categoryProperty: 'member_category',
    });
    stubHubSpotContactAndCompany(
      {
        individual_membership_status: 'Current',
        individual_membership_type_2: 'Individual',
        member_category: 'Individual',
        associatedcompanyid: '123',
      },
      {
        corporate_membership_status: 'Current',
        corporate_membership_level_2: 'Corporate Silver',
      },
    );

    const result = await resolveMembership(envWithKey(portalId), portalId, 'member@example.com');
    expect(result).toEqual({
      isMember: true,
      verified: true,
      level: 'silver',
      category: 'corporate',
    });
  });
});

// ---------------------------------------------------------------------------
// resolveMembership: guest memberCompanyId unlock (CMS checkout to invoice)
// ---------------------------------------------------------------------------

/**
 * Stub HubSpot for the guest company-ID path: contact is absent/non-member,
 * company + HubDB directory carry the membership that should unlock pricing.
 */
function stubGuestCompanyUnlock(args: {
  contactStatusCode?: number;
  contactProperties?: Record<string, string>;
  companyStatus?: string;
  companyTier?: string;
  companyCategory?: 'corporate' | 'industry_supplier';
  directoryRows?: Array<Record<string, unknown>>;
}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);

    if (url.includes('/cms/v3/hubdb/tables/members/rows')) {
      return new Response(
        JSON.stringify({ results: (args.directoryRows ?? []).map((values) => ({ values })) }),
        {
          headers: { 'content-type': 'application/json' },
        },
      );
    }

    if (url.includes('/crm/v3/objects/companies/')) {
      const props =
        args.companyCategory === 'industry_supplier'
          ? {
              industry_supplier_membership_status: args.companyStatus ?? '',
              industry_supplier_membership_level_2: args.companyTier ?? '',
            }
          : {
              corporate_membership_status: args.companyStatus ?? '',
              corporate_membership_level_2: args.companyTier ?? '',
            };
      return new Response(JSON.stringify({ properties: props }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.includes('/crm/v3/objects/contacts/')) {
      if ((args.contactStatusCode ?? 404) === 404) {
        return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
      }
      return new Response(JSON.stringify({ properties: args.contactProperties ?? {} }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    throw new Error(`Unexpected HubSpot URL: ${url}`);
  });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('resolveMembership: CMS signal parity (member-only checkout gate)', () => {
  // These are the cases that produced "We couldn't verify your membership" at reserve:
  // the CMS gate in weld-aus-hubspot/theme/modules/checkout-tunnel.module/module.html
  // counted the buyer as a member, routed them to the member-only ticket, and the Worker
  // then refused because it only ever looked at a membership STATUS.

  const weldTenant = (portalId: string) =>
    insertTenant({
      portalId,
      statusProperty: 'individual_membership_status',
      levelProperty: 'individual_membership_type_2',
    });

  it('verifies a corporate employee carrying only their employer Gold tier', async () => {
    const portalId = freshPortal();
    await weldTenant(portalId);
    stubHubSpotContactAndCompany(
      { individual_membership_status: '', associatedcompanyid: '77' },
      { corporate_membership_level_2: 'Corporate Gold' },
    );

    const result = await resolveMembership(envWithKey(portalId), portalId, 'employee@example.com');
    expect(result).toEqual({
      isMember: true,
      verified: true,
      level: 'gold',
      category: 'corporate',
    });
  });

  it('verifies a contact whose own tier is set but whose status is blank', async () => {
    const portalId = freshPortal();
    await weldTenant(portalId);
    stubHubSpotContact({
      individual_membership_status: '',
      individual_membership_type_2: 'Individual',
    });

    const result = await resolveMembership(envWithKey(portalId), portalId, 'tier@example.com');
    expect(result.isMember).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.level).toBe('individual');
  });

  it('scrubs the "Not Applicable" sentinel and falls through to the employer', async () => {
    const portalId = freshPortal();
    await weldTenant(portalId);
    stubHubSpotContactAndCompany(
      {
        individual_membership_status: 'Not Applicable',
        individual_membership_type_2: 'Not Applicable',
        associatedcompanyid: '77',
      },
      { corporate_membership_status: 'Current', corporate_membership_level_2: 'Corporate Silver' },
    );

    const result = await resolveMembership(envWithKey(portalId), portalId, 'na@example.com');
    expect(result).toEqual({
      isMember: true,
      verified: true,
      level: 'silver',
      category: 'corporate',
    });
  });

  it('calls an explicit sentinel with nothing behind it a confirmed non-member', async () => {
    // Not "unverified": there is nothing for support to look into, so the buyer should be
    // told this ticket is members-only rather than asked to contact the office.
    const portalId = freshPortal();
    await weldTenant(portalId);
    stubHubSpotContact({ individual_membership_status: 'Not Applicable' });

    const result = await resolveMembership(envWithKey(portalId), portalId, 'guest@example.com');
    expect(result.isMember).toBe(false);
    expect(result.verified).toBe(true);
  });

  it('keeps a lapsed contact out even when the employer still holds a tier', async () => {
    const portalId = freshPortal();
    await weldTenant(portalId);
    stubHubSpotContactAndCompany(
      { individual_membership_status: 'Lapsed', associatedcompanyid: '77' },
      { corporate_membership_status: 'Current', corporate_membership_level_2: 'Corporate Gold' },
    );

    const result = await resolveMembership(envWithKey(portalId), portalId, 'lapsed@example.com');
    expect(result.isMember).toBe(false);
    expect(result.verified).toBe(true);
  });

  it('keeps a contact out when the employer membership has lapsed', async () => {
    const portalId = freshPortal();
    await weldTenant(portalId);
    stubHubSpotContactAndCompany(
      { individual_membership_status: '', associatedcompanyid: '77' },
      { corporate_membership_status: 'Lapsed', corporate_membership_level_2: 'Corporate Gold' },
    );

    const result = await resolveMembership(envWithKey(portalId), portalId, 'exemp@example.com');
    expect(result.isMember).toBe(false);
    expect(result.verified).toBe(true);
  });

  it('lets an explicit tenant value map override the built-in sentinel list', async () => {
    // A portal that has deliberately mapped "Non Member" keeps that meaning: the map is
    // the tenant's own statement about their data and outranks our defaults.
    const portalId = freshPortal();
    await insertTenant({
      portalId,
      statusProperty: 'individual_membership_status',
      levelProperty: 'individual_membership_type_2',
      valueMaps: { status: { 'Non Member': 'non_member' } },
    });
    stubHubSpotContactAndCompany(
      {
        individual_membership_status: 'Non Member',
        associatedcompanyid: '77',
      },
      { corporate_membership_status: 'Current', corporate_membership_level_2: 'Corporate Gold' },
    );

    const result = await resolveMembership(envWithKey(portalId), portalId, 'mapped@example.com');
    expect(result.isMember).toBe(false);
    expect(result.verified).toBe(true);
  });

  it('still reports unverified when HubSpot says nothing at all', async () => {
    const portalId = freshPortal();
    await weldTenant(portalId);
    stubHubSpotContact({ individual_membership_status: '' });

    const result = await resolveMembership(envWithKey(portalId), portalId, 'silent@example.com');
    expect(result).toEqual({ isMember: false, verified: false, level: null, category: null });
  });

  // The CMS checkout traverses the contact → company association when
  // `associatedcompanyid` is blank, because that property is only ever set for a PRIMARY
  // association and much of Weld's corporate membership has none. Reading the property
  // alone here priced that employee as a non-member and refused the booking they had just
  // been quoted a member price for.
  it('finds the employer through the association when associatedcompanyid is blank', async () => {
    const portalId = freshPortal();
    await weldTenant(portalId);
    stubHubSpotContactWithAssociatedCompany({
      contactId: '5501',
      contactProperties: { individual_membership_status: '', associatedcompanyid: '' },
      associatedCompanyIds: ['88'],
      companyProperties: {
        corporate_membership_status: 'Current',
        corporate_membership_level_2: 'Corporate Gold',
      },
    });

    const result = await resolveMembership(
      envWithKey(portalId),
      portalId,
      'unlinked-employee@example.com',
    );
    expect(result).toEqual({
      isMember: true,
      verified: true,
      level: 'gold',
      category: 'corporate',
    });
  });

  it('prefers associatedcompanyid and does not call the association endpoint', async () => {
    const portalId = freshPortal();
    await weldTenant(portalId);
    const fetchMock = stubHubSpotContactWithAssociatedCompany({
      contactId: '5502',
      contactProperties: { individual_membership_status: '', associatedcompanyid: '77' },
      associatedCompanyIds: ['88'],
      companyProperties: {
        corporate_membership_status: 'Current',
        corporate_membership_level_2: 'Corporate Silver',
      },
    });

    const result = await resolveMembership(envWithKey(portalId), portalId, 'linked@example.com');
    expect(result.level).toBe('silver');
    expect(
      fetchMock.mock.calls.some((call) => String(call[0]).includes('/associations/companies')),
    ).toBe(false);
  });

  it('carries on with no employer when the association read fails', async () => {
    const portalId = freshPortal();
    await weldTenant(portalId);
    stubHubSpotContactWithAssociatedCompany({
      contactId: '5503',
      contactProperties: { individual_membership_status: '', associatedcompanyid: '' },
      associatedCompanyIds: [],
      associationsStatus: 500,
      companyProperties: {
        corporate_membership_status: 'Current',
        corporate_membership_level_2: 'Corporate Gold',
      },
    });

    const result = await resolveMembership(envWithKey(portalId), portalId, 'broken@example.com');
    expect(result).toEqual({ isMember: false, verified: false, level: null, category: null });
  });

  // QA Ref 98. The CMS checkout reads the contact's mirror of its employer's membership
  // (wa_company_membership_*) first, and on the ungated checkout page it is close to the
  // only company signal the CMS has. An employee carrying the mirror but no reachable
  // company was quoted the member rate there and refused here as membership_unverified.
  it('verifies an employee from the mirrored company tier when no company is reachable', async () => {
    const portalId = freshPortal();
    await weldTenant(portalId);
    stubHubSpotContact({
      individual_membership_status: 'Not Applicable',
      individual_membership_type_2: 'Not Applicable',
      wa_company_membership_tier: 'Corporate Silver',
      wa_company_membership_status: 'Current',
    });

    const result = await resolveMembership(envWithKey(portalId), portalId, 'mirror@example.com');
    expect(result).toEqual({
      isMember: true,
      verified: true,
      level: 'silver',
      category: 'corporate',
    });
  });

  it('reads the category of a mirrored Industry Supplier tier', async () => {
    const portalId = freshPortal();
    await weldTenant(portalId);
    stubHubSpotContact({
      individual_membership_status: '',
      wa_company_membership_tier: 'Industry Supplier',
    });

    const result = await resolveMembership(envWithKey(portalId), portalId, 'supplier@example.com');
    expect(result.isMember).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.category).toBe('industry_supplier');
  });

  it('treats a lapsed mirrored company status as a hard no', async () => {
    const portalId = freshPortal();
    await weldTenant(portalId);
    stubHubSpotContact({
      individual_membership_status: '',
      wa_company_membership_tier: 'Corporate Gold',
      wa_company_membership_status: 'Lapsed',
    });

    const result = await resolveMembership(envWithKey(portalId), portalId, 'lapsedco@example.com');
    expect(result.isMember).toBe(false);
    expect(result.verified).toBe(true);
  });

  it('lets the company record outrank the mirror when the record has a tier', async () => {
    const portalId = freshPortal();
    await weldTenant(portalId);
    stubHubSpotContactAndCompany(
      {
        individual_membership_status: '',
        associatedcompanyid: '77',
        wa_company_membership_tier: 'Corporate Bronze',
      },
      { corporate_membership_status: 'Current', corporate_membership_level_2: 'Corporate Gold' },
    );

    const result = await resolveMembership(envWithKey(portalId), portalId, 'both@example.com');
    expect(result.level).toBe('gold');
  });

  it('asks HubSpot for the mirror properties on the contact read', async () => {
    const portalId = freshPortal();
    await weldTenant(portalId);
    stubHubSpotContact({ individual_membership_status: 'Current' });

    await resolveMembership(envWithKey(portalId), portalId, 'props@example.com');
    const contactCall = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((call) => String(call[0]))
      .find((url) => url.includes('/crm/v3/objects/contacts/'));
    expect(contactCall).toContain('wa_company_membership_tier');
    expect(contactCall).toContain('wa_company_membership_status');
  });
});

/**
 * Contact whose company is reachable only through the v4 association, the shape the CMS
 * checkout handles and the worker did not.
 */
function stubHubSpotContactWithAssociatedCompany(args: {
  contactId: string;
  contactProperties: Record<string, string>;
  associatedCompanyIds: string[];
  associationsStatus?: number;
  companyProperties: Record<string, string>;
}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/cms/v3/hubdb/tables/members/rows')) {
      return new Response(JSON.stringify({ results: [] }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/associations/companies')) {
      if (args.associationsStatus && args.associationsStatus !== 200) {
        return new Response('nope', { status: args.associationsStatus });
      }
      return new Response(
        JSON.stringify({
          results: args.associatedCompanyIds.map((id) => ({ toObjectId: id })),
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/crm/v3/objects/companies/')) {
      return new Response(JSON.stringify({ properties: args.companyProperties }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({ id: args.contactId, properties: args.contactProperties }),
      {
        headers: { 'content-type': 'application/json' },
      },
    );
  });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('resolveMembership: guest memberCompanyId unlock', () => {
  it('upgrades a guest (no contact) to member pricing via CRM company ID', async () => {
    const portalId = freshPortal();
    await insertTenant({
      portalId,
      statusProperty: 'individual_membership_status',
      levelProperty: 'individual_membership_type_2',
      categoryProperty: 'member_category',
      valueMaps: { level: { Gold: 'gold' }, category: { corporate: 'corporate' } },
    });
    stubGuestCompanyUnlock({
      contactStatusCode: 404,
      companyStatus: 'Active',
      companyTier: 'Gold',
      companyCategory: 'corporate',
    });

    const result = await resolveMembership(envWithKey(portalId), portalId, 'guest@example.com', {
      memberCompanyId: '1024',
    });

    expect(result).toEqual({
      isMember: true,
      verified: true,
      level: 'gold',
      category: 'corporate',
    });
  });

  it('upgrades a guest via an active HubDB members directory row when CRM is blank', async () => {
    const portalId = freshPortal();
    await insertTenant({ portalId, statusProperty: null });
    stubGuestCompanyUnlock({
      contactStatusCode: 404,
      companyStatus: '',
      companyTier: '',
      directoryRows: [
        {
          hubspot_company_id: 1024,
          member_tier: { name: 'Gold', label: 'Gold' },
          is_active: true,
          company_name: 'Acme Welding',
        },
      ],
    });

    const result = await resolveMembership(envWithKey(portalId), portalId, 'guest@example.com', {
      memberCompanyId: '1024',
    });

    expect(result).toEqual({
      isMember: true,
      verified: true,
      level: 'gold',
      category: 'corporate',
    });
  });

  it('does not unlock when the CRM company is lapsed even if HubDB still lists it', async () => {
    const portalId = freshPortal();
    await insertTenant({ portalId, statusProperty: null });
    stubGuestCompanyUnlock({
      contactStatusCode: 404,
      companyStatus: 'Lapsed',
      companyTier: 'Gold',
      companyCategory: 'corporate',
      directoryRows: [
        {
          hubspot_company_id: 1024,
          member_tier: 'Gold',
          is_active: true,
        },
      ],
    });

    const result = await resolveMembership(envWithKey(portalId), portalId, 'guest@example.com', {
      memberCompanyId: '1024',
    });

    expect(result.isMember).toBe(false);
    expect(result.verified).toBe(true);
  });

  it('ignores a non-numeric company ID and leaves the guest unverified', async () => {
    const portalId = freshPortal();
    await insertTenant({ portalId, statusProperty: null });
    stubGuestCompanyUnlock({ contactStatusCode: 404 });

    const result = await resolveMembership(envWithKey(portalId), portalId, 'guest@example.com', {
      memberCompanyId: 'not-a-company',
    });

    expect(result).toEqual({
      isMember: false,
      verified: false,
      level: null,
      category: null,
    });
  });

  it('fills missing level/category on a contact member from the company ID', async () => {
    const portalId = freshPortal();
    await insertTenant({
      portalId,
      statusProperty: 'individual_membership_status',
      levelProperty: 'individual_membership_type_2',
      categoryProperty: 'member_category',
    });
    stubGuestCompanyUnlock({
      contactStatusCode: 200,
      contactProperties: {
        individual_membership_status: 'Current',
        // Tier/category not cloned onto the contact yet.
      },
      companyStatus: 'Active',
      companyTier: 'Corporate Silver',
      companyCategory: 'corporate',
    });

    const result = await resolveMembership(envWithKey(portalId), portalId, 'member@example.com', {
      memberCompanyId: '2048',
    });

    expect(result).toEqual({
      isMember: true,
      verified: true,
      level: 'silver',
      category: 'corporate',
    });
  });
});
