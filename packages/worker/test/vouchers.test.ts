import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import {
  captureVoucherBaseline,
  formatVoucherAmount,
  getVoucherBaseline,
  parseVoucherAmount,
  planVoucherRedemption,
  resolveVoucherUsage,
  voucherUsageSyncStatement,
} from '../src/vouchers';
import { seedEvent, seedTenant } from './support/fixtures';

/**
 * Corporate training vouchers.
 *
 * Two things under test: the redemption planner (which seats a balance covers) and the
 * accounting (what that costs the company, and how it comes back).
 *
 * Regression cover for the gap left by commit 85a0113 ("Unify corporate bulk checkout"),
 * which removed the only writer of HubSpot's used-property while leaving the gate that reads
 * it — so a balance never moved and vouchers could be spent forever.
 */

const E = env as unknown as Env;

let counter = 0;
// Registers the portal as it mints it: `orders.portal_id` REFERENCES `tenants`.
const fresh = async () => {
  const n = `${Date.now()}-${counter++}`;
  const portalId = `p-${n}`;
  await seedTenant(E.DB, portalId);
  return { portalId, companyId: `co-${n}` };
};

/** Seed an order that redeemed `seats` vouchers / `cents` of credit. */
async function seedOrder(args: {
  portalId: string;
  companyId: string | null;
  status: string;
  seats?: number;
  cents?: number;
}): Promise<string> {
  const orderId = `ord-${Date.now()}-${counter++}`;
  // `orders.event_id` REFERENCES `events`, and buyer_email/_name are NOT NULL: none of
  // that is what these tests are about, so the event is a throwaway with real columns.
  const eventId = `evt-${orderId}`;
  await seedEvent(E.DB, {
    portalId: args.portalId,
    eventId,
    hubspotEventId: `hs-${orderId}`,
  });
  await E.DB.prepare(
    `INSERT INTO orders
       (id, portal_id, event_id, status, buyer_email, buyer_name, member_company_id,
        voucher_seats_redeemed, voucher_credit_cents, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'buyer@weld.test', 'Buyer', ?5, ?6, ?7, '')`,
  )
    .bind(
      orderId,
      args.portalId,
      eventId,
      args.status,
      args.companyId,
      args.seats ?? 0,
      args.cents ?? 0,
    )
    .run();
  return orderId;
}

const seat = (index: number, unitCents: number) => ({ index, unitCents });

describe('planVoucherRedemption — seat mode', () => {
  it('covers the most expensive seats first, so the voucher is worth the most', () => {
    const plan = planVoucherRedemption([seat(0, 50000), seat(1, 95000), seat(2, 70000)], {
      mode: 'seat',
      available: 2,
    });

    // Two vouchers land on the $950 and $700 seats, leaving the $500 one to be invoiced.
    expect(plan.coveredSeatIndexes).toEqual([1, 2]);
    expect(plan.seatsRedeemed).toBe(2);
  });

  it('covers only what the balance allows, leaving the rest to be invoiced', () => {
    const plan = planVoucherRedemption([seat(0, 95000), seat(1, 95000), seat(2, 95000)], {
      mode: 'seat',
      available: 1,
    });

    expect(plan.coveredSeatIndexes).toHaveLength(1);
    expect(plan.seatsRedeemed).toBe(1);
  });

  it('one voucher covers a seat outright whatever it costs', () => {
    const plan = planVoucherRedemption([seat(0, 250000)], { mode: 'seat', available: 1 });

    expect(plan.coveredSeatIndexes).toEqual([0]);
    expect(plan.seatsRedeemed).toBe(1);
    // Seat mode spends vouchers, not money — no credit is drawn down.
    expect(plan.creditCents).toBe(0);
  });

  it('redeems nothing on an empty balance', () => {
    const plan = planVoucherRedemption([seat(0, 95000)], { mode: 'seat', available: 0 });
    expect(plan.coveredSeatIndexes).toEqual([]);
    expect(plan.seatsRedeemed).toBe(0);
  });
});

