/**
 * Per-tenant webinar-provider credentials — the single resolution layer every
 * provider calls instead of reading Wrangler secrets.
 *
 * Two credential shapes behind ONE interface (CLAUDE.md: nothing tenant-specific
 * leaks into shared layers; every token resolved per tenant):
 *
 *   OAuth providers (Zoom, Google/Meet, Vimeo, Wistia)
 *     Each customer authorizes OUR single published app once via the connect
 *     flow (./connect.ts). We store their access+refresh tokens (AES-GCM,
 *     TOKEN_ENCRYPTION_KEY). getProviderAccessToken() returns a valid access
 *     token, transparently refreshing when < 5 min remain — mirroring the
 *     HubSpot getAccessToken() flow.
 *
 *   Key-only providers (ON24 — no OAuth)
 *     Customer pastes their token-key/secret; stored as an encrypted JSON blob.
 *     getProviderApiCreds() returns the decrypted creds.
 *
 * The OUR-app client id/secret + redirect are platform-level Wrangler secrets
 * (one app per provider, shared across all tenants) — NOT per-tenant. Per-tenant
 * is only the customer's resulting tokens, which live in webinar_connections.
 */

import { getSecret } from '../config';
import { decryptToken, encryptToken } from '../token-crypto';
import type { Env } from '../types';

// ---------------------------------------------------------------------------
// Provider OAuth metadata (OUR app, one per provider)
// ---------------------------------------------------------------------------

export type OAuthProviderName = 'zoom' | 'meet' | 'vimeo' | 'wistia';

interface OAuthProviderConfig {
  /** Where the customer is sent to consent. */
  authorizeUrl: string;
  /** Token mint/refresh endpoint. */
  tokenUrl: string;
  /** Space-separated scopes our app requests. */
  scopes: string;
  /**
   * Zoom mints tokens via HTTP Basic (client_id:client_secret) with the
   * credentials NOT in the body; the others use client_id/secret in the body.
   */
  authStyle: 'basic' | 'body';
}

/**
 * Static per-provider OAuth endpoints. Client id/secret are resolved per call
 * from Wrangler secrets ({PROVIDER}_OAUTH_CLIENT_ID / _SECRET) so the OUR-app
 * credentials are never hard-coded.
 */
export const OAUTH_PROVIDERS: Record<OAuthProviderName, OAuthProviderConfig> = {
  zoom: {
    authorizeUrl: 'https://zoom.us/oauth/authorize',
    tokenUrl: 'https://zoom.us/oauth/token',
    scopes: 'webinar:write:admin webinar:read:admin report:read:admin',
    authStyle: 'basic',
  },
  meet: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes:
      'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/meetings.space.readonly',
    authStyle: 'body',
  },
  vimeo: {
    authorizeUrl: 'https://api.vimeo.com/oauth/authorize',
    tokenUrl: 'https://api.vimeo.com/oauth/access_token',
    scopes: 'public private create edit video_files',
    authStyle: 'basic',
  },
  wistia: {
    authorizeUrl: 'https://app.wistia.com/oauth/authorize',
    tokenUrl: 'https://api.wistia.com/oauth/token',
    scopes: 'all:read all:write',
    authStyle: 'body',
  },
};

export function isOAuthProvider(provider: string): provider is OAuthProviderName {
  return provider in OAUTH_PROVIDERS;
}

/** Resolve OUR app's client id/secret for a provider (platform Wrangler secrets). */
function appCredentials(
  env: Env,
  provider: OAuthProviderName,
): {
  clientId: string;
  clientSecret: string;
} {
  const prefix = provider.toUpperCase();
  return {
    clientId: getSecret(env, `${prefix}_OAUTH_CLIENT_ID`),
    clientSecret: getSecret(env, `${prefix}_OAUTH_CLIENT_SECRET`),
  };
}

/** The single redirect URI registered with every provider app. */
export function redirectUri(env: Env, provider: OAuthProviderName): string {
  // One base, provider on the path: {BASE}/connect/{provider}/callback.
  const base = getSecret(env, 'WEBINAR_OAUTH_REDIRECT_BASE').replace(/\/$/, '');
  return `${base}/connect/${provider}/callback`;
}

// ---------------------------------------------------------------------------
// Token endpoint plumbing
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

async function postToken(
  env: Env,
  provider: OAuthProviderName,
  params: Record<string, string>,
): Promise<TokenResponse> {
  const cfg = OAUTH_PROVIDERS[provider];
  const { clientId, clientSecret } = appCredentials(env, provider);

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  const body = new URLSearchParams(params);

  if (cfg.authStyle === 'basic') {
    headers.Authorization = `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
  } else {
    body.set('client_id', clientId);
    body.set('client_secret', clientSecret);
  }

  const resp = await fetch(cfg.tokenUrl, { method: 'POST', headers, body });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`${provider} token request failed ${resp.status}: ${detail}`);
  }
  return resp.json<TokenResponse>();
}

/** Exchange an authorization code for tokens (connect callback). */
export function exchangeAuthCode(
  env: Env,
  provider: OAuthProviderName,
  code: string,
): Promise<TokenResponse> {
  return postToken(env, provider, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(env, provider),
  });
}

// ---------------------------------------------------------------------------
// Storage (AES-GCM via the shared TOKEN_ENCRYPTION_KEY)
// ---------------------------------------------------------------------------

/** Persist OAuth tokens for a tenant+provider (insert or replace). */
export async function storeOAuthConnection(
  env: Env,
  portalId: string,
  provider: OAuthProviderName,
  tokens: TokenResponse,
  accountRef?: string,
): Promise<void> {
  const encKey = getSecret(env, 'TOKEN_ENCRYPTION_KEY');
  const accessEnc = await encryptToken(encKey, tokens.access_token);
  const refreshEnc = tokens.refresh_token ? await encryptToken(encKey, tokens.refresh_token) : null;
  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO webinar_connections
       (portal_id, provider, access_token_enc, refresh_token_enc, token_expires_at,
        account_ref, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
     ON CONFLICT (portal_id, provider) DO UPDATE SET
       access_token_enc = excluded.access_token_enc,
       refresh_token_enc = COALESCE(excluded.refresh_token_enc, webinar_connections.refresh_token_enc),
       token_expires_at = excluded.token_expires_at,
       account_ref = COALESCE(excluded.account_ref, webinar_connections.account_ref),
       updated_at = excluded.updated_at`,
  )
    .bind(portalId, provider, accessEnc, refreshEnc, expiresAt, accountRef ?? null, now)
    .run();
}

