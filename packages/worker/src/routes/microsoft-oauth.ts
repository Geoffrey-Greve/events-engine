/**
 * Microsoft organiser OAuth routes.
 *
 * These routes are intentionally separate from the generic /connect provider
 * flow because Microsoft Teams Webinar creation uses the customer tenant's app
 * registration and the redirect URI Varant is configuring:
 *   /oauth/microsoft/callback
 */

import type { Context } from 'hono';
import { Hono } from 'hono';
import { authenticateAdmin } from '../checkin';
import { getSecret } from '../config';
import { getGraphCredentials } from '../graph';
import {
  buildMicrosoftAuthorizeUrl,
  exchangeMicrosoftAuthorizationCode,
  getMicrosoftConnectionStatus,
  microsoftDelegatedScopes,
  microsoftRedirectUri,
} from '../microsoft-graph';
import type { Env } from '../types';

const STATE_TTL_MS = 10 * 60 * 1000;

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function b64urlToBytes(value: string): Uint8Array {
  const padded = value.length % 4 === 0 ? value : `${value}${'='.repeat(4 - (value.length % 4))}`;
  const bin = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function stateKey(env: Env): Promise<CryptoKey> {
  const raw = new TextEncoder().encode(getSecret(env, 'TOKEN_ENCRYPTION_KEY'));
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

async function signState(env: Env, portalId: string): Promise<string> {
  const payload = JSON.stringify({
    kind: 'microsoft-teams',
    portalId,
    nonce: crypto.randomUUID(),
    exp: Date.now() + STATE_TTL_MS,
  });
  const key = await stateKey(env);
  const payloadBytes = new TextEncoder().encode(payload);
  const sig = await crypto.subtle.sign('HMAC', key, payloadBytes);
  return `${b64url(payloadBytes)}.${b64url(new Uint8Array(sig))}`;
}

async function verifyState(env: Env, state: string): Promise<string | null> {
  const [payloadB64, sigB64] = state.split('.');
  if (!payloadB64 || !sigB64) return null;

  const payloadBytes = b64urlToBytes(payloadB64);
  const sigBytes = b64urlToBytes(sigB64);
  const key = await stateKey(env);
  const ok = await crypto.subtle.verify('HMAC', key, sigBytes, payloadBytes);
  if (!ok) return null;

  let payload: { kind?: string; portalId?: string; exp?: number };
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as typeof payload;
  } catch {
    return null;
  }

  if (payload.kind !== 'microsoft-teams') return null;
  if (!payload.portalId || typeof payload.exp !== 'number') return null;
  if (Date.now() > payload.exp) return null;
  return payload.portalId;
}

export const microsoftOAuthRoutes = new Hono<{ Bindings: Env }>();

microsoftOAuthRoutes.get('/start', async (c: Context<{ Bindings: Env }>) => {
  const portalId = authenticateAdmin(c);
  if (!portalId) return c.json({ error: 'Admin credentials required' }, 401);

  const redirectUri = microsoftRedirectUri(c.env, c.req.url);
  const state = await signState(c.env, portalId);
  const authorizeUrl = await buildMicrosoftAuthorizeUrl(c.env, portalId, state, redirectUri);

  return c.json({
    authorizeUrl,
    redirectUri,
    scopes: microsoftDelegatedScopes(c.env),
  });
});

microsoftOAuthRoutes.get('/callback', async (c: Context<{ Bindings: Env }>) => {
  const url = new URL(c.req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) return new Response(`Microsoft authorization denied: ${error}`, { status: 400 });
  if (!code || !state) return new Response('Missing code or state.', { status: 400 });

  const portalId = await verifyState(c.env, state);
  if (!portalId)
    return new Response('Invalid or expired Microsoft authorization state.', { status: 400 });

  try {
    await exchangeMicrosoftAuthorizationCode(
      c.env,
      portalId,
      code,
      microsoftRedirectUri(c.env, c.req.url),
    );
  } catch (err) {
    return new Response(`Microsoft token exchange failed: ${String(err)}`, { status: 502 });
  }

  let successRedirect: string;
  try {
    successRedirect = getSecret(c.env, 'OAUTH_SUCCESS_REDIRECT_URI');
  } catch {
    successRedirect = 'https://app.hubspot.com';
  }
  return Response.redirect(successRedirect, 302);
});

microsoftOAuthRoutes.get('/status', async (c: Context<{ Bindings: Env }>) => {
  const portalId = authenticateAdmin(c);
  if (!portalId) return c.json({ error: 'Admin credentials required' }, 401);

  let credentialsConfigured = true;
  try {
    await getGraphCredentials(c.env, portalId);
  } catch {
    credentialsConfigured = false;
  }

  const connection = await getMicrosoftConnectionStatus(c.env, portalId);
  return c.json({
    portalId,
    provider: 'teams',
    credentialsConfigured,
    ...connection,
  });
});
