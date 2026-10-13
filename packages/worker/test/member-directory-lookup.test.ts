/**
 * Finding a buyer in the Find a Member directory.
 *
 * This read decides whether someone is quoted a member price, so it is visible to a
 * customer either as a refused member rate or as a discount they should not have had.
 * It used to be a single unfiltered `limit=1000` request scanned in memory, with no
 * paging: the day Weld's directory passes 1,000 rows, every member past that point
 * silently stops verifying. The page quotes them a member rate off HubDB and the
 * worker then prices them as a non-member, which reaches the buyer as "the course
 * price changed before checkout" and says nothing about membership.
 *
 * The fix has a constraint that rules out the obvious shortcut, and these tests pin it:
 * the email lookup must NOT filter on `is_active`. `statusFromDirectoryProfile` maps a
 * found-but-lapsed row to `non_member` (a settled answer) and a missing row to
 * `membership_unverified` (routes to support). Filtering on the flag would collapse the
 * first into the second and pour settled cases into the support queue.
 */
import { env } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveMembershipProfile } from '../src/membership';
import type { Env } from '../src/types';
import { configureWeldMembership, seedTenant } from './support/fixtures';

// The directory's table and columns are tenant configuration since 0046; this portal carries
// the Weld mapping every installed portal was backfilled with.
const PORTAL = 'mdl-weld-directory';

beforeAll(async () => {
  const db = (env as unknown as Env).DB;
  await seedTenant(db, PORTAL);
  await configureWeldMembership(db, PORTAL);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeEnv(): Env {
  return {
    ...(env as unknown as Record<string, unknown>),
    [`HUBSPOT_API_KEY_${PORTAL}`]: 'test-token',
  } as unknown as Env;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface DirectoryOptions {
  rows: Array<Record<string, unknown>>;
  /** Rows per page, so a small fixture can exercise the paging walk. */
  pageSize?: number;
  /** Simulate a portal whose column config rejects the filter param. */
  filterRejected?: boolean;
  /** Fail the page starting at this offset, to prove a partial read is not a result. */
  failPageAtOffset?: number;
}

/**
 * A HubDB stand-in that behaves like the real one in the two ways that matter:
 * `__eq` on a text column is CASE-SENSITIVE, and results are paged with a cursor.
 */
function mockDirectory(options: DirectoryOptions) {
  const { rows, pageSize = 1000, filterRejected = false, failPageAtOffset } = options;
  const urls: string[] = [];

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const raw = String(input);

    if (raw.includes('/cms/v3/hubdb/tables/members/rows')) {
      urls.push(raw);
      const url = new URL(raw);
      const emailFilter = url.searchParams.get('contact_email__eq');

      if (emailFilter !== null) {
        if (filterRejected) return json({ message: 'bad filter' }, 400);
        // Case-sensitive, exactly as HubDB is.
        const matches = rows.filter((row) => row.contact_email === emailFilter);
        return json({ results: matches.map((values) => ({ values })) });
      }

      const offset = Number(url.searchParams.get('after') ?? '0');
      if (failPageAtOffset !== undefined && offset === failPageAtOffset) {
        return json({ message: 'upstream error' }, 500);
      }
      const limit = Number(url.searchParams.get('limit') ?? String(pageSize));
      const size = Math.min(limit, pageSize);
      const page = rows.slice(offset, offset + size);
      const nextOffset = offset + size;
      return json({
        results: page.map((values) => ({ values })),
        ...(nextOffset < rows.length ? { paging: { next: { after: String(nextOffset) } } } : {}),
      });
    }

    // No CRM signal either way, so the directory is what decides.
    if (raw.includes('/crm/v3/objects/contacts/')) {
      return json({ properties: {} });
    }
    if (raw.includes('/crm/v4/objects/contacts/')) {
      return json({ results: [] });
    }
    if (raw.includes('/crm/v3/objects/companies/')) {
      return json({ properties: {} });
    }

    throw new Error(`Unexpected HubSpot URL: ${raw}`);
  });

  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, directoryUrls: urls };
}

const member = (email: string, extra: Record<string, unknown> = {}) => ({
  contact_email: email,
  member_tier: { label: 'Bronze' },
  is_active: true,
  ...extra,
});

