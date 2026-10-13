import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalPhone,
  canonicalState,
  diffContactDetails,
  loadAttendeeContactConfig,
  normaliseContactDetails,
} from '../src/attendee-contact';
import { listPendingDecisions, resolveDecision } from '../src/decisions';
import { handleOutboxMessage } from '../src/hubspot-writeback';
import { encryptToken } from '../src/token-crypto';
import type { Env } from '../src/types';
import { seedEvent, seedTicketType } from './support/fixtures';

/**
 * Phase 1.2 — attendee contact capture (phone, suburb, state).
 *
 * The behaviour that matters is the one that is easy to get wrong: the write-back fills
 * only what HubSpot leaves empty, and a differing value opens a decision instead of
 * overwriting. A member's stored phone number must survive a colleague's typo in a bulk
 * booking form.
 */

const E = env as unknown as Env;
const TOKEN_KEY = '0'.repeat(64);

let counter = 0;
const freshIds = () => {
  const n = `${Date.now()}-${counter++}`;
  return {
    portalId: `p12-${n}`,
    eventId: `evt12-${n}`,
    hsEvent: `hs12-${n}`,
    orderId: `ord12-${n}`,
    regId: `reg12-${n}`,
  };
};

/** A queue Message stub: records ack/retry so a test can assert the row was not re-driven. */
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

interface Fixture {
  portalId: string;
  eventId: string;
  regId: string;
}

function mappingColumns(
  mapping: 'custom' | 'standard' | 'off',
): [string | null, string | null, string | null] {
  if (mapping === 'standard') return [null, null, null];
  if (mapping === 'off') return ['off', 'off', 'off'];
  return ['mobilephone', 'suburb__c', 'state_region'];
}

/**
 * `mapping`:
 *   'custom'   — the portal keys these somewhere non-standard (explicit overrides)
 *   'standard' — no config at all, so the standard HubSpot properties apply
 *   'off'      — the tenant opted every field out of write-back
 */
async function seedFixture(opts?: {
  mapping?: 'custom' | 'standard' | 'off';
  ownerId?: string;
}): Promise<Fixture> {
  const { portalId, eventId, hsEvent, orderId, regId } = freshIds();
  const now = new Date().toISOString();

  await E.DB.prepare(
    `INSERT INTO tenants (portal_id, hs_access_token, hs_refresh_token, hs_token_expires_at,
       contact_phone_property, contact_suburb_property, contact_state_property, display_name)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'Test Tenant')`,
  )
    .bind(
      portalId,
      await encryptToken(TOKEN_KEY, 'hs-access-token'),
      await encryptToken(TOKEN_KEY, 'hs-refresh-token'),
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      ...mappingColumns(opts?.mapping ?? 'custom'),
    )
    .run();

  await seedEvent(E.DB, {
    portalId,
    eventId,
    hubspotEventId: hsEvent,
    startsAt: now,
    extra: { hubspot_owner_id: opts?.ownerId ?? 'owner-12' },
  });
  const ticketTypeId = await seedTicketType(E.DB, {
    portalId,
    eventId,
    ticketTypeId: `tt12-${eventId}`,
  });

  await E.DB.prepare(
    `INSERT INTO orders
       (id, portal_id, event_id, status, total_cents, buyer_email, buyer_name, updated_at)
     VALUES (?1, ?2, ?3, 'confirmed', 0, 'buyer@weld.test', 'Buyer', ?4)`,
  )
    .bind(orderId, portalId, eventId, now)
    .run();

  await E.DB.prepare(
    `INSERT INTO registrations
       (id, portal_id, order_id, event_id, ticket_type_id, attendee_email, attendee_name,
        attendee_phone, attendee_suburb, attendee_state, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'sam@weld.test', 'Sam Tan',
             '0412 345 678', 'Prospect', 'SA', ?6)`,
  )
    .bind(regId, portalId, orderId, eventId, ticketTypeId, now)
    .run();

  return { portalId, eventId, regId };
}

