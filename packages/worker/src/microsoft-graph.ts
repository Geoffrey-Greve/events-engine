/**
 * Microsoft Graph delegated organiser auth for true Teams Webinars.
 *
 * App-only Graph tokens are still useful for some background operations, but
 * `POST /solutions/virtualEvents/webinars` is delegated-only. This module owns
 * the one-time organiser consent flow and the encrypted access/refresh token
 * used when Event Engine needs to create webinars as the nominated organiser.
 */

import { getSecret } from './config';
import { GraphError, getGraphCredentials } from './graph';
import {
  appendMicrosoftClientAssertion,
  buildMicrosoftClientAssertion,
} from './microsoft-client-assertion';
import { decryptToken, encryptToken } from './token-crypto';
import type { Env } from './types';

export const MICROSOFT_TEAMS_PROVIDER = 'teams';
export const DEFAULT_MICROSOFT_DELEGATED_SCOPES = 'offline_access VirtualEvent.ReadWrite';

interface MicrosoftTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

interface ConnectionRow {
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: string | null;
  account_ref: string | null;
  updated_at: string | null;
}

function optionalSecret(env: Env, name: string): string | null {
  try {
    return getSecret(env, name);
  } catch {
    return null;
  }
}

export function microsoftDelegatedScopes(env: Env): string {
  return (
    optionalSecret(env, 'MICROSOFT_GRAPH_DELEGATED_SCOPES')?.trim() ||
    DEFAULT_MICROSOFT_DELEGATED_SCOPES
  );
}

export function microsoftRedirectUri(env: Env, requestUrl?: string): string {
  const configured = optionalSecret(env, 'MICROSOFT_OAUTH_REDIRECT_URI');
  if (configured) return configured;

  const base = optionalSecret(env, 'WEBINAR_OAUTH_REDIRECT_BASE');
  if (base) return `${base.replace(/\/$/, '')}/oauth/microsoft/callback`;

  if (requestUrl) {
    const url = new URL(requestUrl);
    return `${url.origin}/oauth/microsoft/callback`;
  }

  throw new Error('MICROSOFT_OAUTH_REDIRECT_URI or WEBINAR_OAUTH_REDIRECT_BASE is required');
}

function tokenEndpoint(tenantId: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
}

