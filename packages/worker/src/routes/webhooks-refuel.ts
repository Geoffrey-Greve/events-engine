/**
 * POST /webhooks/refuel
 *
 * Receives HubSpot webhook events from REFUEL's own portal — specifically,
 * invoice and payment events that track Paddock subscription billing.
 *
 * Signed with REFUEL_WEBHOOK_SECRET using HubSpot's v3 HMAC-SHA256 scheme.
 *
 * Processing:
 *   - Invoice hs_invoice_status = paid → activate tenant (status='active',
 *     refuel_billing_status='active'), record deal id.
 *   - Invoice hs_invoice_status = voided → mark past_due or cancelled depending
 *     on whether a deal id is present.
 *
 * Tenant identification: the invoice in REFUEL's portal is associated with a
 * deal that carries the custom property `paddock_portal_id` (the customer's
 * HubSpot portal id). We resolve this via REFUEL_HS_ACCESS_TOKEN.
 *
 * Always returns 200 so HubSpot does not retry; invalid signatures → 401.
 */

import type { Context } from 'hono';
import { getSecret } from '../config';
import type { Env } from '../types';

const HS_API = 'https://api.hubapi.com';

interface RefuelWebhookEvent {
  eventId: number;
  portalId: number;
  subscriptionType: string;
  objectType: string;
  objectId: number;
  propertyName?: string;
  propertyValue?: string;
  occurredAt: number;
}

async function verifyV3Signature(
  method: string,
  url: string,
  rawBody: string,
  ts: string,
  sig: string,
  secret: string,
): Promise<boolean> {
  if (Math.abs(Date.now() - parseInt(ts, 10)) > 5 * 60 * 1000) return false;
  const source = `${method}${url}${rawBody}${ts}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const raw = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(source));
  const computed = btoa(String.fromCharCode(...new Uint8Array(raw)));
  return computed === sig;
}

async function resolveTenantFromInvoice(
  accessToken: string,
  invoiceId: string,
): Promise<{ portalId: string; dealId: string } | null> {
  // Invoice → Deal associations.
  const assocRes = await fetch(
    `${HS_API}/crm/v4/objects/invoices/${invoiceId}/associations/deals`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!assocRes.ok) return null;

  const assocData = (await assocRes.json()) as { results: Array<{ toObjectId: string }> };
  if (!assocData.results.length) return null;

  const dealId = assocData.results[0].toObjectId;

  // Read the paddock_portal_id custom property from the deal.
  const dealRes = await fetch(
    `${HS_API}/crm/v3/objects/deals/${dealId}?properties=paddock_portal_id`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!dealRes.ok) return null;

  const deal = (await dealRes.json()) as { properties: { paddock_portal_id?: string } };
  const portalId = deal.properties.paddock_portal_id;
  if (!portalId) return null;
  return { portalId, dealId };
}

export async function handleRefuelWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
  const rawBody = await c.req.text();

  const ts = c.req.header('X-HubSpot-Request-Timestamp');
  const sig = c.req.header('X-HubSpot-Signature-v3');
  if (!ts || !sig) {
    return c.json({ ok: false, error: 'missing_signature_headers' }, 401);
  }

  let secret: string;
  try {
    secret = getSecret(c.env, 'REFUEL_WEBHOOK_SECRET');
  } catch {
    return c.json({ ok: false, error: 'server_misconfigured' }, 500);
  }

  const valid = await verifyV3Signature(c.req.method, c.req.url, rawBody, ts, sig, secret);
  if (!valid) {
    return c.json({ ok: false, error: 'invalid_signature' }, 401);
  }

  let events: RefuelWebhookEvent[];
  try {
    events = JSON.parse(rawBody) as RefuelWebhookEvent[];
    if (!Array.isArray(events)) events = [events];
  } catch {
    return c.json({ ok: false, error: 'invalid_body' }, 400);
  }

  let refuelToken: string;
  try {
    refuelToken = getSecret(c.env, 'REFUEL_HS_ACCESS_TOKEN');
  } catch {
    return c.json({ ok: false, error: 'server_misconfigured' }, 500);
  }

  for (const event of events) {
    if (event.objectType !== 'INVOICE') continue;
    if (event.propertyName !== 'hs_invoice_status') continue;

    const invoiceId = String(event.objectId);
    const val = event.propertyValue?.toLowerCase();

    if (val === 'paid') {
      const tenant = await resolveTenantFromInvoice(refuelToken, invoiceId).catch(() => null);
      if (!tenant) continue;

      // refuel_hs_deal_id records the associated DEAL id (not the invoice id) so later
      // billing reconciliation and CRM links resolve to the right object.
      await c.env.DB.prepare(
        `UPDATE tenants
         SET status = 'active',
             refuel_billing_status = 'active',
             refuel_hs_deal_id = COALESCE(refuel_hs_deal_id, ?1)
         WHERE portal_id = ?2`,
      )
        .bind(tenant.dealId, tenant.portalId)
        .run();
    } else if (val === 'voided') {
      const tenant = await resolveTenantFromInvoice(refuelToken, invoiceId).catch(() => null);
      if (!tenant) continue;

      await c.env.DB.prepare(
        `UPDATE tenants
         SET status = 'past_due',
             refuel_billing_status = 'past_due'
         WHERE portal_id = ?1 AND status = 'active'`,
      )
        .bind(tenant.portalId)
        .run();
    }
  }

  return c.json({ ok: true });
}
