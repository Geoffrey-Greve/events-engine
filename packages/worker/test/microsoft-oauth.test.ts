import { env } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getMicrosoftDelegatedGraphToken } from '../src/microsoft-graph';
import { getConnectionStatus } from '../src/providers/oauth';
import { microsoftOAuthRoutes } from '../src/routes/microsoft-oauth';
import { encryptToken } from '../src/token-crypto';
import type { Env } from '../src/types';
import { seedTenant } from './support/fixtures';

const PORTAL = 'ms-1';
const ADMIN_KEY = 'admin-key-ms-1';
const TOKEN_KEY = '0'.repeat(64);

const E = {
  ...(env as unknown as Record<string, unknown>),
  [`ADMIN_API_KEY_${PORTAL}`]: ADMIN_KEY,
  [`GRAPH_TENANT_ID_${PORTAL}`]: 'tenant-id',
  [`GRAPH_CLIENT_ID_${PORTAL}`]: 'client-id',
  [`GRAPH_CLIENT_SECRET_${PORTAL}`]: 'client-secret',
  MICROSOFT_OAUTH_REDIRECT_URI: 'https://worker.test/oauth/microsoft/callback',
} as unknown as Env;

const adminHeaders = { 'X-Portal-Id': PORTAL, Authorization: `Bearer ${ADMIN_KEY}` };

beforeAll(() => seedTenant(E.DB, PORTAL));

afterEach(async () => {
  vi.unstubAllGlobals();
  await E.DB.prepare('DELETE FROM webinar_connections WHERE portal_id = ?1').bind(PORTAL).run();
});

function jwtWithClaims(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${encode({ alg: 'none' })}.${encode(claims)}.sig`;
}

describe('GET /oauth/microsoft/start', () => {
  it('requires admin auth', async () => {
    const res = await microsoftOAuthRoutes.request('/start', {}, E);
    expect(res.status).toBe(401);
  });

  it('returns a Microsoft authorize URL for the tenant app', async () => {
    const res = await microsoftOAuthRoutes.request('/start', { headers: adminHeaders }, E);
    expect(res.status).toBe(200);
    const body = await res.json<{ authorizeUrl: string; redirectUri: string; scopes: string }>();
    const url = new URL(body.authorizeUrl);

    expect(url.origin + url.pathname).toBe(
      'https://login.microsoftonline.com/tenant-id/oauth2/v2.0/authorize',
    );
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://worker.test/oauth/microsoft/callback',
    );
    expect(url.searchParams.get('scope')).toContain('VirtualEvent.ReadWrite');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(body.redirectUri).toBe('https://worker.test/oauth/microsoft/callback');
    expect(body.scopes).toContain('offline_access');
  });
});

describe('GET /oauth/microsoft/callback', () => {
  it('rejects an invalid state', async () => {
    const res = await microsoftOAuthRoutes.request('/callback?code=abc&state=bad-state', {}, E);
    expect(res.status).toBe(400);
  });

  it('exchanges code and stores encrypted delegated Teams tokens', async () => {
    const start = await microsoftOAuthRoutes.request('/start', { headers: adminHeaders }, E);
    const { authorizeUrl } = await start.json<{ authorizeUrl: string }>();
    const state = new URL(authorizeUrl).searchParams.get('state');
    if (!state) throw new Error('expected a state param on the authorize URL');
    const accessToken = jwtWithClaims({
      preferred_username: 'event.organiser@weldaustralia.com.au',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: accessToken,
              refresh_token: 'refresh-token',
              expires_in: 3600,
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    const res = await microsoftOAuthRoutes.request(
      `/callback?code=the-code&state=${encodeURIComponent(state)}`,
      { redirect: 'manual' },
      E,
    );

    expect([301, 302]).toContain(res.status);
    const conns = await getConnectionStatus(E, PORTAL);
    expect(conns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'teams',
          accountRef: 'event.organiser@weldaustralia.com.au',
        }),
      ]),
    );
  });
});

describe('getMicrosoftDelegatedGraphToken', () => {
  it('refreshes an expired delegated Teams token', async () => {
    const expiredAccessEnc = await encryptToken(TOKEN_KEY, 'expired-access-token');
    const refreshEnc = await encryptToken(TOKEN_KEY, 'refresh-token');
    await E.DB.prepare(
      `INSERT INTO webinar_connections
         (portal_id, provider, access_token_enc, refresh_token_enc, token_expires_at, account_ref, created_at, updated_at)
       VALUES (?1, 'teams', ?2, ?3, ?4, 'old-account', ?5, ?5)`,
    )
      .bind(
        PORTAL,
        expiredAccessEnc,
        refreshEnc,
        new Date(Date.now() - 60_000).toISOString(),
        new Date().toISOString(),
      )
      .run();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const body = init?.body as URLSearchParams;
        expect(body.get('grant_type')).toBe('refresh_token');
        expect(body.get('refresh_token')).toBe('refresh-token');
        return new Response(
          JSON.stringify({ access_token: 'fresh-access-token', expires_in: 3600 }),
          { headers: { 'content-type': 'application/json' } },
        );
      }),
    );

    await expect(getMicrosoftDelegatedGraphToken(E, PORTAL)).resolves.toBe('fresh-access-token');
  });
});
