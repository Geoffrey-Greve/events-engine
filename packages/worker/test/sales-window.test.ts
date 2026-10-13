import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { manageRoutes } from '../src/routes/manage';
import { handleGetAvailability, handleReserve, reserveEventWithBody } from '../src/routes/reserve';
import {
  resolveRegistrationClosesAt,
  resolveSalesWindow,
  salesWindowRejection,
} from '../src/sales-window';
import type { Env } from '../src/types';

/**
 * Migration 0038 — when an event stops being for sale.
 *
 * Two faults behind this. Reserve had no time bound at all, so a course that finished last
 * week still took public bookings; and the only way to stop selling one early was to zero
 * its capacity, which Phase 1.1 refuses. The cases below pin both gates, who is exempt from
 * them, and the invariant that matters more than either: closing sales moves no seats.
 */

const BASE_ENV = env as unknown as Env;
let counter = 0;

function freshIds() {
  const n = `${Date.now()}-${counter++}`;
  return {
    portalId: `sw-${n}`,
    eventId: `evt-${n}`,
    hubspotEventId: `hs-sw-${n}`,
    ticketTypeId: `tt-${n}`,
    secondTicketTypeId: `tt2-${n}`,
    adminKey: `admin-${n}`,
  };
}

function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

const DAY = 24 * 60 * 60 * 1000;

/** Reserve never reaches HubSpot here: membership degrades to unverified, pricing to list. */
function stubHubSpot() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 404 })),
  );
}

interface SeedOptions {
  startsAt?: string;
  registrationClosesAt?: string | null;
  salesPaused?: boolean;
  secondTicketTypePaused?: boolean;
  displayTimeZone?: string | null;
}

async function seedEvent(values: ReturnType<typeof freshIds>, options: SeedOptions = {}) {
  const {
    startsAt = isoIn(14 * DAY),
    registrationClosesAt = null,
    salesPaused = false,
    secondTicketTypePaused = false,
    displayTimeZone = null,
  } = options;
  const now = new Date().toISOString();

  await BASE_ENV.DB.prepare(
    `INSERT INTO tenants (portal_id, display_name, stripe_processor_connected, xero_gst_rate_id,
                          display_timezone, created_at)
     VALUES (?1, 'Weld Australia (test)', 1, 'hs-gst-rate', ?2, ?3)`,
  )
    .bind(values.portalId, displayTimeZone, now)
    .run();

  await BASE_ENV.DB.prepare(
    `INSERT INTO events
       (id, portal_id, hubspot_event_id, title, starts_at, ends_at, location, capacity,
        booking_kind, allow_oversell, marketing_event_completed, registration_closes_at,
        sales_paused, first_published_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'AS1796 Cert 10', ?4, ?5, 'Adelaide', 20, 'course', 0, 0, ?6, ?7, ?8, ?8, ?8)`,
  )
    .bind(
      values.eventId,
      values.portalId,
      values.hubspotEventId,
      startsAt,
      new Date(Date.parse(startsAt) + DAY).toISOString(),
      registrationClosesAt,
      salesPaused ? 1 : 0,
      now,
    )
    .run();

  for (const [id, name, paused] of [
    [values.ticketTypeId, 'Standard', false],
    [values.secondTicketTypeId, 'Early bird', secondTicketTypePaused],
  ] as Array<[string, string, boolean]>) {
    await BASE_ENV.DB.prepare(
      `INSERT INTO ticket_types
         (id, portal_id, event_id, name, price_cents, currency, capacity, tax_treatment,
          member_only, sort_order, sales_paused, created_at)
       VALUES (?1, ?2, ?3, ?4, 83500, 'AUD', 20, 'gst', 0, 0, ?5, ?6)`,
    )
      .bind(id, values.portalId, values.eventId, name, paused ? 1 : 0, now)
      .run();
  }
}

const publicApp = new Hono<{ Bindings: Env }>();
publicApp.post('/api/v1/events/:slug/reserve', handleReserve);
publicApp.get('/api/v1/events/:slug/availability', handleGetAvailability);

/**
 * The two non-public callers, mounted as real routes so `reserveEventWithBody` gets a real
 * Hono context — these are the paths `manage` (staff) and `corporate-team` (bulk) take.
 */