/** Persist ON24 (key-only) creds for a tenant. */
export async function storeApiKeyConnection(
  env: Env,
  portalId: string,
  provider: 'on24',
  creds: { clientId: string; tokenKey: string; tokenSecret: string },
): Promise<void> {
  const encKey = getSecret(env, 'TOKEN_ENCRYPTION_KEY');
  const apiCredsEnc = await encryptToken(encKey, JSON.stringify(creds));
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO webinar_connections
       (portal_id, provider, api_creds_enc, account_ref, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5)
     ON CONFLICT (portal_id, provider) DO UPDATE SET
       api_creds_enc = excluded.api_creds_enc,
       account_ref = excluded.account_ref,
       updated_at = excluded.updated_at`,
  )
    .bind(portalId, provider, apiCredsEnc, creds.clientId, now)
    .run();
}

/** Remove a tenant's connection for a provider (disconnect). */
export async function deleteConnection(
  env: Env,
  portalId: string,
  provider: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    'DELETE FROM webinar_connections WHERE portal_id = ?1 AND provider = ?2',
  )
    .bind(portalId, provider)
    .run();
  return res.meta.changes > 0;
}

interface ConnectionRow {
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: string | null;
  api_creds_enc: string | null;
  account_ref: string | null;
}

function loadConnection(
  env: Env,
  portalId: string,
  provider: string,
): Promise<ConnectionRow | null> {
  return env.DB.prepare(
    `SELECT access_token_enc, refresh_token_enc, token_expires_at, api_creds_enc, account_ref
     FROM webinar_connections WHERE portal_id = ?1 AND provider = ?2`,
  )
    .bind(portalId, provider)
    .first<ConnectionRow>();
}

// ---------------------------------------------------------------------------
// Resolution — what providers call
// ---------------------------------------------------------------------------

export class ProviderNotConnectedError extends Error {
  constructor(portalId: string, provider: string) {
    super(`No ${provider} connection for portal ${portalId}`);
    this.name = 'ProviderNotConnectedError';
  }
}

/**
 * Returns a valid OAuth access token for a tenant+provider, refreshing in place
 * when < 5 minutes remain (and persisting the rotated tokens). Throws
 * ProviderNotConnectedError if the tenant has never connected this provider.
 */
export async function getProviderAccessToken(
  env: Env,
  portalId: string,
  provider: OAuthProviderName,
): Promise<string> {
  const row = await loadConnection(env, portalId, provider);
  if (!row?.access_token_enc) throw new ProviderNotConnectedError(portalId, provider);

  const encKey = getSecret(env, 'TOKEN_ENCRYPTION_KEY');

  const expiresAt = row.token_expires_at ? new Date(row.token_expires_at).getTime() : Infinity;
  const needsRefresh = Date.now() > expiresAt - 5 * 60 * 1000;

  if (needsRefresh && row.refresh_token_enc) {
    const refreshToken = await decryptToken(encKey, row.refresh_token_enc);
    const tokens = await postToken(env, provider, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    // Some providers (Zoom) rotate the refresh token; others omit it on refresh.
    await storeOAuthConnection(env, portalId, provider, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? refreshToken,
      expires_in: tokens.expires_in,
    });
    return tokens.access_token;
  }

  return decryptToken(encKey, row.access_token_enc);
}

/** Returns decrypted ON24 creds for a tenant. */
export async function getProviderApiCreds(
  env: Env,
  portalId: string,
  provider: 'on24',
): Promise<{ clientId: string; tokenKey: string; tokenSecret: string }> {
  const row = await loadConnection(env, portalId, provider);
  if (!row?.api_creds_enc) throw new ProviderNotConnectedError(portalId, provider);
  const encKey = getSecret(env, 'TOKEN_ENCRYPTION_KEY');
  return JSON.parse(await decryptToken(encKey, row.api_creds_enc)) as {
    clientId: string;
    tokenKey: string;
    tokenSecret: string;
  };
}

/** Lightweight "is this provider connected?" check for the manage/status UI. */
export async function getConnectionStatus(
  env: Env,
  portalId: string,
): Promise<Array<{ provider: string; accountRef: string | null; connectedAt: string }>> {
  const rows = await env.DB.prepare(
    `SELECT provider, account_ref AS accountRef, created_at AS connectedAt
     FROM webinar_connections WHERE portal_id = ?1 ORDER BY provider`,
  )
    .bind(portalId)
    .all<{ provider: string; accountRef: string | null; connectedAt: string }>();
  return rows.results;
}
