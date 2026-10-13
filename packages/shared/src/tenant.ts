/**
 * Per-tenant configuration contract.
 *
 * The platform is multi-tenant from day one — every row carries `portalId` and every
 * token/secret is resolved per tenant (CLAUDE.md invariants). This is the shared shape
 * of a resolved tenant config; the worker resolves it from D1/KV (see getPortalConfig)
 * and Project tooling references the same type so tenant fields stay in lockstep.
 */

/** Overall tenant publishing gate. 'active' is the only publishing-enabled state. */
export type TenantStatus = 'installed' | 'active' | 'past_due' | 'cancelled';

/** Refuel-side billing state (distinct from the tenant's own event-payment config). */
export type RefuelBillingStatus = 'trial' | 'active' | 'past_due' | 'cancelled';

export type RefuelPlan = 'starter' | 'growth' | 'scale';

export interface PortalConfig {
  portalId: string;
  /** Publishing gate: only 'active' allows event publishing. */
  status: TenantStatus;
  /** Refuel subscription billing state (may differ from status during grace periods). */
  refuelBillingStatus: RefuelBillingStatus;
  refuelPlan: RefuelPlan | null;
  /** ISO 8601 UTC — null for paid plans. */
  trialEndsAt: string | null;
  /** true once the tenant has connected Stripe as their payment processor in HubSpot. */
  stripeProcessorConnected: boolean;
  /** HubSpot tax rate id imported from Xero; required before invoice line items can carry GST. */
  xeroGstRateId: string | null;
  /** 'teams' or null (in-person only). Credentials stored encrypted separately. */
  webinarProvider: string | null;
  /** HubDB table id for the `events` table (null until provisioning completes). */
  hubdbEventsTableId: string | null;
  /** HubDB table id for the `ticket_types` table (null until provisioning completes). */
  hubdbTicketTypesTableId: string | null;
  /** Customer CMS domain for the events listing dynamic page. */
  hubdbDynamicPageDomain: string | null;
}