async function enqueueSync(fx: Fixture, force = false): Promise<string> {
  const outboxId = crypto.randomUUID();
  await E.DB.prepare(
    `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
     VALUES (?1, ?2, 'contact.sync_attendee_details', ?3, ?4)`,
  )
    .bind(
      outboxId,
      fx.portalId,
      JSON.stringify({
        registrationId: fx.regId,
        eventId: fx.eventId,
        attendeeEmail: 'sam@weld.test',
        attendeeName: 'Sam Tan',
        hubspotContactId: null,
        details: { phone: '0412 345 678', suburb: 'Prospect', state: 'SA' },
        force,
      }),
      new Date().toISOString(),
    )
    .run();
  return outboxId;
}

/**
 * Stub HubSpot: the GET returns `contactProperties`, everything else 200s. Returns the
 * captured calls so a test can assert exactly what was PATCHed (and what was not).
 */
function stubHubSpot(contactProperties: Record<string, string | null> | 'missing') {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });

      if (method === 'GET' && url.includes('/crm/v3/objects/contacts/')) {
        if (contactProperties === 'missing') {
          return new Response(JSON.stringify({ status: 'error', message: 'not found' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ id: 'c-1', properties: contactProperties }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ id: 'c-1' }), {
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

const patchedProperties = (calls: Array<{ method: string; url: string; body: unknown }>) =>
  calls
    .filter((call) => call.method === 'PATCH' && call.url.includes('/objects/contacts/'))
    .map((call) => (call.body as { properties: Record<string, string> }).properties);

afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------
// Capture + canonicalisation
// ---------------------------------------------------------------------------

describe('capture normalisation', () => {
  it('trims values and reports nothing captured when the form did not ask', () => {
    expect(
      normaliseContactDetails({ phone: '  0412 345 678 ', suburb: '', state: undefined }),
    ).toEqual({ values: { phone: '0412 345 678', suburb: null, state: null }, any: true });
    expect(normaliseContactDetails(undefined)).toEqual({
      values: { phone: null, suburb: null, state: null },
      any: false,
    });
    // Whitespace-only is "not answered", not an answer of ''.
    expect(normaliseContactDetails({ phone: '   ' }).any).toBe(false);
  });

  it('treats reformatted phone numbers and state names as the same value', () => {
    expect(canonicalPhone('+61 412 345 678')).toBe(canonicalPhone('0412 345 678'));
    expect(canonicalPhone('(08) 8212 3456')).toBe(canonicalPhone('08 8212 3456'));
    expect(canonicalState('South Australia')).toBe(canonicalState('sa'));
    expect(canonicalState('VIC')).not.toBe(canonicalState('SA'));
    // A non-Australian number keeps its country code rather than being mangled into a match.
    expect(canonicalPhone('+64 21 555 0100')).not.toBe(canonicalPhone('021 555 0100'));
  });
});

describe('diffContactDetails', () => {
  const config = {
    phoneProperty: 'mobilephone',
    suburbProperty: 'city',
    stateProperty: 'state',
  };
  const captured = { phone: '0412 345 678', suburb: 'Prospect', state: 'SA' };

  it('writes only the empty properties and reports the rest as conflicts', () => {
    const diff = diffContactDetails({
      config,
      captured,
      existing: { mobilephone: '0400 000 000', city: '', state: null },
    });
    expect(diff.writes).toEqual({ city: 'Prospect', state: 'SA' });
    expect(diff.conflicts).toEqual([
      {
        field: 'phone',
        property: 'mobilephone',
        existing: '0400 000 000',
        captured: '0412 345 678',
      },
    ]);
  });

  it('is a no-op when HubSpot already holds the same value in another format', () => {
    const diff = diffContactDetails({
      config,
      captured,
      existing: { mobilephone: '+61 412 345 678', city: 'prospect', state: 'South Australia' },
    });
    expect(diff.writes).toEqual({});
    expect(diff.conflicts).toEqual([]);
  });

  it('never writes an unmapped field, and reports it instead', () => {
    const diff = diffContactDetails({
      config: { phoneProperty: 'mobilephone', suburbProperty: null, stateProperty: null },
      captured,
      existing: {},
    });
    expect(diff.writes).toEqual({ mobilephone: '0412 345 678' });
    expect(diff.unmapped).toEqual(['suburb', 'state']);
  });

  it('force overwrites everything captured (the resolved-conflict path)', () => {
    const diff = diffContactDetails({
      config,
      captured,
      existing: { mobilephone: '0400 000 000', city: 'Adelaide', state: 'VIC' },
      force: true,
    });
    expect(diff.writes).toEqual({ mobilephone: '0412 345 678', city: 'Prospect', state: 'SA' });
    expect(diff.conflicts).toEqual([]);
  });
});

describe('loadAttendeeContactConfig', () => {
  const STANDARD = { phoneProperty: 'phone', suburbProperty: 'city', stateProperty: 'state' };

  it("uses HubSpot's standard contact properties when a tenant has configured nothing", async () => {
    const fx = await seedFixture({ mapping: 'standard' });
    expect(await loadAttendeeContactConfig(E, fx.portalId)).toEqual(STANDARD);
  });

  it('honours a portal that keys these somewhere non-standard', async () => {
    const fx = await seedFixture({ mapping: 'custom' });
    expect(await loadAttendeeContactConfig(E, fx.portalId)).toEqual({
      phoneProperty: 'mobilephone',
      suburbProperty: 'suburb__c',
      stateProperty: 'state_region',
    });
  });

  it("'off' opts a field out of write-back entirely", async () => {
    const fx = await seedFixture({ mapping: 'off' });
    expect(await loadAttendeeContactConfig(E, fx.portalId)).toEqual({
      phoneProperty: null,
      suburbProperty: null,
      stateProperty: null,
    });
  });

  it('falls back to the standard properties for an unknown portal rather than throwing', async () => {
    expect(await loadAttendeeContactConfig(E, 'no-such-portal')).toEqual(STANDARD);
  });
});

// ---------------------------------------------------------------------------
// Write-back through the outbox
// ---------------------------------------------------------------------------

describe('contact.sync_attendee_details write-back', () => {
  it('fills empty properties on the contact', async () => {
    const fx = await seedFixture();
    const outboxId = await enqueueSync(fx);
    const calls = stubHubSpot({ mobilephone: '', suburb__c: null, state_region: '' });

    const { msg, state } = fakeMessage({
      kind: 'contact.sync_attendee_details',
      portalId: fx.portalId,
      outboxId,
    });
    await handleOutboxMessage(msg, E);

    expect(state.acked).toBe(true);
    expect(patchedProperties(calls)).toEqual([
      { mobilephone: '0412 345 678', suburb__c: 'Prospect', state_region: 'SA' },
    ]);
    const row = await E.DB.prepare('SELECT status FROM outbox WHERE id = ?1')
      .bind(outboxId)
      .first<{ status: string }>();
    expect(row?.status).toBe('delivered');
    expect(await listPendingDecisions(E, fx.portalId, fx.eventId)).toEqual([]);
  });

  it("creates the ATTENDEE's contact with their name when HubSpot has none", async () => {
    const fx = await seedFixture();
    const outboxId = await enqueueSync(fx);
    const calls = stubHubSpot('missing');

    const { msg } = fakeMessage({
      kind: 'contact.sync_attendee_details',
      portalId: fx.portalId,
      outboxId,
    });
    await handleOutboxMessage(msg, E);

    // Identified by the attendee's own email, not the buyer's, and never a bare record
    // holding a phone number with nothing to say whose it is.
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.url).toContain(encodeURIComponent('sam@weld.test'));
    expect(patchedProperties(calls)).toEqual([
      {
        email: 'sam@weld.test',
        firstname: 'Sam',
        lastname: 'Tan',
        mobilephone: '0412 345 678',
        suburb__c: 'Prospect',
        state_region: 'SA',
      },
    ]);

    // …and the registration is linked to the contact that write created.
    const reg = await E.DB.prepare('SELECT hubspot_contact_id FROM registrations WHERE id = ?1')
      .bind(fx.regId)
      .first<{ hubspot_contact_id: string }>();
    expect(reg?.hubspot_contact_id).toBe('c-1');
  });

  it('never rewrites the name on a contact that already exists', async () => {
    const fx = await seedFixture();
    const outboxId = await enqueueSync(fx);
    const calls = stubHubSpot({ mobilephone: '', suburb__c: null, state_region: '' });

    const { msg } = fakeMessage({
      kind: 'contact.sync_attendee_details',
      portalId: fx.portalId,
      outboxId,
    });
    await handleOutboxMessage(msg, E);

    const [properties] = patchedProperties(calls);
    expect(properties).not.toHaveProperty('firstname');
    expect(properties).not.toHaveProperty('lastname');
  });

  it('does not overwrite a differing value — it raises a decision and writes the rest', async () => {
    const fx = await seedFixture();
    const outboxId = await enqueueSync(fx);
    const calls = stubHubSpot({ mobilephone: '0400 111 222', suburb__c: '', state_region: 'NSW' });

    const { msg } = fakeMessage({
      kind: 'contact.sync_attendee_details',
      portalId: fx.portalId,
      outboxId,
    });
    await handleOutboxMessage(msg, E);

    // The only PATCH touches the one empty property. The member's phone and state stand.
    const patches = patchedProperties(calls);
    expect(patches).toEqual([{ suburb__c: 'Prospect' }]);

    const decisions = await listPendingDecisions(E, fx.portalId, fx.eventId);
    expect(decisions.length).toBe(1);
    expect(decisions[0].type).toBe('contact_conflict');
    expect(decisions[0].registration_id).toBe(fx.regId);
    expect(decisions[0].assigned_owner_id).toBe('owner-12');

    const context = JSON.parse(decisions[0].context ?? '{}');
    expect(context.conflicts.map((c: { field: string }) => c.field).sort()).toEqual([
      'phone',
      'state',
    ]);
    expect(context.written).toEqual(['suburb__c']);

    // …and the event owner is told about it.
    const task = await E.DB.prepare(
      `SELECT COUNT(*) AS n FROM outbox
        WHERE topic = 'notify.owner_task' AND json_extract(payload, '$.registrationId') = ?1`,
    )
      .bind(fx.regId)
      .first<{ n: number }>();
    expect(task?.n).toBe(1);
  });

  it('does not open a second decision when the row is re-driven', async () => {
    const fx = await seedFixture();
    const existing = { mobilephone: '0400 111 222', suburb__c: 'Adelaide', state_region: 'NSW' };

    for (const _ of [1, 2]) {
      const outboxId = await enqueueSync(fx);
      stubHubSpot(existing);
      const { msg } = fakeMessage({
        kind: 'contact.sync_attendee_details',
        portalId: fx.portalId,
        outboxId,
      });
      await handleOutboxMessage(msg, E);
      vi.unstubAllGlobals();
    }

    expect((await listPendingDecisions(E, fx.portalId, fx.eventId)).length).toBe(1);
  });

  it('writes to the standard HubSpot properties when the tenant configured none', async () => {
    const fx = await seedFixture({ mapping: 'standard' });
    const outboxId = await enqueueSync(fx);
    const calls = stubHubSpot({ phone: '', city: '', state: '' });

    const { msg } = fakeMessage({
      kind: 'contact.sync_attendee_details',
      portalId: fx.portalId,
      outboxId,
    });
    await handleOutboxMessage(msg, E);

    expect(patchedProperties(calls)).toEqual([
      { phone: '0412 345 678', city: 'Prospect', state: 'SA' },
    ]);
    // The GET asks for the standard properties too — a mismatch there would read every
    // field as empty and turn a real conflict into a silent overwrite.
    const get = calls.find((call) => call.method === 'GET');
    expect(get?.url).toContain('properties=phone,city,state');
  });

  it("touches only the attendee's contact, never the buyer's", async () => {
    const fx = await seedFixture();
    const outboxId = await enqueueSync(fx);
    const calls = stubHubSpot({ mobilephone: '', suburb__c: '', state_region: '' });

    const { msg } = fakeMessage({
      kind: 'contact.sync_attendee_details',
      portalId: fx.portalId,
      outboxId,
    });
    await handleOutboxMessage(msg, E);

    // The order's buyer is a different person (buyer@weld.test booked a seat for Sam).
    // Their record must not collect Sam's phone number.
    expect(calls.every((call) => !call.url.includes(encodeURIComponent('buyer@weld.test')))).toBe(
      true,
    );
    expect(calls.some((call) => call.url.includes(encodeURIComponent('sam@weld.test')))).toBe(true);
  });

  it("writes nothing when the tenant has switched write-back 'off'", async () => {
    const fx = await seedFixture({ mapping: 'off' });
    const outboxId = await enqueueSync(fx);
    const calls = stubHubSpot({});

    const { msg } = fakeMessage({
      kind: 'contact.sync_attendee_details',
      portalId: fx.portalId,
      outboxId,
    });
    await handleOutboxMessage(msg, E);

    expect(patchedProperties(calls)).toEqual([]);
    expect(await listPendingDecisions(E, fx.portalId, fx.eventId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Resolving the conflict
// ---------------------------------------------------------------------------

/**
 * The join URL is mapped like the three capture fields and written on opposite terms: it is
 * a value this worker minted seconds ago, so HubSpot's copy is a stale link to whatever
 * event the contact registered for last. Preserving it would send someone to a webinar that
 * finished a month ago.
 */
describe('contact.set_join_url property mapping', () => {
  async function enqueueJoinUrl(fx: Fixture, joinUrl: string | null): Promise<string> {
    const outboxId = crypto.randomUUID();
    await E.DB.prepare(
      `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
       VALUES (?1, ?2, 'contact.set_join_url', ?3, ?4)`,
    )
      .bind(
        outboxId,
        fx.portalId,
        JSON.stringify({
          registrationId: fx.regId,
          attendeeEmail: 'sam@weld.test',
          teamsJoinUrl: joinUrl,
        }),
        new Date().toISOString(),
      )
      .run();
    return outboxId;
  }

  async function drain(fx: Fixture, outboxId: string) {
    const { msg, state } = fakeMessage({
      kind: 'contact.set_join_url',
      portalId: fx.portalId,
      outboxId,
    });
    await handleOutboxMessage(msg, E);
    return state;
  }

  it('writes teams_join_url when the tenant has expressed no preference', async () => {
    const fx = await seedFixture();
    const outboxId = await enqueueJoinUrl(fx, 'https://teams.example/join/abc');
    const calls = stubHubSpot({});

    expect((await drain(fx, outboxId)).acked).toBe(true);
    // The name the worker has always written, and the one the shipped workflow specs read.
    expect(patchedProperties(calls)).toEqual([
      { teams_join_url: 'https://teams.example/join/abc' },
    ]);
  });

  it("writes the tenant's own property when they key it elsewhere", async () => {
    const fx = await seedFixture();
    await E.DB.prepare('UPDATE tenants SET contact_join_url_property = ?1 WHERE portal_id = ?2')
      .bind('webinar_link', fx.portalId)
      .run();
    const outboxId = await enqueueJoinUrl(fx, 'https://teams.example/join/abc');
    const calls = stubHubSpot({});

    await drain(fx, outboxId);
    expect(patchedProperties(calls)).toEqual([{ webinar_link: 'https://teams.example/join/abc' }]);
  });

  it("writes nothing when the tenant has switched it 'off'", async () => {
    const fx = await seedFixture();
    await E.DB.prepare('UPDATE tenants SET contact_join_url_property = ?1 WHERE portal_id = ?2')
      .bind('off', fx.portalId)
      .run();
    const outboxId = await enqueueJoinUrl(fx, 'https://teams.example/join/abc');
    const calls = stubHubSpot({});

    // A no-op, not a failure: a row that can never be written must not be retried forever.
    const state = await drain(fx, outboxId);
    expect(state.acked).toBe(true);
    expect(state.retried).toBe(false);
    expect(calls.filter((c) => c.method === 'PATCH')).toEqual([]);
    const row = await E.DB.prepare('SELECT status FROM outbox WHERE id = ?1')
      .bind(outboxId)
      .first<{ status: string }>();
    expect(row?.status).toBe('delivered');
  });

  it('stays a no-op for an in-person event', async () => {
    const fx = await seedFixture();
    const outboxId = await enqueueJoinUrl(fx, null);
    const calls = stubHubSpot({});
    await drain(fx, outboxId);
    expect(calls.filter((c) => c.method === 'PATCH')).toEqual([]);
  });
});

describe('resolving a contact_conflict', () => {
  async function openConflict(): Promise<Fixture> {
    const fx = await seedFixture();
    const outboxId = await enqueueSync(fx);
    stubHubSpot({ mobilephone: '0400 111 222', suburb__c: 'Adelaide', state_region: 'NSW' });
    const { msg } = fakeMessage({
      kind: 'contact.sync_attendee_details',
      portalId: fx.portalId,
      outboxId,
    });
    await handleOutboxMessage(msg, E);
    vi.unstubAllGlobals();
    return fx;
  }

  it("'keep' closes it without touching HubSpot", async () => {
    const fx = await openConflict();
    const [decision] = await listPendingDecisions(E, fx.portalId, fx.eventId);

    const result = await resolveDecision(E, fx.portalId, decision.id, {
      action: 'keep',
      resolvedBy: 'u-1',
    });
    expect(result.ok).toBe(true);
    expect(await listPendingDecisions(E, fx.portalId, fx.eventId)).toEqual([]);

    const queued = await E.DB.prepare(
      `SELECT COUNT(*) AS n FROM outbox
        WHERE topic = 'contact.sync_attendee_details'
          AND json_extract(payload, '$.registrationId') = ?1
          AND json_extract(payload, '$.force') = 1`,
    )
      .bind(fx.regId)
      .first<{ n: number }>();
    expect(queued?.n).toBe(0);
  });

  it("'overwrite' replays the captured values through the outbox", async () => {
    const fx = await openConflict();
    const [decision] = await listPendingDecisions(E, fx.portalId, fx.eventId);

    const result = await resolveDecision(E, fx.portalId, decision.id, {
      action: 'overwrite',
      resolvedBy: 'u-1',
    });
    expect(result.ok).toBe(true);

    const forced = await E.DB.prepare(
      `SELECT id FROM outbox
        WHERE topic = 'contact.sync_attendee_details'
          AND json_extract(payload, '$.registrationId') = ?1
          AND json_extract(payload, '$.force') = 1`,
    )
      .bind(fx.regId)
      .first<{ id: string }>();
    expect(forced).not.toBeNull();

    // Draining it overwrites every captured field — and asks HubSpot for nothing first.
    const calls = stubHubSpot({
      mobilephone: '0400 111 222',
      suburb__c: 'Adelaide',
      state_region: 'NSW',
    });
    const { msg } = fakeMessage({
      kind: 'contact.sync_attendee_details',
      portalId: fx.portalId,
      outboxId: forced?.id,
    });
    await handleOutboxMessage(msg, E);

    expect(calls.filter((c) => c.method === 'GET')).toEqual([]);
    expect(patchedProperties(calls)).toEqual([
      { mobilephone: '0412 345 678', suburb__c: 'Prospect', state_region: 'SA' },
    ]);
  });

  it('rejects an action that is not keep or overwrite', async () => {
    const fx = await openConflict();
    const [decision] = await listPendingDecisions(E, fx.portalId, fx.eventId);
    expect(await resolveDecision(E, fx.portalId, decision.id, { action: 'honour' })).toEqual({
      ok: false,
      error: 'invalid_action',
    });
  });
});
