/**
 * Registration reporting and export (Phase 2.2).
 *
 * Weld's training dashboard numbers were being questioned and there was nowhere to check
 * them, because the engine had no report surface. This module is that surface: the
 * per-event attendee list, the CSV Weld actually asked for, and a cross-event roll-up by
 * course category and date range.
 *
 * **Everything here reads D1 directly and nothing here reads HubSpot.** A report built off
 * HubSpot would disagree with the engine that sold the seats, and the argument would just
 * repeat with a new set of numbers.
 *
 * ## One definition of "attended", one definition of "counted"
 *
 * The attendance endpoint (Phase 2.1), the per-event list, the CSV and the roll-up all put
 * a registration in a bucket, and they must all put it in the SAME bucket or the report is
 * evidence of nothing. So:
 *
 *   - "Did this seat attend?" is `deriveAttendance` in `attendance-writeback.ts`, reached
 *     here through the shared `ATTENDANCE_DERIVATION_COLUMNS` fragment. There is no second
 *     implementation, in SQL or otherwise.
 *   - The roll-up aggregates the same per-registration rows the per-event list returns,
 *     in TypeScript, rather than a parallel GROUP BY. A GROUP BY would be cheaper and would
 *     be the thing that quietly drifts; `reporting.test.ts` asserts the roll-up equals the
 *     sum of the per-event lists, and that assertion is only meaningful while there is one
 *     derivation to check.
 *
 * ## What the buckets mean
 *
 * A registration row exists from RESERVE time, not from payment — a paid booking holds its
 * seat until the invoice due date (up to 90 days for a bank transfer), and that seat is
 * real the whole time. So the total splits four ways by the state of the order behind it:
 * `confirmed`, `awaitingPayment`, `needsReview`, `cancelled`. Reporting a single
 * "registered" number without that split is how two systems come to disagree without
 * anyone being able to say where.
 *
 * `attended` cuts ACROSS those buckets rather than being one of them, because attending is
 * a fact: someone who walked in the door and was later refunded attended.
 *
 * ## Money
 *
 * Money is an ORDER-level fact and a bulk booking is many registrations under one order,
 * so every monetary figure here is summed over DISTINCT orders. Summing the order total
 * per attendee row would multiply a corporate booking by its seat count — a report that
 * inflates revenue is worse than no report.
 *
 * ## Answers
 *
 * Phase 2.3's custom-question answers join in `toReportRow` and get a column each in the
 * CSV. The columns are DYNAMIC — an event's questions are data, not schema — so they are
 * driven by the event's own question set, with any answered-but-since-archived question
 * appended after it. That last part is what stops last year's export losing a column when
 * a question is retired.
 */

import {
  ATTENDANCE_DERIVATION_COLUMNS,
  type AttendanceDerivationRow,
  type AttendanceSource,
  type AttendanceStatus,
  deriveAttendance,
} from './attendance-writeback';
import { listEventStaffNotes, type StaffNoteRow } from './notes';
import { type AnswerWithQuestion, listEventAnswers, type RegistrationQuestion } from './questions';
import {
  DEFAULT_DISPLAY_TIMEZONE,
  resolveTimeZone,
  zonedDayEndUtc,
  zonedDayStartUtc,
} from './timezone';
import type { Env } from './types';

// ---------------------------------------------------------------------------
// Order status vocabulary
// ---------------------------------------------------------------------------

/**
 * Seats that are committed: a paid order, or a free/complimentary one that committed at
 * reserve time. This is what `GET /events/:id/stats` calls "registered" — the narrower of
 * the two counts the worker already reports.
 */
export const COMMITTED_ORDER_STATUSES = ['paid', 'confirmed'] as const;

/** A live hold whose invoice has not been paid yet. A real seat; not yet money. */
export const AWAITING_PAYMENT_ORDER_STATUSES = ['pending'] as const;

/**
 * Late-payment oversell awaiting an owner decision (Phase 18.3). The payment was captured
 * and the SEAT was withheld, so it counts as money in but not as a committed seat.
 */
export const NEEDS_REVIEW_ORDER_STATUSES = ['needs_review'] as const;

/**
 * Orders whose money actually reached the bank, refunds notwithstanding. `refunded` and
 * `partially_refunded` are in here because the money WAS collected — the refund is
 * subtracted separately, so netting them out here would subtract it twice.
 */
const COLLECTED_ORDER_STATUSES = new Set<string>([
  'paid',
  'confirmed',
  'partially_refunded',
  'refunded',
  'needs_review',
]);

// ---------------------------------------------------------------------------
// Row shape
// ---------------------------------------------------------------------------

/**
 * One attendee, as the report sees them.
 *
 * snake_case, matching the registration rows this endpoint already returned and the rest
 * of the manage API, which hands back D1 rows as they are.
 */
export interface RegistrationReportRow {
  id: string;
  created_at: string;

  attendee_name: string;
  attendee_email: string;
  /**
   * A seat held with no attendee on it yet (Ref 74b). `attendee_name` and `attendee_email`
   * are '' on such a row — read this rather than inferring it from them.
   */
  seat_unnamed: boolean;
  /** Phase 1.2 capture. NULL means "never asked", not "answered blank". */
  attendee_phone: string | null;
  attendee_suburb: string | null;
  attendee_state: string | null;
  hubspot_contact_id: string | null;

  ticket_type_id: string;
  ticket_type_name: string | null;
  ticket_type_price_cents: number | null;

  /** The event this SEAT is on. Not always the order's event — see `order_event_id`. */
  event_id: string;
  order_id: string;
  /**
   * The event the ORDER was placed against (`orders.event_id`).
   *
   * A complete-course booking is one order holding seats on the parent course AND on every
   * included module, so a seat's event and its order's event differ for the module seats.
   * Money is attributed to the owning event only — see `summariseMoney`.
   */
  order_event_id: string;
  order_status: string;
  /** The order state as a reporting bucket — see the module doc. */
  payment_status: PaymentStatus;
  buyer_name: string;
  buyer_email: string;
  /** Order-level totals. A bulk booking repeats these across its attendee rows. */
  order_total_cents: number;
  order_refunded_cents: number;
  currency: string;
  hubspot_invoice_id: string | null;
  hubspot_invoice_url: string | null;
  hubspot_deal_id: string | null;
  member_company_id: string | null;
  order_voucher_seats_redeemed: number;
  order_voucher_credit_cents: number;

