/**
 * Member price resolution.
 *
 * Order of precedence, most authoritative first:
 *
 *   1. The tenant's HubDB session row (./hubdb-pricing.ts). This is where the tenant
 *      adds their sessions and it is the number the CMS quoted the buyer, so it is the
 *      number we must charge. Configured per tenant by migrations 0035 (the courses
 *      table) and 0044 (the events table, and per-tier DISCOUNT columns); tenants with no
 *      HubDB table configured skip straight to (2). A tenant may configure several
 *      tables - the row is taken from the first source that holds one for this event.
 *   2. `pricing_rules` in D1 — most-specific first: ticket_type > event > portal — matched
 *      on (member_level, member_category). A member_category of "member" is the generic
 *      fallback for portals that only expose a membership level/tier, and a member_level
 *      of "member" is the generic fallback tried after the buyer's own tier: it covers a
 *      member whose tier we could not resolve AND a course priced at a single member
 *      rate, which is how the HubDB sync writes a row carrying only `price_member`.
 *      fixed_price_cents (if set) is an absolute member price; otherwise
 *      discount_percent comes off the standard price.
 *   3. The ticket type's own price_cents.
 *
 * Non-members always pay the STANDARD price and never consult the member columns or the
 * pricing rules - but the standard price is read from the same HubDB row (1) before
 * falling back to the ticket type's `price_cents` (3). It used to come straight from (3),
 * which left the public price as the one number the Worker still kept its own copy of:
 * the CMS quoted the buyer from HubDB and the invoice was raised from D1, with nothing
 * reconciling the two and nothing refusing the difference (a guest's quote only measures;
 * see `quotedUnitCents` in reserve.ts). Because the CMS adds GST on top of what it
 * displays and HubSpot adds the portal's rate on top of what we invoice, a disagreement
 * between those two stores about whether a price includes tax reaches the buyer as GST
 * charged twice.
 *
 * All amounts are integer cents AUD (CLAUDE.md invariant).
 */

import type { TicketTypeRow } from './db';
import {
  loadHubDbPricingSources,
  resolveHubDbMemberPrice,
  resolveHubDbPublishedPrices,
  resolveHubDbStandardPrice,
} from './hubdb-pricing';
import { resolveHubSpotReadToken } from './membership';
import type { Env } from './types';

/**
 * `pricing_rules.member_level` used for a member whose tier could not be resolved.
 * Without this a tier-less member fell through to the standard (public) price while the
 * CMS quoted them the generic member rate — a guaranteed `price_mismatch` at reserve.
 */
const GENERIC_MEMBER_LEVEL = 'member';

export interface PricingRuleRow {
  id: string;
  portal_id: string;
  scope: string;
  scope_id: string | null;
  member_level: string;
  member_category: string;
  discount_percent: number | null;
  fixed_price_cents: number | null;
  created_at: string;
}

export interface ResolvePriceArgs {
  portalId: string;
  eventId: string;
  /**
   * `events.hubspot_event_id`. Used only as a secondary way to find the HubDB course
   * row when its `worker_event_id` cell was never filled in — see ./hubdb-pricing.ts.
   */
  hubspotEventId?: string | null;
  ticketType: TicketTypeRow;
  isMember: boolean;
  level: string | null;
  category: string | null;
}

