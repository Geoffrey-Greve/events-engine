import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TicketTypeRow } from '../src/db';
import { resolveHubDbCourseRowId } from '../src/hubdb-pricing';
import { resolvePrice } from '../src/pricing';
import { manageRoutes } from '../src/routes/manage';
import type { Env } from '../src/types';

// Real Workers runtime D1, HubSpot stubbed at fetch. These cover the fix for the
// `price_mismatch` errors members were hitting at checkout: the CMS quoted the member
// price from its HubDB course row while the Worker priced the same seat from
// `pricing_rules`, and any event with a missing or stale rule resolved to the standard
// price and failed the reserve. The Worker now reads the same HubDB row.

const E = env as unknown as Env;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

let counter = 0;
const freshIds = () => {
  const n = `${Date.now()}-${counter++}`;
  return { portalId: `hp-${n}`, eventId: `evt-${n}`, ttId: `tt-${n}` };
};

/**
 * `memberOnly` defaults to FALSE, which is what most of these cases are: a guest being
 * priced from the public column cannot be holding a ticket only members may buy. It was
 * hardcoded to 1 here, harmlessly, until `resolvePrice` learned to read it — the D1 half
 * of the guard that keeps a public price off a member-priced seat, needed because
 * `member_ticket_type_id` exists on Weld's courses table and on no other source.
 */
function ticketType(
  portalId: string,
  eventId: string,
  ttId: string,
  priceCents: number,
  opts: { memberOnly?: boolean } = {},
) {
  return {
    id: ttId,
    portal_id: portalId,
    event_id: eventId,
    name: opts.memberOnly ? 'Member Ticket' : 'Standard Ticket',
    price_cents: priceCents,
    currency: 'AUD',
    capacity: 100,
    tax_treatment: 'gst',
    member_only: opts.memberOnly ? 1 : 0,
    hs_tax_rate_id: null,
    hs_product_id: null,
    sort_order: 0,
    created_at: new Date().toISOString(),
  } as TicketTypeRow;
}

/**
 * Weld's live column names. These are the TENANT's schema, not a built-in default — the
 * worker ships none — so every tenant here maps them explicitly, exactly as onboarding
 * must. A portal that skips the mapping is covered by its own case below.
 */
const WELD_PRICE_COLUMNS = {
  gold: 'price_gold_aud_ex_gst',
  silver: 'price_silver_aud_ex_gst',
  bronze: 'price_bronze_aud_ex_gst',
  student: 'price_student_aud_ex_gst',
  individual: 'price_individual',
  member: 'price_member',
  nonMember: 'price_non_member',
};

/** Weld's live column shape, matching WELD_PRICE_COLUMNS. */
const WELD_ROW = {
  worker_event_id: '',
  price_non_member: 2555,
  price_member: 2280,
  price_individual: 2300,
  price_student_aud_ex_gst: 1900,
  price_bronze_aud_ex_gst: 2300,
  price_silver_aud_ex_gst: 2240,
  price_gold_aud_ex_gst: 2170,
};

async function insertTenant(args: {
  portalId: string;
  coursesTable?: string | null;
  eventIdColumn?: string | null;
  priceColumns?: unknown;
  discountColumns?: unknown;
  eventsTable?: string | null;
  eventPriceColumns?: unknown;
  eventDiscountColumns?: unknown;
}) {
  await E.DB.prepare(
    `INSERT INTO tenants (portal_id, hubdb_courses_table, hubdb_courses_event_id_column,
                          hubdb_course_price_columns, hubdb_course_discount_columns,
                          hubdb_events_table, hubdb_event_price_columns,
                          hubdb_event_discount_columns,
                          display_name)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'Test Tenant')`,
  )
    .bind(
      args.portalId,
      args.coursesTable ?? null,
      args.eventIdColumn ?? null,
      // Absent key = the ordinary case, a portal that mapped its columns at onboarding.
      // Pass `priceColumns: null` to model one that never did.
      'priceColumns' in args
        ? args.priceColumns == null
          ? null
          : JSON.stringify(args.priceColumns)
        : JSON.stringify(WELD_PRICE_COLUMNS),
      args.discountColumns == null ? null : JSON.stringify(args.discountColumns),
      args.eventsTable ?? null,
      args.eventPriceColumns == null ? null : JSON.stringify(args.eventPriceColumns),
      args.eventDiscountColumns == null ? null : JSON.stringify(args.eventDiscountColumns),
    )
    .run();
}

async function insertRule(args: {
  portalId: string;
  scope: string;
  scopeId: string | null;
  level: string;
  category: string;
  fixedPriceCents: number;
}) {
  await E.DB.prepare(
    `INSERT INTO pricing_rules
       (id, portal_id, scope, scope_id, member_level, member_category, discount_percent, fixed_price_cents, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8)`,
  )
    .bind(
      crypto.randomUUID(),
      args.portalId,
      args.scope,
      args.scopeId,
      args.level,
      args.category,
      args.fixedPriceCents,
      new Date().toISOString(),
    )
    .run();
}

/**
 * Stub the HubDB rows API. `filterSupported: false` makes the filtered read fail the way
 * a portal whose column config rejects the filter param does, so the scan path is covered.
 */
