/**
 * POST /webhooks/hubspot
 *
 * Receives HubSpot v3 webhooks. Each request carries an array of events.
 *
 * Processing:
 *   1. Verify the v3 HMAC-SHA256 signature.
 *   2. Dedup each event on (provider='hubspot', provider_event_id=eventId)
 *      via INSERT OR IGNORE into webhook_events.
 *   3. Detect payment events:
 *        Invoice: propertyName=hs_invoice_status, propertyValue=paid
 *        Payment: objectType=PAYMENT, propertyValue=SUCCEEDED → resolve invoice
 *   4. Detect refund events:
 *        Invoice: propertyName=hs_invoice_status, propertyValue=voided
 *   5. Enqueue confirm_payment / refund_payment into the queue.
 *
 * Always returns 200 so HubSpot does not retry. Invalid signatures → 401.
 */

import type { Context } from 'hono';
import { getAccessToken } from '../hubspot-oauth';
import { hs } from '../hubspot-writeback';
import type { Env } from '../types';

const HS_API = 'https://api.hubapi.com';

interface HsWebhookEvent {
  eventId: number;
  subscriptionId: number;
  portalId: number;
  occurredAt: number;
  subscriptionType: string;
  objectType: string;
  objectId: number;
  changeFlag?: string;
  propertyName?: string;
  propertyValue?: string;
}

// ---------------------------------------------------------------------------
// Signature verification (HubSpot v3)
// ---------------------------------------------------------------------------

async function verifyV3Signature(
  method: string,
  url: string,
  rawBody: string,
  ts: string,
  sig: string,
  secret: string,
): Promise<boolean> {
  // Replay protection: reject requests older than 5 minutes.
  if (Math.abs(Date.now() - parseInt(ts, 10)) > 5 * 60 * 1000) return false;

  const source = `${method}${url}${rawBody}${ts}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  // Decode the header signature from base64 before timing-safe verify.
  let sigBytes: Uint8Array;
  try {
    sigBytes = Uint8Array.from(atob(sig), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  // crypto.subtle.verify is timing-safe: no early exit on byte mismatch.
  return crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(source));
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function handleHubspotWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
  const rawBody = await c.req.text();

  const ts = c.req.header('X-HubSpot-Request-Timestamp');
  const sig = c.req.header('X-HubSpot-Signature-v3');
  if (!ts || !sig) {
    return c.json({ ok: false, error: 'missing_signature_headers' }, 401);
  }

  const secret = c.env.HUBSPOT_WEBHOOK_SECRET;
  const valid = await verifyV3Signature(c.req.method, c.req.url, rawBody, ts, sig, secret);
  if (!valid) {
    return c.json({ ok: false, error: 'invalid_signature' }, 401);
  }

  let events: HsWebhookEvent[];
  try {
    events = JSON.parse(rawBody) as HsWebhookEvent[];
    if (!Array.isArray(events)) events = [events];
  } catch {
    return c.json({ ok: false, error: 'invalid_body' }, 400);
  }

  const env = c.env;
  const now = new Date().toISOString();

  for (const event of events) {
    const portalId = String(event.portalId);
    const providerEventId = String(event.eventId);

    // Dedup: INSERT OR IGNORE — changes === 0 means already processed.
    const dedup = await env.DB.prepare(
      `INSERT OR IGNORE INTO webhook_events
         (id, portal_id, provider, provider_event_id, topic, payload, created_at)
       VALUES (?1, ?2, 'hubspot', ?3, ?4, ?5, ?6)`,
    )
      .bind(
        crypto.randomUUID(),
        portalId,
        providerEventId,
        event.subscriptionType,
        JSON.stringify(event),
        now,
      )
      .run();

    if (dedup.meta.changes === 0) continue;

    const prop = event.propertyName;
    const val = event.propertyValue?.toLowerCase();

    // ---- Payment detection --------------------------------------------------
    let hsInvoiceId: string | null = null;

    if (event.objectType === 'INVOICE' && prop === 'hs_invoice_status' && val === 'paid') {
      hsInvoiceId = String(event.objectId);
    } else if (event.objectType === 'PAYMENT' && val === 'succeeded') {
      // Resolve associated invoice via HubSpot associations API.
      try {
        const token = await getAccessToken(env, portalId);
        const data = (await hs(
          token,
          'GET',
          `${HS_API}/crm/v4/objects/payments/${event.objectId}/associations/invoices`,
        )) as { results: Array<{ toObjectId: string }> };
        if (data.results.length > 0) {
          hsInvoiceId = data.results[0].toObjectId;
        }
      } catch {
        // Can't resolve invoice — skip this event.
      }
    }

    if (hsInvoiceId) {
      await env.DB.prepare(
        `UPDATE webhook_events SET processed_at = ?1
         WHERE provider = 'hubspot' AND provider_event_id = ?2`,
      )
        .bind(now, providerEventId)
        .run();

      await env.QUEUE.send({ kind: 'confirm_payment', hsInvoiceId, portalId });
      continue;
    }

    // ---- Refund detection --------------------------------------------------
    if (event.objectType === 'INVOICE' && prop === 'hs_invoice_status' && val === 'voided') {
      const invoiceId = String(event.objectId);

      await env.DB.prepare(
        `UPDATE webhook_events SET processed_at = ?1
         WHERE provider = 'hubspot' AND provider_event_id = ?2`,
      )
        .bind(now, providerEventId)
        .run();

      await env.QUEUE.send({ kind: 'refund_payment', hsInvoiceId: invoiceId, portalId });
    }
  }

  return c.json({ ok: true });
}
