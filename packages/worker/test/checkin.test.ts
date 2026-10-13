import { describe, expect, it } from 'vitest';
import {
  type DeviceClaims,
  deriveEventVerifyKey,
  exportKeyB64url,
  mintDeviceTokenWithSecret,
  mintTicketCode,
  verifyDeviceTokenWithSecret,
  verifyTicketCode,
} from '../src/checkin';

// These exercise the pure crypto core of check-in directly (Web Crypto is real
// in the Workers runtime), with no D1/env dependency.

const MASTER = 'tenant-master-secret-abc';

describe('ticket code mint/verify', () => {
  it('round-trips a payload through the derived per-event key', async () => {
    const key = await deriveEventVerifyKey(MASTER, 'evt_1');
    const code = await mintTicketCode({ tid: 't1', rid: 'r1', eid: 'evt_1' }, key);

    expect(code).toContain('.');
    const decoded = await verifyTicketCode(code, key);
    expect(decoded).toEqual({ tid: 't1', rid: 'r1', eid: 'evt_1' });
  });

  it('rejects a tampered payload', async () => {
    const key = await deriveEventVerifyKey(MASTER, 'evt_1');
    const code = await mintTicketCode({ tid: 't1', rid: 'r1', eid: 'evt_1' }, key);

    const [, sig] = code.split('.');
    // Forge a different payload but keep the original signature.
    const forgedHeader = btoa(JSON.stringify({ tid: 't1', rid: 'r1', eid: 'evt_1', x: 1 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(await verifyTicketCode(`${forgedHeader}.${sig}`, key)).toBeNull();
  });

  it('rejects a malformed code', async () => {
    const key = await deriveEventVerifyKey(MASTER, 'evt_1');
    expect(await verifyTicketCode('not-a-code', key)).toBeNull();
    expect(await verifyTicketCode('only.', key)).toBeNull();
    expect(await verifyTicketCode('', key)).toBeNull();
  });

  it('does not verify under a different event key (per-event isolation)', async () => {
    const key1 = await deriveEventVerifyKey(MASTER, 'evt_1');
    const key2 = await deriveEventVerifyKey(MASTER, 'evt_2');
    const code = await mintTicketCode({ tid: 't1', rid: 'r1', eid: 'evt_1' }, key1);
    expect(await verifyTicketCode(code, key2)).toBeNull();
  });

  it('derived keys differ from the master and per-event', async () => {
    const k1 = await exportKeyB64url(await deriveEventVerifyKey(MASTER, 'evt_1'));
    const k2 = await exportKeyB64url(await deriveEventVerifyKey(MASTER, 'evt_2'));
    const kOtherMaster = await exportKeyB64url(await deriveEventVerifyKey('other', 'evt_1'));
    expect(k1).not.toEqual(k2);
    expect(k1).not.toEqual(kOtherMaster);
    expect(k1).not.toContain(MASTER);
  });

  it('manifest-style verify works from the exported raw key bytes (offline)', async () => {
    const eventKey = await deriveEventVerifyKey(MASTER, 'evt_1');
    const code = await mintTicketCode({ tid: 't1', rid: 'r1', eid: 'evt_1' }, eventKey);

    // Simulate the device importing the manifest's exported verify key.
    const raw = Uint8Array.from(
      atob((await exportKeyB64url(eventKey)).replace(/-/g, '+').replace(/_/g, '/')),
      (ch) => ch.charCodeAt(0),
    );
    const imported = await crypto.subtle.importKey(
      'raw',
      raw,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify', 'sign'],
    );
    expect(await verifyTicketCode(code, imported)).toEqual({ tid: 't1', rid: 'r1', eid: 'evt_1' });
  });
});

describe('device token', () => {
  const claims: DeviceClaims = {
    v: 1,
    portalId: '99999999',
    eid: 'evt_1',
    did: 'dev_1',
    iat: 1000,
    exp: 2000,
  };

  it('round-trips a signature with the same secret', async () => {
    const token = await mintDeviceTokenWithSecret('s', claims);
    expect(await verifyDeviceTokenWithSecret(token, 's')).toBe(true);
  });

  it('fails verification under a different secret', async () => {
    const token = await mintDeviceTokenWithSecret('s', claims);
    expect(await verifyDeviceTokenWithSecret(token, 'other')).toBe(false);
  });

  it('fails on a tampered token', async () => {
    const token = await mintDeviceTokenWithSecret('s', claims);
    expect(await verifyDeviceTokenWithSecret(`${token}x`, 's')).toBe(false);
  });
});