/** Resolve the price (cents) a buyer pays for one seat of `ticketType`. */
export async function resolvePrice(env: Env, args: ResolvePriceArgs): Promise<number> {
  const { portalId, eventId, hubspotEventId, ticketType, isMember, level, category } = args;
  const fallbackStandard = ticketType.price_cents;

  if (!isMember) {
    // A MEMBER-ONLY ticket type is never priced from the public column, whichever HubDB
    // table the row is in. `resolveHubDbStandardPrice` answers half of this itself, off the
    // row's own `member_ticket_type_id` - but that column exists on Weld's `courses` table
    // and on nothing else, so from 0044 the guard has to be askable of D1 too. Reaching
    // here on a member-only ticket means the CMS and this worker disagree about the buyer's
    // membership; repricing the seat at the public rate turns that disagreement into a
    // refused checkout, which `GET /manage/diagnostics/pricing` exists to surface instead.
    if (ticketType.member_only) return fallbackStandard;

    const publicFromHubDb = await resolveHubDbPrice(env, portalId, eventId, hubspotEventId, {
      audience: 'standard',
      ticketTypeId: ticketType.id,
    });
    return publicFromHubDb ?? fallbackStandard;
  }

  const fromHubDb = await resolveHubDbPrice(env, portalId, eventId, hubspotEventId, {
    audience: 'member',
    level,
  });
  if (fromHubDb != null) return fromHubDb;

  // The member fallback chain still discounts off the ticket type's own price, not off a
  // public price read from HubDB: `pricing_rules` percentages were written against it.
  const standard = fallbackStandard;

  const rule = await loadApplicableRule(env, portalId, eventId, ticketType.id, level, category);
  if (!rule) return standard;

  if (rule.fixed_price_cents != null) return Math.max(0, Math.round(rule.fixed_price_cents));
  if (rule.discount_percent != null) {
    const discounted = standard * (1 - rule.discount_percent / 100);
    return Math.max(0, Math.round(discounted));
  }
  return standard;
}

/**
 * What to charge a VERIFIED MEMBER when our price and the page's disagree.
 *
 * The reserve guard is directional: resolved below the quote is honoured, resolved above
 * it refuses (`price_mismatch`, "The course price changed before checkout"). That is the
 * right shape for a stale page, and the wrong one for the failure that actually keeps
 * reaching Weld's members - the CMS and this worker resolving the buyer's membership LEVEL
 * differently off the same CRM, picking different columns on the same HubDB row, and the
 * higher one refusing the booking. The buyer is a member, the page quoted them a real
 * member rate, and the sentence they get names a price change that never happened and
 * gives them nothing to do about it. It recurs because it is a CONFIGURATION disagreement
 * (which property holds the tier, which record carries it) that no amount of code parity
 * on either side can settle.
 *
 * So a quote the tenant PUBLISHED on that row is honoured rather than refused:
 *
 *   resolved <= quoted            → resolved. Unchanged: never charge more than displayed.
 *   quoted is a published price   → quoted. The buyer pays the rate they were shown.
 *   otherwise                     → resolved, and the guard refuses as before.
 *
 * Three things keep this from being "the client sets the price":
 *
 *   - **Verified members only.** A guest, and anyone whose membership the worker could not
 *     confirm, is untouched by this - their disagreement is about MEMBERSHIP, and dressing
 *     it up as a price would sell a member rate to someone who has not been shown to hold
 *     one. The member-only gates upstream are unchanged.
 *   - **A published price only.** The candidate set is read off the buyer's own session row
 *     (`resolveHubDbPublishedPrices`), so the worst a wrong level can cost is another of
 *     this session's own advertised rates. A caller cannot name a number; it can only
 *     match one the tenant wrote.
 *   - **It is louder, not quieter.** The caller logs `member_quote_reconciled` with both
 *     figures and the level we resolved, so the underlying mapping fault is still there to
 *     be found - it just stops being found by a customer.
 *
 * Pure, so the rule is testable without a network.
 */
export function reconcileMemberQuote(input: {
  resolvedCents: number;
  quotedCents: number | undefined;
  publishedCents: number[];
}): { chargeCents: number; reconciled: boolean } {
  const { resolvedCents, quotedCents, publishedCents } = input;
  if (typeof quotedCents !== 'number' || !Number.isFinite(quotedCents)) {
    return { chargeCents: resolvedCents, reconciled: false };
  }
  if (resolvedCents <= quotedCents) return { chargeCents: resolvedCents, reconciled: false };
  if (!publishedCents.includes(quotedCents)) {
    return { chargeCents: resolvedCents, reconciled: false };
  }
  return { chargeCents: quotedCents, reconciled: true };
}

/**
 * The prices the buyer's own session row publishes, for `reconcileMemberQuote` to check a
 * quote against. Empty whenever we cannot read the row, which leaves the guard exactly as
 * it was: unable to confirm a quote is the tenant's own is never permission to charge it.
 */
