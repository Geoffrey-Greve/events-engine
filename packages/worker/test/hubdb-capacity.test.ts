import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncCapacityFromD1 } from '../src/capacity-sync';
import { type EventRow, loadEvent, loadTicketTypes } from '../src/db';
import {
  readCapacityCell,
  syncCapacityBeforeHold,
  syncEventCapacityFromHubDb,
} from '../src/hubdb-capacity';
import { manageRoutes } from '../src/routes/manage';
import { handleGetAvailability } from '../src/routes/reserve';
import type { Env } from '../src/types';
import { seedEvent, seedTenant, seedTicketType } from './support/fixtures';

// Migration 0045 (QA ref 87). Staff raise a course's seats in HubDB and expect it to
// reopen; until this nothing read the number. Real D1 and real EventCapacity DOs, HubSpot
// stubbed at fetch, because the property under test is that a HubDB edit reaches the seat
// math and that nothing about it can oversell.

const E = env as unknown as Env;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

let counter = 0;
function freshIds() {
  const n = `${Date.now()}-${counter++}`;
  return { portalId: `cap-${n}`, eventId: `evt-cap-${n}`, hubspotEventId: `hs-cap-${n}` };
}

function envWithKey(portalId: string, extra: Record<string, string> = {}): Env {
  return {
    ...(E as unknown as Record<string, unknown>),
    [`HUBSPOT_API_KEY_${portalId}`]: 'test-key',
    ...extra,
  } as unknown as Env;
}

async function seed(opts: {
  capacity?: number;
  capacityColumn?: string | null;
  ticketCapacities?: number[];
}) {
  const ids = freshIds();
  await seedTenant(E.DB, ids.portalId, {
    hubdb_courses_table: 'courses',
    hubdb_courses_capacity_column:
      opts.capacityColumn === undefined ? 'capacity' : opts.capacityColumn,
  });
  await seedEvent(E.DB, {
    portalId: ids.portalId,
    eventId: ids.eventId,
    hubspotEventId: ids.hubspotEventId,
    capacity: opts.capacity ?? 24,
  });
  const caps = opts.ticketCapacities ?? [24];
  for (const [i, cap] of caps.entries()) {
    await seedTicketType(E.DB, {
      portalId: ids.portalId,
      eventId: ids.eventId,
      ticketTypeId: `${ids.eventId}-tt${i}`,
      capacity: cap,
      priceCents: 50000,
    });
  }
  return ids;
}

