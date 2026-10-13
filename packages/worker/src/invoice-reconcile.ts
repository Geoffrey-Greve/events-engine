/**
 * HubSpot invoice reconciliation.
 *
 * Webhooks are the preferred real-time path for payment confirmation, but they are
 * operationally easy to misconfigure while onboarding a tenant. This scheduled
 * fallback polls HubSpot for known invoice ids and drives the same payment/refund
 * lifecycle as the webhook handler.
 */

import { getAccessToken } from './hubspot-oauth';
import {
  type ConfirmPaymentJob,
  confirmPayment,
  flagOversellForReview,
  handleRefund,
  type RefundPaymentJob,
} from './payment';
import type { Env } from './types';

const HS_API = 'https://api.hubapi.com';

interface InvoicePollOrder {
  id: string;
  portal_id: string;
  hubspot_invoice_id: string;
  status: string;
}

interface HubSpotInvoiceResponse {
  id: string;
  properties?: {
    hs_invoice_status?: string;
  };
}

async function getInvoiceStatus(accessToken: string, invoiceId: string): Promise<string | null> {
  const res = await fetch(
    `${HS_API}/crm/v3/objects/invoices/${encodeURIComponent(invoiceId)}?properties=hs_invoice_status`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );

  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HubSpot invoice status lookup failed ${res.status}: ${body}`);
  }

  const data = (await res.json()) as HubSpotInvoiceResponse;
  return data.properties?.hs_invoice_status?.toLowerCase() ?? null;
}

async function reconcilePaidInvoice(env: Env, order: InvoicePollOrder): Promise<void> {
  const job: ConfirmPaymentJob = {
    kind: 'confirm_payment',
    portalId: order.portal_id,
    hsInvoiceId: order.hubspot_invoice_id,
  };
  const result = await confirmPayment(env, job);
  if (result.oversold) {
    // No auto-resolve (Phase 18.3): flag for the event owner to decide.
    await flagOversellForReview(env, job);
  }
}

async function reconcileVoidedInvoice(env: Env, order: InvoicePollOrder): Promise<void> {
  const job: RefundPaymentJob = {
    kind: 'refund_payment',
    portalId: order.portal_id,
    hsInvoiceId: order.hubspot_invoice_id,
  };
  await handleRefund(env, job);
}

/**
 * Poll recent unresolved HubSpot invoices and reconcile D1/tickets when HubSpot
 * already knows the invoice outcome.
 */
export async function reconcileHubSpotInvoices(env: Env, limit = 25): Promise<void> {
  const rows = await env.DB.prepare(
    `SELECT id, portal_id, hubspot_invoice_id, status
     FROM orders
     WHERE hubspot_invoice_id IS NOT NULL
       AND status IN ('pending', 'cancelled')
     -- Random sample, not oldest-first: a paid booking now stays 'pending' until its
     -- invoice due date (up to 90 days), so a deterministic order would re-poll the same
     -- stuck unpaid invoices every run and never reach a newer order whose paid webhook
     -- was missed — which is the only reason this fallback sweep exists.
     ORDER BY RANDOM()
     LIMIT ?1`,
  )
    .bind(limit)
    .all<InvoicePollOrder>();

  const tokenByPortal = new Map<string, string>();

  for (const order of rows.results) {
    try {
      let token = tokenByPortal.get(order.portal_id);
      if (!token) {
        token = await getAccessToken(env, order.portal_id);
        tokenByPortal.set(order.portal_id, token);
      }

      const status = await getInvoiceStatus(token, order.hubspot_invoice_id);

      if (status === 'paid') {
        await reconcilePaidInvoice(env, order);
      } else if (status === 'voided' || status === 'cancelled' || status === 'canceled') {
        await reconcileVoidedInvoice(env, order);
      }
    } catch {
      // Leave the order for the next cron/webhook. This fallback must never
      // prevent other scheduled jobs from running.
    }
  }
}
