import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { TicketTypeRow } from '../src/db';
import { resolvePrice } from '../src/pricing';
import type { Env } from '../src/types';
import { seedTenant } from './support/fixtures';

// Real Workers runtime D1 (env.DB), on the real migrations: assert most-specific-wins
// resolution + member/non-member behaviour against the shipped `pricing_rules` shape.

const E = env as unknown as Env;

let counter = 0;
// Registers the portal as it mints it: `pricing_rules.portal_id` REFERENCES `tenants`.
const freshIds = async () => {
  const n = `${Date.now()}-${counter++}`;
  const portalId = `p-${n}`;
  await seedTenant(E.DB, portalId);
  return { portalId, eventId: `evt-${n}`, ttId: `tt-${n}` };
};

function ticketType(
  portalId: string,
  eventId: string,
  ttId: string,
  priceCents: number,
): TicketTypeRow {
  return {
    id: ttId,
    portal_id: portalId,
    event_id: eventId,
    name: 'Standard',
    price_cents: priceCents,
    currency: 'AUD',
    capacity: 100,
    capacity_unlimited: 0,
    tax_treatment: 'gst',
    member_only: 0,
    hs_tax_rate_id: null,
    hs_product_id: null,
    sort_order: 0,
    created_at: new Date().toISOString(),
  };
}

async function insertRule(args: {
  portalId: string;
  scope: string;
  scopeId: string | null;
  level: string;
  category: string;
  discountPercent?: number | null;
  fixedPriceCents?: number | null;
}) {
  await E.DB.prepare(
    `INSERT INTO pricing_rules
       (id, portal_id, scope, scope_id, member_level, member_category, discount_percent, fixed_price_cents, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(
      crypto.randomUUID(),
      args.portalId,
      args.scope,
      args.scopeId,
      args.level,
      args.category,
      args.discountPercent ?? null,
      args.fixedPriceCents ?? null,
      new Date().toISOString(),
    )
    .run();
}

describe('resolvePrice', () => {
  it('non-members and unverified buyers always pay standard', async () => {
    const { portalId, eventId, ttId } = await freshIds();
    const tt = ticketType(portalId, eventId, ttId, 10000);
    await insertRule({
      portalId,
      scope: 'event',
      scopeId: eventId,
      level: 'standard',
      category: 'corporate',
      discountPercent: 50,
    });

    const nonMember = await resolvePrice(E, {
      portalId,
      eventId,
      ticketType: tt,
      isMember: false,
      level: null,
      category: null,
    });
    expect(nonMember).toBe(10000);

    // A member whose level couldn't be resolved looks for a generic `member`-level rule
    // (see hubdb-pricing.test.ts); this portal has none, so they pay standard.
    const noTier = await resolvePrice(E, {
      portalId,
      eventId,
      ticketType: tt,
      isMember: true,
      level: null,
      category: null,
    });
    expect(noTier).toBe(10000);
  });

  it('gives distinct prices by level + category on the same ticket', async () => {
    const { portalId, eventId, ttId } = await freshIds();
    const tt = ticketType(portalId, eventId, ttId, 10000);
    // Corporate member: 30% off; industry supplier: fixed $40.
    await insertRule({
      portalId,
      scope: 'event',
      scopeId: eventId,
      level: 'standard',
      category: 'corporate',
      discountPercent: 30,
    });
    await insertRule({
      portalId,
      scope: 'event',
      scopeId: eventId,
      level: 'standard',
      category: 'industry_supplier',
      fixedPriceCents: 4000,
    });

    const corporate = await resolvePrice(E, {
      portalId,
      eventId,
      ticketType: tt,
      isMember: true,
      level: 'standard',
      category: 'corporate',
    });
    const supplier = await resolvePrice(E, {
      portalId,
      eventId,
      ticketType: tt,
      isMember: true,
      level: 'standard',
      category: 'industry_supplier',
    });
    const nonMember = await resolvePrice(E, {
      portalId,
      eventId,
      ticketType: tt,
      isMember: false,
      level: null,
      category: null,
    });

    expect(corporate).toBe(7000); // 30% off 100.00
    expect(supplier).toBe(4000); // fixed member price
    expect(nonMember).toBe(10000); // standard
    expect(new Set([corporate, supplier, nonMember]).size).toBe(3); // all distinct
  });

  it('uses generic member-category rules when a portal only resolves membership level', async () => {
    const { portalId, eventId, ttId } = await freshIds();
    const tt = ticketType(portalId, eventId, ttId, 10000);
    await insertRule({
      portalId,
      scope: 'event',
      scopeId: eventId,
      level: 'silver',
      category: 'member',
      fixedPriceCents: 9000,
    });

    expect(
      await resolvePrice(E, {
        portalId,
        eventId,
        ticketType: tt,
        isMember: true,
        level: 'silver',
        category: null,
      }),
    ).toBe(9000);
  });

  it('resolves most-specific first: ticket_type > event > portal', async () => {
    const { portalId, eventId, ttId } = await freshIds();
    const tt = ticketType(portalId, eventId, ttId, 10000);
    await insertRule({
      portalId,
      scope: 'portal',
      scopeId: null,
      level: 'premium',
      category: 'corporate',
      discountPercent: 10,
    });
    await insertRule({
      portalId,
      scope: 'event',
      scopeId: eventId,
      level: 'premium',
      category: 'corporate',
      discountPercent: 20,
    });

    // With only portal + event rules, event wins.
    expect(
      await resolvePrice(E, {
        portalId,
        eventId,
        ticketType: tt,
        isMember: true,
        level: 'premium',
        category: 'corporate',
      }),
    ).toBe(8000);

    // Add a ticket_type rule → it overrides the event rule.
    await insertRule({
      portalId,
      scope: 'ticket_type',
      scopeId: ttId,
      level: 'premium',
      category: 'corporate',
      fixedPriceCents: 5000,
    });
    expect(
      await resolvePrice(E, {
        portalId,
        eventId,
        ticketType: tt,
        isMember: true,
        level: 'premium',
        category: 'corporate',
      }),
    ).toBe(5000);
  });

  it('fixed_price_cents overrides discount_percent on the same rule', async () => {
    const { portalId, eventId, ttId } = await freshIds();
    const tt = ticketType(portalId, eventId, ttId, 10000);
    await insertRule({
      portalId,
      scope: 'event',
      scopeId: eventId,
      level: 'fellow',
      category: 'corporate',
      discountPercent: 90,
      fixedPriceCents: 2500,
    });
    expect(
      await resolvePrice(E, {
        portalId,
        eventId,
        ticketType: tt,
        isMember: true,
        level: 'fellow',
        category: 'corporate',
      }),
    ).toBe(2500);
  });
});
