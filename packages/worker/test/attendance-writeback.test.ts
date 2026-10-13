import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ATTENDANCE_PROPERTIES,
  listEventAttendance,
  loadAttendanceContactConfig,
  summariseAttendance,
} from '../src/attendance-writeback';
import { mintTicketForTenant } from '../src/checkin';
import { handleOutboxMessage } from '../src/hubspot-writeback';
import { checkinRoutes } from '../src/routes/checkin';
import { manageRoutes } from '../src/routes/manage';
import { encryptToken } from '../src/token-crypto';
import type { Env } from '../src/types';

/**
 * Phase 2.1 — attendance write-back, which unblocks certificates.
 *
 * The worker renders no certificate. Ollie's Data Hub flow already renders and delivers
 * membership certificates from a contact property, and events feed that same mechanism so
 * a member never receives two differently-shaped documents. What has to hold here:
 *
 *   1. Attendance is QUERYABLE per registration, for a door scan and a webinar join alike.
 *   2. A check-in lands an attended flag + date on the ATTENDEE's contact, through the
 *      outbox, using the tenant's property mapping.
 *   3. The date never moves backwards — a straggler outbox row for last month's course must
 *      not overwrite this morning's, or the certificate names the wrong event.
 */

const BASE_ENV = env as unknown as Env;
const TOKEN_KEY = '0'.repeat(64);

let counter = 0;
function freshIds() {
  const n = `${Date.now()}-${counter++}`;
  return {
    portalId: `att-${n}`,
    adminKey: `admin-${n}`,
    eventId: `evt-att-${n}`,
    hubspotEventId: `hs-att-${n}`,
    ticketTypeId: `tt-att-${n}`,
    orderId: `ord-att-${n}`,
    regId: `reg-att-${n}`,
    ticketId: `tkt-att-${n}`,
  };
}

type Ids = ReturnType<typeof freshIds>;

/**
 * The QUEUE binding is stubbed, and that is load-bearing rather than a shortcut.
 *
 * These tests check people in for real, and check-in signals the queue. Against the REAL
 * binding Miniflare delivers those messages to the worker's own consumer some time later —
 * routinely while a LATER test file is running — which wakes `src/index.ts`, runs the outbox
 * handler, and calls HubSpot through whatever `vi.stubGlobal('fetch')` that other file
 * happens to have installed. `providers.test.ts` throws on any fetch it did not route, so
 * the delivery landed there as two MeetProvider failures roughly one run in six, with a
 * stack pointing at code neither file touches.
 *
 * Stubbing it is faithful to the design, not a dodge: the signal is explicitly best-effort
 * (`try`/`catch`, cron sweep as the backstop), and what these tests assert is the outbox ROW
 * written in the same D1 batch as the state change — which is the actual invariant.
 */
function envFor(ids: Ids): Env {
  return {
    ...(BASE_ENV as unknown as Record<string, unknown>),
    QUEUE: { send: async () => undefined, sendBatch: async () => undefined },
    [`ADMIN_API_KEY_${ids.portalId}`]: ids.adminKey,
    [`TICKET_SIGNING_SECRET_${ids.portalId}`]: `ticket-${ids.portalId}`,
    [`DEVICE_TOKEN_SECRET_${ids.portalId}`]: `device-${ids.portalId}`,
  } as unknown as Env;
}

function adminHeaders(ids: Ids) {
  return {
    'X-Portal-Id': ids.portalId,
    Authorization: `Bearer ${ids.adminKey}`,
    'Content-Type': 'application/json',
  };
}

