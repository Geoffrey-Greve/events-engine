/**
 * Check-in cryptography, device tokens, and request auth.
 *
 * Ticket QR codes are signed, self-describing tokens:
 *
 *     base64url(JSON{tid,rid,eid}) "." base64url(HMAC-SHA256)
 *
 * The HMAC key is NOT the tenant master secret — it is a per-event key DERIVED
 * from the master (deriveEventVerifyKey). That lets the check-in app download a
 * per-event verify key (the manifest) and verify scans offline on-device without
 * ever holding the tenant master secret. Compromising one event's device key
 * exposes neither the master nor any other event.
 *
 * Device tokens are short-lived, event-scoped, stateless HMAC tokens minted by an
 * admin and presented by scanner devices on every check-in call (deviceAuth).
 *
 * Secrets follow the {PREFIX}_{portalId} Wrangler convention:
 *   TICKET_SIGNING_SECRET_{portalId}  — tenant master ticket key
 *   DEVICE_TOKEN_SECRET_{portalId}    — device-token signing key
 *   ADMIN_API_KEY_{portalId}          — admin API key (device-token issuance)
 * Each falls back sensibly when a dedicated secret is not yet provisioned.
 */

import type { Context, MiddlewareHandler } from 'hono';
import { getSecret } from './config';
import type { Env } from './types';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** The decoded contents of a ticket QR code. */
export interface TicketCodePayload {
  /** ticket id (tickets.id) */
  tid: string;
  /** registration id (registrations.id) */
  rid: string;
  /** event id (events.id) */
  eid: string;
}

/** The decoded contents of a device token. */
export interface DeviceClaims {
  v: 1;
  portalId: string;
  /** event id this device is scoped to */
  eid: string;
  /** device id */
  did: string;
  /** issued-at (epoch seconds) */
  iat: number;
  /** expiry (epoch seconds) */
  exp: number;
}

/** Hono generics for the check-in sub-app: deviceAuth populates `device`. */
export type CheckinBindings = {
  Bindings: Env;
  Variables: { device: DeviceClaims };
};

// ---------------------------------------------------------------------------
// base64url helpers
// ---------------------------------------------------------------------------

function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function strToB64url(s: string): string {
  return bytesToB64url(new TextEncoder().encode(s));
}

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
// HMAC primitives
// ---------------------------------------------------------------------------

function importHmacKey(
  secret: string | Uint8Array,
  usages: ('sign' | 'verify')[],
): Promise<CryptoKey> {
  const data = typeof secret === 'string' ? new TextEncoder().encode(secret) : secret;
  return crypto.subtle.importKey('raw', data, { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

async function hmacSign(key: CryptoKey, message: string): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return new Uint8Array(sig);
}

function hmacVerify(key: CryptoKey, message: string, sig: Uint8Array): Promise<boolean> {
  // crypto.subtle.verify is constant-time over the signature comparison.
  return crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(message));
}

// ---------------------------------------------------------------------------
// Per-event verify key (derived from the tenant master — never the master itself)
// ---------------------------------------------------------------------------

const KEY_DERIVATION_LABEL = 'event-engine/ticket-verify/v1:';

/**
 * Derive the per-event ticket-verify key from a tenant master secret.
 * Extractable so the manifest endpoint can hand the raw bytes to a scanner
 * device for offline verification.
 */
export async function deriveEventVerifyKey(
  masterSecret: string,
  eventId: string,
): Promise<CryptoKey> {
  const masterKey = await importHmacKey(masterSecret, ['sign']);
  const raw = await hmacSign(masterKey, `${KEY_DERIVATION_LABEL}${eventId}`);
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, true, [
    'sign',
    'verify',
  ]);
}

/** Export a derived verify key as base64url raw bytes (for the offline manifest). */
export async function exportKeyB64url(key: CryptoKey): Promise<string> {
  const raw = new Uint8Array((await crypto.subtle.exportKey('raw', key)) as ArrayBuffer);
  return bytesToB64url(raw);
}

// ---------------------------------------------------------------------------
// Ticket code: mint + verify
// ---------------------------------------------------------------------------

