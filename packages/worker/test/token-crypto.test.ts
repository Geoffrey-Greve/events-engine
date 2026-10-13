import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken } from '../src/token-crypto';

// AES-GCM round-trip over the base64url codec. The regression guard: decrypt must
// work for EVERY plaintext length, since ciphertext length varies and the
// base64url un-padding previously only handled one length-residue (it threw atob
// errors otherwise — and this same codec protects HubSpot OAuth tokens).

const KEY = '0'.repeat(64); // 32 zero bytes — a valid AES-GCM key for tests

describe('token-crypto base64url round-trip', () => {
  it('round-trips a range of plaintext lengths (covers every mod-4 residue)', async () => {
    for (let len = 0; len <= 24; len++) {
      const plaintext = 'x'.repeat(len);
      const enc = await encryptToken(KEY, plaintext);
      expect(await decryptToken(KEY, enc)).toBe(plaintext);
    }
  });

  it('round-trips a JSON credentials blob', async () => {
    const json = JSON.stringify({ clientId: 'cid', tokenKey: 'tk', tokenSecret: 'ts' });
    expect(await decryptToken(KEY, await encryptToken(KEY, json))).toBe(json);
  });
});
