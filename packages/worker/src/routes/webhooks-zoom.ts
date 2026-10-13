/**
 * POST /webhooks/zoom?portalId=…
 *
 * Zoom event-notification endpoint for the Webinars integration.
 *
 *   1. URL validation: Zoom sends event=endpoint.url_validation with a
 *      plainToken; reply with { plainToken, encryptedToken } where encryptedToken
 *      is HMAC-SHA256(plainToken, secret) hex.
 *   2. Otherwise: verify the x-zm-signature HMAC, dedup on a stable event key,
 *      then let ZoomProvider.handleNotification map the event to a
 *      graph.pull_attendance job (the reconcile is idempotent).
 *
 * The tenant is identified by the ?portalId query param (each tenant points its
 * Zoom app's webhook at /webhooks/zoom?portalId=<theirs>), so the per-tenant
 * secret resolves for both the validation handshake and signature verification.
 *
 * Always 200 so Zoom doesn't disable the endpoint; heavy work runs in waitUntil.
 * Invalid signature → 401.
 */

import type { Context } from 'hono';
import { getSecret } from '../config';
import { getWebinarProvider } from '../providers';
import type { Env } from '../types';

interface ZoomEnvelope {
  event?: string;
  event_ts?: number;
  payload?: {
    plainToken?: string;
    account_id?: string;
    object?: { id?: number | string; participant?: { user_id?: string } };
  };
}

const enc = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time hex-string compare. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function handleZoomWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
  const portalId = c.req.query('portalId');
  if (!portalId) return c.json({ ok: false, error: 'missing_portal' }, 400);

  const rawBody = await c.req.text();
  let body: ZoomEnvelope;
  try {
    body = JSON.parse(rawBody) as ZoomEnvelope;
  } catch {
    return c.json({ ok: false, error: 'invalid_body' }, 400);
  }

  let secret: string;
  try {
    secret = getSecret(c.env, `ZOOM_WEBHOOK_SECRET_${portalId}`);
  } catch {
    return c.json({ ok: false, error: 'unconfigured_portal' }, 400);
  }

  // 1. URL validation handshake.
  if (body.event === 'endpoint.url_validation' && body.payload?.plainToken) {
    const plainToken = body.payload.plainToken;
    const encryptedToken = await hmacHex(secret, plainToken);
    return c.json({ plainToken, encryptedToken }, 200);
  }

  // 2. Verify signature: HMAC over `v0:{ts}:{rawBody}`, header is `v0={hex}`.
  const ts = c.req.header('x-zm-request-timestamp') ?? '';
  const sigHeader = c.req.header('x-zm-signature') ?? '';
  const expected = `v0=${await hmacHex(secret, `v0:${ts}:${rawBody}`)}`;
  if (!timingSafeEqualHex(sigHeader, expected)) {
    return c.json({ ok: false, error: 'invalid_signature' }, 401);
  }

  const env = c.env;
  const now = new Date().toISOString();
  // Stable dedup key (Zoom has no single event-id header on every event type).
  const providerEventId = [
    body.event ?? '',
    body.event_ts ?? '',
    body.payload?.object?.id ?? '',
    body.payload?.object?.participant?.user_id ?? '',
  ].join(':');

  c.executionCtx.waitUntil(
    (async () => {
      const dedup = await env.DB.prepare(
        `INSERT OR IGNORE INTO webhook_events
           (id, portal_id, provider, provider_event_id, topic, payload, created_at)
         VALUES (?1, ?2, 'zoom', ?3, ?4, ?5, ?6)`,
      )
        .bind(crypto.randomUUID(), portalId, providerEventId, body.event ?? '', rawBody, now)
        .run();
      if (dedup.meta.changes === 0) return; // already processed

      const provider = getWebinarProvider(env, portalId, 'zoom');
      if (!provider) return;
      try {
        const jobs = await provider.handleNotification(body);
        if (jobs.length > 0) {
          await env.QUEUE.sendBatch(jobs.map((job) => ({ body: job })));
        }
      } catch {
        // Swallow — the finalize/poll crons are the backstop.
      }
    })(),
  );

  return c.json({ ok: true });
}
