import type { Context } from 'hono';
import { getSecret } from '../config';
import { exchangeCode, getTokenInfo, storeTokens } from '../hubspot-oauth';
import { verifyOAuthState } from '../hubspot-oauth-state';
import { provisionHubDbTables } from '../provision';
import { seedDefaultQuestions } from '../questions';
import type { Env } from '../types';
import { HUBSPOT_OAUTH_SECRETS, oauthNotConfigured } from './oauth-install';

export async function handleOAuthCallback(c: Context<{ Bindings: Env }>): Promise<Response> {
  const notConfigured = oauthNotConfigured(c, HUBSPOT_OAUTH_SECRETS);
  if (notConfigured) return notConfigured;

  const url = new URL(c.req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const claimedPortalId = url.searchParams.get('portalId') ?? url.searchParams.get('hub_id');

  if (!code || !state) {
    return new Response('Missing code or state query parameter.', { status: 400 });
  }

  let intendedPortalId: string | undefined;
  try {
    intendedPortalId = (await verifyOAuthState(c.env, state)).portalId;
  } catch (err) {
    // The state is attacker-supplied, so keep the reason in the log rather than
    // in a response body that would echo internal detail back to the caller.
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'oauth_state_rejected',
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return new Response('Invalid or expired OAuth state. Start the install again.', {
      status: 400,
    });
  }

  let successRedirect: string;
  try {
    successRedirect = getSecret(c.env, 'OAUTH_SUCCESS_REDIRECT_URI');
  } catch {
    successRedirect = 'https://app.hubspot.com';
  }

  let tokens: Awaited<ReturnType<typeof exchangeCode>>;
  try {
    tokens = await exchangeCode(c.env, code);
  } catch (err) {
    return new Response(`OAuth token exchange failed: ${String(err)}`, { status: 502 });
  }

  let portalId: string;
  try {
    portalId = String((await getTokenInfo(tokens.access_token)).hub_id);
  } catch (err) {
    return new Response(`OAuth token introspection failed: ${String(err)}`, { status: 502 });
  }

  if (claimedPortalId && claimedPortalId !== portalId) {
    return new Response('Portal id mismatch between callback and token.', { status: 400 });
  }
  if (intendedPortalId && intendedPortalId !== portalId) {
    return new Response('The authorized portal does not match the requested portal.', {
      status: 400,
    });
  }

  await c.env.DB.prepare(
    `INSERT INTO tenants (portal_id, display_name, status)
     VALUES (?1, ?1, 'installed')
     ON CONFLICT (portal_id) DO NOTHING`,
  )
    .bind(portalId)
    .run();

  // Migration 0024 seeds the default question set for tenants that already existed; this
  // does it for one arriving now. INSERT OR IGNORE, so a reinstall keeps whatever the
  // portal has since edited or archived rather than resetting it.
  await seedDefaultQuestions(c.env, portalId);

  // Store encrypted tokens.
  await storeTokens(c.env, portalId, tokens.access_token, tokens.refresh_token, tokens.expires_in);

  // Existing tenants such as Weld already have their own HubDB schema.
  if (c.env.OAUTH_AUTO_PROVISION_HUBDB === 'true') {
    try {
      await provisionHubDbTables(c.env, portalId, tokens.access_token);
    } catch {
      // OAuth installation remains valid; provisioning can be handled separately.
    }
  }

  return Response.redirect(successRedirect, 302);
}
