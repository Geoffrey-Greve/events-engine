/**
 * Membership sources are tenant configuration (0046).
 *
 * The company property families, the contact's mirror of its employer and the Find a Member
 * HubDB directory were Weld Australia's names hard-coded in membership.ts, asked of every
 * portal. These cases pin the three halves of moving them into config:
 *
 *   - a tenant that has mapped nothing makes no company, mirror or directory request at
 *     all, and resolves as those sources saying nothing;
 *   - a tenant with its own names is read by those names and never by Weld's, which is
 *     the proof that nothing Weld-specific is left in the resolver;
 *   - the backfill copies exactly Weld's names onto every portal that existed on deploy,
 *     and leaves a contact status property somebody had already chosen alone.
 */
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadMembershipConfig,
  resolveMembership,
  resolveMembershipProfile,
} from '../src/membership';
import { manageRoutes } from '../src/routes/manage';
import type { Env } from '../src/types';
import { seedTenant, WELD_MEMBERSHIP_SOURCE_COLUMNS } from './support/fixtures';
import { BACKFILL_0046 } from './support/migration-0046-backfill';

const E = env as unknown as Env;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

let counter = 0;
const freshPortal = () => `msc-${Date.now()}-${counter++}`;

function envWithKey(portalId: string): Env {
  return {
    ...(E as unknown as Record<string, unknown>),
    [`HUBSPOT_API_KEY_${portalId}`]: 'test-key',
  } as unknown as Env;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A HubSpot stand-in that records every URL. Contacts answer `contact`, companies answer
 * `company`, any HubDB table answers `directoryRows`, associations answer `associatedIds`.
 */
function stubHubSpot(args: {
  contact?: Record<string, string>;
  company?: Record<string, string>;
  directoryRows?: Array<Record<string, unknown>>;
  associatedIds?: string[];
}) {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/cms/v3/hubdb/tables/')) {
        return json({ results: (args.directoryRows ?? []).map((values) => ({ values })) });
      }
      if (url.includes('/associations/companies')) {
        return json({ results: (args.associatedIds ?? []).map((id) => ({ toObjectId: id })) });
      }
      if (url.includes('/crm/v3/objects/companies/')) {
        return json({ properties: args.company ?? {} });
      }
      if (url.includes('/crm/v3/objects/contacts/')) {
        return json({ id: '9001', properties: args.contact ?? {} });
      }
      throw new Error(`Unexpected HubSpot URL: ${url}`);
    }),
  );
  return urls;
}

const WELD_NAMES = [
  'corporate_membership',
  'industry_supplier_membership',
  'wa_company_membership',
  'individual_membership',
  '/hubdb/tables/members/',
  'contact_email',
  'hubspot_company_id',
];

describe('a tenant with no membership sources configured', () => {
  it('makes no company, mirror, association or directory request', async () => {
    const portalId = freshPortal();
    await seedTenant(E.DB, portalId, { membership_status_property: 'acme_member_status' });
    const urls = stubHubSpot({
      contact: {
        associatedcompanyid: '123',
        // Present on the contact, but the tenant never said this is its mirror.
        wa_company_membership_tier: 'Corporate Gold',
        wa_company_membership_status: 'Current',
      },
    });

    const result = await resolveMembership(envWithKey(portalId), portalId, 'x@example.com', {
      memberCompanyId: '123',
    });

    // Nothing that was read said anything, so this is the unverified answer, not a member.
    expect(result).toEqual({ isMember: false, verified: false, level: null, category: null });
    expect(urls.every((u) => u.includes('/crm/v3/objects/contacts/'))).toBe(true);
    expect(urls.join(' ')).not.toContain('wa_company_membership');
  });

  it('keeps resolveMembershipProfile to the contact read as well', async () => {
    const portalId = freshPortal();
    await seedTenant(E.DB, portalId);
    const urls = stubHubSpot({ contact: { associatedcompanyid: '123' } });

    const profile = await resolveMembershipProfile(envWithKey(portalId), portalId, 'x@example.com');

    expect(profile.status).toBe('membership_unverified');
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('properties=membership_status,associatedcompanyid');
  });
});

