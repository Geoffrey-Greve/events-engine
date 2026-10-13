import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { issueDeviceToken } from '../src/checkin';
import { checkinRoutes } from '../src/routes/checkin';
import type { Env } from '../src/types';
import { seedEvent, seedTicketType } from './support/fixtures';

/**
 * Ref 74d - registration answers on the check-in manifest.
 *
 * Answers were captured, stored and exported to CSV, but never reached the door: the
 * manifest carried a name and a status and nothing else, so a catering question answered
 * at booking was invisible on the day.
 *
 * What is worth holding down is the scoping, not the plumbing:
 *   1. the answers ride on the ticket of the attendee who gave them, in question order;
 *   2. order-scoped answers stay off the manifest - a purchase order number is not door
 *      information, and on a company block it would repeat on every seat;
 *   3. an unanswered optional question takes up no line;
 *   4. no answer lands on a ticket other than its own.
 */

const BASE_ENV = env as unknown as Env;

const app = new Hono<{ Bindings: Env }>();
app.route('/api/v1/checkin', checkinRoutes);

let counter = 0;
// The event, the portal and the ticket type are real rows: `registrations` and `tickets`
// carry foreign keys into all three.
const freshIds = async () => {
  const n = `m${Date.now()}${counter++}`;
  const portalId = `portal-${n}`;
  const eventId = `evt-${n}`;
  await seedEvent(BASE_ENV.DB, { portalId, eventId, hubspotEventId: `hs-${n}` });
  const ticketTypeId = await seedTicketType(BASE_ENV.DB, {
    portalId,
    eventId,
    ticketTypeId: `tt-${n}`,
  });
  return {
    portalId,
    eventId,
    ticketTypeId,
    registrationId: `reg-${n}`,
    otherRegistrationId: `reg-other-${n}`,
    orderId: `ord-${n}`,
    ticketId: `tkt-${n}`,
    otherTicketId: `tkt-other-${n}`,
  };
};

type Ids = Awaited<ReturnType<typeof freshIds>>;

interface SeedAnswer {
  key: string;
  label: string;
  scope: 'attendee' | 'order';
  value: string | null;
  sortOrder: number;
  registrationId?: string;
  orderId?: string;
}

async function seedQuestionAndAnswer(portalId: string, a: SeedAnswer): Promise<void> {
  const questionId = `q-${portalId}-${a.key}`;
  await BASE_ENV.DB.prepare(
    `INSERT INTO registration_questions
       (id, portal_id, event_id, key, label, field_type, options_json, required, scope,
        hs_property, prefill, help_text, sort_order, archived_at)
     VALUES (?1, ?2, NULL, ?3, ?4, 'textarea', NULL, 0, ?5, NULL, 1, NULL, ?6, NULL)`,
  )
    .bind(questionId, portalId, a.key, a.label, a.scope, a.sortOrder)
    .run();

  await BASE_ENV.DB.prepare(
    `INSERT INTO registration_answers
       (id, portal_id, registration_id, order_id, question_id, value_text)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(
      `a-${portalId}-${a.key}`,
      portalId,
      a.registrationId ?? null,
      a.orderId ?? null,
      questionId,
      a.value,
    )
    .run();
}

async function seedTicket(
  ids: Ids,
  registrationId: string,
  ticketId: string,
  name: string,
): Promise<void> {
  const now = new Date().toISOString();
  // The order has to exist for real: listEventAnswers finds order-scoped answers by
  // reaching through `orders`, so without the row an order-scoped answer would never be
  // returned at all and the scope filter under test would never run.
  await BASE_ENV.DB.prepare(
    `INSERT OR IGNORE INTO orders
       (id, portal_id, event_id, status, buyer_email, buyer_name, total_cents, created_at)
     VALUES (?1, ?2, ?3, 'paid', 'buyer@example.com', 'Buyer', 0, ?4)`,
  )
    .bind(ids.orderId, ids.portalId, ids.eventId, now)
    .run();

  await BASE_ENV.DB.prepare(
    `INSERT INTO registrations
       (id, portal_id, order_id, event_id, ticket_type_id, attendee_email, attendee_name,
        created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?8, ?5, ?6, ?7, ?7)`,
  )
    .bind(
      registrationId,
      ids.portalId,
      ids.orderId,
      ids.eventId,
      `${name.toLowerCase()}@example.com`,
      name,
      now,
      ids.ticketTypeId,
    )
    .run();

  await BASE_ENV.DB.prepare(
    `INSERT INTO tickets
       (id, portal_id, registration_id, order_id, event_id, ticket_type_id, status,
        checked_in_at, qr_code, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?7, 'issued', NULL, NULL, ?6)`,
  )
    .bind(ticketId, ids.portalId, registrationId, ids.orderId, ids.eventId, now, ids.ticketTypeId)
    .run();
}

/** The env the checkin helpers need: per-tenant ticket + device signing secrets. */
function envFor(portalId: string): Env {
  return {
    ...(BASE_ENV as unknown as Record<string, unknown>),
    [`TICKET_SIGNING_SECRET_${portalId}`]: 'ticket-signing-secret',
    [`DEVICE_TOKEN_SECRET_${portalId}`]: 'device-token-secret',
  } as unknown as Env;
}

interface ManifestBody {
  tickets: Array<{
    name: string;
    answers: Array<{ key: string; label: string; value: string }>;
  }>;
}

async function readManifest(ids: Ids) {
  const testEnv = envFor(ids.portalId);
  const { token } = await issueDeviceToken(testEnv, ids.portalId, ids.eventId, 'door-1');
  const res = await app.fetch(
    new Request(`https://worker.test/api/v1/checkin/manifest/${ids.eventId}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    testEnv,
  );
  return { status: res.status, body: (await res.json()) as ManifestBody };
}

