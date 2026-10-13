import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleOutboxMessage } from '../src/hubspot-writeback';
import { listEventStaffNotes, listStaffNotes, prepareStaffNote, SYSTEM_AUTHOR } from '../src/notes';
import { manageRoutes } from '../src/routes/manage';
import { handleGetAvailability, handleGetOrder } from '../src/routes/reserve';
import { encryptToken } from '../src/token-crypto';
import type { Env } from '../src/types';

/**
 * Phase 1.3 — staff notes on a registration or an order.
 *
 * Two properties carry the feature, and both are easy to lose to a later refactor:
 *
 *   1. Append-only. There is no edit and no delete; a correction is another note, and the
 *      earlier one keeps standing next to it.
 *   2. Internal. A note reaches the manage routes and the HubSpot CRM timeline. It must
 *      never reach a ticket, an invoice, a confirmation, or the buyer's order poll — the
 *      last test in this file books a real seat with a note on it and reads every
 *      attendee-facing surface back looking for the words.
 */

const BASE_ENV = env as unknown as Env;
const TOKEN_KEY = '0'.repeat(64);

let counter = 0;
function freshIds() {
  const n = `${Date.now()}-${counter++}`;
  return {
    portalId: `notes-${n}`,
    adminKey: `admin-${n}`,
    eventId: `evt-notes-${n}`,
    hubspotEventId: `hs-notes-${n}`,
    ticketTypeId: `tt-notes-${n}`,
    orderId: `ord-notes-${n}`,
    regId: `reg-notes-${n}`,
  };
}

type Ids = ReturnType<typeof freshIds>;

function envFor(portalId: string, adminKey: string): Env {
  return {
    ...(BASE_ENV as unknown as Record<string, unknown>),
    [`ADMIN_API_KEY_${portalId}`]: adminKey,
  } as unknown as Env;
}

function adminHeaders(ids: Ids, idempotencyKey = crypto.randomUUID()) {
  return {
    'X-Portal-Id': ids.portalId,
    Authorization: `Bearer ${ids.adminKey}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey,
  };
}

/** The public, attendee-facing endpoints, mounted exactly as index.ts mounts them. */
const publicApp = new Hono<{ Bindings: Env }>();
publicApp.get('/api/v1/orders/:id', handleGetOrder);
publicApp.get('/api/v1/events/:slug/availability', handleGetAvailability);

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Tenant + event + ticket type, priced so a manual booking exercises the paid path. */
async function seedEvent(ids: Ids, opts?: { noteSyncMode?: string | null }): Promise<void> {
  const now = new Date().toISOString();
  await BASE_ENV.DB.prepare(
    `INSERT INTO tenants
       (portal_id, stripe_processor_connected, xero_gst_rate_id,
        hs_access_token, hs_refresh_token, hs_token_expires_at, note_sync_mode, display_name)
     VALUES (?1, 1, 'hs-gst-rate', ?2, ?3, ?4, ?5, 'Test Tenant')`,
  )
    .bind(
      ids.portalId,
      await encryptToken(TOKEN_KEY, 'hs-access-token'),
      await encryptToken(TOKEN_KEY, 'hs-refresh-token'),
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      opts?.noteSyncMode ?? null,
    )
    .run();

  await BASE_ENV.DB.prepare(
    `INSERT INTO events
       (id, portal_id, hubspot_event_id, title, starts_at, ends_at, location, capacity,
        booking_kind, provider, allow_oversell, marketing_event_completed, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'Welding Fundamentals', ?4, ?5, 'Adelaide', 20,
             'course', NULL, 0, 0, ?4, ?4)`,
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
       (id, portal_id, event_id, name, price_cents, currency, capacity, tax_treatment,
        member_only, sort_order, created_at)
     VALUES (?1, ?2, ?3, 'Standard', 83500, 'AUD', 20, 'gst', 0, 0, ?4)`,
  )
    .bind(ids.ticketTypeId, ids.portalId, ids.eventId, now)
    .run();
}

