/**
 * HubDB pricing (source of truth for what a buyer is charged).
 *
 * The tenant adds their sessions in HubDB — that row is what the CMS renders and what the
 * checkout tunnel quotes the buyer. Until 0035 the Worker priced the same seat from
 * `pricing_rules` in D1, a second, separately maintained copy of the same numbers. They
 * drifted, and every drift surfaced to the buyer as "The course price changed before
 * checkout" (reserve's `price_mismatch` guard).
 *
 * So we read the price from the same place the buyer read it. `pricing_rules` stays as the
 * fallback: tenants who price in D1 keep working, and a HubDB read that fails for any
 * reason degrades to the old path rather than failing the booking.
 *
 * ONE SHAPE, SEVERAL TABLES (0044). 0035 called all of this "course" pricing, and by 0044
 * that was only ever a name: nothing here is course-specific, it reads a table with an
 * event-id column and some price columns. Weld type member prices into their `events`
 * HubDB rows exactly as they do into `courses` rows, and nothing read them — QA ref 73.
 * A tenant therefore configures a LIST of sources (`loadHubDbPricingSources`) and the
 * resolver takes the first one holding a row for the event being priced. Courses and
 * events go through the same function; a third table is another row of config.
 *
 * TWO WAYS TO STATE A TIER PRICE, because tenants use both. `courses` names an absolute
 * column per tier (`price_gold_aud_ex_gst`); `events` names the public price once and
 * states each tier as a PERCENTAGE off it (`gold_discount_`). Forcing one into the other
 * would leave two columns per tier disagreeing the moment somebody edits the wrong one,
 * which is the family of fault this whole path exists to end. A source may map absolute
 * columns, discount columns, or both.
 *
 * Contract: nothing in here throws, and nothing in here returns a price it is not sure
 * about. Any missing config, missing row, blank cell or bad response returns null so the
 * caller falls through.
 */

import type { Env } from './types';

/**
 * The column holding OUR event id. This one is product-neutral — it is the Event Engine's
 * own id living in the tenant's table — so it has a default. Price column names are the
 * tenant's schema and have none: see `PRICE_COLUMN_KEYS` below.
 */
const DEFAULT_EVENT_ID_COLUMN = 'worker_event_id';

/**
 * The column naming the row's MEMBER ticket type. Defaults for the same reason
 * `DEFAULT_EVENT_ID_COLUMN` does: it holds OUR id in the tenant's table, not the tenant's
 * own data. Used only to keep the public price off a member-priced ticket - see
 * `resolveHubDbStandardPrice`.
 */
const DEFAULT_MEMBER_TICKET_COLUMN = 'member_ticket_type_id';

/**
 * The canonical member levels a row can carry a price for, in the order the pricing rules
 * are written. 'member' is the generic level used for a member whose tier could not be
 * resolved.
 */
export const MEMBER_PRICE_LEVELS = [
  'gold',
  'silver',
  'bronze',
  'student',
  'individual',
  'member',
] as const;

export type MemberPriceLevel = (typeof MEMBER_PRICE_LEVELS)[number];

/**
 * Price-column mapping keys: one per member level the chain can price, plus the public
 * column the fallback chain ends on.
 */
export const PRICE_COLUMN_KEYS = [
  'gold',
  'silver',
  'bronze',
  'student',
  'individual',
  'member',
  'nonMember',
] as const;

export type PriceColumnKey = (typeof PRICE_COLUMN_KEYS)[number];

/**
 * Discount-column mapping keys. No `nonMember`: a percentage off the public price is what
 * a discount IS, so a public discount column would be a discount off itself.
 */
export const DISCOUNT_COLUMN_KEYS = MEMBER_PRICE_LEVELS;

/**
 * Tenant's HubDB column names, keyed by what each column prices.
 *
 * Every key is OPTIONAL and there are NO built-in defaults. These are the tenant's own
 * schema, not ours: guessing them from the first tenant's table (Weld's
 * `price_gold_aud_ex_gst` and friends) would have every other portal read columns that
 * do not exist, find nothing, and fall silently back to `pricing_rules` — the stale
 * second copy this whole path exists to stop pricing from. A portal prices from HubDB
 * only for the levels it has actually mapped; an unmapped level is not read.
 */
