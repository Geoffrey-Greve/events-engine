/**
 * POST /webhooks/app-uninstall
 *
 * HubSpot calls this URL when a portal uninstalls the Paddock app.
 * Configure this as the "App Uninstall URL" in the HubSpot developer portal
 * app settings.
 *
 * HubSpot signs the request body with the app client secret using SHA-256:
 *   signature = sha256(clientSecret + rawBody)   (hex)
 * delivered in the X-HubSpot-Signature header.
 *
 * Body shape: { portalId: number, userId: number, hubDomain?: string }
 *
 * On uninstall:
 *   1. Verify the signature.
 *   2. Set tenant status → 'cancelled'.
 *   3. Set refuel_billing_status → 'cancelled' (stops Refuel-side billing grace).
 *
 * Always returns 200 — HubSpot does not retry on non-200 for lifecycle webhooks.
 */

import type { Context } from 'hono';
import { getSecret } from '../config';
import type { Env } from '../types';

interface UninstallBody {
  portalId: number;
  userId?: number;
  hubDomain?: string;
}

async function verifyUninstallSignature(
  rawBody: string,
  signature: string,
  clientSecret: string,
): Promise<boolean> {
  const source = clientSecret + rawBody;
  const hashBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  const computed = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return computed === signature;
}

export async function handleAppUninstall(c: Context<{ Bindings: Env }>): Promise<Response> {
  const rawBody = await c.req.text();
  const sig = c.req.header('X-HubSpot-Signature');

  if (!sig) {
    return c.json({ ok: false, error: 'missing_signature' }, 401);
  }

  let clientSecret: string;
  try {
    clientSecret = getSecret(c.env, 'HUBSPOT_CLIENT_SECRET');
  } catch {
    return c.json({ ok: false, error: 'server_misconfigured' }, 500);
  }

  const valid = await verifyUninstallSignature(rawBody, sig, clientSecret);
  if (!valid) {
    return c.json({ ok: false, error: 'invalid_signature' }, 401);
  }

  let body: UninstallBody;
  try {
    body = JSON.parse(rawBody) as UninstallBody;
  } catch {
    return c.json({ ok: false, error: 'invalid_body' }, 400);
  }

  const portalId = String(body.portalId);
  if (!portalId) {
    return c.json({ ok: true });
  }

  await c.env.DB.prepare(
    `UPDATE tenants
     SET status = 'cancelled', refuel_billing_status = 'cancelled'
     WHERE portal_id = ?1`,
  )
    .bind(portalId)
    .run();

  return c.json({ ok: true });
}
