import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deleteConnection,
  getConnectionStatus,
  getProviderAccessToken,
  getProviderApiCreds,
  ProviderNotConnectedError,
  storeApiKeyConnection,
  storeOAuthConnection,
} from '../src/providers/oauth';
import type { Env } from '../src/types';
import { seedTenant } from './support/fixtures';

// Exercises the real credential layer against Miniflare's D1 + Web Crypto: tokens
// are AES-GCM encrypted at rest (TOKEN_ENCRYPTION_KEY from vitest.config), refresh
// fires only when expiry is near, and ON24 key creds round-trip. Only the token
// endpoint (fetch) is stubbed.

const E = env as unknown as Env;

let counter = 0;
// `webinar_connections.portal_id` REFERENCES `tenants`, so register it as it is minted.
const freshPortal = async () => seedTenant(E.DB, `p-${Date.now()}-${counter++}`);

afterEach(() => vi.unstubAllGlobals());

describe('OAuth connection storage + resolution', () => {
  it('round-trips an access token with a far-future expiry (no refresh)', async () => {
    const portal = await freshPortal();
    await storeOAuthConnection(E, portal, 'zoom', {
      access_token: 'at-1',
      refresh_token: 'rt-1',
      expires_in: 3600,
    });

    // fetch must NOT be called — the token is fresh.
    const spy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', spy);

    const token = await getProviderAccessToken(E, portal, 'zoom');
    expect(token).toBe('at-1');
    expect(spy).not.toHaveBeenCalled();
  });

  it('stores tokens encrypted, not in plaintext', async () => {
    const portal = await freshPortal();
    await storeOAuthConnection(E, portal, 'meet', {
      access_token: 'super-secret-token',
      refresh_token: 'rt',
      expires_in: 3600,
    });
    const row = await E.DB.prepare(
      'SELECT access_token_enc FROM webinar_connections WHERE portal_id = ?1 AND provider = ?2',
    )
      .bind(portal, 'meet')
      .first<{ access_token_enc: string }>();
    expect(row?.access_token_enc).toBeTruthy();
    expect(row?.access_token_enc).not.toContain('super-secret-token');
  });

  it('refreshes when the token is within 5 minutes of expiry and persists rotation', async () => {
    const portal = await freshPortal();
    await storeOAuthConnection(E, portal, 'zoom', {
      access_token: 'stale',
      refresh_token: 'rt-old',
      expires_in: 60, // expires in 1 min → inside the 5-min refresh window
    });

    const spy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ access_token: 'fresh', refresh_token: 'rt-new', expires_in: 3600 }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', spy);

    const token = await getProviderAccessToken(E, portal, 'zoom');
    expect(token).toBe('fresh');
    expect(spy).toHaveBeenCalledOnce();

    // The rotated refresh token is persisted; a second call returns the new
    // access token from storage without refreshing again.
    const second = await getProviderAccessToken(E, portal, 'zoom');
    expect(second).toBe('fresh');
    expect(spy).toHaveBeenCalledOnce();
  });

  it('throws ProviderNotConnectedError when the tenant never connected', async () => {
    await expect(getProviderAccessToken(E, await freshPortal(), 'vimeo')).rejects.toBeInstanceOf(
      ProviderNotConnectedError,
    );
  });

  it('round-trips ON24 api creds', async () => {
    const portal = await freshPortal();
    await storeApiKeyConnection(E, portal, 'on24', {
      clientId: 'cid',
      tokenKey: 'tk',
      tokenSecret: 'ts',
    });
    const creds = await getProviderApiCreds(E, portal, 'on24');
    expect(creds).toEqual({ clientId: 'cid', tokenKey: 'tk', tokenSecret: 'ts' });
  });

  it('lists connections and supports disconnect', async () => {
    const portal = await freshPortal();
    await storeOAuthConnection(E, portal, 'wistia', {
      access_token: 'at',
      refresh_token: 'rt',
      expires_in: 3600,
    });
    let conns = await getConnectionStatus(E, portal);
    expect(conns.map((c) => c.provider)).toContain('wistia');

    expect(await deleteConnection(E, portal, 'wistia')).toBe(true);
    conns = await getConnectionStatus(E, portal);
    expect(conns).toHaveLength(0);
    expect(await deleteConnection(E, portal, 'wistia')).toBe(false);
  });
});
