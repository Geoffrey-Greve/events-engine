/**
 * AES-GCM encryption for OAuth tokens stored in D1.
 *
 * Key material comes from the TOKEN_ENCRYPTION_KEY Wrangler secret (32 hex-encoded bytes,
 * i.e. a 64-character hex string). IV is random per encryption and prepended to the ciphertext
 * so the same function handles both; output is base64url.
 */

function hexToBytes(hex: string): Uint8Array {
  if (hex.length !== 64) throw new Error('TOKEN_ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function importKey(hexKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', hexToBytes(hexKey), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ]);
}

function toBase64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function fromBase64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  // Re-pad to a multiple of 4 so atob accepts it. Base64 length is never ≡1 mod 4,
  // so this adds 0, 1, or 2 '=' as required.
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function encryptToken(hexKey: string, plaintext: string): Promise<string> {
  const key = await importKey(hexKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  // Prepend IV (12 bytes) to ciphertext.
  const combined = new Uint8Array(12 + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), 12);
  return toBase64url(combined.buffer);
}

export async function decryptToken(hexKey: string, encoded: string): Promise<string> {
  const key = await importKey(hexKey);
  const combined = fromBase64url(encoded);
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(plaintext);
}
