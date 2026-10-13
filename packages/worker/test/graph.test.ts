import { afterEach, describe, expect, it, vi } from 'vitest';
import { getGraphToken } from '../src/graph';
import { encryptToken } from '../src/token-crypto';
import type { Env } from '../src/types';

const PORTAL = '99';
const TOKEN_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function makeEnv(row: unknown, extra: Record<string, string> = {}): Env {
  const first = vi.fn(async () => row);
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn(() => ({ bind }));
  const put = vi.fn(async () => undefined);

  return {
    DB: { prepare },
    KV: { get: async () => null, put },
    TOKEN_ENCRYPTION_KEY: TOKEN_KEY,
    ...extra,
  } as unknown as Env;
}

function mockTokenFetch() {
  const spy = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
    return new Response(JSON.stringify({ access_token: 'graph-token', expires_in: 3600 }));
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

function base64UrlDecodeJson(tokenPart: string): Record<string, unknown> {
  const padded =
    tokenPart.length % 4 === 0
      ? tokenPart
      : `${tokenPart}${'='.repeat(4 - (tokenPart.length % 4))}`;
  return JSON.parse(atob(padded.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
}

async function generatePrivateKeyPem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const exported = (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer;
  let binary = '';
  for (const byte of new Uint8Array(exported)) binary += String.fromCharCode(byte);
  return `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`;
}

afterEach(() => vi.unstubAllGlobals());

describe('getGraphToken', () => {
  it('prefers Teams credentials saved by onboarding', async () => {
    const encrypted = await encryptToken(
      TOKEN_KEY,
      JSON.stringify({
        provider: 'teams',
        tenantId: 'tenant-from-onboarding',
        clientId: 'client-from-onboarding',
        clientSecret: 'secret-from-onboarding',
      }),
    );
    const env = makeEnv(
      {
        webinar_provider: 'teams',
        webinar_creds_enc: encrypted,
      },
      {
        [`GRAPH_TENANT_ID_${PORTAL}`]: 'tenant-from-secret',
        [`GRAPH_CLIENT_ID_${PORTAL}`]: 'client-from-secret',
        [`GRAPH_CLIENT_SECRET_${PORTAL}`]: 'secret-from-secret',
      },
    );
    const fetchSpy = mockTokenFetch();

    const token = await getGraphToken(env, PORTAL);

    expect(token).toBe('graph-token');
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/tenant-from-onboarding/');
    const body = fetchSpy.mock.calls[0][1]?.body as URLSearchParams;
    expect(body.get('client_id')).toBe('client-from-onboarding');
    expect(body.get('client_secret')).toBe('secret-from-onboarding');
  });

  it('falls back to per-tenant Cloudflare secrets when onboarding credentials are absent', async () => {
    const env = makeEnv(null, {
      [`GRAPH_TENANT_ID_${PORTAL}`]: 'tenant-from-secret',
      [`GRAPH_CLIENT_ID_${PORTAL}`]: 'client-from-secret',
      [`GRAPH_CLIENT_SECRET_${PORTAL}`]: 'secret-from-secret',
    });
    const fetchSpy = mockTokenFetch();

    const token = await getGraphToken(env, PORTAL);

    expect(token).toBe('graph-token');
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/tenant-from-secret/');
    const body = fetchSpy.mock.calls[0][1]?.body as URLSearchParams;
    expect(body.get('client_id')).toBe('client-from-secret');
    expect(body.get('client_secret')).toBe('secret-from-secret');
  });

  it('uses certificate client assertion when certificate secrets are present', async () => {
    const privateKeyPem = await generatePrivateKeyPem();
    const env = makeEnv(null, {
      [`GRAPH_TENANT_ID_${PORTAL}`]: 'tenant-from-secret',
      [`GRAPH_CLIENT_ID_${PORTAL}`]: 'client-from-secret',
      [`GRAPH_CLIENT_CERT_PRIVATE_KEY_${PORTAL}`]: privateKeyPem,
      [`GRAPH_CLIENT_CERT_THUMBPRINT_${PORTAL}`]: '00112233445566778899aabbccddeeff00112233',
    });
    const fetchSpy = mockTokenFetch();

    await expect(getGraphToken(env, PORTAL)).resolves.toBe('graph-token');

    const body = fetchSpy.mock.calls[0][1]?.body as URLSearchParams;
    expect(body.get('client_secret')).toBeNull();
    expect(body.get('client_assertion_type')).toBe(
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    );
    const assertion = body.get('client_assertion');
    if (!assertion) throw new Error('expected a client_assertion on the token request');
    const [headerPart, payloadPart, signaturePart] = assertion.split('.');
    expect(signaturePart).toBeTruthy();
    expect(base64UrlDecodeJson(headerPart)).toMatchObject({ alg: 'RS256', typ: 'JWT' });
    expect(base64UrlDecodeJson(payloadPart)).toMatchObject({
      aud: 'https://login.microsoftonline.com/tenant-from-secret/oauth2/v2.0/token',
      iss: 'client-from-secret',
      sub: 'client-from-secret',
    });
  });
});
