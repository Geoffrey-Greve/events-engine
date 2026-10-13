import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { corporateTeamRoutes } from '../src/routes/corporate-team';
import type { Env } from '../src/types';
import { seedTenant } from './support/fixtures';

const PORTAL = '441838610';
const COMPANY = '1001';
const ACTOR = '2001';
const EMPLOYEE = '3001';
const SESSION = 'course-session-45214';

const E = {
  ...(env as unknown as Record<string, unknown>),
  [`HUBSPOT_API_KEY_${PORTAL}`]: 'hs-test-token',
} as unknown as Env;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installHubSpotMock(options: {
  vouchersTotal: string;
  vouchersUsed: string;
  employeeLinked?: boolean;
}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (
      method === 'GET' &&
      url.includes(`/crm/v4/objects/contacts/${ACTOR}/associations/companies`)
    ) {
      return json({
        results: [
          {
            toObjectId: COMPANY,
            types: [{ category: 'USER_DEFINED', typeId: 99, label: 'Primary Admin' }],
          },
        ],
      });
    }

    if (
      method === 'GET' &&
      url.includes(`/crm/v4/objects/companies/${COMPANY}/associations/contacts`)
    ) {
      return json({
        results:
          options.employeeLinked === false
            ? []
            : [
                {
                  toObjectId: EMPLOYEE,
                  types: [{ category: 'HUBSPOT_DEFINED', typeId: 1, label: null }],
                },
              ],
      });
    }

    if (method === 'GET' && url.includes(`/crm/v3/objects/companies/${COMPANY}`)) {
      return json({
        id: COMPANY,
        properties: {
          name: 'Refuel Creative',
          vouchers_total: options.vouchersTotal,
          vouchers_used: options.vouchersUsed,
        },
      });
    }

    if (method === 'GET' && url.includes(`/crm/v3/objects/contacts/${EMPLOYEE}`)) {
      return json({
        id: EMPLOYEE,
        properties: {
          email: 'melwyn+45214-test@refuelcreative.com.au',
          firstname: 'Melwyn',
          lastname: 'Test',
          individual_membership_type_2: 'Corporate',
        },
      });
    }

    if (method === 'GET' && url.includes(`/crm/v3/objects/contacts/${ACTOR}`)) {
      return json({
        id: ACTOR,
        properties: {
          email: 'admin@refuelcreative.com.au',
          firstname: 'Dana',
          lastname: 'Admin',
          individual_membership_type_2: 'Corporate',
        },
      });
    }

    return json({ message: `Unhandled HubSpot mock: ${method} ${url}` }, 500);
  });

  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function bulkRegisterRequest(overrides: Record<string, unknown> = {}) {
  return corporateTeamRoutes.request(
    '/bulk-register',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Portal-Id': PORTAL,
        'Idempotency-Key': 'bulk-test-key',
      },
      body: JSON.stringify({
        portalId: PORTAL,
        companyId: COMPANY,
        actorContactId: ACTOR,
        sessionId: SESSION,
        workerEventId: 'evt_cert10_online',
        ticketTypeId: 'tt_member',
        employeeIds: [EMPLOYEE],
        session: {
          courseName: 'Welding Supervisor',
          city: 'Online',
          startDate: '20 Aug 2026',
        },
        ...overrides,
      }),
    },
    E,
  );
}

beforeEach(async () => {
  vi.unstubAllGlobals();
  await seedTenant(E.DB, PORTAL);
  // Voucher usage is derived from D1, so each case starts from a clean baseline. Scoped
  // to this file's portal: the database is shared with every other suite in the run.
  await E.DB.prepare('DELETE FROM corporate_team_audit WHERE portal_id = ?1').bind(PORTAL).run();
  await E.DB.prepare('DELETE FROM corporate_voucher_accounts WHERE portal_id = ?1')
    .bind(PORTAL)
    .run();
  await E.DB.prepare('DELETE FROM registrations WHERE portal_id = ?1').bind(PORTAL).run();
  await E.DB.prepare('DELETE FROM orders WHERE portal_id = ?1').bind(PORTAL).run();
});

