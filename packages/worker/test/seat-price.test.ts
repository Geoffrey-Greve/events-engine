import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { cancelRegistration } from '../src/cancel';
import { manageRoutes } from '../src/routes/manage';
import type { Env } from '../src/types';
// The migration's own statement, kept in step with the file by check-migrations.mjs — see
// the constant's own note for why it is mirrored rather than imported from the .sql.
import { BACKFILL_0028 } from './support/migration-0028-backfill';

/**
 * Phase 3.3 — what each SEAT cost, recorded against the seat.
 *
 * Two properties hold the whole thing up, and everything else follows from them:
 *
 *   1. The seat record is a DECOMPOSITION of the order's three money columns, so
 *      `SUM(unit_cents) = total_cents`, `SUM(voucher_seats) = voucher_seats_redeemed` and
 *      `SUM(voucher_cents) = voucher_credit_cents` over a booking's seats. If that holds,
 *      cancelling seats one at a time can never refund or return more than was taken.
 *   2. A booking taken before 0028 has no seat record and cannot be given a truthful one,
 *      so both cancel paths fall back to the order's own totals rather than to zero.
 */

const BASE_ENV = env as unknown as Env;

let counter = 0;
function freshIds() {
  const n = `${Date.now()}-${counter++}`;
  return {
    portalId: `sp-${n}`,
    adminKey: `admin-${n}`,
    eventId: `evt-sp-${n}`,
    hsEvent: `hs-sp-${n}`,
    ticketTypeId: `tt-sp-${n}`,
    memberTicketTypeId: `tt-sp-mem-${n}`,
    orderId: `ord-sp-${n}`,
    reservationId: `resv-sp-${n}`,
  };
}
type Ids = ReturnType<typeof freshIds>;

function envFor(ids: Ids): Env {
  return {
    ...(BASE_ENV as unknown as Record<string, unknown>),
    [`ADMIN_API_KEY_${ids.portalId}`]: ids.adminKey,
  } as unknown as Env;
}

function adminHeaders(ids: Ids): Record<string, string> {
  return {
    authorization: `Bearer ${ids.adminKey}`,
    'x-portal-id': ids.portalId,
    'content-type': 'application/json',
  };
}

/** HubSpot is not under test here; every write-back is swallowed. */
function stubHubSpot(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ id: '1' }), { status: 200 })),
  );
}

async function seedEvent(ids: Ids, opts: { priceCents?: number } = {}): Promise<void> {
  const now = new Date().toISOString();
  // A PAID booking is refused until the tenant's payment + tax mapping is complete, so an
  // untaxed or misrouted invoice can never be raised. This test needs a real paid order.
  await BASE_ENV.DB.prepare(
    `INSERT OR IGNORE INTO tenants (portal_id, display_name, stripe_processor_connected,
       xero_gst_rate_id) VALUES (?1, ?2, 1, 'gst-rate-1')`,
  )
    .bind(ids.portalId, 'Seat Price Tenant')
    .run();
  await BASE_ENV.DB.prepare(
    `INSERT INTO events (id, portal_id, hubspot_event_id, title, starts_at, ends_at, capacity,
       hubspot_owner_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'Seat Price Course', ?4, ?4, 20, 'owner-1', ?5, ?5)`,
  )
    .bind(
      ids.eventId,
      ids.portalId,
      ids.hsEvent,
      new Date(Date.now() + 90 * 86400000).toISOString(),
      now,
    )
    .run();
  await BASE_ENV.DB.prepare(
    `INSERT INTO ticket_types (id, portal_id, event_id, name, price_cents, capacity, created_at)
     VALUES (?1, ?2, ?3, 'Standard', ?4, 20, ?5)`,
  )
    .bind(ids.ticketTypeId, ids.portalId, ids.eventId, opts.priceCents ?? 45000, now)
    .run();
}

/** One staff booking through the real reserve path. */
async function book(ids: Ids, mode: 'paid' | 'complimentary'): Promise<Record<string, unknown>> {
  const res = await manageRoutes.request(
    `/events/${ids.eventId}/registrations`,
    {
      method: 'POST',
      headers: { ...adminHeaders(ids), 'idempotency-key': `idem-${ids.eventId}-${mode}` },
      body: JSON.stringify({
        mode,
        ticketTypeId: ids.ticketTypeId,
        attendeeName: 'Sam Tan',
        attendeeEmail: `sam-${ids.eventId}@weld.test`,
      }),
    },
    envFor(ids),
  );
  return (await res.json()) as Record<string, unknown>;
}