describe('a tenant with its own membership property names', () => {
  const ACME = {
    membership_status_property: 'acme_member_status',
    membership_level_property: 'acme_member_level',
    membership_company_sources: JSON.stringify([
      {
        category: 'corporate',
        statusProperty: 'acme_company_status',
        levelProperty: 'acme_company_tier',
      },
      {
        category: 'industry_supplier',
        statusProperty: 'acme_supplier_status',
        levelProperty: null,
      },
    ]),
    membership_mirror_status_property: 'acme_mirror_status',
    membership_mirror_tier_property: 'acme_mirror_tier',
    member_directory_config: JSON.stringify({
      table: 'acme_directory',
      emailColumn: 'email_addr',
      tierColumn: 'level',
      activeColumn: 'live',
      companyIdColumn: 'crm_company',
    }),
  };

  const expectNoWeldNames = (urls: string[]) => {
    const joined = urls.join(' ');
    for (const name of WELD_NAMES) expect(joined).not.toContain(name);
  };

  it('reads the company by its own property families, in priority order', async () => {
    const portalId = freshPortal();
    await seedTenant(E.DB, portalId, ACME);
    const urls = stubHubSpot({
      contact: { associatedcompanyid: '123' },
      company: { acme_company_status: 'Active', acme_company_tier: 'Gold' },
    });

    const result = await resolveMembership(envWithKey(portalId), portalId, 'x@example.com');

    expect(result).toEqual({
      isMember: true,
      verified: true,
      level: 'gold',
      category: 'corporate',
    });
    const companyUrl = urls.find((u) => u.includes('/crm/v3/objects/companies/'));
    expect(companyUrl).toContain(
      'properties=acme_company_status,acme_company_tier,acme_supplier_status',
    );
    expect(urls.some((u) => u.includes('/hubdb/tables/acme_directory/rows?email_addr__eq='))).toBe(
      true,
    );
    expectNoWeldNames(urls);
  });

  it('falls through to a later family that carries the status', async () => {
    const portalId = freshPortal();
    await seedTenant(E.DB, portalId, ACME);
    stubHubSpot({
      contact: { associatedcompanyid: '123' },
      company: { acme_supplier_status: 'Active' },
    });

    const result = await resolveMembership(envWithKey(portalId), portalId, 'x@example.com');

    // A status with no tier carries no level to price by, so only the verdict is asserted.
    expect(result).toMatchObject({ isMember: true, verified: true });
  });

  it('reads the mirror by its own names when the company says nothing', async () => {
    const portalId = freshPortal();
    await seedTenant(E.DB, portalId, ACME);
    const urls = stubHubSpot({
      contact: { acme_mirror_tier: 'Corporate Silver', acme_mirror_status: 'Current' },
    });

    const result = await resolveMembership(envWithKey(portalId), portalId, 'x@example.com');

    expect(result).toEqual({
      isMember: true,
      verified: true,
      level: 'silver',
      category: 'corporate',
    });
    expect(urls.find((u) => u.includes('/crm/v3/objects/contacts/'))).toContain('acme_mirror_tier');
    expectNoWeldNames(urls);
  });

  it('unlocks a guest company id through its own directory table and columns', async () => {
    const portalId = freshPortal();
    await seedTenant(E.DB, portalId, ACME);
    const urls = stubHubSpot({
      directoryRows: [{ crm_company: '555', level: 'Gold', live: true }],
    });

    const result = await resolveMembership(envWithKey(portalId), portalId, 'x@example.com', {
      memberCompanyId: '555',
    });

    expect(result).toMatchObject({ isMember: true, verified: true, level: 'gold' });
    expect(
      urls.some((u) =>
        u.includes('/hubdb/tables/acme_directory/rows?crm_company__eq=555&live__eq=true'),
      ),
    ).toBe(true);
    expectNoWeldNames(urls);
  });

  it('reads the contact status and level from config in resolveMembershipProfile', async () => {
    const portalId = freshPortal();
    await seedTenant(E.DB, portalId, ACME);
    const urls = stubHubSpot({
      contact: { acme_member_status: 'Active', acme_member_level: 'Gold' },
    });

    const profile = await resolveMembershipProfile(envWithKey(portalId), portalId, 'x@example.com');

    expect(profile).toEqual({ status: 'member', memberTier: 'Gold', isGoldMember: true });
    expectNoWeldNames(urls);
  });

  it('reads a malformed source column as not configured', async () => {
    const portalId = freshPortal();
    await seedTenant(E.DB, portalId, {
      membership_company_sources: '[{"category":"corporate"',
      member_directory_config: JSON.stringify({ table: 'acme_directory' }),
    });

    const config = await loadMembershipConfig(E, portalId);

    expect(config.companySources).toEqual([]);
    expect(config.memberDirectory).toBeNull();
  });
});