/** A HubDB rows API answering the event-id filter from `rows`. */
function stubHubDb(rows: Array<Record<string, unknown>>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (!url.hostname.endsWith('hubapi.com')) return new Response('{}', { status: 404 });
    if (/\/rows\/[^/]+$/.test(url.pathname)) return new Response('{}', { status: 404 });
    const key = [...url.searchParams.keys()].find((k) => k.endsWith('__eq'));
    const matched = key
      ? rows.filter((r) => String(r[key.replace(/__eq$/, '')] ?? '') === url.searchParams.get(key))
      : rows;
    return Response.json({ results: matched.map((values) => ({ values })) });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function load(portalId: string, eventId: string) {
  const event = (await loadEvent(E.DB, portalId, eventId)) as EventRow;
  const ticketTypes = await loadTicketTypes(E.DB, eventId);
  return { event, ticketTypes };
}

describe('readCapacityCell', () => {
  it('accepts whole seat counts, as numbers or numeric text', () => {
    expect(readCapacityCell(30)).toBe(30);
    expect(readCapacityCell('30')).toBe(30);
    expect(readCapacityCell(' 1,200 ')).toBe(1200);
  });

  it('refuses anything that is not a real capacity', () => {
    for (const v of [null, undefined, '', '  ', 0, '0', -3, 12.5, 'twenty', Number.NaN]) {
      expect(readCapacityCell(v)).toBeNull();
    }
  });
});

describe('syncEventCapacityFromHubDb', () => {
  it('raises the event and every ticket type that tracked it; a smaller type stays put', async () => {
    const ids = await seed({ capacity: 24, ticketCapacities: [24, 24, 5] });
    stubHubDb([{ worker_event_id: ids.eventId, capacity: 30 }]);
    const { event, ticketTypes } = await load(ids.portalId, ids.eventId);

    const outcome = await syncEventCapacityFromHubDb(
      envWithKey(ids.portalId),
      ids.portalId,
      event,
      ticketTypes,
    );

    expect(outcome).toEqual({ status: 'updated', from: 24, to: 30, ticketTypesMoved: 2 });
    // The caller's own objects move, so its next DO sync sends the new numbers.
    expect(event.capacity).toBe(30);
    expect(ticketTypes.map((t) => t.capacity).sort((a, b) => a - b)).toEqual([5, 30, 30]);
    // And D1 moved, so the DO's cold-start rebuild agrees.
    const reread = await load(ids.portalId, ids.eventId);
    expect(reread.event.capacity).toBe(30);
    expect(reread.ticketTypes.map((t) => t.capacity).sort((a, b) => a - b)).toEqual([5, 30, 30]);
  });

  it('moves ticket types the caller did not pass (the course-bundle paths pass one)', async () => {
    const ids = await seed({ capacity: 24, ticketCapacities: [24, 24] });
    stubHubDb([{ worker_event_id: ids.eventId, capacity: 40 }]);
    const { event, ticketTypes } = await load(ids.portalId, ids.eventId);

    await syncEventCapacityFromHubDb(envWithKey(ids.portalId), ids.portalId, event, [
      ticketTypes[0],
    ]);

    const reread = await load(ids.portalId, ids.eventId);
    expect(reread.ticketTypes.every((t) => t.capacity === 40)).toBe(true);
  });

  it('changes nothing for a blank, zero or fractional cell', async () => {
    for (const cell of ['', 0, 12.5, null]) {
      const ids = await seed({ capacity: 24 });
      stubHubDb([{ worker_event_id: ids.eventId, capacity: cell }]);
      const { event, ticketTypes } = await load(ids.portalId, ids.eventId);

      const outcome = await syncEventCapacityFromHubDb(
        envWithKey(ids.portalId),
        ids.portalId,
        event,
        ticketTypes,
      );

      expect(outcome.status).toBe('no_capacity');
      expect((await load(ids.portalId, ids.eventId)).event.capacity).toBe(24);
    }
  });

  it('does not read HubDB at all for a portal that has not mapped a capacity column', async () => {
    const ids = await seed({ capacity: 24, capacityColumn: null });
    const fetchMock = stubHubDb([{ worker_event_id: ids.eventId, capacity: 99 }]);
    const { event, ticketTypes } = await load(ids.portalId, ids.eventId);

    const outcome = await syncEventCapacityFromHubDb(
      envWithKey(ids.portalId),
      ids.portalId,
      event,
      ticketTypes,
    );

    expect(outcome.status).toBe('not_configured');
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await load(ids.portalId, ids.eventId)).event.capacity).toBe(24);
  });

  it('keeps the D1 capacity when HubSpot cannot be read', async () => {
    const ids = await seed({ capacity: 24 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('down', { status: 503 })),
    );
    const { event, ticketTypes } = await load(ids.portalId, ids.eventId);

    const outcome = await syncEventCapacityFromHubDb(
      envWithKey(ids.portalId),
      ids.portalId,
      event,
      ticketTypes,
    );

    expect(outcome.status).toBe('no_hubdb_row');
    expect((await load(ids.portalId, ids.eventId)).event.capacity).toBe(24);
  });

  it('throttles: a second read inside a minute does not touch HubDB', async () => {
    const ids = await seed({ capacity: 24 });
    const fetchMock = stubHubDb([{ worker_event_id: ids.eventId, capacity: 24 }]);
    const first = await load(ids.portalId, ids.eventId);
    await syncEventCapacityFromHubDb(
      envWithKey(ids.portalId),
      ids.portalId,
      first.event,
      first.ticketTypes,
      {
        throttle: true,
      },
    );
    const calls = fetchMock.mock.calls.length;

    const second = await load(ids.portalId, ids.eventId);
    const outcome = await syncEventCapacityFromHubDb(
      envWithKey(ids.portalId),
      ids.portalId,
      second.event,
      second.ticketTypes,
      { throttle: true },
    );

    expect(outcome.status).toBe('throttled');
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('lowering capacity below the seats already held sells nothing more and cancels nobody', async () => {
    const ids = await seed({ capacity: 3, ticketCapacities: [3] });
    const envK = envWithKey(ids.portalId);
    const stub = E.EVENT_CAPACITY.get(
      E.EVENT_CAPACITY.idFromName(`${ids.portalId}:${ids.hubspotEventId}`),
    );
    const ttId = `${ids.eventId}-tt0`;

    let { event, ticketTypes } = await load(ids.portalId, ids.eventId);
    await syncCapacityFromD1(stub, event, ticketTypes);
    for (const holdId of ['h1', 'h2']) {
      const r = await stub.fetch('https://do/reserve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          holdId: `${ids.eventId}-${holdId}`,
          items: [{ ticketTypeId: ttId, quantity: 1 }],
        }),
      });
      expect(((await r.json()) as { ok: boolean }).ok).toBe(true);
    }

    stubHubDb([{ worker_event_id: ids.eventId, capacity: 1 }]);
    ({ event, ticketTypes } = await load(ids.portalId, ids.eventId));
    await syncEventCapacityFromHubDb(envK, ids.portalId, event, ticketTypes);
    await syncCapacityFromD1(stub, event, ticketTypes);

    const third = await stub.fetch('https://do/reserve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        holdId: `${ids.eventId}-h3`,
        items: [{ ticketTypeId: ttId, quantity: 1 }],
      }),
    });
    expect(((await third.json()) as { ok: boolean }).ok).toBe(false);

    // The two holds already out there are untouched.
    const snap = (await (
      await stub.fetch('https://do/availability', { method: 'POST' })
    ).json()) as {
      available: number;
    };
    expect(snap.available).toBeLessThanOrEqual(0);
  });
});

