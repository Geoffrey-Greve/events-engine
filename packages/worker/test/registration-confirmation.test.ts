import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleOutboxMessage } from '../src/hubspot-writeback';
import { encryptToken } from '../src/token-crypto';
import type { Env } from '../src/types';

/**
 * Ref 61 — registration confirmation trigger.
 *
 * The attendee's HubSpot contact is stamped with the booking's ORDER id, and a workflow
 * watching that property sends the confirmation email. The order id rather than the
 * registration id because a package or multi-seat checkout is one order across many
 * registration rows: stamping per registration would enrol the workflow once per seat.
 *
 * It has its own outbox topic. It used to ride `me.register`, which is enqueued at RESERVE
 * time, so it confirmed unpaid card holds — and a failure took the Marketing Event write-back
 * row down with it, which reporting then read as a real HubSpot sync gap.
 */

const E = env as unknown as Env;
const TOKEN_KEY = '0'.repeat(64);
const TOPIC = 'contact.sync_registration_confirmation';
const DEFAULT_PROPERTY = 'last_event_engine_registration_id';

let counter = 0;
function freshIds() {
  const n = `${Date.now()}-${counter++}`;
  return {
    portalId: `ref61-${n}`,
    eventId: `evt-ref61-${n}`,
    hubspotEventId: `hs-ref61-${n}`,
    ticketTypeId: `tt-ref61-${n}`,
    orderId: `ord-ref61-${n}`,
    regId: `reg-ref61-${n}`,
    contactId: `contact-ref61-${n}`,
  };
}

type Ids = ReturnType<typeof freshIds>;

function fakeMessage(body: Record<string, unknown>) {
  const state = { acked: false, retried: false };
  return {
    state,
    msg: {
      body,
      ack: () => {
        state.acked = true;
      },
      retry: () => {
        state.retried = true;
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal Message stub for the consumer
    } as any,
  };
}

interface StubOpts {
  /** What HubSpot already holds in the confirmation property, if anything. */
  existing?: Record<string, string>;
  /** Make the confirmation PATCH answer 500, so the row must stay retryable. */
  failPatch?: boolean;
  /** Make the confirmation PATCH answer 400, as a portal missing the property would. */
  rejectPatch?: boolean;
  /**
   * Refuse to CREATE the missing property — the shape of a portal whose token predates the
   * required schema scopes. The write-back's repair cannot help there and the row dies.
   */
  refuseCreate?: boolean;
  property?: string;
}

function stubHubSpot(opts: StubOpts = {}) {
  const property = opts.property ?? DEFAULT_PROPERTY;
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const createdProperties: string[] = [];
  let propertyCreated = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method, url, body });

      const json = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { 'content-type': 'application/json' },
        });

      const isConfirmationPatch =
        method === 'PATCH' &&
        url.includes('/crm/v3/objects/contacts/') &&
        (body as { properties?: Record<string, string> } | null)?.properties?.[property] !==
          undefined;

      if (isConfirmationPatch && opts.failPatch) return json({ message: 'temporary' }, 500);
      if (isConfirmationPatch && opts.rejectPatch && !propertyCreated) {
        // HubSpot's real answer, verbatim in shape: the write-back reads the property name
        // out of `errors[].context.propertyName`, not out of the message string.
        return json(
          {
            status: 'error',
            message: `Property values were not valid: [{"isValid":false,"message":"Property \\"${property}\\" does not exist","error":"PROPERTY_DOESNT_EXIST","name":"${property}"}]`,
            category: 'VALIDATION_ERROR',
            errors: [
              {
                message: `Property "${property}" does not exist`,
                code: 'PROPERTY_DOESNT_EXIST',
                context: { propertyName: [property] },
              },
            ],
          },
          400,
        );
      }

      // Property SCHEMA calls (…/properties/contacts), not object calls.
      if (method === 'POST' && url.endsWith('/crm/v3/properties/contacts')) {
        if (opts.refuseCreate) return json({ message: 'scope missing' }, 403);
        createdProperties.push(String((body as { name?: unknown } | null)?.name ?? ''));
        propertyCreated = true;
        return json({ name: property });
      }

      // The pre-write read (readContactProperties) — GET by email with ?idProperty=email.
      if (method === 'GET' && url.includes('idProperty=email')) {
        return json({ id: 'contact-1', properties: opts.existing ?? {} });
      }
      if (method === 'POST' && url.includes('/crm/v3/objects/contacts/search')) {
        return json({ results: [{ id: 'contact-1' }] });
      }
      if (url.includes('/crm/v3/objects/contacts')) {
        return json({ id: 'contact-1' });
      }
      if (url.includes('/marketing/v3/marketing-events/')) {
        return json({ results: [{ objectId: 'me-1' }] });
      }
      return json({});
    }),
  );
  return Object.assign(calls, { createdProperties });
}

