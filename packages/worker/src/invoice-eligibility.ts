/**
 * Invoice eligibility (Phase 4.2) — WHO may pay on terms.
 *
 * Phase 4.1 fixed the fault: a paid booking's seat is held to the invoice due date rather
 * than for 15 minutes, so a buyer paying by bank transfer keeps both the seat and a live
 * payment link. It fixed it for everyone. This resolves who that was actually meant for.
 *
 * Eligibility is a RULE, not a flag on a contact — auditable, per-tenant, and resolved
 * most-specific-first, exactly as `pricing_rules` is (see ./pricing.ts). The shapes differ
 * because the questions differ: pricing asks "which tier is this buyer", eligibility asks
 * "does this buyer clear a bar someone wrote down".
 *
 * SPECIFICITY, most specific first. It is a property of the KIND, not of the row, so no
 * amount of `priority` lets a portal-wide rule beat one that names an individual:
 *
 *   contact_property  → a property on the buyer's own contact
 *   company_property  → a property on the buyer's company
 *   membership_level  → the buyer's resolved membership tier
 *   always            → every buyer
 *
 * `priority` (higher first, then newest) breaks ties WITHIN a kind.
 *
 * TWO THINGS THIS MUST NOT DO.
 *
 * 1. It must not read an empty rule set as "nobody qualifies". A portal with no active
 *    rules has not configured this, and keeps its pre-4.2 behaviour — every paid booking
 *    invoice-eligible. Reading empty as "everybody pays at checkout" would put the
 *    15-minute hold back on every existing tenant the moment this deployed, which is the
 *    AWS D1.1 fault 4.1 exists to fix. A tenant opts in by writing a rule.
 *
 * 2. It must not fail a booking, and it must not turn "cannot see" into "not there". A
 *    missing table (a D1 provisioned before 0029), an unreachable HubSpot, a revoked
 *    token — all of them degrade to eligible-with-default-terms and a warning log, never
 *    to a 500 and never to a silently shortened hold. Of the two ways to be wrong, one
 *    grants a longer hold on an invoice nobody has paid (visible, reversible, and exactly
 *    what happens today); the other cancels a real booking's seat and voids its invoice
 *    fifteen minutes after a customer made it. The asymmetry is not close.
 *
 * Nothing here commits a seat. Eligibility only decides the hold's LENGTH — a hold is
 * still a hold, and seats still commit only on payment confirm (CLAUDE.md invariant).
 */

import type { MembershipResult } from '@paddock/shared';
import { resolveHubSpotReadToken } from './membership';
import type { Env } from './types';

const HS_API = 'https://api.hubapi.com';

export type InvoiceEligibilityMatchKind =
  | 'contact_property'
  | 'company_property'
  | 'membership_level'
  | 'always';

export const INVOICE_ELIGIBILITY_MATCH_KINDS: InvoiceEligibilityMatchKind[] = [
  'contact_property',
  'company_property',
  'membership_level',
  'always',
];

/** Index in this array IS the specificity rank — lower is more specific. */
const SPECIFICITY: InvoiceEligibilityMatchKind[] = INVOICE_ELIGIBILITY_MATCH_KINDS;

export interface InvoiceEligibilityRuleRow {
  id: string;
  portal_id: string;
  match_kind: string;
  match_key: string | null;
  match_value: string | null;
  terms_days: number;
  hold_ms: number | null;
  min_cents: number | null;
  priority: number;
  active: number;
  created_at: string;
}

export type PaymentMethod = 'invoice' | 'card';

export interface InvoiceEligibility {
  /** 'invoice' → held to the due date. 'card' → pays at checkout, default DO hold. */
  method: PaymentMethod;
  /** Payment terms the matched rule grants, or null to fall through to event/portal config. */
  termsDays: number | null;
  /** Explicit hold length in ms, or null to hold to the end of the invoice due date. */
  holdMs: number | null;
  /** The rule that decided this, when one did. */
  ruleId: string | null;
  /**
   * How the decision was reached. Recorded in the reserve log rather than on the order:
   * the order records what was GRANTED, which is the durable fact; why is a diagnostic.
   *   no_rules   — the portal has not configured eligibility (pre-4.2 behaviour).
   *   matched    — a rule qualified this payer.
   *   no_match   — rules exist and this payer cleared none of them.
   *   unresolved — a rule could not be evaluated; failed open (see above).
   */
  reason: 'no_rules' | 'matched' | 'no_match' | 'unresolved';
}

const ELIGIBLE_BY_DEFAULT: InvoiceEligibility = {
  method: 'invoice',
  termsDays: null,
  holdMs: null,
  ruleId: null,
  reason: 'no_rules',
};

/**
 * A hold may not outlive the payment window's own cap. Shares MAX_INVOICE_DUE_DAYS'
 * intent without importing it from the route module (which would be a cycle): reserve
 * clamps the due DATE, this clamps the millisecond form.
 */