describe('GET /events/:slug/availability picks up a HubDB capacity', () => {
  const app = new Hono<{ Bindings: Env }>();
  app.get('/api/v1/events/:slug/availability', handleGetAvailability);

  it('reopens a sold-out course when staff raise its capacity in HubDB', async () => {
    const ids = await seed({ capacity: 1, ticketCapacities: [1] });
    const envK = envWithKey(ids.portalId);
    const stub = E.EVENT_CAPACITY.get(
      E.EVENT_CAPACITY.idFromName(`${ids.portalId}:${ids.hubspotEventId}`),
    );
    const { event, ticketTypes } = await load(ids.portalId, ids.eventId);
    await syncCapacityFromD1(stub, event, ticketTypes);
    await stub.fetch('https://do/reserve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        holdId: `${ids.eventId}-h1`,
        items: [{ ticketTypeId: `${ids.eventId}-tt0`, quantity: 1 }],
      }),
    });

    stubHubDb([{ worker_event_id: ids.eventId, capacity: 5 }]);
    const res = await app.request(
      `/api/v1/events/${ids.eventId}/availability`,
      { headers: { 'X-Portal-Id': ids.portalId, 'CF-Connecting-IP': `10.9.0.${counter % 250}` } },
      envK,
    );
    const body = (await res.json()) as { eventFull: boolean; bookable: boolean };

    expect(body.eventFull).toBe(false);
    expect(body.bookable).toBe(true);
    expect((await load(ids.portalId, ids.eventId)).event.capacity).toBe(5);
  });
});

