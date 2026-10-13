/**
 * POST /webhooks/graph
 *
 * Microsoft Graph change-notification endpoint for the tenant-wide
 * solutions/virtualEvents/events subscription.
 *
 *   1. Validation handshake: Graph appends ?validationToken=… on create/renew;
 *      echo it back verbatim as text/plain 200 (within 10s).
 *   2. Otherwise: group notifications by subscriptionId, resolve each to a
 *      portal (KV reverse map written by ensureSubscription), let the provider
 *      verify clientState + handle lifecycle, and enqueue graph.pull_attendance.
 *
 * Always 202 for real notifications so Graph doesn't retry; the heavy lifting
 * (clientState verify, lifecycle renew, DB lookups) runs in waitUntil.
 */

import type { Context } from 'hono';
import { getWebinarProvider } from '../providers';
import type { Env } from '../types';

interface GraphNotificationEnvelope {
  value?: Array<{ subscriptionId?: string }>;
}

export async function handleGraphWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
  const url = new URL(c.req.url);
  const validationToken = url.searchParams.get('validationToken');
  if (validationToken !== null) {
    return new Response(validationToken, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  let body: GraphNotificationEnvelope;
  try {
    body = (await c.req.json()) as GraphNotificationEnvelope;
  } catch {
    return c.json({ ok: false, error: 'invalid_body' }, 400);
  }

  // Group by subscriptionId so each group is processed under its own tenant.
  const groups = new Map<string, unknown[]>();
  for (const n of body.value ?? []) {
    const sid = n.subscriptionId ?? '';
    const arr = groups.get(sid);
    if (arr) arr.push(n);
    else groups.set(sid, [n]);
  }

  const env = c.env;
  c.executionCtx.waitUntil(
    (async () => {
      for (const [subscriptionId, notifications] of groups) {
        if (!subscriptionId) continue;
        const portalId = await env.KV.get(`graph:sub-portal:${subscriptionId}`);
        if (!portalId) continue; // unknown subscription — ignore
        const provider = getWebinarProvider(env, portalId, 'teams');
        if (!provider) continue;
        try {
          const jobs = await provider.handleNotification({ value: notifications });
          if (jobs.length > 0) {
            await env.QUEUE.sendBatch(jobs.map((job) => ({ body: job })));
          }
        } catch {
          // Swallow — the missed-webhook / finalize crons are the backstop.
        }
      }
    })(),
  );

  return new Response(null, { status: 202 });
}