  ticket_id: string | null;
  ticket_status: string | null;
  /** Display status: attending beats being cancelled. Matches the Phase 2.1 endpoint. */
  status: AttendanceStatus;
  /**
   * Whether the SEAT was cancelled — refunded, cancelled, or holding a cancelled ticket.
   * Distinct from `status`, which reports someone who attended and was refunded afterwards
   * as `attended`. Both are true of that person, and a report needs to say both.
   */
  seat_cancelled: boolean;
  attended: boolean;
  attended_at: string | null;
  attendance_source: AttendanceSource | null;

  /**
   * Whether this seat's Marketing Event registration actually reached HubSpot.
   *
   * The mechanical half of "D1 and HubSpot disagree": a `me.register` outbox row that went
   * `dead`, or was never written, is a person the engine sold a seat to and HubSpot has
   * never heard of. Outbox rows are never purged, so absence here is a real finding rather
   * than a missing record.
   */
  marketing_event_sync: MarketingEventSync;

  /** Internal staff notes (Phase 1.3). Admin-only — never rendered to an attendee. */
  notes: ReportNote[];
  notes_count: number;

  /**
   * Answers to the event's custom questions (Phase 2.3), in question display order.
   *
   * Includes the booking's ORDER-scoped answers as well as this attendee's own — a
   * purchase order number is true of every seat on the booking, and an export where it
   * appeared against only one of them would read as being about that one person. `scope`
   * keeps the distinction. This is the copy a caterer reads: the contact property that
   * mirrors it is the prefill source for next time, not the record for this event.
   */
  answers: ReportAnswer[];
}

/**
 * `delivered` — HubSpot has this registration.
 * `pending`   — still queued or retrying; HubSpot will catch up on its own.
 * `dead`      — gave up. HubSpot will NEVER have it without someone intervening.
 * `never_enqueued` — no outbox row at all: written by a path that didn't enqueue one.
 */
export type MarketingEventSync = 'delivered' | 'pending' | 'dead' | 'never_enqueued';

function marketingEventSyncFor(outboxStatus: string | null): MarketingEventSync {
  if (outboxStatus === null) return 'never_enqueued';
  if (outboxStatus === 'delivered') return 'delivered';
  if (outboxStatus === 'dead') return 'dead';
  // pending / processing / failed all still drain on their own.
  return 'pending';
}

export interface ReportNote {
  id: string;
  author: string;
  body: string;
  created_at: string;
  /** 'registration' = about this attendee; 'order' = about the booking they came in on. */
  scope: 'registration' | 'order';
}

/** One answer to a custom question, joined to the question that asked it. */
export interface ReportAnswer {
  questionId: string;
  key: string;
  label: string;
  /** 'attendee' = this person's own answer; 'order' = answered once for the booking. */
  scope: 'attendee' | 'order';
  value: string;
}

export type PaymentStatus =
  | 'paid'
  | 'free'
  | 'awaiting_payment'
  | 'needs_review'
  | 'refunded'
  | 'partially_refunded'
  | 'cancelled'
  | 'unknown';

