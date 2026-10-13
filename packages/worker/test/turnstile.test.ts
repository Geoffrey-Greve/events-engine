import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getTurnstileAllowedHostnames,
  getTurnstileSecret,
  isPublicImportTicket,
  shouldRequireTurnstile,
  verifyTurnstileToken,
} from '../src/turnstile';
import type { Env } from '../src/types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Turnstile protection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('prefers a portal-specific Turnstile secret over the global fallback', () => {
    const env = {
      TURNSTILE_SECRET_KEY: 'global-secret',
      TURNSTILE_SECRET_KEY_441838610: 'portal-secret',
    } as unknown as Env;

    expect(getTurnstileSecret(env, '441838610')).toBe('portal-secret');
  });

  it('prefers portal-specific hostname allow-lists over the global fallback', () => {
    const env = {
      TURNSTILE_ALLOWED_HOSTNAMES: 'example.com',
      TURNSTILE_ALLOWED_HOSTNAMES_441838610: 'weldaustralia.com.au, www.weldaustralia.com.au',
    } as unknown as Env;

    expect(getTurnstileAllowedHostnames(env, '441838610')).toEqual([
      'weldaustralia.com.au',
      'www.weldaustralia.com.au',
    ]);
  });

  it('requires Turnstile for every configured public reservation, paid or free', () => {
    // A paid public booking is challenged too: since Phase 4.1 its hold runs to the invoice
    // due date, so an unchallenged caller could park a seat for 30-90 days without paying.
    expect(
      shouldRequireTurnstile({
        source: 'public_checkout',
        secretConfigured: true,
      }),
    ).toBe(true);

    expect(
      shouldRequireTurnstile({
        secretConfigured: true,
      }),
    ).toBe(true);
  });

  it('leaves authenticated reservation sources unchallenged', () => {
    for (const source of ['staff_manual', 'corporate_bulk']) {
      expect(
        shouldRequireTurnstile({
          source,
          secretConfigured: true,
        }),
      ).toBe(false);
    }
  });

  it('stays opt-in: a portal with no configured secret is never challenged', () => {
    expect(
      shouldRequireTurnstile({
        source: 'public_checkout',
        secretConfigured: false,
      }),
    ).toBe(false);
  });

  it('recognises CAMS import tickets as non-public ticket types', () => {
    expect(isPublicImportTicket('tt_cams_import_abc123', 'Imported CAMS registration')).toBe(true);
    expect(isPublicImportTicket('tt_general', 'Imported CAMS registration')).toBe(true);
    expect(isPublicImportTicket('tt_general', 'General Admission')).toBe(false);
  });

  it('rejects missing Turnstile tokens before calling Siteverify', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await verifyTurnstileToken({
      secret: 'secret',
      token: '',
      remoteIp: '203.0.113.10',
    });

    expect(result).toEqual({ success: false, reason: 'missing_token' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('validates tokens using Cloudflare Siteverify', async () => {
    const fetchSpy = vi.fn(async () =>
      jsonResponse({
        success: true,
        hostname: 'weldaustralia.com.au',
        action: 'event_engine_reserve',
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);

    const result = await verifyTurnstileToken({
      secret: 'secret',
      token: 'token',
      remoteIp: '203.0.113.10',
      idempotencyKey: 'idem-1',
    });

    expect(result).toEqual({
      success: true,
      hostname: 'weldaustralia.com.au',
      action: 'event_engine_reserve',
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: 'secret',
          response: 'token',
          remoteip: '203.0.113.10',
          idempotency_key: 'idem-1',
        }),
      }),
    );
  });

  it('rejects a successful token if the hostname is outside the configured allow-list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          success: true,
          hostname: 'attacker.example',
          action: 'event_engine_reserve',
        }),
      ),
    );

    const result = await verifyTurnstileToken({
      secret: 'secret',
      token: 'token',
      allowedHostnames: ['weldaustralia.com.au', 'www.weldaustralia.com.au'],
    });

    expect(result).toEqual({
      success: false,
      reason: 'hostname_mismatch',
      hostname: 'attacker.example',
      action: 'event_engine_reserve',
    });
  });

  it('returns a safe failure shape when Siteverify rejects the token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          success: false,
          'error-codes': ['timeout-or-duplicate'],
        }),
      ),
    );

    const result = await verifyTurnstileToken({
      secret: 'secret',
      token: 'token',
    });

    expect(result).toEqual({
      success: false,
      reason: 'siteverify_failed',
      errorCodes: ['timeout-or-duplicate'],
    });
  });
});
