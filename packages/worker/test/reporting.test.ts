import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { listEventAttendance, summariseAttendance } from '../src/attendance-writeback';
import {
  csvEscape,
  csvFilename,
  listEventRegistrations,
  normaliseRangeBound,
  registrationsToCsv,
  summariseMoney,
  summariseRegistrations,
} from '../src/reporting';
import reportingSource from '../src/reporting.ts?raw';
import { manageRoutes } from '../src/routes/manage';
import type { Env } from '../src/types';

/**
 * Phase 2.2 — registration reporting and export.
 *
 * The brief's two acceptance criteria are the two things this file exists to hold:
 *
 *   1. "The CSV matches a hand count for a known event." The fixture below IS the hand
 *      count — a deliberately awkward event whose seats are in every state the engine can
 *      produce (paid, awaiting payment, oversell review, refunded, a bulk booking, an
 *      attendee who walked in and was refunded afterwards) with the right answer written
 *      out longhand. Every surface is then checked against it.
 *   2. "The roll-up reconciles to the per-event lists." Asserted directly, per field.
 *
 * The third property, less visible and easier to lose: the report and the Phase 2.1
 * attendance endpoint must bucket the same seat the same way. They share one derivation
 * precisely so they can't drift, and a test here holds them together.
 */

const BASE_ENV = env as unknown as Env;

let counter = 0;
function freshIds() {
  const n = `${Date.now()}-${counter++}`;
  return {
    portalId: `rep-${n}`,
    adminKey: `admin-${n}`,
    eventId: `evt-rep-${n}`,
    hubspotEventId: `hs-rep-${n}`,
    ticketTypeId: `tt-rep-${n}`,
    premiumTicketTypeId: `tt-rep-prem-${n}`,
  };
}

type Ids = ReturnType<typeof freshIds>;

function envFor(ids: Ids): Env {
  return {
    ...(BASE_ENV as unknown as Record<string, unknown>),
    [`ADMIN_API_KEY_${ids.portalId}`]: ids.adminKey,
  } as unknown as Env;
}

function adminHeaders(ids: Ids) {
  return { 'X-Portal-Id': ids.portalId, Authorization: `Bearer ${ids.adminKey}` };
}

const tryRun = async (sql: string): Promise<void> => {
  try {
    await BASE_ENV.DB.prepare(sql).run();
  } catch {
    // Column/table already present — another test file created it first.
  }
};

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

interface SeatSpec {
  name: string;
  email: string;
  orderId: string;
  orderStatus: string;
  totalCents: number;
  refundedCents?: number;
  ticketTypeId?: string;
  /** Issue a ticket and scan it — a door arrival. */
  checkedIn?: boolean;
  /** Write a matched me.attend outbox row — the online-event equivalent of a scan. */
  webinarJoinedAt?: string;
  ticketStatus?: string;
  /** State of this seat's me.register outbox row; omitted = no row was ever written. */
  meRegisterStatus?: string;
  phone?: string;
  suburb?: string;
  state?: string;
  voucherSeats?: number;
  voucherCreditCents?: number;
}

async function seedTenant(ids: Ids): Promise<void> {
  await tryRun(
    `INSERT OR IGNORE INTO tenants (portal_id, display_name) VALUES ('${ids.portalId}', 'Test Tenant')`,
  );
}

async function seedEvent(
  ids: Ids,
  opts: { eventId?: string; title?: string; category?: string | null; startsAt?: string } = {},
): Promise<string> {
  const eventId = opts.eventId ?? ids.eventId;
  const startsAt = opts.startsAt ?? '2026-05-14T00:30:00Z';
  await BASE_ENV.DB.prepare(
    `INSERT INTO events
       (id, portal_id, hubspot_event_id, title, starts_at, ends_at, location, capacity,
        booking_kind, category, allow_oversell, marketing_event_completed, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'Adelaide', 50, 'course', ?7, 0, 0, ?5, ?5)`,
  )
    .bind(
      eventId,
      ids.portalId,
      `${ids.hubspotEventId}-${eventId}`,
      opts.title ?? 'Welding Fundamentals',
      startsAt,
      '2026-05-14T08:30:00Z',
      opts.category === undefined ? 'welding' : opts.category,
    )
    .run();
  return eventId;
}

async function seedTicketType(
  ids: Ids,
  eventId: string,
  ticketTypeId: string,
  name: string,
  priceCents: number,
): Promise<void> {
  await BASE_ENV.DB.prepare(
    `INSERT INTO ticket_types
       (id, portal_id, event_id, name, price_cents, currency, capacity, tax_treatment,
        member_only, sort_order, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'AUD', 50, 'gst', 0, 0, '2026-01-01T00:00:00Z')`,
  )
    .bind(ticketTypeId, ids.portalId, eventId, name, priceCents)
    .run();
}

/** One seat, written straight to D1 in whatever state the case under test needs. */
async function seedSeat(ids: Ids, eventId: string, seat: SeatSpec, index: number): Promise<string> {
  const regId = `${eventId}-reg-${index}`;
  const createdAt = `2026-04-0${index + 1}T00:00:00Z`;

  const existing = await BASE_ENV.DB.prepare('SELECT id FROM orders WHERE id = ?1')
    .bind(seat.orderId)
    .first();
  if (!existing) {
    await BASE_ENV.DB.prepare(
      `INSERT INTO orders
         (id, portal_id, event_id, status, buyer_email, buyer_name, total_cents,
          refunded_cents, currency, voucher_seats_redeemed, voucher_credit_cents,
          created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'AUD', ?9, ?10, ?11, ?11)`,
    )
      .bind(
        seat.orderId,
        ids.portalId,
        eventId,
        seat.orderStatus,
        `buyer-${seat.orderId}@weld.test`,
        `Buyer ${seat.orderId}`,
        seat.totalCents,
        seat.refundedCents ?? 0,
        seat.voucherSeats ?? 0,
        seat.voucherCreditCents ?? 0,
        createdAt,
      )
      .run();
  }

  await BASE_ENV.DB.prepare(
    `INSERT INTO registrations
       (id, portal_id, order_id, event_id, ticket_type_id, attendee_email, attendee_name,
        attendee_phone, attendee_suburb, attendee_state, marketing_event_state_synced,
        created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, ?11, ?11)`,
  )
    .bind(
      regId,
      ids.portalId,
      seat.orderId,
      eventId,
      seat.ticketTypeId ?? ids.ticketTypeId,
      seat.email,
      seat.name,
      seat.phone ?? null,
      seat.suburb ?? null,
      seat.state ?? null,
      createdAt,
    )
    .run();

  if (seat.checkedIn || seat.ticketStatus) {
    const ticketId = `${regId}-ticket`;
    await BASE_ENV.DB.prepare(
      `INSERT INTO tickets
         (id, portal_id, registration_id, order_id, event_id, ticket_type_id, status,
          qr_code, checked_in_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'qr', ?8, ?9)`,
    )
      .bind(
        ticketId,
        ids.portalId,
        regId,
        seat.orderId,
        eventId,
        seat.ticketTypeId ?? ids.ticketTypeId,
        seat.ticketStatus ?? (seat.checkedIn ? 'checked_in' : 'issued'),
        seat.checkedIn ? '2026-05-14T00:45:00Z' : null,
        createdAt,
      )
      .run();
    await BASE_ENV.DB.prepare('UPDATE registrations SET ticket_id = ?1 WHERE id = ?2')
      .bind(ticketId, regId)
      .run();
  }

  if (seat.meRegisterStatus) {
    await BASE_ENV.DB.prepare(
      `INSERT INTO outbox (id, portal_id, topic, payload, status, created_at)
       VALUES (?1, ?2, 'me.register', ?3, ?4, ?5)`,
    )
      .bind(
        `${regId}-me-register`,
        ids.portalId,
        JSON.stringify({ registrationId: regId }),
        seat.meRegisterStatus,
        createdAt,
      )
      .run();
  }

  if (seat.webinarJoinedAt) {
    await BASE_ENV.DB.prepare(
      `INSERT INTO outbox (id, portal_id, topic, payload, status,
         stable_interaction_datetime, created_at)
       VALUES (?1, ?2, 'me.attend', ?3, 'pending', ?4, ?4)`,
    )
      .bind(
        `${regId}-outbox`,
        ids.portalId,
        JSON.stringify({ registrationId: regId }),
        seat.webinarJoinedAt,
      )
      .run();
  }

  return regId;
}

