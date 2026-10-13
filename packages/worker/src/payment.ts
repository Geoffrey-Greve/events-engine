/**
 * Payment confirmation and refund lifecycle.
 *
 * confirmPayment       — called from the queue on every confirm_payment message.
 * flagOversellForReview — called when confirmPayment returns oversold (Phase 18.3: no
 *                         auto-resolve — flag the order needs_review + open a decision).
 * honourOversell       — owner chose to honour a needs_review order (force-confirm).
 * executeRefund        — policy-aware refund (admin/owner-initiated).
 * handleRefund         — called from the queue on refund_payment messages (webhook void).
 *
 * All D1 mutations (state change + outbox entries) are in a single batch so
 * the outbox is always consistent with the order/registration state (CLAUDE.md).
 */

import type { RefundOutcome } from '@paddock/shared';
import { maybeFlagFastSellout } from './capacity-guard';
import { mintTicketForTenant } from './checkin';
import type { CourseBundleComponentRow, EventRow, OrderRow } from './db';
import { loadCourseBundleComponents, loadEvent, loadOrderByInvoice } from './db';
import { createOversellDecision, createWaitlistDecision } from './decisions';
import { computeRefund, resolveRefundPolicy } from './refund-policy';
import {
  registrationConfirmationStatement,
  signalRegistrationConfirmation,
} from './registration-confirmation';
import type { Env } from './types';
import { signalVoucherUsageSync, voucherUsageSyncStatement } from './vouchers';
import { waitlistSnapshot } from './waitlist';

// ---------------------------------------------------------------------------
// Queue message shapes
// ---------------------------------------------------------------------------

export interface ConfirmPaymentJob {
  kind: 'confirm_payment';
  hsInvoiceId: string;
  portalId: string;
}

