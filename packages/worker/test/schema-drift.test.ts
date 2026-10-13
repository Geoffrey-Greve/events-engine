import { env } from 'cloudflare:test';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { TicketTypeRow } from '../src/db';
import { resolveMembership } from '../src/membership';
import { resolvePrice } from '../src/pricing';
import type { Env } from '../src/types';
import { dropAllTables, resetSchema } from './support/migrate';

/**
 * Ref 217 - "Something went wrong reaching the booking service."
 *
 * handleReserve only maps ReserveError; anything else propagates and Hono's default
 * handler answers with the plain-text body "Internal Server Error". Browser clients
 * parse the reserve response as JSON, so a plain-text 500 reached buyers as one
 * generic, untraceable sentence.
 *
 * The commonest way to throw something that is not a ReserveError is D1 schema
 * drift: a database provisioned before migrations 0009 (pricing_rules) or 0012
 * (tenants.membership_*_property) throws "no such table/column" on reads that every
 * reserve performs, before any capacity work - which is why guest and signed-in
 * checkouts failed identically.
 *
 * Reading optional config must degrade, never fail the booking. These tests run
 * against a D1 with NEITHER table present.
 *
 * This is the one file in the suite that breaks the schema on purpose, and the database is
 * shared by every other file (`vitest.config.ts`), so it rebuilds it from the migrations on
 * the way out. Before that it left `tenants` as a one-column stub and `pricing_rules` gone,
 * and which suites noticed depended on the order vitest happened to pick.
 */

const E = env as unknown as Env;

let counter = 0;
const freshId = () => `p-${Date.now()}-${counter++}`;

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

afterEach(() => vi.unstubAllGlobals());

// Put back what these tests tear down, for whatever runs next.
afterAll(() => resetSchema(E.DB));

describe('reserve survives D1 schema drift (Ref 217)', () => {
  it('resolveMembership degrades to unverified when the tenants config columns are missing', async () => {
    const portalId = freshId();
    // Every other table carries a foreign key into `tenants`, so it cannot be dropped on
    // its own: the whole schema goes, and `afterAll` builds it back from the migrations.
    await dropAllTables(E.DB);
    // A tenants table that predates migration 0012: no membership_* columns.
    await E.DB.exec(`CREATE TABLE tenants (portal_id TEXT PRIMARY KEY)`);
    await E.DB.prepare('INSERT INTO tenants (portal_id) VALUES (?1)').bind(portalId).run();

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ properties: { membership_status: 'member' } }), {
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    const envWithKey = {
      ...(E as unknown as Record<string, unknown>),
      [`HUBSPOT_API_KEY_${portalId}`]: 'test-key',
    } as unknown as Env;

    // Must resolve, not throw. The built-in 'membership_status' fallback still applies.
    const result = await resolveMembership(envWithKey, portalId, 'buyer@example.com');
    expect(result.verified).toBe(true);
    expect(result.isMember).toBe(true);
  });

  it('resolvePrice falls back to the standard price when pricing_rules does not exist', async () => {
    const portalId = freshId();
    await E.DB.exec(`DROP TABLE IF EXISTS pricing_rules`);

    const tt = ticketType(portalId, 'evt-1', 'tt-1', 396000);

    // A member with a resolved level/category is the path that reads pricing_rules.
    await expect(
      resolvePrice(E, {
        portalId,
        eventId: 'evt-1',
        ticketType: tt,
        isMember: true,
        level: 'gold',
        category: 'corporate',
      }),
    ).resolves.toBe(396000);
  });

  it('non-members are unaffected by a missing pricing_rules table', async () => {
    const portalId = freshId();
    await E.DB.exec(`DROP TABLE IF EXISTS pricing_rules`);

    await expect(
      resolvePrice(E, {
        portalId,
        eventId: 'evt-2',
        ticketType: ticketType(portalId, 'evt-2', 'tt-2', 396000),
        isMember: false,
        level: null,
        category: null,
      }),
    ).resolves.toBe(396000);
  });
});