// ---------------------------------------------------------------------------
// The hand count
// ---------------------------------------------------------------------------

/**
 * A known event, counted by hand.
 *
 * Nine seats across seven orders, chosen so every bucket is exercised and so the two
 * easiest reporting mistakes are both live in the fixture:
 *
 *   - Orders `ord-bulk` carries THREE seats at $2,505 for the booking. A report that sums
 *     the order total per attendee row reports $7,515 for it.
 *   - Kim attended and was refunded afterwards. A report that treats "cancelled" as the
 *     final word loses a person who was in the room.
 *
 * By hand:
 *   total            9
 *   confirmed        5  (Ada, Ben, and the three on ord-bulk)
 *   awaitingPayment  1  (Cal — invoice out, bank transfer not in)
 *   needsReview      1  (Dee — oversell, money taken, seat withheld)
 *   cancelled        2  (Eli refunded, Kim refunded-after-attending)
 *   attended         3  (Ada scanned in, Ben joined the webinar, Kim scanned in)
 *   registered       8  (9 - 1: only Eli was cancelled AND absent; Kim came anyway)
 *   notYetArrived    5  (8 - 3)
 *   seatsHeld        7  (5 confirmed + 1 awaiting + 1 needs review)
 *   distinctContacts 9  (nine different people — no one booked twice here)
 *   notSynced        1  (Dee's me.register row went dead — HubSpot never heard of her)
 *
 *   orders           7 distinct
 *   collected     $835 + $835 + $2,505 + $835 + $835 = $5,845   (Ada, Ben, bulk, Dee, Eli)
 *                 + Kim $835 = $6,680
 *   awaiting      $835 (Cal)
 *   refunded      $835 (Eli) + $835 (Kim) = $1,670
 *   net           $6,680 - $1,670 = $5,010
 */
const HAND_COUNT = {
  total: 9,
  confirmed: 5,
  awaitingPayment: 1,
  needsReview: 1,
  cancelled: 2,
  attended: 3,
  registered: 8,
  notYetArrived: 5,
  seatsHeld: 7,
  notSyncedToMarketingEvent: 1,
  // Every seat in this fixture has somebody on it; a company block (Ref 74b) is counted
  // by `unnamed-seats.test.ts`.
  unnamedSeats: 0,
  distinctContacts: 9,
  orders: 7,
  collectedCents: 668_000,
  awaitingPaymentCents: 83_500,
  refundedCents: 167_000,
  netCents: 501_000,
};

function handCountSeats(ids: Ids): SeatSpec[] {
  return [
    // Paid, scanned in at the door.
    {
      name: 'Ada Nguyen',
      email: 'ada@weld.test',
      orderId: `${ids.eventId}-ord-ada`,
      orderStatus: 'paid',
      totalCents: 83_500,
      checkedIn: true,
      meRegisterStatus: 'delivered',
      phone: '0412 345 678',
      suburb: 'Prospect',
      state: 'SA',
    },
    // Paid, joined online — attendance arrives as a matched me.attend record, not a scan.
    {
      name: 'Ben Okafor',
      email: 'ben@weld.test',
      orderId: `${ids.eventId}-ord-ben`,
      orderStatus: 'paid',
      totalCents: 83_500,
      meRegisterStatus: 'delivered',
      webinarJoinedAt: '2026-05-14T00:32:00Z',
    },
    // Invoice out, bank transfer not in. A real seat that is not yet money.
    {
      name: 'Cal Rivera',
      email: 'cal@weld.test',
      orderId: `${ids.eventId}-ord-cal`,
      orderStatus: 'pending',
      totalCents: 83_500,
      meRegisterStatus: 'delivered',
    },
    // Late-payment oversell: money taken, seat withheld pending an owner decision.
    {
      name: 'Dee Farrow',
      email: 'dee@weld.test',
      orderId: `${ids.eventId}-ord-dee`,
      orderStatus: 'needs_review',
      totalCents: 83_500,
      meRegisterStatus: 'dead',
    },
    // Refunded and never turned up.
    {
      name: 'Eli Barnes',
      email: 'eli@weld.test',
      orderId: `${ids.eventId}-ord-eli`,
      orderStatus: 'refunded',
      totalCents: 83_500,
      refundedCents: 83_500,
      meRegisterStatus: 'delivered',
      ticketStatus: 'cancelled',
    },
    // Walked in the door, refunded afterwards. Attending is a fact.
    {
      name: 'Kim Alvarez',
      email: 'kim@weld.test',
      orderId: `${ids.eventId}-ord-kim`,
      orderStatus: 'refunded',
      totalCents: 83_500,
      refundedCents: 83_500,
      meRegisterStatus: 'delivered',
      checkedIn: true,
    },
    // One corporate booking, three seats, one order total.
    ...['Ivy Chen', 'Jon Petrov', 'Lia Moss'].map((name) => ({
      name,
      email: `${name.split(' ')[0].toLowerCase()}@bigco.test`,
      orderId: `${ids.eventId}-ord-bulk`,
      orderStatus: 'paid',
      totalCents: 250_500,
      voucherSeats: 3,
      meRegisterStatus: 'delivered',
    })),
  ];
}

async function seedHandCountEvent(ids: Ids): Promise<void> {
  await seedTenant(ids);
  await seedEvent(ids);
  await seedTicketType(ids, ids.eventId, ids.ticketTypeId, 'Standard', 83_500);
  const seats = handCountSeats(ids);
  for (let i = 0; i < seats.length; i++) {
    await seedSeat(ids, ids.eventId, seats[i], i);
  }
}

// ---------------------------------------------------------------------------