/**
 * Mint a signed ticket QR code:  base64url(JSON{tid,rid,eid}) "." base64url(HMAC).
 * Used by issueTickets (payment + free-event paths).
 */
export async function mintTicketCode(
  payload: TicketCodePayload,
  eventKey: CryptoKey,
): Promise<string> {
  const header = strToB64url(
    JSON.stringify({ tid: payload.tid, rid: payload.rid, eid: payload.eid }),
  );
  const sig = await hmacSign(eventKey, header);
  return `${header}.${bytesToB64url(sig)}`;
}

/**
 * Verify a ticket QR code against an event key. Returns the decoded payload, or
 * null if the format is malformed or the signature does not match.
 */
export async function verifyTicketCode(
  code: string,
  eventKey: CryptoKey,
): Promise<TicketCodePayload | null> {
  const dot = code.indexOf('.');
  if (dot <= 0 || dot === code.length - 1) return null;
  const header = code.slice(0, dot);
  const sigPart = code.slice(dot + 1);

  let sig: Uint8Array;
  try {
    sig = b64urlToBytes(sigPart);
  } catch {
    return null;
  }

  const ok = await hmacVerify(eventKey, header, sig);
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

// ---------------------------------------------------------------------------
// Signed tokens: mint + verify
//
// The `base64url(JSON claims) "." base64url(HMAC)` primitive below is shared, not
// device-specific — `exports.ts` mints CSV download tokens with it. The crypto lives here
// because this is where the HMAC helpers are; a second copy of base64url and HMAC
// somewhere else is how two token formats quietly stop agreeing.
// ---------------------------------------------------------------------------

/** Mint a signed token carrying `claims`, with an explicit secret. */
export async function mintSignedToken(secret: string, claims: object): Promise<string> {
  const header = strToB64url(JSON.stringify(claims));
  const key = await importHmacKey(secret, ['sign']);
  const sig = await hmacSign(key, header);
  return `${header}.${bytesToB64url(sig)}`;
}

/** Verify a signed token against an explicit secret. Signature only — no expiry check. */
export async function verifySignedToken(token: string, secret: string): Promise<boolean> {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return false;
  const header = token.slice(0, dot);
  let sig: Uint8Array;
  try {
    sig = b64urlToBytes(token.slice(dot + 1));
  } catch {
    return false;
  }
  const key = await importHmacKey(secret, ['verify']);
  return hmacVerify(key, header, sig);
}

/**
 * Read a token's claims WITHOUT verifying it.
 *
 * Only ever for selecting which tenant key to verify against — the JWT `kid` pattern. The
 * claims are attacker-controlled until `verifySignedToken` returns true, so nothing but key
 * selection may depend on them.
 */
export function decodeUnverifiedClaims<T>(token: string): T | null {
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  try {
    return JSON.parse(b64urlToStr(token.slice(0, dot))) as T;
  } catch {
    return null;
  }
}

/** Mint a device token with an explicit secret. */
export function mintDeviceTokenWithSecret(secret: string, claims: DeviceClaims): Promise<string> {
  return mintSignedToken(secret, claims);
}

/** Verify a device token's signature with an explicit secret (no expiry check). */
export function verifyDeviceTokenWithSecret(token: string, secret: string): Promise<boolean> {
  return verifySignedToken(token, secret);
}

// ---------------------------------------------------------------------------
// Per-tenant secret resolution
// ---------------------------------------------------------------------------

function masterTicketSecret(env: Env, portalId: string): string {
  try {
    return getSecret(env, `TICKET_SIGNING_SECRET_${portalId}`);
  } catch {
    // Fall back to the webhook secret until a dedicated ticket key is provisioned.
    return env.HUBSPOT_WEBHOOK_SECRET;
  }
}

export function deviceTokenSecret(env: Env, portalId: string): string {
  try {
    return getSecret(env, `DEVICE_TOKEN_SECRET_${portalId}`);
  } catch {
    return masterTicketSecret(env, portalId);
  }
}

// ---------------------------------------------------------------------------
// Env-aware convenience wrappers
// ---------------------------------------------------------------------------

/** Resolve the derived per-event verify key for a tenant. */
export function getEventVerifyKey(env: Env, portalId: string, eventId: string): Promise<CryptoKey> {
  return deriveEventVerifyKey(masterTicketSecret(env, portalId), eventId);
}

/** Mint a ticket code for a tenant/event in one call (used by issueTickets). */
export async function mintTicketForTenant(
  env: Env,
  portalId: string,
  tid: string,
  rid: string,
  eid: string,
): Promise<string> {
  const eventKey = await getEventVerifyKey(env, portalId, eid);
  return mintTicketCode({ tid, rid, eid }, eventKey);
}

const DEFAULT_DEVICE_TTL_SECONDS = 12 * 60 * 60; // 12h
const MAX_DEVICE_TTL_SECONDS = 24 * 60 * 60; // 24h
const MIN_DEVICE_TTL_SECONDS = 60; // 1 min

/** Issue a short-lived, event-scoped device token. */
export async function issueDeviceToken(
  env: Env,
  portalId: string,
  eventId: string,
  deviceId: string,
  ttlSeconds?: number,
): Promise<{ token: string; deviceId: string; expiresAt: string }> {
  const ttl = Math.min(
    MAX_DEVICE_TTL_SECONDS,
    Math.max(MIN_DEVICE_TTL_SECONDS, Math.floor(ttlSeconds ?? DEFAULT_DEVICE_TTL_SECONDS)),
  );
  const now = Math.floor(Date.now() / 1000);
  const claims: DeviceClaims = {
    v: 1,
    portalId,
    eid: eventId,
    did: deviceId,
    iat: now,
    exp: now + ttl,
  };
  const token = await mintDeviceTokenWithSecret(deviceTokenSecret(env, portalId), claims);
  return { token, deviceId, expiresAt: new Date(claims.exp * 1000).toISOString() };
}

/**
 * Authenticate a device token: read the claimed portalId to select the tenant
 * key (like a JWT `kid`), then verify the signature and expiry. The claim is
 * untrusted until the HMAC checks out, so a forged portalId cannot pass.
 */
export async function authenticateDevice(env: Env, token: string): Promise<DeviceClaims | null> {
  const claims = decodeUnverifiedClaims<DeviceClaims>(token);
  if (!claims || typeof claims.portalId !== 'string' || typeof claims.eid !== 'string') {
    return null;
  }

  const ok = await verifyDeviceTokenWithSecret(token, deviceTokenSecret(env, claims.portalId));
  if (!ok) return null;

  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) return null;

  return claims;
}

