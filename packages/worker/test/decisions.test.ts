import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createWaitlistDecision, listPendingDecisions, resolveDecision } from '../src/decisions';
import { flagOversellForReview } from '../src/payment';
import type { Env } from '../src/types';
import { seedEvent as seedEventRow, seedTenant, seedTicketType } from './support/fixtures';

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
    invoiceId: `inv-${n}`,
  };
};

describe('oversell → human-in-the-loop', () => {
  it('flags needs_review + opens an owner-assigned decision + task (no auto-resolve)', async () => {
    const { portalId, eventId, hsEvent, orderId, regId, invoiceId } = await freshIds();
    const now = new Date().toISOString();
    await seedEventRow(E.DB, {
      portalId,
      eventId,
      hubspotEventId: hsEvent,
      startsAt: now,
      title: 'Sold Out Gala',
      extra: { hubspot_owner_id: 'owner-7' },
    });
    const ticketTypeId = await seedTicketType(E.DB, {
      portalId,
      eventId,
      ticketTypeId: `ttA-${eventId}`,
    });
    await E.DB.prepare(
      `INSERT INTO orders (id, portal_id, event_id, hubspot_invoice_id, status, total_cents,
         currency, buyer_email, buyer_name, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'pending', 9900, 'AUD', 'buyer@x.io', 'Buyer', ?5)`,
    )
      .bind(orderId, portalId, eventId, invoiceId, now)
      .run();
    await E.DB.prepare(
      `INSERT INTO registrations (id, portal_id, order_id, event_id, ticket_type_id, attendee_email, attendee_name, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?6, 'buyer@x.io', 'Buyer', ?5)`,
    )
      .bind(regId, portalId, orderId, eventId, now, ticketTypeId)
      .run();

    await flagOversellForReview(E, { kind: 'confirm_payment', hsInvoiceId: invoiceId, portalId });

    const order = await E.DB.prepare('SELECT status FROM orders WHERE id = ?1')
      .bind(orderId)
      .first<{ status: string }>();
    expect(order?.status).toBe('needs_review');

    const decisions = await listPendingDecisions(E, portalId, eventId);
    expect(decisions.length).toBe(1);
    expect(decisions[0].type).toBe('oversell');
    expect(decisions[0].assigned_owner_id).toBe('owner-7');
    expect(decisions[0].order_id).toBe(orderId);

    const task = await E.DB.prepare(
      `SELECT COUNT(*) AS n FROM outbox WHERE topic = 'notify.owner_task' AND json_extract(payload, '$.eventId') = ?1`,
    )
      .bind(eventId)
      .first<{ n: number }>();
    expect(task?.n).toBe(1);

    // Owner honours → order paid + ticket issued + decision resolved.
    const resolved = await resolveDecision(E, portalId, decisions[0].id, {
      action: 'honour',
      resolvedBy: 'u1',
    });
    expect(resolved.ok).toBe(true);

    const paid = await E.DB.prepare('SELECT status FROM orders WHERE id = ?1')
      .bind(orderId)
      .first<{ status: string }>();
    expect(paid?.status).toBe('paid');
    const ticket = await E.DB.prepare(
      "SELECT COUNT(*) AS n FROM tickets WHERE order_id = ?1 AND status = 'issued'",
    )
      .bind(orderId)
      .first<{ n: number }>();
    expect(ticket?.n).toBe(1);
    const decAfter = await listPendingDecisions(E, portalId, eventId);
    expect(decAfter.length).toBe(0); // resolved → no longer open
  });
});