export interface RefundPaymentJob {
  kind: 'refund_payment';
  hsInvoiceId: string;
  portalId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build { ticketTypeId → quantity } map from a flat list of ticket_type_id strings. */
function aggregateItems(
  ticketTypeIds: string[],
): Array<{ ticketTypeId: string; quantity: number }> {
  const m = new Map<string, number>();
  for (const id of ticketTypeIds) m.set(id, (m.get(id) ?? 0) + 1);
  return Array.from(m.entries()).map(([ticketTypeId, quantity]) => ({ ticketTypeId, quantity }));
}

/**
 * The company to re-project voucher usage for, or null when this order redeemed nothing.
 * An order can carry a company purely for member pricing, and that must not trigger a
 * HubSpot write.
 */
function voucherCompanyIfRedeemed(order: {
  member_company_id?: string | null;
  voucher_seats_redeemed?: number;
  voucher_credit_cents?: number;
}): string | null {
  if (!order.member_company_id) return null;
  const redeemed = (order.voucher_seats_redeemed ?? 0) + (order.voucher_credit_cents ?? 0);
  return redeemed > 0 ? order.member_company_id : null;
}

/** Call a DO endpoint, return parsed JSON. Throws on non-OK HTTP. */
async function doCall(
  env: Env,
  doIdName: string,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const stub = env.EVENT_CAPACITY.get(env.EVENT_CAPACITY.idFromName(doIdName));
  const resp = await stub.fetch(`https://do${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp.json() as Promise<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// confirmPayment
// ---------------------------------------------------------------------------

/**
 * Confirm payment for an order identified by HubSpot invoice id.
 *
 * 1. Load order + event.
 * 2. Call DO /confirm (passes orderItems so the DO can commit even if the
 *    hold already expired).
 * 3. If expired_and_oversold → return {oversold:true} without touching D1.
 * 4. Otherwise → mark order paid, issue signed tickets, return {oversold:false}.
 *
 * Idempotent: a paid order is a no-op.
 */
export async function confirmPayment(
  env: Env,
  job: ConfirmPaymentJob,
): Promise<{ oversold: boolean }> {
  const { hsInvoiceId, portalId } = job;

  const order = await loadOrderByInvoice(env.DB, portalId, hsInvoiceId);
  if (!order) return { oversold: false }; // not our invoice
  if (order.status === 'paid') return { oversold: false }; // idempotent replay
  if (order.status === 'cancelled') return { oversold: true }; // late payment after hold expiry

  const event = await loadEvent(env.DB, portalId, order.event_id);
  if (!event) return { oversold: false };

  const regsResult = await env.DB.prepare(
    // Three requirements meet here and all three are load-bearing:
    //  · cancelled_at IS NULL — a seat cancelled out of a multi-seat booking leaves its
    //    order `paid`/`pending` for the colleagues who remain, so confirming that order
    //    must not re-commit the cancelled seat or mint it a ticket;
    //  · event_id — each ticket admits to the module it was sold for, not the parent;
    //  · seat_unnamed (0039) — a seat held with nobody on it yet gets no ticket.
    // Dropping any one of them silently mis-issues tickets.
    `SELECT id, event_id, ticket_type_id, attendee_email, attendee_name, hubspot_contact_id,
            seat_unnamed
       FROM registrations WHERE order_id = ?1 AND cancelled_at IS NULL`,
  )
    .bind(order.id)
    .all<RegRow>();
  const registrations = regsResult.results;
  const bundleComponents = await loadCourseBundleComponents(env.DB, portalId, order.id);
  const selectedModuleOrder = !order.reservation_id && bundleComponents.length > 0;
  const parentRegistrations = registrations.filter(
    (registration) => !registration.event_id || registration.event_id === event.id,
  );

  const orderItems = aggregateItems(parentRegistrations.map((r) => r.ticket_type_id));
  const doIdName = `${portalId}:${event.hubspot_event_id}`;

  if (order.reservation_id) {
    const doData = await doCall(env, doIdName, '/confirm', {
      holdId: order.reservation_id,
      orderItems,
    });

    if (!doData.ok && doData.reason === 'expired_and_oversold') {
      return { oversold: true };
    }
  } else if (!selectedModuleOrder) {
    return { oversold: false };
  }

  // The module seats. `confirmCourseBundleComponents` covers both package shapes: a
  // complete course, whose parent attendees are cloned into every module, and a
  // selected-module order, whose attendees are already registered against the modules
  // themselves and so has no parent attendee to clone.
  const bundle = await confirmCourseBundleComponents(env, {
    portalId,
    order,
    event,
    parentOrderItems: orderItems,
    registrations: parentRegistrations,
    components: bundleComponents,
  });
  if (!bundle.ok) return { oversold: true };

  // Commit: mark paid, confirm reservation, issue tickets.
  await markPaidAndIssueTickets(env, {
    orderId: order.id,
    portalId,
    eventId: order.event_id,
    reservationId: order.reservation_id,
    registrations,
    memberCompanyId: voucherCompanyIfRedeemed(order),
    paymentMethod: order.payment_method ?? null,
    additionalStatements: bundle.statements,
  });

  // Free bookings commit here without ever holding a seat, so the reserve-side check can
  // miss the sell-out. Cheap and idempotent — one decision per event, ever (Phase 1.1).
  await maybeFlagFastSellout(env, portalId, event);

  return { oversold: false };
}

// ---------------------------------------------------------------------------
// flagOversellForReview (Phase 18.3 — replaces the allow_oversell auto-fork)
// ---------------------------------------------------------------------------

/**
 * Called when confirmPayment reports oversold. The worker does NOT auto-resolve: the
 * payment is captured but the seat is NOT committed. We set the order to 'needs_review',
 * open a pending oversell decision, assign it to the event owner, and notify them. The
 * owner then HONOURs or REFUNDs from the App Card (see decisions.resolveDecision).
 */
export async function flagOversellForReview(env: Env, job: ConfirmPaymentJob): Promise<void> {
  const { hsInvoiceId, portalId } = job;

  const order = await loadOrderByInvoice(env.DB, portalId, hsInvoiceId);
  if (!order || order.status === 'paid' || order.status === 'needs_review') return;

  const event = await loadEvent(env.DB, portalId, order.event_id);
  if (!event) return;

  const now = new Date().toISOString();
  await env.DB.prepare(`UPDATE orders SET status = 'needs_review', updated_at = ?1 WHERE id = ?2`)
    .bind(now, order.id)
    .run();

  await createOversellDecision(env, {
    portalId,
    event,
    orderId: order.id,
    context: {
      totalCents: order.total_cents,
      currency: order.currency,
      hubspotInvoiceId: order.hubspot_invoice_id,
      buyerEmail: order.buyer_email,
    },
  });
}

// ---------------------------------------------------------------------------
// honourOversell — owner chose to honour a needs_review order (force-confirm)
// ---------------------------------------------------------------------------

/**
 * Force-commit the seat despite the capacity breach, mark the order paid, and issue
 * tickets. Invoked from decisions.resolveDecision when the owner chooses HONOUR.
 */
export async function honourOversell(env: Env, portalId: string, orderId: string): Promise<void> {
  const order = await env.DB.prepare('SELECT * FROM orders WHERE portal_id = ?1 AND id = ?2')
    .bind(portalId, orderId)
    .first<OrderRow>();
  if (!order || order.status === 'paid') return;

  const event = await loadEvent(env.DB, portalId, order.event_id);
  if (!event) return;

  const regsResult = await env.DB.prepare(
    // Same three requirements as confirmPayment above — cancelled_at, event_id and
    // seat_unnamed. This read feeds markPaidAndIssueTickets too, so without seat_unnamed an
    // unnamed seat would read as named and be issued a ticket on honour.
    `SELECT id, event_id, ticket_type_id, attendee_email, attendee_name, hubspot_contact_id,
            seat_unnamed
       FROM registrations WHERE order_id = ?1 AND cancelled_at IS NULL`,
  )
    .bind(order.id)
    .all<RegRow>();
  const allRegistrations = regsResult.results;
  const components = await loadCourseBundleComponents(env.DB, portalId, order.id);
  // A selected-module order has no parent hold: its seats are the module holds, and its
  // attendees are already registered against the modules rather than cloned into them.
  const selectedModuleOrder = !order.reservation_id && components.length > 0;

  // The parent course's own seats. A package order also carries the module registrations
  // written at confirm time, so the parent DO must be asked for the parent event's seats
  // only — and the module clones below are built from these same rows.
  // Filtered in memory rather than re-queried with `AND event_id = ?`: equivalent for this
  // variable, but a selected-module order passes the FULL set to markPaidAndIssueTickets
  // further down, and a second query scoped to the parent event would leave nothing to
  // pass. The read above already carries cancelled_at, event_id and seat_unnamed.
  const registrations = allRegistrations.filter(
    (registration) => registration.event_id === order.event_id,
  );

  const orderItems = aggregateItems(registrations.map((r) => r.ticket_type_id));
  const doIdName = `${portalId}:${event.hubspot_event_id}`;
  if (order.reservation_id) {
    await doCall(env, doIdName, '/confirm', {
      holdId: order.reservation_id,
      orderItems,
      force: true,
    });
  }

  // A complete course is one order across several events. Honouring it has to enrol the
  // buyer in the modules as well: the oversell that sent the order to review is often a
  // module's, and marking the parent paid on its own would take the money for a course
  // package and enrol nobody in the course. Forced, because the owner has already decided
  // to breach the capacity — that decision is what HONOUR means.
  const bundle = await confirmCourseBundleComponents(env, {
    portalId,
    order,
    event,
    parentOrderItems: orderItems,
    registrations,
    components,
    force: true,
  });
  if (!bundle.ok) {
    // Forced confirmation is refused only by something a retry can fix (a component event
    // that cannot be read). Throwing leaves the order in needs_review with the decision
    // open, which is recoverable; marking it paid without its modules is not.
    throw new Error(`Course package components could not be confirmed for order ${order.id}`);
  }

  await markPaidAndIssueTickets(env, {
    orderId: order.id,
    portalId,
    eventId: order.event_id,
    reservationId: order.reservation_id,
    registrations: selectedModuleOrder ? allRegistrations : registrations,
    memberCompanyId: voucherCompanyIfRedeemed(order),
    paymentMethod: order.payment_method ?? null,
    additionalStatements: bundle.statements,
  });
}

// ---------------------------------------------------------------------------
// handleRefund
// ---------------------------------------------------------------------------

/**
 * Process a refund triggered by a HubSpot webhook (invoice voided, etc.).
 *
 * 1. DO /refund to free seats.
 * 2. Mark order refunded + cancel registrations + queue me.cancel per attendee.
 * 3. Promote waitlist (next-in-line offer, 30-minute TTL).
 *
 * Idempotent: a refunded order is a no-op.
 */
export async function handleRefund(env: Env, job: RefundPaymentJob): Promise<void> {
  const { hsInvoiceId, portalId } = job;

  const order = await loadOrderByInvoice(env.DB, portalId, hsInvoiceId);
  if (!order) return;
  if (order.status === 'refunded' || order.status === 'cancelled') return;

  const event = await loadEvent(env.DB, portalId, order.event_id);
  if (!event) return;

  const regsResult = await env.DB.prepare(
    `SELECT id, event_id, ticket_type_id, attendee_email, hubspot_contact_id
       FROM registrations WHERE order_id = ?1`,
  )
    .bind(order.id)
    .all<{
      id: string;
      event_id: string;
      ticket_type_id: string;
      attendee_email: string;
      hubspot_contact_id: string | null;
    }>();
  const registrations = regsResult.results;

  await cancelOrderWithRefund(env, { order, event, registrations, portalId, reason: 'refund' });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface RegRow {
  id: string;
  event_id?: string;
  ticket_type_id: string;
  attendee_email: string;
  hubspot_contact_id: string | null;
  attendee_name?: string;
  /** 1 = a seat held with no attendee on it yet (Ref 74b). Optional pre-0039. */
  seat_unnamed?: number;
}

/** Best-effort compensation when one member of a paid course package cannot confirm. */
async function rollbackConfirmedCourseBundle(
  env: Env,
  portalId: string,
  holds: Array<{
    event: EventRow;
    reservationId: string | null;
    orderItems: Array<{ ticketTypeId: string; quantity: number }>;
  }>,
): Promise<void> {
  await Promise.allSettled(
    holds
      .filter((hold) => hold.reservationId && hold.orderItems.length > 0)
      .map((hold) =>
        doCall(env, `${portalId}:${hold.event.hubspot_event_id}`, '/cancel-seats', {
          holdId: hold.reservationId,
          items: hold.orderItems,
        }),
      ),
  );
}

/**
 * Take the module seats for a complete-course order and build the D1 work that enrols its
 * attendees in each one.
 *
 * Shared by the ordinary confirmation and the HONOUR resolution of an oversell decision,
 * because a package order that skips this is paid for a course its buyer is not in. The
 * only difference between the two is `force`: an owner honouring a breach has already
 * decided the module may go over, where an ordinary confirmation must refuse and hand the
 * order to a human.
 *
 * Returns the statements rather than running them, so the module reservations, the module
 * registrations and the parent order's own transition all commit in one batch.
 */
async function confirmCourseBundleComponents(
  env: Env,
  input: {
    portalId: string;
    order: OrderRow;
    event: EventRow;
    parentOrderItems: Array<{ ticketTypeId: string; quantity: number }>;
    /**
     * The parent course's attendees — the people cloned into each module. A
     * selected-module order has none: its buyer is already registered against the modules
     * themselves, so there is nothing to clone, no seat shortfall to make up, and the
     * statements below come out as the reservation and component transitions alone.
     */
    registrations: RegRow[];
    /** The order's components, when the caller has already loaded them. */
    components?: CourseBundleComponentRow[];
    force?: boolean;
  },
): Promise<{ ok: true; statements: D1PreparedStatement[] } | { ok: false }> {
  const { portalId, order, event, parentOrderItems, registrations, force } = input;
  // A cancelled component's hold was already released and its reservation already
  // cancelled, so confirming it either commits a seat for a module nobody is attending or,
  // if that seat has since been sold, reports a false oversell and sends a paid booking to
  // needs_review. Filtered HERE rather than at the two call sites on purpose: they derive
  // `selectedModuleOrder` from the unfiltered list, and a fully-cancelled selected-module
  // order filtered early would look like an ordinary one-event order and take the
  // `!selectedModuleOrder` early return, silently leaving the order unpaid.
  const components = (
    input.components ?? (await loadCourseBundleComponents(env.DB, portalId, order.id))
  ).filter((component) => component.status !== 'cancelled');
  if (components.length === 0) return { ok: true, statements: [] };

  const events: EventRow[] = [];
  const seatCorrections: D1PreparedStatement[] = [];
  const confirmed: Array<{
    event: EventRow;
    reservationId: string;
    orderItems: Array<{ ticketTypeId: string; quantity: number }>;
  }> = [];
  const rollback = async () => {
    await rollbackConfirmedCourseBundle(env, portalId, [
      { event, reservationId: order.reservation_id, orderItems: parentOrderItems },
      ...confirmed,
    ]);
  };

  for (const component of components) {
    const componentEvent = await loadEvent(env.DB, portalId, component.event_id);
    if (!componentEvent) {
      await rollback();
      return { ok: false };
    }
    // The seats this module is HOLDING. A live hold is committed only when the items match
    // it exactly (the DO refuses a mismatch), so this has to be the number the hold was
    // taken with, not the number we would like it to have been.
    const held = componentSeats(component);
    const orderItems = [{ ticketTypeId: component.ticket_type_id, quantity: held }];
    const componentData = await doCall(
      env,
      `${portalId}:${componentEvent.hubspot_event_id}`,
      '/confirm',
      { holdId: component.reservation_id, orderItems, ...(force ? { force: true } : {}) },
    );
    if (!componentData.ok) {
      await rollback();
      return { ok: false };
    }
    confirmed.push({ event: componentEvent, reservationId: component.reservation_id, orderItems });

    // And the seats it NEEDS: one per parent attendee, because every one of them is about
    // to be written into this module. A booking made before migration 0036 held one seat
    // however many people were on it, and those bookings are still out there awaiting
    // payment — confirming such a hold as it stands enrols four people against one seat,
    // which is the oversell 0036 was added to stop rather than one it gets to ignore.
    //
    // So the shortfall is taken now, through the DO, on its own stable hold id: an id the
    // DO has never seen takes its expired path, which grants the seats only if the module
    // genuinely has them and otherwise refuses. A refusal is the right answer — the order
    // goes to needs_review and an owner decides, exactly as any other late oversell does.
    // The id is derived rather than random so a replayed confirmation is idempotent.
    const shortfall = registrations.length - held;
    if (shortfall > 0) {
      const topUpItems = [{ ticketTypeId: component.ticket_type_id, quantity: shortfall }];
      const topUpHoldId = `${component.id}:seats`;
      const topUp = await doCall(
        env,
        `${portalId}:${componentEvent.hubspot_event_id}`,
        '/confirm',
        { holdId: topUpHoldId, orderItems: topUpItems, ...(force ? { force: true } : {}) },
      );
      if (!topUp.ok) {
        await rollback();
        return { ok: false };
      }
      confirmed.push({
        event: componentEvent,
        reservationId: topUpHoldId,
        orderItems: topUpItems,
      });
      // The row now says what the module actually carries, so a later refund or cancel
      // gives back every seat this booking took rather than the one it first held.
      seatCorrections.push(
        env.DB.prepare(
          `UPDATE course_bundle_components SET seats = ?1, updated_at = ?2 WHERE id = ?3`,
        ).bind(registrations.length, new Date().toISOString(), component.id),
      );
    }
    events.push(componentEvent);
  }

  const statements = await courseBundlePaymentStatements({
    env,
    portalId,
    orderId: order.id,
    parentRegistrations: registrations,
    components,
    events,
  });
  return { ok: true, statements: [...seatCorrections, ...statements] };
}

/**
 * Seats held in one module. Rows written before migration 0036 have no count of their own
 * and held exactly one seat, which is the number their DO is still carrying.
 */
function componentSeats(component: CourseBundleComponentRow): number {
  const seats = Math.trunc(Number(component.seats));
  return Number.isFinite(seats) && seats > 0 ? seats : 1;
}

/**
 * Once payment is confirmed, clone each parent-course attendee into each
 * included module. The module registrations and tickets share the parent order
 * but use the child event and private package ticket for check-in/reporting.
 */
async function courseBundlePaymentStatements(input: {
  env: Env;
  portalId: string;
  orderId: string;
  parentRegistrations: RegRow[];
  components: CourseBundleComponentRow[];
  events: EventRow[];
}): Promise<D1PreparedStatement[]> {
  const { env, portalId, orderId, parentRegistrations, components, events } = input;
  const now = new Date().toISOString();
  const eventsById = new Map(events.map((event) => [event.id, event]));
  const stmts: D1PreparedStatement[] = [];

  for (const component of components) {
    const event = eventsById.get(component.event_id);
    if (!event) throw new Error(`Missing course component event ${component.event_id}`);
    stmts.push(
      env.DB.prepare(`UPDATE reservations SET status = 'confirmed' WHERE id = ?1`).bind(
        component.reservation_id,
      ),
      env.DB.prepare(
        `UPDATE course_bundle_components
           SET status = 'confirmed', updated_at = ?1 WHERE id = ?2`,
      ).bind(now, component.id),
    );

    for (const parentRegistration of parentRegistrations) {
      // A complete-course package clones each parent seat onto every included module. A
      // parent seat with nobody on it has nobody to clone (Ref 74b): the module seat would
      // carry an empty attendee and raise a me.register that invents a contact. The seat
      // is still held on the module — `component.seats` counts it, so the module capacity
      // is reserved — and the amend that names the parent seat is what creates the module
      // registrations for that person.
      if (parentRegistration.seat_unnamed === 1) continue;
      const registrationId = crypto.randomUUID();
      const ticketId = crypto.randomUUID();
      const qrCode = await mintTicketForTenant(env, portalId, ticketId, registrationId, event.id);
      const outboxId = crypto.randomUUID();
      stmts.push(
        env.DB.prepare(
          `INSERT INTO registrations
             (id, portal_id, order_id, event_id, ticket_type_id, hubspot_contact_id,
              attendee_email, attendee_name, ticket_id, unit_cents, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?10)`,
        ).bind(
          registrationId,
          portalId,
          orderId,
          event.id,
          component.ticket_type_id,
          parentRegistration.hubspot_contact_id,
          parentRegistration.attendee_email,
          parentRegistration.attendee_name ?? parentRegistration.attendee_email,
          ticketId,
          now,
        ),
        env.DB.prepare(
          `INSERT INTO tickets
             (id, portal_id, registration_id, order_id, event_id, ticket_type_id, status, qr_code, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'issued', ?7, ?8)`,
        ).bind(
          ticketId,
          portalId,
          registrationId,
          orderId,
          event.id,
          component.ticket_type_id,
          qrCode,
          now,
        ),
        env.DB.prepare(
          `INSERT INTO outbox (id, portal_id, topic, payload, stable_interaction_datetime, created_at)
           VALUES (?1, ?2, 'me.register', ?3, ?4, ?5)`,
        ).bind(
          outboxId,
          portalId,
          JSON.stringify({
            registrationId,
            attendeeEmail: parentRegistration.attendee_email,
            hubspotContactId: parentRegistration.hubspot_contact_id,
            hubspotEventId: event.hubspot_event_id,
            externalAccountId: portalId,
            ticketTypeId: component.ticket_type_id,
          }),
          now,
          now,
        ),
      );
    }
  }
  return stmts;
}

interface MarkPaidArgs {
  orderId: string;
  portalId: string;
  eventId: string;
  reservationId: string | null;
  registrations: Array<{
    id: string;
    event_id?: string | null;
    ticket_type_id: string;
    seat_unnamed?: number;
    attendee_email?: string;
    hubspot_contact_id?: string | null;
  }>;
  /**
   * How the booking was to be paid (`orders.payment_method`). Only `'card'` earns a
   * registration-confirmation row here: a free or invoice-terms booking was already
   * confirmed to the customer at reserve, and raising a second row would stamp the same
   * value twice (Ref 61).
   */
  paymentMethod?: string | null;
  /**
   * Company whose vouchers this order redeemed. Only set when the order actually redeemed
   * something, so an ordinary member booking doesn't trigger a pointless HubSpot write.
   */
  memberCompanyId?: string | null;
  /** Module registrations/tickets created only when a complete course is paid. */
  additionalStatements?: D1PreparedStatement[];
}

async function markPaidAndIssueTickets(env: Env, args: MarkPaidArgs): Promise<void> {
  const {
    orderId,
    portalId,
    eventId,
    reservationId,
    registrations,
    memberCompanyId,
    paymentMethod,
    additionalStatements = [],
  } = args;
  const now = new Date().toISOString();

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(`UPDATE orders SET status = 'paid', updated_at = ?1 WHERE id = ?2`).bind(
      now,
      orderId,
    ),
  ];

  if (reservationId) {
    stmts.push(
      env.DB.prepare(`UPDATE reservations SET status = 'confirmed' WHERE id = ?1`).bind(
        reservationId,
      ),
    );
  }

  for (const reg of registrations) {
    // A ticket names the person it admits, so a seat held with nobody on it does not get
    // one (Ref 74b). Its seat is still committed by the caller — the company paid for it —
    // and the amend that attaches a name mints the ticket then.
    if (reg.seat_unnamed === 1) continue;
    // tickets.id is the plain ticket id (tid); the scannable QR code is the
    // signed { tid, rid, eid } token minted with the per-event verify key.
    const ticketEventId = reg.event_id || eventId;
    const ticketId = crypto.randomUUID();
    const qrCode = await mintTicketForTenant(env, portalId, ticketId, reg.id, ticketEventId);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO tickets
           (id, portal_id, registration_id, order_id, event_id, ticket_type_id, status, qr_code, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'issued', ?7, ?8)`,
      ).bind(ticketId, portalId, reg.id, orderId, ticketEventId, reg.ticket_type_id, qrCode, now),
      env.DB.prepare(`UPDATE registrations SET ticket_id = ?1, updated_at = ?2 WHERE id = ?3`).bind(
        ticketId,
        now,
        reg.id,
      ),
    );
  }

  // The seat is now committed, so the voucher it draws on is spent. Outbox row goes in the
  // same batch as the commit; the handler recomputes usage from D1 at delivery time.
  const voucherSyncOutboxId = memberCompanyId ? crypto.randomUUID() : null;
  if (memberCompanyId && voucherSyncOutboxId) {
    stmts.push(voucherUsageSyncStatement(env, portalId, memberCompanyId, voucherSyncOutboxId, now));
  }

  // Ref 61: the money has landed, so a card-at-checkout booking is now a booking the buyer
  // can be told about. Free and invoice-terms bookings raised their row at reserve.
  //
  // One row per distinct ATTENDEE, not per registration. A complete-course booking holds a
  // seat on the parent and one on every included module, all the same person on the same
  // order — so a per-registration row would stamp the same value onto the same contact
  // four times over. The handler would no-op the repeats, but they are still four HubSpot
  // reads and four outbox rows for one email.
  const seen = new Set<string>();
  const confirmations: Array<{ reg: MarkPaidArgs['registrations'][number]; outboxId: string }> = [];
  if (paymentMethod === 'card') {
    for (const reg of registrations) {
      if (reg.seat_unnamed === 1 || !reg.attendee_email) continue;
      const key = reg.attendee_email.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      confirmations.push({ reg, outboxId: crypto.randomUUID() });
    }
  }
  for (const { reg, outboxId } of confirmations) {
    stmts.push(
      registrationConfirmationStatement(
        env,
        portalId,
        {
          registrationId: reg.id,
          orderId,
          attendeeEmail: reg.attendee_email as string,
          hubspotContactId: reg.hubspot_contact_id ?? null,
        },
        outboxId,
        now,
      ),
    );
  }

  stmts.push(...additionalStatements);

  await env.DB.batch(stmts);

  if (memberCompanyId && voucherSyncOutboxId) {
    await signalVoucherUsageSync(env, portalId, memberCompanyId, voucherSyncOutboxId);
  }

  for (const { reg, outboxId } of confirmations) {
    await signalRegistrationConfirmation(env, portalId, outboxId, reg.id);
  }
}