describe('POST /corporate/bulk-register', () => {
  it('validates a dry run without creating deals or updating voucher usage', async () => {
    const fetchMock = installHubSpotMock({ vouchersTotal: '2', vouchersUsed: '0' });

    const res = await bulkRegisterRequest({ dryRun: true });
    expect(res.status).toBe(200);

    const body = await res.json<{
      ok: boolean;
      status: string;
      dryRun: boolean;
      wouldRegister: Array<{ employeeId: string; email: string }>;
      registered: unknown[];
      vouchers: { metered: boolean; remaining: number | null };
    }>();
    expect(body.ok).toBe(true);
    expect(body.status).toBe('dry_run');
    expect(body.dryRun).toBe(true);
    expect(body.wouldRegister).toEqual([
      {
        employeeId: EMPLOYEE,
        name: 'Melwyn Test',
        email: 'melwyn+45214-test@refuelcreative.com.au',
      },
    ]);
    expect(body.registered).toEqual([]);
    expect(body.vouchers).toMatchObject({ metered: true, remaining: 2 });

    const writeCalls = fetchMock.mock.calls.filter(([input, init]) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      return method !== 'GET' && url.includes('api.hubapi.com');
    });
    expect(writeCalls).toEqual([]);
  });

  it('blocks live registration when Event Engine ids are missing', async () => {
    const res = await bulkRegisterRequest({ workerEventId: '', ticketTypeId: '' });
    expect(res.status).toBe(400);

    const body = await res.json<{ ok: boolean; status: string; message: string }>();
    expect(body.ok).toBe(false);
    expect(body.status).toBe('missing_event_engine_config');
  });

  it('no longer blocks when the voucher allocation is exhausted — the seats are invoiced', async () => {
    // Vouchers are credit, not a quota: an exhausted balance covers nothing and the booking
    // proceeds to the normal reserve/payment path, rather than being rejected outright as it
    // was before redemption existed.
    installHubSpotMock({ vouchersTotal: '1', vouchersUsed: '1' });

    const res = await bulkRegisterRequest();

    const body = await res.json<{ status?: string }>();
    expect(body.status).not.toBe('insufficient_vouchers');
  });

  it('reports an exhausted balance as nothing remaining on a dry run', async () => {
    installHubSpotMock({ vouchersTotal: '1', vouchersUsed: '1' });

    const res = await bulkRegisterRequest({ dryRun: true });
    expect(res.status).toBe(200);

    const body = await res.json<{
      vouchers: { remaining: number; metered: boolean; wouldCoverSeats: number | null };
    }>();
    expect(body.vouchers).toMatchObject({ remaining: 0, metered: true, wouldCoverSeats: 0 });
  });

  it('reports how many seats vouchers would cover on a dry run', async () => {
    installHubSpotMock({ vouchersTotal: '5', vouchersUsed: '1' });

    const res = await bulkRegisterRequest({ dryRun: true });
    const body = await res.json<{
      vouchers: { remaining: number; wouldCoverSeats: number | null };
    }>();

    // 4 left, 1 employee selected — coverage is capped by the booking, not the balance.
    expect(body.vouchers).toMatchObject({ remaining: 4, wouldCoverSeats: 1 });
  });
});

describe("the team list reads the tenant's own membership level property", () => {
  // Display only (membership_tier on Manage My Team), but it was the last Weld property
  // name hard-coded in the worker. It now follows membership-config's level property.
  async function withLevelProperty<T>(value: string | null, run: () => Promise<T>): Promise<T> {
    const before = await E.DB.prepare(
      'SELECT membership_level_property AS v FROM tenants WHERE portal_id = ?1',
    )
      .bind(PORTAL)
      .first<{ v: string | null }>();
    await E.DB.prepare('UPDATE tenants SET membership_level_property = ?1 WHERE portal_id = ?2')
      .bind(value, PORTAL)
      .run();
    try {
      return await run();
    } finally {
      await E.DB.prepare('UPDATE tenants SET membership_level_property = ?1 WHERE portal_id = ?2')
        .bind(before?.v ?? null, PORTAL)
        .run();
    }
  }

  const contactReads = (fetchMock: ReturnType<typeof installHubSpotMock>) =>
    fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.includes(`/crm/v3/objects/contacts/${EMPLOYEE}`));

  it('requests the mapped property, not a Weld name', async () => {
    const fetchMock = installHubSpotMock({ vouchersTotal: '2', vouchersUsed: '0' });
    await withLevelProperty('acme_member_level', async () => bulkRegisterRequest({ dryRun: true }));

    const reads = contactReads(fetchMock);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((url) => url.includes('acme_member_level'))).toBe(true);
    expect(reads.some((url) => url.includes('individual_membership_type_2'))).toBe(false);
  });

  it('requests no level property at all for a portal that has not mapped one', async () => {
    const fetchMock = installHubSpotMock({ vouchersTotal: '2', vouchersUsed: '0' });
    await withLevelProperty(null, async () => bulkRegisterRequest({ dryRun: true }));

    expect(
      contactReads(fetchMock).some((url) => url.includes('individual_membership_type_2')),
    ).toBe(false);
  });
});
