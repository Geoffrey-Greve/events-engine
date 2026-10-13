/**
 * A verified member is not turned away over which of the tenant's own prices they get.
 *
 * The reserve guard refuses when the worker resolves a price ABOVE the one the page
 * displayed, which is right for a stale page and wrong for the failure that keeps
 * reaching Weld's members: the CMS and the worker each resolve the buyer's membership
 * LEVEL from the same CRM through different reads, land on different levels, pick
 * different columns on the same HubDB row, and the higher one refuses the booking with
 * "The course price changed before checkout" - a sentence about a change that never
 * happened, naming nothing the buyer can do. It recurs because the disagreement is
 * CONFIGURATION (which property holds the tier, which record carries it), which no amount
 * of code parity on either side settles.
 *
 * `reconcileMemberQuote` honours the page's figure instead, bounded to the prices the
 * tenant published on that session. These pin the bounds, because the bounds are the
 * whole reason it is not "the client sets the price".
 */
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPublishedPrices, reconcileMemberQuote } from '../src/pricing';
import type { Env } from '../src/types';

const E = env as unknown as Env;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Weld's IIW Welding Inspector (Basic) row, in cents: the member tiers sit below the
// public price and a wrong level therefore reads HIGHER, which is the refusing direction.
const PUBLISHED = [217000, 225000, 230000, 235000, 253500, 255500];
const GOLD = 217000;
const PUBLIC = 255500;

describe('reconcileMemberQuote', () => {
  it('honours a published member price the worker resolved above', () => {
    // The page priced them Gold; the worker resolved no level and fell through to the
    // public column. Both numbers are the tenant's; only one was shown to the buyer.
    const result = reconcileMemberQuote({
      resolvedCents: PUBLIC,
      quotedCents: GOLD,
      publishedCents: PUBLISHED,
    });
    expect(result).toEqual({ chargeCents: GOLD, reconciled: true });
  });

  it('refuses a quote the row does not publish, however plausible', () => {
    // One dollar under Gold is not a rate anybody advertised, so the guard still refuses.
    // This is the line between honouring the tenant's price and taking the caller's.
    const result = reconcileMemberQuote({
      resolvedCents: PUBLIC,
      quotedCents: GOLD - 100,
      publishedCents: PUBLISHED,
    });
    expect(result).toEqual({ chargeCents: PUBLIC, reconciled: false });
  });

  it('refuses everything when the row could not be read', () => {
    // Being unable to confirm a quote is the tenant's own is never permission to charge
    // it: an empty set leaves the guard exactly as it was.
    expect(
      reconcileMemberQuote({ resolvedCents: PUBLIC, quotedCents: GOLD, publishedCents: [] }),
    ).toEqual({ chargeCents: PUBLIC, reconciled: false });
  });

  it('leaves a lower resolved price alone', () => {
    // Already honoured by the directional guard, and the cheaper of the two is the
    // buyer's either way. Nothing to reconcile.
    expect(
      reconcileMemberQuote({
        resolvedCents: GOLD,
        quotedCents: PUBLIC,
        publishedCents: PUBLISHED,
      }),
    ).toEqual({ chargeCents: GOLD, reconciled: false });
  });

  it('leaves an exact match alone', () => {
    expect(
      reconcileMemberQuote({ resolvedCents: GOLD, quotedCents: GOLD, publishedCents: PUBLISHED }),
    ).toEqual({ chargeCents: GOLD, reconciled: false });
  });

  it('does nothing when the page sent no price', () => {
    expect(
      reconcileMemberQuote({
        resolvedCents: PUBLIC,
        quotedCents: undefined,
        publishedCents: PUBLISHED,
      }),
    ).toEqual({ chargeCents: PUBLIC, reconciled: false });
  });
});

// ---------------------------------------------------------------------------
// The candidate set is read off the buyer's own session row.
// ---------------------------------------------------------------------------

const WELD_PRICE_COLUMNS = {
  gold: 'price_gold_aud_ex_gst',
  silver: 'price_silver_aud_ex_gst',
  bronze: 'price_bronze_aud_ex_gst',
  student: 'price_student_aud_ex_gst',
  individual: 'price_individual',
  member: 'price_member',
  nonMember: 'price_non_member',
};

const WELD_ROW = {
  worker_event_id: '',
  price_non_member: 2555,
  price_member: 2170,
  price_individual: 2350,
  price_student_aud_ex_gst: 2535,
  price_bronze_aud_ex_gst: 2300,
  price_silver_aud_ex_gst: 2250,
  price_gold_aud_ex_gst: 2170,
};