export type HubDbPriceColumns = Partial<Record<PriceColumnKey, string>>;

/**
 * Tenant's HubDB column names holding a PERCENTAGE off the non-member price, per level.
 * Optional everywhere, defaults nowhere, for the same reason as `HubDbPriceColumns`.
 */
export type HubDbDiscountColumns = Partial<Record<MemberPriceLevel, string>>;

/** Which of the tenant's tables a source describes. Reported, never inferred. */
export type HubDbPricingSourceKind = 'courses' | 'events';

export interface HubDbPricingSource {
  kind: HubDbPricingSourceKind;
  table: string;
  eventIdColumn: string;
  columns: HubDbPriceColumns;
  discountColumns: HubDbDiscountColumns;
}

/**
 * Map a HubSpot marketing-event id back to the HubDB row id it was minted from.
 *
 * `events.hubspot_event_id` carries the row id in several shapes depending on which
 * importer created the event: a bare row id ("368236893636"), "course-session-<id>",
 * "course-<id>" or "hubdb-event-<id>". Returns null for anything else (a genuine
 * marketing-event id, a smoke-test id), which simply means this fallback does not apply.
 */
export function resolveHubDbCourseRowId(hubspotRowId: string): string | null {
  const value = hubspotRowId.trim();
  if (!value) return null;
  if (/^\d+$/.test(value)) return value;

  const prefixed = value.match(/^(?:course-session|course|hubdb-event)-(\d+)$/i);
  if (prefixed) return prefixed[1];

  return null;
}

type HubDbPricingRow = Record<string, unknown>;

/** A row, and which configured source it came out of. */
export interface HubDbPricingHit {
  source: HubDbPricingSource;
  row: HubDbPricingRow;
}

interface TenantPricingConfigRow {
  hubdb_courses_table: string | null;
  hubdb_courses_event_id_column: string | null;
  hubdb_course_price_columns: string | null;
  hubdb_course_discount_columns: string | null;
  hubdb_events_table: string | null;
  hubdb_events_event_id_column: string | null;
  hubdb_event_price_columns: string | null;
  hubdb_event_discount_columns: string | null;
}

/**
 * Every HubDB table this tenant prices from, in the order they are tried.
 *
 * Empty means "stay on the `pricing_rules` path entirely", which is both an unconfigured
 * tenant and a tenant whose tables are named but unmapped (see below).
 *
 * Courses first, because that is the table with the most rows on the one portal that has
 * both, and a source that holds the row ends the search. An event costs one extra filtered
 * HubDB read per price resolution; a course costs what it always did.
 */
export async function loadHubDbPricingSources(
  env: Env,
  portalId: string,
): Promise<HubDbPricingSource[]> {
  // The courses columns arrived in 0035 and the events columns in 0044. Against a tenants
  // table that predates either, the query throws "no such column"; a booking must not fail
  // because a tenant is mid-migration, so fall back to the 0035 set before giving up.
  let row: TenantPricingConfigRow | null = null;
  try {
    row = await env.DB.prepare(
      `SELECT hubdb_courses_table, hubdb_courses_event_id_column, hubdb_course_price_columns,
              hubdb_course_discount_columns, hubdb_events_table, hubdb_events_event_id_column,
              hubdb_event_price_columns, hubdb_event_discount_columns
         FROM tenants WHERE portal_id = ?1`,
    )
      .bind(portalId)
      .first<TenantPricingConfigRow>();
  } catch {
    row = await loadPre0044Config(env, portalId);
  }
  if (!row) return [];

  const sources: HubDbPricingSource[] = [];
  const courses = buildSource(portalId, 'courses', {
    table: row.hubdb_courses_table,
    eventIdColumn: row.hubdb_courses_event_id_column,
    priceColumns: row.hubdb_course_price_columns,
    discountColumns: row.hubdb_course_discount_columns,
  });
  if (courses) sources.push(courses);

  const events = buildSource(portalId, 'events', {
    table: row.hubdb_events_table,
    eventIdColumn: row.hubdb_events_event_id_column,
    priceColumns: row.hubdb_event_price_columns,
    discountColumns: row.hubdb_event_discount_columns,
  });
  if (events) sources.push(events);

  return sources;
}

