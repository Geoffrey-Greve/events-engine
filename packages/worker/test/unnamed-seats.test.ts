import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { amendRegistration } from '../src/amend';
import { resolveDecision } from '../src/decisions';
import { expireHold } from '../src/expire';
import {
  listEventRegistrations,
  registrationsToCsv,
  summariseRegistrations,
} from '../src/reporting';
import { manageRoutes } from '../src/routes/manage';
import { handleReserve } from '../src/routes/reserve';
import type { Env } from '../src/types';

/**
 * Ref 74b — a company books ten seats and supplies the names later (migration 0039).
 *
 * The shape Ryan scoped: a block is NOT a new state. It is an ordinary invoiced booking
 * that happens to have nobody on its seats, so it prices, holds and invoices exactly as
 * every other booking does and drops public availability the moment it is placed. Names
 * attach at any time through the Phase 3 amend, one at a time. The expiry window is when
 * the INVOICE is voided, and a portal can take that decision away from the clock.
 *
 * The cases below pin all three, plus the thing that would be worst to get wrong: a seat
 * with no person on it must never make the worker invent one in HubSpot.
 */

const BASE_ENV = env as unknown as Env;
let counter = 0;

function freshIds() {
  const n = `${Date.now()}-${counter++}`;
  return {
    portalId: `blk-${n}`,
    eventId: `evt-${n}`,
    hubspotEventId: `hs-blk-${n}`,
    ticketTypeId: `tt-${n}`,
    adminKey: `admin-${n}`,
  };
}

const DAY = 24 * 60 * 60 * 1000;

/** HubSpot answers nothing useful — reserve's optional lookups degrade. */
function stubHubSpot() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 404 })),
  );
}

async function seedEvent(values: ReturnType<typeof freshIds>, opts: { capacity?: number } = {}) {
  const now = new Date().toISOString();
  await BASE_ENV.DB.prepare(
    `INSERT INTO tenants (portal_id, display_name, stripe_processor_connected, xero_gst_rate_id, created_at)
     VALUES (?1, 'Weld Australia (test)', 1, 'hs-gst-rate', ?2)`,
  )
    .bind(values.portalId, now)
    .run();

  await BASE_ENV.DB.prepare(
    `INSERT INTO events
       (id, portal_id, hubspot_event_id, title, starts_at, ends_at, location, capacity,
        booking_kind, allow_oversell, marketing_event_completed, hubspot_owner_id,
        first_published_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'AS1796 Cert 10', ?4, ?5, 'Adelaide', ?6, 'course', 0, 0, 'owner-1', ?7, ?7, ?7)`,
  )
    .bind(
      values.eventId,
      values.portalId,
      values.hubspotEventId,
      new Date(Date.now() + 30 * DAY).toISOString(),
      new Date(Date.now() + 31 * DAY).toISOString(),
      opts.capacity ?? 20,
      now,
    )
    .run();

  await BASE_ENV.DB.prepare(
    `INSERT INTO ticket_types
       (id, portal_id, event_id, name, price_cents, currency, capacity, tax_treatment,
        member_only, sort_order, created_at)
     VALUES (?1, ?2, ?3, 'Standard', 83500, 'AUD', ?4, 'gst', 0, 0, ?5)`,
  )
    .bind(values.ticketTypeId, values.portalId, values.eventId, opts.capacity ?? 20, now)
    .run();
}

function envFor(values: ReturnType<typeof freshIds>): Env {
  return {
    ...(BASE_ENV as unknown as Record<string, unknown>),
    [`ADMIN_API_KEY_${values.portalId}`]: values.adminKey,
  } as unknown as Env;
}

