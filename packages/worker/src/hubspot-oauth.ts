/**
 * HubSpot OAuth token management.
 *
 * Tokens are stored encrypted in the tenants table (AES-GCM, TOKEN_ENCRYPTION_KEY).
 * `getAccessToken` transparently refreshes if < 5 minutes remain.
 */

import { getSecret } from './config';
import { decryptToken, encryptToken } from './token-crypto';
import type { Env } from './types';

interface TenantTokenRow {
  hs_access_token: string | null;
  hs_refresh_token: string | null;
  hs_token_expires_at: string | null;
}

interface HubSpotTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
}

interface HubSpotTokenInfo {
  hub_id: number; // the portal id the token actually belongs to
  user_id?: number;
  app_id?: number;
  scopes?: string[];
}

/**
 * Introspect an access token to discover which portal it actually belongs to.
 * This is the authoritative portal id — never trust a portal id supplied in a
 * redirect/query parameter, which the caller can tamper with.
 */
export async function getTokenInfo(accessToken: string): Promise<HubSpotTokenInfo> {
  const res = await fetch(
    `https://api.hubapi.com/oauth/v1/access-tokens/${encodeURIComponent(accessToken)}`,
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HubSpot token introspection failed ${res.status}: ${body}`);
  }
  return res.json<HubSpotTokenInfo>();
}

async function fetchNewTokens(env: Env, refreshToken: string): Promise<HubSpotTokenResponse> {
  const res = await fetch('https://api.hubapi.com/oauth/2026-03/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: getSecret(env, 'HUBSPOT_CLIENT_ID'),
      client_secret: getSecret(env, 'HUBSPOT_CLIENT_SECRET'),
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HubSpot token refresh failed ${res.status}: ${body}`);
  }
  return res.json<HubSpotTokenResponse>();
}

/**
 * Stores OAuth tokens for a portal (encrypted). Call after initial OAuth exchange
 * and after every refresh.
 */
export async function storeTokens(
  env: Env,
  portalId: string,
  accessToken: string,
  refreshToken: string,
  expiresIn: number,
): Promise<void> {
  const encKey = getSecret(env, 'TOKEN_ENCRYPTION_KEY');
  const [encAccess, encRefresh] = await Promise.all([
    encryptToken(encKey, accessToken),
    encryptToken(encKey, refreshToken),
  ]);
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  await env.DB.prepare(
    `UPDATE tenants
     SET hs_access_token = ?1, hs_refresh_token = ?2, hs_token_expires_at = ?3
     WHERE portal_id = ?4`,
  )
    .bind(encAccess, encRefresh, expiresAt, portalId)
    .run();
}

/**
 * Returns a valid access token for the given portal.
 *
 * A per-portal static token in `HUBSPOT_API_KEY_{portalId}` (a service key or
 * private-app token) wins over OAuth. It never expires, so a tenant configured
 * that way needs no `tenants.hs_*` rows and no install flow at all — which is
 * how a single-portal deployment is stood up. Otherwise fall back to the stored
 * OAuth tokens, refreshing when < 5 minutes remain.
 *
 * Throws if the portal has neither.
 */
export async function getAccessToken(env: Env, portalId: string): Promise<string> {
  try {
    return getSecret(env, `HUBSPOT_API_KEY_${portalId}`);
  } catch {
    // No static token for this portal; use the OAuth tokens below.
  }

  const row = await env.DB.prepare(
    'SELECT hs_access_token, hs_refresh_token, hs_token_expires_at FROM tenants WHERE portal_id = ?1',
  )
    .bind(portalId)
    .first<TenantTokenRow>();

  if (!row?.hs_access_token || !row.hs_refresh_token) {
    throw new Error(
      `No HubSpot credentials for portal ${portalId}: ` +
        `set HUBSPOT_API_KEY_${portalId} or complete the OAuth install`,
    );
  }

  const encKey = getSecret(env, 'TOKEN_ENCRYPTION_KEY');

  // Refresh if expiry unknown or < 5 minutes away.
  const expiresAt = row.hs_token_expires_at ? new Date(row.hs_token_expires_at).getTime() : 0;
  if (Date.now() > expiresAt - 5 * 60 * 1000) {
    const refreshToken = await decryptToken(encKey, row.hs_refresh_token);
    const tokens = await fetchNewTokens(env, refreshToken);
    await storeTokens(env, portalId, tokens.access_token, tokens.refresh_token, tokens.expires_in);
    return tokens.access_token;
  }

  return decryptToken(encKey, row.hs_access_token);
}

/**
 * Exchanges an OAuth authorization code for tokens.
 */
export async function exchangeCode(env: Env, code: string): Promise<HubSpotTokenResponse> {
  const res = await fetch('https://api.hubapi.com/oauth/2026-03/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: getSecret(env, 'HUBSPOT_CLIENT_ID'),
      client_secret: getSecret(env, 'HUBSPOT_CLIENT_SECRET'),
      redirect_uri: getSecret(env, 'HUBSPOT_REDIRECT_URI'),
      code,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HubSpot OAuth exchange failed ${res.status}: ${body}`);
  }
  return res.json<HubSpotTokenResponse>();
}