/** A queue Message stub: records ack/retry so a test can assert how the row was settled. */
function fakeMessage(body: Record<string, unknown>) {
  const state = { acked: false, retried: false };
  return {
    state,
    msg: {
      body,
      ack: () => {
        state.acked = true;
      },
      retry: () => {
        state.retried = true;
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal Message stub for the consumer
    } as any,
  };
}

/** Records every HubSpot call and answers from `contact` (null = no such contact). */
function stubHubSpot(opts: {
  contact?: Record<string, string> | null;
  /** null = HubSpot refuses the property schema read (the scope is optional). */
  propertyType?: string | null;
}) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });

      const json = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { 'content-type': 'application/json' },
        });

      if (url.includes('/crm/v3/properties/contacts/')) {
        if (opts.propertyType === null) return json({ message: 'no schema scope' }, 403);
        return json({ type: opts.propertyType ?? 'datetime' });
      }
      if (url.includes('/crm/v3/objects/contacts/')) {
        if (method === 'GET') {
          if (opts.contact === null) return json({ message: 'not found' }, 404);
          return json({ id: 'contact-1', properties: opts.contact ?? {} });
        }
        return json({ id: 'contact-1' });
      }
      return json({});
    }),
  );
  return calls;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function seedEvent(
  ids: Ids,
  opts?: { attendedProperty?: string | null; dateProperty?: string | null },
): Promise<void> {
  const now = new Date().toISOString();
  await BASE_ENV.DB.prepare(
    `INSERT INTO tenants
       (portal_id, stripe_processor_connected, hs_access_token, hs_refresh_token,
        hs_token_expires_at, contact_attended_property, contact_attended_date_property, display_name)
     VALUES (?1, 1, ?2, ?3, ?4, ?5, ?6, 'Test Tenant')`,
  )
    .bind(
      ids.portalId,
      await encryptToken(TOKEN_KEY, 'hs-access-token'),
      await encryptToken(TOKEN_KEY, 'hs-refresh-token'),
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      opts?.attendedProperty ?? null,
      opts?.dateProperty ?? null,
    )
    .run();

  await BASE_ENV.DB.prepare(
    `INSERT INTO events
       (id, portal_id, hubspot_event_id, title, starts_at, ends_at, location, capacity,
        booking_kind, marketing_event_completed, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'Welding Fundamentals', ?4, ?5, 'Adelaide', 20, 'course', 0, ?4, ?4)`,
  )
    .bind(
      ids.eventId,
      ids.portalId,
      ids.hubspotEventId,
      now,
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    )
    .run();

  await BASE_ENV.DB.prepare(
    `INSERT INTO ticket_types
       (id, portal_id, event_id, name, price_cents, currency, capacity, sort_order, created_at)
     VALUES (?1, ?2, ?3, 'Standard', 83500, 'AUD', 20, 0, ?4)`,
  )
    .bind(ids.ticketTypeId, ids.portalId, ids.eventId, now)
    .run();
}

/** An order, a registration and an issued ticket — a seat ready to be scanned. */
async function seedBooking(ids: Ids): Promise<string> {
  const now = new Date().toISOString();
  await BASE_ENV.DB.prepare(
    `INSERT INTO orders (id, portal_id, event_id, status, buyer_email, buyer_name,
       total_cents, currency, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'paid', 'buyer@weld.test', 'Bree Buyer', 83500, 'AUD', ?4, ?4)`,
  )
    .bind(ids.orderId, ids.portalId, ids.eventId, now)
    .run();
  await BASE_ENV.DB.prepare(
    `INSERT INTO registrations
       (id, portal_id, order_id, event_id, ticket_type_id, attendee_email, attendee_name,
        ticket_id, marketing_event_state_synced, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'sam@weld.test', 'Sam Tan', ?6, 0, ?7, ?7)`,
  )
    .bind(ids.regId, ids.portalId, ids.orderId, ids.eventId, ids.ticketTypeId, ids.ticketId, now)
    .run();

  const qrCode = await mintTicketForTenant(
    envFor(ids),
    ids.portalId,
    ids.ticketId,
    ids.regId,
    ids.eventId,
  );
  await BASE_ENV.DB.prepare(
    `INSERT INTO tickets
       (id, portal_id, registration_id, order_id, event_id, ticket_type_id, status, qr_code, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'issued', ?7, ?8)`,
  )
    .bind(
      ids.ticketId,
      ids.portalId,
      ids.regId,
      ids.orderId,
      ids.eventId,
      ids.ticketTypeId,
      qrCode,
      now,
    )
    .run();
  return qrCode;
}