const internalApp = new Hono<{ Bindings: Env }>();
internalApp.post('/:source/:portalId/:eventId/:ticketTypeId/:email', (c) =>
  reserveEventWithBody(c, c.req.param('portalId'), {
    eventId: c.req.param('eventId'),
    idempotencyKey: crypto.randomUUID(),
    body: {
      buyer: { name: 'Internal Caller', email: c.req.param('email') },
      ticketTypeId: c.req.param('ticketTypeId'),
    },
    options: { source: c.req.param('source') as 'staff_manual' | 'corporate_bulk' },
  }),
);

function internalReserve(
  values: ReturnType<typeof freshIds>,
  source: 'staff_manual' | 'corporate_bulk',
  email: string,
) {
  return internalApp.request(
    `/${source}/${values.portalId}/${values.eventId}/${values.ticketTypeId}/${email}`,
    { method: 'POST' },
    BASE_ENV,
  );
}

function publicReserve(
  values: ReturnType<typeof freshIds>,
  ticketTypeId = values.ticketTypeId,
  email = 'danielle@example.com',
) {
  return publicApp.request(
    `/api/v1/events/${values.eventId}/reserve`,
    {
      method: 'POST',
      headers: {
        'X-Portal-Id': values.portalId,
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
        'CF-Connecting-IP': `10.0.1.${counter % 250}`,
      },
      body: JSON.stringify({ buyer: { name: 'Danielle Buyer', email }, ticketTypeId }),
    },
    BASE_ENV,
  );
}

/**
 * A booking that actually took a seat. Reserve answers 201 when the seat is confirmed
 * outright (free/comped) and 200 with `reserved` when it is held against an invoice, so
 * asserting on the status code alone would pin the wrong thing — what matters here is that
 * the sales window let the booking through, in whichever shape it takes.
 */
async function expectSeatTaken(res: Response) {
  const body = (await res.clone().json()) as { status?: string };
  expect([200, 201]).toContain(res.status);
  expect(['reserved', 'confirmed']).toContain(body.status);
}

function availability(values: ReturnType<typeof freshIds>) {
  return publicApp.request(
    `/api/v1/events/${values.eventId}/availability`,
    { headers: { 'X-Portal-Id': values.portalId, 'CF-Connecting-IP': `10.0.2.${counter % 250}` } },
    BASE_ENV,
  );
}

function envFor(values: ReturnType<typeof freshIds>): Env {
  return {
    ...(BASE_ENV as unknown as Record<string, unknown>),
    [`ADMIN_API_KEY_${values.portalId}`]: values.adminKey,
  } as unknown as Env;
}

