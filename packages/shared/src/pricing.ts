/**
 * Pricing + membership contract (Phase 18.1).
 *
 * Member pricing is tiered by the buyer's membership LEVEL + CATEGORY (cloned from the
 * company), not a single binary member price. Discount rules are resolved most-specific
 * first (ticket_type > event > portal) and matched on (level, category). This is the
 * shared shape used by the worker (resolver) and the HubSpot App Card (rule editor) so
 * the two never drift.
 */

/** GST treatment of a ticket type's invoice line. Default 'gst' (10% included). */
export type TaxTreatment = 'gst' | 'gst_free';

/**
 * True when the line should carry a 0% / no-GST rate.
 * Accepts legacy `exempt` and treats historic `gst_inclusive` (and anything else) as taxable.
 */
export function isGstFreeTreatment(taxTreatment: string | undefined | null): boolean {
  return taxTreatment === 'gst_free' || taxTreatment === 'exempt';
}

/**
 * STORED PRICES ARE TAX-EXCLUSIVE, AND THE WORKER COMPUTES NO TAX.
 *
 * A line item goes to HubSpot at the price we hold, carrying the tax rate id from the
 * portal's own tax library, and HubSpot applies that rate on top. Whatever the rate is,
 * wherever the tenant is, the number on the invoice is HubSpot's arithmetic — which is
 * the only version Data Sync can reconcile against Xero anyway.
 *
 * This used to be the other way round: prices were read as tax-INCLUSIVE and a
 * `gstExclusiveCents` helper divided by 1.1 before handing the line over, so HubSpot's
 * 10% put it back. Two faults in one. The tenant's prices are ex GST at source (Weld's
 * HubDB columns are named `price_gold_aud_ex_gst` and the website labels every price
 * "ex GST"), so every invoice came out a tax fraction short of what the buyer was
 * quoted. And the 1.1 was a hard-coded Australian 10% sitting in a multi-tenant product:
 * the moment a portal's tax library held 15% GST, 20% VAT or a US sales tax, the
 * division would have been against a rate nobody charges.
 *
 * So there is no rate constant here on purpose. If a tenant ever does enter prices
 * tax-inclusive, the answer is a tenant flag plus HubSpot's own rate — never a number
 * in this file.
 */
export const PRICES_ARE_TAX_EXCLUSIVE = true;

/** Where a pricing rule applies. Most-specific wins at resolution time. */
export type PricingScope = 'portal' | 'event' | 'ticket_type';

/** A single tiered discount rule. */
export interface PricingRule {
  id: string;
  portalId: string;
  scope: PricingScope;
  /** event_id or ticket_type_id; null for portal-default rules. */
  scopeId: string | null;
  /** Canonical membership level (tenant-defined, e.g. 'standard','premium','fellow'). */
  memberLevel: string;
  /** Canonical membership category (e.g. 'corporate','industry_supplier','individual'). */
  memberCategory: string;
  /** Percent off the standard price (0–100); applied unless fixedPriceCents is set. */
  discountPercent: number | null;
  /** Absolute member price in cents; overrides discountPercent when set. */
  fixedPriceCents: number | null;
  createdAt: string;
}

/**
 * Raw HubSpot value → canonical value maps for a tenant. Unmapped raw values fall back to
 * a normalized form (trim + lowercase + spaces→underscores) for level/category, and to
 * the built-in defaults for status.
 */
export interface MembershipValueMaps {
  /** raw membership_status value → 'member' | 'non_member' */
  status?: Record<string, 'member' | 'non_member'>;
  /** raw level-property value → canonical level */
  level?: Record<string, string>;
  /** raw category-property value → canonical category */
  category?: Record<string, string>;
}

/**
 * Resolved membership for a buyer. `verified` distinguishes an unverified membership
 * (status not yet cloned from company → support path) from a determined member/non-member.
 * level/category are canonical and only meaningful when isMember is true.
 */
export interface MembershipResult {
  isMember: boolean;
  verified: boolean;
  level: string | null;
  category: string | null;
}
