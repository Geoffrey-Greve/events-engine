/**
 * A refused reserve used to be recorded nowhere.
 *
 * Every `ReserveError` — "we couldn't verify your membership", "the course price
 * changed before checkout", "this attendee email is already registered for this event" —
 * was turned straight into JSON for the buyer and dropped. The three most-reported
 * checkout defects on the QA sheet were all of that shape, and each one had to be
 * re-derived from a customer's description of a sentence they saw, because the Worker
 * held no line to search for. `price_drift` was the sole exception: it logs before it
 * decides, and it is the only one of them that was ever traceable from the Worker's own
 * output.
 *
 * These tests pin the log: that a refusal produces one, that it carries the status and
 * the buyer, that the response the buyer gets is unchanged by it, and that the four
 * reserve routes all go through it.
 */
import type { Context } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReserveError, refuseReserve } from '../src/routes/reserve';
// The workers pool has no filesystem, so the module's own text comes in as an asset.
import SOURCE from '../src/routes/reserve?raw';
import type { Env } from '../src/types';

interface JsonCall {
  body: unknown;
  status: number;
}

/** The two things `refuseReserve` uses a Hono context for. */
function stubContext(): { c: Context<{ Bindings: Env }>; calls: JsonCall[] } {
  const calls: JsonCall[] = [];
  const c = {
    json: (body: unknown, status: number) => {
      calls.push({ body, status });
      return new Response(JSON.stringify(body), { status });
    },
  } as unknown as Context<{ Bindings: Env }>;
  return { c, calls };
}

function captureLogs() {
  const lines: Array<Record<string, unknown>> = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    for (const arg of args) {
      if (typeof arg !== 'string') continue;
      try {
        lines.push(JSON.parse(arg) as Record<string, unknown>);
      } catch {
        /* not one of ours */
      }
    }
  });
  return { lines, spy };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('refuseReserve', () => {
  it('logs the refusal', () => {
    const { lines } = captureLogs();
    const { c } = stubContext();

    refuseReserve(c, new ReserveError('membership_unverified', 'We could not verify it.', 403), {
      portalId: 'portal-1',
      eventId: 'evt-1',
      buyerEmail: 'pat@example.com',
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'warn',
      event: 'reserve_refused',
      status: 'membership_unverified',
      httpStatus: 403,
      portalId: 'portal-1',
      eventId: 'evt-1',
      buyerEmail: 'pat@example.com',
      source: 'public',
      message: 'We could not verify it.',
    });
  });

  it('answers the buyer exactly as it did before, status and body', () => {
    captureLogs();
    const { c, calls } = stubContext();

    refuseReserve(c, new ReserveError('price_mismatch', 'The course price changed.', 409), {
      portalId: 'portal-1',
    });

    expect(calls).toEqual([
      { body: { status: 'price_mismatch', message: 'The course price changed.' }, status: 409 },
    ]);
  });

  it('logs a refusal it cannot name a buyer for rather than staying silent', () => {
    const { lines } = captureLogs();
    const { c } = stubContext();

    // `invalid_body` is thrown before the buyer is known. A refusal with an unknown
    // buyer is still the most useful thing in the log when someone reports a checkout
    // that would not submit.
    refuseReserve(c, new ReserveError('invalid_body', 'Request body must be valid JSON', 400), {
      portalId: 'portal-1',
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ status: 'invalid_body', buyerEmail: null, eventId: null });
  });

  it('distinguishes the two duplicate faults in the log, not just in the message', () => {
    const { lines } = captureLogs();
    const { c } = stubContext();

    refuseReserve(c, new ReserveError('duplicate_attendee_in_booking', 'Listed twice.', 409), {
      portalId: 'portal-1',
    });
    refuseReserve(c, new ReserveError('duplicate_attendee', 'Already registered.', 409), {
      portalId: 'portal-1',
    });

    expect(lines.map((line) => line.status)).toEqual([
      'duplicate_attendee_in_booking',
      'duplicate_attendee',
    ]);
  });
});

describe('every reserve route refuses through it', () => {
  it('leaves no ReserveError catch answering the buyer directly', () => {
    // A route that builds its own `c.json({ status, message })` from a ReserveError is
    // a refusal nobody can search for, which is the whole fault. There were four.
    const handWritten = SOURCE.match(/if \(err instanceof ReserveError\) \{\s*return c\.json\(/g);
    expect(handWritten).toBeNull();
  });

  it('routes all four reserve entry points through refuseReserve', () => {
    expect(SOURCE.match(/return refuseReserve\(/g)).toHaveLength(4);
  });
});
