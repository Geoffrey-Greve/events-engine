import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../src/types';
import {
  claimWaitlistOffer,
  joinWaitlist,
  promoteWaitlist,
  signOffer,
  verifyWaitlistOffer,
} from '../src/waitlist';
import { seedEvent, seedTicketType } from './support/fixtures';

// Real Workers runtime: D1 (env.DB), Queues (env.QUEUE) and the EventCapacity DO are the
// actual Miniflare bindings, on the real migrations. We drive a real DO for availability
// and assert on the offer/claim lifecycle end-to-end.

const E = env as unknown as Env;

let counter = 0;
// `waitlist.event_id` and `.ticket_type_id` are foreign keys, so the event and both
// ticket types are real rows. The DO keys availability by ticket type id, so the ids the
// tests set inventory against are these.
const freshIds = async () => {
  const n = `${Date.now()}-${counter++}`;
  const portalId = `p-${n}`;
  const eventId = `evt-${n}`;
  const hsEvent = `hs-${n}`;
  await seedEvent(E.DB, { portalId, eventId, hubspotEventId: hsEvent });
  const ttA = await seedTicketType(E.DB, { portalId, eventId, ticketTypeId: `ttA-${n}` });
  const ttB = await seedTicketType(E.DB, { portalId, eventId, ticketTypeId: `ttB-${n}` });
  return { portalId, eventId, hsEvent, ttA, ttB };
};

function doStub(name: string) {
  return E.EVENT_CAPACITY.get(E.EVENT_CAPACITY.idFromName(name));
}

async function setAvailability(idName: string, body: Record<string, unknown>) {
  await doStub(idName).fetch('https://do/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function insertWaiting(args: {
  id: string;
  portalId: string;
  eventId: string;
  ticketTypeId: string | null;
  position: number;
  quantity?: number;
  email?: string;
}) {
  await E.DB.prepare(
    `INSERT INTO waitlist
       (id, portal_id, event_id, ticket_type_id, hubspot_contact_id, email, position, quantity, status, created_at)
     VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7, 'waiting', ?8)`,
  )
    .bind(
      args.id,
      args.portalId,
      args.eventId,
      args.ticketTypeId,
      args.email ?? `${args.id}@example.com`,
      args.position,
      args.quantity ?? 1,
      new Date().toISOString(),
    )
    .run();
}

async function statusOf(id: string): Promise<{ status: string; offer_expires_at: string | null }> {
  const row = await E.DB.prepare('SELECT status, offer_expires_at FROM waitlist WHERE id = ?1')
    .bind(id)
    .first<{ status: string; offer_expires_at: string | null }>();
  if (!row) throw new Error(`Waitlist row ${id} not found`);
  return row;
}

