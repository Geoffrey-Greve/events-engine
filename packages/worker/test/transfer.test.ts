import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { transferRegistration } from '../src/transfer';
import type { Env } from '../src/types';
import { seedEvent, seedTenant, seedTicketType } from './support/fixtures';

const E = env as unknown as Env;

let counter = 0;
// Registers the portal as it mints it: every portal-scoped row REFERENCES `tenants`.
const freshIds = async () => {
  const n = `${Date.now()}-${counter++}`;
  const portalId = `p-${n}`;
  await seedTenant(E.DB, portalId);
  return {
    portalId,
    eventId: `evt-${n}`,
    hsEvent: `hs-${n}`,
    orderId: `ord-${n}`,
    regId: `reg-${n}`,
  };
};

async function seedInPersonReg(args: {
  portalId: string;
  eventId: string;
  hsEvent: string;
  orderId: string;
  regId: string;
}) {
  const now = new Date().toISOString();
  await seedEvent(E.DB, {
    portalId: args.portalId,
    eventId: args.eventId,
    hubspotEventId: args.hsEvent,
    startsAt: new Date(Date.now() + 30 * 86400000).toISOString(),
  });
  const ticketTypeId = await seedTicketType(E.DB, {
    portalId: args.portalId,
    eventId: args.eventId,
    ticketTypeId: `ttA-${args.eventId}`,
  });
  await E.DB.prepare(
    `INSERT INTO orders (id, portal_id, event_id, status, buyer_email, buyer_name, updated_at)
     VALUES (?1, ?2, ?3, 'paid', 'old@x.io', 'Old Name', ?4)`,
  )
    .bind(args.orderId, args.portalId, args.eventId, now)
    .run();
  await E.DB.prepare(
    `INSERT INTO registrations (id, portal_id, order_id, event_id, ticket_type_id, attendee_email, attendee_name, hubspot_contact_id, ticket_id, marketing_event_state_synced, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?6, 'old@x.io', 'Old Name', 'c-old', 'tk-' || ?1, 1, ?5)`,
  )
    .bind(args.regId, args.portalId, args.orderId, args.eventId, now, ticketTypeId)
    .run();
  await E.DB.prepare(
    `INSERT INTO tickets (id, portal_id, registration_id, order_id, event_id, ticket_type_id, status, qr_code, created_at)
     VALUES ('tk-' || ?1, ?2, ?1, ?3, ?4, ?6, 'issued', 'old-qr', ?5)`,
  )
    .bind(args.regId, args.portalId, args.orderId, args.eventId, now, ticketTypeId)
    .run();
}

describe('transferRegistration', () => {
  it('reassigns the seat, reissues the ticket, and logs the transfer', async () => {
    const { portalId, eventId, hsEvent, orderId, regId } = await freshIds();
    await seedInPersonReg({ portalId, eventId, hsEvent, orderId, regId });

    const result = await transferRegistration(E, {
      portalId,
      registrationId: regId,
      toEmail: 'new@x.io',
      toName: 'New Person',
      reason: 'could not attend',
    });
    expect(result.ok).toBe(true);

    // Registration now points at the new attendee.
    const reg = await E.DB.prepare(
      'SELECT attendee_email, attendee_name, ticket_id, hubspot_contact_id FROM registrations WHERE id = ?1',
    )
      .bind(regId)
      .first<{
        attendee_email: string;
        attendee_name: string;
        ticket_id: string;
        hubspot_contact_id: string | null;
      }>();
    expect(reg?.attendee_email).toBe('new@x.io');
    expect(reg?.attendee_name).toBe('New Person');
    expect(reg?.hubspot_contact_id).toBeNull(); // cleared; contact.upsert sets it
    if (result.ok) expect(reg?.ticket_id).toBe(result.ticketId);

    // Old ticket voided, new ticket issued.
    const oldTicket = await E.DB.prepare("SELECT status FROM tickets WHERE id = 'tk-' || ?1")
      .bind(regId)
      .first<{ status: string }>();
    expect(oldTicket?.status).toBe('voided');
    if (result.ok) {
      const newTicket = await E.DB.prepare('SELECT status, qr_code FROM tickets WHERE id = ?1')
        .bind(result.ticketId)
        .first<{ status: string; qr_code: string }>();
      expect(newTicket?.status).toBe('issued');
      expect(newTicket?.qr_code).not.toBe('old-qr'); // freshly minted code
    }

    // Audit row written.
    const transfer = await E.DB.prepare(
      'SELECT from_email, to_email FROM transfers WHERE registration_id = ?1',
    )
      .bind(regId)
      .first<{ from_email: string; to_email: string }>();
    expect(transfer).toEqual({ from_email: 'old@x.io', to_email: 'new@x.io' });

    // Marketing Event reassignment queued: me.cancel (old) + me.register (new) + contact.upsert.
    const topics = await E.DB.prepare(
      `SELECT topic FROM outbox WHERE json_extract(payload, '$.registrationId') = ?1 ORDER BY topic`,
    )
      .bind(regId)
      .all<{ topic: string }>();
    const set = new Set(topics.results.map((t) => t.topic));
    expect(set.has('me.cancel')).toBe(true);
    expect(set.has('me.register')).toBe(true);
    expect(set.has('contact.upsert')).toBe(true);

    // me.cancel carries the OLD email; me.register the NEW email.
    const cancel = await E.DB.prepare(
      "SELECT payload FROM outbox WHERE topic = 'me.cancel' AND json_extract(payload, '$.registrationId') = ?1",
    )
      .bind(regId)
      .first<{ payload: string }>();
    expect(cancel).toBeTruthy();
    if (!cancel) throw new Error('expected cancel outbox');
    expect((JSON.parse(cancel.payload) as { attendeeEmail: string }).attendeeEmail).toBe(
      'old@x.io',
    );
    const register = await E.DB.prepare(
      "SELECT payload FROM outbox WHERE topic = 'me.register' AND json_extract(payload, '$.registrationId') = ?1",
    )
      .bind(regId)
      .first<{ payload: string }>();
    expect(register).toBeTruthy();
    if (!register) throw new Error('expected register outbox');
    expect((JSON.parse(register.payload) as { attendeeEmail: string }).attendeeEmail).toBe(
      'new@x.io',
    );
  });

  it('is blocked when the policy disallows transfer', async () => {
    const { portalId, eventId, hsEvent, orderId, regId } = await freshIds();
    await seedInPersonReg({ portalId, eventId, hsEvent, orderId, regId });
    // Portal default policy with transfers blocked.
    await E.DB.prepare(
      `INSERT INTO refund_policies (id, portal_id, name, is_default, category, full_refund_cutoff_days, partial_refund_percent, allow_transfer, created_at)
       VALUES ('pp-' || ?1, ?1, 'No transfers', 1, NULL, 30, NULL, 0, ?2)`,
    )
      .bind(portalId, new Date().toISOString())
      .run();

    const result = await transferRegistration(E, {
      portalId,
      registrationId: regId,
      toEmail: 'new@x.io',
      toName: 'New',
    });
    expect(result).toEqual({ ok: false, error: 'transfer_not_allowed' });

    // Registration untouched.
    const reg = await E.DB.prepare('SELECT attendee_email FROM registrations WHERE id = ?1')
      .bind(regId)
      .first<{ attendee_email: string }>();
    expect(reg?.attendee_email).toBe('old@x.io');
  });
});
