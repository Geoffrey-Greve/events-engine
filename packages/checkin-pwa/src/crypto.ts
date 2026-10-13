/**
 * Offline QR-code verification — mirrors the server-side logic in worker/src/checkin.ts.
 *
 * The manifest supplies a raw per-event HMAC-SHA256 key (base64url). We import it
 * as a non-extractable verify-only CryptoKey so it can verify ticket codes locally
 * without ever holding (or leaking) the tenant master secret.
 *
 * Ticket code format: base64url(JSON{tid,rid,eid}) "." base64url(HMAC-SHA256)
 */

import type { TicketCodePayload } from '@paddock/shared';

// ---------------------------------------------------------------------------
// base64url helpers
// ---------------------------------------------------------------------------

function b64urlToBytes(s: string): Uint8Array {
  const padded = s.length % 4 === 0 ? s : s + '='.repeat(4 - (s.length % 4));
  const bin = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToStr(s: string): string {
  return new TextDecoder().decode(b64urlToBytes(s));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Import a base64url-encoded raw HMAC-SHA256 key from the manifest.
 * The key is not extractable — it can only be used to verify codes.
 */
export function importVerifyKey(keyB64url: string): Promise<CryptoKey> {
  const raw = b64urlToBytes(keyB64url);
  const buf: ArrayBuffer =
    raw.buffer instanceof ArrayBuffer ? raw.buffer : new Uint8Array(raw).buffer;
  return crypto.subtle.importKey('raw', buf, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
}

/**
 * Verify a ticket QR code against the event verify key.
 * Returns the decoded payload, or null if the signature is invalid or the
 * format is malformed. Identical behaviour to the server-side verifyTicketCode.
 */
export async function verifyTicketCode(
  code: string,
  key: CryptoKey,
): Promise<TicketCodePayload | null> {
  const dot = code.indexOf('.');
  if (dot <= 0 || dot === code.length - 1) return null;

  const header = code.slice(0, dot);
  let sig: Uint8Array;
  try {
    sig = b64urlToBytes(code.slice(dot + 1));
  } catch {
    return null;
  }

  const msgBytes = new TextEncoder().encode(header);
  const toArrayBuffer = (u8: Uint8Array): ArrayBuffer =>
    u8.buffer instanceof ArrayBuffer ? u8.buffer : new Uint8Array(u8).buffer;
  const ok = await crypto.subtle.verify('HMAC', key, toArrayBuffer(sig), toArrayBuffer(msgBytes));
  if (!ok) return null;

  try {
    const obj = JSON.parse(b64urlToStr(header)) as Partial<TicketCodePayload>;
    if (typeof obj.tid === 'string' && typeof obj.rid === 'string' && typeof obj.eid === 'string') {
      return { tid: obj.tid, rid: obj.rid, eid: obj.eid };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Extract the event id from a device token payload without verifying the signature.
 * Safe because the server validates the token when we fetch the manifest; we only
 * use this to know which event to request.
 */
export function parseDeviceTokenEventId(token: string): string | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  try {
    const claims = JSON.parse(b64urlToStr(token.slice(0, dot))) as Record<string, unknown>;
    return typeof claims.eid === 'string' ? claims.eid : null;
  } catch {
    return null;
  }
}