interface RefundOrderLike {
  id: string;
  reservation_id: string | null;
  event_id: string;
  hubspot_invoice_id?: string | null;
  total_cents?: number;
  member_company_id?: string | null;
  voucher_seats_redeemed?: number;
  voucher_credit_cents?: number;
}

interface ApplyRefundArgs {
  order: RefundOrderLike;
  event: { id: string; hubspot_event_id: string };
  registrations: RegRow[];
  portalId: string;
  /** Final order status: 'refunded' (full), 'partially_refunded', or 'cancelled' (none). */
  finalStatus: string;
  /** Amount recorded as refunded on the order (cents). */
  refundedCents: number;
  /**
   * When set, a `payment.refund` outbox row is created so the HubSpot-side refund is
   * issued (full → void the invoice; partial → refund the amount). Null for the
   * webhook-driven path, where the void already happened in HubSpot.
   */
  hubspotRefund: { hsInvoiceId: string | null; amountCents: number; kind: string } | null;
}

/**
 * Shared refund state-change: free the seat, mark the order, cancel registrations +
 * tickets, queue me.cancel per attendee, optionally issue the HubSpot refund, and (for
 * now) promote the waitlist. Both the webhook void path and the admin policy refund use it.
 */
async function applyRefund(env: Env, args: ApplyRefundArgs): Promise<void> {
  const { order, event, registrations, portalId, finalStatus, refundedCents, hubspotRefund } = args;
  const now = new Date().toISOString();
  const bundleComponents = await loadCourseBundleComponents(env.DB, portalId, order.id);
  const bundleEvents = await Promise.all(
    bundleComponents.map(async (component) => ({
      component,
      event: await loadEvent(env.DB, portalId, component.event_id),
    })),
  );
  const eventsById = new Map<string, { id: string; hubspot_event_id: string }>([
    [event.id, event],
    ...bundleEvents.flatMap(({ event: componentEvent }) =>
      componentEvent ? [[componentEvent.id, componentEvent] as const] : [],
    ),
  ]);

  // Free every committed package seat. This remains best-effort: D1 is the
  // durable record and the Capacity DO rehydrates from it after an outage.
  const parentOrderItems = aggregateItems(
    registrations
      .filter((registration) => !registration.event_id || registration.event_id === event.id)
      .map((registration) => registration.ticket_type_id),
  );
  await Promise.allSettled([
    ...(order.reservation_id && parentOrderItems.length > 0
      ? [
          doCall(env, `${portalId}:${event.hubspot_event_id}`, '/refund', {
            holdId: order.reservation_id,
            orderItems: parentOrderItems,
          }),
        ]
      : []),
    ...bundleEvents.flatMap(({ component, event: componentEvent }) => {
      if (!componentEvent) return [];
      const orderItems = aggregateItems(
        registrations
          .filter((registration) => registration.event_id === component.event_id)
          .map((registration) => registration.ticket_type_id),
      );
      return orderItems.length === 0
        ? []
        : [
            doCall(env, `${portalId}:${componentEvent.hubspot_event_id}`, '/refund', {
              holdId: component.reservation_id,
              orderItems,
            }),
          ];
    }),
  ]);

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE orders SET status = ?1, refunded_cents = ?2, updated_at = ?3 WHERE id = ?4`,
    ).bind(finalStatus, refundedCents, now, order.id),
    env.DB.prepare(`UPDATE reservations SET status = 'cancelled' WHERE id = ?1`).bind(
      order.reservation_id,
    ),
    env.DB.prepare(`UPDATE tickets SET status = 'cancelled' WHERE order_id = ?1`).bind(order.id),
    ...(bundleComponents.length > 0
      ? [
          env.DB.prepare(
            `UPDATE reservations
                SET status = 'cancelled'
              WHERE id IN (
                SELECT reservation_id FROM course_bundle_components
                 WHERE portal_id = ?1 AND order_id = ?2
              )`,
          ).bind(portalId, order.id),
          env.DB.prepare(
            `UPDATE course_bundle_components
                SET status = 'cancelled', updated_at = ?1
              WHERE portal_id = ?2 AND order_id = ?3 AND status = 'confirmed'`,
          ).bind(now, portalId, order.id),
          env.DB.prepare(
            `UPDATE registrations
                SET cancelled_at = COALESCE(cancelled_at, ?1),
                    cancellation_reason = COALESCE(cancellation_reason, 'course_package_refund'),
                    updated_at = ?1
              WHERE portal_id = ?2 AND order_id = ?3`,
          ).bind(now, portalId, order.id),
        ]
      : []),
  ];

  // One me.cancel outbox entry per attendee (stable interactionDateTime so retries are safe).
  const meCancelOutboxIds: string[] = [];
  for (const reg of registrations) {
    const registrationEvent = reg.event_id ? (eventsById.get(reg.event_id) ?? event) : event;
    const outboxId = crypto.randomUUID();
    meCancelOutboxIds.push(outboxId);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO outbox (id, portal_id, topic, payload, stable_interaction_datetime, created_at)
         VALUES (?1, ?2, 'me.cancel', ?3, ?4, ?5)`,
      ).bind(
        outboxId,
        portalId,
        JSON.stringify({
          registrationId: reg.id,
          attendeeEmail: reg.attendee_email,
          hubspotContactId: reg.hubspot_contact_id,
          hubspotEventId: registrationEvent.hubspot_event_id,
          externalAccountId: portalId,
        }),
        now,
        now,
      ),
    );
    stmts.push(
      env.DB.prepare(
        `UPDATE registrations SET marketing_event_state_synced = 0, updated_at = ?1 WHERE id = ?2`,
      ).bind(now, reg.id),
    );
  }

  // Issue the HubSpot-side refund via the outbox (admin-initiated path only).
  let refundOutboxId: string | null = null;
  if (hubspotRefund && hubspotRefund.kind !== 'none') {
    refundOutboxId = crypto.randomUUID();
    stmts.push(
      env.DB.prepare(
        `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
         VALUES (?1, ?2, 'payment.refund', ?3, ?4)`,
      ).bind(
        refundOutboxId,
        portalId,
        JSON.stringify({
          orderId: order.id,
          hsInvoiceId: hubspotRefund.hsInvoiceId,
          amountCents: hubspotRefund.amountCents,
          kind: hubspotRefund.kind,
        }),
        now,
      ),
    );
  }

  // The order leaves the committed statuses here, so its seats stop counting against the
  // company's vouchers — return them by re-projecting the recomputed usage.
  const voucherCompanyId = voucherCompanyIfRedeemed(order);
  const voucherSyncOutboxId = voucherCompanyId ? crypto.randomUUID() : null;
  if (voucherCompanyId && voucherSyncOutboxId) {
    stmts.push(
      voucherUsageSyncStatement(env, portalId, voucherCompanyId, voucherSyncOutboxId, now),
    );
  }

  await env.DB.batch(stmts);

  // Drain signals (best-effort; cron is the backstop).
  try {
    const signals: { body: Record<string, unknown> }[] = meCancelOutboxIds.map((outboxId, i) => ({
      body: { kind: 'me.cancel', portalId, outboxId, registrationId: registrations[i].id },
    }));
    if (refundOutboxId) {
      signals.push({ body: { kind: 'payment.refund', portalId, outboxId: refundOutboxId } });
    }
    if (voucherCompanyId && voucherSyncOutboxId) {
      signals.push({
        body: {
          kind: 'company.sync_voucher_usage',
          portalId,
          companyId: voucherCompanyId,
          outboxId: voucherSyncOutboxId,
        },
      });
    }
    if (signals.length > 0) await env.QUEUE.sendBatch(signals);
  } catch {
    // swallow
  }

  void refundedCents;

  // Seats just freed. The worker no longer auto-offers (Phase 18.3): if anyone is waiting,
  // open a waitlist decision for the event owner to pick who to offer to. Best-effort.
  try {
    const snapshot = await waitlistSnapshot(env, portalId, event.id);
    if (snapshot.length > 0) {
      const fullEvent = await loadEvent(env.DB, portalId, event.id);
      if (fullEvent) {
        await createWaitlistDecision(env, {
          portalId,
          event: fullEvent,
          context: { freedSeats: registrations.length, waitlist: snapshot },
        });
      }
    }
  } catch {
    // swallow — a later free or the cron retries.
  }
}