describe('the 0046 backfill', () => {
  // The shipped statement, scoped to this test's rows: unscoped it would rewrite every
  // tenant in the shared database, which is what it does in production and exactly what a
  // test must not.
  const scoped = `${BACKFILL_0046.trim().replace(/;$/, '')} WHERE portal_id IN (?1, ?2)`;

  it("copies Weld's names onto an existing tenant and keeps a chosen status property", async () => {
    const plain = freshPortal();
    const chosen = freshPortal();
    await seedTenant(E.DB, plain);
    await seedTenant(E.DB, chosen, {
      membership_status_property: 'acme_status',
      membership_level_property: 'acme_level',
    });

    await E.DB.prepare(scoped).bind(plain, chosen).run();

    const plainConfig = await loadMembershipConfig(E, plain);
    expect(plainConfig).toMatchObject({
      statusProperty: 'individual_membership_status',
      levelProperty: 'individual_membership_type_2',
      mirrorStatusProperty: 'wa_company_membership_status',
      mirrorTierProperty: 'wa_company_membership_tier',
    });
    // The same values the fixtures give a Weld-shaped test tenant, so the tests that use
    // the fixture prove what production runs.
    expect(plainConfig.companySources).toEqual(
      JSON.parse(String(WELD_MEMBERSHIP_SOURCE_COLUMNS.membership_company_sources)),
    );
    expect(plainConfig.memberDirectory).toEqual(
      JSON.parse(String(WELD_MEMBERSHIP_SOURCE_COLUMNS.member_directory_config)),
    );

    const chosenConfig = await loadMembershipConfig(E, chosen);
    expect(chosenConfig.statusProperty).toBe('acme_status');
    expect(chosenConfig.levelProperty).toBe('acme_level');
    expect(chosenConfig.companySources).toHaveLength(2);
  });
});

describe('PATCH /onboarding/membership-config', () => {
  function request(portalId: string, method: 'PATCH' | 'GET', path: string, body?: unknown) {
    const adminKey = `admin-${portalId}`;
    return manageRoutes.request(
      path,
      {
        method,
        headers: {
          Authorization: `Bearer ${adminKey}`,
          'X-Portal-Id': portalId,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      {
        ...(E as unknown as Record<string, unknown>),
        [`ADMIN_API_KEY_${portalId}`]: adminKey,
      } as unknown as Env,
    );
  }
  const patch = (portalId: string, body: unknown) =>
    request(portalId, 'PATCH', '/onboarding/membership-config', body);

  const WELD_BODY = {
    companySources: [
      {
        category: 'corporate',
        statusProperty: 'corporate_membership_status',
        levelProperty: 'corporate_membership_level_2',
      },
      {
        category: 'industry_supplier',
        statusProperty: 'industry_supplier_membership_status',
        levelProperty: 'industry_supplier_membership_level_2',
      },
    ],
    mirrorStatusProperty: 'wa_company_membership_status',
    mirrorTierProperty: 'wa_company_membership_tier',
    memberDirectory: {
      table: 'members',
      emailColumn: 'contact_email',
      tierColumn: 'member_tier',
      activeColumn: 'is_active',
      companyIdColumn: 'hubspot_company_id',
    },
  };

  it('stores the sources and reports them back on GET /onboarding', async () => {
    const portalId = freshPortal();
    await seedTenant(E.DB, portalId);

    const res = await patch(portalId, WELD_BODY);
    expect(res.status).toBe(200);

    const onboarding = (await (await request(portalId, 'GET', '/onboarding')).json()) as {
      membership: Record<string, unknown>;
    };
    expect(onboarding.membership).toMatchObject(WELD_BODY);
  });

  it('clears a source with null, which stops it being read', async () => {
    const portalId = freshPortal();
    await seedTenant(E.DB, portalId);
    await patch(portalId, WELD_BODY);

    const res = await patch(portalId, {
      companySources: null,
      mirrorTierProperty: null,
      memberDirectory: null,
    });
    expect(res.status).toBe(200);

    const config = await loadMembershipConfig(E, portalId);
    expect(config.companySources).toEqual([]);
    expect(config.mirrorTierProperty).toBeNull();
    expect(config.mirrorStatusProperty).toBe('wa_company_membership_status');
    expect(config.memberDirectory).toBeNull();
  });

  it.each([
    ['not an array', { companySources: { category: 'corporate' } }, 'invalid_company_sources'],
    [
      'an unknown category',
      { companySources: [{ category: 'gold', statusProperty: 'a_status', levelProperty: null }] },
      'invalid_company_sources',
    ],
    [
      'a missing status property',
      { companySources: [{ category: 'corporate', levelProperty: 'a_level' }] },
      'invalid_company_sources',
    ],
    [
      'a label where a name belongs',
      { companySources: [{ category: 'corporate', statusProperty: 'Membership Status' }] },
      'invalid_company_sources',
    ],
    ['a non-string mirror', { mirrorTierProperty: 42 }, 'invalid_mirror_property'],
    [
      'a directory missing a column',
      { memberDirectory: { table: 'members', emailColumn: 'contact_email' } },
      'invalid_member_directory',
    ],
  ])('refuses %s with a named status and writes nothing', async (_, body, status) => {
    const portalId = freshPortal();
    await seedTenant(E.DB, portalId);

    const res = await patch(portalId, { ...body, membershipStatusProperty: 'should_not_land' });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { status: string }).status).toBe(status);
    expect((await loadMembershipConfig(E, portalId)).statusProperty).toBeNull();
  });
});