function stubHubDb(opts: {
  rows?: Array<Record<string, unknown>>;
  /** Per-table rows, for a portal configured with more than one pricing source (0044). */
  rowsByTable?: Record<string, Array<Record<string, unknown>>>;
  rowsById?: Record<string, Record<string, unknown>>;
  filterSupported?: boolean;
  status?: number;
}) {
  const { rowsByTable, rowsById = {}, filterSupported = true, status = 200 } = opts;
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (status !== 200) return new Response('nope', { status });

    const table = url.pathname.match(/\/hubdb\/tables\/([^/]+)\//)?.[1] ?? '';
    const rows = rowsByTable ? (rowsByTable[table] ?? []) : (opts.rows ?? []);

    const byIdMatch = url.pathname.match(/\/rows\/([^/]+)$/);
    if (byIdMatch) {
      const values = rowsById[byIdMatch[1]];
      if (!values) return new Response('{}', { status: 404 });
      return Response.json({ values });
    }

    const filterKeys = [...url.searchParams.keys()].filter((k) => k.endsWith('__eq'));
    if (filterKeys.length > 0) {
      if (!filterSupported) return new Response('bad filter', { status: 400 });
      const column = filterKeys[0].replace(/__eq$/, '');
      const wanted = url.searchParams.get(filterKeys[0]);
      return Response.json({
        results: rows
          .filter((values) => String(values[column] ?? '') === wanted)
          .map((values) => ({ values })),
      });
    }

    return Response.json({ results: rows.map((values) => ({ values })) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function envWithKey(portalId: string): Env {
  return {
    ...(E as unknown as Record<string, unknown>),
    [`HUBSPOT_API_KEY_${portalId}`]: 'test-key',
  } as unknown as Env;
}

describe('resolvePrice — HubDB course row is the source of truth', () => {
  it('charges the tier price from the HubDB row the CMS quoted from', async () => {
    const { portalId, eventId, ttId } = freshIds();
    await insertTenant({ portalId, coursesTable: 'courses' });
    stubHubDb({ rows: [{ ...WELD_ROW, worker_event_id: eventId }] });

    const gold = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 217000),
      isMember: true,
      level: 'gold',
      category: 'corporate',
    });
    expect(gold).toBe(217000);

    const student = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 217000),
      isMember: true,
      level: 'student',
      category: 'individual',
    });
    expect(student).toBe(190000);
  });

  it('beats a stale pricing_rules row — HubDB is what the buyer was shown', async () => {
    const { portalId, eventId, ttId } = freshIds();
    await insertTenant({ portalId, coursesTable: 'courses' });
    await insertRule({
      portalId,
      scope: 'event',
      scopeId: eventId,
      level: 'gold',
      category: 'member',
      fixedPriceCents: 999900,
    });
    stubHubDb({ rows: [{ ...WELD_ROW, worker_event_id: eventId }] });

    const price = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 255500),
      isMember: true,
      level: 'gold',
      category: 'corporate',
    });
    expect(price).toBe(217000);
  });

  it('prices a member with no resolvable tier from the generic member column', async () => {
    // This is the case that used to fall straight through to the standard price while
    // the CMS quoted price_member, producing a guaranteed price_mismatch.
    const { portalId, eventId, ttId } = freshIds();
    await insertTenant({ portalId, coursesTable: 'courses' });
    stubHubDb({ rows: [{ ...WELD_ROW, worker_event_id: eventId }] });

    const price = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 255500),
      isMember: true,
      level: null,
      category: null,
    });
    expect(price).toBe(228000);
  });

  it('falls back down the CMS chain when the tier column is blank', async () => {
    const { portalId, eventId, ttId } = freshIds();
    await insertTenant({ portalId, coursesTable: 'courses' });
    stubHubDb({
      rows: [
        {
          worker_event_id: eventId,
          price_gold_aud_ex_gst: 0,
          price_member: 0,
          price_individual: 2300,
          price_non_member: 2555,
        },
      ],
    });

    const price = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 255500),
      isMember: true,
      level: 'gold',
      category: 'corporate',
    });
    expect(price).toBe(230000);
  });

  it('reads a price stored as formatted text', async () => {
    const { portalId, eventId, ttId } = freshIds();
    await insertTenant({ portalId, coursesTable: 'courses' });
    stubHubDb({
      rows: [{ worker_event_id: eventId, price_gold_aud_ex_gst: '$2,170.00' }],
    });

    const price = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 255500),
      isMember: true,
      level: 'gold',
      category: 'corporate',
    });
    expect(price).toBe(217000);
  });

  it('finds the row by HubDB row id when worker_event_id was never filled in', async () => {
    const { portalId, eventId, ttId } = freshIds();
    await insertTenant({ portalId, coursesTable: 'courses' });
    stubHubDb({
      rows: [{ ...WELD_ROW, worker_event_id: '' }],
      rowsById: { '370245767611': { ...WELD_ROW } },
    });

    const price = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      hubspotEventId: 'course-session-370245767611',
      ticketType: ticketType(portalId, eventId, ttId, 255500),
      isMember: true,
      level: 'gold',
      category: 'corporate',
    });
    expect(price).toBe(217000);
  });

  it('scans when the portal rejects the filter param', async () => {
    const { portalId, eventId, ttId } = freshIds();
    await insertTenant({ portalId, coursesTable: 'courses' });
    stubHubDb({
      rows: [{ ...WELD_ROW, worker_event_id: eventId }],
      filterSupported: false,
    });

    const price = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 255500),
      isMember: true,
      level: 'silver',
      category: 'corporate',
    });
    expect(price).toBe(224000);
  });

  it('reads each tenant from its own column names', async () => {
    const { portalId, eventId, ttId } = freshIds();
    await insertTenant({
      portalId,
      coursesTable: 'sessions',
      eventIdColumn: 'engine_event_id',
      priceColumns: { gold: 'gold_rate' },
    });
    stubHubDb({ rows: [{ engine_event_id: eventId, gold_rate: 1500 }] });

    const price = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 255500),
      isMember: true,
      level: 'gold',
      category: 'corporate',
    });
    expect(price).toBe(150000);
  });

  it('never charges a non-member a member price', async () => {
    const { portalId, eventId, ttId } = freshIds();
    await insertTenant({ portalId, coursesTable: 'courses' });
    // Every member column on this row is cheaper than the public one, and the buyer even
    // arrives carrying a tier. The public column is the only one a guest may be priced
    // from, so none of that may reach them.
    stubHubDb({ rows: [{ ...WELD_ROW, worker_event_id: eventId }] });

    const price = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 999900),
      isMember: false,
      level: 'gold',
      category: 'corporate',
    });
    expect(price).toBe(255500);
  });

  it('charges a non-member the public price from the row the CMS quoted, not the D1 copy', async () => {
    const { portalId, eventId, ttId } = freshIds();
    await insertTenant({ portalId, coursesTable: 'courses' });
    // The shape of the GST double-charge: HubDB carries the ex-GST figure the checkout
    // displayed and added its own 10% to ($5,113.64 + $511.36 = $5,625.00), while the
    // ticket type in D1 still carries the old GST-inclusive $5,625.00. Invoicing the D1
    // copy hands HubSpot a number that already contains tax and it grosses it again, to
    // $6,187.50 - a bill 10% above the page, on a guest checkout whose quote only
    // measures and so refuses nothing.
    stubHubDb({
      rows: [{ ...WELD_ROW, worker_event_id: eventId, price_non_member: 5113.64 }],
    });

    const price = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 562500),
      isMember: false,
      level: null,
      category: null,
    });
    expect(price).toBe(511364);
  });

  it('leaves the row MEMBER ticket type on its own price, never the public column', async () => {
    const { portalId, eventId, ttId } = freshIds();
    await insertTenant({ portalId, coursesTable: 'courses' });
    // The regression this guards: `price_cents` is per ticket type and the public column
    // is one figure for the whole course, so overriding one with the other is only sound
    // for the PUBLIC ticket. When the two sides disagree about membership - which they do,
    // and which the reserve guard reports as `price_mismatch` - a logged-in member arrives
    // here carrying the member ticket the CMS chose for them, and pricing it off the
    // public column refuses a booking that went through at the member rate before.
    stubHubDb({
      rows: [{ ...WELD_ROW, worker_event_id: eventId, member_ticket_type_id: ttId }],
    });

    const price = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 217000),
      isMember: false,
      level: null,
      category: null,
    });
    expect(price).toBe(217000);
  });

  it('still prices every other ticket type from the public column', async () => {
    const { portalId, eventId, ttId } = freshIds();
    await insertTenant({ portalId, coursesTable: 'courses' });
    // The row names a DIFFERENT ticket type as its member one, so this is the public seat
    // and the GST fix applies to it in full.
    stubHubDb({
      rows: [{ ...WELD_ROW, worker_event_id: eventId, member_ticket_type_id: 'tt-member-other' }],
    });

    const price = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 999900),
      isMember: false,
      level: null,
      category: null,
    });
    expect(price).toBe(255500);
  });

  it('keeps the ticket price when the row states no public price', async () => {
    const { portalId, eventId, ttId } = freshIds();
    await insertTenant({ portalId, coursesTable: 'courses' });
    // A blank public column is not evidence the seat is free, and the member columns
    // beside it are not a guest's to be priced from. The D1 price stands.
    stubHubDb({
      rows: [{ ...WELD_ROW, worker_event_id: eventId, price_non_member: '' }],
    });

    const price = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 255500),
      isMember: false,
      level: null,
      category: null,
    });
    expect(price).toBe(255500);
  });

  it('keeps the ticket price for a non-member when HubSpot cannot be read', async () => {
    const { portalId, eventId, ttId } = freshIds();
    await insertTenant({ portalId, coursesTable: 'courses' });
    stubHubDb({ status: 500 });

    const price = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 255500),
      isMember: false,
      level: null,
      category: null,
    });
    expect(price).toBe(255500);
  });

  it('keeps the ticket price for a non-member when the portal mapped no public column', async () => {
    const { portalId, eventId, ttId } = freshIds();
    await insertTenant({
      portalId,
      coursesTable: 'courses',
      // Mapped for members, silent about the public price: the worker ships no default
      // column name, so there is nothing to read and nothing to guess.
      priceColumns: { gold: 'price_gold_aud_ex_gst', member: 'price_member' },
    });
    stubHubDb({ rows: [{ ...WELD_ROW, worker_event_id: eventId }] });

    const price = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 255500),
      isMember: false,
      level: null,
      category: null,
    });
    expect(price).toBe(255500);
  });
});

