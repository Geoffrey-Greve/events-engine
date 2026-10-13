/**
 * Bounds on the corporate routes, while they still have no authentication.
 *
 * `/api/v1/corporate/*` trusts a caller-supplied `actorContactId`: it verifies that the
 * NAMED actor is a company admin, never that the caller is that actor. The real fix is
 * the per-contact action token. These guards are what stands in front of it meanwhile,
 * and they are the kind of control that quietly stops working, so they get tests.
 *
 * Neither is authentication. The origin allowlist stops a page on another site running
 * script in a logged-in member's browser; it does nothing to a caller that omits the
 * header. The rate limit bounds one IP. Both are deliberately sized so a real corporate
 * admin never meets them.
 */
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { corporateTeamRoutes } from '../src/routes/corporate-team';
import type { Env } from '../src/types';

const PORTAL = '441838610';
const ALLOWED = 'https://weldaustralia.com.au';

function withEnv(overrides: Record<string, string | undefined>): Env {
  return { ...(env as unknown as Record<string, unknown>), ...overrides } as unknown as Env;
}

/** A body that is well-formed enough to get past validation and reach HubSpot. */
const BODY = { companyId: '123', actorContactId: '456', employeeId: '789' };

function request(path: string, init: { origin?: string; portalId?: string } = {}) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Portal-Id': init.portalId ?? PORTAL,
    'CF-Connecting-IP': `10.0.0.${Math.floor(Math.random() * 250) + 1}`,
  };
  if (init.origin) headers.Origin = init.origin;
  return new Request(`https://worker.test${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(BODY),
  });
}

/** Same IP across calls, so the rate limiter actually accumulates. */
function requestFromIp(path: string, ip: string) {
  return new Request(`https://worker.test${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Portal-Id': PORTAL,
      'CF-Connecting-IP': ip,
    },
    body: JSON.stringify(BODY),
  });
}

describe('corporate origin allowlist', () => {
  it('is unrestricted when no portal has configured it', async () => {
    // Every deployment today is in this state, so shipping the guard must change nothing.
    const res = await corporateTeamRoutes.fetch(
      request('/remove-employee', { origin: 'https://evil.example' }),
      withEnv({ CORPORATE_ALLOWED_ORIGIN: undefined }),
    );
    expect(res.status).not.toBe(403);
  });

  it('rejects an origin the portal has not listed', async () => {
    const res = await corporateTeamRoutes.fetch(
      request('/remove-employee', { origin: 'https://evil.example' }),
      withEnv({ CORPORATE_ALLOWED_ORIGIN: ALLOWED }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ status: 'origin_not_allowed' });
  });

  it('allows a listed origin', async () => {
    const res = await corporateTeamRoutes.fetch(
      request('/remove-employee', { origin: ALLOWED }),
      withEnv({ CORPORATE_ALLOWED_ORIGIN: ALLOWED }),
    );
    expect(res.status).not.toBe(403);
  });

  it('reads a portal-specific list ahead of the shared one', async () => {
    const res = await corporateTeamRoutes.fetch(
      request('/remove-employee', { origin: 'https://portal-specific.example' }),
      withEnv({
        CORPORATE_ALLOWED_ORIGIN: ALLOWED,
        [`CORPORATE_ALLOWED_ORIGIN_${PORTAL}`]: 'https://portal-specific.example',
      }),
    );
    expect(res.status).not.toBe(403);
  });

  it('accepts any entry in a comma-separated list, trimming spaces', async () => {
    const list = `${ALLOWED}, https://www.weldaustralia.com.au ,https://441838610.hs-sites-ap1.com`;
    for (const origin of [
      'https://www.weldaustralia.com.au',
      'https://441838610.hs-sites-ap1.com',
    ]) {
      const res = await corporateTeamRoutes.fetch(
        request('/remove-employee', { origin }),
        withEnv({ CORPORATE_ALLOWED_ORIGIN: list }),
      );
      expect(res.status, origin).not.toBe(403);
    }
  });

  it('lets a request with no Origin through, since blocking it stops nothing', async () => {
    // A non-browser caller simply omits the header. Refusing it would break
    // server-to-server use without touching the attack this guards against.
    const res = await corporateTeamRoutes.fetch(
      request('/remove-employee'),
      withEnv({ CORPORATE_ALLOWED_ORIGIN: ALLOWED }),
    );
    expect(res.status).not.toBe(403);
  });
});

// The limiter is KV-backed and windowed on wall clock, so each case uses its own IP
// rather than trying to reset shared state between them.
describe('corporate rate limits', () => {
  it('bounds bulk-register tighter than the employee writes', async () => {
    // bulk-register is the one corporate route that raises an invoice, so it gets 10/min
    // against 30/min. Proven by exhausting the lower budget and showing the higher one
    // is still open from the same IP.
    const ip = '10.9.9.1';
    const E = withEnv({});

    let sawLimit = false;
    for (let i = 0; i < 12; i++) {
      const res = await corporateTeamRoutes.fetch(requestFromIp('/bulk-register', ip), E);
      if (res.status === 429) {
        sawLimit = true;
        expect(await res.json()).toMatchObject({ status: 'rate_limited' });
        break;
      }
    }
    expect(sawLimit).toBe(true);

    const employeeWrite = await corporateTeamRoutes.fetch(requestFromIp('/remove-employee', ip), E);
    expect(employeeWrite.status).not.toBe(429);
  });

  it('leaves a normal admin session well inside the budget', async () => {
    // Onboarding ten staff one at a time must never be mistaken for abuse.
    const ip = '10.9.9.2';
    const E = withEnv({});
    for (let i = 0; i < 10; i++) {
      const res = await corporateTeamRoutes.fetch(requestFromIp('/add-employee', ip), E);
      expect(res.status, `call ${i + 1}`).not.toBe(429);
    }
  });
});