describe('check-in manifest carries attendee answers (Ref 74d)', () => {
  it('puts the answers on the ticket of the attendee who gave them, in question order', async () => {
    const ids = await freshIds();
    await seedTicket(ids, ids.registrationId, ids.ticketId, 'Ada');
    await seedQuestionAndAnswer(ids.portalId, {
      key: 'shirt_size',
      label: 'Shirt size',
      scope: 'attendee',
      value: 'L',
      sortOrder: 1,
      registrationId: ids.registrationId,
    });
    await seedQuestionAndAnswer(ids.portalId, {
      key: 'dietary_requirements',
      label: 'Dietary requirements',
      scope: 'attendee',
      value: 'Coeliac - strictly gluten free',
      sortOrder: 0,
      registrationId: ids.registrationId,
    });

    const { status, body } = await readManifest(ids);
    expect(status).toBe(200);
    expect(body.tickets).toHaveLength(1);
    // sort_order decides the order the door reads them in, not insertion order.
    expect(body.tickets[0]?.answers).toEqual([
      {
        key: 'dietary_requirements',
        label: 'Dietary requirements',
        value: 'Coeliac - strictly gluten free',
      },
      { key: 'shirt_size', label: 'Shirt size', value: 'L' },
    ]);
  });

  it('does not leak an answer onto a ticket other than its own', async () => {
    const ids = await freshIds();
    await seedTicket(ids, ids.registrationId, ids.ticketId, 'Ada');
    await seedTicket(ids, ids.otherRegistrationId, ids.otherTicketId, 'Grace');
    await seedQuestionAndAnswer(ids.portalId, {
      key: 'dietary_requirements',
      label: 'Dietary requirements',
      scope: 'attendee',
      value: 'Nut allergy',
      sortOrder: 0,
      registrationId: ids.registrationId,
    });

    const { body } = await readManifest(ids);
    const ada = body.tickets.find((t) => t.name === 'Ada');
    const grace = body.tickets.find((t) => t.name === 'Grace');
    expect(ada?.answers).toEqual([
      { key: 'dietary_requirements', label: 'Dietary requirements', value: 'Nut allergy' },
    ]);
    // Not undefined, and not the other answer: an empty list.
    expect(grace?.answers).toEqual([]);
  });

  it('leaves order-scoped answers off the manifest', async () => {
    const ids = await freshIds();
    await seedTicket(ids, ids.registrationId, ids.ticketId, 'Ada');
    await seedQuestionAndAnswer(ids.portalId, {
      key: 'purchase_order',
      label: 'Purchase order number',
      scope: 'order',
      value: 'PO-4471',
      sortOrder: 0,
      orderId: ids.orderId,
    });

    const { body } = await readManifest(ids);
    // A PO number is not door information, and on a block it would repeat on every seat.
    expect(body.tickets[0]?.answers).toEqual([]);
  });

  it('drops an order-scoped answer even when it carries a registration id', async () => {
    const ids = await freshIds();
    await seedTicket(ids, ids.registrationId, ids.ticketId, 'Ada');
    // The order-scoped case above is excluded by having no registration to attach to, so it
    // cannot tell whether the SCOPE is being read. This row is scoped to the order and
    // stamped with a registration anyway - the shape a future writer could produce - and
    // only the scope check keeps a purchase order number off every seat at the door.
    await seedQuestionAndAnswer(ids.portalId, {
      key: 'purchase_order_misscoped',
      label: 'Purchase order number',
      scope: 'order',
      value: 'PO-9001',
      sortOrder: 0,
      registrationId: ids.registrationId,
      orderId: ids.orderId,
    });

    const { body } = await readManifest(ids);
    expect(body.tickets[0]?.answers).toEqual([]);
  });

  it('omits an unanswered optional question rather than showing a blank line', async () => {
    const ids = await freshIds();
    await seedTicket(ids, ids.registrationId, ids.ticketId, 'Ada');
    await seedQuestionAndAnswer(ids.portalId, {
      key: 'dietary_requirements',
      label: 'Dietary requirements',
      scope: 'attendee',
      value: '   ',
      sortOrder: 0,
      registrationId: ids.registrationId,
    });

    const { body } = await readManifest(ids);
    expect(body.tickets[0]?.answers).toEqual([]);
  });
});