describe('waitlist → human-in-the-loop', () => {
  it('owner picks waitlisters and only the chosen get an offer', async () => {
    const { portalId, eventId, hsEvent } = await freshIds();
    const now = new Date().toISOString();
    await seedEventRow(E.DB, {
      portalId,
      eventId,
      hubspotEventId: hsEvent,
      startsAt: now,
      title: 'Workshop',
      extra: { hubspot_owner_id: 'owner-9' },
    });

    const w1 = crypto.randomUUID();
    const w2 = crypto.randomUUID();
    for (const [i, id] of [w1, w2].entries()) {
      await E.DB.prepare(
        `INSERT INTO waitlist (id, portal_id, event_id, ticket_type_id, email, position, quantity, status, created_at)
         VALUES (?1, ?2, ?3, NULL, ?4, ?5, 1, 'waiting', ?6)`,
      )
        .bind(id, portalId, eventId, `w${i}@x.io`, i + 1, now)
        .run();
    }

    const event = await E.DB.prepare('SELECT * FROM events WHERE id = ?1').bind(eventId).first();
    expect(event).toBeTruthy();
    if (!event) throw new Error('expected event');
    await createWaitlistDecision(E, {
      portalId,
      event: event as never,
      context: { freedSeats: 1, waitlist: [] },
    });

    const decisions = await listPendingDecisions(E, portalId, eventId);
    expect(decisions.length).toBe(1);
    expect(decisions[0].type).toBe('waitlist');

    // Offer only to w1.
    const resolved = await resolveDecision(E, portalId, decisions[0].id, { waitlistIds: [w1] });
    expect(resolved.ok).toBe(true);

    const s1 = await E.DB.prepare('SELECT status FROM waitlist WHERE id = ?1')
      .bind(w1)
      .first<{ status: string }>();
    const s2 = await E.DB.prepare('SELECT status FROM waitlist WHERE id = ?1')
      .bind(w2)
      .first<{ status: string }>();
    expect(s1?.status).toBe('offered');
    expect(s2?.status).toBe('waiting'); // not chosen

    const offer = await E.DB.prepare(
      `SELECT COUNT(*) AS n FROM outbox WHERE topic = 'notify.waitlist_offer' AND json_extract(payload, '$.waitlistId') = ?1`,
    )
      .bind(w1)
      .first<{ n: number }>();
    expect(offer?.n).toBe(1);
  });
});

describe('task_sync_mode (migration 0042)', () => {
  async function seedEvent(portalId: string, eventId: string, hsEvent: string) {
    await seedEventRow(E.DB, {
      portalId,
      eventId,
      hubspotEventId: hsEvent,
      extra: { hubspot_owner_id: 'owner-9' },
    });
    return {
      id: eventId,
      portal_id: portalId,
      hubspot_event_id: hsEvent,
      title: 'Welding Fundamentals',
      hubspot_owner_id: 'owner-9',
    } as unknown as Parameters<typeof createWaitlistDecision>[1]['event'];
  }

  const countTasks = async (portalId: string) =>
    (
      await E.DB.prepare(
        "SELECT COUNT(*) AS n FROM outbox WHERE portal_id = ?1 AND topic = 'notify.owner_task'",
      )
        .bind(portalId)
        .first<{ n: number }>()
    )?.n ?? 0;

  it("records the decision and raises no task when the tenant is set to 'off'", async () => {
    const { portalId, eventId, hsEvent } = await freshIds();
    await E.DB.prepare("UPDATE tenants SET task_sync_mode = 'off' WHERE portal_id = ?1")
      .bind(portalId)
      .run();
    const event = await seedEvent(portalId, eventId, hsEvent);

    const decisionId = await createWaitlistDecision(E, { portalId, event, context: { freed: 1 } });

    // The decision is the record; the task was only ever the telling. Losing the scope
    // must not lose the queue, or a freed seat is offered to nobody and nobody knows.
    const open = await listPendingDecisions(E, portalId, eventId);
    expect(open.map((d) => d.id)).toContain(decisionId);
    expect(await countTasks(portalId)).toBe(0);
  });

  it('still raises a task for a tenant that has not opted out', async () => {
    const { portalId, eventId, hsEvent } = await freshIds();
    await E.DB.prepare('UPDATE tenants SET task_sync_mode = NULL WHERE portal_id = ?1')
      .bind(portalId)
      .run();
    const event = await seedEvent(portalId, eventId, hsEvent);

    await createWaitlistDecision(E, { portalId, event, context: { freed: 1 } });

    expect(await countTasks(portalId)).toBe(1);
  });

  it('raises a task for a portal that has never been configured (degrades to on)', async () => {
    const { portalId, eventId, hsEvent } = await freshIds();
    const event = await seedEvent(portalId, eventId, hsEvent);

    await createWaitlistDecision(E, { portalId, event, context: { freed: 1 } });

    // An unconfigured portal keeps the behaviour the worker has always had, so no
    // installed portal changes on deploy. The same holds when the COLUMN is missing
    // (Ref 217): reading optional config must never fail the caller.
    //
    // The tenant row itself is not optional and this no longer pretends it is: both
    // `events.portal_id` and `pending_decisions.portal_id` REFERENCE `tenants`, so a
    // decision for a portal D1 has never heard of cannot be written at all. The case
    // that survives is the one that reaches production — a row with nothing set on it.
    expect(await countTasks(portalId)).toBe(1);
  });
});