function paymentStatusFor(orderStatus: string, totalCents: number): PaymentStatus {
  switch (orderStatus) {
    case 'paid':
      return 'paid';
    // A $0 order never had an invoice to pay; calling that "paid" makes free seats look
    // like revenue on a dashboard that sums by payment status.
    case 'confirmed':
      return totalCents === 0 ? 'free' : 'paid';
    case 'pending':
      return 'awaiting_payment';
    case 'needs_review':
      return 'needs_review';
    case 'refunded':
      return 'refunded';
    case 'partially_refunded':
      return 'partially_refunded';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

interface ReportQueryRow extends AttendanceDerivationRow {
  id: string;
  created_at: string;
  attendee_name: string;
  attendee_email: string;
  seat_unnamed: number;
  attendee_phone: string | null;
  attendee_suburb: string | null;
  attendee_state: string | null;
  hubspot_contact_id: string | null;
  ticket_type_id: string;
  ticket_type_name: string | null;
  ticket_type_price_cents: number | null;
  order_id: string;
  order_event_id: string;
  buyer_name: string;
  buyer_email: string;
  order_total_cents: number;
  order_refunded_cents: number;
  currency: string;
  hubspot_invoice_id: string | null;
  hubspot_invoice_url: string | null;
  hubspot_deal_id: string | null;
  member_company_id: string | null;
  order_voucher_seats_redeemed: number;
  order_voucher_credit_cents: number;
  ticket_id: string | null;
  event_id: string;
  me_register_status: string | null;
}

/**
 * Ticket types join with LEFT JOIN, not JOIN.
 *
 * An inner join would silently DROP an attendee whose ticket type was deleted — losing a
 * row from an attendee list is the single worst failure this report can have, and it would
 * be invisible: the count would just be lower than the hand count. A missing type shows as
 * a null name instead.
 */
const REPORT_SELECT = `
  SELECT r.id                              AS id,
         r.created_at                      AS created_at,
         r.event_id                        AS event_id,
         r.attendee_name                   AS attendee_name,
         r.attendee_email                  AS attendee_email,
         COALESCE(r.seat_unnamed, 0)       AS seat_unnamed,
         r.attendee_phone                  AS attendee_phone,
         r.attendee_suburb                 AS attendee_suburb,
         r.attendee_state                  AS attendee_state,
         r.hubspot_contact_id              AS hubspot_contact_id,
         r.ticket_type_id                  AS ticket_type_id,
         tt.name                           AS ticket_type_name,
         tt.price_cents                    AS ticket_type_price_cents,
         r.order_id                        AS order_id,
         o.event_id                        AS order_event_id,
         o.buyer_name                      AS buyer_name,
         o.buyer_email                     AS buyer_email,
         o.total_cents                     AS order_total_cents,
         o.refunded_cents                  AS order_refunded_cents,
         o.currency                        AS currency,
         o.hubspot_invoice_id              AS hubspot_invoice_id,
         o.hubspot_invoice_url             AS hubspot_invoice_url,
         o.hubspot_deal_id                 AS hubspot_deal_id,
         o.member_company_id               AS member_company_id,
         o.voucher_seats_redeemed          AS order_voucher_seats_redeemed,
         o.voucher_credit_cents            AS order_voucher_credit_cents,
         r.ticket_id                       AS ticket_id,
         (SELECT ob.status FROM outbox ob
           WHERE ob.portal_id = r.portal_id AND ob.topic = 'me.register'
             -- IIF(json_valid(…)): a malformed payload must not raise for the whole
             -- statement. See expire.ts, where the reason is written out.
             AND json_extract(IIF(json_valid(ob.payload), ob.payload, '{}'), '$.registrationId') = r.id
           ORDER BY ob.created_at DESC LIMIT 1)  AS me_register_status,
${ATTENDANCE_DERIVATION_COLUMNS}
    FROM registrations r
    JOIN orders o       ON o.id = r.order_id
    LEFT JOIN ticket_types tt ON tt.id = r.ticket_type_id AND tt.portal_id = r.portal_id
`;

/** Booking order, oldest first — the order an attendee list is read and counted in. */
const REPORT_ORDER_BY = 'ORDER BY r.created_at ASC, r.id ASC';

function toReportRow(
  row: ReportQueryRow,
  notes: ReportNote[],
  answers: ReportAnswer[] = [],
): RegistrationReportRow {
  const verdict = deriveAttendance(row);
  return {
    id: row.id,
    created_at: row.created_at,
    attendee_name: row.attendee_name,
    attendee_email: row.attendee_email,
    seat_unnamed: row.seat_unnamed === 1,
    attendee_phone: row.attendee_phone,
    attendee_suburb: row.attendee_suburb,
    attendee_state: row.attendee_state,
    hubspot_contact_id: row.hubspot_contact_id,
    ticket_type_id: row.ticket_type_id,
    ticket_type_name: row.ticket_type_name,
    ticket_type_price_cents: row.ticket_type_price_cents,
    event_id: row.event_id,
    order_id: row.order_id,
    order_event_id: row.order_event_id,
    order_status: row.order_status,
    payment_status: paymentStatusFor(row.order_status, row.order_total_cents ?? 0),
    buyer_name: row.buyer_name,
    buyer_email: row.buyer_email,
    order_total_cents: row.order_total_cents ?? 0,
    order_refunded_cents: row.order_refunded_cents ?? 0,
    currency: row.currency,
    hubspot_invoice_id: row.hubspot_invoice_id,
    hubspot_invoice_url: row.hubspot_invoice_url,
    hubspot_deal_id: row.hubspot_deal_id,
    member_company_id: row.member_company_id,
    order_voucher_seats_redeemed: row.order_voucher_seats_redeemed ?? 0,
    order_voucher_credit_cents: row.order_voucher_credit_cents ?? 0,
    ticket_id: row.ticket_id,
    ticket_status: row.ticket_status,
    status: verdict.status,
    seat_cancelled: verdict.seatCancelled,
    attended: verdict.attended,
    attended_at: verdict.attendedAt,
    attendance_source: verdict.source,
    marketing_event_sync: marketingEventSyncFor(row.me_register_status),
    notes,
    notes_count: notes.length,
    answers,
  };
}

/**
 * Index an event's staff notes by registration.
 *
 * A note written against the ORDER is about the booking, so it shows against every
 * attendee on that booking: "invoice going to head office" is true of all four seats, and
 * an export where it appeared against only one of them would read as being about that one
 * person. `scope` says which kind it is so the distinction survives the export.
 */
function indexNotes(notes: StaffNoteRow[]): {
  byRegistration: Map<string, ReportNote[]>;
  byOrder: Map<string, ReportNote[]>;
} {
  const byRegistration = new Map<string, ReportNote[]>();
  const byOrder = new Map<string, ReportNote[]>();

  const push = (map: Map<string, ReportNote[]>, key: string, entry: ReportNote): void => {
    const existing = map.get(key);
    if (existing) existing.push(entry);
    else map.set(key, [entry]);
  };

  for (const note of notes) {
    // A note may name both a registration and an order. It is then about that attendee on
    // that booking, and belongs to the attendee rather than to everyone else on the order.
    const registrationId = note.registration_id;
    const key = registrationId ?? note.order_id;
    if (!key) continue;
    push(registrationId ? byRegistration : byOrder, key, {
      id: note.id,
      author: note.author,
      body: note.body,
      created_at: note.created_at,
      scope: registrationId ? 'registration' : 'order',
    });
  }
  return { byRegistration, byOrder };
}

/**
 * Index an event's answers by registration and by order — the same two-level shape as
 * `indexNotes`, and for the same reason: an ORDER-scoped answer is about the booking, so
 * it shows against every attendee on it.
 */
function indexAnswers(answers: AnswerWithQuestion[]): {
  byRegistration: Map<string, ReportAnswer[]>;
  byOrder: Map<string, ReportAnswer[]>;
} {
  const byRegistration = new Map<string, ReportAnswer[]>();
  const byOrder = new Map<string, ReportAnswer[]>();

  for (const answer of answers) {
    // An answer's scope is settled by which column holds it, not by re-reading the
    // question: a question whose scope was edited after the fact must not move answers
    // that were recorded under the old one.
    const registrationId = answer.registration_id;
    const key = registrationId ?? answer.order_id;
    if (!key) continue;
    const entry: ReportAnswer = {
      questionId: answer.question_id,
      key: answer.key,
      label: answer.label,
      scope: registrationId ? 'attendee' : 'order',
      value: answer.value_text ?? '',
    };
    const map = registrationId ? byRegistration : byOrder;
    const existing = map.get(key);
    if (existing) existing.push(entry);
    else map.set(key, [entry]);
  }
  return { byRegistration, byOrder };
}

function answersFor(row: ReportQueryRow, index: ReturnType<typeof indexAnswers>): ReportAnswer[] {
  const own = index.byRegistration.get(row.id) ?? [];
  const booking = index.byOrder.get(row.order_id) ?? [];
  if (booking.length === 0) return own;
  if (own.length === 0) return booking;
  return [...own, ...booking];
}

function notesFor(row: ReportQueryRow, index: ReturnType<typeof indexNotes>): ReportNote[] {
  const own = index.byRegistration.get(row.id) ?? [];
  const booking = index.byOrder.get(row.order_id) ?? [];
  if (booking.length === 0) return own;
  if (own.length === 0) return booking;
  return [...own, ...booking].sort((a, b) =>
    a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
  );
}

/**
 * Every registration for one event, in full, oldest first.
 *
 * Deliberately unpaginated at this level: the summary has to describe the WHOLE event
 * (the Phase 2.1 lesson — a count that changed because someone asked for page 2 would be a
 * trap), the CSV is the whole event by definition, and an event's registrations are bounded
 * by its capacity. The caller slices the page it wants out of this.
 */
export async function listEventRegistrations(
  env: Env,
  portalId: string,
  eventId: string,
): Promise<RegistrationReportRow[]> {
  const [rows, notes, answers] = await Promise.all([
    env.DB.prepare(
      `${REPORT_SELECT}
        WHERE r.portal_id = ?1 AND r.event_id = ?2
        ${REPORT_ORDER_BY}`,
    )
      .bind(portalId, eventId)
      .all<ReportQueryRow>()
      .then((result) => result.results),
    // Notes are optional decoration on a report whose point is the seat count. A portal
    // whose D1 predates migration 0022 must still get its attendee list.
    listEventStaffNotes(env, portalId, eventId).catch(() => [] as StaffNoteRow[]),
    // Same for answers and migration 0024. An attendee list that fails outright because a
    // portal has never defined a custom question would be a worse report than one without
    // the answer columns.
    listEventAnswers(env, portalId, eventId).catch(() => [] as AnswerWithQuestion[]),
  ]);

  const noteIndex = indexNotes(notes);
  const answerIndex = indexAnswers(answers);
  return rows.map((row) =>
    toReportRow(row, notesFor(row, noteIndex), answersFor(row, answerIndex)),
  );
}

/**
 * SQLite caps the bound parameters in one statement, so a wide date range is asked for in
 * chunks rather than one enormous IN list. Well under the limit, and large enough that a
 * year of courses is one or two round trips.
 */
const EVENT_ID_CHUNK = 200;

/**
 * The same rows as `listEventRegistrations`, for many events at once, grouped by event.
 *
 * The roll-up needs every event's registrations and asking per event is a query per event —
 * a wide range would exhaust the Worker's subrequest budget partway through and fail as
 * something that looks like a bug rather than a limit. This runs the SAME `REPORT_SELECT`
 * with a different WHERE, so the rows, the derivation and therefore the counts are identical
 * to the per-event list by construction; only the filter changes.
 *
 * Notes are not loaded: the roll-up reports counts, not attendee rows, and the per-event
 * list is where an attendee's notes belong.
 */
async function listRegistrationsByEvent(
  env: Env,
  portalId: string,
  eventIds: string[],
): Promise<Map<string, RegistrationReportRow[]>> {
  const byEvent = new Map<string, RegistrationReportRow[]>();
  // Every event in scope gets an entry, so one with no registrations still reports zeroes
  // rather than vanishing from the roll-up.
  for (const eventId of eventIds) byEvent.set(eventId, []);

  for (let i = 0; i < eventIds.length; i += EVENT_ID_CHUNK) {
    const chunk = eventIds.slice(i, i + EVENT_ID_CHUNK);
    const placeholders = chunk.map((_, index) => `?${index + 2}`).join(', ');
    const result = await env.DB.prepare(
      `${REPORT_SELECT}
        WHERE r.portal_id = ?1 AND r.event_id IN (${placeholders})
        ${REPORT_ORDER_BY}`,
    )
      .bind(portalId, ...chunk)
      .all<ReportQueryRow>();

    for (const row of result.results) {
      byEvent.get(row.event_id)?.push(toReportRow(row, []));
    }
  }

  return byEvent;
}

/**
 * The counts behind every `/stats` surface, without loading notes.
 *
 * Three endpoints — the manage card, the App Home card and the door scanner — each counted
 * "registered" and "attended" with their own SQL, and all three were wrong in the same two
 * ways: `registered` excluded seats held against an unpaid invoice, and `attended` read
 * only `tickets.status = 'checked_in'`, so an online event reported nobody as having
 * attended no matter how many people joined the webinar. They all call this now, so the
 * worker reports one answer to "how many people are coming" rather than three.
 */
export async function summariseEventRegistrations(
  env: Env,
  portalId: string,
  eventId: string,
): Promise<RegistrationSummary> {
  const result = await env.DB.prepare(
    `${REPORT_SELECT}
      WHERE r.portal_id = ?1 AND r.event_id = ?2
      ${REPORT_ORDER_BY}`,
  )
    .bind(portalId, eventId)
    .all<ReportQueryRow>();
  return summariseRegistrations(result.results.map((row) => toReportRow(row, [])));
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/**
 * Two axes over the same rows, and reading them as one is how a reconciliation goes wrong.
 *
 *   BOOKING STATE — `confirmed` + `awaitingPayment` + `needsReview` + `cancelled` = `total`.
 *   A clean partition: every seat's order is in exactly one of those states. This is the
 *   axis to hold a disagreeing dashboard against, because a gap can be pointed at.
 *
 *   ATTENDANCE — `attended`, `registered`, `notYetArrived`, identical to what the Phase 2.1
 *   attendance endpoint reports for the same event.
 *
 * They are not two views of one number, and `cancelled` and `registered` do not have to add
 * up: someone can be refunded AND have been in the room. That person is counted in
 * `cancelled` (their booking was cancelled) and is not subtracted from `registered` (they
 * attended). An event where that happens has `cancelled + registered > total`, and that is
 * the arithmetic being correct rather than the report being broken.
 */
export interface RegistrationSummary {
  /** Every registration row in scope. The denominator. */
  total: number;
  /** Seats committed — order paid or (free) confirmed. What /stats calls "registered". */
  confirmed: number;
  /** Held seats whose invoice is not yet paid. Real seats; not yet money. */
  awaitingPayment: number;
  /** Oversell awaiting an owner decision (Phase 18.3): money in, seat withheld. */
  needsReview: number;
  /** Bookings that were refunded or cancelled, whether or not the person turned up. */
  cancelled: number;
  /** Attending is a fact; a refund afterwards does not un-attend someone. */
  attended: number;
  /**
   * Seats still expected: everyone except those cancelled who did NOT attend. Matches the
   * Phase 2.1 attendance endpoint's `registered` exactly — the number a door count is read
   * against.
   */
  registered: number;
  notYetArrived: number;
  /**
   * Seats the engine is currently holding: `confirmed + awaitingPayment + needsReview`.
   * The right denominator for "how many are left", because a seat held against an unpaid
   * invoice is not for sale, and a cancelled one is — whether or not its occupant attended.
   */
  seatsHeld: number;
  /**
   * Registrations whose Marketing Event write-back has NOT reached HubSpot. Non-zero is the
   * mechanical explanation for HubSpot reporting fewer registrations than the engine, and
   * points at which rows to look at rather than at the whole event.
   */
  notSyncedToMarketingEvent: number;
  /**
   * Seats sold and held with nobody on them yet (Ref 74b) — a company block still waiting
   * on its names.
   *
   * Reported rather than enforced. A seat with no attendee cannot answer an attendee
   * question, so a required one is not enforced against it at booking; refusing the block
   * instead would make it impossible on any event that asks one. The gap belongs here, in
   * the same place every other "the two systems disagree" gap is named, so it is a number
   * a staff member can chase rather than a silence.
   *
   * These seats ARE in `total`, `confirmed`/`awaitingPayment` and `seatsHeld`: they are
   * sold, they are paid for or invoiced, and they are out of sale. They are NOT in
   * `distinctContacts`, because nobody is on them.
   */
  unnamedSeats: number;
  /**
   * Distinct PEOPLE behind these registrations, where `total` counts SEATS.
   *
   * HubSpot's Marketing Events are contact-scoped: one contact holds one participation
   * record however many times they book, so a HubSpot report counting "contacts associated
   * to the marketing event" counts people. Our rows are seats. The two diverge whenever
   * somebody cancels and rebooks — which the duplicate-attendee guard allows once the first
   * booking is cancelled — and that divergence is by design on both sides rather than a
   * fault on either.
   *
   * Reporting both is what makes the engine and a contact-based dashboard comparable
   * without anyone doing arithmetic by hand: `total` is the seat count that capacity and
   * revenue run on, `distinctContacts` is the number to hold that dashboard against.
   *
   * NOT additive across events — see `sumSummaries`.
   */
  distinctContacts: number;
}

export interface MoneySummary {
  /** Distinct orders behind these registrations — not the registration count. */
  orders: number;
  /** Sum of order totals for orders whose money reached the bank, before refunds. */
  collectedCents: number;
  /** Sum of order totals still out as an unpaid invoice. */
  awaitingPaymentCents: number;
  refundedCents: number;
  /** collectedCents - refundedCents. */
  netCents: number;
  /** Vouchers drawn down by these orders. Units follow the tenant's voucher_mode. */
  voucherSeatsRedeemed: number;
  voucherCreditCents: number;
  /** Present only when every order in scope shares a currency; null when they differ. */
  currency: string | null;
}

export function summariseRegistrations(rows: RegistrationReportRow[]): RegistrationSummary {
  let confirmed = 0;
  let awaitingPayment = 0;
  let needsReview = 0;
  let cancelled = 0;
  let attended = 0;
  let cancelledNoShow = 0;
  let notSyncedToMarketingEvent = 0;
  let unnamedSeats = 0;

  for (const row of rows) {
    if (row.attended) attended++;
    if (row.seat_unnamed) unnamedSeats++;
    // A seat with nobody on it was never enqueued, so counting it as a sync gap would
    // report a disagreement with HubSpot that does not exist — HubSpot is right not to
    // know about a seat that has no person.
    if (!row.seat_unnamed && row.marketing_event_sync !== 'delivered') {
      notSyncedToMarketingEvent++;
    }

    // Booking state. `seat_cancelled` rather than `status`, because `status` lets attending
    // override a cancellation and this axis is about the booking, not the person: a seat
    // that was refunded belongs in `cancelled` whether or not its occupant came anyway.
    // It also catches a partial refund, which cancels the tickets while leaving the order
    // 'partially_refunded'.
    if (row.seat_cancelled) {
      cancelled++;
      if (!row.attended) cancelledNoShow++;
    } else if ((COMMITTED_ORDER_STATUSES as readonly string[]).includes(row.order_status)) {
      confirmed++;
    } else if ((AWAITING_PAYMENT_ORDER_STATUSES as readonly string[]).includes(row.order_status)) {
      awaitingPayment++;
    } else if ((NEEDS_REVIEW_ORDER_STATUSES as readonly string[]).includes(row.order_status)) {
      needsReview++;
    } else {
      // An order status this build has never heard of is still a seat someone booked.
      // Counting it nowhere would break the partition, which is the one property that lets
      // a reader trust the arithmetic; the closest honest bucket is "booked, not settled".
      awaitingPayment++;
    }
  }

  // Everyone except the cancelled seats whose occupant did not turn up — which is exactly
  // `summariseAttendance`'s definition, so the two endpoints report the same number.
  const registered = rows.length - cancelledNoShow;
  return {
    total: rows.length,
    confirmed,
    awaitingPayment,
    needsReview,
    cancelled,
    attended,
    registered,
    notYetArrived: Math.max(0, registered - attended),
    seatsHeld: confirmed + awaitingPayment + needsReview,
    notSyncedToMarketingEvent,
    unnamedSeats,
    distinctContacts: contactKeys(rows).size,
  };
}

/**
 * How a registration is identified as a PERSON.
 *
 * Contact id where HubSpot has given us one, lowercased email otherwise — the email is what
 * the contact will be keyed on once the write-back lands, so a row counted by email before
 * its sync and by id afterwards is the same person either way.
 */
export function contactKeys(rows: RegistrationReportRow[]): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) {
    // A seat with nobody on it is not a person (Ref 74b). Counting it would make every
    // unnamed seat on one booking collapse into a single phantom contact keyed on '',
    // which is both wrong and the kind of wrong nobody would spot in a total.
    if (row.seat_unnamed) continue;
    keys.add(row.hubspot_contact_id ?? row.attendee_email.trim().toLowerCase());
  }
  return keys;
}

/**
 * Money for a set of registrations, summed over the DISTINCT orders behind them.
 *
 * The de-duplication is the whole point: four seats on one corporate booking are four rows
 * carrying the same order total, and adding them up would report four times the revenue.
 *
 * A seat whose order belongs to a DIFFERENT event contributes nothing. That is the module
 * seat of a complete-course booking: the course is charged once, on the parent, and its
 * modules are $0 entitlements. Counting the package total again under each module would
 * report a three-module course at four times its revenue in the roll-up, and would tell a
 * module's own report it earned money that was never charged against it.
 */
export function summariseMoney(rows: RegistrationReportRow[]): MoneySummary {
  const seen = new Set<string>();
  const currencies = new Set<string>();
  let collectedCents = 0;
  let awaitingPaymentCents = 0;
  let refundedCents = 0;
  let voucherSeatsRedeemed = 0;
  let voucherCreditCents = 0;

  for (const row of rows) {
    if (row.order_event_id !== row.event_id) continue;
    if (seen.has(row.order_id)) continue;
    seen.add(row.order_id);
    if (row.currency) currencies.add(row.currency);

    if (COLLECTED_ORDER_STATUSES.has(row.order_status)) {
      collectedCents += row.order_total_cents;
    } else if ((AWAITING_PAYMENT_ORDER_STATUSES as readonly string[]).includes(row.order_status)) {
      awaitingPaymentCents += row.order_total_cents;
    }
    // Refunds are counted whatever the order ended up as: a policy refund that granted
    // nothing leaves the order 'cancelled' with refunded_cents set.
    refundedCents += row.order_refunded_cents;
    voucherSeatsRedeemed += row.order_voucher_seats_redeemed;
    voucherCreditCents += row.order_voucher_credit_cents;
  }

  return {
    orders: seen.size,
    collectedCents,
    awaitingPaymentCents,
    refundedCents,
    netCents: collectedCents - refundedCents,
    voucherSeatsRedeemed,
    voucherCreditCents,
    currency: currencies.size === 1 ? [...currencies][0] : null,
  };
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

/**
 * Column order for the CSV. Attendee identity first — the columns a person reading the
 * export in a spreadsheet actually scans — then the seat, then the booking, then money.
 */
const CSV_COLUMNS: { header: string; value: (row: RegistrationReportRow) => unknown }[] = [
  { header: 'registration_id', value: (r) => r.id },
  // A held seat reads as awaiting a name rather than as a blank cell, so the person doing
  // the hand count knows the difference between "nobody has told us yet" and "the export
  // dropped something" (Ref 74b).
  {
    header: 'attendee_name',
    value: (r) => (r.seat_unnamed ? 'Unassigned seat' : r.attendee_name),
  },
  { header: 'attendee_email', value: (r) => (r.seat_unnamed ? '' : r.attendee_email) },
  { header: 'attendee_phone', value: (r) => r.attendee_phone },
  { header: 'attendee_suburb', value: (r) => r.attendee_suburb },
  { header: 'attendee_state', value: (r) => r.attendee_state },
  { header: 'ticket_type', value: (r) => r.ticket_type_name },
  { header: 'ticket_type_price', value: (r) => centsToCsvAmount(r.ticket_type_price_cents) },
  { header: 'status', value: (r) => r.status },
  { header: 'booking_cancelled', value: (r) => (r.seat_cancelled ? 'yes' : 'no') },
  { header: 'attended', value: (r) => (r.attended ? 'yes' : 'no') },
  { header: 'attended_at', value: (r) => r.attended_at },
  { header: 'attendance_source', value: (r) => r.attendance_source },
  { header: 'checked_in', value: (r) => (r.attendance_source === 'checkin' ? 'yes' : 'no') },
  { header: 'payment_status', value: (r) => r.payment_status },
  { header: 'order_status', value: (r) => r.order_status },
  { header: 'order_id', value: (r) => r.order_id },
  { header: 'buyer_name', value: (r) => r.buyer_name },
  { header: 'buyer_email', value: (r) => r.buyer_email },
  { header: 'order_total', value: (r) => centsToCsvAmount(r.order_total_cents) },
  { header: 'order_refunded', value: (r) => centsToCsvAmount(r.order_refunded_cents) },
  { header: 'currency', value: (r) => r.currency },
  { header: 'invoice_id', value: (r) => r.hubspot_invoice_id },
  { header: 'invoice_url', value: (r) => r.hubspot_invoice_url },
  { header: 'member_company_id', value: (r) => r.member_company_id },
  { header: 'voucher_seats_redeemed', value: (r) => r.order_voucher_seats_redeemed },
  { header: 'voucher_credit', value: (r) => centsToCsvAmount(r.order_voucher_credit_cents) },
  { header: 'hubspot_contact_id', value: (r) => r.hubspot_contact_id },
  { header: 'marketing_event_sync', value: (r) => r.marketing_event_sync },
  { header: 'registered_at', value: (r) => r.created_at },
  { header: 'notes_count', value: (r) => r.notes_count },
  { header: 'notes', value: (r) => formatNotesForCsv(r.notes) },
];

/**
 * Cents as a decimal amount, because this column is read in a spreadsheet and summed there.
 * Integer cents are the storage contract, not the reading contract — a column of `9900`
 * summed by a finance person is out by two orders of magnitude and still looks plausible.
 */
function centsToCsvAmount(cents: number | null): string {
  if (cents === null || cents === undefined) return '';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function formatNotesForCsv(notes: ReportNote[]): string {
  return notes
    .map((note) => {
      const scope = note.scope === 'order' ? ' (booking)' : '';
      return `[${note.created_at} ${note.author}${scope}] ${note.body}`;
    })
    .join('\n');
}

/**
 * Characters that make a spreadsheet treat a cell as a formula rather than as text.
 *
 * This export carries free text a person typed — attendee names, staff notes — straight
 * into Excel and Google Sheets. A note beginning `=` or `+` is executed on open, which is
 * the CSV-injection problem; a leading tab or carriage return sneaks past a check of just
 * the obvious three. Prefixing an apostrophe is the standard neutralisation, and is what
 * every spreadsheet renders back as the literal text.
 */
const CSV_FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (text.length > 0 && CSV_FORMULA_PREFIXES.includes(text[0])) {
    text = `'${text}`;
  }
  // RFC 4180: quote anything holding a delimiter, a quote or a newline, and double any
  // embedded quote. Notes deliberately carry newlines — a quoted field keeps them in one
  // cell instead of tearing the row in half.
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * The answer columns for one export, in a stable order.
 *
 * Driven by the event's live question set first, so a question that is ASKED but that
 * nobody answered still gets a column — an empty dietary column is a meaningful answer to
 * "did anyone declare an allergy", where a missing column reads as the export being wrong.
 * Any key that only appears in the answers is appended after: an archived question keeps
 * its answers readable, which means last year's export must not lose the column when the
 * question is retired.
 */
function answerColumns(
  rows: RegistrationReportRow[],
  questions: RegistrationQuestion[],
): { key: string; label: string }[] {
  const columns: { key: string; label: string }[] = [];
  const seen = new Set<string>();
  for (const question of questions) {
    if (seen.has(question.key)) continue;
    seen.add(question.key);
    columns.push({ key: question.key, label: question.label });
  }
  for (const row of rows) {
    for (const answer of row.answers) {
      if (seen.has(answer.key)) continue;
      seen.add(answer.key);
      columns.push({ key: answer.key, label: answer.label });
    }
  }
  return columns;
}

/**
 * Header for one answer column. Prefixed so a question keyed `status` or `notes` cannot
 * collide with a fixed column and silently shadow it in whatever reads the CSV back.
 */
function answerColumnHeader(key: string): string {
  return `question_${key}`;
}

/**
 * `questions` supplies the columns for the event, including questions nobody answered.
 * Optional so a caller with only rows in hand (the roll-up, a test) still gets every
 * answer that was actually given.
 */
export function registrationsToCsv(
  rows: RegistrationReportRow[],
  questions: RegistrationQuestion[] = [],
): string {
  const answerCols = answerColumns(rows, questions);
  const headers = [
    ...CSV_COLUMNS.map((column) => column.header),
    ...answerCols.map((column) => answerColumnHeader(column.key)),
  ];

  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) {
    // One question, one cell. A multiselect answer is already ';'-joined in storage
    // (HubSpot's own encoding), and a duplicate key cannot occur: an attendee-scoped and
    // an order-scoped question may not share a key on the same event.
    const byKey = new Map(row.answers.map((answer) => [answer.key, answer.value]));
    lines.push(
      [
        ...CSV_COLUMNS.map((column) => column.value(row)),
        ...answerCols.map((column) => byKey.get(column.key) ?? ''),
      ]
        .map(csvEscape)
        .join(','),
    );
  }
  // CRLF per RFC 4180, with a trailing terminator so the last row ends like the others.
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * A filename a person can still tell apart after downloading four of them. Falls back to
 * the event id when the title has nothing filename-safe in it.
 */
export function csvFilename(eventTitle: string, eventId: string, generatedAt: string): string {
  const slug = eventTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `registrations-${slug || eventId}-${generatedAt.slice(0, 10)}.csv`;
}

// ---------------------------------------------------------------------------
// Cross-event roll-up
// ---------------------------------------------------------------------------

export interface ReportRange {
  /** Inclusive ISO lower bound on events.starts_at; null = no lower bound. */
  from: string | null;
  /** Inclusive ISO upper bound on events.starts_at; null = no upper bound. */
  to: string | null;
  /** Exact events.category match; null = every category. */
  category: string | null;
  /**
   * The timezone a bare `from`/`to` date was interpreted in. Echoed back because the same
   * request means different things in different zones, and a reader comparing this report
   * to a HubSpot dashboard needs to know the boundaries matched.
   */
  timeZone?: string;
}

export interface EventRollup {
  eventId: string;
  title: string;
  category: string | null;
  startsAt: string;
  endsAt: string;
  bookingKind: string | null;
  summary: RegistrationSummary;
  money: MoneySummary;
}

export interface CategoryRollup {
  /** null is a real group — events with no category set — not an error. */
  category: string | null;
  eventCount: number;
  summary: RegistrationSummary;
  money: MoneySummary;
  events: EventRollup[];
}

export interface RegistrationsReport {
  generatedAt: string;
  range: ReportRange;
  eventCount: number;
  summary: RegistrationSummary;
  money: MoneySummary;
  categories: CategoryRollup[];
}

interface RollupEventRow {
  id: string;
  title: string;
  category: string | null;
  starts_at: string;
  ends_at: string;
  booking_kind: string | null;
}

/**
 * Normalise a `from`/`to` query parameter into the UTC instant to compare `events.starts_at`
 * against.
 *
 * A bare date means a LOCAL calendar day in the tenant's display timezone, and `to` means
 * through the END of it. Two separate traps, both of which silently move whole days:
 *
 *   - Without the end-of-day handling, `to=2026-06-30` drops every course that started that
 *     day, because a bare date compares as midnight.
 *   - Without the timezone, the day boundaries are UTC ones. Adelaide is UTC+9:30, so a
 *     "June" report loses courses starting the morning of 1 June and gains ones starting the
 *     morning of 1 July. HubSpot stores datetimes in UTC but its dashboards GROUP by the
 *     portal's timezone, so a UTC-bounded range is guaranteed to disagree with the dashboard
 *     it is meant to be reconciled against — by a few records, at both ends, silently.
 *
 * A value that already carries a time is an explicit instant and is used as given.
 */
export function normaliseRangeBound(
  value: string | undefined,
  edge: 'from' | 'to',
  timeZone: string = DEFAULT_DISPLAY_TIMEZONE,
): string | null {
  const trimmed = (value ?? '').trim();
  if (trimmed === '') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    // Resolved here as well as at the config read, so an unusable zone means the same thing
    // — the default — however this is reached. Two different fallbacks for one condition is
    // how a caller ends up with a range it did not ask for.
    const zone = resolveTimeZone(timeZone);
    const bound = edge === 'from' ? zonedDayStartUtc(trimmed, zone) : zonedDayEndUtc(trimmed, zone);
    // An unconvertible date falls back to the UTC interpretation rather than silently
    // widening the range to everything.
    return bound ?? (edge === 'from' ? `${trimmed}T00:00:00Z` : `${trimmed}T23:59:59.999Z`);
  }
  return Number.isNaN(Date.parse(trimmed)) ? null : trimmed;
}

/**
 * The timezone a tenant's dates are read in. Reading optional config must never fail the
 * caller, so a tenants table predating migration 0025 degrades to the default.
 */
export async function loadDisplayTimeZone(env: Env, portalId: string): Promise<string> {
  try {
    const row = await env.DB.prepare('SELECT display_timezone FROM tenants WHERE portal_id = ?1')
      .bind(portalId)
      .first<{ display_timezone: string | null }>();
    return resolveTimeZone(row?.display_timezone);
  } catch {
    return DEFAULT_DISPLAY_TIMEZONE;
  }
}

/**
 * The cross-event roll-up, grouped by course category.
 *
 * Aggregated from the same per-registration rows `listEventRegistrations` returns, one
 * event at a time, rather than from a parallel GROUP BY — see the module doc. That is what
 * makes "the roll-up reconciles to the per-event lists" a property of the code rather than
 * a coincidence lasting until someone edits one of two queries.
 */
export async function buildRegistrationsReport(
  env: Env,
  portalId: string,
  range: ReportRange,
): Promise<RegistrationsReport> {
  const events = await env.DB.prepare(
    `SELECT id, title, category, starts_at, ends_at, booking_kind
       FROM events
      WHERE portal_id = ?1
        AND (?2 IS NULL OR starts_at >= ?2)
        AND (?3 IS NULL OR starts_at <= ?3)
        AND (?4 IS NULL OR category = ?4)
      ORDER BY starts_at ASC, id ASC`,
  )
    .bind(portalId, range.from, range.to, range.category)
    .all<RollupEventRow>();

  const byEvent = await listRegistrationsByEvent(
    env,
    portalId,
    events.results.map((event) => event.id),
  );

  // Contact keys per event, so a category total and the grand total can be a true union
  // rather than a sum that counts a repeat attendee twice.
  const keysByEvent = new Map<string, Set<string>>();
  const unionOf = (eventIds: string[]): number => {
    const union = new Set<string>();
    for (const eventId of eventIds) {
      for (const key of keysByEvent.get(eventId) ?? []) union.add(key);
    }
    return union.size;
  };

  const rollups: EventRollup[] = events.results.map((event) => {
    const rows = byEvent.get(event.id) ?? [];
    keysByEvent.set(event.id, contactKeys(rows));
    return {
      eventId: event.id,
      title: event.title,
      category: event.category,
      startsAt: event.starts_at,
      endsAt: event.ends_at,
      bookingKind: event.booking_kind,
      summary: summariseRegistrations(rows),
      money: summariseMoney(rows),
      // The rows themselves stay out of the roll-up: an unbounded attendee dump across a
      // date range is a different endpoint, and the per-event list is it.
    };
  });

  // Keyed by the category itself, null included — a Map takes null as a key, so an
  // uncategorised event needs no sentinel string that a real category might one day collide
  // with. (This previously held a sentinel whose leading character was a stray NUL byte,
  // which made the whole file read as binary to grep and ripgrep.)
  const byCategory = new Map<string | null, CategoryRollup>();
  for (const rollup of rollups) {
    const key = rollup.category;
    const group = byCategory.get(key);
    if (group) group.events.push(rollup);
    else {
      byCategory.set(key, {
        category: rollup.category,
        eventCount: 0,
        summary: sumSummaries([], 0),
        money: sumMoney([]),
        events: [rollup],
      });
    }
  }

  const categories = [...byCategory.values()].map((group) => ({
    ...group,
    eventCount: group.events.length,
    summary: sumSummaries(
      group.events.map((event) => event.summary),
      unionOf(group.events.map((event) => event.eventId)),
    ),
    money: sumMoney(group.events.map((event) => event.money)),
  }));

  return {
    generatedAt: new Date().toISOString(),
    range,
    eventCount: rollups.length,
    summary: sumSummaries(
      rollups.map((rollup) => rollup.summary),
      unionOf(rollups.map((rollup) => rollup.eventId)),
    ),
    money: sumMoney(rollups.map((rollup) => rollup.money)),
    categories,
  };
}

/**
 * Totals are summed from the per-event summaries rather than recomputed over pooled rows,
 * so a total can never disagree with the event lines printed underneath it.
 *
 * `distinctContacts` is the exception and has to be passed in: one person on two courses is
 * two per-event contacts and one human, so adding the parts would report more people than
 * exist. Making it a required argument rather than deriving something plausible is
 * deliberate — a caller has to have done the union to produce a number at all.
 */
export function sumSummaries(
  parts: RegistrationSummary[],
  distinctContacts: number,
): RegistrationSummary {
  const total: RegistrationSummary = {
    total: 0,
    confirmed: 0,
    awaitingPayment: 0,
    needsReview: 0,
    cancelled: 0,
    attended: 0,
    registered: 0,
    notYetArrived: 0,
    seatsHeld: 0,
    notSyncedToMarketingEvent: 0,
    unnamedSeats: 0,
    distinctContacts,
  };
  for (const part of parts) {
    total.total += part.total;
    total.confirmed += part.confirmed;
    total.awaitingPayment += part.awaitingPayment;
    total.needsReview += part.needsReview;
    total.cancelled += part.cancelled;
    total.attended += part.attended;
    total.registered += part.registered;
    total.notYetArrived += part.notYetArrived;
    total.seatsHeld += part.seatsHeld;
    total.notSyncedToMarketingEvent += part.notSyncedToMarketingEvent;
  }
  return total;
}

/**
 * An order belongs to exactly one event (`orders.event_id`), and `summariseMoney` counts it
 * only under that event, so per-event sums add across events without any order being
 * counted twice — including a course package, whose seats span several of them.
 */
export function sumMoney(parts: MoneySummary[]): MoneySummary {
  const currencies = new Set<string>();
  const total: MoneySummary = {
    orders: 0,
    collectedCents: 0,
    awaitingPaymentCents: 0,
    refundedCents: 0,
    netCents: 0,
    voucherSeatsRedeemed: 0,
    voucherCreditCents: 0,
    currency: null,
  };
  for (const part of parts) {
    total.orders += part.orders;
    total.collectedCents += part.collectedCents;
    total.awaitingPaymentCents += part.awaitingPaymentCents;
    total.refundedCents += part.refundedCents;
    total.netCents += part.netCents;
    total.voucherSeatsRedeemed += part.voucherSeatsRedeemed;
    total.voucherCreditCents += part.voucherCreditCents;
    if (part.currency) currencies.add(part.currency);
  }
  total.currency = currencies.size === 1 ? [...currencies][0] : null;
  return total;
}