/** Seat rows written directly, for the shapes a single staff booking cannot produce. */
async function seedBooking(args: {
  ids: Ids;
  seats: Array<{
    unitCents: number | null;
    voucherSeats?: number;
    voucherCents?: number;
    ticketTypeId?: string;
  }>;
  totalCents: number;
  memberCompanyId?: string | null;
  voucherSeatsRedeemed?: number;
  voucherCreditCents?: number;
}): Promise<string[]> {
  const { ids, seats, totalCents } = args;
  const now = new Date().toISOString();
  await BASE_ENV.DB.prepare(
    `INSERT INTO reservations
       (id, portal_id, event_id, idempotency_key, status, expires_at, created_at)
     VALUES (?1, ?2, ?3, ?1, 'confirmed', ?4, ?5)`,
  )
    .bind(ids.reservationId, ids.portalId, ids.eventId, now, now)
    .run();
  await BASE_ENV.DB.prepare(
    `INSERT INTO orders (id, portal_id, event_id, reservation_id, hubspot_invoice_id, status,
       buyer_email, buyer_name, total_cents, refunded_cents, currency, member_company_id,
       voucher_seats_redeemed, voucher_credit_cents, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'paid', 'buyer@weld.test', 'Buyer', ?6, 0, 'AUD', ?7, ?8, ?9, ?10, ?10)`,
  )
    .bind(
      ids.orderId,
      ids.portalId,
      ids.eventId,
      ids.reservationId,
      `inv-${ids.orderId}`,
      totalCents,
      args.memberCompanyId ?? null,
      args.voucherSeatsRedeemed ?? 0,
      args.voucherCreditCents ?? 0,
      now,
    )
    .run();

  const regIds: string[] = [];
  for (const [index, seat] of seats.entries()) {
    const regId = `${ids.orderId}-reg-${index}`;
    regIds.push(regId);
    await BASE_ENV.DB.prepare(
      `INSERT INTO registrations (id, portal_id, order_id, event_id, ticket_type_id,
         attendee_email, attendee_name, ticket_id, unit_cents, voucher_seats, voucher_cents,
         marketing_event_state_synced, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 1, ?12, ?12)`,
    )
      .bind(
        regId,
        ids.portalId,
        ids.orderId,
        ids.eventId,
        seat.ticketTypeId ?? ids.ticketTypeId,
        `seat${index}@weld.test`,
        `Seat ${index}`,
        `${regId}-tk`,
        seat.unitCents,
        seat.voucherSeats ?? 0,
        seat.voucherCents ?? 0,
        now,
      )
      .run();
    await BASE_ENV.DB.prepare(
      `INSERT INTO tickets (id, portal_id, registration_id, order_id, event_id, ticket_type_id,
         status, qr_code, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'issued', ?7, ?8)`,
    )
      .bind(
        `${regId}-tk`,
        ids.portalId,
        regId,
        ids.orderId,
        ids.eventId,
        seat.ticketTypeId ?? ids.ticketTypeId,
        `qr-${regId}`,
        now,
      )
      .run();
  }
  return regIds;
}

// ---------------------------------------------------------------------------
// The decomposition, written by a real reserve
// ---------------------------------------------------------------------------

