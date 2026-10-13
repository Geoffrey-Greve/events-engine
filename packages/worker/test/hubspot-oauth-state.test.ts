import { describe, expect, it } from 'vitest';
import { createOAuthState, verifyOAuthState } from '../src/hubspot-oauth-state';
import type { Env } from '../src/types';

const env = {
  HUBSPOT_CLIENT_SECRET: 'hubspot-app-secret',
} as unknown as Env;

describe('HubSpot OAuth state', () => {
  it('round-trips the intended portal id', async () => {
    const state = await createOAuthState(env, '441838610');
    expect((await verifyOAuthState(env, state)).portalId).toBe('441838610');
  });

  it('rejects a modified signature', async () => {
    const state = await createOAuthState(env, '441838610');
    const [payload, signature] = state.split('.');
    const modifiedSignature = `${signature.startsWith('a') ? 'b' : 'a'}${signature.slice(1)}`;
    const modified = `${payload}.${modifiedSignature}`;
    await expect(verifyOAuthState(env, modified)).rejects.toThrow('Invalid OAuth state');
  });
});
