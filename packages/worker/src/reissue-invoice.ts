/**
 * Reissue the HubSpot invoice for a booking whose invoice was voided (Phase 4.2).
 *
 * THE FAULT THIS RECOVERS FROM. A HubSpot invoice has no "cancelled" status — `voided` is
 * the only terminal one — so the worker closes an expired hold's unpaid invoice by voiding
 * it (`expireHold` → `payment.refund` with `reason: 'expired_hold'`). Voiding is
 * IRREVERSIBLE: a voided invoice cannot be reopened, re-sent, or paid, and its hosted
 * payment link is dead. The AWS D1.1 booking hit exactly that — the seat lapsed after
 * fifteen minutes, the invoice was voided, and the customer who was about to pay it had
 * nothing left to pay. Phase 4.1 stopped it happening (the hold now runs to the due date);
 * this is the way back for a booking it already happened to, and for any later void that
 * turns out to have been premature.
 *
 * WHAT REISSUE IS, AND IS NOT. It is not un-voiding: nothing can un-void a HubSpot invoice.
 * It is giving the SAME order a fresh invoice — same deal, same line items, same money —
 * and a live seat to go with it. The old invoice id is superseded and explicitly closed, so
 * a portal never ends up with two payable invoices for one booking.
 *
 * THE SEAT IS RE-TAKEN THROUGH THE DO, AND MAY BE REFUSED. The seat was freed when the hold
 * lapsed, and in the meantime it may have been sold. There is no version of this that
 * assumes the seat is still there: the DO is asked for it exactly as a fresh booking would
 * be, and a full event fails the reissue with `event_full` rather than overselling. The
 * hold that comes back is a HOLD — this commits nothing, and the seat still commits only on
 * payment confirm (CLAUDE.md invariant).
 *
 * WHAT IT REFUSES. An order that was actually PAID, refunded or partially refunded is out
 * of scope: money moved, and undoing that is a refund decision with a policy behind it, not
 * an invoice-clerical one. Reissue only serves an order that never got paid.
 */

import { formatBookingLineItemName } from './commerce-lines';
import { loadEvent, loadTicketTypes, type OrderRow, type TicketTypeRow } from './db';
import { syncCapacityBeforeHold } from './hubdb-capacity';
import {
  clampInvoiceDueDays,
  DEFAULT_INVOICE_DUE_DAYS,
  resolveInvoiceDueDate,
} from './routes/reserve';
import type { Env } from './types';

/** Statuses a reissue may act on: the booking never took payment. */
const REISSUABLE_ORDER_STATUSES = new Set(['cancelled', 'pending']);

export interface ReissueInvoiceArgs {
  portalId: string;
  orderId: string;
  /** Staff-chosen due date (YYYY-MM-DD). Omitted → the event/portal payment terms. */
  invoiceDueDate?: string | null;
}

export type ReissueInvoiceResult =
  | {
      ok: true;
      orderId: string;
      reservationId: string;
      /** The invoice being replaced, when there was one. */
      supersededInvoiceId: string | null;
      invoiceDueDate: string;
      holdExpiresAt: string;
      seats: number;
    }
  | { ok: false; error: string; message: string };

interface ReservationItemRow {
  ticket_type_id: string;
  quantity: number;
  unit_cents: number | null;
}

