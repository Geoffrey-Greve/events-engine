import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { reconcileOutbox } from '../src/hubspot-writeback';
import { encryptToken } from '../src/token-crypto';
import type { Env } from '../src/types';
import { seedTicketType } from './support/fixtures';

/**
 * `reconcileOutbox` step 2: the seat HubSpot has never heard of.
 *
 * `registrations.marketing_event_state_synced = 0` is meant to say "this attendee was sold
 * a seat and no Marketing Event participation exists for them". It is also what a seat
 * reads when it SHOULD have none — an unnamed seat, a cancelled one — and what a seat reads
 * after its `me.register` has died, which is the state the sweep must not answer by raising
 * another one.
 */

const E = env as unknown as Env;
const TOKEN_KEY = '0'.repeat(64);

let counter = 0;

interface SeatOpts {
  orderStatus?: string;
  paymentMethod?: string | null;
  unnamed?: boolean;
  cancelled?: boolean;
  /** Seed an existing me.register row for the seat, in this status. */
  existingRow?: string;
}

async function seedSeat(opts: SeatOpts = {}) {
  const n = `${Date.now()}-${counter++}`;
  const portalId = `mereg-${n}`;
  const eventId = `evt-${n}`;
  const orderId = `ord-${n}`;
  const regId = crypto.randomUUID();
  const now = new Date().toISOString();

  await E.DB.prepare(
    `INSERT INTO tenants (portal_id, display_name, hs_access_token, hs_refresh_token,
                          hs_token_expires_at, created_at)
     VALUES (?1, 'Weld', ?2, ?3, ?4, ?5)`,
  )
    .bind(
      portalId,
      await encryptToken(TOKEN_KEY, 'hs-access-token'),
      await encryptToken(TOKEN_KEY, 'hs-refresh-token'),
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      now,
    )
    .run();

  await E.DB.prepare(
    `INSERT INTO events (id, portal_id, hubspot_event_id, title, starts_at, ends_at, capacity,
                         created_at, updated_at)
     VALUES (?1, ?2, 'hs-evt', 'Course', ?3, ?3, 10, ?3, ?3)`,
  )
    .bind(eventId, portalId, now)
    .run();

  await E.DB.prepare(
    `INSERT INTO orders (id, portal_id, event_id, status, payment_method, buyer_email,
                         buyer_name, total_cents, currency, hubspot_deal_id, hubspot_invoice_id,
                         created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'buyer@weld.test', 'Bree Buyer', 585000, 'AUD',
             'deal-1', 'inv-1', ?6, ?6)`,
  )
    .bind(
      orderId,
      portalId,
      eventId,
      opts.orderStatus ?? 'paid',
      opts.paymentMethod === undefined ? 'invoice' : opts.paymentMethod,
      now,
    )
    .run();

  const ticketTypeId = await seedTicketType(E.DB, {
    portalId,
    eventId,
    ticketTypeId: `tt-${n}`,
  });

  await E.DB.prepare(
    `INSERT INTO registrations (id, portal_id, order_id, event_id, ticket_type_id,
       attendee_email, attendee_name, seat_unnamed, cancelled_at,
       marketing_event_state_synced, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?10)`,
  )
    .bind(
      regId,
      portalId,
      orderId,
      eventId,
      ticketTypeId,
      opts.unnamed ? '' : 'attendee@weld.test',
      opts.unnamed ? '' : 'Ann Attendee',
      opts.unnamed ? 1 : 0,
      opts.cancelled ? now : null,
      now,
    )
    .run();

  if (opts.existingRow) {
    await E.DB.prepare(
      `INSERT INTO outbox (id, portal_id, topic, payload, status, created_at)
       VALUES (?1, ?2, 'me.register', ?3, ?4, ?5)`,
    )
      .bind(
        crypto.randomUUID(),
        portalId,
        JSON.stringify({ registrationId: regId, attendeeEmail: 'attendee@weld.test' }),
        opts.existingRow,
        now,
      )
      .run();
  }

  return { portalId, regId };
}

const meRegisterRows = async (portalId: string) =>
  (
    await E.DB.prepare(
      `SELECT status, COUNT(*) AS c FROM outbox
        WHERE portal_id = ?1 AND topic = 'me.register' GROUP BY status`,
    )
      .bind(portalId)
      .all<{ status: string; c: number }>()
  ).results;

