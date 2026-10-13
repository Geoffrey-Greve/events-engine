import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  HUBSPOT_OAUTH_SCOPES,
  HUBSPOT_OAUTH_SECRETS,
  handleOAuthInstall,
} from '../src/routes/oauth-install';
import type { Env } from '../src/types';

// The install redirect is the very first thing a HubSpot admin touches. When the
// deployment has no app credentials it must say so, not fall through getSecret
// into the generic 500 handler with an opaque reference.

const E = env as unknown as Env;

function ctx(env: Env, url = 'https://worker.test/oauth/install?portalId=443253065') {
  return {
    env,
    req: { url, method: 'GET' },
    json: (body: unknown, status?: number) =>
      Response.json(body as Record<string, unknown>, { status: status ?? 200 }),
  } as unknown as Parameters<typeof handleOAuthInstall>[0];
}

describe('GET /oauth/install', () => {
  it('redirects to HubSpot authorize with scopes, state and portal id', async () => {
    const res = await handleOAuthInstall(ctx(E));
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get('location') ?? '');
    expect(location.origin + location.pathname).toBe('https://app.hubspot.com/oauth/authorize');
    expect(location.searchParams.get('client_id')).toBe('hubspot-app-id');
    expect(location.searchParams.get('scope')).toBe(HUBSPOT_OAUTH_SCOPES.join(' '));
    expect(location.searchParams.get('portalId')).toBe('443253065');
    // Signed state: payload.signature.
    expect(location.searchParams.get('state')?.split('.')).toHaveLength(2);
  });

  it.each(HUBSPOT_OAUTH_SECRETS)('answers 503, not 500, when %s is unset', async (name) => {
    const res = await handleOAuthInstall(ctx({ ...E, [name]: undefined } as unknown as Env));
    expect(res.status).toBe(503);

    const body = await res.json<{ status: string; message: string }>();
    expect(body.status).toBe('not_configured');
    // The remedy is in the message; the secret names stay in the log.
    expect(body.message).toContain('Worker secrets');
    expect(body.message).not.toContain(name);
  });
});