describe('resolvePrice — degrades to pricing_rules, never fails the booking', () => {
  it('uses pricing_rules when the tenant has no HubDB table configured', async () => {
    const { portalId, eventId, ttId } = freshIds();
    await insertTenant({ portalId, coursesTable: null });
    await insertRule({
      portalId,
      scope: 'event',
      scopeId: eventId,
      level: 'gold',
      category: 'member',
      fixedPriceCents: 180000,
    });
    const fetchMock = stubHubDb({ rows: [] });

    const price = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 255500),
      isMember: true,
      level: 'gold',
      category: 'corporate',
    });
    expect(price).toBe(180000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses pricing_rules when HubSpot is down', async () => {
    const { portalId, eventId, ttId } = freshIds();
    await insertTenant({ portalId, coursesTable: 'courses' });
    await insertRule({
      portalId,
      scope: 'event',
      scopeId: eventId,
      level: 'gold',
      category: 'member',
      fixedPriceCents: 180000,
    });
    stubHubDb({ status: 503 });

    const price = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 255500),
      isMember: true,
      level: 'gold',
      category: 'corporate',
    });
    expect(price).toBe(180000);
  });

  it('matches a generic member-level rule for a tier-less member', async () => {
    const { portalId, eventId, ttId } = freshIds();
    await insertTenant({ portalId, coursesTable: null });
    await insertRule({
      portalId,
      scope: 'event',
      scopeId: eventId,
      level: 'member',
      category: 'member',
      fixedPriceCents: 200000,
    });

    const price = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 255500),
      isMember: true,
      level: null,
      category: null,
    });
    expect(price).toBe(200000);
  });

  it('stays on pricing_rules when the portal named a table but mapped no columns', async () => {
    // The bug this guards: with built-in Weld column names, a portal whose table calls
    // them anything else read columns that do not exist, found nothing, and dropped to
    // pricing_rules WITHOUT anything saying so. Unmapped is now a deliberate, logged
    // fallback, and the HubDB read never happens.
    const { portalId, eventId, ttId } = freshIds();
    await insertTenant({ portalId, coursesTable: 'courses', priceColumns: null });
    await insertRule({
      portalId,
      scope: 'event',
      scopeId: eventId,
      level: 'gold',
      category: 'member',
      fixedPriceCents: 180000,
    });
    const fetchMock = stubHubDb({ rows: [{ ...WELD_ROW, worker_event_id: eventId }] });

    const price = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 255500),
      isMember: true,
      level: 'gold',
      category: 'corporate',
    });
    expect(price).toBe(180000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads only the levels a partial mapping names, and guesses none of the rest', async () => {
    const { portalId, eventId, ttId } = freshIds();
    await insertTenant({
      portalId,
      coursesTable: 'courses',
      priceColumns: { gold: 'price_gold_aud_ex_gst' },
    });
    // The row carries Weld's other columns, but this portal has not mapped them: a
    // silver buyer must not be priced from a column nobody told us about.
    stubHubDb({ rows: [{ ...WELD_ROW, worker_event_id: eventId }] });

    const gold = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 255500),
      isMember: true,
      level: 'gold',
      category: 'corporate',
    });
    expect(gold).toBe(217000);

    const silver = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 255500),
      isMember: true,
      level: 'silver',
      category: 'corporate',
    });
    expect(silver).toBe(255500);
  });

  it('falls back to a generic member rule when the tier has none of its own', async () => {
    // A course priced at a single `price_member` syncs to one rule at level 'member'.
    // Before the level fallback, a Gold buyer hitting the fallback path queried 'gold'
    // alone, found nothing and paid the public price — a price_mismatch at precisely the
    // moment HubDB was unreadable and the fallback was meant to save the booking.
    const { portalId, eventId, ttId } = freshIds();
    await insertTenant({ portalId, coursesTable: 'courses' });
    await insertRule({
      portalId,
      scope: 'event',
      scopeId: eventId,
      level: 'member',
      category: 'member',
      fixedPriceCents: 228000,
    });
    stubHubDb({ status: 503 });

    const price = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 255500),
      isMember: true,
      level: 'gold',
      category: 'corporate',
    });
    expect(price).toBe(228000);
  });

  it('prefers the buyer own tier rule over the generic member rule', async () => {
    const { portalId, eventId, ttId } = freshIds();
    await insertTenant({ portalId, coursesTable: null });
    await insertRule({
      portalId,
      scope: 'event',
      scopeId: eventId,
      level: 'member',
      category: 'member',
      fixedPriceCents: 228000,
    });
    await insertRule({
      portalId,
      scope: 'event',
      scopeId: eventId,
      level: 'gold',
      category: 'member',
      fixedPriceCents: 217000,
    });

    const price = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 255500),
      isMember: true,
      level: 'gold',
      category: 'corporate',
    });
    expect(price).toBe(217000);
  });

  it('falls back to the ticket price when the event is not in HubDB and has no rule', async () => {
    const { portalId, eventId, ttId } = freshIds();
    await insertTenant({ portalId, coursesTable: 'courses' });
    stubHubDb({ rows: [] });

    const price = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 217000),
      isMember: true,
      level: 'gold',
      category: 'corporate',
    });
    expect(price).toBe(217000);
  });
});