/** A device token scoped to the event, as the scanner presents it. */
async function deviceToken(ids: Ids): Promise<string> {
  const res = await checkinRoutes.request(
    '/device-token',
    {
      method: 'POST',
      headers: adminHeaders(ids),
      body: JSON.stringify({ eventId: ids.eventId, deviceId: 'dev-1' }),
    },
    envFor(ids),
  );
  const body = await res.json<{ token: string }>();
  return body.token;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Property mapping
// ---------------------------------------------------------------------------

describe('attendance property mapping', () => {
  it('keeps configured property names when display_timezone has not been migrated yet', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await BASE_ENV.DB.prepare(
      'UPDATE tenants SET contact_attended_property = ?1 WHERE portal_id = ?2',
    )
      .bind('weld_course_attended', ids.portalId)
      .run();

    // D1 fails the whole statement on an unknown column, so between deploying the timezone
    // work and applying migration 0025 the config read throws. Falling back to the DEFAULT
    // property names would silently write attendance somewhere nothing reads — the retry
    // has to preserve what the portal configured, and only give up the timezone.
    const missingColumn = {
      ...(BASE_ENV as unknown as Record<string, unknown>),
      DB: {
        prepare(sql: string) {
          const stmt = BASE_ENV.DB.prepare(sql);
          if (sql.includes('display_timezone')) {
            return {
              bind: () => ({
                first: async () => {
                  throw new Error('D1_ERROR: no such column: display_timezone');
                },
              }),
            };
          }
          return stmt;
        },
      },
    } as unknown as Env;

    const config = await loadAttendanceContactConfig(missingColumn, ids.portalId);
    expect(config.attendedProperty).toBe('weld_course_attended');
    expect(config.displayTimeZone).toBe('Australia/Adelaide');
  });

  it('defaults to the named properties when the tenant has expressed no preference', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    const config = await loadAttendanceContactConfig(BASE_ENV, ids.portalId);
    expect(config).toEqual({
      // The tenant has set no timezone, so the attendance DATE is expressed in the
      // built-in default (migration 0025).
      displayTimeZone: 'Australia/Adelaide',
      attendedProperty: DEFAULT_ATTENDANCE_PROPERTIES.attended,
      attendedDateProperty: DEFAULT_ATTENDANCE_PROPERTIES.attendedDate,
      eventNameProperty: DEFAULT_ATTENDANCE_PROPERTIES.eventName,
    });
  });

  it("honours a portal's own property names, and 'off' per field", async () => {
    const ids = freshIds();
    await seedEvent(ids, { attendedProperty: 'weld_attended', dateProperty: 'off' });
    const config = await loadAttendanceContactConfig(BASE_ENV, ids.portalId);
    expect(config.attendedProperty).toBe('weld_attended');
    expect(config.attendedDateProperty).toBeNull();
    expect(config.eventNameProperty).toBe(DEFAULT_ATTENDANCE_PROPERTIES.eventName);
  });

  it('degrades to the defaults rather than throwing when the columns are missing (Ref 217)', async () => {
    const config = await loadAttendanceContactConfig(BASE_ENV, 'no-such-portal');
    expect(config.attendedProperty).toBe(DEFAULT_ATTENDANCE_PROPERTIES.attended);
  });

  it('resets a field to its default through the onboarding route', async () => {
    const ids = freshIds();
    await seedEvent(ids, { attendedProperty: 'weld_attended' });

    const res = await manageRoutes.request(
      '/onboarding/attendance-property-config',
      {
        method: 'PATCH',
        headers: adminHeaders(ids),
        body: JSON.stringify({ contactAttendedProperty: '' }),
      },
      envFor(ids),
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ propertyMapping: Record<string, string | null> }>();
    expect(body.propertyMapping.attended).toBe(DEFAULT_ATTENDANCE_PROPERTIES.attended);
  });
});

// ---------------------------------------------------------------------------
// The read model
// ---------------------------------------------------------------------------