// ---------------------------------------------------------------------------
// Request auth: deviceAuth middleware + admin auth
// ---------------------------------------------------------------------------

function bearerToken(c: Context): string | undefined {
  const auth = c.req.header('Authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim();
  return undefined;
}

/** Constant-time string comparison (false on length mismatch). */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Hono middleware: verify an event-scoped device token on every check-in call.
 * Token comes from `Authorization: Bearer <token>` or `X-Device-Token`.
 */
export const deviceAuth: MiddlewareHandler<CheckinBindings> = async (c, next) => {
  const token = bearerToken(c) ?? c.req.header('X-Device-Token');
  if (!token) {
    return c.json({ status: 'unauthorized', message: 'Device token required' }, 401);
  }
  const claims = await authenticateDevice(c.env, token);
  if (!claims) {
    return c.json({ status: 'unauthorized', message: 'Invalid or expired device token' }, 401);
  }
  c.set('device', claims);
  await next();
  return undefined;
};

/**
 * Authenticate an admin request for the device-token issuance endpoint.
 * Requires `X-Portal-Id` plus an admin key (Bearer or `X-Admin-Key`) that
 * matches ADMIN_API_KEY_{portalId}. Returns the portalId, or null on failure.
 * This is deliberately NOT device auth — devices cannot mint their own tokens.
 */
export function authenticateAdmin(c: Context<{ Bindings: Env }>): string | null {
  const portalId = c.req.header('X-Portal-Id');
  if (!portalId) return null;

  const presented = bearerToken(c) ?? c.req.header('X-Admin-Key');
  if (!presented) return null;

  let expected: string;
  try {
    expected = getSecret(c.env, `ADMIN_API_KEY_${portalId}`);
  } catch {
    return null;
  }
  return constantTimeEqual(presented, expected) ? portalId : null;
}