export async function loadPublishedPrices(
  env: Env,
  portalId: string,
  eventId: string,
  hubspotEventId: string | null | undefined,
): Promise<number[]> {
  try {
    const sources = await loadHubDbPricingSources(env, portalId);
    if (sources.length === 0) return [];

    const token = await resolveHubSpotReadToken(env, portalId);
    if (!token) return [];

    return await resolveHubDbPublishedPrices({
      sources,
      token,
      eventId,
      hubspotEventId,
      portalId,
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'warn',
        event: 'hubdb_published_prices_failed',
        portalId,
        eventId,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return [];
  }
}

/**
 * HubDB lookup, wrapped so that no failure mode here can fail a booking: an
 * unconfigured tenant, a missing row, an expired token or a HubSpot outage all return
 * null and let the caller fall through to `pricing_rules`.
 */
async function resolveHubDbPrice(
  env: Env,
  portalId: string,
  eventId: string,
  hubspotEventId: string | null | undefined,
  audience:
    | { audience: 'member'; level: string | null }
    | { audience: 'standard'; ticketTypeId: string },
): Promise<number | null> {
  try {
    const sources = await loadHubDbPricingSources(env, portalId);
    if (sources.length === 0) return null;

    const token = await resolveHubSpotReadToken(env, portalId);
    if (!token) return null;

    if (audience.audience === 'standard') {
      return await resolveHubDbStandardPrice({
        sources,
        token,
        eventId,
        hubspotEventId,
        portalId,
        ticketTypeId: audience.ticketTypeId,
      });
    }

    return await resolveHubDbMemberPrice({
      sources,
      token,
      eventId,
      hubspotEventId,
      level: audience.level,
      portalId,
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'warn',
        event: 'hubdb_pricing_failed',
        portalId,
        eventId,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}

/**
 * Most-specific-first lookup: ticket_type → event → portal default.
 *
 * Within each scope, the buyer's own level is tried before the generic `member` level,
 * and their own category before the generic `member` category. The level fallback is
 * what makes the fallback path actually usable: a HubDB row that prices only
 * `price_member` syncs to one rule at member_level = 'member' (see the sync in
 * routes/manage.ts), so a Gold buyer querying `gold` alone would find nothing and drop
 * to the public price — a guaranteed `price_mismatch` at exactly the moment the HubDB
 * read failed and the fallback was supposed to save the booking.
 */
async function loadApplicableRule(
  env: Env,
  portalId: string,
  eventId: string,
  ticketTypeId: string,
  level: string | null,
  category: string | null,
): Promise<PricingRuleRow | null> {
  const levels = Array.from(new Set([level, GENERIC_MEMBER_LEVEL].filter(Boolean))) as string[];
  const categories = Array.from(new Set([category, 'member'].filter(Boolean))) as string[];

  const scopes: Array<[string, string | null]> = [
    ['ticket_type', ticketTypeId],
    ['event', eventId],
    ['portal', null],
  ];

  for (const [scope, scopeId] of scopes) {
    for (const candidateLevel of levels) {
      for (const candidateCategory of categories) {
        const rule = await queryRule(
          env,
          portalId,
          scope,
          scopeId,
          candidateLevel,
          candidateCategory,
        );
        if (rule) return rule;
      }
    }
  }

  return null;
}

/**
 * `pricing_rules` arrived in migration 0009. Against a database that predates it,
 * this query throws "no such table" - which, uncaught, took down the whole reserve
 * as an unhandled 500. A missing discount table means no discount, not a failed
 * booking: log it and let the caller fall through to the standard price.
 */
async function queryRule(
  env: Env,
  portalId: string,
  scope: string,
  scopeId: string | null,
  level: string,
  category: string,
): Promise<PricingRuleRow | null> {
  try {
    return await runRuleQuery(env, portalId, scope, scopeId, level, category);
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'warn',
        event: 'pricing_rules_unreadable',
        portalId,
        scope,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}

function runRuleQuery(
  env: Env,
  portalId: string,
  scope: string,
  scopeId: string | null,
  level: string,
  category: string,
): Promise<PricingRuleRow | null> {
  return env.DB.prepare(
    `SELECT * FROM pricing_rules
       WHERE portal_id = ?1 AND scope = ?2
         AND (scope_id = ?3 OR (?3 IS NULL AND scope_id IS NULL))
         AND member_level = ?4 AND member_category = ?5
       ORDER BY created_at DESC
       LIMIT 1`,
  )
    .bind(portalId, scope, scopeId, level, category)
    .first<PricingRuleRow>();
}