describe('PATCH /onboarding/hubdb-capacity', () => {
  function patch(portalId: string, body: unknown) {
    const adminKey = `admin-${portalId}`;
    return manageRoutes.request(
      '/onboarding/hubdb-capacity',
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${adminKey}`,
          'X-Portal-Id': portalId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      {
        ...(E as unknown as Record<string, unknown>),
        [`ADMIN_API_KEY_${portalId}`]: adminKey,
      } as unknown as Env,
    );
  }

  it('refuses a capacity column for a table the portal has not configured', async () => {
    const { portalId } = freshIds();
    await seedTenant(E.DB, portalId);

    const res = await patch(portalId, { eventsCapacityColumn: 'capacity' });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { status: string }).status).toBe('table_required');
  });

  it('stores the mapping, and null clears it', async () => {
    const { portalId } = freshIds();
    await seedTenant(E.DB, portalId, { hubdb_courses_table: 'courses' });

    expect((await patch(portalId, { coursesCapacityColumn: 'capacity' })).status).toBe(200);
    let row = await E.DB.prepare(
      'SELECT hubdb_courses_capacity_column AS c FROM tenants WHERE portal_id = ?1',
    )
      .bind(portalId)
      .first<{ c: string | null }>();
    expect(row?.c).toBe('capacity');

    expect((await patch(portalId, { coursesCapacityColumn: null })).status).toBe(200);
    row = await E.DB.prepare(
      'SELECT hubdb_courses_capacity_column AS c FROM tenants WHERE portal_id = ?1',
    )
      .bind(portalId)
      .first<{ c: string | null }>();
    expect(row?.c).toBeNull();
  });
});

describe('syncCapacityBeforeHold: a lowered capacity must reach the DO before a hold', () => {
  // PR review (events-engine#69): the D1 sync is best-effort, so a lowered HubDB capacity
  // could land in D1 while an initialised DO kept its old, higher limit and sold into it.
  const failingStub = {
    fetch: vi.fn(async () => new Response('down', { status: 500 })),
  } as unknown as DurableObjectStub;

  it('refuses when capacity was lowered and the DO did not acknowledge it', async () => {
    const ids = await seed({ capacity: 24 });
    stubHubDb([{ worker_event_id: ids.eventId, capacity: 10 }]);
    const { event, ticketTypes } = await load(ids.portalId, ids.eventId);

    const ok = await syncCapacityBeforeHold(
      envWithKey(ids.portalId),
      ids.portalId,
      failingStub,
      event,
      ticketTypes,
    );

    expect(ok).toBe(false);
  });

  it('still books when capacity was RAISED, whatever the DO answered', async () => {
    const ids = await seed({ capacity: 24 });
    stubHubDb([{ worker_event_id: ids.eventId, capacity: 30 }]);
    const { event, ticketTypes } = await load(ids.portalId, ids.eventId);

    expect(
      await syncCapacityBeforeHold(
        envWithKey(ids.portalId),
        ids.portalId,
        failingStub,
        event,
        ticketTypes,
      ),
    ).toBe(true);
  });

  it('accepts a lowered capacity the real DO acknowledged, and the DO then holds to it', async () => {
    const ids = await seed({ capacity: 5, ticketCapacities: [5] });
    const stub = E.EVENT_CAPACITY.get(
      E.EVENT_CAPACITY.idFromName(`${ids.portalId}:${ids.hubspotEventId}`),
    );
    stubHubDb([{ worker_event_id: ids.eventId, capacity: 1 }]);
    const { event, ticketTypes } = await load(ids.portalId, ids.eventId);

    expect(
      await syncCapacityBeforeHold(
        envWithKey(ids.portalId),
        ids.portalId,
        stub,
        event,
        ticketTypes,
      ),
    ).toBe(true);
    const snap = (await (
      await stub.fetch('https://do/availability', { method: 'POST' })
    ).json()) as {
      available: number;
    };
    expect(snap.available).toBe(1);
  });
});