/** 0035's columns alone, for a tenants table that has not taken 0044 yet. */
async function loadPre0044Config(
  env: Env,
  portalId: string,
): Promise<TenantPricingConfigRow | null> {
  try {
    const legacy = await env.DB.prepare(
      `SELECT hubdb_courses_table, hubdb_courses_event_id_column, hubdb_course_price_columns
         FROM tenants WHERE portal_id = ?1`,
    )
      .bind(portalId)
      .first<{
        hubdb_courses_table: string | null;
        hubdb_courses_event_id_column: string | null;
        hubdb_course_price_columns: string | null;
      }>();
    if (!legacy) return null;
    return {
      ...legacy,
      hubdb_course_discount_columns: null,
      hubdb_events_table: null,
      hubdb_events_event_id_column: null,
      hubdb_event_price_columns: null,
      hubdb_event_discount_columns: null,
    };
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'warn',
        event: 'hubdb_pricing_config_unreadable',
        portalId,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}

function buildSource(
  portalId: string,
  kind: HubDbPricingSourceKind,
  raw: {
    table: string | null;
    eventIdColumn: string | null;
    priceColumns: string | null;
    discountColumns: string | null;
  },
): HubDbPricingSource | null {
  const table = raw.table?.trim();
  if (!table) return null;

  const columns = parseColumnMap(raw.priceColumns, stripBlankColumnNames);
  const discountColumns = parseColumnMap(raw.discountColumns, stripBlankDiscountColumnNames);

  // A table with no columns mapped at all is not a configuration we can price from, and
  // there is no safe guess: reading a column name this portal does not have returns
  // nothing, which would look identical to "this session has no member price" and drop the
  // buyer to the stale `pricing_rules` copy. Name it in the log and stay on the fallback
  // path deliberately rather than by accident.
  if (Object.keys(columns).length === 0 && Object.keys(discountColumns).length === 0) {
    console.error(
      JSON.stringify({
        level: 'warn',
        event: 'hubdb_pricing_columns_unmapped',
        portalId,
        kind,
        table,
        message:
          `HubDB ${kind} table configured without price column names. ` +
          'PATCH /manage/onboarding/hubdb-pricing with priceColumns for this portal; ' +
          'pricing stays on pricing_rules until it is set.',
      }),
    );
    return null;
  }

  return {
    kind,
    table,
    eventIdColumn: raw.eventIdColumn?.trim() || DEFAULT_EVENT_ID_COLUMN,
    columns,
    discountColumns,
  };
}

function parseColumnMap<T>(stored: string | null, strip: (parsed: unknown) => T): T {
  if (!stored) return strip(null);
  try {
    return strip(JSON.parse(stored));
  } catch {
    // Malformed JSON reads exactly like no mapping at all.
    return strip(null);
  }
}

/**
 * The column mapping stored for one of this portal's tables, or null when it has none.
 *
 * Separate from `loadHubDbPricingSources` because the onboarding PATCH needs to know
 * whether a mapping already exists before it allows a table to be named, and that question
 * has an answer even for a portal with no table set yet.
 */
export async function loadHubDbPricingColumns(
  env: Env,
  portalId: string,
  kind: HubDbPricingSourceKind,
): Promise<HubDbPriceColumns | null> {
  const column = kind === 'courses' ? 'hubdb_course_price_columns' : 'hubdb_event_price_columns';
  let row: Record<string, string | null> | null = null;
  try {
    row = await env.DB.prepare(`SELECT ${column} FROM tenants WHERE portal_id = ?1`)
      .bind(portalId)
      .first();
  } catch {
    return null;
  }
  const stored = row?.[column];
  if (!stored) return null;
  try {
    const columns = stripBlankColumnNames(JSON.parse(stored));
    return Object.keys(columns).length > 0 ? columns : null;
  } catch {
    return null;
  }
}

/**
 * The price (integer cents) this member level pays for `eventId`, per HubDB.
 *
 * Mirrors the CMS's chain (`_member-pricing.html`) exactly, because agreeing with the
 * quoted number IS the job:
 *
 *   1. the level's own ABSOLUTE column, when it carries a real price;
 *   2. the level's own DISCOUNT column, applied to the non-member price;
 *   3. price_member, 4. price_individual, 5. price_non_member.
 *
 * The buyer's own tier outranks the generic member price in both of its shapes, which is
 * why (2) sits above (3): "Gold members get 20% off" is a statement about Gold, and
 * `member_price` is the fallback for a member whose tier said nothing. An absolute column
 * for the level beats a discount for the same level because it states the price directly
 * rather than deriving it.
 *
 * A level of null (a member whose tier we could not resolve) skips (1) and (2) and takes
 * the generic chain, which is what the CMS does for a member with a blank tier.
 *
 * Returns null when the tenant is not configured for HubDB pricing, no source holds the
 * row, or every candidate column is blank/zero.
 */
export async function resolveHubDbMemberPrice(args: {
  sources: HubDbPricingSource[];
  token: string;
  eventId: string;
  hubspotEventId?: string | null;
  level: string | null;
  portalId: string;
}): Promise<number | null> {
  const { sources, token, eventId, hubspotEventId, level, portalId } = args;

  const hit = await fetchPricingRow(sources, token, eventId, hubspotEventId, portalId);
  if (!hit) return null;
  const { source, row } = hit;

  if (level) {
    const exact = readDollarCell(row, columnForLevel(source.columns, level));
    if (exact != null && exact > 0) return toCents(exact);

    const discounted = applyLevelDiscount(row, source, level);
    if (discounted != null) return discounted;
  }

  // Unmapped columns are skipped, not guessed — the chain simply gets shorter.
  for (const column of [
    source.columns.member,
    source.columns.individual,
    source.columns.nonMember,
  ]) {
    const fallback = readDollarCell(row, column);
    if (fallback != null && fallback > 0) return toCents(fallback);
  }

  return null;
}

/**
 * The PUBLIC price for a session row, in cents, or null.
 *
 * Reads the `nonMember` column and nothing else. Unlike `resolveHubDbMemberPrice` there
 * is no fallback chain and no discount: a member column must never price a guest, so a row
 * with no public column mapped or no public price in it returns null and the caller keeps
 * the ticket type's own `price_cents`.
 *
 * This exists because the standard price was the one number the Worker still held a second
 * copy of. Member prices have come from the tenant's HubDB row since 0035 - the row the CMS
 * quoted the buyer from - while a guest was priced from `ticket_types.price_cents` in D1,
 * maintained separately and never reconciled. The CMS adds GST on top of the figure it
 * displays and HubSpot adds the portal's tax rate on top of the figure we invoice, so once
 * those two figures come from different stores any disagreement about the tax basis reaches
 * the buyer as GST charged twice: a page quoting $5,113.64 + $511.36 = $5,625.00 against an
 * invoice raised on a $5,625.00 line that HubSpot then grosses to $6,187.50. Nothing refuses
 * it either, because the guest checkout's quote only measures (`quotedUnitCents`; see
 * reserve.ts `evaluatePriceQuote`). One row prices both buyers now, so the invoice can only
 * add GST to the number the page showed.
 */
export async function resolveHubDbStandardPrice(args: {
  sources: HubDbPricingSource[];
  token: string;
  eventId: string;
  hubspotEventId?: string | null;
  portalId: string;
  /**
   * The ticket type being priced. The public column prices the PUBLIC ticket, so a row
   * that names its own member ticket is asked first whether this is that one.
   */
  ticketTypeId?: string;
}): Promise<number | null> {
  const { sources, token, eventId, hubspotEventId, portalId, ticketTypeId } = args;

  const hit = await fetchPricingRow(sources, token, eventId, hubspotEventId, portalId);
  if (!hit) return null;
  const { source, row } = hit;

  // A SESSION-level public price must never reprice a MEMBER-priced ticket type.
  //
  // `ticket_types.price_cents` is per ticket type; `nonMember` is one figure for the whole
  // session. Overriding one with the other is only sound for the public ticket. When the
  // two sides disagree about membership - which they do, and which is what the reserve
  // guard then reports as `price_mismatch` - a logged-in member arrives here carrying the
  // MEMBER ticket type the CMS chose for them, and pricing it off the public column
  // refuses a booking that used to go through at the member ticket's own price. The
  // membership disagreement is the fault; turning it into a refused checkout is not the
  // way to surface it (`GET /manage/diagnostics/pricing` is).
  //
  // The row is only one of the two places that guard can be answered from, and on Weld's
  // `events` table it is answered from neither: there is no member-ticket column there at
  // all. `resolvePrice` therefore refuses to call this for a `member_only` ticket type,
  // which is the half of the guard that reads D1 and works for every source.
  const memberTicketTypeId = normaliseId(row[DEFAULT_MEMBER_TICKET_COLUMN]);
  if (ticketTypeId && memberTicketTypeId && memberTicketTypeId === ticketTypeId.trim()) {
    return null;
  }

  const dollars = readDollarCell(row, source.columns.nonMember);
  if (dollars == null || dollars <= 0) return null;
  return toCents(dollars);
}

/**
 * Every member price the row PUBLISHES, in cents, for the buyer's own event.
 *
 * Not a price to charge - a set to check a quote against. The CMS and this worker each
 * resolve the buyer's membership level independently, from the same CRM but through
 * different reads, and when they land on different levels they pick different columns off
 * this row. The page quotes one, reserve resolves the other, and the buyer is told "the
 * course price changed before checkout" - a sentence about a page they never saw change,
 * naming nothing they can act on, over a disagreement that is ours.
 *
 * `reconcileMemberQuote` (../pricing.ts) uses this to honour the page's figure instead of
 * refusing, and the SET is what keeps that safe: a verified member can only ever be
 * charged a number the tenant published on the session they are buying. Nothing here can
 * invent a price, and a caller cannot name one.
 *
 * Includes the public column, because a row with no member pricing at all quotes every
 * member the public figure and that is still a published price for the session. It
 * includes every DISCOUNT-derived price too: a tier stated as "20% off" is as published as
 * one typed in dollars, and leaving those out would refuse exactly the bookings 0044 exists
 * to let through.
 */
export async function resolveHubDbPublishedPrices(args: {
  sources: HubDbPricingSource[];
  token: string;
  eventId: string;
  hubspotEventId?: string | null;
  portalId: string;
}): Promise<number[]> {
  const { sources, token, eventId, hubspotEventId, portalId } = args;

  const hit = await fetchPricingRow(sources, token, eventId, hubspotEventId, portalId);
  if (!hit) return [];
  const { source, row } = hit;

  const cents = new Set<number>();
  for (const key of PRICE_COLUMN_KEYS) {
    const dollars = readDollarCell(row, source.columns[key]);
    if (dollars != null && dollars > 0) cents.add(toCents(dollars));
  }
  for (const level of DISCOUNT_COLUMN_KEYS) {
    const discounted = applyLevelDiscount(row, source, level);
    if (discounted != null && discounted > 0) cents.add(discounted);
  }
  return [...cents];
}

/**
 * Every member level's price for one row, in cents, skipping levels the row says nothing
 * about. Unlike `resolveHubDbMemberPrice` this does NOT apply the member/individual/
 * non-member fallback chain: it reports only what the row actually states, which is what
 * the pricing_rules sync wants to mirror. A level stated as a discount is resolved to the
 * dollars it comes to, because `pricing_rules` is read without the HubDB row beside it.
 */
export function readHubDbTierPrices(
  row: HubDbPricingRow,
  source: Pick<HubDbPricingSource, 'columns' | 'discountColumns'>,
): Partial<Record<MemberPriceLevel, number>> {
  const prices: Partial<Record<MemberPriceLevel, number>> = {};
  for (const level of MEMBER_PRICE_LEVELS) {
    const dollars = readDollarCell(row, columnForLevel(source.columns, level));
    if (dollars != null && dollars > 0) {
      prices[level] = toCents(dollars);
      continue;
    }
    const discounted = applyLevelDiscount(row, source, level);
    if (discounted != null && discounted > 0) prices[level] = discounted;
  }
  return prices;
}

/**
 * The HubDB row for an event and the source it came from, or null. Exported for the
 * pricing_rules sync and the pricing diagnostic; `resolveHubDbMemberPrice` is the read
 * path used at reserve time.
 */
export async function fetchHubDbPricingRow(args: {
  sources: HubDbPricingSource[];
  token: string;
  eventId: string;
  hubspotEventId?: string | null;
  portalId: string;
}): Promise<HubDbPricingHit | null> {
  return await fetchPricingRow(
    args.sources,
    args.token,
    args.eventId,
    args.hubspotEventId,
    args.portalId,
  );
}

/** Canonical member level → the HubDB column holding that level's absolute price. */
export function columnForLevel(columns: HubDbPriceColumns, level: string): string | undefined {
  switch (level) {
    case 'gold':
      return columns.gold;
    case 'silver':
      return columns.silver;
    case 'bronze':
      return columns.bronze;
    case 'student':
      return columns.student;
    case 'individual':
      return columns.individual;
    default:
      // 'member' and anything else canonicalises to the generic member column.
      return columns.member;
  }
}

/** Canonical member level → the HubDB column holding that level's discount percentage. */
export function discountColumnForLevel(
  columns: HubDbDiscountColumns,
  level: string,
): string | undefined {
  switch (level) {
    case 'gold':
      return columns.gold;
    case 'silver':
      return columns.silver;
    case 'bronze':
      return columns.bronze;
    case 'student':
      return columns.student;
    case 'individual':
      return columns.individual;
    default:
      return columns.member;
  }
}

/**
 * This level's discount applied to the row's non-member price, in cents, or null.
 *
 * Off the NON-MEMBER price, settled with Ryan 2026-09-20: that is what "Gold members get
 * 20% off" means on a page showing one public figure, and taking it off `member_price`
 * would discount an already-discounted number.
 *
 * A percentage outside (0, 100) is IGNORED rather than honoured. 0 is "no discount
 * entered", which is the state of most rows; 100 or more would give a seat away, and a
 * cell somebody fat-fingered is far likelier than a tenant meaning it. A free seat is a
 * price of 0 in the absolute column, where it is unambiguous.
 */
function applyLevelDiscount(
  row: HubDbPricingRow,
  source: Pick<HubDbPricingSource, 'columns' | 'discountColumns'>,
  level: string,
): number | null {
  const percent = readPercentCell(row, discountColumnForLevel(source.discountColumns, level));
  if (percent == null || percent <= 0 || percent >= 100) return null;

  const base = readDollarCell(row, source.columns.nonMember);
  if (base == null || base <= 0) return null;

  return toCents(base * (1 - percent / 100));
}

/**
 * Find the HubDB row for this event across every configured source.
 *
 * Two passes, in this order, and the order matters: EVERY source is asked by its event-id
 * column before ANY source is asked for a row by id. The by-id fallback reads a row id out
 * of `hubspot_event_id`, and row ids do not say which table they belong to — asking the
 * courses table for an id that came from the events table can only mislead, so it is the
 * last thing tried rather than the second.
 */
async function fetchPricingRow(
  sources: HubDbPricingSource[],
  token: string,
  eventId: string,
  hubspotEventId: string | null | undefined,
  portalId: string,
): Promise<HubDbPricingHit | null> {
  for (const source of sources) {
    const row = await fetchRowByEventId(source, token, eventId, portalId);
    if (row) return { source, row };
  }

  // The row's `worker_event_id` may never have been filled in — most of the events that
  // were failing checkout were exactly these. Their `hubspot_event_id` still carries the
  // HubDB row id, so ask for the row directly.
  const rowId = hubspotEventId ? resolveHubDbCourseRowId(hubspotEventId) : null;
  if (!rowId) return null;

  for (const source of sources) {
    const row = await fetchRowById(source.table, token, rowId, portalId);
    if (row) return { source, row };
  }
  return null;
}

async function fetchRowByEventId(
  source: HubDbPricingSource,
  token: string,
  eventId: string,
  portalId: string,
): Promise<HubDbPricingRow | null> {
  const filtered = await fetchRows(
    source.table,
    token,
    `${encodeURIComponent(source.eventIdColumn)}__eq=${encodeURIComponent(eventId)}&limit=1`,
    portalId,
  );
  if (filtered) {
    // Filter accepted: one row, or genuinely none. Do not fall back to a scan here —
    // that would turn "this session is not in HubDB" into a full-table read per reserve.
    return filtered[0]?.values ?? null;
  }

  // Filter rejected for this portal's column config: scan the first page instead.
  const all = await fetchRows(source.table, token, 'limit=1000', portalId);
  return (
    all?.find((row) => normaliseId(row.values?.[source.eventIdColumn]) === eventId.trim())
      ?.values ?? null
  );
}

async function fetchRowById(
  table: string,
  token: string,
  rowId: string,
  portalId: string,
): Promise<HubDbPricingRow | null> {
  let resp: Response;
  try {
    resp = await fetch(
      `https://api.hubapi.com/cms/v3/hubdb/tables/${encodeURIComponent(table)}/rows/${encodeURIComponent(rowId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
  } catch {
    return null;
  }
  if (!resp.ok) {
    if (resp.status !== 404) {
      console.error(
        JSON.stringify({
          level: 'warn',
          event: 'hubdb_pricing_read_failed',
          portalId,
          table,
          rowId,
          httpStatus: resp.status,
        }),
      );
    }
    return null;
  }
  try {
    const data = (await resp.json()) as { values?: HubDbPricingRow };
    return data.values ?? null;
  } catch {
    return null;
  }
}

async function fetchRows(
  table: string,
  token: string,
  query: string,
  portalId: string,
): Promise<Array<{ values?: HubDbPricingRow }> | null> {
  let resp: Response;
  try {
    resp = await fetch(
      `https://api.hubapi.com/cms/v3/hubdb/tables/${encodeURIComponent(table)}/rows?${query}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'warn',
        event: 'hubdb_pricing_unreachable',
        portalId,
        table,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
  if (!resp.ok) {
    console.error(
      JSON.stringify({
        level: 'warn',
        event: 'hubdb_pricing_read_failed',
        portalId,
        table,
        httpStatus: resp.status,
      }),
    );
    return null;
  }
  try {
    const data = (await resp.json()) as { results?: Array<{ values?: HubDbPricingRow }> };
    return data.results ?? [];
  } catch {
    return null;
  }
}

/**
 * HubDB number cells come back as numbers, but a text column holding "$2,170.00" is a
 * perfectly ordinary way for a tenant to have set this up. Mirrors the CMS's
 * numericValue() so both sides read the same cell the same way.
 */
function readDollarCell(row: HubDbPricingRow, column: string | undefined): number | null {
  if (!column) return null;
  const raw = row[column];
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[$,\s]/g, '');
  if (!cleaned) return null;
  const amount = Number(cleaned);
  return Number.isFinite(amount) ? amount : null;
}

/**
 * A percentage cell. Same reader as a dollar cell, plus a trailing '%': a tenant typing
 * "20%" into a text column means the same thing as 20 in a number column, and reading one
 * of those as blank would quietly charge a Gold member the public price.
 */
function readPercentCell(row: HubDbPricingRow, column: string | undefined): number | null {
  if (!column) return null;
  const raw = row[column];
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[%,\s]/g, '');
  if (!cleaned) return null;
  const percent = Number(cleaned);
  return Number.isFinite(percent) ? percent : null;
}

/** HubDB prices are dollars; D1 and every invoice line are integer cents. */
function toCents(dollars: number): number {
  return Math.max(0, Math.round(dollars * 100));
}

function normaliseId(value: unknown): string {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string') return '';
  return value.trim();
}

/** Keep only the price keys we know, mapped to a non-blank column name. */
export function stripBlankColumnNames(parsed: unknown): HubDbPriceColumns {
  const out: HubDbPriceColumns = {};
  if (!parsed || typeof parsed !== 'object') return out;
  for (const key of PRICE_COLUMN_KEYS) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) out[key] = value.trim();
  }
  return out;
}

/** Keep only the discount keys we know, mapped to a non-blank column name. */
export function stripBlankDiscountColumnNames(parsed: unknown): HubDbDiscountColumns {
  const out: HubDbDiscountColumns = {};
  if (!parsed || typeof parsed !== 'object') return out;
  for (const key of DISCOUNT_COLUMN_KEYS) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) out[key] = value.trim();
  }
  return out;
}
