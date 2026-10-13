import { getSecret } from './config';
import type { Env } from './types';

interface OAuthStatePayload {
  portalId?: string;
  nonce: string;
  expiresAt: number;
}

function encode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decode(value: string): Uint8Array {
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function getSigningKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(getSecret(env, 'HUBSPOT_CLIENT_SECRET')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function createOAuthState(env: Env, portalId?: string): Promise<string> {
  const payload: OAuthStatePayload = {
    portalId,
    nonce: crypto.randomUUID(),
    expiresAt: Date.now() + 10 * 60 * 1000,
  };
  const encoded = encode(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    'HMAC',
    await getSigningKey(env),
    new TextEncoder().encode(encoded),
  );
  return `${encoded}.${encode(new Uint8Array(signature))}`;
}

export async function verifyOAuthState(env: Env, state: string): Promise<OAuthStatePayload> {
  const [encoded, signature] = state.split('.');
  if (!encoded || !signature) throw new Error('Malformed OAuth state');
  const valid = await crypto.subtle.verify(
    'HMAC',
    await getSigningKey(env),
    decode(signature),
    new TextEncoder().encode(encoded),
  );
  if (!valid) throw new Error('Invalid OAuth state signature');
  const payload = JSON.parse(new TextDecoder().decode(decode(encoded))) as OAuthStatePayload;
  if (!payload.nonce || !payload.expiresAt || payload.expiresAt < Date.now()) {
    throw new Error('OAuth state has expired');
  }
  return payload;
}