function authorizeEndpoint(tenantId: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/authorize`;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const [, payload] = token.split('.');
  if (!payload) return null;
  try {
    const padded =
      payload.length % 4 === 0 ? payload : `${payload}${'='.repeat(4 - (payload.length % 4))}`;
    const json = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function accountRefFromAccessToken(accessToken: string): string | null {
  const claims = decodeJwtPayload(accessToken);
  const candidates = [claims?.preferred_username, claims?.upn, claims?.email, claims?.oid];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

async function postMicrosoftToken(
  env: Env,
  portalId: string,
  params: Record<string, string>,
): Promise<MicrosoftTokenResponse> {
  const creds = await getGraphCredentials(env, portalId);
  const endpoint = tokenEndpoint(creds.aadTenantId);
  const body = new URLSearchParams({
    client_id: creds.clientId,
    ...params,
  });

  if (creds.certificate) {
    const assertion = await buildMicrosoftClientAssertion({
      clientId: creds.clientId,
      tokenEndpoint: endpoint,
      certificate: creds.certificate,
    });
    appendMicrosoftClientAssertion(body, assertion);
  } else if (creds.clientSecret) {
    body.set('client_secret', creds.clientSecret);
  } else {
    throw new Error(
      `Microsoft delegated credentials for portal ${portalId} need client secret or certificate auth`,
    );
  }

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new GraphError(
      `Microsoft delegated token request failed (${resp.status}): ${detail}`,
      resp.status,
    );
  }

  return resp.json<MicrosoftTokenResponse>();
}

async function loadMicrosoftConnection(env: Env, portalId: string): Promise<ConnectionRow | null> {
  return env.DB.prepare(
    `SELECT access_token_enc, refresh_token_enc, token_expires_at, account_ref, updated_at
     FROM webinar_connections WHERE portal_id = ?1 AND provider = ?2`,
  )
    .bind(portalId, MICROSOFT_TEAMS_PROVIDER)
    .first<ConnectionRow>();
}

async function storeMicrosoftConnection(
  env: Env,
  portalId: string,
  tokens: MicrosoftTokenResponse,
  refreshTokenFallback?: string,
): Promise<void> {
  const encKey = getSecret(env, 'TOKEN_ENCRYPTION_KEY');
  const accessEnc = await encryptToken(encKey, tokens.access_token);
  const refreshToken = tokens.refresh_token ?? refreshTokenFallback;
  const refreshEnc = refreshToken ? await encryptToken(encKey, refreshToken) : null;
  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;
  const accountRef = accountRefFromAccessToken(tokens.access_token);
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
    .bind(portalId, MICROSOFT_TEAMS_PROVIDER, accessEnc, refreshEnc, expiresAt, accountRef, now)
    .run();
}

export async function buildMicrosoftAuthorizeUrl(
  env: Env,
  portalId: string,
  state: string,
  redirectUri: string,
): Promise<string> {
  const creds = await getGraphCredentials(env, portalId);
  const url = new URL(authorizeEndpoint(creds.aadTenantId));
  url.searchParams.set('client_id', creds.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', microsoftDelegatedScopes(env));
  url.searchParams.set('state', state);

  const loginHint =
    optionalSecret(env, `MICROSOFT_ORGANISER_EMAIL_${portalId}`) ??
    optionalSecret(env, `GRAPH_ORGANISER_EMAIL_${portalId}`);
  if (loginHint) url.searchParams.set('login_hint', loginHint);

  return url.toString();
}

export async function exchangeMicrosoftAuthorizationCode(
  env: Env,
  portalId: string,
  code: string,
  redirectUri: string,
): Promise<void> {
  const tokens = await postMicrosoftToken(env, portalId, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    scope: microsoftDelegatedScopes(env),
  });
  await storeMicrosoftConnection(env, portalId, tokens);
}

export async function getMicrosoftDelegatedGraphToken(env: Env, portalId: string): Promise<string> {
  const row = await loadMicrosoftConnection(env, portalId);
  if (!row?.access_token_enc) {
    throw new Error(`Microsoft Teams delegated organiser is not connected for portal ${portalId}`);
  }

  const encKey = getSecret(env, 'TOKEN_ENCRYPTION_KEY');
  const expiresAt = row.token_expires_at ? new Date(row.token_expires_at).getTime() : Infinity;
  const needsRefresh = Date.now() > expiresAt - 5 * 60 * 1000;

  if (needsRefresh) {
    if (!row.refresh_token_enc) {
      throw new Error(
        `Microsoft Teams delegated token expired and no refresh token is stored for portal ${portalId}`,
      );
    }

    const refreshToken = await decryptToken(encKey, row.refresh_token_enc);
    const tokens = await postMicrosoftToken(env, portalId, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: microsoftDelegatedScopes(env),
    });
    await storeMicrosoftConnection(env, portalId, tokens, refreshToken);
    return tokens.access_token;
  }

  return decryptToken(encKey, row.access_token_enc);
}

export async function getMicrosoftConnectionStatus(
  env: Env,
  portalId: string,
): Promise<{
  connected: boolean;
  accountRef: string | null;
  tokenExpiresAt: string | null;
  hasRefreshToken: boolean;
  updatedAt: string | null;
}> {
  const row = await loadMicrosoftConnection(env, portalId);
  return {
    connected: !!row?.access_token_enc,
    accountRef: row?.account_ref ?? null,
    tokenExpiresAt: row?.token_expires_at ?? null,
    hasRefreshToken: !!row?.refresh_token_enc,
    updatedAt: row?.updated_at ?? null,
  };
}
