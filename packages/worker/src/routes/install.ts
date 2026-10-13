import type { Context } from 'hono';
import { exchangeCode, getTokenInfo, storeTokens } from '../hubspot-oauth';
import { provisionHubDbTables } from '../provision';
import { seedDefaultQuestions } from '../questions';
import type { Env } from '../types';

export async function handleInstall(c: Context<{ Bindings: Env }>): Promise<Response> {
  let body: { code?: string; portalId?: string; displayName?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { code, portalId: claimedPortalId, displayName } = body;
  if (!code || !claimedPortalId) {
    return c.json({ error: 'code and portalId are required' }, 400);
  }

  let tokens: Awaited<ReturnType<typeof exchangeCode>>;
  try {
    tokens = await exchangeCode(c.env, code);
  } catch (err) {
    return c.json({ error: String(err) }, 502);
  }

  let portalId: string;
  try {
    portalId = String((await getTokenInfo(tokens.access_token)).hub_id);
  } catch (err) {
    return c.json({ error: `Token introspection failed: ${String(err)}` }, 502);
  }
  if (portalId !== claimedPortalId) {
    return c.json({ error: 'Portal id mismatch between request and token' }, 400);
  }

  await c.env.DB.prepare(
    `INSERT INTO tenants (portal_id, display_name, status)
     VALUES (?1, ?2, 'installed')
     ON CONFLICT (portal_id) DO UPDATE SET display_name = excluded.display_name`,
  )
    .bind(portalId, displayName ?? portalId)
    .run();

  // Migration 0024 seeds the default question set for tenants that already existed; this
  // does it for one arriving now. INSERT OR IGNORE, so a reinstall keeps whatever the
  // portal has since edited or archived rather than resetting it.
  await seedDefaultQuestions(c.env, portalId);

  await storeTokens(c.env, portalId, tokens.access_token, tokens.refresh_token, tokens.expires_in);

  let result: Awaited<ReturnType<typeof provisionHubDbTables>> | null = null;
  if (c.env.OAUTH_AUTO_PROVISION_HUBDB === 'true') {
    try {
      result = await provisionHubDbTables(c.env, portalId, tokens.access_token);
    } catch (err) {
      return c.json({ error: `Provisioning failed: ${String(err)}` }, 502);
    }
  }

  return c.json({
    ok: true,
    eventsTableId: result?.eventsTableId ?? null,
    ticketTypesTableId: result?.ticketTypesTableId ?? null,
    created: result?.created ?? false,
  });
}