describe('GET /events/:id/attendance', () => {
  it('requires admin authentication', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    const res = await manageRoutes.request(
      `/events/${ids.eventId}/attendance`,
      { method: 'GET', headers: { 'X-Portal-Id': ids.portalId } },
      envFor(ids),
    );
    expect(res.status).toBe(401);
  });

  it('reports a seat as registered before the door opens', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await seedBooking(ids);

    const res = await manageRoutes.request(
      `/events/${ids.eventId}/attendance`,
      { method: 'GET', headers: adminHeaders(ids) },
      envFor(ids),
    );
    const body = await res.json<{
      summary: { registered: number; attended: number; notYetArrived: number };
      propertyMapping: Record<string, string | null>;
      attendees: Array<{ attended: boolean; status: string; attendedAt: string | null }>;
    }>();

    expect(body.summary).toMatchObject({ registered: 1, attended: 0, notYetArrived: 1 });
    expect(body.attendees[0]).toMatchObject({
      attended: false,
      status: 'registered',
      attendedAt: null,
    });
    // Echoed so whoever wires the certificate flow can see where attendance lands.
    expect(body.propertyMapping.attended).toBe(DEFAULT_ATTENDANCE_PROPERTIES.attended);
  });

  it('reports a scanned seat as attended, with the arrival time and its source', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    const code = await seedBooking(ids);
    stubHubSpot({ contact: {} });

    const token = await deviceToken(ids);
    const scannedAt = '2026-03-04T23:30:00.000Z';
    const scan = await checkinRoutes.request(
      '/',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, scannedAt }),
      },
      envFor(ids),
    );
    expect(scan.status).toBe(200);

    const rows = await listEventAttendance(BASE_ENV, ids.portalId, ids.eventId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      attended: true,
      status: 'attended',
      attendedAt: scannedAt,
      source: 'checkin',
    });
    expect(summariseAttendance(rows)).toMatchObject({ attended: 1, notYetArrived: 0 });
  });

  it('reports a webinar join as attended, so online events answer too', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await seedBooking(ids);

    // What processAttendance writes for a matched provider record: an me.attend row whose
    // stable interaction time is the earliest join.
    await BASE_ENV.DB.prepare(
      `INSERT INTO outbox (id, portal_id, topic, payload, stable_interaction_datetime, created_at)
       VALUES (?1, ?2, 'me.attend', ?3, ?4, ?4)`,
    )
      .bind(
        crypto.randomUUID(),
        ids.portalId,
        JSON.stringify({ registrationId: ids.regId }),
        '2026-03-04T22:00:00.000Z',
      )
      .run();

    const rows = await listEventAttendance(BASE_ENV, ids.portalId, ids.eventId);
    expect(rows[0]).toMatchObject({
      attended: true,
      attendedAt: '2026-03-04T22:00:00.000Z',
      source: 'marketing_event',
    });
  });

  it('counts one attendee once after a transfer reissued their ticket', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await seedBooking(ids);

    // A transfer voids the old code and issues a new one against the SAME registration.
    const newTicketId = `${ids.ticketId}-2`;
    await BASE_ENV.DB.prepare(`UPDATE tickets SET status = 'voided' WHERE id = ?1`)
      .bind(ids.ticketId)
      .run();
    await BASE_ENV.DB.prepare(
      `INSERT INTO tickets
         (id, portal_id, registration_id, order_id, event_id, ticket_type_id, status, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'issued', ?7)`,
    )
      .bind(
        newTicketId,
        ids.portalId,
        ids.regId,
        ids.orderId,
        ids.eventId,
        ids.ticketTypeId,
        new Date().toISOString(),
      )
      .run();
    await BASE_ENV.DB.prepare('UPDATE registrations SET ticket_id = ?1 WHERE id = ?2')
      .bind(newTicketId, ids.regId)
      .run();

    const rows = await listEventAttendance(BASE_ENV, ids.portalId, ids.eventId);
    expect(rows).toHaveLength(1);
    expect(rows[0].ticketId).toBe(newTicketId);
  });
});

// ---------------------------------------------------------------------------
// The write-back
// ---------------------------------------------------------------------------

describe('check-in enqueues the contact write-back', () => {
  it('writes the outbox row in the same batch as the ticket state change', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    const code = await seedBooking(ids);
    stubHubSpot({ contact: {} });

    const token = await deviceToken(ids);
    await checkinRoutes.request(
      '/',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, scannedAt: '2026-03-04T23:30:00.000Z' }),
      },
      envFor(ids),
    );

    const row = await BASE_ENV.DB.prepare(
      `SELECT payload, stable_interaction_datetime FROM outbox
        WHERE portal_id = ?1 AND topic = 'contact.sync_attendance'`,
    )
      .bind(ids.portalId)
      .first<{ payload: string; stable_interaction_datetime: string }>();

    expect(row).not.toBeNull();
    expect(JSON.parse(row?.payload ?? '{}')).toMatchObject({
      registrationId: ids.regId,
      // The ATTENDEE, never the buyer — a colleague books the seat, the attendee earns
      // the certificate.
      attendeeEmail: 'sam@weld.test',
      attendedAt: '2026-03-04T23:30:00.000Z',
      eventTitle: 'Welding Fundamentals',
    });
    // Stable arrival time, so a replay writes the same date rather than "now".
    expect(row?.stable_interaction_datetime).toBe('2026-03-04T23:30:00.000Z');
  });
});

