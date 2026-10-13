/**
 * Soft-cancel ONE registration (Phase 3.2).
 *
 * Everything before this cancelled at ORDER granularity — `executeRefund` voids the
 * invoice, flips `orders.status` and takes every seat on the booking with it. That is the
 * right shape when the booking is one person and the wrong shape for the case Weld
 * actually has: a four-seat corporate booking where one person can no longer come.
 * Cancelling the order there would cancel three colleagues who are still coming.
 *
 * The four constraints this path is built around, and where each is honoured:
 *
 *   The seat is released through the EventCapacity DO, never by decrementing a count in
 *     D1. `/cancel-seats` — which shrinks a live hold or a commit, whichever the seat is
 *     sitting in — is the only place the number changes. `registrations.cancelled_at`
 *     RECORDS the cancellation; it does not perform it. (The DO's own D1 rebuild subtracts
 *     the same rows, so a cold start agrees with what happened here.)
 *
 *   Cancelling one of several must not cancel the order. The order is only touched when
 *     the cancelled seat was its LAST live one — at which point leaving it 'paid' would be
 *     the lie instead. Siblings alive: the order keeps its status and only accrues
 *     `refunded_cents`.
 *
 *   Refund handling is governed by the event's refund_policy_id, and no default is
 *     invented. `resolveRefundPolicy` + `computeRefund` decide, over this seat's share of
 *     the booking; a policy that grants nothing after its cutoff grants nothing here.
 *     `refund: 'none'` is available for the seat staff have already settled elsewhere, and
 *     it is a stated choice on the request, not a fallback this module reaches for.
 *
 *   A freed seat opens a waitlist decision and never auto-offers. Same
 *     `createWaitlistDecision` call the refund and hold-expiry paths make.
 *
 * On the seat's share of the money: the seat says what it cost. `registrations.unit_cents`
 * (0028) is the amount THIS seat contributed to the order total, so cancelling a member seat
 * out of a mixed-price group refunds the member price rather than the group average, and a
 * voucher-covered or comped seat refunds nothing because nothing was charged for it.
 *
 * Bookings taken before 0028 have no seat record and cannot get one — the aggregate cannot
 * say which of a ticket type's zeroed lines belonged to which person. Those fall back to the
 * booking's unrefunded value spread over its live seats: exact for a one-seat booking, an
 * approximation for a mixed-price group, and never able to refund more than was taken. The
 * response says which basis was used, and `refundAmountCents` overrides both.
 *
 * Vouchers come back the same way, and this is the second thing the seat record made
 * possible: a covered seat's `voucher_seats` / `voucher_cents` are subtracted from the
 * ORDER's redemption totals, so the company's balance recovers the moment the seat does.
 * Usage stays DERIVED (CLAUDE.md) — it is still summed over `orders`, never incremented;
 * what changes is the order's own record of what it redeems, because one of the seats it
 * redeemed for is gone. Before this, a cancelled voucher seat consumed the balance forever:
 * the order stayed 'paid' on behalf of the colleagues still coming, so nothing ever moved.
 */

import { loadCourseBundleComponents, loadEvent, type OrderRow } from './db';
import { createWaitlistDecision } from './decisions';
import { computeRefund, resolveRefundPolicy } from './refund-policy';
import type { Env } from './types';
import { voucherUsageSyncStatement } from './vouchers';
import { waitlistSnapshot } from './waitlist';

/** Order statuses whose money is actually in hand, and so can be given back. */
const COLLECTED_ORDER_STATUSES = new Set(['paid', 'confirmed', 'needs_review']);

/**
 * How long one request owns a cancellation before another may take it over (0037).
 *
 * Long enough that a cancel in flight is never elbowed aside — the whole path is a
 * handful of round trips — and short enough that a worker which died holding one does not
 * strand the seat. Taking over a lease is safe: it is only reachable while `cancelled_at`
 * is still NULL, which means the abandoned attempt wrote nothing.
 */
const CANCELLATION_CLAIM_TTL_MS = 60_000;

interface RegistrationRow {
  id: string;
  portal_id: string;
  order_id: string;
  event_id: string;
  ticket_type_id: string;
  attendee_email: string;
  attendee_name: string;
  hubspot_contact_id: string | null;
  cancelled_at: string | null;
  /** What this seat contributed to the order total (0028). NULL = booked before 0028. */
  unit_cents: number | null;
  voucher_seats: number | null;
  voucher_cents: number | null;
}

