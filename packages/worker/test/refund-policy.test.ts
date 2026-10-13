import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { executeRefund } from '../src/payment';
import { computeRefund, resolveRefundPolicy } from '../src/refund-policy';
import type { Env } from '../src/types';
import { seedEvent, seedTenant, seedTicketType } from './support/fixtures';

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
  };
};

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

describe('computeRefund', () => {
  const policy = {
    id: 'x',
    fullRefundCutoffDays: 30,
    partialRefundPercent: 50,
    allowTransfer: true,
  };

  it('full refund before the cutoff', () => {
    const out = computeRefund(policy, {
      totalCents: 10000,
      eventStartsAt: daysFromNow(45),
      nowMs: Date.now(),
    });
    expect(out).toEqual({ kind: 'full', amountCents: 10000 });
  });

  it('partial refund after the cutoff', () => {
    const out = computeRefund(policy, {
      totalCents: 10000,
      eventStartsAt: daysFromNow(10),
      nowMs: Date.now(),
    });
    expect(out).toEqual({ kind: 'partial', amountCents: 5000 });
  });

  it('no refund after the cutoff when partial is null', () => {
    const noPartial = { ...policy, partialRefundPercent: null };
    const out = computeRefund(noPartial, {
      totalCents: 10000,
      eventStartsAt: daysFromNow(5),
      nowMs: Date.now(),
    });
    expect(out).toEqual({ kind: 'none', amountCents: 0 });
  });
});

describe('resolveRefundPolicy', () => {
  it('prefers event policy, then category default, then portal default, then fallback', async () => {
    const { portalId, eventId, hsEvent } = await freshIds();

    // No templates → built-in fallback.
    const fallback = await resolveRefundPolicy(E, {
      portal_id: portalId,
      refund_policy_id: null,
      category: null,
    });
    expect(fallback).toEqual({
      id: null,
      fullRefundCutoffDays: 30,
      partialRefundPercent: null,
      allowTransfer: true,
    });

    // Portal default.
    await E.DB.prepare(
      `INSERT INTO refund_policies (id, portal_id, name, is_default, category, full_refund_cutoff_days, partial_refund_percent, allow_transfer, created_at)
       VALUES ('pp-' || ?1, ?1, 'Portal default', 1, NULL, 20, 25, 1, ?2)`,
    )
      .bind(portalId, new Date().toISOString())
      .run();
    const portalDefault = await resolveRefundPolicy(E, {
      portal_id: portalId,
      refund_policy_id: null,
      category: null,
    });
    expect(portalDefault.fullRefundCutoffDays).toBe(20);

    // Category default beats portal default for a matching event category.
    await E.DB.prepare(
      `INSERT INTO refund_policies (id, portal_id, name, is_default, category, full_refund_cutoff_days, partial_refund_percent, allow_transfer, created_at)
       VALUES ('cp-' || ?1, ?1, 'Training default', 1, 'training', 14, 0, 0, ?2)`,
    )
      .bind(portalId, new Date().toISOString())
      .run();
    const categoryDefault = await resolveRefundPolicy(E, {
      portal_id: portalId,
      refund_policy_id: null,
      category: 'training',
    });
    expect(categoryDefault.fullRefundCutoffDays).toBe(14);
    expect(categoryDefault.allowTransfer).toBe(false);

    // Explicit per-event policy beats everything.
    await E.DB.prepare(
      `INSERT INTO refund_policies (id, portal_id, name, is_default, category, full_refund_cutoff_days, partial_refund_percent, allow_transfer, created_at)
       VALUES ('ep-' || ?1, ?1, 'Special', 0, NULL, 7, 90, 1, ?2)`,
    )
      .bind(portalId, new Date().toISOString())
      .run();
    const explicit = await resolveRefundPolicy(E, {
      portal_id: portalId,
      refund_policy_id: `ep-${portalId}`,
      category: 'training',
    });
    expect(explicit.fullRefundCutoffDays).toBe(7);

    void eventId;
    void hsEvent;
  });
});

