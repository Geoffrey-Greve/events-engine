import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// These tests drive REAL EventCapacity Durable Object instances (via Miniflare).
// The DO's single-threaded-per-event guarantee is the thing under test, so we never
// mock it — we fire real concurrent fetches and assert on the seat math.

type DOResponse = {
  status: number;
  body: Record<string, unknown>;
};

function doStub(name: string): DurableObjectStub {
  const id = env.EVENT_CAPACITY.idFromName(name);
  return env.EVENT_CAPACITY.get(id);
}

async function call(
  stub: DurableObjectStub,
  path: string,
  body: Record<string, unknown> = {},
): Promise<DOResponse> {
  const res = await stub.fetch(`https://do.local${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const TT = 'tt_general';
const seat = (quantity = 1, ticketTypeId = TT) => [{ ticketTypeId, quantity }];

// Unique event name per test so storage/state never bleeds across cases.
let counter = 0;
const freshEvent = () => `evt-${Date.now()}-${counter++}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function insertRegistration(params: {
  portalId: string;
  eventId: string;
  ticketTypeId: string;
  status: 'paid' | 'confirmed' | 'refunded';
  suffix: string;
}): Promise<void> {
  const now = new Date().toISOString();
  const orderId = `order-${params.status}-${params.suffix}`;
  const reservationId = `resv-${params.status}-${params.suffix}`;
  // `orders.reservation_id` REFERENCES `reservations`, so the hold this order came from
  // is a real row. It is already spent — the rebuild counts only PENDING, unexpired
  // holds — so it must not be one of them.
  await env.DB.prepare(
    `INSERT INTO reservations
       (id, portal_id, event_id, idempotency_key, status, expires_at)
     VALUES (?1, ?2, ?3, ?1, 'confirmed', ?4)`,
  )
    .bind(reservationId, params.portalId, params.eventId, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO orders
       (id, portal_id, event_id, reservation_id, status, buyer_email, buyer_name, total_cents, currency, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'Buyer', 1000, 'AUD', ?7)`,
  )
    .bind(
      orderId,
      params.portalId,
      params.eventId,
      reservationId,
      params.status,
      `${params.status}-${params.suffix}@example.com`,
      now,
    )
    .run();
  await env.DB.prepare(
    `INSERT INTO registrations
       (id, portal_id, order_id, event_id, ticket_type_id, attendee_email, attendee_name)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'Attendee')`,
  )
    .bind(
      `reg-${params.status}-${params.suffix}`,
      params.portalId,
      orderId,
      params.eventId,
      params.ticketTypeId,
      `${params.status}-attendee-${params.suffix}@example.com`,
    )
    .run();
}

describe('EventCapacity Durable Object', () => {
  it('grants the LAST seat to exactly one of N concurrent reservers', async () => {
    const stub = doStub(freshEvent());
    // One seat, uncapped per-type — the event-level cap is the only gate.
    await call(stub, '/sync', { eventCapacity: 1 });

    const N = 30;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        call(stub, '/reserve', { holdId: `hold-${i}`, items: seat(1) }),
      ),
    );

    const winners = results.filter((r) => typeof r.body.holdId === 'string' && r.body.ok === true);
    const losers = results.filter((r) => r.body.full === true);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(N - 1);

    // And the seat is genuinely gone afterwards.
    const avail = await call(stub, '/availability');
    expect(avail.body.available).toBe(0);
  });

  it('reserve → confirm commits the seats', async () => {
    const stub = doStub(freshEvent());
    await call(stub, '/sync', { eventCapacity: 5 });

    const r = await call(stub, '/reserve', { holdId: 'h1', items: seat(2) });
    expect(r.body.holdId).toBe('h1');

    const c = await call(stub, '/confirm', { holdId: 'h1' });
    expect(c.body.confirmed).toBe(true);

    const avail = await call(stub, '/availability');
    expect(avail.body.confirmed).toBe(2);
    expect(avail.body.held).toBe(0);
    expect(avail.body.available).toBe(3);
  });

  it('reserve → expiry frees the seat for the next reserver', async () => {
    const stub = doStub(freshEvent());
    await call(stub, '/sync', { eventCapacity: 1 });

    const a = await call(stub, '/reserve', { holdId: 'hA', items: seat(1), ttlMs: 80 });
    expect(a.body.holdId).toBe('hA');

    // Event is full while the hold is live.
    const blocked = await call(stub, '/reserve', { holdId: 'hB', items: seat(1) });
    expect(blocked.body.full).toBe(true);

    await sleep(160); // let hold hA lapse

    // GC on reserve reaps the expired hold, so the seat is grantable again.
    const b = await call(stub, '/reserve', { holdId: 'hC', items: seat(1) });
    expect(b.body.ok).toBe(true);
    expect(b.body.holdId).toBe('hC');
  });

  it('confirm after expiry + oversell returns expired_and_oversold (unless forced)', async () => {
    const stub = doStub(freshEvent());
    await call(stub, '/sync', { eventCapacity: 1 });

    // hA grabs the only seat with a short TTL.
    await call(stub, '/reserve', { holdId: 'hA', items: seat(1), ttlMs: 80 });
    await sleep(160); // hA lapses

    // Someone else reserves and commits the now-free seat.
    const b = await call(stub, '/reserve', { holdId: 'hB', items: seat(1) });
    expect(b.body.ok).toBe(true);
    const cb = await call(stub, '/confirm', { holdId: 'hB' });
    expect(cb.body.confirmed).toBe(true);

    // hA's late payment lands — seat is gone, so confirm must refuse.
    const late = await call(stub, '/confirm', { holdId: 'hA', orderItems: seat(1) });
    expect(late.body.confirmed).toBe(false);
    expect(late.body.reason).toBe('expired_and_oversold');

    // ...unless the event opts to force-honour (allow_oversell).
    const forced = await call(stub, '/confirm', {
      holdId: 'hA',
      orderItems: seat(1),
      force: true,
    });
    expect(forced.body.confirmed).toBe(true);

    const avail = await call(stub, '/availability');
    expect(avail.body.confirmed).toBe(2); // genuinely oversold, on purpose
  });

  it('refund returns seats to availability', async () => {
    const stub = doStub(freshEvent());
    await call(stub, '/sync', { eventCapacity: 5 });

    await call(stub, '/reserve', { holdId: 'h1', items: seat(2) });
    await call(stub, '/confirm', { holdId: 'h1' });

    let avail = await call(stub, '/availability');
    expect(avail.body.confirmed).toBe(2);
    expect(avail.body.available).toBe(3);

    const refunded = await call(stub, '/refund', { holdId: 'h1' });
    expect(refunded.body.refunded).toBe(true);

    avail = await call(stub, '/availability');
    expect(avail.body.confirmed).toBe(0);
    expect(avail.body.available).toBe(5);
  });

  it('aggregates duplicate ticket-type lines before the per-type gate', async () => {
    const stub = doStub(freshEvent());
    // Uncapped event; the ONLY seat lives in the per-type inventory.
    await call(stub, '/sync', { eventCapacity: null, perType: { [TT]: { inventory: 1 } } });

    // Two lines of the same type each ask for the one seat. Combined they want 2.
    const r = await call(stub, '/reserve', {
      holdId: 'dup',
      items: [
        { ticketTypeId: TT, quantity: 1 },
        { ticketTypeId: TT, quantity: 1 },
      ],
    });
    expect(r.status).toBe(409);
    expect(r.body.full).toBe(true);

    // The single seat is still free for an honest single-seat request.
    const ok = await call(stub, '/reserve', { holdId: 'solo', items: seat(1) });
    expect(ok.body.ok).toBe(true);
  });

  it('rejects a live confirm whose orderItems differ from the hold', async () => {
    const stub = doStub(freshEvent());
    await call(stub, '/sync', { eventCapacity: 5 });

    await call(stub, '/reserve', { holdId: 'h1', items: seat(1) });

    // Caller-supplied orderItems claim 2 seats for a 1-seat hold → must be refused
    // (committing 2 would oversell seats that were never reserved).
    const bad = await call(stub, '/confirm', { holdId: 'h1', orderItems: seat(2) });
    expect(bad.status).toBe(409);
    expect(bad.body.error).toBe('orderItems_mismatch');

    // The hold survives the rejection, so a matching confirm still commits exactly 1.
    const good = await call(stub, '/confirm', { holdId: 'h1', orderItems: seat(1) });
    expect(good.body.confirmed).toBe(true);

    const avail = await call(stub, '/availability');
    expect(avail.body.confirmed).toBe(1);
  });

  it('rebuilds stale counters from paid/confirmed D1 registrations and active holds', async () => {
    const suffix = freshEvent();
    const portalId = `portal-${suffix}`;
    const eventId = `event-${suffix}`;
    const hubspotEventId = `hs-${suffix}`;
    const paidTicketTypeId = `tt-paid-${suffix}`;
    const freeTicketTypeId = `tt-free-${suffix}`;
    const idName = `${portalId}:${hubspotEventId}`;
    const now = new Date().toISOString();

    await env.DB.prepare('INSERT OR IGNORE INTO tenants (portal_id, display_name) VALUES (?1, ?2)')
      .bind(portalId, 'Test Tenant')
      .run();
    await env.DB.prepare(
      `INSERT INTO events
         (id, portal_id, hubspot_event_id, title, starts_at, ends_at, capacity)
       VALUES (?1, ?2, ?3, 'Rebuild Test Event', ?4, ?4, 10)`,
    )
      .bind(eventId, portalId, hubspotEventId, now)
      .run();
    await env.DB.prepare(
      `INSERT INTO ticket_types
         (id, portal_id, event_id, name, price_cents, capacity, sort_order, created_at)
       VALUES (?1, ?2, ?3, 'Paid', 1000, 8, 1, ?4),
              (?5, ?2, ?3, 'Free', 0, 6, 2, ?4)`,
    )
      .bind(paidTicketTypeId, portalId, eventId, now, freeTicketTypeId)
      .run();

    await insertRegistration({
      portalId,
      eventId,
      ticketTypeId: paidTicketTypeId,
      status: 'paid',
      suffix,
    });
    await insertRegistration({
      portalId,
      eventId,
      ticketTypeId: freeTicketTypeId,
      status: 'confirmed',
      suffix,
    });
    await insertRegistration({
      portalId,
      eventId,
      ticketTypeId: paidTicketTypeId,
      status: 'refunded',
      suffix,
    });

    const activeHoldId = `pending-${suffix}`;
    await env.DB.prepare(
      `INSERT INTO reservations
         (id, portal_id, event_id, idempotency_key, status, expires_at)
       VALUES (?1, ?2, ?3, ?4, 'pending', ?5)`,
    )
      .bind(
        activeHoldId,
        portalId,
        eventId,
        `idem-${suffix}`,
        new Date(Date.now() + 60_000).toISOString(),
      )
      .run();
    await env.DB.prepare(
      `INSERT INTO reservation_items
         (id, reservation_id, ticket_type_id, quantity, portal_id)
       VALUES (?1, ?2, ?3, 2, ?4)`,
    )
      .bind(`ri-${suffix}`, activeHoldId, paidTicketTypeId, portalId)
      .run();

    const stub = doStub(idName);
    await call(stub, '/sync', {
      eventCapacity: 5,
      perType: { [paidTicketTypeId]: { inventory: 5 } },
    });
    await call(stub, '/reserve', {
      holdId: `stale-${suffix}`,
      items: [{ ticketTypeId: paidTicketTypeId, quantity: 1 }],
    });
    await call(stub, '/confirm', { holdId: `stale-${suffix}` });

    const rebuilt = await call(stub, '/rebuild', { idName });
    expect(rebuilt.status).toBe(200);
    expect(rebuilt.body.rebuilt).toBe(true);
    expect(rebuilt.body.eventCapacity).toBe(10);
    expect(rebuilt.body.confirmed).toBe(2);
    expect(rebuilt.body.held).toBe(2);
    expect(rebuilt.body.available).toBe(6);

    const perType = rebuilt.body.perType as Record<
      string,
      { inventory: number; confirmed: number; held: number; available: number }
    >;
    expect(perType[paidTicketTypeId]).toMatchObject({
      inventory: 8,
      confirmed: 1,
      held: 2,
      available: 5,
    });
    expect(perType[freeTicketTypeId]).toMatchObject({
      inventory: 6,
      confirmed: 1,
      held: 0,
      available: 5,
    });
  });
});