export interface CancelRegistrationArgs {
  portalId: string;
  registrationId: string;
  /** Staff-supplied, stored verbatim on the registration. */
  reason?: string | null;
  /**
   * 'policy' (default) resolves the event's refund policy for this seat. 'none' cancels the
   * seat and moves no money — for a comp, or a refund already handled outside the worker.
   */
  refund?: 'policy' | 'none';
  /** Overrides the seat share the policy is applied to. Clamped to the unrefunded total. */
  refundAmountCents?: number | null;
}

export interface CancelRefundSummary {
  kind: 'full' | 'partial' | 'none';
  /** What this cancellation refunds, in cents. */
  amountCents: number;
  /** The seat amount the policy was applied to. */
  seatAmountCents: number;
  /**
   * Where that amount came from. `seat` = the seat's own recorded price (0028);
   * `order_share` = a pre-0028 booking with no seat record, split over its live seats;
   * `override` = the caller supplied `refundAmountCents`. Surfaced because the first is
   * exact and the second is an estimate, and staff reading a refund should know which.
   */
  basis: 'seat' | 'order_share' | 'override';
  /** The resolved policy, or null when only the built-in fallback applied. */
  policyId: string | null;
}

/** Vouchers handed back to the company by this cancellation. */
export interface CancelVoucherSummary {
  /** Vouchers returned under 'seat' mode. */
  seats: number;
  /** Credit returned under 'credit' mode, in cents. */
  cents: number;
  /** The company the balance goes back to, or null when the seat drew on none. */
  companyId: string | null;
}

export type CancelResult =
  | {
      ok: true;
      registrationId: string;
      cancelledAt: string;
      /** Live registrations still on this booking. 0 means the order was closed too. */
      remainingOnOrder: number;
      orderStatus: string;
      refund: CancelRefundSummary;
      vouchers: CancelVoucherSummary;
      waitlistDecisionId: string | null;
    }
  | { ok: false; error: string; message?: string };