describe('per-event registration list (Phase 2.2)', () => {
  it('counts a known event exactly as it counts by hand', async () => {
    const ids = freshIds();
    await seedHandCountEvent(ids);

    const rows = await listEventRegistrations(BASE_ENV, ids.portalId, ids.eventId);
    expect(rows).toHaveLength(HAND_COUNT.total);

    const summary = summariseRegistrations(rows);
    expect(summary).toEqual({
      total: HAND_COUNT.total,
      confirmed: HAND_COUNT.confirmed,
      awaitingPayment: HAND_COUNT.awaitingPayment,
      needsReview: HAND_COUNT.needsReview,
      cancelled: HAND_COUNT.cancelled,
      attended: HAND_COUNT.attended,
      registered: HAND_COUNT.registered,
      notYetArrived: HAND_COUNT.notYetArrived,
      seatsHeld: HAND_COUNT.seatsHeld,
      notSyncedToMarketingEvent: HAND_COUNT.notSyncedToMarketingEvent,
      unnamedSeats: HAND_COUNT.unnamedSeats,
      distinctContacts: HAND_COUNT.distinctContacts,
    });

    // The four seat buckets partition the total — the property that lets a reader trust
    // the arithmetic, and the one that makes a gap against another system locatable.
    expect(
      summary.confirmed + summary.awaitingPayment + summary.needsReview + summary.cancelled,
    ).toBe(summary.total);
  });

  it('sums money over distinct orders, not over attendee rows', async () => {
    const ids = freshIds();
    await seedHandCountEvent(ids);

    const rows = await listEventRegistrations(BASE_ENV, ids.portalId, ids.eventId);
    const money = summariseMoney(rows);

    expect(money.orders).toBe(HAND_COUNT.orders);
    expect(money.collectedCents).toBe(HAND_COUNT.collectedCents);
    expect(money.awaitingPaymentCents).toBe(HAND_COUNT.awaitingPaymentCents);
    expect(money.refundedCents).toBe(HAND_COUNT.refundedCents);
    expect(money.netCents).toBe(HAND_COUNT.netCents);
    expect(money.currency).toBe('AUD');

    // The three-seat corporate booking is counted once. Summing per row would give
    // $2,505 x 3 for that order alone.
    const bulkRows = rows.filter((row) => row.order_id === `${ids.eventId}-ord-bulk`);
    expect(bulkRows).toHaveLength(3);
    expect(money.collectedCents).toBeLessThan(
      rows.reduce((sum, row) => sum + row.order_total_cents, 0),
    );
    // Vouchers are an order fact too, and are de-duplicated the same way.
    expect(money.voucherSeatsRedeemed).toBe(3);
  });

  it('keeps someone who attended and was refunded afterwards as attended', async () => {
    const ids = freshIds();
    await seedHandCountEvent(ids);

    const rows = await listEventRegistrations(BASE_ENV, ids.portalId, ids.eventId);
    const kim = rows.find((row) => row.attendee_email === 'kim@weld.test');

    expect(kim?.attended).toBe(true);
    expect(kim?.status).toBe('attended');
    // Both are true of her, and the report says both.
    expect(kim?.seat_cancelled).toBe(true);
    expect(kim?.attendance_source).toBe('checkin');
    // The refund is still visible — it just doesn't rewrite history.
    expect(kim?.order_status).toBe('refunded');
    expect(kim?.payment_status).toBe('refunded');
  });

  it('reads attendance for an online seat from the matched me.attend record', async () => {
    const ids = freshIds();
    await seedHandCountEvent(ids);

    const rows = await listEventRegistrations(BASE_ENV, ids.portalId, ids.eventId);
    const ben = rows.find((row) => row.attendee_email === 'ben@weld.test');

    expect(ben?.attended).toBe(true);
    expect(ben?.attendance_source).toBe('marketing_event');
    expect(ben?.attended_at).toBe('2026-05-14T00:32:00Z');
  });

  it('buckets a seat exactly as the Phase 2.1 attendance endpoint does', async () => {
    const ids = freshIds();
    await seedHandCountEvent(ids);

    const report = await listEventRegistrations(BASE_ENV, ids.portalId, ids.eventId);
    const attendance = await listEventAttendance(BASE_ENV, ids.portalId, ids.eventId);
    const attendanceSummary = summariseAttendance(attendance);
    const reportSummary = summariseRegistrations(report);

    // The vocabulary the two endpoints share has to mean the same thing in both.
    expect(reportSummary.registered).toBe(attendanceSummary.registered);
    expect(reportSummary.attended).toBe(attendanceSummary.attended);
    expect(reportSummary.notYetArrived).toBe(attendanceSummary.notYetArrived);

    // The one figure that legitimately differs, pinned rather than glossed over: the
    // report counts CANCELLED BOOKINGS (2 — Eli and Kim), the attendance endpoint counts
    // people whose final state is cancelled (1 — Kim attended, so she isn't one). The gap
    // is exactly the people who were refunded and turned up anyway.
    expect(reportSummary.cancelled - attendanceSummary.cancelled).toBe(
      report.filter((row) => row.seat_cancelled && row.attended).length,
    );

    // And per seat, not just in aggregate.
    const byId = new Map(attendance.map((row) => [row.registrationId, row]));
    for (const row of report) {
      expect(row.status).toBe(byId.get(row.id)?.status);
      expect(row.attended).toBe(byId.get(row.id)?.attended);
      expect(row.attended_at).toBe(byId.get(row.id)?.attendedAt ?? null);
    }
  });

  it('carries the Phase 1.2 contact capture and the Phase 1.3 staff notes', async () => {
    const ids = freshIds();
    await seedHandCountEvent(ids);
    const adaId = `${ids.eventId}-reg-0`;

    await BASE_ENV.DB.prepare(
      `INSERT INTO registration_notes (id, portal_id, registration_id, author, body, created_at)
       VALUES (?1, ?2, ?3, 'hs-user-7', 'Rang to say she will be late.', '2026-05-01T00:00:00Z')`,
    )
      .bind(`${ids.eventId}-note-1`, ids.portalId, adaId)
      .run();
    await BASE_ENV.DB.prepare(
      `INSERT INTO registration_notes (id, portal_id, order_id, author, body, created_at)
       VALUES (?1, ?2, ?3, 'hs-user-7', 'Invoice going to head office.', '2026-05-02T00:00:00Z')`,
    )
      .bind(`${ids.eventId}-note-2`, ids.portalId, `${ids.eventId}-ord-bulk`)
      .run();

    const rows = await listEventRegistrations(BASE_ENV, ids.portalId, ids.eventId);
    const ada = rows.find((row) => row.id === adaId);

    expect(ada?.attendee_phone).toBe('0412 345 678');
    expect(ada?.attendee_suburb).toBe('Prospect');
    expect(ada?.attendee_state).toBe('SA');
    expect(ada?.notes.map((note) => note.body)).toEqual(['Rang to say she will be late.']);

    // A note against the ORDER is about the booking, so it shows against all three seats
    // on it — it is not a fact about one of those three people.
    const bulk = rows.filter((row) => row.order_id === `${ids.eventId}-ord-bulk`);
    expect(bulk).toHaveLength(3);
    for (const row of bulk) {
      expect(row.notes_count).toBe(1);
      expect(row.notes[0]).toMatchObject({ scope: 'order', body: 'Invoice going to head office.' });
    }
  });

  it('joins the ticket type OUTWARD, so a seat is never dropped for want of one', () => {
    // Losing a row from an attendee list is the worst thing this report can do, and an
    // inner join would do it silently.
    //
    // Asserted against the shipped SQL rather than through a fixture, because D1 enforces
    // foreign keys and ignores `PRAGMA foreign_keys = OFF`: `registrations.ticket_type_id`
    // REFERENCES `ticket_types(id)`, so a seat naming a type that is not there cannot be
    // inserted and the type cannot be deleted out from under one. What CAN still produce a
    // null is the portal half of the join — a type row belonging to another tenant — and
    // that is the clause below, which an inner join would turn into a dropped attendee.
    expect(reportingSource).toMatch(
      /LEFT JOIN ticket_types tt ON tt\.id = r\.ticket_type_id AND tt\.portal_id = r\.portal_id/,
    );
  });
});