const MAX_HOLD_MS = 90 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Rule loading
// ---------------------------------------------------------------------------

/**
 * This portal's active rules, most specific first. Returns null — distinct from an empty
 * array — when the table cannot be read at all, so the caller can tell "no rules" from
 * "no answer" (0029 postdates every existing tenant's database; Ref 217 schema drift).
 */
export async function loadInvoiceEligibilityRules(
  env: Env,
  portalId: string,
): Promise<InvoiceEligibilityRuleRow[] | null> {
  let rows: InvoiceEligibilityRuleRow[];
  try {
    const result = await env.DB.prepare(
      `SELECT * FROM invoice_eligibility_rules
        WHERE portal_id = ?1 AND active = 1`,
    )
      .bind(portalId)
      .all<InvoiceEligibilityRuleRow>();
    rows = result.results;
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'warn',
        event: 'invoice_eligibility_rules_unreadable',
        portalId,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }

  return rows
    .filter((rule) => SPECIFICITY.includes(rule.match_kind as InvoiceEligibilityMatchKind))
    .sort((a, b) => {
      const bySpecificity =
        SPECIFICITY.indexOf(a.match_kind as InvoiceEligibilityMatchKind) -
        SPECIFICITY.indexOf(b.match_kind as InvoiceEligibilityMatchKind);
      if (bySpecificity !== 0) return bySpecificity;
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
    });
}

// ---------------------------------------------------------------------------
// Value comparison
// ---------------------------------------------------------------------------

const FALSEY = new Set(['false', 'no', '0', 'off', 'none', 'null']);