function confirmationPatches(
  calls: Array<{ method: string; url: string; body: unknown }>,
  property = DEFAULT_PROPERTY,
) {
  return calls
    .filter(
      (call) =>
        call.method === 'PATCH' &&
        call.url.includes('/crm/v3/objects/contacts/') &&
        (call.body as { properties?: Record<string, string> } | null)?.properties?.[property] !==
          undefined,
    )
    .map((call) => (call.body as { properties: Record<string, string> }).properties[property]);
}

async function seedTenantAndEvent(
  ids: Ids,
  opts?: { confirmationProperty?: string | null },
): Promise<void> {
  const now = new Date().toISOString();
  await E.DB.prepare(
    `INSERT INTO tenants
       (portal_id, stripe_processor_connected, hs_access_token, hs_refresh_token,
        hs_token_expires_at, contact_registration_confirmation_property, display_name)
     VALUES (?1, 1, ?2, ?3, ?4, ?5, 'Test Tenant')`,
  )
    .bind(
      ids.portalId,
      await encryptToken(TOKEN_KEY, 'hs-access-token'),
      await encryptToken(TOKEN_KEY, 'hs-refresh-token'),
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      opts?.confirmationProperty ?? null,
    )
    .run();

  await E.DB.prepare(
    `INSERT INTO events
       (id, portal_id, hubspot_event_id, title, starts_at, ends_at, location, capacity,
        booking_kind, marketing_event_completed, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'Welding Fundamentals', ?4, ?5, 'Adelaide', 20, 'course', 0, ?4, ?4)`,
  )
    .bind(
      ids.eventId,
      ids.portalId,
      ids.hubspotEventId,
      now,
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    )
    .run();

  await E.DB.prepare(
    `INSERT INTO ticket_types
       (id, portal_id, event_id, name, price_cents, currency, capacity, sort_order, created_at)
     VALUES (?1, ?2, ?3, 'Standard', 83500, 'AUD', 20, 0, ?4)`,
  )
    .bind(ids.ticketTypeId, ids.portalId, ids.eventId, now)
    .run();
}

interface SeedOpts {
  regId?: string;
  orderId?: string;
  contactId?: string;
  status?: string;
  paymentMethod?: string | null;
  createdAt?: string;
  cancelled?: boolean;
  unnamed?: boolean;
}

async function seedOrderAndRegistration(
  ids: Ids,
  opts: SeedOpts = {},
): Promise<{ regId: string; orderId: string; contactId: string }> {
  const now = opts.createdAt ?? new Date().toISOString();
  const regId = opts.regId ?? ids.regId;
  const orderId = opts.orderId ?? ids.orderId;
  const contactId = opts.contactId ?? ids.contactId;

  const existingOrder = await E.DB.prepare('SELECT id FROM orders WHERE id = ?1')
    .bind(orderId)
    .first<{ id: string }>();
  if (!existingOrder) {
    await E.DB.prepare(
      `INSERT INTO orders (id, portal_id, event_id, status, payment_method, buyer_email,
         buyer_name, total_cents, currency, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'buyer@weld.test', 'Bree Buyer', 83500, 'AUD', ?6, ?6)`,
    )
      .bind(
        orderId,
        ids.portalId,
        ids.eventId,
        opts.status ?? 'paid',
        opts.paymentMethod ?? null,
        now,
      )
      .run();
  }

  await E.DB.prepare(
    `INSERT INTO registrations
       (id, portal_id, order_id, event_id, ticket_type_id, hubspot_contact_id,
        attendee_email, attendee_name, seat_unnamed, cancelled_at,
        marketing_event_state_synced, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'Sam Tan', ?8, ?9, 0, ?10, ?10)`,
  )
    .bind(
      regId,
      ids.portalId,
      orderId,
      ids.eventId,
      ids.ticketTypeId,
      contactId,
      opts.unnamed ? '' : 'sam@weld.test',
      opts.unnamed ? 1 : 0,
      opts.cancelled ? now : null,
      now,
    )
    .run();

  return { regId, orderId, contactId };
}