/**
 * Webhook-driven full refund (HubSpot invoice voided). The void already happened in
 * HubSpot, so we don't re-issue it — just apply the full-refund state change.
 */
async function cancelOrderWithRefund(
  env: Env,
  args: {
    order: RefundOrderLike;
    event: { id: string; hubspot_event_id: string };
    registrations: RegRow[];
    portalId: string;
    reason: string;
  },
): Promise<void> {
  await applyRefund(env, {
    order: args.order,
    event: args.event,
    registrations: args.registrations,
    portalId: args.portalId,
    finalStatus: 'refunded',
    refundedCents: args.order.total_cents ?? 0,
    hubspotRefund: null,
  });
}

// ---------------------------------------------------------------------------
// executeRefund — admin/owner-initiated refund honouring the per-event policy
// ---------------------------------------------------------------------------

export type RefundResult =
  | { status: 'refunded'; outcome: RefundOutcome }
  | { status: 'noop'; reason: string };

/**
 * Refund an order per its resolved policy. Computes full / partial / none from days-until-
 * event, applies the state change, and issues the HubSpot-side refund. Order-level (one
 * invoice per order); idempotent — an already-refunded/cancelled order is a no-op.
 */
/**
 * Void an order's HubSpot invoice because a human asked, now (migration 0039).
 *
 * The `manual_review` counterpart to what expiry does automatically. The reason is
 * deliberately NOT `expired_hold`: that one re-reads the order at drain time and stands
 * down unless it is still cancelled, because the booking can come back in the gap between
 * enqueue and drain. This one names an invoice a person has already decided about, so it
 * voids as asked — the same rule every other reason follows.
 *
 * Returns the outbox id, or null when there is no invoice to void.
 */
