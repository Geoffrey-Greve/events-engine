/**
 * Per-tenant webinar OAuth "Connect" flow.
 *
 *   GET /connect/:provider/start?portalId=…   (ADMIN_SECRET bearer, or signed admin)
 *     Builds the provider consent URL for OUR app and 302s the customer's browser
 *     to it. A signed `state` carries the portal id + a nonce through the round
 *     trip (CSRF defence) — the callback trusts the portal id from state, never a
 *     query param, mirroring the HubSpot callback's "authoritative id" rule.
 *
 *   GET /connect/:provider/callback?code=…&state=…
 *     Verifies state, exchanges the code for tokens, stores them encrypted, and
 *     redirects to the success page. No bearer here (it's a browser redirect from
 *     the provider) — the signed state is the integrity guarantee.
 *
 * ON24 has no OAuth; its creds are saved via PATCH /api/v1/manage/onboarding/
 * webinar-creds (see manage.ts), not this flow.
 */

import type { Context } from 'hono';
import { Hono } from 'hono';
import { authenticateAdmin } from '../checkin';
import { getSecret } from '../config';
import {
  exchangeAuthCode,
  isOAuthProvider,
  OAUTH_PROVIDERS,
  type OAuthProviderName,
  redirectUri,
  storeOAuthConnection,
} from '../providers/oauth';
import type { Env } from '../types';

// ---------------------------------------------------------------------------
// Signed state (HMAC over portalId.nonce.expiry with TOKEN_ENCRYPTION_KEY-derived key)
// ---------------------------------------------------------------------------

const STATE_TTL_MS = 10 * 60 * 1000; // consent must complete within 10 minutes

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

async function stateKey(env: Env): Promise<CryptoKey> {
  // Reuse the platform encryption secret as HMAC material — no new secret needed.
  const raw = new TextEncoder().encode(getSecret(env, 'TOKEN_ENCRYPTION_KEY'));
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

async function signState(env: Env, portalId: string): Promise<string> {
  const payload = `${portalId}.${crypto.randomUUID()}.${Date.now() + STATE_TTL_MS}`;
  const key = await stateKey(env);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return `${b64url(new TextEncoder().encode(payload))}.${b64url(new Uint8Array(sig))}`;
}

/** Verify state and return the portal id, or null if invalid/expired/tampered. */
async function verifyState(env: Env, state: string): Promise<string | null> {
  const [payloadB64, sigB64] = state.split('.');
  if (!payloadB64 || !sigB64) return null;

  const payloadBytes = Uint8Array.from(
    atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')),
    (ch) => ch.charCodeAt(0),
  );
  const sigBytes = Uint8Array.from(atob(sigB64.replace(/-/g, '+').replace(/_/g, '/')), (ch) =>
    ch.charCodeAt(0),
  );

  const key = await stateKey(env);
  // crypto.subtle.verify is constant-time — no early-exit signature leak.
  const ok = await crypto.subtle.verify('HMAC', key, sigBytes, payloadBytes);
  if (!ok) return null;

  const [portalId, , expiryStr] = new TextDecoder().decode(payloadBytes).split('.');
  if (!portalId || !expiryStr) return null;
  if (Date.now() > Number(expiryStr)) return null; // expired
  return portalId;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const connectRoutes = new Hono<{ Bindings: Env }>();

/**
 * Mint the provider consent URL for the authenticated tenant admin.
 *
 * Returns JSON `{ authorizeUrl }` rather than a 302: the onboarding SPA
 * authenticates with X-Portal-Id + admin bearer headers (which a top-level
 * browser navigation can't carry), then does `window.location = authorizeUrl`.
 * The portal id comes from the verified admin identity, never the query string.
 */
connectRoutes.get('/:provider/start', async (c: Context<{ Bindings: Env }>) => {
  const provider = c.req.param('provider') ?? '';
  if (!isOAuthProvider(provider)) {
    return c.json({ error: `Provider ${provider} does not support OAuth connect` }, 400);
  }

  const portalId = authenticateAdmin(c);
  if (!portalId) {
    return c.json({ error: 'Admin credentials required' }, 401);
  }

  const cfg = OAUTH_PROVIDERS[provider];
  const state = await signState(c.env, portalId);

  const url = new URL(cfg.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', getSecret(c.env, `${provider.toUpperCase()}_OAUTH_CLIENT_ID`));
  url.searchParams.set('redirect_uri', redirectUri(c.env, provider));
  url.searchParams.set('scope', cfg.scopes);
  url.searchParams.set('state', state);
  // Google needs these to return a refresh token on first consent.
  if (provider === 'meet') {
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
  }

  return c.json({ authorizeUrl: url.toString() });
});

/** Provider redirects here after consent; exchange + persist tokens. */
connectRoutes.get('/:provider/callback', async (c: Context<{ Bindings: Env }>) => {
  const provider = c.req.param('provider') ?? '';
  if (!isOAuthProvider(provider)) {
    return new Response(`Unknown provider ${provider}.`, { status: 400 });
  }

  const url = new URL(c.req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) return new Response(`Authorization denied: ${error}`, { status: 400 });
  if (!code || !state) return new Response('Missing code or state.', { status: 400 });

  // Authoritative portal id comes from the signed state, never a query param.
  const portalId = await verifyState(c.env, state);
  if (!portalId) return new Response('Invalid or expired authorization state.', { status: 400 });

  let tokens: Awaited<ReturnType<typeof exchangeAuthCode>>;
  try {
    tokens = await exchangeAuthCode(c.env, provider as OAuthProviderName, code);
  } catch (err) {
    return new Response(`Token exchange failed: ${String(err)}`, { status: 502 });
  }

  try {
    await storeOAuthConnection(c.env, portalId, provider as OAuthProviderName, tokens);
  } catch (err) {
    return new Response(`Failed to store connection: ${String(err)}`, { status: 500 });
  }

  let successRedirect: string;
  try {
    successRedirect = getSecret(c.env, 'OAUTH_SUCCESS_REDIRECT_URI');
  } catch {
    successRedirect = 'https://app.hubspot.com';
  }
  return Response.redirect(successRedirect, 302);
});
