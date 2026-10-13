/**
 * Admin endpoints (ADMIN_SECRET bearer-gated).
 *
 * POST /admin/provision/:portalId
 *   Runs provisioning for a portal that already has OAuth tokens stored.
 *   Use this to provision "tenant zero" (Weld) and for any re-provisioning.
 *   Returns { ok, eventsTableId, ticketTypesTableId, created }.
 *
 * GET /admin/hubdb/:portalId
 *   Read-only dump of HubSpot's actual responses for our two HubDB tables.
 *   Use this to diagnose a provisioning failure instead of guessing from one
 *   error message at a time. Mutates nothing.
 *
 * PATCH /admin/tenants/:portalId/status
 *   Body: { status: 'installed' | 'active' | 'past_due' | 'cancelled' }
 *   Advances the tenant status machine.
 */

import type { TenantStatus } from '@paddock/shared';
import { Hono } from 'hono';
import { getSecret } from '../config';
import { getAccessToken } from '../hubspot-oauth';
import { describeHubDbTables, provisionHubDbTables } from '../provision';
import type { Env } from '../types';

const VALID_STATUSES: TenantStatus[] = ['installed', 'active', 'past_due', 'cancelled'];

export const adminRoutes = new Hono<{ Bindings: Env }>();

// Bearer-token guard applied to all admin routes.
adminRoutes.use('*', async (c, next) => {
  const authHeader = c.req.header('Authorization') ?? '';
  let secret: string;
  try {
    secret = getSecret(c.env, 'ADMIN_SECRET');
  } catch {
    return c.json({ error: 'Admin access not configured' }, 503);
  }
  if (authHeader !== `Bearer ${secret}`) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return next();
});

adminRoutes.post('/provision/:portalId', async (c) => {
  const { portalId } = c.req.param();

  let accessToken: string;
  try {
    accessToken = await getAccessToken(c.env, portalId);
  } catch (err) {
    return c.json({ error: `Cannot get access token: ${String(err)}` }, 400);
  }

  let result: Awaited<ReturnType<typeof provisionHubDbTables>>;
  try {
    result = await provisionHubDbTables(c.env, portalId, accessToken);
  } catch (err) {
    return c.json({ error: `Provisioning failed: ${String(err)}` }, 502);
  }

  return c.json({
    ok: true,
    eventsTableId: result.eventsTableId,
    ticketTypesTableId: result.ticketTypesTableId,
    created: result.created,
  });
});

adminRoutes.get('/hubdb/:portalId', async (c) => {
  const { portalId } = c.req.param();

  let accessToken: string;
  try {
    accessToken = await getAccessToken(c.env, portalId);
  } catch (err) {
    return c.json({ error: `Cannot get access token: ${String(err)}` }, 400);
  }

  try {
    return c.json(await describeHubDbTables(accessToken));
  } catch (err) {
    return c.json({ error: `Describe failed: ${String(err)}` }, 502);
  }
});

adminRoutes.patch('/tenants/:portalId/status', async (c) => {
  const { portalId } = c.req.param();
  let body: { status?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }
  const status = body.status as TenantStatus | undefined;
  if (!status || !VALID_STATUSES.includes(status)) {
    return c.json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` }, 400);
  }
  const result = await c.env.DB.prepare('UPDATE tenants SET status = ?1 WHERE portal_id = ?2')
    .bind(status, portalId)
    .run();
  if (result.meta.changes === 0) {
    return c.json({ error: `Tenant ${portalId} not found` }, 404);
  }
  return c.json({ ok: true, portalId, status });
});