afterEach(async () => {
  await E.DB.prepare("DELETE FROM outbox WHERE portal_id LIKE 'mereg-%'").run();
  await E.DB.prepare("DELETE FROM registrations WHERE portal_id LIKE 'mereg-%'").run();
  await E.DB.prepare("DELETE FROM orders WHERE portal_id LIKE 'mereg-%'").run();
  await E.DB.prepare("DELETE FROM ticket_types WHERE portal_id LIKE 'mereg-%'").run();
  await E.DB.prepare("DELETE FROM events WHERE portal_id LIKE 'mereg-%'").run();
  await E.DB.prepare("DELETE FROM tenants WHERE portal_id LIKE 'mereg-%'").run();
});

describe('step 2 raises a me.register for a seat HubSpot has never heard of', () => {
  it('does, for a paid booking with no row at all', async () => {
    const { portalId } = await seedSeat();
    await reconcileOutbox(E, { portalId });
    expect(await meRegisterRows(portalId)).toEqual([{ status: 'pending', c: 1 }]);
  });

  it('does for a booking on INVOICE TERMS, which stays pending for up to 90 days', async () => {
    // Ref 78 fixed this narrowness in step 3 and left step 2 on ('paid','confirmed'), so
    // the repair never looked at the ordinary shape of a Weld booking.
    const { portalId } = await seedSeat({ orderStatus: 'pending', paymentMethod: 'invoice' });
    await reconcileOutbox(E, { portalId });
    expect(await meRegisterRows(portalId)).toEqual([{ status: 'pending', c: 1 }]);
  });

  it('does not for a free booking still holding an unpaid card checkout', async () => {
    const { portalId } = await seedSeat({ orderStatus: 'pending', paymentMethod: null });
    await reconcileOutbox(E, { portalId });
    expect(await meRegisterRows(portalId)).toEqual([]);
  });
});

describe('step 2 never re-raises a row that has already died', () => {
  it('leaves a dead row alone however many times the sweep runs', async () => {
    // The unbounded loop: a dead row was excluded from the "already queued" check, so a
    // cause nobody had fixed (a 403 on a missing scope) earned a fresh row every fifteen
    // minutes, each dying again — 96 dead rows a day for one seat, in a table that is
    // never purged, burying the real findings in the heartbeat.
    const { portalId } = await seedSeat({ existingRow: 'dead' });

    await reconcileOutbox(E, { portalId });
    await reconcileOutbox(E, { portalId });
    await reconcileOutbox(E, { portalId });

    expect(await meRegisterRows(portalId)).toEqual([{ status: 'dead', c: 1 }]);
  });

  it('still treats a live row and a delivered row as already handled', async () => {
    const live = await seedSeat({ existingRow: 'failed' });
    await reconcileOutbox(E, { portalId: live.portalId });
    expect(await meRegisterRows(live.portalId)).toEqual([{ status: 'failed', c: 1 }]);

    const done = await seedSeat({ existingRow: 'delivered' });
    await reconcileOutbox(E, { portalId: done.portalId });
    expect(await meRegisterRows(done.portalId)).toEqual([{ status: 'delivered', c: 1 }]);
  });
});

describe('step 2 reads the flags that say a seat should have no participation', () => {
  it('raises nothing for an UNNAMED seat', async () => {
    // Ref 74b: reserve deliberately raises no me.register for a seat with nobody on it, so
    // its mirror stays 0 for ever. Reading that 0 as drift would upsert a contact from an
    // empty email and put somebody HubSpot invented onto the event — the one thing
    // migration 0039 names this path as having to avoid.
    const { portalId } = await seedSeat({ unnamed: true });
    await reconcileOutbox(E, { portalId });
    expect(await meRegisterRows(portalId)).toEqual([]);
  });

  it('raises nothing for a CANCELLED seat whose colleagues are still coming', async () => {
    // `me.cancel` sets the mirror back to 0, which is the same 0, so a seat cancelled out
    // of a still-paid booking looked exactly like one HubSpot had never heard of.
    const { portalId } = await seedSeat({ cancelled: true });
    await reconcileOutbox(E, { portalId });
    expect(await meRegisterRows(portalId)).toEqual([]);
  });
});