describe('reserve records what each seat cost', () => {
  it('stamps the seat with its charged price, summing to the order total', async () => {
    const ids = freshIds();
    await seedEvent(ids, { priceCents: 45000 });
    stubHubSpot();

    const body = await book(ids, 'paid');
    const orderId = body.orderId as string;
    expect(orderId).toBeTruthy();

    const row = await BASE_ENV.DB.prepare(
      `SELECT COALESCE(SUM(r.unit_cents), -1) AS seat_total,
              COALESCE(SUM(r.voucher_seats), 0) AS vseats,
              COALESCE(SUM(r.voucher_cents), 0) AS vcents,
              o.total_cents AS order_total
         FROM registrations r JOIN orders o ON o.id = r.order_id
        WHERE r.order_id = ?1 GROUP BY o.total_cents`,
    )
      .bind(orderId)
      .first<{ seat_total: number; vseats: number; vcents: number; order_total: number }>();

    expect(row?.seat_total).toBe(45000);
    // The decomposition invariant: the seats add up to the booking.
    expect(row?.seat_total).toBe(row?.order_total);
    // Nothing was redeemed, so nothing is recorded as redeemed.
    expect(row?.vseats).toBe(0);
    expect(row?.vcents).toBe(0);
  });

  it('records a comped seat as costing nothing, not as costing its list price', async () => {
    const ids = freshIds();
    await seedEvent(ids, { priceCents: 45000 });
    stubHubSpot();

    const body = await book(ids, 'complimentary');
    const orderId = body.orderId as string;

    const row = await BASE_ENV.DB.prepare(
      `SELECT r.unit_cents AS seat, o.total_cents AS order_total
         FROM registrations r JOIN orders o ON o.id = r.order_id WHERE r.order_id = ?1`,
    )
      .bind(orderId)
      .first<{ seat: number; order_total: number }>();

    // A comp is not owed its ticket type's price back, so the seat records the amount
    // actually charged rather than what the ticket normally costs.
    expect(row?.seat).toBe(0);
    expect(row?.order_total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// What the record buys: an exact per-seat refund
// ---------------------------------------------------------------------------

describe('cancelling a seat out of a mixed-price booking', () => {
  it('refunds what THAT seat cost, not the booking average', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    // 2 × $100 member + 2 × $200 standard = $600. The even share would refund $150.
    const regIds = await seedBooking({
      ids,
      seats: [
        { unitCents: 10000 },
        { unitCents: 10000 },
        { unitCents: 20000 },
        { unitCents: 20000 },
      ],
      totalCents: 60000,
    });

    const member = await cancelRegistration(BASE_ENV, {
      portalId: ids.portalId,
      registrationId: regIds[0],
    });
    expect(member.ok).toBe(true);
    if (!member.ok) return;
    expect(member.refund).toMatchObject({
      kind: 'full',
      amountCents: 10000,
      seatAmountCents: 10000,
      basis: 'seat',
    });

    const standard = await cancelRegistration(BASE_ENV, {
      portalId: ids.portalId,
      registrationId: regIds[2],
    });
    expect(standard.ok).toBe(true);
    if (!standard.ok) return;
    expect(standard.refund).toMatchObject({ amountCents: 20000, basis: 'seat' });

    // Two seats gone, $300 back, and the booking still stands for the other two.
    const order = await BASE_ENV.DB.prepare(
      'SELECT status, refunded_cents FROM orders WHERE id = ?1',
    )
      .bind(ids.orderId)
      .first<{ status: string; refunded_cents: number }>();
    expect(order).toEqual({ status: 'paid', refunded_cents: 30000 });
  });

  it('never refunds more than the booking took, cancelled seat by seat', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    const regIds = await seedBooking({
      ids,
      seats: [{ unitCents: 33333 }, { unitCents: 33333 }, { unitCents: 33334 }],
      totalCents: 100000,
    });

    for (const regId of regIds) {
      await cancelRegistration(BASE_ENV, { portalId: ids.portalId, registrationId: regId });
    }

    const order = await BASE_ENV.DB.prepare(
      'SELECT status, refunded_cents FROM orders WHERE id = ?1',
    )
      .bind(ids.orderId)
      .first<{ status: string; refunded_cents: number }>();
    expect(order).toEqual({ status: 'refunded', refunded_cents: 100000 });
  });

  it('refunds nothing for a voucher-covered seat, and hands the voucher back', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    // Two seats, one covered by a training voucher: the booking was invoiced $250 for one.
    const regIds = await seedBooking({
      ids,
      seats: [{ unitCents: 0, voucherSeats: 1 }, { unitCents: 25000 }],
      totalCents: 25000,
      memberCompanyId: '9001',
      voucherSeatsRedeemed: 1,
    });

    const result = await cancelRegistration(BASE_ENV, {
      portalId: ids.portalId,
      registrationId: regIds[0],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // No money was taken for this seat — the money was taken when the voucher was sold.
    expect(result.refund).toMatchObject({ kind: 'none', amountCents: 0, basis: 'seat' });
    // The voucher comes back instead.
    expect(result.vouchers).toEqual({ seats: 1, cents: 0, companyId: '9001' });

    // Usage is summed over the ORDER's redemption, so the balance recovers by the order
    // recording that it now redeems one voucher fewer.
    const order = await BASE_ENV.DB.prepare(
      'SELECT status, refunded_cents, voucher_seats_redeemed FROM orders WHERE id = ?1',
    )
      .bind(ids.orderId)
      .first<{ status: string; refunded_cents: number; voucher_seats_redeemed: number }>();
    expect(order).toEqual({
      status: 'paid',
      refunded_cents: 0,
      voucher_seats_redeemed: 0,
    });
    // And the seat stops claiming it, so the decomposition still adds up.
    const seat = await BASE_ENV.DB.prepare(
      'SELECT voucher_seats, voucher_cents FROM registrations WHERE id = ?1',
    )
      .bind(regIds[0])
      .first<{ voucher_seats: number; voucher_cents: number }>();
    expect(seat).toEqual({ voucher_seats: 0, voucher_cents: 0 });

    // The company's HubSpot record is re-projected.
    const sync = await BASE_ENV.DB.prepare(
      `SELECT payload FROM outbox WHERE topic = 'company.sync_voucher_usage' AND portal_id = ?1`,
    )
      .bind(ids.portalId)
      .first<{ payload: string }>();
    expect(JSON.parse(sync?.payload ?? '{}').companyId).toBe('9001');
  });

  it('returns credit rather than a voucher count under credit mode', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    const regIds = await seedBooking({
      ids,
      seats: [
        { unitCents: 0, voucherCents: 25000 },
        { unitCents: 0, voucherCents: 10000 },
      ],
      totalCents: 0,
      memberCompanyId: '9002',
      voucherCreditCents: 35000,
    });

    const result = await cancelRegistration(BASE_ENV, {
      portalId: ids.portalId,
      registrationId: regIds[0],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.vouchers).toEqual({ seats: 0, cents: 25000, companyId: '9002' });

    const order = await BASE_ENV.DB.prepare('SELECT voucher_credit_cents FROM orders WHERE id = ?1')
      .bind(ids.orderId)
      .first<{ voucher_credit_cents: number }>();
    // Only the cancelled seat's own credit comes back; the colleague's stays spent.
    expect(order?.voucher_credit_cents).toBe(10000);
  });

  it('leaves an ordinary seat’s vouchers alone on a partly-covered booking', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    const regIds = await seedBooking({
      ids,
      seats: [{ unitCents: 0, voucherSeats: 1 }, { unitCents: 25000 }],
      totalCents: 25000,
      memberCompanyId: '9003',
      voucherSeatsRedeemed: 1,
    });

    // Cancel the PAID seat: money comes back, the colleague's voucher does not.
    const result = await cancelRegistration(BASE_ENV, {
      portalId: ids.portalId,
      registrationId: regIds[1],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.refund.amountCents).toBe(25000);
    expect(result.vouchers).toEqual({ seats: 0, cents: 0, companyId: null });

    const order = await BASE_ENV.DB.prepare(
      'SELECT voucher_seats_redeemed FROM orders WHERE id = ?1',
    )
      .bind(ids.orderId)
      .first<{ voucher_seats_redeemed: number }>();
    expect(order?.voucher_seats_redeemed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Bookings taken before the record existed
// ---------------------------------------------------------------------------

describe('a booking with no seat record', () => {
  it('falls back to the booking share, and says so', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    const regIds = await seedBooking({
      ids,
      seats: [{ unitCents: null }, { unitCents: null }, { unitCents: null }, { unitCents: null }],
      totalCents: 60000,
    });

    const result = await cancelRegistration(BASE_ENV, {
      portalId: ids.portalId,
      registrationId: regIds[0],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // $600 over four live seats. An estimate, and labelled as one.
    expect(result.refund).toMatchObject({
      amountCents: 15000,
      seatAmountCents: 15000,
      basis: 'order_share',
    });
  });

  it('splits legacy voucher redemption the order still records', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    // The order redeemed two vouchers; not one of its seats accounts for any of it, which
    // is exactly what a pre-0028 booking looks like.
    const regIds = await seedBooking({
      ids,
      seats: [{ unitCents: null }, { unitCents: null }],
      totalCents: 0,
      memberCompanyId: '9004',
      voucherSeatsRedeemed: 2,
    });

    const first = await cancelRegistration(BASE_ENV, {
      portalId: ids.portalId,
      registrationId: regIds[0],
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.vouchers).toEqual({ seats: 1, cents: 0, companyId: '9004' });

    const second = await cancelRegistration(BASE_ENV, {
      portalId: ids.portalId,
      registrationId: regIds[1],
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.vouchers).toEqual({ seats: 1, cents: 0, companyId: '9004' });

    // Both back, and not one more than was taken.
    const order = await BASE_ENV.DB.prepare(
      'SELECT voucher_seats_redeemed FROM orders WHERE id = ?1',
    )
      .bind(ids.orderId)
      .first<{ voucher_seats_redeemed: number }>();
    expect(order?.voucher_seats_redeemed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The backfill, run as written
// ---------------------------------------------------------------------------

describe('migration 0028 backfill', () => {
  const backfill = BACKFILL_0028;

  it('hands the priced lines out to the seats that share them, and sums exactly', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    const now = new Date().toISOString();

    // A four-seat booking of one ticket type, two of them voucher-covered: the exact shape
    // the aggregate cannot describe, and the reason this record was added.
    await BASE_ENV.DB.prepare(
      `INSERT INTO reservations
         (id, portal_id, event_id, idempotency_key, status, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?1, 'confirmed', ?4, ?4)`,
    )
      .bind(ids.reservationId, ids.portalId, ids.eventId, now)
      .run();
    for (const [i, line] of [
      { quantity: 2, unitCents: 0 },
      { quantity: 2, unitCents: 25000 },
    ].entries()) {
      await BASE_ENV.DB.prepare(
        `INSERT INTO reservation_items (id, portal_id, reservation_id, ticket_type_id, quantity, unit_cents)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
        .bind(
          `${ids.reservationId}-li-${i}`,
          ids.portalId,
          ids.reservationId,
          ids.ticketTypeId,
          line.quantity,
          line.unitCents,
        )
        .run();
    }
    await BASE_ENV.DB.prepare(
      `INSERT INTO orders (id, portal_id, event_id, reservation_id, status, buyer_email,
         buyer_name, total_cents, currency, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'paid', 'buyer@weld.test', 'Buyer', 50000, 'AUD', ?5, ?5)`,
    )
      .bind(ids.orderId, ids.portalId, ids.eventId, ids.reservationId, now)
      .run();
    for (let i = 0; i < 4; i++) {
      await BASE_ENV.DB.prepare(
        `INSERT INTO registrations (id, portal_id, order_id, event_id, ticket_type_id,
           attendee_email, attendee_name, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
      )
        .bind(
          `${ids.orderId}-legacy-${i}`,
          ids.portalId,
          ids.orderId,
          ids.eventId,
          ids.ticketTypeId,
          `legacy${i}@weld.test`,
          `Legacy ${i}`,
          // Distinct timestamps so the deterministic ordering has something to order by.
          new Date(Date.now() + i * 1000).toISOString(),
        )
        .run();
    }

    await BASE_ENV.DB.prepare(backfill).run();

    const rows = await BASE_ENV.DB.prepare(
      'SELECT unit_cents FROM registrations WHERE order_id = ?1 ORDER BY created_at ASC, id ASC',
    )
      .bind(ids.orderId)
      .all<{ unit_cents: number | null }>();
    const values = rows.results.map((r) => r.unit_cents);

    // Two zeroed seats and two priced ones — which SEAT got which is arbitrary and
    // unrecoverable, but the money is exactly right, and that is what a refund reads.
    expect(values).toEqual([0, 0, 25000, 25000]);
    expect(values.reduce((sum, v) => (sum ?? 0) + (v ?? 0), 0)).toBe(50000);

    // Re-running writes nothing: the only write is to rows still NULL.
    await BASE_ENV.DB.prepare(backfill).run();
    const again = await BASE_ENV.DB.prepare(
      'SELECT unit_cents FROM registrations WHERE order_id = ?1 ORDER BY created_at ASC, id ASC',
    )
      .bind(ids.orderId)
      .all<{ unit_cents: number | null }>();
    expect(again.results.map((r) => r.unit_cents)).toEqual(values);
  });

  it('leaves a seat it cannot price as NULL, so the fallback stays reachable', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    const now = new Date().toISOString();

    // An order with no reservation behind it — nothing to hand out.
    await BASE_ENV.DB.prepare(
      `INSERT INTO orders (id, portal_id, event_id, reservation_id, status, buyer_email,
         buyer_name, total_cents, currency, created_at, updated_at)
       VALUES (?1, ?2, ?3, NULL, 'paid', 'buyer@weld.test', 'Buyer', 45000, 'AUD', ?4, ?4)`,
    )
      .bind(ids.orderId, ids.portalId, ids.eventId, now)
      .run();
    await BASE_ENV.DB.prepare(
      `INSERT INTO registrations (id, portal_id, order_id, event_id, ticket_type_id,
         attendee_email, attendee_name, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'orphan@weld.test', 'Orphan', ?6, ?6)`,
    )
      .bind(`${ids.orderId}-orphan`, ids.portalId, ids.orderId, ids.eventId, ids.ticketTypeId, now)
      .run();

    await BASE_ENV.DB.prepare(backfill).run();

    const row = await BASE_ENV.DB.prepare('SELECT unit_cents FROM registrations WHERE id = ?1')
      .bind(`${ids.orderId}-orphan`)
      .first<{ unit_cents: number | null }>();
    // NULL, not 0 — "not recoverable" must not read as "this seat was free".
    expect(row?.unit_cents).toBeNull();
  });
});