async function doCall(
  env: Env,
  idName: string,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const stub = env.EVENT_CAPACITY.get(env.EVENT_CAPACITY.idFromName(idName));
  const resp = await stub.fetch(`https://do${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await resp.json()) as Record<string, unknown>;
}

/**
 * What this seat hands back to the company's voucher balance.
 *
 * Reads the seat's own record where it has one. A booking taken before 0028 has none — and
 * its per-seat split is not recoverable, which is why the migration does not invent one —
 * so the LEGACY SHAPE is detected instead: the order says it redeemed something and not one
 * of its seats accounts for any of it. Those fall back to an even split over the live seats,
 * with the last seat taking the remainder so a booking cancelled seat by seat returns
 * exactly what it took.
 *
 * A booking whose seats DO account for their redemption is trusted verbatim, including a
 * seat that accounts for nothing — under 'credit' mode a $0 seat is legitimately covered and
 * legitimately returns nothing, and re-deriving it from the order would invent a refund.
 */
async function resolveVoucherReturn(
  env: Env,
  args: {
    portalId: string;
    reg: RegistrationRow;
    order: OrderRow;
    liveBefore: number;
  },
): Promise<CancelVoucherSummary> {
  const { portalId, reg, order, liveBefore } = args;
  const companyId = order.member_company_id ?? null;
  const orderSeats = order.voucher_seats_redeemed ?? 0;
  const orderCents = order.voucher_credit_cents ?? 0;
  const none: CancelVoucherSummary = { seats: 0, cents: 0, companyId: null };

  if (!companyId || (orderSeats <= 0 && orderCents <= 0)) return none;

  const recorded = await env.DB.prepare(
    `SELECT COALESCE(SUM(voucher_seats), 0) AS seats, COALESCE(SUM(voucher_cents), 0) AS cents
       FROM registrations WHERE order_id = ?1 AND portal_id = ?2`,
  )
    .bind(order.id, portalId)
    .first<{ seats: number; cents: number }>();

  const legacySeats = orderSeats > 0 && (recorded?.seats ?? 0) === 0;
  const legacyCents = orderCents > 0 && (recorded?.cents ?? 0) === 0;

  const share = (total: number): number =>
    liveBefore <= 1 ? total : Math.floor(total / liveBefore);

  const seats = legacySeats ? share(orderSeats) : (reg.voucher_seats ?? 0);
  const cents = legacyCents ? share(orderCents) : (reg.voucher_cents ?? 0);

  // Never hand back more than the order still records as redeemed.
  const returnSeats = Math.max(0, Math.min(seats, orderSeats));
  const returnCents = Math.max(0, Math.min(cents, orderCents));
  if (returnSeats === 0 && returnCents === 0) return none;
  return { seats: returnSeats, cents: returnCents, companyId };
}

export async function cancelRegistration(
  env: Env,
  args: CancelRegistrationArgs,
): Promise<CancelResult> {
  const { portalId, registrationId } = args;

  const reg = await env.DB.prepare('SELECT * FROM registrations WHERE id = ?1 AND portal_id = ?2')
    .bind(registrationId, portalId)
    .first<RegistrationRow>();
  if (!reg) return { ok: false, error: 'registration_not_found' };
  // Idempotent by refusal rather than by silence: a second cancel would give the seat back
  // twice through the DO and refund the share again.
  if (reg.cancelled_at !== null) {
    return {
      ok: false,
      error: 'already_cancelled',
      message: 'This registration was already cancelled.',
    };
  }

  const [event, order] = await Promise.all([
    loadEvent(env.DB, portalId, reg.event_id),
    env.DB.prepare('SELECT * FROM orders WHERE id = ?1 AND portal_id = ?2')
      .bind(reg.order_id, portalId)
      .first<OrderRow>(),
  ]);
  if (!event) return { ok: false, error: 'event_not_found' };
  if (!order) return { ok: false, error: 'order_not_found' };

  // Live seats on this booking INCLUDING the one being cancelled — the denominator for the
  // seat share, and (minus one) the answer to "does this empty the booking".
  const liveRow = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM registrations
      WHERE order_id = ?1 AND portal_id = ?2 AND cancelled_at IS NULL`,
  )
    .bind(reg.order_id, portalId)
    .first<{ c: number }>();
  const liveBefore = Math.max(1, liveRow?.c ?? 1);
  const remainingOnOrder = liveBefore - 1;
  const isLastSeat = remainingOnOrder === 0;

  // ---- Money ----------------------------------------------------------------
  const unrefunded = Math.max(0, (order.total_cents ?? 0) - (order.refunded_cents ?? 0));

  // The seat says what it cost (0028). Clamped to what is left unrefunded so a booking
  // already partly refunded through the order-level path cannot be refunded past its total.
  let basis: CancelRefundSummary['basis'] = 'seat';
  let seatAmountCents: number;
  if (args.refundAmountCents != null) {
    basis = 'override';
    seatAmountCents = Math.max(0, Math.min(Math.round(args.refundAmountCents), unrefunded));
  } else if (reg.unit_cents !== null) {
    seatAmountCents = Math.max(0, Math.min(reg.unit_cents, unrefunded));
  } else {
    // Pre-0028 booking: no seat record, and none is recoverable. Spread the booking over its
    // live seats, giving the last seat whatever is left rather than a rounded share — so a
    // booking cancelled seat by seat still comes out at exactly its total instead of losing
    // the remainder of the division.
    basis = 'order_share';
    seatAmountCents = isLastSeat ? unrefunded : Math.floor(unrefunded / liveBefore);
  }

  const policy = await resolveRefundPolicy(env, event);
  let refund: CancelRefundSummary = {
    kind: 'none',
    amountCents: 0,
    seatAmountCents,
    basis,
    policyId: policy.id,
  };
  const refundable = args.refund !== 'none' && COLLECTED_ORDER_STATUSES.has(order.status);
  if (refundable && seatAmountCents > 0) {
    const outcome = computeRefund(policy, {
      totalCents: seatAmountCents,
      eventStartsAt: event.starts_at,
      nowMs: Date.now(),
    });
    refund = { ...refund, kind: outcome.kind, amountCents: outcome.amountCents };
  }

  // ---- Vouchers -------------------------------------------------------------
  // A covered seat gives its vouchers back to the company. The amounts come off the ORDER's
  // redemption totals, which is where usage is summed from — so the balance recovers without
  // any compensating write, exactly as a whole-order refund already did by leaving the
  // committed statuses.
  const vouchers = await resolveVoucherReturn(env, { portalId, reg, order, liveBefore });

  // Voiding the invoice is only right when the refund settles the WHOLE booking: an invoice
  // voided over one seat of four would wipe three colleagues' payment record in HubSpot and,
  // through Data Sync, in Xero.
  const hubspotRefundKind =
    refund.amountCents <= 0
      ? null
      : isLastSeat && refund.amountCents >= unrefunded
        ? 'full'
        : 'partial';

  // ---- Take the cancellation LEASE (0037) ------------------------------------
  // What races is the lease, not the cancellation. Two concurrent cancels of one seat
  // both used to reach the DO and the outbox and only afterwards learn which of them had
  // flipped `cancelled_at`, so the loser freed a second seat and issued the refund again.
  // Flipping `cancelled_at` up here instead fixed the race and bought a worse failure: a
  // worker that stopped before the batch left a seat reading cancelled forever with no
  // refund, no `me.cancel` and a live ticket, and a retry read it as already cancelled.
  //
  // A lease loses the other way. Abandoned, it expires and the seat is cancellable again;
  // `cancelled_at` stays with the outbox rows it belongs to, in one batch.
  const now = new Date().toISOString();
  const claimToken = crypto.randomUUID();
  const staleBefore = new Date(Date.now() - CANCELLATION_CLAIM_TTL_MS).toISOString();
  const claim = await env.DB.prepare(
    `UPDATE registrations
        SET cancellation_claim = ?1, cancellation_claimed_at = ?2
      WHERE id = ?3 AND portal_id = ?4 AND cancelled_at IS NULL
        AND (cancellation_claim IS NULL OR cancellation_claimed_at < ?5)`,
  )
    .bind(claimToken, now, reg.id, portalId, staleBefore)
    .run();
  if ((claim.meta?.changes ?? 0) === 0) {
    // Either it is already cancelled, or another request is mid-cancel on it. Both are
    // "not yours", and both are what the caller needs to hear.
    return {
      ok: false,
      error: 'already_cancelled',
      message: 'This registration was already cancelled.',
    };
  }

  /** Drop the lease, so a failure below leaves the seat cancellable without waiting it out. */
  const releaseClaim = async () => {
    try {
      await env.DB.prepare(
        `UPDATE registrations
            SET cancellation_claim = NULL, cancellation_claimed_at = NULL
          WHERE id = ?1 AND portal_id = ?2 AND cancellation_claim = ?3`,
      )
        .bind(reg.id, portalId, claimToken)
        .run();
    } catch {
      // Nothing more to try, and nothing is lost: the lease expires on its own.
    }
  };

  // ---- D1 -------------------------------------------------------------------
  const meCancelOutboxId = crypto.randomUUID();
  const refundOutboxId = hubspotRefundKind ? crypto.randomUUID() : null;
  const voucherSyncOutboxId = vouchers.companyId ? crypto.randomUUID() : null;

  const stmts: D1PreparedStatement[] = [
    // The cancellation itself, in the same batch as the outbox rows that carry it out —
    // the invariant this file has to keep. Guarded on the lease, so it is still exactly
    // one request's to make.
    env.DB.prepare(
      `UPDATE registrations
          SET cancelled_at = ?1, cancellation_reason = ?2,
              marketing_event_state_synced = 0, updated_at = ?1,
              cancellation_claim = NULL, cancellation_claimed_at = NULL
        WHERE id = ?3 AND portal_id = ?4 AND cancelled_at IS NULL
          AND cancellation_claim = ?5`,
    ).bind(now, args.reason ?? null, reg.id, portalId, claimToken),

    // Only an ISSUED ticket is cancelled. A checked-in one is left exactly as it is:
    // attending is a fact, a later cancellation does not un-attend someone who walked in
    // the door, and the certificate flow reads that record.
    env.DB.prepare(
      `UPDATE tickets SET status = 'cancelled'
        WHERE registration_id = ?1 AND portal_id = ?2 AND status = 'issued'`,
    ).bind(reg.id, portalId),

    // The Marketing Event participation is per contact, so cancelling one seat cancels
    // exactly one participation record — the colleagues on the same order are untouched.
    env.DB.prepare(
      `INSERT INTO outbox (id, portal_id, topic, payload, stable_interaction_datetime, created_at)
       VALUES (?1, ?2, 'me.cancel', ?3, ?4, ?4)`,
    ).bind(
      meCancelOutboxId,
      portalId,
      JSON.stringify({
        registrationId: reg.id,
        attendeeEmail: reg.attendee_email,
        hubspotContactId: reg.hubspot_contact_id,
        hubspotEventId: event.hubspot_event_id,
        externalAccountId: portalId,
      }),
      now,
    ),
  ];

  // The order moves only when nothing live is left on it, which is the constraint stated at
  // the top of this file. `refunded_cents` accrues either way: the money left whether or not
  // the booking did.
  // The order redeems less than it did, because one of the seats it redeemed for is gone.
  // Floored at zero: a legacy split that rounds up must never drive the column negative and
  // hand a company more balance than it ever spent.
  if (vouchers.companyId && (vouchers.seats > 0 || vouchers.cents > 0)) {
    stmts.push(
      env.DB.prepare(
        `UPDATE orders
            SET voucher_seats_redeemed = MAX(0, voucher_seats_redeemed - ?1),
                voucher_credit_cents   = MAX(0, voucher_credit_cents   - ?2),
                updated_at = ?3
          WHERE id = ?4 AND portal_id = ?5`,
      ).bind(vouchers.seats, vouchers.cents, now, order.id, portalId),
      // Zero the seat's own record too, so a re-read of the booking still adds up to the
      // order's new totals and a replayed cancel cannot return the same vouchers twice.
      env.DB.prepare(
        'UPDATE registrations SET voucher_seats = 0, voucher_cents = 0 WHERE id = ?1',
      ).bind(reg.id),
    );
  }

  const refundedTotal = (order.refunded_cents ?? 0) + refund.amountCents;
  let orderStatus = order.status;
  if (isLastSeat) {
    orderStatus =
      refundedTotal >= (order.total_cents ?? 0) && refundedTotal > 0
        ? 'refunded'
        : refundedTotal > 0
          ? 'partially_refunded'
          : 'cancelled';
    stmts.push(
      env.DB.prepare(
        `UPDATE orders SET status = ?1, refunded_cents = ?2, updated_at = ?3 WHERE id = ?4`,
      ).bind(orderStatus, refundedTotal, now, order.id),
    );
    if (order.reservation_id) {
      stmts.push(
        env.DB.prepare(`UPDATE reservations SET status = 'cancelled' WHERE id = ?1`).bind(
          order.reservation_id,
        ),
      );
    }
  } else if (refund.amountCents > 0) {
    stmts.push(
      // Accrued, not assigned: two seats on one booking cancelled at the same time both
      // read the same `refunded_cents` and an absolute write would drop one of the shares.
      env.DB.prepare(
        `UPDATE orders SET refunded_cents = refunded_cents + ?1, updated_at = ?2 WHERE id = ?3`,
      ).bind(refund.amountCents, now, order.id),
    );
  }

  if (refundOutboxId && hubspotRefundKind) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
         VALUES (?1, ?2, 'payment.refund', ?3, ?4)`,
      ).bind(
        refundOutboxId,
        portalId,
        JSON.stringify({
          orderId: order.id,
          hsInvoiceId: order.hubspot_invoice_id,
          amountCents: refund.amountCents,
          kind: hubspotRefundKind,
          reason: 'registration_cancelled',
          registrationId: reg.id,
        }),
        now,
      ),
    );
  }

  // Project the company's recomputed usage back onto its HubSpot record. In the same batch
  // as the state change that moved it, per the outbox invariant; the handler recomputes from
  // D1 at delivery time, so a delayed or retried row writes the current figure.
  if (vouchers.companyId && voucherSyncOutboxId) {
    stmts.push(
      voucherUsageSyncStatement(env, portalId, vouchers.companyId, voucherSyncOutboxId, now),
    );
  }

  // A selected-module or complete-course order keeps one child hold per module, so this
  // registration's seat belongs to the component for its OWN event, and that component's
  // reservation is the hold the DO knows about — not orders.reservation_id, which such an
  // order leaves NULL.
  //
  // Read through loadCourseBundleComponents so a database predating migration 0033 degrades
  // to an empty list rather than throwing: those orders are ordinary one-event orders whose
  // orders.reservation_id IS the right hold, and a cancellation must not 500 at a customer
  // because an additive migration has not been applied.
  const components = await loadCourseBundleComponents(env.DB, portalId, order.id);
  const componentHoldId =
    components.find((component) => component.event_id === reg.event_id)?.reservation_id ?? null;

  // Only tear the component down when this was its LAST live seat. A component can hold
  // several seats, and cancelling its reservation row while colleagues still hold seats on
  // the same module would give back capacity nobody released — the same mistake, one level
  // down, that cancelling the whole order for one seat would have been.
  let componentEmptied = false;
  if (componentHoldId) {
    const siblingRow = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM registrations
        WHERE order_id = ?1 AND portal_id = ?2 AND event_id = ?3
          AND id != ?4 AND cancelled_at IS NULL`,
    )
      .bind(reg.order_id, portalId, reg.event_id, reg.id)
      .first<{ c: number }>();
    componentEmptied = (siblingRow?.c ?? 0) === 0;
  }
  if (componentHoldId && componentEmptied) {
    stmts.push(
      env.DB.prepare(
        `UPDATE course_bundle_components SET status = 'cancelled', updated_at = ?1
           WHERE portal_id = ?2 AND order_id = ?3 AND event_id = ?4`,
      ).bind(now, portalId, order.id, reg.event_id),
      env.DB.prepare(`UPDATE reservations SET status = 'cancelled' WHERE id = ?1`).bind(
        componentHoldId,
      ),
    );
  } else if (componentHoldId) {
    // Seats still remain on this module, so the component lives on — but it is now one
    // seat smaller, and `seats` is what payment confirms against. The DO compares the
    // requested items to the live hold and refuses a mismatch outright
    // (`orderItems_mismatch`), so leaving the stale larger number here would turn the next
    // payment on this booking into a false oversell.
    stmts.push(
      env.DB.prepare(
        `UPDATE course_bundle_components
           SET seats = MAX(0, seats - 1), updated_at = ?1
           WHERE portal_id = ?2 AND order_id = ?3 AND event_id = ?4`,
      ).bind(now, portalId, order.id, reg.event_id),
    );
  }

  // One batch: the seat is cancelled, its ticket voided, and every row that refunds the
  // money and tells HubSpot written, or none of it is. A failure here has changed nothing
  // but the lease, which is given straight back.
  try {
    await env.DB.batch(stmts);
  } catch (err) {
    await releaseClaim();
    throw err;
  }

  // ---- Release the seat (the DO owns this number) ----------------------------
  // After the batch, not before: D1 is the durable record and the DO rebuilds from it, so
  // a DO that cannot be reached converges on the next rehydrate. Doing it first would
  // have freed a seat for a cancellation that then failed to commit.
  //
  // A selected-module order holds NULL in orders.reservation_id — its seats live in one
  // child hold per module — so the hold id has to come from course_bundle_components for
  // this registration's event. Passing the NULL through made /cancel-seats skip the
  // live-hold branch entirely and decrement `confirmed` instead, which is a no-op on an
  // unpaid seat: the child hold survived and the seat stayed out of sale until its hold
  // expired, up to the invoice due date.
  const doIdName = `${portalId}:${event.hubspot_event_id}`;
  try {
    await doCall(env, doIdName, '/cancel-seats', {
      holdId: componentHoldId ?? order.reservation_id,
      items: [{ ticketTypeId: reg.ticket_type_id, quantity: 1 }],
    });
  } catch {
    // Best-effort, as every other seat-freeing path is.
  }

  try {
    const signals: Array<{ body: Record<string, unknown> }> = [
      {
        body: {
          kind: 'me.cancel',
          portalId,
          outboxId: meCancelOutboxId,
          registrationId: reg.id,
        },
      },
    ];
    if (refundOutboxId) {
      signals.push({ body: { kind: 'payment.refund', portalId, outboxId: refundOutboxId } });
    }
    if (vouchers.companyId && voucherSyncOutboxId) {
      signals.push({
        body: {
          kind: 'company.sync_voucher_usage',
          portalId,
          companyId: vouchers.companyId,
          outboxId: voucherSyncOutboxId,
        },
      });
    }
    await env.QUEUE.sendBatch(signals);
  } catch {
    // swallow — the reconciliation cron re-drives pending outbox rows.
  }

  // ---- The freed seat is offered to nobody automatically ---------------------
  let waitlistDecisionId: string | null = null;
  try {
    const snapshot = await waitlistSnapshot(env, portalId, event.id);
    if (snapshot.length > 0) {
      waitlistDecisionId = await createWaitlistDecision(env, {
        portalId,
        event,
        context: { freedSeats: 1, registrationId: reg.id, waitlist: snapshot },
      });
    }
  } catch {
    // Best-effort: a decision that could not be opened is reopened by the next free or by
    // the owner looking at the event, and must not fail a cancellation that already happened.
  }

  return {
    ok: true,
    registrationId: reg.id,
    cancelledAt: now,
    remainingOnOrder,
    orderStatus,
    refund,
    vouchers,
    waitlistDecisionId,
  };
}