async function seedPaidOrder(args: {
  portalId: string;
  eventId: string;
  hsEvent: string;
  orderId: string;
  regId: string;
  startsAt: string;
  totalCents: number;
  memberCompanyId?: string | null;
  voucherSeatsRedeemed?: number;
}) {
  const now = new Date().toISOString();
  await seedEvent(E.DB, {
    portalId: args.portalId,
    eventId: args.eventId,
    hubspotEventId: args.hsEvent,
    startsAt: args.startsAt,
  });
  const ticketTypeId = await seedTicketType(E.DB, {
    portalId: args.portalId,
    eventId: args.eventId,
    ticketTypeId: `ttA-${args.eventId}`,
  });
  await E.DB.prepare(
    `INSERT INTO orders (id, portal_id, event_id, reservation_id, hubspot_invoice_id, status,
       buyer_email, buyer_name, total_cents, refunded_cents, member_company_id,
       voucher_seats_redeemed, updated_at)
     VALUES (?1, ?2, ?3, NULL, NULL, 'paid', 'a@x.io', 'A', ?4, 0, ?5, ?6, ?7)`,
  )
    .bind(
      args.orderId,
      args.portalId,
      args.eventId,
      args.totalCents,
      args.memberCompanyId ?? null,
      args.voucherSeatsRedeemed ?? 0,
      now,
    )
    .run();
  await E.DB.prepare(
    `INSERT INTO registrations (id, portal_id, order_id, event_id, ticket_type_id, attendee_email, attendee_name, ticket_id, marketing_event_state_synced, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?6, 'a@x.io', 'A', 'tk-' || ?1, 1, ?5)`,
  )
    .bind(args.regId, args.portalId, args.orderId, args.eventId, now, ticketTypeId)
    .run();
  await E.DB.prepare(
    `INSERT INTO tickets (id, portal_id, registration_id, order_id, event_id, ticket_type_id, status, qr_code, created_at)
     VALUES ('tk-' || ?1, ?2, ?1, ?3, ?4, ?6, 'issued', 'qr', ?5)`,
  )
    .bind(args.regId, args.portalId, args.orderId, args.eventId, now, ticketTypeId)
    .run();
}

describe('executeRefund', () => {
  it('full refund before the cutoff marks the order refunded and queues a full HubSpot refund', async () => {
    const { portalId, eventId, hsEvent, orderId, regId } = await freshIds();
    await seedPaidOrder({
      portalId,
      eventId,
      hsEvent,
      orderId,
      regId,
      startsAt: daysFromNow(60),
      totalCents: 10000,
    });

    const result = await executeRefund(E, portalId, orderId);
    expect(result.status).toBe('refunded');
    if (result.status === 'refunded')
      expect(result.outcome).toEqual({ kind: 'full', amountCents: 10000 });

    const order = await E.DB.prepare('SELECT status, refunded_cents FROM orders WHERE id = ?1')
      .bind(orderId)
      .first<{ status: string; refunded_cents: number }>();
    expect(order?.status).toBe('refunded');
    expect(order?.refunded_cents).toBe(10000);

    // A second call is a no-op.
    const again = await executeRefund(E, portalId, orderId);
    expect(again.status).toBe('noop');
  });

  it('queues a voucher usage sync for a corporate order so the seat is returned', async () => {
    const { portalId, eventId, hsEvent, orderId, regId } = await freshIds();
    const companyId = `co-${orderId}`;
    await seedPaidOrder({
      portalId,
      eventId,
      hsEvent,
      orderId,
      regId,
      startsAt: daysFromNow(60),
      totalCents: 10000,
      memberCompanyId: companyId,
      voucherSeatsRedeemed: 2,
    });

    await executeRefund(E, portalId, orderId);

    const sync = await E.DB.prepare(
      `SELECT payload FROM outbox WHERE portal_id = ?1 AND topic = 'company.sync_voucher_usage'`,
    )
      .bind(portalId)
      .first<{ payload: string }>();
    expect(JSON.parse(sync?.payload ?? '{}')).toEqual({ portalId, companyId });
  });

  it('queues no voucher sync for an order that draws on no company', async () => {
    const { portalId, eventId, hsEvent, orderId, regId } = await freshIds();
    await seedPaidOrder({
      portalId,
      eventId,
      hsEvent,
      orderId,
      regId,
      startsAt: daysFromNow(60),
      totalCents: 10000,
    });

    await executeRefund(E, portalId, orderId);

    const sync = await E.DB.prepare(
      `SELECT COUNT(*) AS n FROM outbox WHERE portal_id = ?1 AND topic = 'company.sync_voucher_usage'`,
    )
      .bind(portalId)
      .first<{ n: number }>();
    expect(sync?.n).toBe(0);
  });

  it('partial refund after the cutoff records the partial amount', async () => {
    const { portalId, eventId, hsEvent, orderId, regId } = await freshIds();
    await E.DB.prepare(
      `INSERT INTO refund_policies (id, portal_id, name, is_default, category, full_refund_cutoff_days, partial_refund_percent, allow_transfer, created_at)
       VALUES ('pp-' || ?1, ?1, 'Portal default', 1, NULL, 30, 40, 1, ?2)`,
    )
      .bind(portalId, new Date().toISOString())
      .run();
    await seedPaidOrder({
      portalId,
      eventId,
      hsEvent,
      orderId,
      regId,
      startsAt: daysFromNow(5),
      totalCents: 10000,
    });

    const result = await executeRefund(E, portalId, orderId);
    expect(result.status).toBe('refunded');
    if (result.status === 'refunded')
      expect(result.outcome).toEqual({ kind: 'partial', amountCents: 4000 });

    const order = await E.DB.prepare('SELECT status, refunded_cents FROM orders WHERE id = ?1')
      .bind(orderId)
      .first<{ status: string; refunded_cents: number }>();
    expect(order?.status).toBe('partially_refunded');
    expect(order?.refunded_cents).toBe(4000);
  });
});