function canonical(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

/**
 * Does `actual` satisfy `expected`?
 *
 * An empty `match_value` asks whether the property is SET rather than what it says — the
 * shape a plain HubSpot checkbox takes. HubSpot renders an unticked checkbox as the string
 * "false", not as an empty value, so a present-but-false property does not qualify; that is
 * the difference between "has the property" and "has it ticked", and only the second one is
 * ever what a rule means.
 */
export function matchesValue(actual: unknown, expected: string | null): boolean {
  const got = canonical(actual);
  const want = canonical(expected);
  if (want === '') return got !== '' && !FALSEY.has(got);
  return got === want;
}

// ---------------------------------------------------------------------------
// HubSpot property reads (lazy, batched, and allowed to fail)
// ---------------------------------------------------------------------------

interface PropertyLookup {
  /** null = the read was attempted and could not be completed. */
  contact: Record<string, string | undefined> | null;
  company: Record<string, string | undefined> | null;
}

/**
 * Read every contact and company property the candidate rules need, in at most one call
 * each. Rules are evaluated in specificity order, but the properties are fetched together:
 * a portal with four contact-property rules should cost one round-trip, not four.
 */
async function loadProperties(
  env: Env,
  portalId: string,
  buyerEmail: string,
  memberCompanyId: string | null,
  contactProps: string[],
  companyProps: string[],
): Promise<PropertyLookup> {
  const out: PropertyLookup = { contact: null, company: null };
  if (contactProps.length === 0 && companyProps.length === 0) {
    out.contact = {};
    out.company = {};
    return out;
  }

  const token = await resolveHubSpotReadToken(env, portalId).catch(() => null);
  if (!token) return out;

  // The buyer's contact also carries the company to fall back on: a booking that did not
  // name a memberCompanyId is still made by someone who works somewhere, and a company
  // rule is about their employer either way.
  let associatedCompanyId: string | null = memberCompanyId;
  const wantContact = contactProps.length > 0;
  const needsAssociation = companyProps.length > 0 && !memberCompanyId;

  if (wantContact || needsAssociation) {
    const props = Array.from(new Set([...contactProps, 'associatedcompanyid']))
      .map(encodeURIComponent)
      .join(',');
    try {
      const resp = await fetch(
        `${HS_API}/crm/v3/objects/contacts/${encodeURIComponent(buyerEmail)}` +
          `?idProperty=email&properties=${props}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (resp.status === 404) {
        // No contact is an ANSWER, not a failure: this buyer holds none of these
        // properties, so no contact rule qualifies them.
        out.contact = {};
      } else if (resp.ok) {
        const data = (await resp.json()) as { properties?: Record<string, string | undefined> };
        out.contact = data.properties ?? {};
        associatedCompanyId = associatedCompanyId ?? out.contact.associatedcompanyid ?? null;
      }
    } catch {
      // Leave null — unreadable, which the caller must not read as "not there".
    }
  } else {
    out.contact = {};
  }

  if (companyProps.length === 0) {
    out.company = {};
    return out;
  }
  if (!associatedCompanyId) {
    // No company to read: an answer, not a failure. A buyer with no employer on record
    // qualifies under no company rule.
    out.company = {};
    return out;
  }

  const props = companyProps.map(encodeURIComponent).join(',');
  try {
    const resp = await fetch(
      `${HS_API}/crm/v3/objects/companies/${encodeURIComponent(associatedCompanyId)}` +
        `?properties=${props}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (resp.status === 404) {
      out.company = {};
    } else if (resp.ok) {
      const data = (await resp.json()) as { properties?: Record<string, string | undefined> };
      out.company = data.properties ?? {};
    }
  } catch {
    // Leave null.
  }

  return out;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolveInvoiceEligibilityArgs {
  portalId: string;
  buyerEmail: string;
  /** Already resolved by reserve for pricing — passed in rather than re-fetched. */
  membership: MembershipResult;
  /** The company the booking named, when it named one. */
  memberCompanyId?: string | null;
  /** The booking total, against which a rule's `min_cents` floor is tested. */
  totalCents: number;
}

export async function resolveInvoiceEligibility(
  env: Env,
  args: ResolveInvoiceEligibilityArgs,
): Promise<InvoiceEligibility> {
  const { portalId, buyerEmail, membership, totalCents } = args;
  const memberCompanyId = args.memberCompanyId?.trim() || null;

  const rules = await loadInvoiceEligibilityRules(env, portalId);
  if (rules === null) return { ...ELIGIBLE_BY_DEFAULT, reason: 'unresolved' };
  if (rules.length === 0) return ELIGIBLE_BY_DEFAULT;

  // A rule whose floor this booking does not clear is not a rule about this booking.
  // Dropping it here (rather than failing it during evaluation) is what makes "gold members
  // may invoice anything; everyone else only above $1,000" two ordinary rows.
  const applicable = rules.filter((rule) => rule.min_cents == null || totalCents >= rule.min_cents);
  if (applicable.length === 0) {
    return { method: 'card', termsDays: null, holdMs: null, ruleId: null, reason: 'no_match' };
  }

  const contactProps = Array.from(
    new Set(
      applicable
        .filter((r) => r.match_kind === 'contact_property')
        .map((r) => r.match_key?.trim())
        .filter((k): k is string => Boolean(k)),
    ),
  );
  const companyProps = Array.from(
    new Set(
      applicable
        .filter((r) => r.match_kind === 'company_property')
        .map((r) => r.match_key?.trim())
        .filter((k): k is string => Boolean(k)),
    ),
  );

  const properties = await loadProperties(
    env,
    portalId,
    buyerEmail,
    memberCompanyId,
    contactProps,
    companyProps,
  );

  // A rule we could not evaluate is not a rule this payer failed. Track it, and if nothing
  // else qualifies them, fail open rather than shortening a real booking's hold on the
  // strength of a HubSpot timeout.
  let skippedUnreadable = false;

  for (const rule of applicable) {
    switch (rule.match_kind) {
      case 'always':
        return granted(rule);

      case 'membership_level': {
        // An UNVERIFIED membership is not a member and not a non-member (CLAUDE.md): it is
        // an unanswered question, and must not qualify anyone for terms on a tier we could
        // not read.
        if (!membership.verified) {
          skippedUnreadable = true;
          break;
        }
        const half =
          canonical(rule.match_key) === 'category' ? membership.category : membership.level;
        if (matchesValue(half, rule.match_value)) return granted(rule);
        break;
      }

      case 'contact_property': {
        const key = rule.match_key?.trim();
        if (!key) break; // Malformed rule: matches nothing, blocks nothing.
        if (properties.contact === null) {
          skippedUnreadable = true;
          break;
        }
        if (matchesValue(properties.contact[key], rule.match_value)) return granted(rule);
        break;
      }

      case 'company_property': {
        const key = rule.match_key?.trim();
        if (!key) break;
        if (properties.company === null) {
          skippedUnreadable = true;
          break;
        }
        if (matchesValue(properties.company[key], rule.match_value)) return granted(rule);
        break;
      }
    }
  }

  if (skippedUnreadable) {
    console.error(
      JSON.stringify({
        level: 'warn',
        event: 'invoice_eligibility_unresolved',
        portalId,
        buyerEmail,
        // Which side could not be read, so an operator can tell a token problem from a
        // membership one without reproducing the booking.
        contactReadable: properties.contact !== null,
        companyReadable: properties.company !== null,
        membershipVerified: membership.verified,
      }),
    );
    return { ...ELIGIBLE_BY_DEFAULT, reason: 'unresolved' };
  }

  return { method: 'card', termsDays: null, holdMs: null, ruleId: null, reason: 'no_match' };
}

function granted(rule: InvoiceEligibilityRuleRow): InvoiceEligibility {
  const termsDays = Number.isFinite(rule.terms_days) ? Math.trunc(rule.terms_days) : null;
  const holdMs =
    typeof rule.hold_ms === 'number' && Number.isFinite(rule.hold_ms) && rule.hold_ms > 0
      ? Math.min(Math.trunc(rule.hold_ms), MAX_HOLD_MS)
      : null;
  return {
    method: 'invoice',
    termsDays: termsDays !== null && termsDays > 0 ? termsDays : null,
    holdMs,
    ruleId: rule.id,
    reason: 'matched',
  };
}