export async function reissueInvoice(
  env: Env,
  args: ReissueInvoiceArgs,
): Promise<ReissueInvoiceResult> {
  const { portalId, orderId } = args;

  const order = await env.DB.prepare('SELECT * FROM orders WHERE portal_id = ?1 AND id = ?2')
    .bind(portalId, orderId)
    .first<OrderRow>();
  if (!order) return fail('order_not_found', 'Order not found');

  if (!REISSUABLE_ORDER_STATUSES.has(order.status)) {
    return fail(
      'order_not_reissuable',
      `An order in status "${order.status}" has taken payment or been settled — reissuing an ` +
        'invoice for it would create a second payable invoice. Refund or cancel it instead.',
    );
  }
  if (order.total_cents <= 0) {
    return fail('order_not_payable', 'A free or fully comped booking has no invoice to reissue');
  }

  const event = await loadEvent(env.DB, portalId, order.event_id);
  if (!event) return fail('event_not_found', 'Event not found');
  if (!order.hubspot_deal_id) {
    // invoice.create needs the deal, and would sit retrying forever without it. Say so now.
    return fail(
      'deal_missing',
      'This booking has no HubSpot deal yet — let the deal write-back drain, then reissue.',
    );
  }

  // The seats to re-take: the ones this booking still has. A registration cancelled
  // individually (Phase 3.2) gave its seat back deliberately and must not come back here.
  const seatRows = (
    await env.DB.prepare(
      `SELECT ticket_type_id, COUNT(*) AS quantity
         FROM registrations
        WHERE order_id = ?1 AND cancelled_at IS NULL
        GROUP BY ticket_type_id`,
    )
      .bind(orderId)
      .all<{ ticket_type_id: string; quantity: number }>()
  ).results;
  if (seatRows.length === 0) {
    return fail('no_live_seats', 'Every seat on this booking has been cancelled');
  }
  const seats = seatRows.reduce((sum, row) => sum + row.quantity, 0);

  // The invoice's lines come from the reservation the booking was priced under, so the
  // reissued invoice bills exactly what the original did — a re-price here would quietly
  // charge today's prices for a booking made months ago.
  const items = order.reservation_id
    ? (
        await env.DB.prepare(
          `SELECT ticket_type_id, quantity, unit_cents
             FROM reservation_items WHERE reservation_id = ?1`,
        )
          .bind(order.reservation_id)
          .all<ReservationItemRow>()
      ).results
    : [];
  if (items.length === 0) {
    return fail('reservation_items_missing', 'This booking has no priced lines to reinvoice');
  }

  const dueDays =
    clampInvoiceDueDays(event.invoice_due_days) ??
    clampInvoiceDueDays(order.payment_terms_days) ??
    (await portalInvoiceDueDays(env, portalId)) ??
    DEFAULT_INVOICE_DUE_DAYS;
  let invoiceDue: { date: string; expiresAt: string };
  try {
    invoiceDue = resolveInvoiceDueDate(args.invoiceDueDate ?? undefined, dueDays);
  } catch (err) {
    return fail(
      'invalid_invoice_due_date',
      err instanceof Error ? err.message : 'Invalid due date',
    );
  }

  // ---- Re-take the seats. The DO decides, and may say no. -------------------
  const reservationId = crypto.randomUUID();
  const ticketTypes = await loadTicketTypes(env.DB, event.id);
  const ttById = new Map<string, TicketTypeRow>(ticketTypes.map((tt) => [tt.id, tt]));
  const doIdName = `${portalId}:${event.hubspot_event_id}`;
  const stub = env.EVENT_CAPACITY.get(env.EVENT_CAPACITY.idFromName(doIdName));
  if (!(await syncCapacityBeforeHold(env, portalId, stub, event, ticketTypes))) {
    return fail(
      'capacity_unconfirmed',
      'Capacity was just lowered and could not be confirmed; try the reissue again.',
    );
  }

  const doResp = await stub.fetch('https://do/reserve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      holdId: reservationId,
      items: seatRows.map((row) => ({
        ticketTypeId: row.ticket_type_id,
        quantity: row.quantity,
      })),
      expiresAt: invoiceDue.expiresAt,
    }),
  });
  const doData = (await doResp.json()) as { ok: boolean; full?: boolean; expiresAt?: string };
  if (!doData.ok || !doData.expiresAt) {
    return fail(
      doData.full ? 'event_full' : 'reserve_failed',
      doData.full
        ? 'The seats on this booking have since been sold. Use the waitlist decision to free one.'
        : 'The seat could not be re-held',
    );
  }
  const holdExpiresAt = doData.expiresAt;

  // ---- D1: new hold, order back to pending, fresh invoice ------------------
  const now = new Date().toISOString();
  const supersededInvoiceId = order.hubspot_invoice_id;
  const invoiceOutboxId = crypto.randomUUID();
  const supersedeOutboxId = supersededInvoiceId ? crypto.randomUUID() : null;

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO reservations (id, portal_id, event_id, idempotency_key, status, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6)`,
    ).bind(
      reservationId,
      portalId,
      event.id,
      `reissue:${orderId}:${reservationId}`,
      holdExpiresAt,
      now,
    ),
  ];

  for (const item of items) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO reservation_items (id, portal_id, reservation_id, ticket_type_id, quantity, unit_cents)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      ).bind(
        crypto.randomUUID(),
        portalId,
        reservationId,
        item.ticket_type_id,
        item.quantity,
        item.unit_cents,
      ),
    );
  }

  // Clearing hubspot_invoice_id is what makes handleInvoiceCreate mint a NEW invoice
  // rather than resuming the voided one — it reuses a stored id by design, to avoid
  // creating a second payable invoice on retry.
  stmts.push(
    env.DB.prepare(
      `UPDATE orders
          SET status = 'pending',
              reservation_id = ?1,
              hubspot_invoice_id = NULL,
              hubspot_invoice_url = NULL,
              payment_method = 'invoice',
              payment_terms_days = ?2,
              updated_at = ?3
        WHERE id = ?4 AND portal_id = ?5`,
    ).bind(reservationId, dueDays, now, orderId, portalId),
  );

  // Close the invoice being replaced. Its own reason, not 'expired_hold': that one stands
  // down when the order is no longer cancelled, which is precisely the state this leaves
  // it in. Voiding an already-voided invoice is a no-op, so this is safe on the recovery
  // path as well as on a still-open one.
  if (supersededInvoiceId && supersedeOutboxId) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
         VALUES (?1, ?2, 'payment.refund', ?3, ?4)`,
      ).bind(
        supersedeOutboxId,
        portalId,
        JSON.stringify({
          orderId,
          hsInvoiceId: supersededInvoiceId,
          amountCents: order.total_cents,
          kind: 'full',
          reason: 'reissue_superseded',
        }),
        now,
      ),
    );
  }

  stmts.push(
    env.DB.prepare(
      `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
       VALUES (?1, ?2, 'invoice.create', ?3, ?4)`,
    ).bind(
      invoiceOutboxId,
      portalId,
      JSON.stringify({
        orderId,
        eventId: event.id,
        hubspotEventId: event.hubspot_event_id,
        buyerEmail: order.buyer_email,
        buyerName: order.buyer_name,
        buyerAbn: order.buyer_abn,
        totalCents: order.total_cents,
        currency: order.currency,
        invoiceDueDate: invoiceDue.date,
        lineItems: items.map((item) => {
          const tt = ttById.get(item.ticket_type_id);
          const unitCents = item.unit_cents ?? 0;
          return {
            ticketTypeId: item.ticket_type_id,
            // A voucher-covered line was named "(training voucher)" on the original
            // invoice; it is a $0 line either way, and the attendee still appears on it.
            name: formatBookingLineItemName(event.title, tt?.name ?? 'Registration'),
            quantity: item.quantity,
            unitCents,
            totalCents: unitCents * item.quantity,
            taxTreatment: tt?.tax_treatment ?? 'gst',
            hsTaxRateId: tt?.hs_tax_rate_id ?? null,
            hsProductId: tt?.hs_product_id ?? null,
          };
        }),
        reissued: true,
      }),
      now,
    ),
  );

  // A reissued hold runs to the invoice due date — up to 90 days. If D1 rejects the batch
  // there is no reservation and no order pointing at that hold, so nothing would ever
  // release it and the seats would sit unsellable for the whole term. Give them back, the
  // same way the reserve path compensates its own failed persistence.
  try {
    await env.DB.batch(stmts);
  } catch (err) {
    try {
      await stub.fetch('https://do/release', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ holdId: reservationId }),
      });
    } catch {
      // Best-effort: the DO's own TTL alarm reaps the hold if this could not reach it.
    }
    console.log(
      JSON.stringify({
        level: 'error',
        event: 'reissue_invoice_persist_failed',
        portalId,
        orderId,
        reservationId,
        message: String(err),
      }),
    );
    return fail('reissue_persist_failed', 'The reissued booking could not be saved');
  }

  try {
    const signals: { body: Record<string, unknown> }[] = [
      { body: { kind: 'invoice.create', portalId, outboxId: invoiceOutboxId, orderId } },
    ];
    if (supersedeOutboxId) {
      signals.push({ body: { kind: 'payment.refund', portalId, outboxId: supersedeOutboxId } });
    }
    await env.QUEUE.sendBatch(signals);
  } catch {
    // Best-effort — the outbox cron drains what the signal missed.
  }

  return {
    ok: true,
    orderId,
    reservationId,
    supersededInvoiceId,
    invoiceDueDate: invoiceDue.date,
    holdExpiresAt,
    seats,
  };
}

function fail(error: string, message: string): ReissueInvoiceResult {
  return { ok: false, error, message };
}

async function portalInvoiceDueDays(env: Env, portalId: string): Promise<number | null> {
  try {
    const row = await env.DB.prepare('SELECT invoice_due_days FROM tenants WHERE portal_id = ?1')
      .bind(portalId)
      .first<{ invoice_due_days: number | null }>();
    return clampInvoiceDueDays(row?.invoice_due_days);
  } catch {
    return null;
  }
}