/** An order + registration written directly, for tests that don't need a real booking. */
async function seedBooking(ids: Ids): Promise<void> {
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
        created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'sam@weld.test', 'Sam Tan', ?6, ?6)`,
  )
    .bind(ids.regId, ids.portalId, ids.orderId, ids.eventId, ids.ticketTypeId, now)
    .run();
}

/** HubSpot answers nothing useful — enough for reserve's optional lookups to degrade. */
function stubHubSpotSilent() {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ status: 'error', message: 'not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('prepareStaffNote', () => {
  it('records an unattributed note against the system rather than dropping it', () => {
    const result = prepareStaffNote({
      portalId: 'p',
      orderId: 'o',
      body: '  Rang, running late  ',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.note.author).toBe(SYSTEM_AUTHOR);
    expect(result.note.body).toBe('Rang, running late');
    expect(result.note.registrationId).toBeNull();
  });

  it('keeps the line breaks staff typed', () => {
    const result = prepareStaffNote({
      portalId: 'p',
      orderId: 'o',
      body: 'Called 9am.\nCalling back Friday.',
    });
    expect(result.ok && result.note.body).toBe('Called 9am.\nCalling back Friday.');
  });

  it('refuses a note with nothing to say, and one about nothing', () => {
    expect(prepareStaffNote({ portalId: 'p', orderId: 'o', body: '   ' })).toMatchObject({
      ok: false,
      status: 'missing_body',
    });
    expect(prepareStaffNote({ portalId: 'p', body: 'orphan' })).toMatchObject({
      ok: false,
      status: 'missing_target',
    });
  });
});

// ---------------------------------------------------------------------------
// Manage routes
// ---------------------------------------------------------------------------

describe('staff notes manage routes', () => {
  it('requires admin authentication', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await seedBooking(ids);

    const res = await manageRoutes.request(
      `/events/${ids.eventId}/registrations/${ids.regId}/notes`,
      { method: 'GET', headers: { 'X-Portal-Id': ids.portalId } },
      envFor(ids.portalId, ids.adminKey),
    );
    expect(res.status).toBe(401);
  });

  it('adds and reads a note against a registration', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await seedBooking(ids);
    const testEnv = envFor(ids.portalId, ids.adminKey);

    const created = await manageRoutes.request(
      `/events/${ids.eventId}/registrations/${ids.regId}/notes`,
      {
        method: 'POST',
        headers: adminHeaders(ids),
        body: JSON.stringify({ body: 'Needs a left-handed booth', author: '55501' }),
      },
      testEnv,
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json<{
      ok: boolean;
      note: { author: string; body: string };
    }>();
    expect(createdBody.note).toMatchObject({
      author: '55501',
      body: 'Needs a left-handed booth',
    });

    const listed = await manageRoutes.request(
      `/events/${ids.eventId}/registrations/${ids.regId}/notes`,
      { method: 'GET', headers: adminHeaders(ids) },
      testEnv,
    );
    const notes = await listed.json<Array<{ body: string; registration_id: string }>>();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      body: 'Needs a left-handed booth',
      registration_id: ids.regId,
    });
  });

  it('adds and reads a note against an order', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await seedBooking(ids);
    const testEnv = envFor(ids.portalId, ids.adminKey);

    const created = await manageRoutes.request(
      `/events/${ids.eventId}/orders/${ids.orderId}/notes`,
      {
        method: 'POST',
        headers: adminHeaders(ids),
        body: JSON.stringify({ body: 'Invoice to head office, PO 4471' }),
      },
      testEnv,
    );
    expect(created.status).toBe(201);

    const listed = await manageRoutes.request(
      `/events/${ids.eventId}/orders/${ids.orderId}/notes`,
      { method: 'GET', headers: adminHeaders(ids) },
      testEnv,
    );
    const notes = await listed.json<Array<{ body: string; order_id: string; author: string }>>();
    expect(notes).toEqual([
      expect.objectContaining({
        body: 'Invoice to head office, PO 4471',
        order_id: ids.orderId,
        author: SYSTEM_AUTHOR,
      }),
    ]);
  });

  it('is append-only: a correction is a second note and the first one stands', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await seedBooking(ids);
    const testEnv = envFor(ids.portalId, ids.adminKey);

    for (const body of ['Dietary: vegetarian', 'Correction — dietary: vegan']) {
      const res = await manageRoutes.request(
        `/events/${ids.eventId}/registrations/${ids.regId}/notes`,
        { method: 'POST', headers: adminHeaders(ids), body: JSON.stringify({ body }) },
        testEnv,
      );
      expect(res.status).toBe(201);
    }

    const notes = await listStaffNotes(BASE_ENV, ids.portalId, { registrationId: ids.regId });
    expect(notes.map((n) => n.body)).toEqual([
      'Dietary: vegetarian',
      'Correction — dietary: vegan',
    ]);
    // No route can rewrite or remove either one.
    for (const method of ['PATCH', 'PUT', 'DELETE']) {
      const res = await manageRoutes.request(
        `/events/${ids.eventId}/registrations/${ids.regId}/notes/${notes[0].id}`,
        { method, headers: adminHeaders(ids), body: JSON.stringify({ body: 'rewritten' }) },
        testEnv,
      );
      expect(res.status).toBe(404);
    }
  });

  it('keeps the thread in write order when the notes share a timestamp', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await seedBooking(ids);

    // The Workers clock is frozen between I/O, so notes typed in the same breath — a
    // correction right after the note it corrects — carry the SAME millisecond. Forced
    // here so the tiebreak, not the timestamp, is what decides the order.
    const sharedTimestamp = '2026-03-04T01:02:03.000Z';
    // Six, not two: ordering on a random UUID would still land in write order 1 time in 2
    // by luck, and this test has to fail every time the tiebreak regresses, not half of them.
    const bodies = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth'].map((n) => `${n} call`);
    for (const body of bodies) {
      await BASE_ENV.DB.prepare(
        `INSERT INTO registration_notes
           (id, portal_id, registration_id, author, body, created_at)
         VALUES (?1, ?2, ?3, 'system', ?4, ?5)`,
      )
        .bind(crypto.randomUUID(), ids.portalId, ids.regId, body, sharedTimestamp)
        .run();
    }

    // Ordering on the random UUID returned these three in an arbitrary order, which loses
    // the one thing an append-only log exists to preserve.
    const notes = await listStaffNotes(BASE_ENV, ids.portalId, { registrationId: ids.regId });
    expect(notes.map((n) => n.body)).toEqual(bodies);

    const forEvent = await listEventStaffNotes(BASE_ENV, ids.portalId, ids.eventId);
    expect(forEvent.map((n) => n.body)).toEqual(bodies);
  });

  it('rejects an empty note rather than storing one that cannot be taken back', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await seedBooking(ids);

    const res = await manageRoutes.request(
      `/events/${ids.eventId}/registrations/${ids.regId}/notes`,
      { method: 'POST', headers: adminHeaders(ids), body: JSON.stringify({ body: '   ' }) },
      envFor(ids.portalId, ids.adminKey),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ status: 'missing_body' });
  });

  it("will not write a note against another portal's registration", async () => {
    const mine = freshIds();
    const theirs = freshIds();
    await seedEvent(mine);
    await seedEvent(theirs);
    await seedBooking(theirs);

    const res = await manageRoutes.request(
      `/events/${mine.eventId}/registrations/${theirs.regId}/notes`,
      { method: 'POST', headers: adminHeaders(mine), body: JSON.stringify({ body: 'peek' }) },
      envFor(mine.portalId, mine.adminKey),
    );
    expect(res.status).toBe(404);
    expect(
      await listStaffNotes(BASE_ENV, theirs.portalId, { registrationId: theirs.regId }),
    ).toEqual([]);
  });

  it('lists every note on the event, registration- and order-scoped alike', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await seedBooking(ids);
    const testEnv = envFor(ids.portalId, ids.adminKey);

    await manageRoutes.request(
      `/events/${ids.eventId}/registrations/${ids.regId}/notes`,
      { method: 'POST', headers: adminHeaders(ids), body: JSON.stringify({ body: 'about Sam' }) },
      testEnv,
    );
    await manageRoutes.request(
      `/events/${ids.eventId}/orders/${ids.orderId}/notes`,
      {
        method: 'POST',
        headers: adminHeaders(ids),
        body: JSON.stringify({ body: 'about the PO' }),
      },
      testEnv,
    );

    const res = await manageRoutes.request(
      `/events/${ids.eventId}/notes`,
      { method: 'GET', headers: adminHeaders(ids) },
      testEnv,
    );
    const notes = await res.json<Array<{ body: string }>>();
    expect(notes.map((n) => n.body).sort()).toEqual(['about Sam', 'about the PO']);
  });
});

// ---------------------------------------------------------------------------
// The manual-booking note
// ---------------------------------------------------------------------------

describe('the note typed on a manual booking', () => {
  it('is persisted against the order instead of being logged and lost', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    stubHubSpotSilent();

    const res = await manageRoutes.request(
      `/events/${ids.eventId}/registrations`,
      {
        method: 'POST',
        headers: adminHeaders(ids),
        body: JSON.stringify({
          mode: 'complimentary',
          ticketTypeId: ids.ticketTypeId,
          attendeeName: 'Pat Comp',
          attendeeEmail: 'comp@weld.test',
          staffActor: '55501',
          staffNote: 'Comped — approved by Ollie, replaces the cancelled June seat',
        }),
      },
      envFor(ids.portalId, ids.adminKey),
    );
    const body = await res.json<{ orderId: string }>();
    expect(res.status).toBe(200);

    const notes = await listStaffNotes(BASE_ENV, ids.portalId, { orderId: body.orderId });
    expect(notes).toEqual([
      expect.objectContaining({
        author: '55501',
        body: 'Comped — approved by Ollie, replaces the cancelled June seat',
        order_id: body.orderId,
      }),
    ]);

    // The outbox row rides in the same batch as the order (CLAUDE.md invariant).
    const outbox = await BASE_ENV.DB.prepare(
      `SELECT payload FROM outbox WHERE portal_id = ?1 AND topic = 'note.create'`,
    )
      .bind(ids.portalId)
      .all<{ payload: string }>();
    expect(outbox.results).toHaveLength(1);
    expect(JSON.parse(outbox.results[0].payload)).toEqual({ noteId: notes[0].id });
  });
});

// ---------------------------------------------------------------------------
// The invariant: never attendee-facing
// ---------------------------------------------------------------------------

describe('notes never reach the attendee', () => {
  it('appears in no attendee-facing output of a real booking', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    stubHubSpotSilent();
    const testEnv = envFor(ids.portalId, ids.adminKey);

    const SECRET = 'INTERNAL: chased twice for payment, do not send another reminder';

    const booking = await manageRoutes.request(
      `/events/${ids.eventId}/registrations`,
      {
        method: 'POST',
        headers: adminHeaders(ids),
        body: JSON.stringify({
          mode: 'paid',
          ticketTypeId: ids.ticketTypeId,
          attendeeName: 'Sam Tan',
          attendeeEmail: 'sam@weld.test',
          staffActor: '55501',
          staffNote: SECRET,
        }),
      },
      testEnv,
    );
    const bookingBody = await booking.text();
    const { orderId, registrationIds } = JSON.parse(bookingBody) as {
      orderId: string;
      registrationIds: string[];
    };

    // A second note, added after the fact against the registration itself.
    const REG_SECRET = 'INTERNAL: turned up drunk in March, watch this one';
    await manageRoutes.request(
      `/events/${ids.eventId}/registrations/${registrationIds[0]}/notes`,
      { method: 'POST', headers: adminHeaders(ids), body: JSON.stringify({ body: REG_SECRET }) },
      testEnv,
    );

    const secrets = [SECRET, REG_SECRET];
    const expectClean = (label: string, text: string) => {
      for (const secret of secrets) {
        expect(`${label}: ${text}`).not.toContain(secret);
      }
    };

    // 1. The response the booking flow hands back.
    expectClean('reserve response', bookingBody);

    // 2. The buyer's payment-status poll, which the checkout module renders verbatim.
    const poll = await publicApp.request(
      `/api/v1/orders/${orderId}`,
      { headers: { 'X-Portal-Id': ids.portalId } },
      testEnv,
    );
    expectClean('order poll', await poll.text());

    // 3. The public availability endpoint.
    const availability = await publicApp.request(
      `/api/v1/events/${ids.eventId}/availability`,
      { headers: { 'X-Portal-Id': ids.portalId } },
      testEnv,
    );
    expectClean('availability', await availability.text());

    // 4. Everything queued for HubSpot EXCEPT the note's own row — the invoice the buyer
    //    is sent, the deal, the Marketing Event registration, the contact write-back.
    const outbox = await BASE_ENV.DB.prepare(
      `SELECT topic, payload FROM outbox WHERE portal_id = ?1 AND topic != 'note.create'`,
    )
      .bind(ids.portalId)
      .all<{ topic: string; payload: string }>();
    expect(outbox.results.length).toBeGreaterThan(0);
    for (const row of outbox.results) {
      expectClean(`outbox ${row.topic}`, row.payload);
    }

    // 5. The order and registration rows a ticket is rendered from.
    const order = await BASE_ENV.DB.prepare('SELECT * FROM orders WHERE id = ?1')
      .bind(orderId)
      .first();
    expectClean('order row', JSON.stringify(order));
    const registration = await BASE_ENV.DB.prepare('SELECT * FROM registrations WHERE id = ?1')
      .bind(registrationIds[0])
      .first();
    expectClean('registration row', JSON.stringify(registration));
    const tickets = await BASE_ENV.DB.prepare('SELECT * FROM tickets WHERE order_id = ?1')
      .bind(orderId)
      .all();
    expectClean('tickets', JSON.stringify(tickets.results));

    // And the notes really were stored — otherwise this test passes for the wrong reason.
    const stored = await BASE_ENV.DB.prepare(
      'SELECT body FROM registration_notes WHERE portal_id = ?1 ORDER BY created_at ASC',
    )
      .bind(ids.portalId)
      .all<{ body: string }>();
    expect(stored.results.map((n) => n.body).sort()).toEqual([...secrets].sort());
  });
});

// ---------------------------------------------------------------------------
// HubSpot mirror
// ---------------------------------------------------------------------------

/** Captures HubSpot traffic and answers every call with a created-object id. */
function stubHubSpotNotes(opts?: { notesStatus?: number }) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });

      if (url.includes('/crm/v3/objects/notes') && opts?.notesStatus) {
        return new Response(JSON.stringify({ message: 'scope missing' }), {
          status: opts.notesStatus,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/crm/v4/associations/') && url.endsWith('/labels')) {
        return new Response(
          JSON.stringify({ results: [{ typeId: 202, label: null, category: 'HUBSPOT_DEFINED' }] }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/crm/v3/objects/contacts/search')) {
        return new Response(JSON.stringify({ results: [{ id: 'contact-9' }] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ id: 'note-1' }), {
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

async function enqueueNoteSync(ids: Ids, noteId: string): Promise<string> {
  const outboxId = crypto.randomUUID();
  await BASE_ENV.DB.prepare(
    `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
     VALUES (?1, ?2, 'note.create', ?3, ?4)`,
  )
    .bind(outboxId, ids.portalId, JSON.stringify({ noteId }), new Date().toISOString())
    .run();
  return outboxId;
}

async function addRegistrationNote(ids: Ids, body: string): Promise<string> {
  const res = await manageRoutes.request(
    `/events/${ids.eventId}/registrations/${ids.regId}/notes`,
    { method: 'POST', headers: adminHeaders(ids), body: JSON.stringify({ body }) },
    envFor(ids.portalId, ids.adminKey),
  );
  const created = await res.json<{ note: { id: string } }>();
  return created.note.id;
}

describe('note.create write-back', () => {
  it("mirrors the note as a native HubSpot Note on the attendee's contact", async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await seedBooking(ids);
    const noteId = await addRegistrationNote(ids, 'Bringing own helmet');
    const calls = stubHubSpotNotes();
    const outboxId = await enqueueNoteSync(ids, noteId);

    const { msg, state } = fakeMessage({ kind: 'note.create', portalId: ids.portalId, outboxId });
    await handleOutboxMessage(msg, BASE_ENV);
    expect(state.acked).toBe(true);

    // HubSpot's OWN note object and its own properties — not a custom property.
    const create = calls.find(
      (c) => c.method === 'POST' && c.url.endsWith('/crm/v3/objects/notes'),
    );
    const stored = await BASE_ENV.DB.prepare(
      'SELECT created_at FROM registration_notes WHERE id = ?1',
    )
      .bind(noteId)
      .first<{ created_at: string }>();
    expect((create?.body as { properties: Record<string, string> }).properties).toEqual({
      hs_note_body: 'Bringing own helmet',
      // The note's own creation time, so a retry writes an identical timeline entry.
      hs_timestamp: stored?.created_at,
    });

    // Associated to the attendee's contact, resolved from their email.
    expect(
      calls.some(
        (c) => c.method === 'PUT' && c.url.includes('/crm/v4/objects/notes/note-1/associations/'),
      ),
    ).toBe(true);

    const row = await BASE_ENV.DB.prepare(
      'SELECT hubspot_note_id FROM registration_notes WHERE id = ?1',
    )
      .bind(noteId)
      .first<{ hubspot_note_id: string | null }>();
    expect(row?.hubspot_note_id).toBe('note-1');
  });

  it('does not post the note twice when the row is re-driven', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await seedBooking(ids);
    const noteId = await addRegistrationNote(ids, 'Second run must be a no-op');
    const calls = stubHubSpotNotes();

    for (let i = 0; i < 2; i++) {
      const outboxId = await enqueueNoteSync(ids, noteId);
      const { msg } = fakeMessage({ kind: 'note.create', portalId: ids.portalId, outboxId });
      await handleOutboxMessage(msg, BASE_ENV);
    }

    const creates = calls.filter(
      (c) => c.method === 'POST' && c.url.endsWith('/crm/v3/objects/notes'),
    );
    expect(creates).toHaveLength(1);
  });

  it('finishes the association when the note was created but never attached', async () => {
    // The id is stored BEFORE the association so a retry cannot mint a second note. A
    // retry that saw the id and returned marked the row delivered with the note sitting
    // in HubSpot attached to nothing — the one place nobody reads it. Skip the creation,
    // not the rest.
    const ids = freshIds();
    await seedEvent(ids);
    await seedBooking(ids);
    const noteId = await addRegistrationNote(ids, 'Created, then the association 429d');
    await BASE_ENV.DB.prepare('UPDATE registration_notes SET hubspot_note_id = ?1 WHERE id = ?2')
      .bind('note-1', noteId)
      .run();

    const calls = stubHubSpotNotes();
    const outboxId = await enqueueNoteSync(ids, noteId);
    const { msg, state } = fakeMessage({ kind: 'note.create', portalId: ids.portalId, outboxId });
    await handleOutboxMessage(msg, BASE_ENV);

    expect(state.acked).toBe(true);
    // No second note.
    expect(
      calls.filter((c) => c.method === 'POST' && c.url.endsWith('/crm/v3/objects/notes')),
    ).toHaveLength(0);
    // But the association is retried, against the note that already exists.
    expect(
      calls.some(
        (c) => c.method === 'PUT' && c.url.includes('/crm/v4/objects/notes/note-1/associations/'),
      ),
    ).toBe(true);
  });

  it('keeps notes in the worker when the tenant turns the mirror off', async () => {
    const ids = freshIds();
    await seedEvent(ids, { noteSyncMode: 'off' });
    await seedBooking(ids);
    const noteId = await addRegistrationNote(ids, 'Stays in D1');
    const calls = stubHubSpotNotes();
    const outboxId = await enqueueNoteSync(ids, noteId);

    const { msg, state } = fakeMessage({ kind: 'note.create', portalId: ids.portalId, outboxId });
    await handleOutboxMessage(msg, BASE_ENV);

    expect(state.acked).toBe(true);
    expect(calls.filter((c) => c.url.includes('/crm/v3/objects/notes'))).toEqual([]);
    const row = await BASE_ENV.DB.prepare('SELECT status FROM outbox WHERE id = ?1')
      .bind(outboxId)
      .first<{ status: string }>();
    expect(row?.status).toBe('delivered');
  });

  it('keeps taking notes when the portal has not granted notes access', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await seedBooking(ids);
    const noteId = await addRegistrationNote(ids, 'Written before the scope was granted');
    stubHubSpotNotes({ notesStatus: 403 });
    const outboxId = await enqueueNoteSync(ids, noteId);

    const { msg, state } = fakeMessage({ kind: 'note.create', portalId: ids.portalId, outboxId });
    await handleOutboxMessage(msg, BASE_ENV);

    // Delivered, not dead: an ungranted optional scope must not leave a dead row per note.
    expect(state.acked).toBe(true);
    const row = await BASE_ENV.DB.prepare('SELECT status FROM outbox WHERE id = ?1')
      .bind(outboxId)
      .first<{ status: string }>();
    expect(row?.status).toBe('delivered');
    const note = await BASE_ENV.DB.prepare(
      'SELECT body, hubspot_note_id FROM registration_notes WHERE id = ?1',
    )
      .bind(noteId)
      .first<{ body: string; hubspot_note_id: string | null }>();
    expect(note).toMatchObject({
      body: 'Written before the scope was granted',
      hubspot_note_id: null,
    });
  });
});
