/**
 * Export download tokens (Phase 2.2).
 *
 * The CSV export is admin-authed, and the admin API key is a server secret. That is correct
 * for a script or an integration, and useless for the person the export is for: a browser
 * downloading a file follows a plain navigation, and a navigation carries no headers. The
 * HubSpot App Card can't bridge the gap either — UI extensions render a fixed component set
 * inside a sandboxed iframe with no download primitive, so the only thing it can do is open
 * a URL.
 *
 * So a staff member gets a short-lived, single-purpose, event-scoped token minted by an
 * authenticated caller, and the download URL carries it as a query parameter. Same shape as
 * the check-in device token, and it reuses that module's signing primitive rather than
 * growing a second token format.
 *
 * **A token in a URL is weaker than a token in a header** — it lands in browser history, and
 * in an intermediary's logs if one ever terminates TLS. The design answers that by making a
 * leaked token worth as little as possible:
 *
 *   - it expires in minutes, not hours (`DEFAULT_EXPORT_TTL_SECONDS`);
 *   - it names one scope, so it can't be replayed against a different export;
 *   - it names one event, so it can't be walked across an account;
 *   - it names one portal and is signed with that tenant's key, so it can't cross tenants;
 *   - it authorises a READ. There is no write path behind a token.
 *
 * It is deliberately stateless, and therefore replayable within its lifetime. Single-use
 * would mean a round trip to D1 or KV to burn it, and a download that fails halfway would
 * be unrepeatable — worse, for a few minutes of exposure on a read-only, event-scoped URL.
 * The device token made the same trade for the same reason.
 */

import {
  decodeUnverifiedClaims,
  deviceTokenSecret,
  mintSignedToken,
  verifySignedToken,
} from './checkin';
import { getSecret } from './config';
import type { Env } from './types';

/**
 * What a token authorises. One value today; the field exists so that adding the roll-up
 * export later cannot be done by replaying an attendee-list token against it.
 */
export type ExportScope = 'registrations.csv';

export interface ExportClaims {
  v: 1;
  portalId: string;
  scope: ExportScope;
  /** The single event this token can download. */
  eid: string;
  /** issued-at (epoch seconds) */
  iat: number;
  /** expiry (epoch seconds) */
  exp: number;
}

/**
 * Minutes, not hours. The token is minted when a person clicks "prepare export" and spent
 * seconds later; anything longer is exposure bought for no one's benefit.
 */
export const DEFAULT_EXPORT_TTL_SECONDS = 5 * 60;
export const MAX_EXPORT_TTL_SECONDS = 60 * 60;
export const MIN_EXPORT_TTL_SECONDS = 30;

/**
 * Per-tenant signing key, following the {PREFIX}_{portalId} convention and falling back
 * down the same chain as the device token. A portal that has provisioned no dedicated
 * export key still gets a key that is specific to it — never a shared one.
 */
function exportTokenSecret(env: Env, portalId: string): string {
  try {
    return getSecret(env, `EXPORT_TOKEN_SECRET_${portalId}`);
  } catch {
    return deviceTokenSecret(env, portalId);
  }
}

export interface IssuedExportToken {
  token: string;
  expiresAt: string;
}

/** Mint a short-lived download token for one event's export. */
export async function issueExportToken(
  env: Env,
  portalId: string,
  eventId: string,
  scope: ExportScope,
  ttlSeconds?: number,
): Promise<IssuedExportToken> {
  const ttl = Math.min(
    MAX_EXPORT_TTL_SECONDS,
    Math.max(MIN_EXPORT_TTL_SECONDS, Math.floor(ttlSeconds ?? DEFAULT_EXPORT_TTL_SECONDS)),
  );
  const now = Math.floor(Date.now() / 1000);
  const claims: ExportClaims = { v: 1, portalId, scope, eid: eventId, iat: now, exp: now + ttl };
  return {
    token: await mintSignedToken(exportTokenSecret(env, portalId), claims),
    expiresAt: new Date(claims.exp * 1000).toISOString(),
  };
}

/**
 * Authenticate an export token against the scope and event it must be for.
 *
 * Reads the claimed portalId first to select the tenant key (the JWT `kid` pattern), then
 * verifies. Nothing but key selection may depend on the claims before that check — a forged
 * portalId selects a key whose signature will not match, so it cannot pass.
 *
 * The scope and event are checked HERE rather than by the caller: a route that verified the
 * signature and forgot to compare the event id would hand any event's attendee list to any
 * valid token, and that is exactly the mistake worth making structurally impossible.
 */
export async function authenticateExportToken(
  env: Env,
  token: string,
  expected: { scope: ExportScope; eventId: string },
): Promise<ExportClaims | null> {
  const claims = decodeUnverifiedClaims<ExportClaims>(token);
  if (!claims || typeof claims.portalId !== 'string' || typeof claims.eid !== 'string') {
    return null;
  }

  if (!(await verifySignedToken(token, exportTokenSecret(env, claims.portalId)))) return null;

  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= Date.now()) return null;
  if (claims.scope !== expected.scope) return null;
  if (claims.eid !== expected.eventId) return null;

  return claims;
}
