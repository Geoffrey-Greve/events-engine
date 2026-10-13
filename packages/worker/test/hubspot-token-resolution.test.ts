import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { getAccessToken, storeTokens } from '../src/hubspot-oauth';
import { resolveHubSpotReadToken } from '../src/membership';
import type { Env } from '../src/types';

// A single-portal deployment authenticates with a per-portal service key /
// private-app token in HUBSPOT_API_KEY_{portalId} and never runs the OAuth
// install. Every HubSpot caller resolves through getAccessToken, so the static
// token has to win there — not just in the two call sites that once special-cased it.

const E = env as unknown as Env;
const withKey = (portalId: string, token: string) =>
  ({ ...E, [`HUBSPOT_API_KEY_${portalId}`]: token }) as unknown as Env;

// Suites share one D1 (singleWorker, isolatedStorage off) and each declares the
// `tenants` columns it needs, so whichever runs first fixes the schema. Add the
// token columns if that suite wasn't this one.

describe('HubSpot token resolution', () => {
  it('uses the per-portal static token with no tenant row at all', async () => {
    const portal = 'p-static-only';
    expect(await getAccessToken(withKey(portal, 'pat-na1-static'), portal)).toBe('pat-na1-static');
  });

  it('prefers the static token over stored OAuth tokens', async () => {
    const portal = 'p-both';
    await E.DB.prepare(
      "INSERT OR IGNORE INTO tenants (portal_id, display_name) VALUES (?1, 'Test Tenant')",
    )
      .bind(portal)
      .run();
    await storeTokens(E, portal, 'oauth-access', 'oauth-refresh', 3600);

    expect(await getAccessToken(E, portal)).toBe('oauth-access');
    expect(await getAccessToken(withKey(portal, 'static-wins'), portal)).toBe('static-wins');
  });

  it('names both remedies when a portal has neither credential', async () => {
    await expect(getAccessToken(E, 'p-unconfigured')).rejects.toThrow(
      /HUBSPOT_API_KEY_p-unconfigured.*OAuth install/s,
    );
  });

  it('resolves the read token for membership without an OAuth install', async () => {
    const portal = 'p-read';
    expect(await resolveHubSpotReadToken(withKey(portal, 'read-token'), portal)).toBe('read-token');
    expect(await resolveHubSpotReadToken(E, 'p-none')).toBeNull();
  });
});
