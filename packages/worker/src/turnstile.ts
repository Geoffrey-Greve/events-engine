import type { Env } from './types';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAX_TOKEN_LENGTH = 2048;

export interface TurnstileVerification {
  success: boolean;
  reason?: string;
  hostname?: string;
  action?: string;
  errorCodes?: string[];
}

interface SiteverifyResponse {
  success?: boolean;
  hostname?: string;
  action?: string;
  'error-codes'?: string[];
}

export function getTurnstileSecret(env: Env, portalId: string): string | null {
  const bindings = env as unknown as Record<string, string | undefined>;
  return (
    bindings[`TURNSTILE_SECRET_KEY_${portalId}`]?.trim() ||
    bindings.TURNSTILE_SECRET_KEY?.trim() ||
    null
  );
}

export function getTurnstileAllowedHostnames(env: Env, portalId: string): string[] {
  const bindings = env as unknown as Record<string, string | undefined>;
  const raw =
    bindings[`TURNSTILE_ALLOWED_HOSTNAMES_${portalId}`] ||
    bindings.TURNSTILE_ALLOWED_HOSTNAMES ||
    '';
  return raw
    .split(',')
    .map((hostname) => hostname.trim().toLowerCase())
    .filter(Boolean);
}

export function isPublicImportTicket(ticketTypeId: string, ticketName: string): boolean {
  return (
    /^tt_cams_import_/i.test(ticketTypeId) || /imported\s+cams\s+registration/i.test(ticketName)
  );
}

/**
 * Whether this reservation must pass a Turnstile challenge.
 *
 * Every PUBLIC reservation is challenged, paid or free — the booking total says nothing
 * about whether the caller is a person. The gate used to fire only on a zero total, on the
 * reasoning that a free booking commits a seat outright while a paid one still had to clear
 * payment. Phase 4.1 removed that second half: a paid public booking now holds its seat to
 * the invoice due date (30 days by default, up to 90), and the EventCapacity DO accepts that
 * expiry without an upper bound. So an unauthenticated caller could take a seat for a month
 * with a throwaway email and no payment, and repeat until the event was sold out — the
 * "never oversell" invariant running backwards into never-sell.
 *
 * `staff_manual` and `corporate_bulk` are unaffected: both are already authenticated, and
 * neither renders a widget that could produce a token.
 *
 * A portal with no Turnstile secret configured is still not challenged. That is deliberate —
 * it is what keeps the gate opt-in per tenant — but it does mean the protection above is
 * only real once `TURNSTILE_SECRET_KEY_{portalId}` is set for that portal.
 */
export function shouldRequireTurnstile(input: {
  source?: string;
  secretConfigured: boolean;
}): boolean {
  const source = input.source ?? 'public_checkout';
  return input.secretConfigured && source === 'public_checkout';
}

export async function verifyTurnstileToken(input: {
  secret: string;
  token: unknown;
  remoteIp?: string | null;
  idempotencyKey?: string | null;
  allowedHostnames?: string[];
}): Promise<TurnstileVerification> {
  if (!input.token || typeof input.token !== 'string') {
    return { success: false, reason: 'missing_token' };
  }

  const token = input.token.trim();
  if (!token || token.length > MAX_TOKEN_LENGTH) {
    return { success: false, reason: 'invalid_token' };
  }

  const payload: Record<string, string> = {
    secret: input.secret,
    response: token,
  };
  if (input.remoteIp) payload.remoteip = input.remoteIp;
  if (input.idempotencyKey) payload.idempotency_key = input.idempotencyKey;

  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = (await response.json().catch(() => ({}))) as SiteverifyResponse;

    if (!response.ok) {
      const result: TurnstileVerification = {
        success: false,
        reason: 'siteverify_http_error',
      };
      if (data['error-codes']) result.errorCodes = data['error-codes'];
      return result;
    }

    if (data.success === true) {
      const result: TurnstileVerification = { success: true };
      if (data.hostname) result.hostname = data.hostname;
      if (data.action) result.action = data.action;
      if (input.allowedHostnames?.length) {
        const hostname = data.hostname?.trim().toLowerCase();
        if (!hostname || !input.allowedHostnames.includes(hostname)) {
          return {
            success: false,
            reason: 'hostname_mismatch',
            hostname: data.hostname,
            action: data.action,
          };
        }
      }
      return result;
    }

    const result: TurnstileVerification = {
      success: false,
      reason: 'siteverify_failed',
    };
    if (data['error-codes']) result.errorCodes = data['error-codes'];
    if (data.hostname) result.hostname = data.hostname;
    if (data.action) result.action = data.action;
    return result;
  } catch {
    return { success: false, reason: 'siteverify_unreachable' };
  }
}