describe('planVoucherRedemption — credit mode', () => {
  it('draws down the balance by the price of the seats it covers', () => {
    const plan = planVoucherRedemption([seat(0, 95000), seat(1, 50000)], {
      mode: 'credit',
      available: 200000, // $2,000
    });

    expect(plan.coveredSeatIndexes).toEqual([0, 1]);
    expect(plan.creditCents).toBe(145000);
    expect(plan.seatsRedeemed).toBe(0);
  });

  it('covers whole seats only, carrying the remainder forward', () => {
    // $1,200 against three $950 seats: one seat covered, $250 left — not enough for another,
    // and deliberately NOT applied as a part-payment, so every invoice line stays whole.
    const plan = planVoucherRedemption([seat(0, 95000), seat(1, 95000), seat(2, 95000)], {
      mode: 'credit',
      available: 120000,
    });

    expect(plan.coveredSeatIndexes).toHaveLength(1);
    expect(plan.creditCents).toBe(95000);
  });

  it('skips a seat it cannot fully cover but still takes a cheaper one', () => {
    // $600 can't touch the $950 seat, but covers the $500 one.
    const plan = planVoucherRedemption([seat(0, 95000), seat(1, 50000)], {
      mode: 'credit',
      available: 60000,
    });

    expect(plan.coveredSeatIndexes).toEqual([1]);
    expect(plan.creditCents).toBe(50000);
  });

  it('covers a free seat without spending credit', () => {
    const plan = planVoucherRedemption([seat(0, 0)], { mode: 'credit', available: 10000 });
    expect(plan.coveredSeatIndexes).toEqual([0]);
    expect(plan.creditCents).toBe(0);
  });
});

describe('planVoucherRedemption — off', () => {
  it('never redeems when the tenant has vouchers disabled', () => {
    const plan = planVoucherRedemption([seat(0, 95000)], { mode: 'off', available: 999 });
    expect(plan.coveredSeatIndexes).toEqual([]);
  });
});

describe('voucher property units', () => {
  it('reads seat allowances as whole counts', () => {
    expect(parseVoucherAmount('10', 'seat')).toBe(10);
    expect(parseVoucherAmount('', 'seat')).toBe(0);
    expect(parseVoucherAmount('-3', 'seat')).toBe(0);
  });

  it('reads credit allowances as dollars and stores them as cents', () => {
    expect(parseVoucherAmount('5000', 'credit')).toBe(500000);
    expect(parseVoucherAmount('1234.56', 'credit')).toBe(123456);
    expect(parseVoucherAmount('$2,000.00', 'credit')).toBe(200000);
  });

  it('writes back in the unit the HubSpot property is keyed in', () => {
    expect(formatVoucherAmount(7, 'seat')).toBe('7');
    expect(formatVoucherAmount(123456, 'credit')).toBe('1234.56');
  });
});

