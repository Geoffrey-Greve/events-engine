import type { PortalConfig, RefuelBillingStatus, RefuelPlan, TenantStatus } from '@paddock/shared';
import type { Env } from './types';

export type { PortalConfig };

interface TenantRow {
  portal_id: string;
  status: TenantStatus;
  refuel_billing_status: RefuelBillingStatus | null;
  refuel_plan: RefuelPlan | null;
  trial_ends_at: string | null;
  stripe_processor_connected: number;
  xero_gst_rate_id: string | null;
  webinar_provider: string | null;
  hubdb_events_table_id: string | null;
  hubdb_ticket_types_table_id: string | null;
  hubdb_dynamic_page_domain: string | null;
}

/**
 * Resolves per-tenant config from D1. Returns null if the portal is not provisioned.
 */
export async function getPortalConfig(env: Env, portalId: string): Promise<PortalConfig | null> {
  const row = await env.DB.prepare(
    `SELECT portal_id, status,
            refuel_billing_status, refuel_plan, trial_ends_at,
            stripe_processor_connected, xero_gst_rate_id, webinar_provider,
            hubdb_events_table_id, hubdb_ticket_types_table_id, hubdb_dynamic_page_domain
     FROM tenants WHERE portal_id = ?1`,
  )
    .bind(portalId)
    .first<TenantRow>();

  if (!row) return null;

  return {
    portalId: row.portal_id,
    status: row.status ?? 'installed',
    refuelBillingStatus: row.refuel_billing_status ?? 'trial',
    refuelPlan: row.refuel_plan ?? null,
    trialEndsAt: row.trial_ends_at ?? null,
    stripeProcessorConnected: !!row.stripe_processor_connected,
    xeroGstRateId: row.xero_gst_rate_id ?? null,
    webinarProvider: row.webinar_provider ?? null,
    hubdbEventsTableId: row.hubdb_events_table_id,
    hubdbTicketTypesTableId: row.hubdb_ticket_types_table_id,
    hubdbDynamicPageDomain: row.hubdb_dynamic_page_domain ?? null,
  };
}

/**
 * Reads a Wrangler secret following the {PREFIX}_{portalId} convention.
 * Example: getSecret(env, "HUBSPOT_API_KEY_12345") → env["HUBSPOT_API_KEY_12345"]
 *
 * Secrets not declared in the Env interface are accessed via the cast below;
 * add them to Env as concrete features land.
 */
export function getSecret(env: Env, name: string): string {
  const value = (env as unknown as Record<string, unknown>)[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Secret "${name}" is missing or empty`);
  }
  return value;
}

/**
 * Names of the given secrets that are missing or empty on this deployment.
 * Use it to answer a misconfiguration with a clear message instead of letting
 * `getSecret` throw into the generic 500 handler.
 */
export function missingSecrets(env: Env, names: readonly string[]): string[] {
  const bag = env as unknown as Record<string, unknown>;
  return names.filter((name) => typeof bag[name] !== 'string' || bag[name] === '');
}