describe('the D1 to HubSpot gap is locatable, not just visible', () => {
  it('names the seats HubSpot never heard about', async () => {
    const ids = freshIds();
    await seedHandCountEvent(ids);

    const rows = await listEventRegistrations(BASE_ENV, ids.portalId, ids.eventId);
    const summary = summariseRegistrations(rows);

    // The engine sold Dee a seat and her me.register row went dead, so HubSpot's marketing
    // event is one registration short. That is a locatable gap rather than "the numbers
    // disagree" — the argument this phase exists to end.
    expect(summary.notSyncedToMarketingEvent).toBe(1);
    const stranded = rows.filter((row) => row.marketing_event_sync !== 'delivered');
    expect(stranded.map((row) => row.attendee_email)).toEqual(['dee@weld.test']);
    expect(stranded[0].marketing_event_sync).toBe('dead');
  });

  it('distinguishes a row still draining from one that gave up, and from one never written', async () => {
    const ids = freshIds();
    await seedTenant(ids);
    await seedEvent(ids);
    await seedTicketType(ids, ids.eventId, ids.ticketTypeId, 'Standard', 83_500);

    const seats: SeatSpec[] = [
      // Still queued: HubSpot catches up on its own, so this is not a discrepancy yet.
      {
        name: 'Pending Pat',
        email: 'pat@weld.test',
        orderId: `${ids.eventId}-ord-pat`,
        orderStatus: 'paid',
        totalCents: 83_500,
        meRegisterStatus: 'pending',
      },
      // Retrying — same thing as far as a reconciliation is concerned.
      {
        name: 'Failing Fran',
        email: 'fran@weld.test',
        orderId: `${ids.eventId}-ord-fran`,
        orderStatus: 'paid',
        totalCents: 83_500,
        meRegisterStatus: 'failed',
      },
      // No outbox row at all. Outbox rows are never purged, so this is a real finding.
      {
        name: 'Silent Sal',
        email: 'sal@weld.test',
        orderId: `${ids.eventId}-ord-sal`,
        orderStatus: 'paid',
        totalCents: 83_500,
      },
    ];
    for (let i = 0; i < seats.length; i++) await seedSeat(ids, ids.eventId, seats[i], i);

    const rows = await listEventRegistrations(BASE_ENV, ids.portalId, ids.eventId);
    const byEmail = Object.fromEntries(rows.map((row) => [row.attendee_email, row]));

    expect(byEmail['pat@weld.test'].marketing_event_sync).toBe('pending');
    expect(byEmail['fran@weld.test'].marketing_event_sync).toBe('pending');
    expect(byEmail['sal@weld.test'].marketing_event_sync).toBe('never_enqueued');
    expect(summariseRegistrations(rows).notSyncedToMarketingEvent).toBe(3);
  });

  it('carries the sync state into the CSV', async () => {
    const ids = freshIds();
    await seedHandCountEvent(ids);

    const res = await manageRoutes.request(
      `/events/${ids.eventId}/registrations.csv`,
      { headers: adminHeaders(ids) },
      envFor(ids),
    );
    const csv = await res.text();
    expect(csv.split('\r\n')[0]).toContain('marketing_event_sync');
    expect(csv).toContain('dead');
  });
});