export async function enqueueInvoiceVoid(
  env: Env,
  portalId: string,
  orderId: string,
): Promise<string | null> {
  const order = await env.DB.prepare(
    `SELECT id, hubspot_invoice_id, total_cents
       FROM orders
      WHERE id = ?1 AND portal_id = ?2
        AND hubspot_invoice_id IS NOT NULL AND hubspot_invoice_id != ''`,
  )
    .bind(orderId, portalId)
    .first<{ id: string; hubspot_invoice_id: string; total_cents: number }>();
  if (!order) return null;

  const outboxId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
     VALUES (?1, ?2, 'payment.refund', ?3, ?4)`,
  )
    .bind(
      outboxId,
      portalId,
      JSON.stringify({
        orderId: order.id,
        hsInvoiceId: order.hubspot_invoice_id,
        amountCents: order.total_cents,
        kind: 'full',
        reason: 'manual_void',
      }),
      new Date().toISOString(),
    )
    .run();

  try {
    await env.QUEUE.send({ kind: 'payment.refund', portalId, outboxId });
  } catch {
    // Best-effort drain; the reconciliation cron re-drives pending outbox rows.
  }
  return outboxId;
}

export async function executeRefund(
  env: Env,
  portalId: string,
  orderId: string,
): Promise<RefundResult> {
  const order = await env.DB.prepare('SELECT * FROM orders WHERE portal_id = ?1 AND id = ?2')
    .bind(portalId, orderId)
    .first<OrderRow>();
  if (!order) return { status: 'noop', reason: 'order_not_found' };
  if (
    order.status === 'refunded' ||
    order.status === 'cancelled' ||
    order.status === 'partially_refunded'
  ) {
    return { status: 'noop', reason: 'already_refunded' };
  }

  const event = await loadEvent(env.DB, portalId, order.event_id);
  if (!event) return { status: 'noop', reason: 'event_not_found' };

  const regsResult = await env.DB.prepare(
    `SELECT id, event_id, ticket_type_id, attendee_email, hubspot_contact_id, seat_unnamed
       FROM registrations WHERE order_id = ?1`,
  )
    .bind(order.id)
    .all<RegRow>();
  const registrations = regsResult.results;

  const policy = await resolveRefundPolicy(env, event);
  const outcome = computeRefund(policy, {
    totalCents: order.total_cents,
    eventStartsAt: event.starts_at,
    nowMs: Date.now(),
  });

  const finalStatus =
    outcome.kind === 'full'
      ? 'refunded'
      : outcome.kind === 'partial'
        ? 'partially_refunded'
        : 'cancelled';

  await applyRefund(env, {
    order,
    event,
    registrations,
    portalId,
    finalStatus,
    refundedCents: outcome.amountCents,
    hubspotRefund: {
      hsInvoiceId: order.hubspot_invoice_id,
      amountCents: outcome.amountCents,
      kind: outcome.kind,
    },
  });

  return { status: 'refunded', outcome };
}