function patchEvent(values: ReturnType<typeof freshIds>, body: Record<string, unknown>) {
  return manageRoutes.request(
    `/events/${values.eventId}`,
    {
      method: 'PATCH',
      headers: {
        'X-Portal-Id': values.portalId,
        Authorization: `Bearer ${values.adminKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
    envFor(values),
  );
}

async function storedEvent(eventId: string) {
  return BASE_ENV.DB.prepare(
    'SELECT registration_closes_at, sales_paused, capacity FROM events WHERE id = ?1',
  )
    .bind(eventId)
    .first<{ registration_closes_at: string | null; sales_paused: number; capacity: number }>();
}

afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------
// resolveSalesWindow
// ---------------------------------------------------------------------------

describe('resolveSalesWindow', () => {
  it('defaults the cutoff to the event start, so a finished course is not still selling', () => {
    const window = resolveSalesWindow({ starts_at: isoIn(-DAY), registration_closes_at: null });
    expect(window.closed).toBe(true);
    expect(window.closesAtIsDefault).toBe(true);
    expect(window.open).toBe(false);
  });

  it('leaves an upcoming event open', () => {
    const window = resolveSalesWindow({ starts_at: isoIn(DAY) });
    expect(window).toMatchObject({ closed: false, paused: false, open: true });
  });

  it('honours a chosen cutoff ahead of the start — the catering-numbers case', () => {
    const startsAt = isoIn(14 * DAY);
    const window = resolveSalesWindow({
      starts_at: startsAt,
      registration_closes_at: isoIn(-DAY),
    });
    expect(window.closed).toBe(true);
    expect(window.closesAtIsDefault).toBe(false);
    expect(window.closesAt).not.toBe(startsAt);
  });

  it('honours a chosen cutoff PAST the start — the walk-up window', () => {
    const window = resolveSalesWindow({
      starts_at: isoIn(-60 * 60 * 1000),
      registration_closes_at: isoIn(60 * 60 * 1000),
    });
    expect(window.open).toBe(true);
  });

  it('treats an unparseable cutoff as no cutoff, never as closed', () => {
    // A typo in one column must not be able to take an event off sale invisibly.
    const window = resolveSalesWindow({
      starts_at: isoIn(DAY),
      registration_closes_at: 'next Tuesday',
    });
    expect(window.closed).toBe(false);
    expect(window.open).toBe(true);
  });

  it('reports a pause ahead of the clock, because the pause is the reversible one', () => {
    const rejection = salesWindowRejection(
      resolveSalesWindow({ starts_at: isoIn(-DAY), sales_paused: 1 }),
    );
    expect(rejection?.status).toBe('sales_paused');
  });

  it('reads a row predating the migration as open', () => {
    // SELECT * on an un-migrated database returns neither column.
    expect(resolveSalesWindow({ starts_at: isoIn(DAY) }).open).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveRegistrationClosesAt
// ---------------------------------------------------------------------------

/** The stored instant, or a failure the assertion will show rather than swallow. */
function resolved(input: unknown, timeZone: string | null): string {
  const result = resolveRegistrationClosesAt(input, timeZone);
  if (!result.ok) throw new Error(result.message);
  return result.value ?? '';
}

describe('resolveRegistrationClosesAt', () => {
  it('reads a bare date as the END of that day where the tenant lives', () => {
    const result = resolveRegistrationClosesAt('2026-09-20', 'Australia/Adelaide');
    expect(result).toEqual({ ok: true, value: '2026-09-20T14:29:59.999Z' });
  });

  it('does not lose the tenant nine and a half hours to UTC', () => {
    // The bug this exists to avoid: "close on the 20th" resolving to 20 Sep 00:00Z, which
    // is 09:30 on the 20th in Adelaide — most of the day gone.
    expect(
      resolved('2026-09-20', 'Australia/Adelaide') < resolved('2026-09-20T23:59:59.999Z', null),
    ).toBe(true);
  });

  it('follows the tenant timezone rather than assuming Adelaide', () => {
    // Perth is UTC+8, Adelaide +9:30, so Perth's end-of-day is the LATER instant.
    expect(
      resolved('2026-09-20', 'Australia/Perth') > resolved('2026-09-20', 'Australia/Adelaide'),
    ).toBe(true);
  });

  it('stores a full instant as given, normalised to UTC', () => {
    expect(resolveRegistrationClosesAt('2026-09-20T09:00:00+09:30', null)).toEqual({
      ok: true,
      value: '2026-09-19T23:30:00.000Z',
    });
  });

  it('clears the cutoff on null or empty, back to the starts_at default', () => {
    expect(resolveRegistrationClosesAt(null, null)).toEqual({ ok: true, value: null });
    expect(resolveRegistrationClosesAt('  ', null)).toEqual({ ok: true, value: null });
  });

  it('rejects something that is not a date at all', () => {
    expect(resolveRegistrationClosesAt('soon', null).ok).toBe(false);
    expect(resolveRegistrationClosesAt(42, null).ok).toBe(false);
  });

  it('rejects a day that does not exist rather than rolling it forward', () => {
    // Date.UTC turns 2026-02-30 into 2 March without complaint, so a mistyped cutoff would
    // leave sales open two days longer than intended and nothing would say so.
    for (const impossible of ['2026-02-30', '2026-11-31', '2026-13-01', '2026-02-29']) {
      expect(resolveRegistrationClosesAt(impossible, null).ok).toBe(false);
    }
  });

  it('still accepts a real leap day', () => {
    expect(resolveRegistrationClosesAt('2024-02-29', 'Australia/Adelaide').ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Reserve
// ---------------------------------------------------------------------------

describe('reserve sales window', () => {
  it('books an open event as before', async () => {
    stubHubSpot();
    const values = freshIds();
    await seedEvent(values);

    await expectSeatTaken(await publicReserve(values));
  });

  it('refuses a public booking on a course that has already started', async () => {
    stubHubSpot();
    const values = freshIds();
    await seedEvent(values, { startsAt: isoIn(-7 * DAY) });

    const res = await publicReserve(values);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ status: 'registration_closed' });
  });

  it('refuses a public booking past a chosen cutoff, with the event still to come', async () => {
    stubHubSpot();
    const values = freshIds();
    await seedEvent(values, { startsAt: isoIn(14 * DAY), registrationClosesAt: isoIn(-DAY) });

    const res = await publicReserve(values);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ status: 'registration_closed' });
  });

  it('refuses a paused event and says so distinctly, not as a sell-out', async () => {
    stubHubSpot();
    const values = freshIds();
    await seedEvent(values, { salesPaused: true });

    const res = await publicReserve(values);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ status: 'sales_paused' });
  });

  it('refuses a paused TICKET TYPE while the event keeps selling the others', async () => {
    stubHubSpot();
    const values = freshIds();
    await seedEvent(values, { secondTicketTypePaused: true });

    const paused = await publicReserve(values, values.secondTicketTypeId, 'early@example.com');
    expect(paused.status).toBe(409);
    expect(await paused.json()).toMatchObject({ status: 'ticket_sales_paused' });

    await expectSeatTaken(await publicReserve(values, values.ticketTypeId, 'standard@example.com'));
  });

  it('lets STAFF book past the cutoff — the phone call after registrations closed', async () => {
    stubHubSpot();
    const values = freshIds();
    await seedEvent(values, { startsAt: isoIn(-DAY), salesPaused: true });

    await expectSeatTaken(await internalReserve(values, 'staff_manual', 'walkin@example.com'));
  });

  it('does NOT exempt corporate bulk — a self-service path that ignores the cutoff is no cutoff', async () => {
    stubHubSpot();
    const values = freshIds();
    await seedEvent(values, { startsAt: isoIn(-DAY) });

    const res = await internalReserve(values, 'corporate_bulk', 'admin@example.com');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ status: 'registration_closed' });
  });

  it('closing sales moves no seats — the hold and the capacity are untouched', async () => {
    stubHubSpot();
    const values = freshIds();
    await seedEvent(values);

    const booked = await publicReserve(values);
    await expectSeatTaken(booked);
    const { orderId } = (await booked.json()) as { orderId: string };

    const before = await BASE_ENV.DB.prepare(
      `SELECT o.status, r.expires_at, (SELECT COUNT(*) FROM registrations WHERE order_id = o.id) AS seats
       FROM orders o JOIN reservations r ON r.id = o.reservation_id WHERE o.id = ?1`,
    )
      .bind(orderId)
      .first<{ status: string; expires_at: string; seats: number }>();

    expect((await patchEvent(values, { salesPaused: true })).status).toBe(200);

    const after = await BASE_ENV.DB.prepare(
      `SELECT o.status, r.expires_at, (SELECT COUNT(*) FROM registrations WHERE order_id = o.id) AS seats
       FROM orders o JOIN reservations r ON r.id = o.reservation_id WHERE o.id = ?1`,
    )
      .bind(orderId)
      .first<{ status: string; expires_at: string; seats: number }>();

    // Same order, same hold, same seats. Pausing stops SELLING; it is not a cancellation.
    expect(after).toEqual(before);
    // And the capacity the report divides by is the one it always was — the whole reason
    // this is a flag rather than a capacity of zero.
    expect((await storedEvent(values.eventId))?.capacity).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

describe('GET /events/:slug/availability', () => {
  it('reports an open event as bookable with seats', async () => {
    const values = freshIds();
    await seedEvent(values);

    const body = (await (await availability(values)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: 'ok',
      registrationClosed: false,
      salesPaused: false,
      bookable: true,
    });
    expect((body.ticketTypes as Array<{ bookable: boolean }>)[0].bookable).toBe(true);
  });

  it('separates "closed" from "sold out", because they are different sentences', async () => {
    const values = freshIds();
    await seedEvent(values, { startsAt: isoIn(-DAY) });

    const body = (await (await availability(values)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ registrationClosed: true, eventFull: false, bookable: false });
    const types = body.ticketTypes as Array<{ soldOut: boolean; bookable: boolean }>;
    // Seats really are available — the event just is not selling them.
    expect(types[0].soldOut).toBe(false);
    expect(types[0].bookable).toBe(false);
  });

  it('offers no waitlist on a closed event — reserve would reject the join', async () => {
    const values = freshIds();
    await seedEvent(values, { salesPaused: true });

    const body = (await (await availability(values)).json()) as Record<string, unknown>;
    const types = body.ticketTypes as Array<{ waitlistAvailable: boolean }>;
    expect(types.every((t) => t.waitlistAvailable === false)).toBe(true);
  });

  it('is not bookable when every public ticket type is paused, even with seats left', async () => {
    // Event-level capacity is untouched, so `eventFull` is false. A consumer reading only
    // the event flag would render a Register button with nothing selectable behind it.
    const values = freshIds();
    await seedEvent(values, { secondTicketTypePaused: true });
    await BASE_ENV.DB.prepare('UPDATE ticket_types SET sales_paused = 1 WHERE id = ?1')
      .bind(values.ticketTypeId)
      .run();

    const body = (await (await availability(values)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ eventFull: false, salesPaused: false, bookable: false });
    const types = body.ticketTypes as Array<{ bookable: boolean }>;
    expect(types.every((t) => t.bookable === false)).toBe(true);
  });

  it('marks only the paused ticket type, leaving the rest bookable', async () => {
    const values = freshIds();
    await seedEvent(values, { secondTicketTypePaused: true });

    const body = (await (await availability(values)).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ bookable: true, salesPaused: false });
    const types = body.ticketTypes as Array<{
      ticketTypeId: string;
      salesPaused: boolean;
      bookable: boolean;
    }>;
    const early = types.find((t) => t.ticketTypeId === values.secondTicketTypeId);
    const standard = types.find((t) => t.ticketTypeId === values.ticketTypeId);
    expect(early).toMatchObject({ salesPaused: true, bookable: false });
    expect(standard).toMatchObject({ salesPaused: false, bookable: true });
  });
});

// ---------------------------------------------------------------------------
// PATCH /events/:id
// ---------------------------------------------------------------------------

describe('PATCH /events/:id sales window', () => {
  it('pauses and resumes', async () => {
    const values = freshIds();
    await seedEvent(values);

    expect((await patchEvent(values, { salesPaused: true })).status).toBe(200);
    expect((await storedEvent(values.eventId))?.sales_paused).toBe(1);

    expect((await patchEvent(values, { salesPaused: false })).status).toBe(200);
    expect((await storedEvent(values.eventId))?.sales_paused).toBe(0);
  });

  it('resolves a bare date through the tenant timezone', async () => {
    const values = freshIds();
    await seedEvent(values, { displayTimeZone: 'Australia/Perth' });

    expect((await patchEvent(values, { registrationClosesAt: '2026-09-20' })).status).toBe(200);
    expect((await storedEvent(values.eventId))?.registration_closes_at).toBe(
      '2026-09-20T15:59:59.999Z',
    );
  });

  it('clears the cutoff back to the starts_at default', async () => {
    const values = freshIds();
    await seedEvent(values, { registrationClosesAt: isoIn(DAY) });

    expect((await patchEvent(values, { registrationClosesAt: null })).status).toBe(200);
    expect((await storedEvent(values.eventId))?.registration_closes_at).toBeNull();
  });

  it('validates the cutoff BEFORE creating the event, so a retry is not a conflict', async () => {
    // Rejecting after the insert left the caller with a 400, a live half-configured event,
    // and a retry that collides with it.
    const values = freshIds();
    await BASE_ENV.DB.prepare(
      `INSERT INTO tenants (portal_id, display_name, created_at) VALUES (?1, 'T', ?2)`,
    )
      .bind(values.portalId, new Date().toISOString())
      .run();

    const create = (extra: Record<string, unknown>) =>
      manageRoutes.request(
        '/events',
        {
          method: 'POST',
          headers: {
            'X-Portal-Id': values.portalId,
            Authorization: `Bearer ${values.adminKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            hubspotEventId: values.hubspotEventId,
            title: 'Welding Fundamentals',
            startsAt: isoIn(14 * DAY),
            endsAt: isoIn(15 * DAY),
            capacity: 20,
            ...extra,
          }),
        },
        envFor(values),
      );

    const rejected = await create({ registrationClosesAt: 'the end of March' });
    expect(rejected.status).toBe(400);

    // Nothing was written, so the corrected retry succeeds instead of hitting 409.
    const stored = await BASE_ENV.DB.prepare(
      'SELECT COUNT(*) AS n FROM events WHERE portal_id = ?1',
    )
      .bind(values.portalId)
      .first<{ n: number }>();
    expect(stored?.n).toBe(0);

    expect((await create({ registrationClosesAt: '2026-03-31' })).status).toBe(201);
  });

  it('rejects a cutoff that is not a date', async () => {
    const values = freshIds();
    await seedEvent(values);

    const res = await patchEvent(values, { registrationClosesAt: 'end of the month' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ status: 'invalid_registration_closes_at' });
  });

  it('accepts a cutoff in the past — that is how you close an event right now', async () => {
    const values = freshIds();
    await seedEvent(values);

    expect((await patchEvent(values, { registrationClosesAt: isoIn(-DAY) })).status).toBe(200);
    const res = await publicReserve(values);
    expect(res.status).toBe(409);
  });
});