describe('every /stats surface reports the same numbers', () => {
  it('agrees with the report, and counts a webinar join as attendance', async () => {
    const ids = freshIds();
    await seedHandCountEvent(ids);

    const rows = await listEventRegistrations(BASE_ENV, ids.portalId, ids.eventId);
    const expected = summariseRegistrations(rows);

    const res = await manageRoutes.request(
      `/events/${ids.eventId}/stats`,
      { headers: adminHeaders(ids) },
      envFor(ids),
    );
    expect(res.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: stats shape asserted field by field
    const stats = (await res.json()) as any;

    expect(stats.registered).toBe(expected.registered);
    expect(stats.attended).toBe(expected.attended);
    expect(stats.notYetArrived).toBe(expected.notYetArrived);
    expect(stats.summary).toEqual(expected);

    // Ben joined the webinar and never scanned a QR code. Counting attendance from
    // checked-in tickets alone reported him as still to arrive.
    expect(stats.attended).toBe(3);
  });

  it('leaves the seats an unpaid invoice is holding out of availableSeats', async () => {
    const ids = freshIds();
    await seedHandCountEvent(ids);

    const res = await manageRoutes.request(
      `/events/${ids.eventId}/stats`,
      { headers: adminHeaders(ids) },
      envFor(ids),
    );
    // biome-ignore lint/suspicious/noExplicitAny: stats shape asserted field by field
    const stats = (await res.json()) as any;

    // Capacity 50, 7 seats held (5 confirmed + Cal's unpaid invoice + Dee's oversell).
    // Counting only paid/confirmed would offer 45 seats, two of which the DO will refuse.
    expect(stats.capacity).toBe(50);
    expect(stats.summary.seatsHeld).toBe(HAND_COUNT.seatsHeld);
    expect(stats.availableSeats).toBe(50 - HAND_COUNT.seatsHeld);
  });

  it('reports null capacity for an uncapped event rather than sold out', async () => {
    const ids = freshIds();
    await seedTenant(ids);
    await BASE_ENV.DB.prepare(
      `INSERT INTO events
         (id, portal_id, hubspot_event_id, title, starts_at, ends_at, capacity,
          capacity_unlimited, booking_kind, category, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'Open Session', '2026-05-14T00:30:00Z', '2026-05-14T08:30:00Z',
               0, 1, 'course', 'welding', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    )
      .bind(ids.eventId, ids.portalId, ids.hubspotEventId)
      .run();

    const res = await manageRoutes.request(
      `/events/${ids.eventId}/stats`,
      { headers: adminHeaders(ids) },
      envFor(ids),
    );
    // biome-ignore lint/suspicious/noExplicitAny: stats shape asserted field by field
    const stats = (await res.json()) as any;
    expect(stats.capacity).toBeNull();
    expect(stats.availableSeats).toBeNull();
  });
});

describe('paginated list route', () => {
  it('pages the rows but always summarises the whole event', async () => {
    const ids = freshIds();
    await seedHandCountEvent(ids);

    const first = await manageRoutes.request(
      `/events/${ids.eventId}/registrations?limit=4`,
      { headers: adminHeaders(ids) },
      envFor(ids),
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Record<string, never>;

    expect((firstBody.registrations as unknown as unknown[]).length).toBe(4);
    expect(firstBody.page).toMatchObject({
      limit: 4,
      offset: 0,
      total: HAND_COUNT.total,
      returned: 4,
      hasMore: true,
    });
    // The headline count must not move because someone asked for a page.
    expect(firstBody.summary).toMatchObject({
      total: HAND_COUNT.total,
      attended: HAND_COUNT.attended,
    });

    const last = await manageRoutes.request(
      `/events/${ids.eventId}/registrations?limit=4&offset=8`,
      { headers: adminHeaders(ids) },
      envFor(ids),
    );
    const lastBody = (await last.json()) as Record<string, never>;
    expect(lastBody.page).toMatchObject({ returned: 1, hasMore: false });
    expect(lastBody.summary).toMatchObject({ total: HAND_COUNT.total });
  });

  it('404s an event belonging to another portal', async () => {
    const ids = freshIds();
    const other = freshIds();
    await seedHandCountEvent(ids);

    const res = await manageRoutes.request(
      `/events/${ids.eventId}/registrations`,
      { headers: adminHeaders(other) },
      envFor(other),
    );
    expect(res.status).toBe(404);
  });

  it('rejects an unauthenticated request', async () => {
    const ids = freshIds();
    await seedHandCountEvent(ids);

    const res = await manageRoutes.request(
      `/events/${ids.eventId}/registrations`,
      { headers: { 'X-Portal-Id': ids.portalId } },
      envFor(ids),
    );
    expect(res.status).toBe(401);
  });
});

describe('CSV export', () => {
  it('downloads one line per attendee, matching the hand count', async () => {
    const ids = freshIds();
    await seedHandCountEvent(ids);

    const res = await manageRoutes.request(
      `/events/${ids.eventId}/registrations.csv`,
      { headers: adminHeaders(ids) },
      envFor(ids),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/csv');
    expect(res.headers.get('Content-Disposition')).toContain('attachment');
    expect(res.headers.get('Content-Disposition')).toContain('welding-fundamentals');
    // A report answering a reconciliation out of cache is the failure this phase ends.
    expect(res.headers.get('Cache-Control')).toBe('no-store');

    const csv = await res.text();
    const lines = csv.trimEnd().split('\r\n');
    // Header + one row per attendee, and nobody dropped.
    expect(lines).toHaveLength(HAND_COUNT.total + 1);
    for (const seat of handCountSeats(ids)) {
      expect(csv).toContain(seat.email);
    }
  });

  it('is the whole event, not the first page', async () => {
    const ids = freshIds();
    await seedHandCountEvent(ids);

    // A ?limit on the CSV must not truncate it — a hand count is of everybody.
    const res = await manageRoutes.request(
      `/events/${ids.eventId}/registrations.csv?limit=2`,
      { headers: adminHeaders(ids) },
      envFor(ids),
    );
    const lines = (await res.text()).trimEnd().split('\r\n');
    expect(lines).toHaveLength(HAND_COUNT.total + 1);
  });

  it('writes money as an amount, not as raw cents', async () => {
    const ids = freshIds();
    await seedHandCountEvent(ids);

    const res = await manageRoutes.request(
      `/events/${ids.eventId}/registrations.csv`,
      { headers: adminHeaders(ids) },
      envFor(ids),
    );
    const csv = await res.text();
    // $835.00 — a column of `83500` summed by a finance person is out by 100x and still
    // looks plausible.
    expect(csv).toContain('835.00');
    expect(csv).not.toContain(',83500,');
  });

  it('neutralises a spreadsheet formula in staff-typed text', () => {
    // A staff note or an attendee name beginning with one of these is executed on open in
    // Excel and Sheets. Prefixing an apostrophe is the standard neutralisation.
    expect(csvEscape('=cmd|calc')).toBe("'=cmd|calc");
    expect(csvEscape('+1-555')).toBe("'+1-555");
    expect(csvEscape('-2+3')).toBe("'-2+3");
    expect(csvEscape('@SUM(A1)')).toBe("'@SUM(A1)");
    // A tab needs neutralising but not quoting — RFC 4180 quotes only commas,
    // quotes and newlines.
    expect(csvEscape('\t=danger')).toBe("'\t=danger");
  });

  it('quotes delimiters, quotes and newlines per RFC 4180', () => {
    expect(csvEscape('Smith, Jane')).toBe('"Smith, Jane"');
    expect(csvEscape('She said "no"')).toBe('"She said ""no"""');
    expect(csvEscape('line one\nline two')).toBe('"line one\nline two"');
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
  });

  it('keeps a multi-line note inside one cell', async () => {
    const ids = freshIds();
    await seedHandCountEvent(ids);
    await BASE_ENV.DB.prepare(
      `INSERT INTO registration_notes (id, portal_id, registration_id, author, body, created_at)
       VALUES (?1, ?2, ?3, 'hs-user-7', ?4, '2026-05-01T00:00:00Z')`,
    )
      .bind(
        `${ids.eventId}-note-multi`,
        ids.portalId,
        `${ids.eventId}-reg-0`,
        'Rang Monday.\nRang again Friday, all sorted.',
      )
      .run();

    const rows = await listEventRegistrations(BASE_ENV, ids.portalId, ids.eventId);
    const csv = registrationsToCsv(rows);
    // Still one line per attendee: the embedded newline is inside a quoted field, so the
    // row count a person reconciles against is unaffected.
    const dataLines = csv.trimEnd().split('\r\n');
    expect(dataLines).toHaveLength(HAND_COUNT.total + 1);
    expect(csv).toContain('Rang again Friday, all sorted.');
  });

  it('names the file after the event, falling back to the id', () => {
    expect(csvFilename('Welding Fundamentals', 'evt_1', '2026-05-14T00:00:00Z')).toBe(
      'registrations-welding-fundamentals-2026-05-14.csv',
    );
    expect(csvFilename('   ', 'evt_1', '2026-05-14T00:00:00Z')).toBe(
      'registrations-evt_1-2026-05-14.csv',
    );
  });
});

describe('cross-event roll-up', () => {
  /** Three events: two welding courses in the range, one fabrication course outside it. */
  async function seedRollup(ids: Ids) {
    await seedTenant(ids);
    const inRangeA = await seedEvent(ids, {
      eventId: `${ids.eventId}-a`,
      title: 'Welding Fundamentals',
      category: 'welding',
      startsAt: '2026-05-14T00:30:00Z',
    });
    const inRangeB = await seedEvent(ids, {
      eventId: `${ids.eventId}-b`,
      title: 'Welding Inspection',
      category: 'welding',
      startsAt: '2026-05-30T00:30:00Z',
    });
    const otherCategory = await seedEvent(ids, {
      eventId: `${ids.eventId}-c`,
      title: 'Fabrication Basics',
      category: 'fabrication',
      startsAt: '2026-05-20T00:30:00Z',
    });
    const outOfRange = await seedEvent(ids, {
      eventId: `${ids.eventId}-d`,
      title: 'Welding Fundamentals',
      category: 'welding',
      startsAt: '2026-07-02T00:30:00Z',
    });

    for (const eventId of [inRangeA, inRangeB, otherCategory, outOfRange]) {
      await seedTicketType(ids, eventId, `${eventId}-tt`, 'Standard', 83_500);
    }

    await seedSeat(
      ids,
      inRangeA,
      {
        name: 'Ada Nguyen',
        email: 'ada@weld.test',
        orderId: `${inRangeA}-ord-1`,
        orderStatus: 'paid',
        totalCents: 83_500,
        ticketTypeId: `${inRangeA}-tt`,
        checkedIn: true,
      },
      0,
    );
    await seedSeat(
      ids,
      inRangeA,
      {
        name: 'Ben Okafor',
        email: 'ben@weld.test',
        orderId: `${inRangeA}-ord-2`,
        orderStatus: 'pending',
        totalCents: 83_500,
        ticketTypeId: `${inRangeA}-tt`,
      },
      1,
    );
    await seedSeat(
      ids,
      inRangeB,
      {
        name: 'Cal Rivera',
        email: 'cal@weld.test',
        orderId: `${inRangeB}-ord-1`,
        orderStatus: 'paid',
        totalCents: 83_500,
        ticketTypeId: `${inRangeB}-tt`,
      },
      0,
    );
    await seedSeat(
      ids,
      otherCategory,
      {
        name: 'Dee Farrow',
        email: 'dee@weld.test',
        orderId: `${otherCategory}-ord-1`,
        orderStatus: 'paid',
        totalCents: 83_500,
        ticketTypeId: `${otherCategory}-tt`,
      },
      0,
    );
    await seedSeat(
      ids,
      outOfRange,
      {
        name: 'Eli Barnes',
        email: 'eli@weld.test',
        orderId: `${outOfRange}-ord-1`,
        orderStatus: 'paid',
        totalCents: 83_500,
        ticketTypeId: `${outOfRange}-tt`,
      },
      0,
    );

    return { inRangeA, inRangeB, otherCategory, outOfRange };
  }

  it('reconciles to the per-event lists, field by field', async () => {
    const ids = freshIds();
    await seedRollup(ids);

    const res = await manageRoutes.request(
      '/reports/registrations?from=2026-05-01&to=2026-05-31',
      { headers: adminHeaders(ids) },
      envFor(ids),
    );
    expect(res.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: report shape asserted field by field below
    const report = (await res.json()) as any;

    // Every event line in the roll-up must equal that event's own list — this is the
    // brief's second acceptance criterion, checked directly rather than in aggregate.
    for (const category of report.categories) {
      for (const event of category.events) {
        const rows = await listEventRegistrations(BASE_ENV, ids.portalId, event.eventId);
        expect(event.summary).toEqual(summariseRegistrations(rows));
        expect(event.money).toEqual(summariseMoney(rows));
      }
    }

    // And the totals must equal the sum of those lines.
    const eventLines = report.categories.flatMap(
      (category: { events: { summary: { total: number }; money: { orders: number } }[] }) =>
        category.events,
    );
    expect(report.summary.total).toBe(
      eventLines.reduce(
        (sum: number, line: { summary: { total: number } }) => sum + line.summary.total,
        0,
      ),
    );
    expect(report.money.orders).toBe(
      eventLines.reduce(
        (sum: number, line: { money: { orders: number } }) => sum + line.money.orders,
        0,
      ),
    );
  });

  it('groups by course category and honours the date range', async () => {
    const ids = freshIds();
    const events = await seedRollup(ids);

    const res = await manageRoutes.request(
      '/reports/registrations?from=2026-05-01&to=2026-05-31',
      { headers: adminHeaders(ids) },
      envFor(ids),
    );
    // biome-ignore lint/suspicious/noExplicitAny: report shape asserted field by field below
    const report = (await res.json()) as any;

    expect(report.eventCount).toBe(3);
    const categories = Object.fromEntries(
      // biome-ignore lint/suspicious/noExplicitAny: see above
      report.categories.map((category: any) => [category.category, category]),
    );
    expect(Object.keys(categories).sort()).toEqual(['fabrication', 'welding']);
    expect(categories.welding.eventCount).toBe(2);
    expect(categories.welding.summary.total).toBe(3);
    expect(categories.fabrication.eventCount).toBe(1);

    // The July course is outside the range and must not be in it.
    const allIds = report.categories.flatMap(
      // biome-ignore lint/suspicious/noExplicitAny: see above
      (category: any) => category.events.map((event: any) => event.eventId),
    );
    expect(allIds).not.toContain(events.outOfRange);
  });

  it('filters to one category', async () => {
    const ids = freshIds();
    await seedRollup(ids);

    const res = await manageRoutes.request(
      '/reports/registrations?category=fabrication',
      { headers: adminHeaders(ids) },
      envFor(ids),
    );
    // biome-ignore lint/suspicious/noExplicitAny: report shape asserted field by field below
    const report = (await res.json()) as any;
    expect(report.categories).toHaveLength(1);
    expect(report.categories[0].category).toBe('fabrication');
    expect(report.eventCount).toBe(1);
  });

  it('includes an event starting on the last day of the range', async () => {
    const ids = freshIds();
    await seedTenant(ids);
    // 08:00 UTC on the 31st. A bare `to=2026-05-31` compared as a string against
    // "2026-05-31T08:00:00Z" would drop this course and nobody would think to ask why.
    const eventId = await seedEvent(ids, {
      eventId: `${ids.eventId}-lastday`,
      startsAt: '2026-05-31T08:00:00Z',
    });
    await seedTicketType(ids, eventId, `${eventId}-tt`, 'Standard', 83_500);

    const res = await manageRoutes.request(
      '/reports/registrations?from=2026-05-01&to=2026-05-31',
      { headers: adminHeaders(ids) },
      envFor(ids),
    );
    // biome-ignore lint/suspicious/noExplicitAny: report shape asserted field by field below
    const report = (await res.json()) as any;
    expect(report.eventCount).toBe(1);
    // It has no registrations, and it still appears reporting zeroes. An event that
    // vanished from the roll-up because nobody booked it would read as a range that
    // covered fewer courses than it did.
    expect(report.categories[0].events[0].summary.total).toBe(0);
    expect(report.summary.total).toBe(0);
  });

  it('groups uncategorised events under a null category rather than dropping them', async () => {
    const ids = freshIds();
    await seedTenant(ids);
    const eventId = await seedEvent(ids, { eventId: `${ids.eventId}-nocat`, category: null });
    await seedTicketType(ids, eventId, `${eventId}-tt`, 'Standard', 83_500);
    await seedSeat(
      ids,
      eventId,
      {
        name: 'Ada Nguyen',
        email: 'ada@weld.test',
        orderId: `${eventId}-ord-1`,
        orderStatus: 'paid',
        totalCents: 83_500,
        ticketTypeId: `${eventId}-tt`,
      },
      0,
    );

    const res = await manageRoutes.request(
      '/reports/registrations',
      { headers: adminHeaders(ids) },
      envFor(ids),
    );
    // biome-ignore lint/suspicious/noExplicitAny: report shape asserted field by field below
    const report = (await res.json()) as any;
    expect(report.categories).toHaveLength(1);
    expect(report.categories[0].category).toBeNull();
    expect(report.categories[0].summary.total).toBe(1);
  });

  it('rejects a backwards range instead of silently reporting nothing', async () => {
    const ids = freshIds();
    await seedTenant(ids);

    const res = await manageRoutes.request(
      '/reports/registrations?from=2026-06-01&to=2026-05-01',
      { headers: adminHeaders(ids) },
      envFor(ids),
    );
    expect(res.status).toBe(400);
  });

  it('never reaches across portals', async () => {
    const ids = freshIds();
    const other = freshIds();
    await seedRollup(ids);
    await seedTenant(other);

    const res = await manageRoutes.request(
      '/reports/registrations',
      { headers: adminHeaders(other) },
      envFor(other),
    );
    // biome-ignore lint/suspicious/noExplicitAny: report shape asserted field by field below
    const report = (await res.json()) as any;
    expect(report.eventCount).toBe(0);
    expect(report.summary.total).toBe(0);
  });
});

describe('a course package is one booking across several events', () => {
  /**
   * A complete-course order holds seats on the parent course AND on every included module,
   * so the same order id appears in several events' registration lists. The money was
   * charged once, on the parent: the modules are $0 entitlement seats. Attributing it to
   * the order's own event is what stops a three-module course reporting four times its
   * revenue in the roll-up, and what stops a module's own report claiming money that was
   * never charged against it.
   */
  async function seedPackage(ids: Ids) {
    await seedTenant(ids);
    const parent = await seedEvent(ids, {
      eventId: `${ids.eventId}-course`,
      title: 'Complete Welding Certificate',
      startsAt: '2026-05-10T00:30:00Z',
    });
    const moduleOne = await seedEvent(ids, {
      eventId: `${ids.eventId}-mod-1`,
      title: 'Module 1',
      startsAt: '2026-05-12T00:30:00Z',
    });
    const moduleTwo = await seedEvent(ids, {
      eventId: `${ids.eventId}-mod-2`,
      title: 'Module 2',
      startsAt: '2026-05-18T00:30:00Z',
    });
    for (const eventId of [parent, moduleOne, moduleTwo]) {
      await seedTicketType(ids, eventId, `${eventId}-tt`, 'Standard', 0);
    }

    const orderId = `${parent}-ord-package`;
    // The order is created against the parent by the first seat; the module seats reuse it.
    await seedSeat(
      ids,
      parent,
      {
        name: 'Cara Diaz',
        email: 'cara@weld.test',
        orderId,
        orderStatus: 'paid',
        totalCents: 250_000,
        ticketTypeId: `${parent}-tt`,
      },
      0,
    );
    await seedSeat(
      ids,
      moduleOne,
      {
        name: 'Cara Diaz',
        email: 'cara@weld.test',
        orderId,
        orderStatus: 'paid',
        totalCents: 250_000,
        ticketTypeId: `${moduleOne}-tt`,
      },
      1,
    );
    await seedSeat(
      ids,
      moduleTwo,
      {
        name: 'Cara Diaz',
        email: 'cara@weld.test',
        orderId,
        orderStatus: 'paid',
        totalCents: 250_000,
        ticketTypeId: `${moduleTwo}-tt`,
      },
      2,
    );
    return { parent, moduleOne, moduleTwo };
  }

  it('charges the package to the parent course and to no module', async () => {
    const ids = freshIds();
    const { parent, moduleOne, moduleTwo } = await seedPackage(ids);

    const parentMoney = summariseMoney(
      await listEventRegistrations(BASE_ENV, ids.portalId, parent),
    );
    expect(parentMoney.orders).toBe(1);
    expect(parentMoney.collectedCents).toBe(250_000);

    for (const moduleId of [moduleOne, moduleTwo]) {
      const moduleMoney = summariseMoney(
        await listEventRegistrations(BASE_ENV, ids.portalId, moduleId),
      );
      // The seat is real and counted — see the summary below — but the money is not its own.
      expect(moduleMoney.orders).toBe(0);
      expect(moduleMoney.collectedCents).toBe(0);
      expect(
        summariseRegistrations(await listEventRegistrations(BASE_ENV, ids.portalId, moduleId))
          .total,
      ).toBe(1);
    }
  });

  it('counts the package once in the roll-up, not once per event it touches', async () => {
    const ids = freshIds();
    await seedPackage(ids);

    const res = await manageRoutes.request(
      '/reports/registrations?from=2026-05-01&to=2026-05-31',
      { headers: adminHeaders(ids) },
      envFor(ids),
    );
    expect(res.status).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: report shape asserted field by field
    const report = (await res.json()) as any;

    expect(report.eventCount).toBe(3);
    // Three seats, one booking, one person.
    expect(report.summary.total).toBe(3);
    expect(report.summary.distinctContacts).toBe(1);
    expect(report.money.orders).toBe(1);
    expect(report.money.collectedCents).toBe(250_000);
    expect(report.money.netCents).toBe(250_000);
  });
});

describe('seats versus people', () => {
  it('counts a cancel-then-rebook as two seats and one person', async () => {
    const ids = freshIds();
    await seedTenant(ids);
    await seedEvent(ids);
    await seedTicketType(ids, ids.eventId, ids.ticketTypeId, 'Standard', 83_500);

    // The duplicate-attendee guard allows the same email back once the first booking is
    // cancelled, so this is an ordinary rebooking, not a data fault.
    await seedSeat(
      ids,
      ids.eventId,
      {
        name: 'Ada Nguyen',
        email: 'ada@weld.test',
        orderId: `${ids.eventId}-ord-1`,
        orderStatus: 'refunded',
        totalCents: 83_500,
        refundedCents: 83_500,
        ticketStatus: 'cancelled',
      },
      0,
    );
    await seedSeat(
      ids,
      ids.eventId,
      {
        name: 'Ada Nguyen',
        email: 'ada@weld.test',
        orderId: `${ids.eventId}-ord-2`,
        orderStatus: 'paid',
        totalCents: 83_500,
      },
      1,
    );

    const rows = await listEventRegistrations(BASE_ENV, ids.portalId, ids.eventId);
    const summary = summariseRegistrations(rows);

    // Two seats sold, one person in the room. HubSpot's marketing event is contact-scoped
    // and reports one; the engine reports two. Both are right about different questions,
    // and reporting both is what makes them comparable without hand arithmetic.
    expect(summary.total).toBe(2);
    expect(summary.distinctContacts).toBe(1);
  });

  it('identifies a person by contact id ahead of email', async () => {
    const ids = freshIds();
    await seedTenant(ids);
    await seedEvent(ids);
    await seedTicketType(ids, ids.eventId, ids.ticketTypeId, 'Standard', 83_500);

    for (const [i, email] of ['a@weld.test', 'b@weld.test'].entries()) {
      await seedSeat(
        ids,
        ids.eventId,
        {
          name: `Person ${i}`,
          email,
          orderId: `${ids.eventId}-ord-${i}`,
          orderStatus: 'paid',
          totalCents: 83_500,
        },
        i,
      );
    }
    // Two emails HubSpot resolved to the same contact — a merge, or a person who books
    // under both a work and a personal address.
    await BASE_ENV.DB.prepare(
      'UPDATE registrations SET hubspot_contact_id = ?1 WHERE portal_id = ?2 AND event_id = ?3',
    )
      .bind('hs-contact-1', ids.portalId, ids.eventId)
      .run();

    const rows = await listEventRegistrations(BASE_ENV, ids.portalId, ids.eventId);
    expect(summariseRegistrations(rows).total).toBe(2);
    expect(summariseRegistrations(rows).distinctContacts).toBe(1);
  });
});

describe('report boundaries line up with the portal timezone', () => {
  async function seedAt(ids: Ids, suffix: string, startsAt: string) {
    const eventId = await seedEvent(ids, { eventId: `${ids.eventId}-${suffix}`, startsAt });
    await seedTicketType(ids, eventId, `${eventId}-tt`, 'Standard', 83_500);
    return eventId;
  }

  it('keeps a local month inside the month, at both ends', async () => {
    const ids = freshIds();
    await seedTenant(ids);

    // 9:00am on 1 June in Adelaide — the previous day in UTC. A UTC-bounded June report
    // dropped it.
    const firstMorning = await seedAt(ids, 'jun1', '2026-05-31T23:30:00Z');
    // 9:00am on 1 July in Adelaide — also the previous day in UTC, which a UTC-bounded June
    // report wrongly swept in.
    const julyMorning = await seedAt(ids, 'jul1', '2026-06-30T23:30:00Z');
    // Comfortably inside the month, as a control.
    const midJune = await seedAt(ids, 'mid', '2026-06-15T01:00:00Z');

    const res = await manageRoutes.request(
      '/reports/registrations?from=2026-06-01&to=2026-06-30',
      { headers: adminHeaders(ids) },
      envFor(ids),
    );
    // biome-ignore lint/suspicious/noExplicitAny: report shape asserted field by field
    const report = (await res.json()) as any;
    const included = report.categories.flatMap(
      // biome-ignore lint/suspicious/noExplicitAny: see above
      (category: any) => category.events.map((event: any) => event.eventId),
    );

    expect(included).toContain(firstMorning);
    expect(included).toContain(midJune);
    expect(included).not.toContain(julyMorning);
    expect(report.eventCount).toBe(2);
    // The report says which timezone it read the range in, because the same request means
    // different things in different zones.
    expect(report.range.timeZone).toBe('Australia/Adelaide');
  });

  it('follows a portal that has set its own timezone', async () => {
    const ids = freshIds();
    await seedTenant(ids);
    await BASE_ENV.DB.prepare('UPDATE tenants SET display_timezone = ?1 WHERE portal_id = ?2')
      .bind('UTC', ids.portalId)
      .run();

    const julyMorning = await seedAt(ids, 'jul1', '2026-06-30T23:30:00Z');

    const res = await manageRoutes.request(
      '/reports/registrations?from=2026-06-01&to=2026-06-30',
      { headers: adminHeaders(ids) },
      envFor(ids),
    );
    // biome-ignore lint/suspicious/noExplicitAny: report shape asserted field by field
    const report = (await res.json()) as any;

    // For a UTC portal that same instant IS 30 June, so it belongs in the June report.
    expect(report.range.timeZone).toBe('UTC');
    expect(report.eventCount).toBe(1);
    expect(report.categories[0].events[0].eventId).toBe(julyMorning);
  });

  it('counts a repeat attendee once across the range, not once per course', async () => {
    const ids = freshIds();
    await seedTenant(ids);

    const first = await seedAt(ids, 'a', '2026-06-05T01:00:00Z');
    const second = await seedAt(ids, 'b', '2026-06-19T01:00:00Z');
    for (const [i, eventId] of [first, second].entries()) {
      await seedSeat(
        ids,
        eventId,
        {
          name: 'Ada Nguyen',
          email: 'ada@weld.test',
          orderId: `${eventId}-ord`,
          orderStatus: 'paid',
          totalCents: 83_500,
          ticketTypeId: `${eventId}-tt`,
        },
        i,
      );
    }

    const res = await manageRoutes.request(
      '/reports/registrations?from=2026-06-01&to=2026-06-30',
      { headers: adminHeaders(ids) },
      envFor(ids),
    );
    // biome-ignore lint/suspicious/noExplicitAny: report shape asserted field by field
    const report = (await res.json()) as any;

    // Two seats across two courses, one person. Summing the per-event people counts would
    // report two humans where there is one, which is why the roll-up takes a union.
    expect(report.summary.total).toBe(2);
    expect(report.summary.distinctContacts).toBe(1);
    expect(report.categories[0].summary.distinctContacts).toBe(1);
    for (const event of report.categories[0].events) {
      expect(event.summary.distinctContacts).toBe(1);
    }
  });
});

describe('range parsing', () => {
  it('reads a bare date as a whole LOCAL day, at the right edge', () => {
    // Adelaide is UTC+9:30, so the local day starts the previous afternoon in UTC. Bounding
    // in UTC instead is what made a "June" report disagree with the HubSpot dashboard it is
    // meant to reconcile against — HubSpot groups by the portal's timezone.
    expect(normaliseRangeBound('2026-05-01', 'from', 'Australia/Adelaide')).toBe(
      '2026-04-30T14:30:00.000Z',
    );
    expect(normaliseRangeBound('2026-05-31', 'to', 'Australia/Adelaide')).toBe(
      '2026-05-31T14:29:59.999Z',
    );
  });

  it('defaults to the tenant default when no timezone is given', () => {
    expect(normaliseRangeBound('2026-05-01', 'from')).toBe(
      normaliseRangeBound('2026-05-01', 'from', 'Australia/Adelaide'),
    );
  });

  it('follows whatever timezone the portal is in', () => {
    // Nothing here is Australian: a UTC portal's local day IS the UTC day.
    expect(normaliseRangeBound('2026-05-01', 'from', 'UTC')).toBe('2026-05-01T00:00:00.000Z');
    expect(normaliseRangeBound('2026-05-31', 'to', 'UTC')).toBe('2026-05-31T23:59:59.999Z');
    // New York is behind UTC, so its local day starts later in UTC, not earlier.
    expect(normaliseRangeBound('2026-05-01', 'from', 'America/New_York')).toBe(
      '2026-05-01T04:00:00.000Z',
    );
  });

  it('handles a daylight-saving boundary', () => {
    // Adelaide leaves daylight saving on 5 April 2026 (ACDT +10:30 → ACST +9:30). The offset
    // that applies is the one in force on the day being asked about, which is why the
    // conversion re-reads the offset at its own answer rather than at the guess.
    expect(normaliseRangeBound('2026-04-04', 'from', 'Australia/Adelaide')).toBe(
      '2026-04-03T13:30:00.000Z',
    );
    expect(normaliseRangeBound('2026-04-06', 'from', 'Australia/Adelaide')).toBe(
      '2026-04-05T14:30:00.000Z',
    );
  });

  it('falls back to the UTC reading rather than widening the range', () => {
    // An unusable timezone must not turn a bounded report into an unbounded one.
    expect(normaliseRangeBound('2026-05-01', 'from', 'Not/AZone')).toBe(
      normaliseRangeBound('2026-05-01', 'from', 'Australia/Adelaide'),
    );
  });

  it('passes a full timestamp through, and ignores junk', () => {
    expect(normaliseRangeBound('2026-05-31T08:00:00Z', 'to')).toBe('2026-05-31T08:00:00Z');
    expect(normaliseRangeBound('', 'from')).toBeNull();
    expect(normaliseRangeBound(undefined, 'to')).toBeNull();
    expect(normaliseRangeBound('last tuesday', 'from')).toBeNull();
  });
});