describe('voucher usage accounting', () => {
  it('sums what committed orders redeemed and ignores orders that never committed', async () => {
    const { portalId, companyId } = await fresh();

    await seedOrder({ portalId, companyId, status: 'paid', seats: 2 });
    await seedOrder({ portalId, companyId, status: 'confirmed', seats: 1 }); // free-path commit
    await seedOrder({ portalId, companyId, status: 'cancelled', seats: 3 }); // expired hold
    await seedOrder({ portalId, companyId, status: 'refunded', seats: 4 }); // returned

    const usage = await resolveVoucherUsage(E.DB, portalId, companyId);
    expect(usage.committed).toBe(3);
    expect(usage.used).toBe(3);
  });

  it('counts redemption, not seats, so a partly covered booking spends only what it used', async () => {
    const { portalId, companyId } = await fresh();
    // 5 attendees, but only 2 vouchers were left to redeem.
    await seedOrder({ portalId, companyId, status: 'paid', seats: 2 });

    expect((await resolveVoucherUsage(E.DB, portalId, companyId)).used).toBe(2);
  });

  it('charges live holds against the gate but not against the HubSpot projection', async () => {
    const { portalId, companyId } = await fresh();

    await seedOrder({ portalId, companyId, status: 'paid', seats: 1 });
    await seedOrder({ portalId, companyId, status: 'pending', seats: 2 }); // in-flight checkout
    await seedOrder({ portalId, companyId, status: 'needs_review', seats: 1 }); // undecided oversell

    const usage = await resolveVoucherUsage(E.DB, portalId, companyId);
    // Settled usage — what the HubSpot used-property should read.
    expect(usage.used).toBe(1);
    // What the booking charges against, so concurrent checkouts can't over-allocate.
    expect(usage.encumbered).toBe(4);
  });

  it('tracks credit-mode usage in cents', async () => {
    const { portalId, companyId } = await fresh();
    await seedOrder({ portalId, companyId, status: 'paid', cents: 145000 });
    await seedOrder({ portalId, companyId, status: 'cancelled', cents: 95000 });

    const usage = await resolveVoucherUsage(E.DB, portalId, companyId, 'credit');
    expect(usage.used).toBe(145000);
  });

  it('does not count another company or another tenant', async () => {
    const { portalId, companyId } = await fresh();
    const other = await fresh();

    await seedOrder({ portalId, companyId, status: 'paid', seats: 1 });
    await seedOrder({ portalId, companyId: other.companyId, status: 'paid', seats: 5 });
    await seedOrder({ portalId: other.portalId, companyId, status: 'paid', seats: 7 });
    await seedOrder({ portalId, companyId: null, status: 'paid', seats: 9 });

    expect((await resolveVoucherUsage(E.DB, portalId, companyId)).used).toBe(1);
  });

  it('preserves usage that predates the worker as a baseline', async () => {
    const { portalId, companyId } = await fresh();

    // HubSpot already showed 4 vouchers spent before this worker ever wrote the property.
    await captureVoucherBaseline(E.DB, portalId, companyId, 4);
    await seedOrder({ portalId, companyId, status: 'paid', seats: 2 });

    const usage = await resolveVoucherUsage(E.DB, portalId, companyId);
    expect(usage.baseline).toBe(4);
    expect(usage.used).toBe(6);
  });

  it('keeps baselines for the two modes apart', async () => {
    const { portalId, companyId } = await fresh();
    await captureVoucherBaseline(E.DB, portalId, companyId, 250000, 'credit');

    expect(await getVoucherBaseline(E.DB, portalId, companyId, 'credit')).toBe(250000);
    // A cents baseline must never be read back as a seat count.
    expect(await getVoucherBaseline(E.DB, portalId, companyId, 'seat')).toBe(0);
  });

  it('keeps the first baseline, so a value we already projected cannot overwrite it', async () => {
    const { portalId, companyId } = await fresh();

    await captureVoucherBaseline(E.DB, portalId, companyId, 3);
    // A later read of HubSpot returns a value we ourselves wrote — must not become baseline.
    await captureVoucherBaseline(E.DB, portalId, companyId, 11);

    expect(await getVoucherBaseline(E.DB, portalId, companyId)).toBe(3);
  });

  it('reports no baseline for a company it has never touched', async () => {
    const { portalId, companyId } = await fresh();
    expect(await getVoucherBaseline(E.DB, portalId, companyId)).toBeNull();
  });

  it('recomputes rather than increments, so replaying a sync is a no-op', async () => {
    const { portalId, companyId } = await fresh();
    await seedOrder({ portalId, companyId, status: 'paid', seats: 2 });

    const first = await resolveVoucherUsage(E.DB, portalId, companyId);
    const second = await resolveVoucherUsage(E.DB, portalId, companyId);
    expect(second.used).toBe(first.used);
  });

  it('returns the vouchers when a committed order is refunded', async () => {
    const { portalId, companyId } = await fresh();
    const orderId = await seedOrder({ portalId, companyId, status: 'paid', seats: 2 });
    expect((await resolveVoucherUsage(E.DB, portalId, companyId)).used).toBe(2);

    await E.DB.prepare("UPDATE orders SET status = 'refunded' WHERE id = ?1").bind(orderId).run();

    expect((await resolveVoucherUsage(E.DB, portalId, companyId)).used).toBe(0);
  });

  it('writes an outbox row carrying only the identifiers, not a precomputed total', async () => {
    const { portalId, companyId } = await fresh();
    const outboxId = `ob-${Date.now()}-${counter++}`;

    await E.DB.batch([
      voucherUsageSyncStatement(E, portalId, companyId, outboxId, new Date().toISOString()),
    ]);

    const row = await E.DB.prepare('SELECT topic, payload FROM outbox WHERE id = ?1')
      .bind(outboxId)
      .first<{ topic: string; payload: string }>();

    expect(row?.topic).toBe('company.sync_voucher_usage');
    // The handler recomputes at delivery time, so a delayed row can't write a stale total.
    expect(JSON.parse(row?.payload ?? '{}')).toEqual({ portalId, companyId });
  });
});
