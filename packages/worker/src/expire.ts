import { loadCourseBundleComponents, loadEvent } from './db';
import { createUnpaidInvoiceDecision, createWaitlistDecision } from './decisions';
import type { Env } from './types';
import { waitlistSnapshot } from './waitlist';

/**
 * Whether this portal voids a lapsed booking's unpaid invoice itself (migration 0039).
 *
 * Reading config must never fail the expiry, so a tenants table predating the migration —
 * or an unreadable one — degrades to the behaviour the worker has always had.
 */
async function voidsUnpaidInvoicesAutomatically(env: Env, portalId: string): Promise<boolean> {
  try {
    const row = await env.DB.prepare('SELECT unpaid_invoice_mode FROM tenants WHERE portal_id = ?1')
      .bind(portalId)
      .first<{ unpaid_invoice_mode: string | null }>();
    return row?.unpaid_invoice_mode !== 'manual_review';
  } catch {
    return true;
  }
}

interface ExpiringInvoiceOrder {
  id: string;
  portal_id: string;
  hubspot_invoice_id: string;
  total_cents: number;
}

interface PendingCourseBundleOrder {
  id: string;
  portal_id: string;
  reservation_id: string | null;
}

/**
 * A capacity alarm is per event, so any child module can expire first. Resolve
 * it to the parent order so the rest of the package does not remain held.
 */
async function findPendingCourseBundleOrder(
  env: Env,
  holdId: string,
): Promise<PendingCourseBundleOrder | null> {
  try {
    const parent = await env.DB.prepare(
      `SELECT id, portal_id, reservation_id
         FROM orders
        WHERE reservation_id = ?1 AND status = 'pending'`,
    )
      .bind(holdId)
      .first<PendingCourseBundleOrder>();
    if (parent) return parent;

    return await env.DB.prepare(
      `SELECT o.id, o.portal_id, o.reservation_id
         FROM course_bundle_components c
         JOIN orders o ON o.id = c.order_id
        WHERE c.reservation_id = ?1
          AND c.status = 'pending'
          AND o.status = 'pending'`,
    )
      .bind(holdId)
      .first<PendingCourseBundleOrder>();
  } catch {
    // The additive table is not on older databases, which keep the ordinary path.
    return null;
  }
}

async function releaseSiblingPackageHolds(
  env: Env,
  portalId: string,
  parentReservationId: string | null,
  expiredHoldId: string,
  components: Awaited<ReturnType<typeof loadCourseBundleComponents>>,
): Promise<void> {
  const parent = parentReservationId
    ? await env.DB.prepare('SELECT event_id FROM reservations WHERE id = ?1')
        .bind(parentReservationId)
        .first<{ event_id: string }>()
    : null;
  const releases = [
    ...(parent ? [{ eventId: parent.event_id, reservationId: parentReservationId }] : []),
    ...components.map((component) => ({
      eventId: component.event_id,
      reservationId: component.reservation_id,
    })),
  ].filter((hold) => hold.reservationId !== expiredHoldId);

  await Promise.allSettled(
    releases.map(async (hold) => {
      const event = await loadEvent(env.DB, portalId, hold.eventId);
      if (!event) return;
      const stub = env.EVENT_CAPACITY.get(
        env.EVENT_CAPACITY.idFromName(`${portalId}:${event.hubspot_event_id}`),
      );
      await stub.fetch('https://do/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ holdId: hold.reservationId }),
      });
    }),
  );
}

/**
 * Called from the queue handler when the EventCapacity DO alarm fires for a lapsed hold.
 * The DO has already freed the seats in-memory; this updates D1 to match, then — if anyone
 * is waiting — opens a waitlist decision for the event owner (Phase 18.3: no auto-offer).
 *
 * holdId is the reservation.id (the same UUID used as the DO holdId).
 * Only affects rows still in 'pending' status — idempotent if replayed.
 */