describe('member directory lookup', () => {
  it('finds a member with one filtered request, not a table scan', async () => {
    const { directoryUrls } = mockDirectory({ rows: [member('member@example.com')] });

    await expect(
      resolveMembershipProfile(makeEnv(), PORTAL, 'member@example.com'),
    ).resolves.toMatchObject({ status: 'member', memberTier: 'Bronze' });

    expect(directoryUrls).toHaveLength(1);
    expect(directoryUrls[0]).toContain('contact_email__eq=member%40example.com');
  });

  it('never filters the email lookup on is_active', async () => {
    // Doing so would turn every lapsed member into an unverified one. Asserted on the
    // URL because the consequence shows up in a support queue, not in a return value.
    const { directoryUrls } = mockDirectory({ rows: [member('member@example.com')] });
    await resolveMembershipProfile(makeEnv(), PORTAL, 'member@example.com');
    expect(directoryUrls[0]).not.toContain('is_active');
  });

  it('answers non_member for a lapsed row, not membership_unverified', async () => {
    mockDirectory({ rows: [member('lapsed@example.com', { is_active: false })] });

    await expect(
      resolveMembershipProfile(makeEnv(), PORTAL, 'lapsed@example.com'),
    ).resolves.toMatchObject({ status: 'non_member' });
  });

  it('answers membership_unverified when the directory has no such row', async () => {
    mockDirectory({ rows: [member('someone.else@example.com')] });

    await expect(
      resolveMembershipProfile(makeEnv(), PORTAL, 'absent@example.com'),
    ).resolves.toMatchObject({ status: 'membership_unverified' });
  });

  it('finds a member past the first page when the filter misses', async () => {
    // The original bug, reproduced in miniature: the row is beyond the first page, and
    // its stored address is cased differently so the exact filter cannot match it.
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => member(`filler${i}@example.com`)),
      member('Person@Example.com', { member_tier: { label: 'Gold' } }),
    ];
    const { directoryUrls } = mockDirectory({ rows, pageSize: 2 });

    await expect(
      resolveMembershipProfile(makeEnv(), PORTAL, 'person@example.com'),
    ).resolves.toMatchObject({ status: 'member', memberTier: 'Gold', isGoldMember: true });

    // One filtered attempt, then a paged walk that did not stop at page one.
    expect(directoryUrls.filter((url) => url.includes('after=')).length).toBeGreaterThan(0);
  });

  it('walks every page rather than stopping at the first', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => member(`m${i}@example.com`));
    rows.push(member('Last@Example.com'));
    const { directoryUrls } = mockDirectory({ rows, pageSize: 3 });

    await expect(
      resolveMembershipProfile(makeEnv(), PORTAL, 'last@example.com'),
    ).resolves.toMatchObject({ status: 'member' });

    const scanUrls = directoryUrls.filter((url) => !url.includes('contact_email__eq'));
    expect(scanUrls.length).toBeGreaterThanOrEqual(3);
  });

  it('falls back to the scan when the portal rejects the filter param', async () => {
    const { directoryUrls } = mockDirectory({
      rows: [member('member@example.com')],
      filterRejected: true,
    });

    await expect(
      resolveMembershipProfile(makeEnv(), PORTAL, 'member@example.com'),
    ).resolves.toMatchObject({ status: 'member' });

    expect(directoryUrls.some((url) => !url.includes('contact_email__eq'))).toBe(true);
  });

  it('says so when the directory outgrows the scan cap', async () => {
    // A silent truncation here is the original bug wearing a larger number, so the cap
    // logs. pageSize 1 reaches the 10-page ceiling on a tiny fixture.
    const rows = Array.from({ length: 15 }, (_, i) => member(`M${i}@Example.com`));
    mockDirectory({ rows, pageSize: 1 });
    const logged: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      for (const arg of args) if (typeof arg === 'string') logged.push(arg);
    });

    await resolveMembershipProfile(makeEnv(), PORTAL, 'm14@example.com');

    expect(logged.some((line) => line.includes('member_directory_scan_truncated'))).toBe(true);
  });

  it('treats a failure mid-walk as "cannot see", never as "not there"', async () => {
    // Returning the rows gathered so far would report a member who happens to sit on
    // the failed page as absent, which is the distinction the whole path turns on.
    // Cased differently in the table, so the exact filter misses and the walk is the
    // only way to find them — and the walk fails partway.
    const rows = Array.from({ length: 5 }, (_, i) => member(`m${i}@example.com`));
    rows.push(member('Buried@Example.com'));
    mockDirectory({ rows, pageSize: 2, failPageAtOffset: 2 });

    await expect(
      resolveMembershipProfile(makeEnv(), PORTAL, 'buried@example.com'),
    ).resolves.toMatchObject({ status: 'membership_unverified' });
  });
});