function adminHeaders(values: ReturnType<typeof freshIds>) {
  return {
    'X-Portal-Id': values.portalId,
    Authorization: `Bearer ${values.adminKey}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': crypto.randomUUID(),
  };
}

/** The staff route a company block is actually placed through. */
async function blockSeats(
  values: ReturnType<typeof freshIds>,
  seats: number,
  extra: Record<string, unknown> = {},
) {
  const res = await manageRoutes.request(
    `/events/${values.eventId}/seat-blocks`,
    {
      method: 'POST',
      headers: adminHeaders(values),
      body: JSON.stringify({
        ticketTypeId: values.ticketTypeId,
        seats,
        buyerEmail: 'accounts@acme.test',
        buyerName: 'ACME Welding Pty Ltd',
        ...extra,
      }),
    },
    envFor(values),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const publicApp = new Hono<{ Bindings: Env }>();
publicApp.post('/api/v1/events/:slug/reserve', handleReserve);

async function seatsFor(orderId: string) {
  return (
    await BASE_ENV.DB.prepare(
      `SELECT id, attendee_email, attendee_name, seat_unnamed, ticket_id, unit_cents
         FROM registrations WHERE order_id = ?1 ORDER BY rowid`,
    )
      .bind(orderId)
      .all<{
        id: string;
        attendee_email: string;
        attendee_name: string;
        seat_unnamed: number;
        ticket_id: string | null;
        unit_cents: number;
      }>()
  ).results;
}

async function outboxTopics(portalId: string): Promise<string[]> {
  const rows = (
    await BASE_ENV.DB.prepare('SELECT topic FROM outbox WHERE portal_id = ?1')
      .bind(portalId)
      .all<{ topic: string }>()
  ).results;
  return rows.map((r) => r.topic);
}

afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------
// Placing a block
// ---------------------------------------------------------------------------

describe('POST /events/:id/seat-blocks', () => {
  it('holds and invoices the seats with nobody on them', async () => {
    stubHubSpot();
    const values = freshIds();
    await seedEvent(values);

    const result = await blockSeats(values, 10);
    expect(result.body.status).toBe('reserved');

    const seats = await seatsFor(result.body.orderId as string);
    expect(seats).toHaveLength(10);
    expect(seats.every((s) => s.seat_unnamed === 1)).toBe(true);
    // Sold, at the ordinary price. A block is not a discount and not a placeholder.
    expect(seats.every((s) => s.unit_cents === 83_500)).toBe(true);

    const order = await BASE_ENV.DB.prepare('SELECT total_cents FROM orders WHERE id = ?1')
      .bind(result.body.orderId)
      .first<{ total_cents: number }>();
    expect(order?.total_cents).toBe(835_000);
  });

  it('raises the invoice now — the block IS the invoice', async () => {
    stubHubSpot();
    const values = freshIds();
    await seedEvent(values);

    await blockSeats(values, 4);
    expect(await outboxTopics(values.portalId)).toContain('invoice.create');
  });

  it('takes the seats off sale immediately, through the ordinary seat math', async () => {
    stubHubSpot();
    const values = freshIds();
    await seedEvent(values, { capacity: 10 });

    await blockSeats(values, 10);

    // No new capacity concept: the DO already refuses, because the seats are held.
    const res = await publicApp.request(
      `/api/v1/events/${values.eventId}/reserve`,
      {
        method: 'POST',
        headers: {
          'X-Portal-Id': values.portalId,
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
          'CF-Connecting-IP': `10.0.9.${counter % 250}`,
        },
        body: JSON.stringify({
          buyer: { name: 'Public Buyer', email: 'public@example.com' },
          ticketTypeId: values.ticketTypeId,
        }),
      },
      BASE_ENV,
    );
    expect(((await res.json()) as { status: string }).status).toBe('waitlisted');
  });

  it('never tells HubSpot about a person who does not exist', async () => {
    // The worst way to get this wrong: me.register upserts a CONTACT by email, so an empty
    // one would put someone HubSpot invented onto the marketing event, ten times.
    stubHubSpot();
    const values = freshIds();
    await seedEvent(values);

    await blockSeats(values, 3);

    const topics = await outboxTopics(values.portalId);
    expect(topics).not.toContain('me.register');
    expect(topics).not.toContain('contact.sync_attendee_details');
    expect(topics).not.toContain('contact.sync_answers');
  });

  it('issues no ticket for a seat with nobody to admit', async () => {
    stubHubSpot();
    const values = freshIds();
    await seedEvent(values);

    const result = await blockSeats(values, 3);
    const seats = await seatsFor(result.body.orderId as string);
    expect(seats.every((s) => s.ticket_id === null)).toBe(true);
  });

  it('rejects a block with no seats or no ticket type', async () => {
    stubHubSpot();
    const values = freshIds();
    await seedEvent(values);

    expect((await blockSeats(values, 0)).status).toBe(400);
    expect((await blockSeats(values, 2, { ticketTypeId: '' })).status).toBe(400);
  });

  it('refuses an unnamed block from public checkout', async () => {
    // A block is a company being invoiced on terms. An anonymous caller taking twenty
    // seats off sale is a denial-of-service with an invoice attached.
    stubHubSpot();
    const values = freshIds();
    await seedEvent(values);

    const res = await publicApp.request(
      `/api/v1/events/${values.eventId}/reserve`,
      {
        method: 'POST',
        headers: {
          'X-Portal-Id': values.portalId,
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
          'CF-Connecting-IP': `10.0.8.${counter % 250}`,
        },
        body: JSON.stringify({
          buyer: { name: 'Public Buyer', email: 'public@example.com' },
          unnamedSeats: [{ ticketTypeId: values.ticketTypeId, quantity: 20 }],
        }),
      },
      BASE_ENV,
    );
    expect(res.status).toBe(403);
    expect((await res.json()) as { status: string }).toMatchObject({
      status: 'unnamed_seats_not_public',
    });
  });
});

// ---------------------------------------------------------------------------
// Attaching names
// ---------------------------------------------------------------------------

describe('naming a held seat', () => {
  it('assigns one seat and leaves the rest of the block held', async () => {
    stubHubSpot();
    const values = freshIds();
    await seedEvent(values);
    const block = await blockSeats(values, 5);
    const seats = await seatsFor(block.body.orderId as string);

    const result = await amendRegistration(BASE_ENV, {
      portalId: values.portalId,
      registrationId: seats[0].id,
      name: 'Sam Tan',
      email: 'sam@acme.test',
    });
    expect(result).toMatchObject({ ok: true, seatNamed: true });

    const after = await seatsFor(block.body.orderId as string);
    expect(after[0]).toMatchObject({
      attendee_email: 'sam@acme.test',
      attendee_name: 'Sam Tan',
      seat_unnamed: 0,
    });
    // Partial naming is the ordinary case, not a special one: four still to come.
    expect(after.filter((s) => s.seat_unnamed === 1)).toHaveLength(4);
  });

  it('registers the newly named attendee with HubSpot, and cancels nothing', async () => {
    stubHubSpot();
    const values = freshIds();
    await seedEvent(values);
    const block = await blockSeats(values, 2);
    const seats = await seatsFor(block.body.orderId as string);

    await amendRegistration(BASE_ENV, {
      portalId: values.portalId,
      registrationId: seats[0].id,
      name: 'Sam Tan',
      email: 'sam@acme.test',
    });

    const topics = await outboxTopics(values.portalId);
    expect(topics).toContain('me.register');
    // There was no previous participation, so un-registering one would be a dead row
    // against a contact HubSpot has never heard of.
    expect(topics).not.toContain('me.cancel');
  });

  it('refuses half a name', async () => {
    stubHubSpot();
    const values = freshIds();
    await seedEvent(values);
    const block = await blockSeats(values, 1);
    const seats = await seatsFor(block.body.orderId as string);

    await expect(
      amendRegistration(BASE_ENV, {
        portalId: values.portalId,
        registrationId: seats[0].id,
        name: 'Sam Tan',
      }),
    ).resolves.toMatchObject({ ok: false, error: 'incomplete_attendee' });
  });

  it('refuses a name already holding a seat at this event', async () => {
    // The same guard reserve applies. A block is an easy way to double-book by hand.
    stubHubSpot();
    const values = freshIds();
    await seedEvent(values);
    const block = await blockSeats(values, 2);
    const seats = await seatsFor(block.body.orderId as string);

    await amendRegistration(BASE_ENV, {
      portalId: values.portalId,
      registrationId: seats[0].id,
      name: 'Sam Tan',
      email: 'sam@acme.test',
    });
    await expect(
      amendRegistration(BASE_ENV, {
        portalId: values.portalId,
        registrationId: seats[1].id,
        name: 'Sam Tan Again',
        email: 'SAM@acme.test',
      }),
    ).resolves.toMatchObject({ ok: false, error: 'duplicate_attendee' });
  });

  it('issues the seat its first ticket once the booking is paid', async () => {
    stubHubSpot();
    const values = freshIds();
    await seedEvent(values);
    const block = await blockSeats(values, 1);
    const orderId = block.body.orderId as string;
    const seats = await seatsFor(orderId);

    // No ticket while the invoice is unpaid — same as any other unpaid booking.
    const held = await amendRegistration(BASE_ENV, {
      portalId: values.portalId,
      registrationId: seats[0].id,
      name: 'Unpaid Person',
      email: 'unpaid@acme.test',
    });
    expect(held).toMatchObject({ ok: true, ticketId: null });

    // Money lands, then a second seat is named.
    const second = await blockSeats(values, 1);
    const secondOrderId = second.body.orderId as string;
    await BASE_ENV.DB.prepare("UPDATE orders SET status = 'paid' WHERE id = ?1")
      .bind(secondOrderId)
      .run();
    const secondSeats = await seatsFor(secondOrderId);

    const paid = await amendRegistration(BASE_ENV, {
      portalId: values.portalId,
      registrationId: secondSeats[0].id,
      name: 'Paid Person',
      email: 'paid@acme.test',
    });
    expect(paid.ok && paid.ticketId).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

describe('reporting a block', () => {
  it('counts held seats as seats, and names the gap rather than hiding it', async () => {
    stubHubSpot();
    const values = freshIds();
    await seedEvent(values);
    const block = await blockSeats(values, 4);
    const seats = await seatsFor(block.body.orderId as string);
    await amendRegistration(BASE_ENV, {
      portalId: values.portalId,
      registrationId: seats[0].id,
      name: 'Sam Tan',
      email: 'sam@acme.test',
    });

    const rows = await listEventRegistrations(BASE_ENV, values.portalId, values.eventId);
    const summary = summariseRegistrations(rows);

    // The seats are sold and out of sale, so they are in every seat figure...
    expect(summary.total).toBe(4);
    expect(summary.seatsHeld).toBe(4);
    // ...and the three still waiting on a name are a number someone can chase.
    expect(summary.unnamedSeats).toBe(3);
    // Nobody is on them, so they are not people.
    expect(summary.distinctContacts).toBe(1);
    // And they are not a HubSpot sync failure: HubSpot is right not to know about them.
    expect(summary.notSyncedToMarketingEvent).toBe(1);
  });

  it('writes a held seat into the CSV as unassigned, not as a blank row', async () => {
    stubHubSpot();
    const values = freshIds();
    await seedEvent(values);
    await blockSeats(values, 2);

    const rows = await listEventRegistrations(BASE_ENV, values.portalId, values.eventId);
    const csv = registrationsToCsv(rows, []);
    expect(csv).toContain('Unassigned seat');
  });
});

// ---------------------------------------------------------------------------
// Who voids the invoice
// ---------------------------------------------------------------------------

describe('unpaid invoice mode', () => {
  async function expireWithMode(mode: string | null) {
    stubHubSpot();
    const values = freshIds();
    await seedEvent(values);
    await BASE_ENV.DB.prepare('UPDATE tenants SET unpaid_invoice_mode = ?1 WHERE portal_id = ?2')
      .bind(mode, values.portalId)
      .run();

    const block = await blockSeats(values, 3);
    const orderId = block.body.orderId as string;
    // An invoice exists by the time the hold lapses.
    await BASE_ENV.DB.prepare('UPDATE orders SET hubspot_invoice_id = ?1 WHERE id = ?2')
      .bind(`inv-${orderId}`, orderId)
      .run();
    const reservationId = (
      await BASE_ENV.DB.prepare('SELECT reservation_id FROM orders WHERE id = ?1')
        .bind(orderId)
        .first<{ reservation_id: string }>()
    )?.reservation_id as string;

    await expireHold(BASE_ENV, reservationId);
    return { values, orderId };
  }

  async function voidRows(portalId: string) {
    return (
      await BASE_ENV.DB.prepare(
        `SELECT payload FROM outbox WHERE portal_id = ?1 AND topic = 'payment.refund'`,
      )
        .bind(portalId)
        .all<{ payload: string }>()
    ).results.map((r) => JSON.parse(r.payload) as { reason: string });
  }

  it('voids automatically by default — unchanged for every installed portal', async () => {
    const { values } = await expireWithMode(null);
    expect((await voidRows(values.portalId)).map((r) => r.reason)).toContain('expired_hold');
  });

  it('leaves the invoice alone under manual_review and asks a human', async () => {
    const { values, orderId } = await expireWithMode('manual_review');

    // Nothing voided. A void is terminal in HubSpot, and this portal said it decides.
    expect(await voidRows(values.portalId)).toHaveLength(0);

    const decision = await BASE_ENV.DB.prepare(
      `SELECT id, type, status, order_id FROM pending_decisions
        WHERE portal_id = ?1 AND type = 'unpaid_invoice'`,
    )
      .bind(values.portalId)
      .first<{ id: string; type: string; status: string; order_id: string }>();
    expect(decision).toMatchObject({ status: 'open', order_id: orderId });
    // And the owner has a task, not just a row nobody looks at.
    expect(await outboxTopics(values.portalId)).toContain('notify.owner_task');
  });

  it('still returns the seats to sale under manual_review', async () => {
    // The mode governs the INVOICE. Holding seats indefinitely off an unpaid invoice is a
    // different decision and deliberately not this one.
    const { orderId } = await expireWithMode('manual_review');
    const order = await BASE_ENV.DB.prepare('SELECT status FROM orders WHERE id = ?1')
      .bind(orderId)
      .first<{ status: string }>();
    expect(order?.status).toBe('cancelled');
  });

  it('voids when the owner says to, with a reason that does not stand down', async () => {
    const { values } = await expireWithMode('manual_review');
    const decision = await BASE_ENV.DB.prepare(
      `SELECT id FROM pending_decisions WHERE portal_id = ?1 AND type = 'unpaid_invoice'`,
    )
      .bind(values.portalId)
      .first<{ id: string }>();

    const result = await resolveDecision(BASE_ENV, values.portalId, decision?.id as string, {
      action: 'void',
    });
    expect(result.ok).toBe(true);

    // 'expired_hold' re-reads the order at drain time and stands down if the booking came
    // back. This one names an invoice a person already decided about.
    expect((await voidRows(values.portalId)).map((r) => r.reason)).toEqual(['manual_void']);
  });

  it('closes the decision without voiding when the owner keeps the invoice payable', async () => {
    const { values } = await expireWithMode('manual_review');
    const decision = await BASE_ENV.DB.prepare(
      `SELECT id FROM pending_decisions WHERE portal_id = ?1 AND type = 'unpaid_invoice'`,
    )
      .bind(values.portalId)
      .first<{ id: string }>();

    expect(
      await resolveDecision(BASE_ENV, values.portalId, decision?.id as string, { action: 'keep' }),
    ).toMatchObject({ ok: true });
    expect(await voidRows(values.portalId)).toHaveLength(0);
  });

  it('rejects an unpaid-invoice decision resolved with no action', async () => {
    const { values } = await expireWithMode('manual_review');
    const decision = await BASE_ENV.DB.prepare(
      `SELECT id FROM pending_decisions WHERE portal_id = ?1 AND type = 'unpaid_invoice'`,
    )
      .bind(values.portalId)
      .first<{ id: string }>();

    expect(
      await resolveDecision(BASE_ENV, values.portalId, decision?.id as string, {}),
    ).toMatchObject({ ok: false, error: 'invalid_action' });
  });
});

// ---------------------------------------------------------------------------
// PATCH /onboarding/unpaid-invoice-mode
// ---------------------------------------------------------------------------

describe('PATCH /onboarding/unpaid-invoice-mode', () => {
  async function patch(values: ReturnType<typeof freshIds>, body: Record<string, unknown>) {
    return manageRoutes.request(
      '/onboarding/unpaid-invoice-mode',
      { method: 'PATCH', headers: adminHeaders(values), body: JSON.stringify(body) },
      envFor(values),
    );
  }

  it('stores the mode', async () => {
    const values = freshIds();
    await seedEvent(values);

    expect((await patch(values, { unpaidInvoiceMode: 'manual_review' })).status).toBe(200);
    const row = await BASE_ENV.DB.prepare(
      'SELECT unpaid_invoice_mode FROM tenants WHERE portal_id = ?1',
    )
      .bind(values.portalId)
      .first<{ unpaid_invoice_mode: string | null }>();
    expect(row?.unpaid_invoice_mode).toBe('manual_review');
  });

  it('spells null out as the default rather than leaving a third meaning', async () => {
    const values = freshIds();
    await seedEvent(values);

    await patch(values, { unpaidInvoiceMode: 'manual_review' });
    expect((await patch(values, { unpaidInvoiceMode: null })).status).toBe(200);
    const row = await BASE_ENV.DB.prepare(
      'SELECT unpaid_invoice_mode FROM tenants WHERE portal_id = ?1',
    )
      .bind(values.portalId)
      .first<{ unpaid_invoice_mode: string | null }>();
    expect(row?.unpaid_invoice_mode).toBe('auto_void');
  });

  it('rejects a mode it does not know', async () => {
    const values = freshIds();
    await seedEvent(values);
    const res = await patch(values, { unpaidInvoiceMode: 'never' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ status: 'invalid_unpaid_invoice_mode' });
  });
});
