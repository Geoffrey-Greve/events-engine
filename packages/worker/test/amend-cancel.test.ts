import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { amendRegistration } from '../src/amend';
import { cancelRegistration } from '../src/cancel';
import { summariseEventRegistrations } from '../src/reporting';
import type { Env } from '../src/types';
import { seedTenant } from './support/fixtures';

/**
 * Phase 3 — amend and cancel one registration.
 *
 * The done-when has four parts and each has a section below:
 *   1. a single registration can be AMENDED (identity, the 1.2 contact fields, the 2.3
 *      answers) with the ticket and the HubSpot side left consistent;
 *   2. a single registration can be CANCELLED without taking its booking with it;
 *   3. CAPACITY behaves under a concurrent reserve — the freed seat is sold exactly once,
 *      against a REAL EventCapacity Durable Object (never mocked: the single-threaded
 *      gating is the thing being tested);
 *   4. the WAITLIST opens a decision and offers nothing by itself.
 */

const E = env as unknown as Env;

let counter = 0;
// Registers the portal as it mints it: the suite runs against the real migrations, so
// every portal-scoped row's foreign key into `tenants` is enforced as it is in production.
async function freshIds() {
  const n = `${Date.now()}-${counter++}`;
  const portalId = `ac-${n}`;
  await seedTenant(E.DB, portalId);
  return {
    portalId,
    eventId: `evt-ac-${n}`,
    hsEvent: `hs-ac-${n}`,
    orderId: `ord-ac-${n}`,
    reservationId: `resv-ac-${n}`,
    ticketTypeId: `tt-ac-${n}`,
  };
}

type Ids = Awaited<ReturnType<typeof freshIds>>;

// ---------------------------------------------------------------------------
// Fixture: one event, one booking, N seats
// ---------------------------------------------------------------------------

interface SeatSpec {
  email: string;
  name: string;
  phone?: string | null;
  suburb?: string | null;
  state?: string | null;
  /** Issue a ticket for this seat (a committed booking has one). */
  ticket?: boolean;
}