describe('contact.sync_attendance handler', () => {
  async function enqueue(ids: Ids, attendedAt: string) {
    const outboxId = crypto.randomUUID();
    await BASE_ENV.DB.prepare(
      `INSERT INTO outbox (id, portal_id, topic, payload, stable_interaction_datetime, created_at)
       VALUES (?1, ?2, 'contact.sync_attendance', ?3, ?4, ?5)`,
    )
      .bind(
        outboxId,
        ids.portalId,
        JSON.stringify({
          registrationId: ids.regId,
          eventId: ids.eventId,
          attendeeEmail: 'sam@weld.test',
          attendeeName: 'Sam Tan',
          attendedAt,
          eventTitle: 'Welding Fundamentals',
        }),
        attendedAt,
        new Date().toISOString(),
      )
      .run();
    return outboxId;
  }

  function patchBody(calls: Array<{ method: string; url: string; body?: unknown }>) {
    const patch = calls.find(
      (call) => call.method === 'PATCH' && call.url.includes('/crm/v3/objects/contacts/'),
    );
    return (patch?.body as { properties?: Record<string, string> } | undefined)?.properties;
  }

  it('writes the flag, the date and the event name onto the attendee contact', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await seedBooking(ids);
    const calls = stubHubSpot({ contact: {} });

    const outboxId = await enqueue(ids, '2026-03-04T23:30:00.000Z');
    const { msg, state } = fakeMessage({
      kind: 'contact.sync_attendance',
      portalId: ids.portalId,
      outboxId,
      registrationId: ids.regId,
    });
    await handleOutboxMessage(msg, envFor(ids));
    expect(state.acked).toBe(true);

    expect(patchBody(calls)).toEqual({
      event_attended: 'true',
      event_last_attended_date: '2026-03-04T23:30:00.000Z',
      event_last_attended_name: 'Welding Fundamentals',
    });

    // The contact id it resolved is stamped back, the same linkage me.register makes.
    const reg = await BASE_ENV.DB.prepare(
      'SELECT hubspot_contact_id FROM registrations WHERE id = ?1',
    )
      .bind(ids.regId)
      .first<{ hubspot_contact_id: string | null }>();
    expect(reg?.hubspot_contact_id).toBe('contact-1');
  });

  it('sends a calendar date when the portal keys attendance as a HubSpot date property', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await seedBooking(ids);
    const calls = stubHubSpot({ contact: {}, propertyType: 'date' });

    // 23:30Z on the 4th is 10:00am on the 5th in Adelaide — an ordinary morning course.
    // The certificate prints the day they were in the room, which is the 5th.
    const outboxId = await enqueue(ids, '2026-03-04T23:30:00.000Z');
    const { msg } = fakeMessage({
      kind: 'contact.sync_attendance',
      portalId: ids.portalId,
      outboxId,
      registrationId: ids.regId,
    });
    await handleOutboxMessage(msg, envFor(ids));

    expect(patchBody(calls)?.event_last_attended_date).toBe('2026-03-05');
  });

  it('writes the date in the tenant timezone, not the UTC one', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await seedBooking(ids);
    const calls = stubHubSpot({ contact: {}, propertyType: 'date' });

    // The whole failure in one case: Adelaide is UTC+10:30 in March, so every check-in
    // before 10:30am local falls on the previous UTC day. Slicing the ISO string put the
    // wrong day on the certificate for most morning courses.
    const outboxId = await enqueue(ids, '2026-03-04T22:00:00.000Z'); // 08:30 on the 5th
    const { msg } = fakeMessage({
      kind: 'contact.sync_attendance',
      portalId: ids.portalId,
      outboxId,
      registrationId: ids.regId,
    });
    await handleOutboxMessage(msg, envFor(ids));

    expect(patchBody(calls)?.event_last_attended_date).toBe('2026-03-05');
  });

  it('follows a portal that has set its own timezone', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await seedBooking(ids);
    await BASE_ENV.DB.prepare('UPDATE tenants SET display_timezone = ?1 WHERE portal_id = ?2')
      .bind('Europe/London', ids.portalId)
      .run();
    const calls = stubHubSpot({ contact: {}, propertyType: 'date' });

    // Nothing here is Australian: the same instant is still the 4th in London, and a
    // London portal's certificate has to say so.
    const outboxId = await enqueue(ids, '2026-03-04T23:30:00.000Z');
    const { msg } = fakeMessage({
      kind: 'contact.sync_attendance',
      portalId: ids.portalId,
      outboxId,
      registrationId: ids.regId,
    });
    await handleOutboxMessage(msg, envFor(ids));

    expect(patchBody(calls)?.event_last_attended_date).toBe('2026-03-04');
  });

  it('falls back to a calendar date when the property schema cannot be read', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await seedBooking(ids);
    // The schema scope is optional, so an un-granted portal must still write a value both
    // HubSpot date types accept — a timestamp would be a 400 on a `date` property.
    const calls = stubHubSpot({ contact: {}, propertyType: null });

    const outboxId = await enqueue(ids, '2026-03-04T23:30:00.000Z');
    const { msg, state } = fakeMessage({
      kind: 'contact.sync_attendance',
      portalId: ids.portalId,
      outboxId,
      registrationId: ids.regId,
    });
    await handleOutboxMessage(msg, envFor(ids));

    expect(state.acked).toBe(true);
    expect(patchBody(calls)?.event_last_attended_date).toBe('2026-03-05');
  });

  it('never moves the date backwards for a straggling older attendance', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await seedBooking(ids);
    // HubSpot already holds a LATER attendance than the row now draining.
    const calls = stubHubSpot({
      contact: {
        event_attended: 'true',
        event_last_attended_date: '2026-06-01T09:00:00.000Z',
        event_last_attended_name: 'Advanced TIG',
      },
    });

    const outboxId = await enqueue(ids, '2026-03-04T23:30:00.000Z');
    const { msg, state } = fakeMessage({
      kind: 'contact.sync_attendance',
      portalId: ids.portalId,
      outboxId,
      registrationId: ids.regId,
    });
    await handleOutboxMessage(msg, envFor(ids));

    // Nothing to write: the flag is already set, the date is newer, and the event name
    // belongs to that newer date — writing it would name the wrong course.
    expect(state.acked).toBe(true);
    expect(patchBody(calls)).toBeUndefined();
  });

  it('writes nothing when the tenant has switched attendance write-back off', async () => {
    const ids = freshIds();
    await seedEvent(ids, { attendedProperty: 'off', dateProperty: 'off' });
    await BASE_ENV.DB.prepare(
      'UPDATE tenants SET contact_attended_event_property = ?1 WHERE portal_id = ?2',
    )
      .bind('off', ids.portalId)
      .run();
    await seedBooking(ids);
    const calls = stubHubSpot({ contact: {} });

    const outboxId = await enqueue(ids, '2026-03-04T23:30:00.000Z');
    const { msg, state } = fakeMessage({
      kind: 'contact.sync_attendance',
      portalId: ids.portalId,
      outboxId,
      registrationId: ids.regId,
    });
    await handleOutboxMessage(msg, envFor(ids));

    expect(state.acked).toBe(true);
    expect(calls.some((call) => call.url.includes('/crm/v3/objects/contacts/'))).toBe(false);
  });

  it('is idempotent: a redelivery of the same attendance writes nothing the second time', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await seedBooking(ids);
    const calls = stubHubSpot({
      // The state HubSpot is in after the first delivery.
      contact: {
        event_attended: 'true',
        event_last_attended_date: '2026-03-04T23:30:00.000Z',
        event_last_attended_name: 'Welding Fundamentals',
      },
    });

    const outboxId = await enqueue(ids, '2026-03-04T23:30:00.000Z');
    const { msg } = fakeMessage({
      kind: 'contact.sync_attendance',
      portalId: ids.portalId,
      outboxId,
      registrationId: ids.regId,
    });
    await handleOutboxMessage(msg, envFor(ids));

    expect(patchBody(calls)).toBeUndefined();
  });

  it('creates the attendee contact carrying their name when HubSpot has none', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await seedBooking(ids);
    const calls = stubHubSpot({ contact: null });

    const outboxId = await enqueue(ids, '2026-03-04T23:30:00.000Z');
    const { msg } = fakeMessage({
      kind: 'contact.sync_attendance',
      portalId: ids.portalId,
      outboxId,
      registrationId: ids.regId,
    });
    await handleOutboxMessage(msg, envFor(ids));

    // A record holding an attendance date and nothing to identify it is worse than none.
    expect(patchBody(calls)).toMatchObject({
      email: 'sam@weld.test',
      firstname: 'Sam',
      lastname: 'Tan',
      event_attended: 'true',
    });
  });
});

// ---------------------------------------------------------------------------
// Provisioning the properties the write-back targets
// ---------------------------------------------------------------------------