export async function expireHold(env: Env, holdId: string): Promise<void> {
  const now = new Date().toISOString();
  const packageOrder = await findPendingCourseBundleOrder(env, holdId);
  const parentReservationId = packageOrder?.reservation_id ?? holdId;
  const bundleComponents = packageOrder
    ? await loadCourseBundleComponents(env.DB, packageOrder.portal_id, packageOrder.id)
    : [];

  const invoiceOrders = (
    await (packageOrder
      ? env.DB.prepare(
          `SELECT id, portal_id, hubspot_invoice_id, total_cents
             FROM orders
            WHERE id = ?1
              AND portal_id = ?2
              AND status = 'pending'
              AND hubspot_invoice_id IS NOT NULL
              AND hubspot_invoice_id != ''`,
        ).bind(packageOrder.id, packageOrder.portal_id)
      : env.DB.prepare(
          `SELECT id, portal_id, hubspot_invoice_id, total_cents
             FROM orders
            WHERE reservation_id = ?1
              AND status = 'pending'
              AND hubspot_invoice_id IS NOT NULL
              AND hubspot_invoice_id != ''`,
        ).bind(parentReservationId)
    ).all<ExpiringInvoiceOrder>()
  ).results;

  // Migration 0039: a portal can take the void decision away from the clock. The seat still
  // goes back on sale below either way — that is what a lapsed hold IS, and it is already
  // what happens whenever the hold runs shorter than the invoice. What `manual_review`
  // withholds is the irreversible half: voiding the invoice a company was asked to pay.
  const autoVoid =
    invoiceOrders.length === 0 ||
    (await voidsUnpaidInvoicesAutomatically(env, invoiceOrders[0].portal_id));
  const voidingOrders = autoVoid ? invoiceOrders : [];
  const manualReviewOrders = autoVoid ? [] : invoiceOrders;

  // Every `json_extract` over `outbox` below reads through `IIF(json_valid(...))`, and so
  // does every other one in the worker.
  //
  // SQLite RAISES on `json_extract` of a payload that is not well-formed JSON, and it
  // raises for the whole statement — so one unparseable row anywhere in a portal's outbox
  // took down this batch (an expiring hold that then never released its seat), the staff
  // note write-back, the attendance derivation and the 2.2 registration report, none of
  // which have anything to do with that row. The dispatcher now marks such a row dead on
  // sight, but a row already sitting in the table is exactly the case this has to survive.
  const invoiceOutboxIds = voidingOrders.map(() => crypto.randomUUID());
  const results = await env.DB.batch([
    // Composed from both sides: 0039 decides WHICH orders are voided (voidingOrders — a
    // portal on manual_review voids none of them), and the selected-module work decides HOW
    // the row is written for a bundle order, whose seats live in course_bundle_components
    // rather than on orders.reservation_id. The two are orthogonal: one gates, one shapes.
    ...voidingOrders.map((order, index) =>
      (packageOrder?.reservation_id === null
        ? env.DB.prepare(
            `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
             SELECT ?1, ?2, 'payment.refund', ?3, ?4
             WHERE EXISTS (
               SELECT 1
                 FROM course_bundle_components c
                 JOIN reservations r ON r.id = c.reservation_id
                 JOIN orders o ON o.id = c.order_id
                WHERE c.reservation_id = ?5
                  AND c.order_id = ?6
                  AND r.status = 'pending'
                  AND o.status = 'pending'
                  AND o.hubspot_invoice_id IS NOT NULL
                  AND o.hubspot_invoice_id != ''
             )
             AND NOT EXISTS (
               SELECT 1
                 FROM outbox existing
                WHERE existing.topic = 'payment.refund'
                  AND json_extract(IIF(json_valid(existing.payload), existing.payload, '{}'), '$.orderId') = ?6
                  AND json_extract(IIF(json_valid(existing.payload), existing.payload, '{}'), '$.reason') = 'expired_hold'
                  AND existing.status != 'dead'
             )`,
          )
        : env.DB.prepare(
            `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
             SELECT ?1, ?2, 'payment.refund', ?3, ?4
             WHERE EXISTS (
               SELECT 1
               FROM reservations r
               JOIN orders o ON o.reservation_id = r.id
               WHERE r.id = ?5
                 AND r.status = 'pending'
                 AND o.id = ?6
                 AND o.status = 'pending'
                 AND o.hubspot_invoice_id IS NOT NULL
                 AND o.hubspot_invoice_id != ''
             )
             AND NOT EXISTS (
               SELECT 1
               FROM outbox existing
               WHERE existing.topic = 'payment.refund'
                 AND json_extract(IIF(json_valid(existing.payload), existing.payload, '{}'), '$.orderId') = ?6
                 AND json_extract(IIF(json_valid(existing.payload), existing.payload, '{}'), '$.reason') = 'expired_hold'
                 AND existing.status != 'dead'
             )`,
          )
      ).bind(
        invoiceOutboxIds[index],
        order.portal_id,
        JSON.stringify({
          orderId: order.id,
          hsInvoiceId: order.hubspot_invoice_id,
          amountCents: order.total_cents,
          kind: 'full',
          reason: 'expired_hold',
        }),
        now,
        parentReservationId,
        order.id,
      ),
    ),
    env.DB.prepare(
      "UPDATE reservations SET status = 'expired' WHERE id = ?1 AND status = 'pending'",
    ).bind(parentReservationId),
    ...(packageOrder?.reservation_id === null
      ? [
          env.DB.prepare(
            "UPDATE orders SET status = 'cancelled', updated_at = ?2" +
              " WHERE id = ?1 AND status = 'pending'",
          ).bind(packageOrder.id, now),
        ]
      : [
          env.DB.prepare(
            "UPDATE orders SET status = 'cancelled', updated_at = ?2" +
              " WHERE reservation_id = ?1 AND status = 'pending'",
          ).bind(parentReservationId, now),
        ]),
    ...(packageOrder
      ? [
          env.DB.prepare(
            `UPDATE reservations
                SET status = 'expired'
              WHERE status = 'pending'
                AND id IN (
                  SELECT reservation_id FROM course_bundle_components
                   WHERE portal_id = ?1 AND order_id = ?2
                )`,
          ).bind(packageOrder.portal_id, packageOrder.id),
          env.DB.prepare(
            `UPDATE course_bundle_components
                SET status = 'released', updated_at = ?1
              WHERE portal_id = ?2 AND order_id = ?3 AND status = 'pending'`,
          ).bind(now, packageOrder.portal_id, packageOrder.id),
        ]
      : []),
  ]);

  // Only act if this call actually expired a live hold (freed a seat). A replay that
  // changed nothing skips the work — there's no newly-freed seat to offer.
  const freed = results[voidingOrders.length]?.meta?.changes ?? 0;
  if (freed === 0) return;

  if (packageOrder) {
    await releaseSiblingPackageHolds(
      env,
      packageOrder.portal_id,
      packageOrder.reservation_id,
      holdId,
      bundleComponents,
    );
  }

  try {
    const signals = voidingOrders.map((order, index) => ({
      body: {
        kind: 'payment.refund',
        portalId: order.portal_id,
        outboxId: invoiceOutboxIds[index],
      },
    }));
    if (signals.length > 0) await env.QUEUE.sendBatch(signals);
  } catch {
    // swallow — cron will catch pending outbox rows
  }

  const resv = await env.DB.prepare('SELECT portal_id, event_id FROM reservations WHERE id = ?1')
    .bind(parentReservationId)
    .first<{ portal_id: string; event_id: string }>();
  if (!resv) return;

  // Nothing was voided, so somebody has to decide. Raised after the batch, not before: the
  // decision describes a hold that actually lapsed, and a replay that changed nothing
  // returned above rather than handing the owner the same task twice.
  if (manualReviewOrders.length > 0) {
    const event = await loadEvent(env.DB, resv.portal_id, resv.event_id);
    if (event) {
      for (const order of manualReviewOrders) {
        try {
          await createUnpaidInvoiceDecision(env, {
            portalId: order.portal_id,
            event,
            orderId: order.id,
            context: {
              hsInvoiceId: order.hubspot_invoice_id,
              totalCents: order.total_cents,
              freedSeats: freed,
            },
          });
        } catch (error) {
          // A decision that cannot be raised must not take the expiry down with it — the
          // seat is already back on sale and the invoice is untouched, which is the safe
          // side of this to be stuck on.
          console.warn(
            JSON.stringify({
              level: 'warn',
              event: 'unpaid_invoice_decision_failed',
              portalId: order.portal_id,
              orderId: order.id,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
    }
  }

  // Open a waitlist decision for the owner if anyone is waiting (no auto-offer).
  const snapshot = await waitlistSnapshot(env, resv.portal_id, resv.event_id);
  if (snapshot.length === 0) return;
  const event = await loadEvent(env.DB, resv.portal_id, resv.event_id);
  if (event) {
    await createWaitlistDecision(env, {
      portalId: resv.portal_id,
      event,
      context: { freedSeats: freed, waitlist: snapshot },
    });
  }
}
