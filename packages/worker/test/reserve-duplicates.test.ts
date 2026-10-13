import { describe, expect, it, vi } from 'vitest';
import { resolveHubDbCourseRowId } from '../src/hubdb-pricing';
import {
  assertNoDuplicateAttendeeEmails,
  comparePriceQuote,
  type ReserveError,
} from '../src/routes/reserve';
import type { Env } from '../src/types';

interface ExistingRegistration {
  portalId: string;
  eventId: string;
  email: string;
  orderStatus: string;
}

function makeEnv(existingRegistrations: ExistingRegistration[] = []) {
  const first = vi.fn(async (...params: unknown[]) => {
    const [portalId, eventId, ...rest] = params as string[];
    const activeStatuses = rest.slice(-3);
    const emails = rest.slice(0, -3);

    const existing = existingRegistrations.find(
      (registration) =>
        registration.portalId === portalId &&
        registration.eventId === eventId &&
        emails.includes(registration.email.trim().toLowerCase()) &&
        activeStatuses.includes(registration.orderStatus),
    );

    return existing ? { attendee_email: existing.email } : null;
  });

  const bind = vi.fn((...params: unknown[]) => ({
    first: () => first(...params),
  }));
  const prepare = vi.fn(() => ({ bind }));

  return {
    env: { DB: { prepare } } as unknown as Env,
    prepare,
    bind,
    first,
  };
}

function attendee(email: string, ticketTypeId = 'tt-general') {
  return {
    email,
    name: 'Pat Attendee',
    ticketTypeId,
  };
}

describe('reserve duplicate attendee guard', () => {
  it('rejects the same attendee email twice in one booking, under its own status', async () => {
    const fake = makeEnv();

    // Distinct from `duplicate_attendee`: nobody holds a seat yet, THIS booking lists
    // one person twice. Told as "already registered for this event" it is a sentence
    // about a brand-new address that is true of nothing, which is exactly what the
    // events widget's buyers were shown when it expanded a quantity into N copies of
    // the buyer. The two faults need two sentences.
    await expect(
      assertNoDuplicateAttendeeEmails(fake.env, 'portal-1', 'event-1', [
        attendee(' Pat@example.com '),
        attendee('pat@EXAMPLE.com'),
      ]),
    ).rejects.toMatchObject({
      name: 'ReserveError',
      status: 'duplicate_attendee_in_booking',
      httpStatus: 409,
    } satisfies Partial<ReserveError>);

    expect(fake.prepare).not.toHaveBeenCalled();
  });

  it('names the repeated address, so the buyer knows which field to fix', async () => {
    const fake = makeEnv();

    await expect(
      assertNoDuplicateAttendeeEmails(fake.env, 'portal-1', 'event-1', [
        attendee('Pat@example.com'),
        attendee('pat@example.com'),
      ]),
    ).rejects.toThrow(/pat@example\.com/);
  });

  it('keeps `duplicate_attendee` for an email that already holds a seat', async () => {
    const fake = makeEnv([
      {
        portalId: 'portal-1',
        eventId: 'event-1',
        email: 'registered@example.com',
        orderStatus: 'confirmed',
      },
    ]);

    await expect(
      assertNoDuplicateAttendeeEmails(fake.env, 'portal-1', 'event-1', [
        attendee(' REGISTERED@example.com '),
      ]),
    ).rejects.toMatchObject({
      name: 'ReserveError',
      status: 'duplicate_attendee',
      httpStatus: 409,
    } satisfies Partial<ReserveError>);
  });

  it('allows one buyer to book different attendee emails', async () => {
    const fake = makeEnv();

    await expect(
      assertNoDuplicateAttendeeEmails(fake.env, 'portal-1', 'event-1', [
        attendee('one@example.com'),
        attendee('two@example.com'),
      ]),
    ).resolves.toBeUndefined();
  });

  it('allows duplicate attendee emails in one booking when duplicate attendees are explicitly allowed', async () => {
    const fake = makeEnv();

    await expect(
      assertNoDuplicateAttendeeEmails(
        fake.env,
        'portal-1',
        'event-1',
        [attendee(' Pat@example.com '), attendee('pat@EXAMPLE.com')],
        { allowDuplicateAttendees: true },
      ),
    ).resolves.toBeUndefined();

    expect(fake.prepare).not.toHaveBeenCalled();
  });

  it('allows an active existing registration when duplicate attendees are explicitly allowed', async () => {
    const fake = makeEnv([
      {
        portalId: 'portal-1',
        eventId: 'event-1',
        email: 'registered@example.com',
        orderStatus: 'confirmed',
      },
    ]);

    await expect(
      assertNoDuplicateAttendeeEmails(
        fake.env,
        'portal-1',
        'event-1',
        [attendee('registered@example.com')],
        { allowDuplicateAttendees: true },
      ),
    ).resolves.toBeUndefined();

    expect(fake.prepare).not.toHaveBeenCalled();
  });

  it('does not block a fresh booking after a cancelled or refunded order', async () => {
    const fake = makeEnv([
      {
        portalId: 'portal-1',
        eventId: 'event-1',
        email: 'cancelled@example.com',
        orderStatus: 'cancelled',
      },
      {
        portalId: 'portal-1',
        eventId: 'event-1',
        email: 'refunded@example.com',
        orderStatus: 'refunded',
      },
    ]);

    await expect(
      assertNoDuplicateAttendeeEmails(fake.env, 'portal-1', 'event-1', [
        attendee('cancelled@example.com'),
        attendee('refunded@example.com'),
      ]),
    ).resolves.toBeUndefined();
  });
});

describe('course pricing HubDB row id resolution', () => {
  it('uses the raw HubDB row id from course-session Event Engine ids', () => {
    expect(resolveHubDbCourseRowId('346457798115')).toBe('346457798115');
    expect(resolveHubDbCourseRowId('course-session-346457798115')).toBe('346457798115');
    expect(resolveHubDbCourseRowId(' course-session-346457798115 ')).toBe('346457798115');
  });

  it('rejects non-course row ids for pricing verification', () => {
    expect(resolveHubDbCourseRowId('')).toBeNull();
    expect(resolveHubDbCourseRowId('event-357079452141')).toBeNull();
  });
});

describe('comparePriceQuote', () => {
  it('passes an exact match', () => {
    expect(comparePriceQuote(217000, [217000])).toBe('match');
    expect(comparePriceQuote(217000, [255500, 217000])).toBe('match');
  });

  it('rejects a resolved price above what the buyer was quoted', () => {
    // The only outcome worth failing a booking over: we must never invoice more
    // than the checkout displayed.
    expect(comparePriceQuote(217000, [255500])).toBe('rejected');
  });

  it('honours a resolved price below the quote instead of failing the booking', () => {
    // A stale page (the tenant edited the HubDB row mid-checkout) used to throw
    // price_mismatch here and lose the sale.
    expect(comparePriceQuote(255500, [217000])).toBe('honoured_lower');
  });

  it('rejects when any line would be overcharged, even if another matches the quote', () => {
    expect(comparePriceQuote(217000, [190000, 255500])).toBe('rejected');
  });
});