let counter = 0;
const freshIds = () => {
  const n = `${Date.now()}-${counter++}`;
  return { portalId: `rp-${n}`, eventId: `rev-${n}` };
};

async function insertTenant(
  portalId: string,
  priceColumns: unknown = WELD_PRICE_COLUMNS,
  discountColumns: unknown = null,
) {
  await E.DB.prepare(
    `INSERT INTO tenants (portal_id, hubdb_courses_table, hubdb_courses_event_id_column,
                          hubdb_course_price_columns, hubdb_course_discount_columns, display_name)
     VALUES (?1, 'courses', NULL, ?2, ?3, 'Test Tenant')`,
  )
    .bind(
      portalId,
      priceColumns == null ? null : JSON.stringify(priceColumns),
      discountColumns == null ? null : JSON.stringify(discountColumns),
    )
    .run();
}

function stubHubDb(rows: Array<Record<string, unknown>>, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (status !== 200) return new Response('nope', { status });
      const url = new URL(String(input));
      const filterKeys = [...url.searchParams.keys()].filter((k) => k.endsWith('__eq'));
      if (filterKeys.length > 0) {
        const column = filterKeys[0].replace(/__eq$/, '');
        const wanted = url.searchParams.get(filterKeys[0]);
        return Response.json({
          results: rows
            .filter((values) => String(values[column] ?? '') === wanted)
            .map((values) => ({ values })),
        });
      }
      return Response.json({ results: rows.map((values) => ({ values })) });
    }),
  );
}

function envWithKey(portalId: string): Env {
  return {
    ...(E as unknown as Record<string, unknown>),
    [`HUBSPOT_API_KEY_${portalId}`]: 'test-key',
  } as unknown as Env;
}

describe('loadPublishedPrices', () => {
  it('returns every distinct price the row states, in cents', async () => {
    const { portalId, eventId } = freshIds();
    await insertTenant(portalId);
    stubHubDb([{ ...WELD_ROW, worker_event_id: eventId }]);

    const prices = await loadPublishedPrices(envWithKey(portalId), portalId, eventId, null);

    // Gold and member hold the same figure; one candidate, not two.
    expect([...prices].sort((a, b) => a - b)).toEqual([
      217000, 225000, 230000, 235000, 253500, 255500,
    ]);
  });

  it('counts a DISCOUNT-derived price as published (0044)', async () => {
    const { portalId, eventId } = freshIds();
    // A tier stated as "20% off" is as published as one typed in dollars. Leaving these
    // out would have `reconcileMemberQuote` refuse exactly the quotes 0044 lets a tenant
    // state in the first place.
    await insertTenant(
      portalId,
      { nonMember: 'price_non_member', member: 'price_member' },
      { gold: 'gold_discount_' },
    );
    stubHubDb([{ ...WELD_ROW, worker_event_id: eventId, gold_discount_: 20 }]);

    const prices = await loadPublishedPrices(envWithKey(portalId), portalId, eventId, null);
    // $2,555 public, $2,170 member, and 20% off the public price = $2,044.
    expect([...prices].sort((a, b) => a - b)).toEqual([204400, 217000, 255500]);
  });

  it('reads only the columns the tenant mapped', async () => {
    const { portalId, eventId } = freshIds();
    await insertTenant(portalId, { gold: 'price_gold_aud_ex_gst', member: 'price_member' });
    stubHubDb([{ ...WELD_ROW, worker_event_id: eventId }]);

    const prices = await loadPublishedPrices(envWithKey(portalId), portalId, eventId, null);
    expect(prices).toEqual([217000]);
  });

  it('is empty when HubSpot cannot be read, so the guard is unchanged', async () => {
    const { portalId, eventId } = freshIds();
    await insertTenant(portalId);
    stubHubDb([], 500);

    expect(await loadPublishedPrices(envWithKey(portalId), portalId, eventId, null)).toEqual([]);
  });

  it('is empty when the event has no row in the tenant table', async () => {
    const { portalId, eventId } = freshIds();
    await insertTenant(portalId);
    stubHubDb([{ ...WELD_ROW, worker_event_id: 'some-other-event' }]);

    expect(await loadPublishedPrices(envWithKey(portalId), portalId, eventId, null)).toEqual([]);
  });

  it('is empty for a portal that priced nothing in HubDB', async () => {
    const { portalId, eventId } = freshIds();
    await insertTenant(portalId, null);
    stubHubDb([{ ...WELD_ROW, worker_event_id: eventId }]);

    expect(await loadPublishedPrices(envWithKey(portalId), portalId, eventId, null)).toEqual([]);
  });
});