async function enqueueConfirmation(
  ids: Ids,
  regId: string,
  orderId: string,
  contactId: string | null,
  email = 'sam@weld.test',
): Promise<string> {
  const outboxId = crypto.randomUUID();
  await E.DB.prepare(
    `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(
      outboxId,
      ids.portalId,
      TOPIC,
      JSON.stringify({
        registrationId: regId,
        orderId,
        attendeeEmail: email,
        hubspotContactId: contactId,
      }),
      new Date().toISOString(),
    )
    .run();
  return outboxId;
}

async function enqueueMe(ids: Ids, regId: string, contactId: string): Promise<string> {
  const outboxId = crypto.randomUUID();
  const now = new Date().toISOString();
  await E.DB.prepare(
    `INSERT INTO outbox (id, portal_id, topic, payload, stable_interaction_datetime, created_at)
     VALUES (?1, ?2, 'me.register', ?3, ?4, ?4)`,
  )
    .bind(
      outboxId,
      ids.portalId,
      JSON.stringify({
        registrationId: regId,
        attendeeEmail: 'sam@weld.test',
        hubspotContactId: contactId,
        hubspotEventId: ids.hubspotEventId,
        externalAccountId: ids.portalId,
        ticketTypeId: ids.ticketTypeId,
      }),
      now,
    )
    .run();
  return outboxId;
}

async function drain(ids: Ids, kind: string, outboxId: string, regId: string) {
  const { msg, state } = fakeMessage({
    kind,
    portalId: ids.portalId,
    outboxId,
    registrationId: regId,
  });
  await handleOutboxMessage(msg, E);
  return state;
}

const outboxStatus = async (outboxId: string) =>
  (
    await E.DB.prepare('SELECT status FROM outbox WHERE id = ?1')
      .bind(outboxId)
      .first<{ status: string }>()
  )?.status;

afterEach(() => vi.unstubAllGlobals());

describe('contact.sync_registration_confirmation (Ref 61)', () => {
  it('stamps the ORDER id on the attendee contact', async () => {
    const ids = freshIds();
    await seedTenantAndEvent(ids);
    const { regId, orderId, contactId } = await seedOrderAndRegistration(ids);
    const calls = stubHubSpot();

    const outboxId = await enqueueConfirmation(ids, regId, orderId, contactId);
    const state = await drain(ids, TOPIC, outboxId, regId);

    expect(state.acked).toBe(true);
    expect(confirmationPatches(calls)).toEqual([orderId]);
    // Never the registration row id — package bookings share one order across many regs.
    expect(confirmationPatches(calls)[0]).not.toBe(regId);
    expect(await outboxStatus(outboxId)).toBe('delivered');
  });

  it('writes the same order id for every seat on one checkout', async () => {
    const ids = freshIds();
    await seedTenantAndEvent(ids);
    const first = await seedOrderAndRegistration(ids);
    const secondRegId = `${ids.regId}-b`;
    await seedOrderAndRegistration(ids, {
      regId: secondRegId,
      orderId: first.orderId,
      contactId: `${first.contactId}-b`,
    });
    const calls = stubHubSpot();

    const a = await enqueueConfirmation(ids, first.regId, first.orderId, first.contactId);
    const b = await enqueueConfirmation(
      ids,
      secondRegId,
      first.orderId,
      `${first.contactId}-b`,
      'jo@weld.test',
    );
    await drain(ids, TOPIC, a, first.regId);
    await drain(ids, TOPIC, b, secondRegId);

    expect(confirmationPatches(calls)).toEqual([first.orderId, first.orderId]);
  });

  it('writes nothing when the contact already holds this order id', async () => {
    const ids = freshIds();
    await seedTenantAndEvent(ids);
    const { regId, orderId, contactId } = await seedOrderAndRegistration(ids);
    const calls = stubHubSpot({ existing: { [DEFAULT_PROPERTY]: orderId } });

    const outboxId = await enqueueConfirmation(ids, regId, orderId, contactId);
    const state = await drain(ids, TOPIC, outboxId, regId);

    // Re-writing the same value can re-enrol a workflow, so a retry must send nothing.
    expect(state.acked).toBe(true);
    expect(confirmationPatches(calls)).toEqual([]);
  });

  it('never moves backwards: an older order cannot overwrite a newer one', async () => {
    const ids = freshIds();
    await seedTenantAndEvent(ids);
    const older = await seedOrderAndRegistration(ids, {
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    const newerOrderId = `${ids.orderId}-new`;
    await seedOrderAndRegistration(ids, {
      regId: `${ids.regId}-new`,
      orderId: newerOrderId,
      contactId: older.contactId,
      createdAt: new Date().toISOString(),
    });
    // HubSpot already holds the NEWER booking; the straggler is the older one.
    const calls = stubHubSpot({ existing: { [DEFAULT_PROPERTY]: newerOrderId } });

    const outboxId = await enqueueConfirmation(ids, older.regId, older.orderId, older.contactId);
    const state = await drain(ids, TOPIC, outboxId, older.regId);

    expect(state.acked).toBe(true);
    expect(confirmationPatches(calls)).toEqual([]);
  });

  it('does move forwards: a newer order overwrites an older one', async () => {
    const ids = freshIds();
    await seedTenantAndEvent(ids);
    const older = await seedOrderAndRegistration(ids, {
      createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    const newerOrderId = `${ids.orderId}-new`;
    const newerRegId = `${ids.regId}-new`;
    await seedOrderAndRegistration(ids, {
      regId: newerRegId,
      orderId: newerOrderId,
      contactId: older.contactId,
    });
    const calls = stubHubSpot({ existing: { [DEFAULT_PROPERTY]: older.orderId } });

    const outboxId = await enqueueConfirmation(ids, newerRegId, newerOrderId, older.contactId);
    await drain(ids, TOPIC, outboxId, newerRegId);

    expect(confirmationPatches(calls)).toEqual([newerOrderId]);
  });

  it('defers an unpaid card checkout, and stamps invoice terms straight away', async () => {
    const card = freshIds();
    await seedTenantAndEvent(card);
    const cardSeat = await seedOrderAndRegistration(card, {
      status: 'pending',
      paymentMethod: 'card',
    });
    const cardCalls = stubHubSpot();
    const cardOutbox = await enqueueConfirmation(
      card,
      cardSeat.regId,
      cardSeat.orderId,
      cardSeat.contactId,
    );
    const cardState = await drain(card, TOPIC, cardOutbox, cardSeat.regId);

    // An abandoned checkout must never be told its registration is confirmed.
    expect(cardState.acked).toBe(true);
    expect(confirmationPatches(cardCalls)).toEqual([]);
    vi.unstubAllGlobals();

    const invoice = freshIds();
    await seedTenantAndEvent(invoice);
    const invoiceSeat = await seedOrderAndRegistration(invoice, {
      status: 'pending',
      paymentMethod: 'invoice',
    });
    const invoiceCalls = stubHubSpot();
    const invoiceOutbox = await enqueueConfirmation(
      invoice,
      invoiceSeat.regId,
      invoiceSeat.orderId,
      invoiceSeat.contactId,
    );
    await drain(invoice, TOPIC, invoiceOutbox, invoiceSeat.regId);

    // Bank transfer holds the seat to the due date — the buyer is owed the confirmation now.
    expect(confirmationPatches(invoiceCalls)).toEqual([invoiceSeat.orderId]);
  });

  it('skips a cancelled seat and an unnamed one', async () => {
    const ids = freshIds();
    await seedTenantAndEvent(ids);
    const cancelled = await seedOrderAndRegistration(ids, {
      regId: `${ids.regId}-x`,
      cancelled: true,
    });
    const unnamed = await seedOrderAndRegistration(ids, {
      regId: `${ids.regId}-u`,
      orderId: `${ids.orderId}-u`,
      unnamed: true,
    });
    const calls = stubHubSpot();

    const a = await enqueueConfirmation(ids, cancelled.regId, cancelled.orderId, ids.contactId);
    const b = await enqueueConfirmation(ids, unnamed.regId, unnamed.orderId, ids.contactId, '');
    expect((await drain(ids, TOPIC, a, cancelled.regId)).acked).toBe(true);
    expect((await drain(ids, TOPIC, b, unnamed.regId)).acked).toBe(true);
    expect(confirmationPatches(calls)).toEqual([]);
  });

  it("honours the tenant's property name, and 'off'", async () => {
    const mapped = freshIds();
    await seedTenantAndEvent(mapped, { confirmationProperty: 'weld_last_booking' });
    const mappedSeat = await seedOrderAndRegistration(mapped);
    const mappedCalls = stubHubSpot({ property: 'weld_last_booking' });
    const mappedOutbox = await enqueueConfirmation(
      mapped,
      mappedSeat.regId,
      mappedSeat.orderId,
      mappedSeat.contactId,
    );
    await drain(mapped, TOPIC, mappedOutbox, mappedSeat.regId);

    expect(confirmationPatches(mappedCalls, 'weld_last_booking')).toEqual([mappedSeat.orderId]);
    expect(confirmationPatches(mappedCalls)).toEqual([]);
    vi.unstubAllGlobals();

    const off = freshIds();
    await seedTenantAndEvent(off, { confirmationProperty: 'off' });
    const offSeat = await seedOrderAndRegistration(off);
    const offCalls = stubHubSpot();
    const offOutbox = await enqueueConfirmation(
      off,
      offSeat.regId,
      offSeat.orderId,
      offSeat.contactId,
    );
    const offState = await drain(off, TOPIC, offOutbox, offSeat.regId);

    // A tenant who drives confirmations elsewhere collects no dead rows, and no retries.
    expect(offState.acked).toBe(true);
    expect(offCalls.filter((c) => c.method === 'PATCH')).toEqual([]);
    expect(await outboxStatus(offOutbox)).toBe('delivered');
  });

  it('stays retryable on a transient failure, and takes nothing else down with it', async () => {
    const ids = freshIds();
    await seedTenantAndEvent(ids);
    const { regId, orderId, contactId } = await seedOrderAndRegistration(ids);
    stubHubSpot({ failPatch: true });

    const outboxId = await enqueueConfirmation(ids, regId, orderId, contactId);
    const state = await drain(ids, TOPIC, outboxId, regId);

    expect(state.retried).toBe(true);
    expect(state.acked).toBe(false);
    expect(await outboxStatus(outboxId)).toBe('failed');
  });

  it('a portal missing the property has it created, and the confirmation still lands', async () => {
    // The live-portal failure, exactly: Weld authorised before migration 0040, so every
    // booking's confirmation row died on `last_event_engine_registration_id does not
    // exist`. Phase 6.1 says the app provisions the properties its write-backs target —
    // and this is the only moment anyone finds out one is missing, since nobody re-runs
    // the installer on a portal that has been live for months.
    const ids = freshIds();
    await seedTenantAndEvent(ids);
    const { regId, orderId, contactId } = await seedOrderAndRegistration(ids);
    const calls = stubHubSpot({ rejectPatch: true });

    const confirmationOutbox = await enqueueConfirmation(ids, regId, orderId, contactId);
    const state = await drain(ids, TOPIC, confirmationOutbox, regId);

    expect(state.acked).toBe(true);
    expect(await outboxStatus(confirmationOutbox)).toBe('delivered');
    expect(calls.createdProperties).toContain(DEFAULT_PROPERTY);
    // Created, then written — the second PATCH is the one that stamps the order id.
    expect(confirmationPatches(calls)).toEqual([orderId, orderId]);
  });

  it('a portal that cannot create it loses this row and NOT the Marketing Event row', async () => {
    const ids = freshIds();
    await seedTenantAndEvent(ids);
    const { regId, orderId, contactId } = await seedOrderAndRegistration(ids);
    stubHubSpot({ rejectPatch: true, refuseCreate: true });

    const confirmationOutbox = await enqueueConfirmation(ids, regId, orderId, contactId);
    await drain(ids, TOPIC, confirmationOutbox, regId);
    // Nothing left to write: the only property this row carries is the missing one, and a
    // 400 that cannot be repaired is still permanent. It dies, as it must.
    expect(await outboxStatus(confirmationOutbox)).toBe('dead');

    // The Marketing Event write-back is a separate row in a separate failure domain. It
    // still delivers and still mirrors its state, so reporting shows no false sync gap and
    // reconcileOutbox does not re-register the attendee on every sweep.
    const meOutbox = await enqueueMe(ids, regId, contactId);
    const meState = await drain(ids, 'me.register', meOutbox, regId);

    expect(meState.acked).toBe(true);
    expect(await outboxStatus(meOutbox)).toBe('delivered');
    const reg = await E.DB.prepare(
      'SELECT marketing_event_state_synced FROM registrations WHERE id = ?1',
    )
      .bind(regId)
      .first<{ marketing_event_state_synced: number }>();
    expect(reg?.marketing_event_state_synced).toBe(1);
  });

  it('me.register does not write the confirmation property itself', async () => {
    const ids = freshIds();
    await seedTenantAndEvent(ids);
    const { regId, contactId } = await seedOrderAndRegistration(ids);
    const calls = stubHubSpot();

    const outboxId = await enqueueMe(ids, regId, contactId);
    const state = await drain(ids, 'me.register', outboxId, regId);

    expect(state.acked).toBe(true);
    expect(confirmationPatches(calls)).toEqual([]);
  });
});