async function offerTokenFor(waitlistId: string): Promise<string> {
  const row = await E.DB.prepare(
    `SELECT payload FROM outbox
      WHERE topic = 'notify.waitlist_offer' AND json_extract(payload, '$.waitlistId') = ?1
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(waitlistId)
    .first<{ payload: string }>();
  if (!row?.payload) {
    throw new Error(`No waitlist offer outbox row for ${waitlistId}`);
  }
  return (JSON.parse(row.payload) as { offerToken: string }).offerToken;
}

describe('signed offer tokens', () => {
  it('round-trips waitlistId + expiry', async () => {
    const exp = Date.now() + 1000;
    const token = await signOffer('test-signing-secret', 'wl-1', exp);
    const v = await verifyWaitlistOffer('test-signing-secret', token);
    expect(v).toEqual({ waitlistId: 'wl-1', expiresAtMs: exp });
  });

  it('rejects a tampered signature or wrong secret', async () => {
    const exp = Date.now() + 1000;
    const token = await signOffer('test-signing-secret', 'wl-1', exp);
    expect(await verifyWaitlistOffer('test-signing-secret', `${token}x`)).toBeNull();
    expect(await verifyWaitlistOffer('other-secret', token)).toBeNull();
    // Swapped expiry isn't covered by the signature → rejected.
    const forged = `wl-1.${exp + 999}.${token.split('.')[2]}`;
    expect(await verifyWaitlistOffer('test-signing-secret', forged)).toBeNull();
  });
});

describe('joinWaitlist', () => {
  it('numbers positions per (event, ticket type)', async () => {
    const { portalId, eventId, hsEvent, ttA, ttB } = await freshIds();
    const ev = { id: eventId, hubspot_event_id: hsEvent };

    const a = await joinWaitlist(E, { portalId, event: ev, ticketTypeId: ttA, email: 'a@x.io' });
    const b = await joinWaitlist(E, { portalId, event: ev, ticketTypeId: ttA, email: 'b@x.io' });
    const c = await joinWaitlist(E, { portalId, event: ev, ticketTypeId: ttB, email: 'c@x.io' });

    expect(a.position).toBe(1);
    expect(b.position).toBe(2); // same type → next slot
    expect(c.position).toBe(1); // different type → its own queue restarts at 1

    // A "joined" notification was enqueued to the outbox.
    const note = await E.DB.prepare(
      `SELECT COUNT(*) AS n FROM outbox
        WHERE topic = 'notify.waitlist_joined' AND json_extract(payload, '$.waitlistId') = ?1`,
    )
      .bind(a.waitlistId)
      .first<{ n: number }>();
    expect(note?.n).toBe(1);
  });
});

describe('promoteWaitlist', () => {
  it('offers only as many freed seats as are available, front of queue first', async () => {
    const { portalId, eventId, hsEvent, ttA } = await freshIds();
    const idName = `${portalId}:${hsEvent}`;
    // One seat free for ttA.
    await setAvailability(idName, { eventCapacity: null, perType: { [ttA]: { inventory: 1 } } });

    const w1 = crypto.randomUUID();
    const w2 = crypto.randomUUID();
    await insertWaiting({ id: w1, portalId, eventId, ticketTypeId: ttA, position: 1 });
    await insertWaiting({ id: w2, portalId, eventId, ticketTypeId: ttA, position: 2 });

    await promoteWaitlist(E, { portalId, event: { id: eventId, hubspot_event_id: hsEvent } });

    const s1 = await statusOf(w1);
    const s2 = await statusOf(w2);
    expect(s1.status).toBe('offered');
    expect(s1.offer_expires_at).toBeTruthy();
    expect(s2.status).toBe('waiting'); // only one seat → only the front gets it

    // A second pass must NOT double-offer the same freed seat.
    await promoteWaitlist(E, { portalId, event: { id: eventId, hubspot_event_id: hsEvent } });
    expect((await statusOf(w2)).status).toBe('waiting');
  });

  it('skips a wait whose quantity does not fit and offers the next that does', async () => {
    const { portalId, eventId, hsEvent, ttA } = await freshIds();
    const idName = `${portalId}:${hsEvent}`;
    await setAvailability(idName, { eventCapacity: null, perType: { [ttA]: { inventory: 1 } } });

    const big = crypto.randomUUID();
    const small = crypto.randomUUID();
    await insertWaiting({
      id: big,
      portalId,
      eventId,
      ticketTypeId: ttA,
      position: 1,
      quantity: 3,
    });
    await insertWaiting({
      id: small,
      portalId,
      eventId,
      ticketTypeId: ttA,
      position: 2,
      quantity: 1,
    });

    await promoteWaitlist(E, { portalId, event: { id: eventId, hubspot_event_id: hsEvent } });

    expect((await statusOf(big)).status).toBe('waiting'); // wants 3, only 1 free
    expect((await statusOf(small)).status).toBe('offered'); // fits the gap
  });

  it('produces a token the claimant can redeem, and rejects expired/forged offers', async () => {
    const { portalId, eventId, hsEvent, ttA } = await freshIds();
    const idName = `${portalId}:${hsEvent}`;
    await setAvailability(idName, { eventCapacity: 5, perType: {} });

    const w = crypto.randomUUID();
    await insertWaiting({
      id: w,
      portalId,
      eventId,
      ticketTypeId: ttA,
      position: 1,
      quantity: 2,
    });
    await promoteWaitlist(E, { portalId, event: { id: eventId, hubspot_event_id: hsEvent } });

    const token = await offerTokenFor(w);
    const ok = await claimWaitlistOffer(E, { portalId, eventId, token });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.claim.waitlistId).toBe(w);
      expect(ok.claim.quantity).toBe(2);
    }

    // Forged token (valid shape, wrong signature) → invalid.
    const bad = await claimWaitlistOffer(E, { portalId, eventId, token: `${token}z` });
    expect(bad).toEqual({ ok: false, error: 'offer_invalid' });

    // Wrong event scope → invalid.
    const wrongEvent = await claimWaitlistOffer(E, { portalId, eventId: 'nope', token });
    expect(wrongEvent).toEqual({ ok: false, error: 'offer_invalid' });

    // Expire the offer window: a stale offer can't be claimed.
    await E.DB.prepare(
      `UPDATE waitlist SET status = 'expired', offer_expires_at = ?1 WHERE id = ?2`,
    )
      .bind(new Date(Date.now() - 1000).toISOString(), w)
      .run();
    const expired = await claimWaitlistOffer(E, { portalId, eventId, token });
    // offer_expires_at no longer matches the token's expiry → invalid.
    expect(expired.ok).toBe(false);
  });
});
