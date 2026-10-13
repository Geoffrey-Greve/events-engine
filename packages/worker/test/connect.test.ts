import { env } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getConnectionStatus } from '../src/providers/oauth';
import { connectRoutes } from '../src/routes/connect';
import type { Env } from '../src/types';
import { seedTenant } from './support/fixtures';

// Drives the /connect sub-app directly (it's an exported Hono instance). D1 is the
// real Miniflare binding; the provider token endpoint (fetch) is stubbed. The
// admin identity uses ADMIN_API_KEY_<portalId> + X-Portal-Id, matching
// authenticateAdmin. Platform OAuth client id/secret come from vitest.config.

const PORTAL = 'cp-1';
const ADMIN_KEY = 'admin-key-cp-1';

// authenticateAdmin reads ADMIN_API_KEY_<portalId>; inject it onto the env we pass
// into the sub-app's fetch handler.
const E = {
  ...(env as unknown as Record<string, unknown>),
  [`ADMIN_API_KEY_${PORTAL}`]: ADMIN_KEY,
} as unknown as Env;

beforeAll(() => seedTenant(E.DB, PORTAL));

afterEach(() => vi.unstubAllGlobals());

const adminHeaders = { 'X-Portal-Id': PORTAL, Authorization: `Bearer ${ADMIN_KEY}` };

describe('GET /connect/:provider/start', () => {
  it('rejects a non-OAuth provider', async () => {
    const res = await connectRoutes.request('/on24/start', { headers: adminHeaders }, E);
    expect(res.status).toBe(400);
  });

  it('requires admin auth', async () => {
    const res = await connectRoutes.request('/zoom/start', {}, E);
    expect(res.status).toBe(401);
  });

  it('returns a well-formed authorize URL for an authed admin', async () => {
    const res = await connectRoutes.request('/zoom/start', { headers: adminHeaders }, E);
    expect(res.status).toBe(200);
    const { authorizeUrl } = await res.json<{ authorizeUrl: string }>();
    const url = new URL(authorizeUrl);
    expect(url.origin + url.pathname).toBe('https://zoom.us/oauth/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('zoom-app-id');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('asks Google for offline access so a refresh token is issued', async () => {
    // Google (meet) needs platform creds too; inject for this case.
    const envWithGoogle = {
      ...(E as unknown as Record<string, unknown>),
      MEET_OAUTH_CLIENT_ID: 'g-id',
      MEET_OAUTH_CLIENT_SECRET: 'g-secret',
    } as unknown as Env;
    const res = await connectRoutes.request(
      '/meet/start',
      { headers: adminHeaders },
      envWithGoogle,
    );
    expect(res.status).toBe(200);
    const { authorizeUrl } = await res.json<{ authorizeUrl: string }>();
    const url = new URL(authorizeUrl);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });
});

describe('GET /connect/:provider/callback', () => {
  it('rejects a tampered/invalid state', async () => {
    const res = await connectRoutes.request(
      '/zoom/callback?code=abc&state=not-a-valid-state',
      {},
      E,
    );
    expect(res.status).toBe(400);
  });

  it('exchanges the code and persists an encrypted connection on valid state', async () => {
    // Mint a real signed state via the start endpoint.
    const startRes = await connectRoutes.request('/zoom/start', { headers: adminHeaders }, E);
    const { authorizeUrl } = await startRes.json<{ authorizeUrl: string }>();
    const state = new URL(authorizeUrl).searchParams.get('state');
    expect(state).toBeTruthy();
    if (!state) throw new Error('expected state');

    // Stub the Zoom token endpoint.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }),
            { headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    const res = await connectRoutes.request(
      `/zoom/callback?code=the-code&state=${encodeURIComponent(state)}`,
      { redirect: 'manual' },
      E,
    );
    // Redirects to the success page on success.
    expect([301, 302]).toContain(res.status);

    const conns = await getConnectionStatus(E, PORTAL);
    expect(conns.map((c) => c.provider)).toContain('zoom');
  });

  it('rejects when the provider returns an error param', async () => {
    const res = await connectRoutes.request('/zoom/callback?error=access_denied', {}, E);
    expect(res.status).toBe(400);
  });
});