describe('resolveHubDbCourseRowId', () => {
  it('unwraps every id shape the importers produce', () => {
    expect(resolveHubDbCourseRowId('368236893636')).toBe('368236893636');
    expect(resolveHubDbCourseRowId('course-session-370245767611')).toBe('370245767611');
    expect(resolveHubDbCourseRowId('course-346457798095')).toBe('346457798095');
    expect(resolveHubDbCourseRowId('hubdb-event-357079452143')).toBe('357079452143');
  });

  it('returns null for ids that are not HubDB rows', () => {
    expect(resolveHubDbCourseRowId('')).toBeNull();
    expect(resolveHubDbCourseRowId('  ')).toBeNull();
    expect(resolveHubDbCourseRowId('wa-event-357079452144')).toBeNull();
    expect(resolveHubDbCourseRowId('codex-smoke-invoice-hold-20260907-1255')).toBeNull();
  });
});

describe('PATCH /onboarding/hubdb-pricing — a table arrives with its column names or not at all', () => {
  /**
   * The mapping is the tenant's schema. Letting a table be named without one produced a
   * portal that looked configured, read column names borrowed from the first tenant,
   * found nothing, and priced every member off the stale `pricing_rules` copy with no
   * error anywhere. So the refusal happens here, at the one moment a human is looking.
   */
  function adminEnv(portalId: string, adminKey: string): Env {
    return {
      ...(E as unknown as Record<string, unknown>),
      [`ADMIN_API_KEY_${portalId}`]: adminKey,
    } as unknown as Env;
  }

  function patch(portalId: string, adminKey: string, body: unknown) {
    return manageRoutes.request(
      '/onboarding/hubdb-pricing',
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminKey}`,
          'X-Portal-Id': portalId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      adminEnv(portalId, adminKey),
    );
  }

  it('refuses a courses table with no price columns mapped', async () => {
    const { portalId } = freshIds();
    await insertTenant({ portalId, coursesTable: null, priceColumns: null });

    const res = await patch(portalId, `admin-${portalId}`, { coursesTable: 'courses' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { status: string }).status).toBe('price_columns_required');

    const row = await E.DB.prepare('SELECT hubdb_courses_table FROM tenants WHERE portal_id = ?1')
      .bind(portalId)
      .first<{ hubdb_courses_table: string | null }>();
    expect(row?.hubdb_courses_table).toBeNull();
  });

  it('refuses a mapping that names no usable column', async () => {
    const { portalId } = freshIds();
    await insertTenant({ portalId, coursesTable: null, priceColumns: null });

    const res = await patch(portalId, `admin-${portalId}`, {
      coursesTable: 'courses',
      priceColumns: { gold: '   ', notALevel: 'price_gold_aud_ex_gst' },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { status: string }).status).toBe('invalid_price_columns');
  });

  it('accepts a table sent with its mapping, and stores only known keys', async () => {
    const { portalId } = freshIds();
    await insertTenant({ portalId, coursesTable: null, priceColumns: null });

    const res = await patch(portalId, `admin-${portalId}`, {
      coursesTable: 'sessions',
      eventIdColumn: 'engine_event_id',
      priceColumns: { gold: ' gold_rate ', member: 'member_rate', bogus: 'ignore_me' },
    });
    expect(res.status).toBe(200);

    const row = await E.DB.prepare(
      'SELECT hubdb_courses_table, hubdb_course_price_columns FROM tenants WHERE portal_id = ?1',
    )
      .bind(portalId)
      .first<{ hubdb_courses_table: string; hubdb_course_price_columns: string }>();
    expect(row?.hubdb_courses_table).toBe('sessions');
    expect(JSON.parse(row?.hubdb_course_price_columns ?? '{}')).toEqual({
      gold: 'gold_rate',
      member: 'member_rate',
    });
  });

  it('lets a portal that already mapped its columns change table alone', async () => {
    const { portalId } = freshIds();
    await insertTenant({ portalId, coursesTable: 'courses' });

    const res = await patch(portalId, `admin-${portalId}`, { coursesTable: 'courses_v2' });
    expect(res.status).toBe(200);
  });

  // ---- 0044: the events table is held to the same rule -------------------

  it('refuses an events table with no price columns mapped', async () => {
    const { portalId } = freshIds();
    await insertTenant({ portalId, coursesTable: null, priceColumns: null });

    const res = await patch(portalId, `admin-${portalId}`, { eventsTable: 'events' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      status: 'price_columns_required',
      table: 'events',
    });

    const row = await E.DB.prepare('SELECT hubdb_events_table FROM tenants WHERE portal_id = ?1')
      .bind(portalId)
      .first<{ hubdb_events_table: string | null }>();
    expect(row?.hubdb_events_table).toBeNull();
  });

  it('refuses discount columns with no non-member column to take them off', async () => {
    const { portalId } = freshIds();
    await insertTenant({ portalId, coursesTable: null, priceColumns: null });

    // A percentage off nothing can never apply: configuration that looks set and prices
    // nothing is the silent inertness this endpoint exists to refuse.
    const res = await patch(portalId, `admin-${portalId}`, {
      eventsTable: 'events',
      eventPriceColumns: { member: 'member_price' },
      eventDiscountColumns: { gold: 'gold_discount_' },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      status: 'discount_needs_non_member_column',
      table: 'events',
    });
  });

  it('stores both tables, and their discount columns, in one call', async () => {
    const { portalId } = freshIds();
    await insertTenant({ portalId, coursesTable: null, priceColumns: null });

    const res = await patch(portalId, `admin-${portalId}`, {
      coursesTable: 'courses',
      priceColumns: { nonMember: 'price_non_member', gold: 'price_gold_aud_ex_gst' },
      eventsTable: 'events',
      eventPriceColumns: { nonMember: 'non_member_price', member: 'member_price' },
      eventDiscountColumns: { gold: 'gold_discount_', silver: '  ' },
    });
    expect(res.status).toBe(200);

    const row = await E.DB.prepare(
      `SELECT hubdb_courses_table, hubdb_events_table, hubdb_event_price_columns,
              hubdb_event_discount_columns
         FROM tenants WHERE portal_id = ?1`,
    )
      .bind(portalId)
      .first<Record<string, string>>();
    expect(row?.hubdb_courses_table).toBe('courses');
    expect(row?.hubdb_events_table).toBe('events');
    expect(JSON.parse(row?.hubdb_event_price_columns ?? '{}')).toEqual({
      nonMember: 'non_member_price',
      member: 'member_price',
    });
    // The blank silver name is dropped, not stored: a column named '  ' reads as nothing.
    expect(JSON.parse(row?.hubdb_event_discount_columns ?? '{}')).toEqual({
      gold: 'gold_discount_',
    });
  });
});

/**
 * Weld's live `events` table: one public price, one generic member price, and each tier
 * stated as a PERCENTAGE off the public one. A different shape from `courses`, and the
 * reason 0044 is a second source rather than a second code path.
 */
const WELD_EVENT_PRICE_COLUMNS = {
  member: 'member_price',
  nonMember: 'non_member_price',
};

const WELD_EVENT_DISCOUNT_COLUMNS = {
  gold: 'gold_discount_',
  silver: 'silver_discount_',
  bronze: 'bronze_discount_',
};

const WELD_EVENT_ROW = {
  worker_event_id: '',
  non_member_price: 500,
  member_price: 450,
  gold_discount_: 20,
  silver_discount_: 10,
  bronze_discount_: 5,
};

function eventTenant(portalId: string) {
  return insertTenant({
    portalId,
    eventsTable: 'events',
    eventPriceColumns: WELD_EVENT_PRICE_COLUMNS,
    eventDiscountColumns: WELD_EVENT_DISCOUNT_COLUMNS,
  });
}

describe('the events table is a pricing source too (0044, QA ref 73)', () => {
  it('prices a member from the events row the CMS quoted, not from pricing_rules', async () => {
    const { portalId, eventId, ttId } = freshIds();
    await eventTenant(portalId);
    // The whole of ref 73: Weld type these numbers into the events row by hand and, before
    // this, nothing on the worker side ever read one.
    stubHubDb({ rowsByTable: { events: [{ ...WELD_EVENT_ROW, worker_event_id: eventId }] } });
    await insertRule({
      portalId,
      scope: 'portal',
      scopeId: null,
      level: 'member',
      category: 'member',
      fixedPriceCents: 999999,
    });

    const price = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 50000),
      isMember: true,
      level: null,
      category: null,
    });
    expect(price).toBe(45000);
  });

  it("takes a tier's discount off the NON-MEMBER price, not off the member one", async () => {
    const { portalId, eventId, ttId } = freshIds();
    await eventTenant(portalId);
    stubHubDb({ rowsByTable: { events: [{ ...WELD_EVENT_ROW, worker_event_id: eventId }] } });

    const price = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 50000),
      isMember: true,
      level: 'gold',
      category: 'corporate',
    });
    // 20% off $500, not 20% off the $450 member price ($360) and not the member price.
    expect(price).toBe(40000);
  });

  it("prefers the buyer's own tier discount over the generic member price", async () => {
    const { portalId, eventId, ttId } = freshIds();
    await eventTenant(portalId);
    // Bronze is 5% off $500 = $475, which is DEARER than the $450 generic member rate. The
    // tier is still the more specific statement about this buyer, and the page quotes it.
    stubHubDb({ rowsByTable: { events: [{ ...WELD_EVENT_ROW, worker_event_id: eventId }] } });

    const price = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 50000),
      isMember: true,
      level: 'bronze',
      category: 'corporate',
    });
    expect(price).toBe(47500);
  });

  it('lets an ABSOLUTE tier column beat a discount for the same tier', async () => {
    const { portalId, eventId, ttId } = freshIds();
    await insertTenant({
      portalId,
      eventsTable: 'events',
      eventPriceColumns: { ...WELD_EVENT_PRICE_COLUMNS, gold: 'gold_price' },
      eventDiscountColumns: WELD_EVENT_DISCOUNT_COLUMNS,
    });
    // A tenant may state both. The absolute figure is the direct statement of the price.
    stubHubDb({
      rowsByTable: {
        events: [{ ...WELD_EVENT_ROW, worker_event_id: eventId, gold_price: 399 }],
      },
    });

    const price = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 50000),
      isMember: true,
      level: 'gold',
      category: 'corporate',
    });
    expect(price).toBe(39900);
  });

  it.each([
    ['a blank cell', ''],
    ['zero', 0],
    ['a hundred percent', 100],
    ['nonsense', 'n/a'],
  ])('ignores %s in a discount column and falls through', async (_label, value) => {
    const { portalId, eventId, ttId } = freshIds();
    await eventTenant(portalId);
    // 0 is "nobody entered one", which is the state of most rows; >= 100 gives a seat away,
    // and a fat-fingered cell is far likelier than a tenant meaning it.
    stubHubDb({
      rowsByTable: {
        events: [{ ...WELD_EVENT_ROW, worker_event_id: eventId, gold_discount_: value }],
      },
    });

    const price = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 50000),
      isMember: true,
      level: 'gold',
      category: 'corporate',
    });
    expect(price).toBe(45000);
  });

  it('reads "20%" typed into a text column the same as 20 in a number one', async () => {
    const { portalId, eventId, ttId } = freshIds();
    await eventTenant(portalId);
    stubHubDb({
      rowsByTable: {
        events: [{ ...WELD_EVENT_ROW, worker_event_id: eventId, gold_discount_: '20%' }],
      },
    });

    const price = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 50000),
      isMember: true,
      level: 'gold',
      category: 'corporate',
    });
    expect(price).toBe(40000);
  });

  it('prices a guest from the events row public column', async () => {
    const { portalId, eventId, ttId } = freshIds();
    await eventTenant(portalId);
    stubHubDb({ rowsByTable: { events: [{ ...WELD_EVENT_ROW, worker_event_id: eventId }] } });

    const price = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 62500),
      isMember: false,
      level: null,
      category: null,
    });
    expect(price).toBe(50000);
  });

  it('never prices a MEMBER-ONLY ticket type off the public column', async () => {
    const { portalId, eventId, ttId } = freshIds();
    await eventTenant(portalId);
    // The events table carries no `member_ticket_type_id`, so the row cannot answer this
    // and D1 has to. Reaching here means the CMS and the worker disagree about membership;
    // repricing the seat at the public rate would turn that into a refused checkout.
    stubHubDb({ rowsByTable: { events: [{ ...WELD_EVENT_ROW, worker_event_id: eventId }] } });

    const price = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 45000, { memberOnly: true }),
      isMember: false,
      level: null,
      category: null,
    });
    expect(price).toBe(45000);
  });
});

describe('several sources, one row', () => {
  it('stops at the first source holding the row, and never reads the second', async () => {
    const { portalId, eventId, ttId } = freshIds();
    await insertTenant({
      portalId,
      coursesTable: 'courses',
      eventsTable: 'events',
      eventPriceColumns: WELD_EVENT_PRICE_COLUMNS,
    });
    const fetchMock = stubHubDb({
      rowsByTable: {
        courses: [{ ...WELD_ROW, worker_event_id: eventId }],
        events: [{ ...WELD_EVENT_ROW, worker_event_id: eventId }],
      },
    });

    const price = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 50000),
      isMember: true,
      level: 'gold',
      category: 'corporate',
    });
    expect(price).toBe(217000);
    const tablesRead = fetchMock.mock.calls.map(
      (call) => new URL(String(call[0])).pathname.split('/')[5],
    );
    expect(tablesRead).toEqual(['courses']);
  });

  it('falls through to the events table when no courses row carries the id', async () => {
    const { portalId, eventId, ttId } = freshIds();
    await insertTenant({
      portalId,
      coursesTable: 'courses',
      eventsTable: 'events',
      eventPriceColumns: WELD_EVENT_PRICE_COLUMNS,
      eventDiscountColumns: WELD_EVENT_DISCOUNT_COLUMNS,
    });
    stubHubDb({
      rowsByTable: {
        courses: [{ ...WELD_ROW, worker_event_id: 'some-other-session' }],
        events: [{ ...WELD_EVENT_ROW, worker_event_id: eventId }],
      },
    });

    const price = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      ticketType: ticketType(portalId, eventId, ttId, 50000),
      isMember: true,
      level: 'gold',
      category: 'corporate',
    });
    expect(price).toBe(40000);
  });

  it('asks every source by event id before asking any of them for a row by id', async () => {
    const { portalId, eventId, ttId } = freshIds();
    await insertTenant({
      portalId,
      coursesTable: 'courses',
      eventsTable: 'events',
      eventPriceColumns: WELD_EVENT_PRICE_COLUMNS,
    });
    // A HubDB row id says nothing about which table it belongs to, so asking `courses` for
    // an id that came out of `events` can only mislead. The by-id fallback is last.
    const fetchMock = stubHubDb({
      rowsByTable: { courses: [], events: [{ ...WELD_EVENT_ROW, worker_event_id: eventId }] },
      rowsById: { '4242': { ...WELD_ROW, price_member: 11 } },
    });

    const price = await resolvePrice(envWithKey(portalId), {
      portalId,
      eventId,
      hubspotEventId: 'course-session-4242',
      ticketType: ticketType(portalId, eventId, ttId, 50000),
      isMember: true,
      level: null,
      category: null,
    });
    expect(price).toBe(45000);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/rows/4242'))).toBe(false);
  });
});

describe('PATCH /onboarding/voucher-config — vouchers arrive mapped or off', () => {
  /**
   * Every other per-tenant mapping has had an endpoint since its feature landed; this one
   * did not, so configuring vouchers meant a hand-written UPDATE against production D1.
   *
   * And the unconfigured state is LIVE rather than inert: `loadVoucherConfig` defaults to
   * `seat` / `vouchers_total` / `vouchers_used`, so a portal that has never set this reads
   * an allowance property it does not have, resolves every company to zero, covers no
   * seats, and dies on the usage write-back. Weld's allowance is `vouchers_allowance` and
   * its usage `vouchers_used__training`. Same refusal, same reason, as the price columns
   * above.
   */
  function adminEnv(portalId: string, adminKey: string): Env {
    return {
      ...(E as unknown as Record<string, unknown>),
      [`ADMIN_API_KEY_${portalId}`]: adminKey,
    } as unknown as Env;
  }

  function patch(portalId: string, body: unknown) {
    const adminKey = `admin-${portalId}`;
    return manageRoutes.request(
      '/onboarding/voucher-config',
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminKey}`,
          'X-Portal-Id': portalId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      adminEnv(portalId, adminKey),
    );
  }

  const storedConfig = (portalId: string) =>
    E.DB.prepare(
      'SELECT voucher_mode, voucher_total_property, voucher_used_property FROM tenants WHERE portal_id = ?1',
    )
      .bind(portalId)
      .first<{
        voucher_mode: string | null;
        voucher_total_property: string | null;
        voucher_used_property: string | null;
      }>();

  /**
   * KNOWN DEFECT, recorded rather than deleted. `it.fails` inverts the result, so this
   * goes green while the guard is unreachable and RED the day somebody fixes it — at
   * which point delete the `.fails` and this comment.
   *
   * Migration 0018 ships both property columns as NOT NULL with a DEFAULT:
   *
   *     ALTER TABLE tenants ADD COLUMN voucher_total_property TEXT NOT NULL DEFAULT 'vouchers_total';
   *     ALTER TABLE tenants ADD COLUMN voucher_used_property  TEXT NOT NULL DEFAULT 'vouchers_used';
   *
   * so on a real portal `nextTotal` and `nextUsed` in `handlePatchVoucherConfig` are never
   * null, the `voucher_properties_required` branch cannot be reached, and this PATCH is
   * accepted. `describeVoucherConfig` reads `mapped` off the same two columns, so
   * `usingDefaultProperties` can never be true either — the one signal meant to say
   * "vouchers are live against names nobody chose" is silent on exactly the portals it was
   * written for, Weld among them (`vouchers_allowance` / `vouchers_used__training`).
   *
   * This passed in review because the file hand-rolled a `tenants` table whose columns were
   * nullable. It is the argument for this PR, found by it.
   *
   * The fix is a decision, not a patch: either a migration dropping those defaults, or a
   * notion of "mapped" that does not confuse a portal which genuinely uses `vouchers_total`
   * with one that never chose. Ryan's call, not this PR's.
   */
  it.fails('refuses to turn vouchers on without both property names', async () => {
    const { portalId } = freshIds();
    await insertTenant({ portalId, coursesTable: null, priceColumns: null });

    const res = await patch(portalId, { mode: 'seat' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { status: string }).status).toBe('voucher_properties_required');
    // Nothing half-written: a portal left at `seat` with no names is the fault, not the fix.
    expect((await storedConfig(portalId))?.voucher_mode).toBeNull();
  });

  it('accepts it today, which is the defect above stated as behaviour', async () => {
    const { portalId } = freshIds();
    await insertTenant({ portalId, coursesTable: null, priceColumns: null });

    const res = await patch(portalId, { mode: 'seat' });
    expect(res.status).toBe(200);
    // Vouchers left on, pointed at the names the app invented, and the flag that exists to
    // say so reads false.
    const body = (await res.json()) as {
      vouchers: { totalProperty: string; usingDefaultProperties: boolean; source: string };
    };
    expect(body.vouchers.totalProperty).toBe('vouchers_total');
    expect(body.vouchers.usingDefaultProperties).toBe(false);
    expect(body.vouchers.source).toBe('mapped');
  });

  it('refuses a mode it does not recognise', async () => {
    const { portalId } = freshIds();
    await insertTenant({ portalId, coursesTable: null, priceColumns: null });

    const res = await patch(portalId, {
      mode: 'seats',
      totalProperty: 'vouchers_allowance',
      usedProperty: 'vouchers_used__training',
    });
    expect(res.status).toBe(400);
    // Stored, an unknown mode resolves back to `seat` and spends an allowance in the wrong
    // unit, which is not something to discover from a company's balance.
    expect(((await res.json()) as { status: string }).status).toBe('invalid_mode');
  });

  it('stores a mode sent with its mapping, and echoes what the worker will read', async () => {
    const { portalId } = freshIds();
    await insertTenant({ portalId, coursesTable: null, priceColumns: null });

    const res = await patch(portalId, {
      mode: 'seat',
      totalProperty: ' vouchers_allowance ',
      usedProperty: 'vouchers_used__training',
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { vouchers: unknown }).vouchers).toEqual({
      mode: 'seat',
      totalProperty: 'vouchers_allowance',
      usedProperty: 'vouchers_used__training',
      source: 'mapped',
      usingDefaultProperties: false,
    });
    expect(await storedConfig(portalId)).toMatchObject({
      voucher_mode: 'seat',
      voucher_total_property: 'vouchers_allowance',
    });
  });

  it('lets a mapped portal switch mode on its own', async () => {
    const { portalId } = freshIds();
    await insertTenant({ portalId, coursesTable: null, priceColumns: null });
    await patch(portalId, {
      mode: 'seat',
      totalProperty: 'vouchers_allowance',
      usedProperty: 'vouchers_used__training',
    });

    // The guard is about the END state, not about this body: the names are already stored.
    const res = await patch(portalId, { mode: 'credit' });
    expect(res.status).toBe(200);
    expect((await storedConfig(portalId))?.voucher_mode).toBe('credit');
  });

  it('takes mode off with no mapping at all', async () => {
    const { portalId } = freshIds();
    await insertTenant({ portalId, coursesTable: null, priceColumns: null });

    const res = await patch(portalId, { mode: 'off' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { vouchers: { usingDefaultProperties: boolean } };
    // Off is the one state that needs no names, so the default-property flag is not a
    // finding there.
    expect(body.vouchers.usingDefaultProperties).toBe(false);
  });
});