async function seedBooking(args: {
  ids: Ids;
  seats: SeatSpec[];
  /** 'paid' commits the seats in the DO; 'pending' leaves them as a live hold. */
  orderStatus: 'paid' | 'pending';
  totalCents: number;
  capacity?: number;
  /** Days from now the event starts — drives the refund policy's cutoff. */
  startsInDays?: number;
  provider?: string | null;
}): Promise<string[]> {
  const { ids, seats, orderStatus, totalCents } = args;
  const now = new Date().toISOString();
  const startsAt = new Date(
    Date.now() + (args.startsInDays ?? 60) * 24 * 60 * 60 * 1000,
  ).toISOString();

  await E.DB.prepare(
    `INSERT INTO events (id, portal_id, hubspot_event_id, title, starts_at, ends_at, capacity,
       provider, hubspot_owner_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'Welding Intensive', ?4, ?4, ?5, ?6, 'owner-1', ?7, ?7)`,
  )
    .bind(
      ids.eventId,
      ids.portalId,
      ids.hsEvent,
      startsAt,
      args.capacity ?? seats.length,
      args.provider ?? null,
      now,
    )
    .run();
  await E.DB.prepare(
    `INSERT INTO ticket_types (id, portal_id, event_id, name, price_cents, capacity, created_at)
     VALUES (?1, ?2, ?3, 'Standard', ?4, ?5, ?6)`,
  )
    .bind(
      ids.ticketTypeId,
      ids.portalId,
      ids.eventId,
      Math.round(totalCents / seats.length),
      args.capacity ?? seats.length,
      now,
    )
    .run();
  await E.DB.prepare(
    `INSERT INTO reservations
       (id, portal_id, event_id, idempotency_key, status, expires_at, created_at)
     VALUES (?1, ?2, ?3, ?1, ?4, ?5, ?6)`,
  )
    .bind(
      ids.reservationId,
      ids.portalId,
      ids.eventId,
      orderStatus === 'paid' ? 'confirmed' : 'pending',
      new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      now,
    )
    .run();
  await E.DB.prepare(
    `INSERT INTO reservation_items (id, portal_id, reservation_id, ticket_type_id, quantity, unit_cents)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(
      `ri-${ids.reservationId}`,
      ids.portalId,
      ids.reservationId,
      ids.ticketTypeId,
      seats.length,
      Math.round(totalCents / seats.length),
    )
    .run();
  await E.DB.prepare(
    `INSERT INTO orders (id, portal_id, event_id, reservation_id, hubspot_invoice_id, status,
       buyer_email, buyer_name, total_cents, refunded_cents, currency, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'buyer@weld.test', 'Booking Buyer', ?7, 0, 'AUD', ?8, ?8)`,
  )
    .bind(
      ids.orderId,
      ids.portalId,
      ids.eventId,
      ids.reservationId,
      `inv-${ids.orderId}`,
      orderStatus,
      totalCents,
      now,
    )
    .run();

  const regIds: string[] = [];
  for (const [index, seat] of seats.entries()) {
    const regId = `${ids.orderId}-reg-${index}`;
    regIds.push(regId);
    const ticketId = seat.ticket === false ? null : `${regId}-tk`;
    await E.DB.prepare(
      `INSERT INTO registrations (id, portal_id, order_id, event_id, ticket_type_id,
         hubspot_contact_id, attendee_email, attendee_name, attendee_phone, attendee_suburb,
         attendee_state, ticket_id, marketing_event_state_synced, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1, ?13, ?13)`,
    )
      .bind(
        regId,
        ids.portalId,
        ids.orderId,
        ids.eventId,
        ids.ticketTypeId,
        `contact-${index}`,
        seat.email,
        seat.name,
        seat.phone ?? null,
        seat.suburb ?? null,
        seat.state ?? null,
        ticketId,
        now,
      )
      .run();
    if (ticketId) {
      await E.DB.prepare(
        `INSERT INTO tickets (id, portal_id, registration_id, order_id, event_id, ticket_type_id,
           status, qr_code, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'issued', ?7, ?8)`,
      )
        .bind(
          ticketId,
          ids.portalId,
          regId,
          ids.orderId,
          ids.eventId,
          ids.ticketTypeId,
          `qr-${regId}`,
          now,
        )
        .run();
    }
  }
  return regIds;
}

// ---------------------------------------------------------------------------
// DO helpers — the real Durable Object, as in EventCapacity.test.ts
// ---------------------------------------------------------------------------

function doStub(idName: string): DurableObjectStub {
  return E.EVENT_CAPACITY.get(E.EVENT_CAPACITY.idFromName(idName));
}

async function doCall(
  idName: string,
  path: string,
  body: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await doStub(idName).fetch(`https://do.local${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as Record<string, unknown>;
}

async function outboxTopics(registrationId: string): Promise<string[]> {
  const rows = await E.DB.prepare(
    `SELECT topic FROM outbox WHERE json_extract(payload, '$.registrationId') = ?1 ORDER BY topic`,
  )
    .bind(registrationId)
    .all<{ topic: string }>();
  return rows.results.map((r) => r.topic);
}

// ---------------------------------------------------------------------------
// 1. Amend
// ---------------------------------------------------------------------------

describe('PATCH — amending one registration', () => {
  it('corrects an email: reissues the ticket and moves the Marketing Event registration', async () => {
    const ids = await freshIds();
    const [regId] = await seedBooking({
      ids,
      seats: [{ email: 'jhon@weld.test', name: 'John Smith' }],
      orderStatus: 'paid',
      totalCents: 45000,
    });

    const result = await amendRegistration(E, {
      portalId: ids.portalId,
      registrationId: regId,
      email: 'john@weld.test',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toEqual(['email']);
    expect(result.ticketReissued).toBe(true);

    const reg = await E.DB.prepare(
      'SELECT attendee_email, attendee_name, hubspot_contact_id, ticket_id, marketing_event_state_synced FROM registrations WHERE id = ?1',
    )
      .bind(regId)
      .first<{
        attendee_email: string;
        attendee_name: string;
        hubspot_contact_id: string | null;
        ticket_id: string;
        marketing_event_state_synced: number;
      }>();
    expect(reg?.attendee_email).toBe('john@weld.test');
    expect(reg?.attendee_name).toBe('John Smith'); // untouched
    // Cleared so contact.upsert resolves the corrected address rather than writing onto
    // whoever the old one belonged to.
    expect(reg?.hubspot_contact_id).toBeNull();
    expect(reg?.marketing_event_state_synced).toBe(0);
    expect(reg?.ticket_id).toBe(result.ticketId);

    // Old QR invalidated, new one minted.
    const old = await E.DB.prepare('SELECT status FROM tickets WHERE id = ?1')
      .bind(`${regId}-tk`)
      .first<{ status: string }>();
    expect(old?.status).toBe('voided');
    const fresh = await E.DB.prepare('SELECT status, qr_code FROM tickets WHERE id = ?1')
      .bind(result.ticketId)
      .first<{ status: string; qr_code: string }>();
    expect(fresh?.status).toBe('issued');
    expect(fresh?.qr_code).not.toBe(`qr-${regId}`);

    // HubSpot: the participation record moves off the old contact and onto the new one.
    const topics = await outboxTopics(regId);
    expect(topics).toContain('contact.upsert');
    expect(topics).toContain('me.cancel');
    expect(topics).toContain('me.register');

    const cancel = await E.DB.prepare(
      `SELECT payload FROM outbox WHERE topic = 'me.cancel' AND json_extract(payload, '$.registrationId') = ?1`,
    )
      .bind(regId)
      .first<{ payload: string }>();
    expect(JSON.parse(cancel?.payload ?? '{}').attendeeEmail).toBe('jhon@weld.test');
    const register = await E.DB.prepare(
      `SELECT payload FROM outbox WHERE topic = 'me.register' AND json_extract(payload, '$.registrationId') = ?1`,
    )
      .bind(regId)
      .first<{ payload: string }>();
    expect(JSON.parse(register?.payload ?? '{}').attendeeEmail).toBe('john@weld.test');
  });

  it('leaves the ticket alone when only the contact fields change', async () => {
    const ids = await freshIds();
    const [regId] = await seedBooking({
      ids,
      seats: [{ email: 'sam@weld.test', name: 'Sam Reed', phone: '0400 000 000' }],
      orderStatus: 'paid',
      totalCents: 45000,
    });

    const result = await amendRegistration(E, {
      portalId: ids.portalId,
      registrationId: regId,
      contact: { phone: '0411 111 111', suburb: 'Norwood' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toEqual(['phone', 'suburb']);
    // The QR in their inbox still works: nothing about a phone number makes a code wrong.
    expect(result.ticketReissued).toBe(false);
    expect(result.ticketId).toBe(`${regId}-tk`);
    const ticket = await E.DB.prepare('SELECT status FROM tickets WHERE id = ?1')
      .bind(`${regId}-tk`)
      .first<{ status: string }>();
    expect(ticket?.status).toBe('issued');

    const reg = await E.DB.prepare(
      'SELECT attendee_phone, attendee_suburb, attendee_state FROM registrations WHERE id = ?1',
    )
      .bind(regId)
      .first<{
        attendee_phone: string | null;
        attendee_suburb: string | null;
        attendee_state: string | null;
      }>();
    expect(reg).toEqual({
      attendee_phone: '0411 111 111',
      attendee_suburb: 'Norwood',
      attendee_state: null,
    });

    // The 1.2 write-back carries ONLY what this request touched, and no Marketing Event
    // write is raised: the participation record did not move.
    const topics = await outboxTopics(regId);
    expect(topics).toEqual(['contact.sync_attendee_details']);
    const sync = await E.DB.prepare(
      `SELECT payload FROM outbox WHERE topic = 'contact.sync_attendee_details' AND json_extract(payload, '$.registrationId') = ?1`,
    )
      .bind(regId)
      .first<{ payload: string }>();
    expect(JSON.parse(sync?.payload ?? '{}').details).toEqual({
      phone: '0411 111 111',
      suburb: 'Norwood',
      state: null,
    });
  });

  it('amends a 2.3 answer in place, and an empty value removes it', async () => {
    const ids = await freshIds();
    const [regId] = await seedBooking({
      ids,
      seats: [{ email: 'kim@weld.test', name: 'Kim Tran' }],
      orderStatus: 'paid',
      totalCents: 45000,
    });
    await E.DB.prepare(
      `INSERT INTO registration_questions
         (id, portal_id, event_id, key, label, field_type, required, scope, hs_property, prefill, sort_order, created_at, updated_at)
       VALUES (?1, ?2, NULL, 'dietary_requirements', 'Dietary requirements', 'textarea', 0,
               'attendee', 'dietary_requirements', 1, 0, ?3, ?3)`,
    )
      .bind(`q-${ids.portalId}`, ids.portalId, new Date().toISOString())
      .run();

    const first = await amendRegistration(E, {
      portalId: ids.portalId,
      registrationId: regId,
      answers: { dietary_requirements: 'Coeliac' },
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.changed).toEqual(['answers']);

    // A correction REPLACES the value rather than adding a second row an attendee list
    // would have to choose between.
    await amendRegistration(E, {
      portalId: ids.portalId,
      registrationId: regId,
      answers: { dietary_requirements: 'Coeliac, no nuts' },
    });
    const rows = await E.DB.prepare(
      'SELECT value_text FROM registration_answers WHERE registration_id = ?1',
    )
      .bind(regId)
      .all<{ value_text: string }>();
    expect(rows.results.map((r) => r.value_text)).toEqual(['Coeliac, no nuts']);

    // The write-back claims authority (selfDeclared) — a staff correction of one named
    // person's answer is a statement about them, not a by-product of a bulk booking.
    const sync = await E.DB.prepare(
      `SELECT payload FROM outbox WHERE topic = 'contact.sync_answers'
         AND json_extract(payload, '$.registrationId') = ?1 ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(regId)
      .first<{ payload: string }>();
    expect(JSON.parse(sync?.payload ?? '{}').selfDeclared).toBe(true);

    // Empty clears it — "she told us the allergy was a mistake".
    await amendRegistration(E, {
      portalId: ids.portalId,
      registrationId: regId,
      answers: { dietary_requirements: '' },
    });
    const after = await E.DB.prepare(
      'SELECT COUNT(*) AS c FROM registration_answers WHERE registration_id = ?1',
    )
      .bind(regId)
      .first<{ c: number }>();
    expect(after?.c).toBe(0);
  });

  it('refuses an unknown question key rather than silently recording nothing', async () => {
    const ids = await freshIds();
    const [regId] = await seedBooking({
      ids,
      seats: [{ email: 'lee@weld.test', name: 'Lee Park' }],
      orderStatus: 'paid',
      totalCents: 45000,
    });
    const result = await amendRegistration(E, {
      portalId: ids.portalId,
      registrationId: regId,
      answers: { shirt_size: 'L' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('unknown_question');
  });

  it('refuses an email that already holds a live seat at the event', async () => {
    const ids = await freshIds();
    const [first, second] = await seedBooking({
      ids,
      seats: [
        { email: 'a@weld.test', name: 'Attendee A' },
        { email: 'b@weld.test', name: 'Attendee B' },
      ],
      orderStatus: 'paid',
      totalCents: 90000,
    });
    const result = await amendRegistration(E, {
      portalId: ids.portalId,
      registrationId: second,
      email: 'a@weld.test',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('duplicate_attendee');
    const reg = await E.DB.prepare('SELECT attendee_email FROM registrations WHERE id = ?1')
      .bind(second)
      .first<{ attendee_email: string }>();
    expect(reg?.attendee_email).toBe('b@weld.test');
    expect(first).toBeTruthy();
  });

  it('will not amend a cancelled seat', async () => {
    const ids = await freshIds();
    const [regId] = await seedBooking({
      ids,
      seats: [{ email: 'gone@weld.test', name: 'Gone Away' }],
      orderStatus: 'paid',
      totalCents: 45000,
    });
    await cancelRegistration(E, { portalId: ids.portalId, registrationId: regId });

    const result = await amendRegistration(E, {
      portalId: ids.portalId,
      registrationId: regId,
      name: 'Somebody Else',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('registration_cancelled');
  });

  it('retires the old webinar registration through the outbox, carrying the id it overwrites', async () => {
    // Called inline this could only ever be attempted once: the batch overwrites the
    // stored provider registration id, so a transient provider failure was unrecoverable
    // and the previous attendee's personal join URL stayed live indefinitely — a way into
    // the webinar, and a second attendance record for someone no longer on the seat.
    const ids = await freshIds();
    const [regId] = await seedBooking({
      ids,
      seats: [{ email: 'before@weld.test', name: 'Before Change' }],
      orderStatus: 'paid',
      totalCents: 20000,
      provider: 'teams',
    });
    await E.DB.prepare('UPDATE events SET teams_webinar_id = ?1 WHERE id = ?2')
      .bind('webinar-1', ids.eventId)
      .run();
    await E.DB.prepare('UPDATE registrations SET teams_registration_id = ?1 WHERE id = ?2')
      .bind('old-provider-reg', regId)
      .run();

    const result = await amendRegistration(E, {
      portalId: ids.portalId,
      registrationId: regId,
      email: 'after@weld.test',
    });
    expect(result.ok).toBe(true);

    const row = await E.DB.prepare(
      `SELECT payload FROM outbox
        WHERE portal_id = ?1 AND topic = 'webinar.cancel_registration'`,
    )
      .bind(ids.portalId)
      .first<{ payload: string }>();
    expect(row).toBeTruthy();
    expect(JSON.parse(row?.payload ?? '{}')).toMatchObject({
      registrationId: regId,
      webinarId: 'webinar-1',
      // The OLD id — the row exists precisely because D1 no longer holds it.
      providerRegistrationId: 'old-provider-reg',
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Cancel
// ---------------------------------------------------------------------------

describe('DELETE — cancelling one registration', () => {
  it('cancels the seat, not the booking, when colleagues remain', async () => {
    const ids = await freshIds();
    const regIds = await seedBooking({
      ids,
      seats: [
        { email: 'one@weld.test', name: 'One' },
        { email: 'two@weld.test', name: 'Two' },
        { email: 'three@weld.test', name: 'Three' },
        { email: 'four@weld.test', name: 'Four' },
      ],
      orderStatus: 'paid',
      totalCents: 40000,
      capacity: 10,
      startsInDays: 90, // well inside the built-in 30-day full-refund cutoff
    });
    // Commit the booking's four seats in the DO, as payment confirm would.
    const idName = `${ids.portalId}:${ids.hsEvent}`;
    await doCall(idName, '/sync', {
      eventCapacity: 10,
      perType: { [ids.ticketTypeId]: { inventory: 10 } },
    });
    await doCall(idName, '/reserve', {
      holdId: ids.reservationId,
      items: [{ ticketTypeId: ids.ticketTypeId, quantity: 4 }],
    });
    await doCall(idName, '/confirm', { holdId: ids.reservationId });

    const result = await cancelRegistration(E, {
      portalId: ids.portalId,
      registrationId: regIds[1],
      reason: 'broke her wrist',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.remainingOnOrder).toBe(3);

    // The ORDER is untouched — three colleagues are still coming.
    const order = await E.DB.prepare('SELECT status, refunded_cents FROM orders WHERE id = ?1')
      .bind(ids.orderId)
      .first<{ status: string; refunded_cents: number }>();
    expect(order?.status).toBe('paid');
    // A full refund of this seat's share of a $400 booking for four.
    expect(result.refund).toMatchObject({ kind: 'full', amountCents: 10000 });
    expect(order?.refunded_cents).toBe(10000);

    // The seat is recorded as gone, and its ticket can no longer be scanned.
    const reg = await E.DB.prepare(
      'SELECT cancelled_at, cancellation_reason FROM registrations WHERE id = ?1',
    )
      .bind(regIds[1])
      .first<{ cancelled_at: string | null; cancellation_reason: string | null }>();
    expect(reg?.cancelled_at).toBeTruthy();
    expect(reg?.cancellation_reason).toBe('broke her wrist');
    const ticket = await E.DB.prepare('SELECT status FROM tickets WHERE registration_id = ?1')
      .bind(regIds[1])
      .first<{ status: string }>();
    expect(ticket?.status).toBe('cancelled');

    // The colleagues' tickets are untouched — the failure this endpoint exists to avoid.
    for (const other of [regIds[0], regIds[2], regIds[3]]) {
      const t = await E.DB.prepare('SELECT status FROM tickets WHERE registration_id = ?1')
        .bind(other)
        .first<{ status: string }>();
      expect(t?.status).toBe('issued');
      const r = await E.DB.prepare('SELECT cancelled_at FROM registrations WHERE id = ?1')
        .bind(other)
        .first<{ cancelled_at: string | null }>();
      expect(r?.cancelled_at).toBeNull();
    }

    // Exactly ONE Marketing Event participation is cancelled.
    const cancels = await E.DB.prepare(
      `SELECT payload FROM outbox WHERE topic = 'me.cancel' AND portal_id = ?1`,
    )
      .bind(ids.portalId)
      .all<{ payload: string }>();
    expect(cancels.results.map((r) => JSON.parse(r.payload).attendeeEmail)).toEqual([
      'two@weld.test',
    ]);

    // The invoice is refunded PARTIALLY, never voided: voiding it over one seat of four
    // would wipe three colleagues' payment record in HubSpot and, via Data Sync, in Xero.
    const refund = await E.DB.prepare(
      `SELECT payload FROM outbox WHERE topic = 'payment.refund' AND portal_id = ?1`,
    )
      .bind(ids.portalId)
      .first<{ payload: string }>();
    expect(JSON.parse(refund?.payload ?? '{}')).toMatchObject({
      kind: 'partial',
      amountCents: 10000,
    });

    // And the seat really went back to the DO.
    const availability = await doCall(idName, '/availability');
    expect(availability.confirmed).toBe(3);
    expect(availability.available).toBe(7);
  });

  it('closes the booking when the last live seat goes, and voids the invoice', async () => {
    const ids = await freshIds();
    const [regId] = await seedBooking({
      ids,
      seats: [{ email: 'solo@weld.test', name: 'Solo Booker' }],
      orderStatus: 'paid',
      totalCents: 45000,
      startsInDays: 90,
    });

    const result = await cancelRegistration(E, {
      portalId: ids.portalId,
      registrationId: regId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.remainingOnOrder).toBe(0);
    expect(result.orderStatus).toBe('refunded');
    expect(result.refund).toMatchObject({ kind: 'full', amountCents: 45000 });

    const order = await E.DB.prepare('SELECT status, refunded_cents FROM orders WHERE id = ?1')
      .bind(ids.orderId)
      .first<{ status: string; refunded_cents: number }>();
    expect(order).toEqual({ status: 'refunded', refunded_cents: 45000 });
    const refund = await E.DB.prepare(
      `SELECT payload FROM outbox WHERE topic = 'payment.refund' AND portal_id = ?1`,
    )
      .bind(ids.portalId)
      .first<{ payload: string }>();
    expect(JSON.parse(refund?.payload ?? '{}').kind).toBe('full');
  });

  it('follows the event refund policy, and invents nothing when it grants nothing', async () => {
    const ids = await freshIds();
    const [regId] = await seedBooking({
      ids,
      seats: [{ email: 'late@weld.test', name: 'Late Cancel' }],
      orderStatus: 'paid',
      totalCents: 45000,
      startsInDays: 3, // inside the cutoff
    });
    // A policy with no partial: after the cutoff, nothing comes back.
    await E.DB.prepare(
      `INSERT INTO refund_policies (id, portal_id, name, is_default, category,
         full_refund_cutoff_days, partial_refund_percent, allow_transfer, created_at)
       VALUES (?1, ?2, 'Strict', 1, NULL, 30, NULL, 1, ?3)`,
    )
      .bind(`pol-${ids.portalId}`, ids.portalId, new Date().toISOString())
      .run();

    const result = await cancelRegistration(E, {
      portalId: ids.portalId,
      registrationId: regId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.refund).toMatchObject({
      kind: 'none',
      amountCents: 0,
      policyId: `pol-${ids.portalId}`,
    });
    // The seat still goes; only the money stays.
    expect(result.orderStatus).toBe('cancelled');
    const refunds = await E.DB.prepare(
      `SELECT COUNT(*) AS c FROM outbox WHERE topic = 'payment.refund' AND portal_id = ?1`,
    )
      .bind(ids.portalId)
      .first<{ c: number }>();
    expect(refunds?.c).toBe(0);
  });

  it('is refused the second time, so a seat is never given back twice', async () => {
    const ids = await freshIds();
    const [regId] = await seedBooking({
      ids,
      seats: [{ email: 'twice@weld.test', name: 'Twice Cancelled' }],
      orderStatus: 'paid',
      totalCents: 45000,
      startsInDays: 90,
    });
    const first = await cancelRegistration(E, { portalId: ids.portalId, registrationId: regId });
    expect(first.ok).toBe(true);
    const second = await cancelRegistration(E, { portalId: ids.portalId, registrationId: regId });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe('already_cancelled');
    const order = await E.DB.prepare('SELECT refunded_cents FROM orders WHERE id = ?1')
      .bind(ids.orderId)
      .first<{ refunded_cents: number }>();
    expect(order?.refunded_cents).toBe(45000); // not 90000
  });

  it('lets exactly one of two simultaneous cancels own the seat', async () => {
    // Sequentially the second cancel is refused by the read at the top. Simultaneously,
    // both used to get past that read, both asked the Durable Object for a seat back, and
    // both wrote a refund row — the loser only discovering afterwards that it had not
    // flipped `cancelled_at`. That freed a colleague's seat and refunded the money twice.
    const ids = await freshIds();
    const [regId] = await seedBooking({
      ids,
      seats: [{ email: 'race@weld.test', name: 'Race Condition' }],
      orderStatus: 'paid',
      totalCents: 45000,
      startsInDays: 90,
    });

    const [first, second] = await Promise.all([
      cancelRegistration(E, { portalId: ids.portalId, registrationId: regId }),
      cancelRegistration(E, { portalId: ids.portalId, registrationId: regId }),
    ]);

    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    const loser = first.ok ? second : first;
    expect(loser.ok).toBe(false);
    if (!loser.ok) expect(loser.error).toBe('already_cancelled');

    // One refund, once: both the order's record of it and the outbox row that issues it.
    const order = await E.DB.prepare('SELECT refunded_cents FROM orders WHERE id = ?1')
      .bind(ids.orderId)
      .first<{ refunded_cents: number }>();
    expect(order?.refunded_cents).toBe(45000);
    const refunds = await E.DB.prepare(
      `SELECT COUNT(*) AS c FROM outbox WHERE portal_id = ?1 AND topic = 'payment.refund'`,
    )
      .bind(ids.portalId)
      .first<{ c: number }>();
    expect(refunds?.c).toBe(1);
    // And the Marketing Event is cancelled once, not twice.
    const meCancels = await E.DB.prepare(
      `SELECT COUNT(*) AS c FROM outbox WHERE portal_id = ?1 AND topic = 'me.cancel'`,
    )
      .bind(ids.portalId)
      .first<{ c: number }>();
    expect(meCancels?.c).toBe(1);
  });

  it('cancels nothing at all when the write fails, and leaves the seat cancellable', async () => {
    // The cancellation and the rows that carry it out — the refund, the ticket, the
    // Marketing Event — are one batch or none of it. Flipping `cancelled_at` ahead of them
    // to win the race bought a seat that reads cancelled forever with no refund and a live
    // ticket, which no retry could reach because a retry read it as already cancelled.
    const ids = await freshIds();
    const [regId] = await seedBooking({
      ids,
      seats: [{ email: 'atomic@weld.test', name: 'All Or Nothing' }],
      orderStatus: 'paid',
      totalCents: 45000,
      startsInDays: 90,
    });

    const brokenEnv = {
      ...E,
      DB: {
        prepare: (sql: string) => E.DB.prepare(sql),
        batch: async () => {
          throw new Error('D1 unavailable');
        },
      },
    } as unknown as Env;

    await expect(
      cancelRegistration(brokenEnv, { portalId: ids.portalId, registrationId: regId }),
    ).rejects.toThrow();

    const after = await E.DB.prepare(
      'SELECT cancelled_at, cancellation_claim FROM registrations WHERE id = ?1',
    )
      .bind(regId)
      .first<{ cancelled_at: string | null; cancellation_claim: string | null }>();
    expect(after?.cancelled_at).toBeNull();
    // And the lease is handed straight back, so the retry does not wait it out.
    expect(after?.cancellation_claim).toBeNull();

    const ticket = await E.DB.prepare('SELECT status FROM tickets WHERE registration_id = ?1')
      .bind(regId)
      .first<{ status: string }>();
    expect(ticket?.status).toBe('issued');
    const outbox = await E.DB.prepare(
      `SELECT COUNT(*) AS c FROM outbox WHERE portal_id = ?1 AND topic IN ('me.cancel', 'payment.refund')`,
    )
      .bind(ids.portalId)
      .first<{ c: number }>();
    expect(outbox?.c).toBe(0);

    // The retry is what proves it: the seat is still there to cancel, in full.
    const retry = await cancelRegistration(E, { portalId: ids.portalId, registrationId: regId });
    expect(retry.ok).toBe(true);
    const order = await E.DB.prepare('SELECT refunded_cents FROM orders WHERE id = ?1')
      .bind(ids.orderId)
      .first<{ refunded_cents: number }>();
    expect(order?.refunded_cents).toBe(45000);
  });

  it('shrinks a live HOLD rather than dropping it, when the booking is awaiting payment', async () => {
    const ids = await freshIds();
    const regIds = await seedBooking({
      ids,
      seats: [
        { email: 'hold1@weld.test', name: 'Hold One', ticket: false },
        { email: 'hold2@weld.test', name: 'Hold Two', ticket: false },
      ],
      orderStatus: 'pending',
      totalCents: 20000,
      capacity: 2,
    });
    const idName = `${ids.portalId}:${ids.hsEvent}`;
    await doCall(idName, '/sync', {
      eventCapacity: 2,
      perType: { [ids.ticketTypeId]: { inventory: 2 } },
    });
    await doCall(idName, '/reserve', {
      holdId: ids.reservationId,
      items: [{ ticketTypeId: ids.ticketTypeId, quantity: 2 }],
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect((await doCall(idName, '/availability')).available).toBe(0);

    // Money that was never collected is not refunded: the invoice is still outstanding.
    const result = await cancelRegistration(E, {
      portalId: ids.portalId,
      registrationId: regIds[0],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.refund.amountCents).toBe(0);

    // ONE seat came back; the colleague's hold survives. `release` would have dropped both.
    const availability = await doCall(idName, '/availability');
    expect(availability.available).toBe(1);
    expect(availability.held).toBe(1);
    const order = await E.DB.prepare('SELECT status FROM orders WHERE id = ?1')
      .bind(ids.orderId)
      .first<{ status: string }>();
    expect(order?.status).toBe('pending');
  });

  it('does not un-attend someone who walked in the door', async () => {
    const ids = await freshIds();
    const [regId] = await seedBooking({
      ids,
      seats: [{ email: 'came@weld.test', name: 'Came Anyway' }],
      orderStatus: 'paid',
      totalCents: 45000,
      startsInDays: 90,
    });
    await E.DB.prepare(
      `UPDATE tickets SET status = 'checked_in', checked_in_at = ?1 WHERE registration_id = ?2`,
    )
      .bind(new Date().toISOString(), regId)
      .run();

    await cancelRegistration(E, { portalId: ids.portalId, registrationId: regId });

    const ticket = await E.DB.prepare('SELECT status FROM tickets WHERE registration_id = ?1')
      .bind(regId)
      .first<{ status: string }>();
    expect(ticket?.status).toBe('checked_in');

    // Both axes stay true at once: the booking is cancelled AND the person attended.
    const summary = await summariseEventRegistrations(E, ids.portalId, ids.eventId);
    expect(summary.cancelled).toBe(1);
    expect(summary.attended).toBe(1);
    expect(summary.registered).toBe(1);
  });

  it('takes the seat out of every count the engine reports', async () => {
    const ids = await freshIds();
    const regIds = await seedBooking({
      ids,
      seats: [
        { email: 'count1@weld.test', name: 'Count One' },
        { email: 'count2@weld.test', name: 'Count Two' },
      ],
      orderStatus: 'paid',
      totalCents: 20000,
      capacity: 5,
      startsInDays: 90,
    });
    const before = await summariseEventRegistrations(E, ids.portalId, ids.eventId);
    expect(before).toMatchObject({ total: 2, confirmed: 2, cancelled: 0, seatsHeld: 2 });

    await cancelRegistration(E, { portalId: ids.portalId, registrationId: regIds[0] });

    const after = await summariseEventRegistrations(E, ids.portalId, ids.eventId);
    // The booking-state partition still adds up, and the seat is no longer held — which is
    // what stops the manage card, the App Home card and the door scanner from disagreeing.
    expect(after).toMatchObject({ total: 2, confirmed: 1, cancelled: 1, seatsHeld: 1 });
    expect(after.confirmed + after.awaitingPayment + after.needsReview + after.cancelled).toBe(
      after.total,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Capacity under a concurrent reserve
// ---------------------------------------------------------------------------

describe('the freed seat, under concurrent reserves', () => {
  it('is sold exactly once when eight buyers race for it', async () => {
    const ids = await freshIds();
    const regIds = await seedBooking({
      ids,
      seats: [
        { email: 'r1@weld.test', name: 'Racer One' },
        { email: 'r2@weld.test', name: 'Racer Two' },
        { email: 'r3@weld.test', name: 'Racer Three' },
      ],
      orderStatus: 'paid',
      totalCents: 30000,
      capacity: 3,
      startsInDays: 90,
    });
    const idName = `${ids.portalId}:${ids.hsEvent}`;
    await doCall(idName, '/sync', {
      eventCapacity: 3,
      perType: { [ids.ticketTypeId]: { inventory: 3 } },
    });
    await doCall(idName, '/reserve', {
      holdId: ids.reservationId,
      items: [{ ticketTypeId: ids.ticketTypeId, quantity: 3 }],
    });
    await doCall(idName, '/confirm', { holdId: ids.reservationId });
    // Sold out.
    expect((await doCall(idName, '/availability')).available).toBe(0);

    await cancelRegistration(E, { portalId: ids.portalId, registrationId: regIds[2] });

    // Eight buyers hit /reserve at once for the single freed seat. The DO is
    // single-threaded per event, so exactly one of them can win — that is the
    // never-oversell invariant, and this is the shape of the traffic that breaks a
    // check-then-write implementation.
    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        doCall(idName, '/reserve', {
          holdId: `race-${ids.eventId}-${i}`,
          items: [{ ticketTypeId: ids.ticketTypeId, quantity: 1 }],
        }),
      ),
    );
    const won = attempts.filter((a) => a.ok === true);
    const lost = attempts.filter((a) => a.full === true);
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(7);

    const availability = await doCall(idName, '/availability');
    expect(availability.available).toBe(0);
    expect(availability.confirmed).toBe(2);
    expect(availability.held).toBe(1);
  });

  it('survives a rebuild: the cancelled seat is not re-taken from D1', async () => {
    const ids = await freshIds();
    const regIds = await seedBooking({
      ids,
      seats: [
        { email: 'rb1@weld.test', name: 'Rebuild One' },
        { email: 'rb2@weld.test', name: 'Rebuild Two' },
      ],
      orderStatus: 'paid',
      totalCents: 20000,
      capacity: 2,
      startsInDays: 90,
    });
    await E.DB.prepare('INSERT OR IGNORE INTO tenants (portal_id, display_name) VALUES (?1, ?2)')
      .bind(ids.portalId, 'Rebuild Tenant')
      .run();

    const idName = `${ids.portalId}:${ids.hsEvent}`;
    await cancelRegistration(E, { portalId: ids.portalId, registrationId: regIds[0] });

    // Discard the in-memory counters and rebuild from D1 — the admin repair path, and what
    // a cold start does by itself. The cancelled seat must not come back as sold.
    const rebuilt = await doCall(idName, '/rebuild', { idName });
    expect(rebuilt.ok).toBe(true);
    expect(rebuilt.confirmed).toBe(1);
    expect(rebuilt.available).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Waitlist — a decision, never an offer
// ---------------------------------------------------------------------------

describe('the waitlist when a seat is cancelled', () => {
  it('opens a decision for the event owner and offers the seat to nobody', async () => {
    const ids = await freshIds();
    const [regId] = await seedBooking({
      ids,
      seats: [{ email: 'leaving@weld.test', name: 'Leaving Soon' }],
      orderStatus: 'paid',
      totalCents: 45000,
      startsInDays: 90,
    });
    await E.DB.prepare(
      `INSERT INTO waitlist (id, portal_id, event_id, ticket_type_id, email, position, quantity,
         status, created_at)
       VALUES (?1, ?2, ?3, ?4, 'waiting@weld.test', 1, 1, 'waiting', ?5)`,
    )
      .bind(
        `wl-${ids.eventId}`,
        ids.portalId,
        ids.eventId,
        ids.ticketTypeId,
        new Date().toISOString(),
      )
      .run();

    const result = await cancelRegistration(E, {
      portalId: ids.portalId,
      registrationId: regId,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.waitlistDecisionId).toBeTruthy();

    const decision = await E.DB.prepare(
      `SELECT type, status, assigned_owner_id, context FROM pending_decisions WHERE id = ?1`,
    )
      .bind(result.waitlistDecisionId)
      .first<{ type: string; status: string; assigned_owner_id: string; context: string }>();
    expect(decision?.type).toBe('waitlist');
    expect(decision?.status).toBe('open');
    expect(decision?.assigned_owner_id).toBe('owner-1');
    expect(JSON.parse(decision?.context ?? '{}').freedSeats).toBe(1);

    // The waiter is still WAITING — no auto-offer, no token, no email.
    const waiter = await E.DB.prepare('SELECT status, offer_expires_at FROM waitlist WHERE id = ?1')
      .bind(`wl-${ids.eventId}`)
      .first<{ status: string; offer_expires_at: string | null }>();
    expect(waiter).toEqual({ status: 'waiting', offer_expires_at: null });
    const offers = await E.DB.prepare(
      `SELECT COUNT(*) AS c FROM outbox WHERE topic = 'notify.waitlist_offer' AND portal_id = ?1`,
    )
      .bind(ids.portalId)
      .first<{ c: number }>();
    expect(offers?.c).toBe(0);
  });

  it('opens nothing when nobody is waiting', async () => {
    const ids = await freshIds();
    const [regId] = await seedBooking({
      ids,
      seats: [{ email: 'quiet@weld.test', name: 'Quiet Event' }],
      orderStatus: 'paid',
      totalCents: 45000,
      startsInDays: 90,
    });
    const result = await cancelRegistration(E, {
      portalId: ids.portalId,
      registrationId: regId,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.waitlistDecisionId).toBeNull();
  });
});
