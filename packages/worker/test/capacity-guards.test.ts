import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { maybeFlagFastSellout } from '../src/capacity-guard';
import type { EventRow } from '../src/db';
import { resolveDecision } from '../src/decisions';
import { manageRoutes } from '../src/routes/manage';
import { handleGetCourseComponents } from '../src/routes/reserve';
import type { Env } from '../src/types';
import { seedTenant } from './support/fixtures';

/**
 * Phase 1.1 — capacity guards.
 *
 * Two behaviours, one incident behind them: placeholder capacities entered during setup
 * and never replaced, one course left at zero, sales silently closed.
 *   - a write path that refuses an unset/zero capacity unless uncapped is explicit;
 *   - a sell-out inside 30 minutes of first publish raising a decision, not silence.
 */

const BASE_ENV = env as unknown as Env;
const publicRoutes = new Hono<{ Bindings: Env }>();
publicRoutes.get('/events/:slug/course-components', handleGetCourseComponents);

let counter = 0;
// Registers the portal as it mints it: `events.portal_id` and every other portal-scoped
// column REFERENCES `tenants`, and the suite runs against the real migrations, so a row
// carrying an unregistered id is refused exactly as it would be in production.
async function freshIds() {
  const n = `${Date.now()}-${counter++}`;
  const portalId = `cap-${n}`;
  await seedTenant(BASE_ENV.DB, portalId);
  return {
    portalId,
    adminKey: `admin-${n}`,
    eventId: `evt-${n}`,
    hubspotEventId: `hs-cap-${n}`,
    ticketTypeId: `tt-${n}`,
  };
}

type Ids = Awaited<ReturnType<typeof freshIds>>;

function envFor(portalId: string, adminKey: string): Env {
  return {
    ...(BASE_ENV as unknown as Record<string, unknown>),
    [`ADMIN_API_KEY_${portalId}`]: adminKey,
  } as unknown as Env;
}

function adminHeaders(portalId: string, adminKey: string) {
  return {
    'X-Portal-Id': portalId,
    Authorization: `Bearer ${adminKey}`,
    'Content-Type': 'application/json',
  };
}

function createEventBody(values: Ids, extra: Record<string, unknown>) {
  return JSON.stringify({
    hubspotEventId: values.hubspotEventId,
    title: 'Welding Fundamentals',
    startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    endsAt: new Date(Date.now() + 90_000_000).toISOString(),
    ...extra,
  });
}

function postEvent(values: Ids, extra: Record<string, unknown>) {
  return manageRoutes.request(
    '/events',
    {
      method: 'POST',
      headers: adminHeaders(values.portalId, values.adminKey),
      body: createEventBody(values, extra),
    },
    envFor(values.portalId, values.adminKey),
  );
}

function patchEvent(values: Ids, eventId: string, body: Record<string, unknown>) {
  return manageRoutes.request(
    `/events/${eventId}`,
    {
      method: 'PATCH',
      headers: adminHeaders(values.portalId, values.adminKey),
      body: JSON.stringify(body),
    },
    envFor(values.portalId, values.adminKey),
  );
}

describe('POST /events capacity guard', () => {
  it('rejects an absent capacity', async () => {
    const values = await freshIds();
    const res = await postEvent(values, {});
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ status: 'invalid_capacity' });
  });

  it('rejects a zero capacity — the placeholder that closed sales', async () => {
    const values = await freshIds();
    const res = await postEvent(values, { capacity: 0 });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ status: 'invalid_capacity' });

    const row = await BASE_ENV.DB.prepare(
      'SELECT id FROM events WHERE portal_id = ?1 AND hubspot_event_id = ?2',
    )
      .bind(values.portalId, values.hubspotEventId)
      .first();
    expect(row).toBeNull();
  });

  it('rejects a null and a fractional capacity', async () => {
    for (const capacity of [null, 2.5, '', 'twenty']) {
      const values = await freshIds();
      const res = await postEvent(values, { capacity });
      expect(res.status).toBe(400);
    }
  });

  it('accepts a real capacity and stamps first_published_at', async () => {
    const values = await freshIds();
    const res = await postEvent(values, { capacity: 24 });
    expect(res.status).toBe(201);
    const created = (await res.json()) as EventRow;
    expect(created.capacity).toBe(24);
    expect(created.capacity_unlimited).toBe(0);
    expect(Date.parse(created.first_published_at ?? '')).toBeGreaterThan(0);
  });

  it('accepts an uncapped event only when the flag says so explicitly', async () => {
    const values = await freshIds();
    const res = await postEvent(values, { capacityUnlimited: true });
    expect(res.status).toBe(201);
    const created = (await res.json()) as EventRow;
    expect(created.capacity_unlimited).toBe(1);
    // The stored number is meaningless once uncapped, so it is normalized rather than
    // left as a stale count a later un-flagging would resurrect.
    expect(created.capacity).toBe(0);
  });
});

describe('PATCH /events/:id capacity guard', () => {
  async function seedEvent(values: Ids, extra: Record<string, unknown>) {
    const res = await postEvent(values, extra);
    expect(res.status).toBe(201);
    return (await res.json()) as EventRow;
  }

  it('rejects patching the capacity to zero and leaves the row untouched', async () => {
    const values = await freshIds();
    const event = await seedEvent(values, { capacity: 24 });

    const res = await patchEvent(values, event.id, { capacity: 0 });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ status: 'invalid_capacity' });

    const row = await BASE_ENV.DB.prepare('SELECT capacity FROM events WHERE id = ?1')
      .bind(event.id)
      .first<{ capacity: number }>();
    expect(row?.capacity).toBe(24);
  });

  it('rejects clearing capacityUnlimited without supplying a seat count', async () => {
    const values = await freshIds();
    const event = await seedEvent(values, { capacityUnlimited: true });

    const res = await patchEvent(values, event.id, { capacityUnlimited: false });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ status: 'invalid_capacity' });
  });

  it('caps a previously uncapped event when given a real seat count', async () => {
    const values = await freshIds();
    const event = await seedEvent(values, { capacityUnlimited: true });

    const res = await patchEvent(values, event.id, { capacity: 40 });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as EventRow;
    expect(updated.capacity).toBe(40);
    expect(updated.capacity_unlimited).toBe(0);
  });

  it('blocks any further edit to an event still sitting on a zero capacity', async () => {
    const values = await freshIds();
    const now = new Date().toISOString();
    // A row that predates the guard: exactly the state the incident left behind.
    await BASE_ENV.DB.prepare(
      `INSERT INTO events (id, portal_id, hubspot_event_id, title, starts_at, ends_at,
         capacity, capacity_unlimited, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'Legacy placeholder', ?4, ?4, 0, 0, ?4, ?4)`,
    )
      .bind(values.eventId, values.portalId, values.hubspotEventId, now)
      .run();

    const blocked = await patchEvent(values, values.eventId, { title: 'Renamed' });
    expect(blocked.status).toBe(400);
    expect(await blocked.json()).toMatchObject({ status: 'invalid_capacity' });

    // Supplying the missing capacity in the same request unblocks it.
    const fixed = await patchEvent(values, values.eventId, { title: 'Renamed', capacity: 12 });
    expect(fixed.status).toBe(200);
    expect(await fixed.json()).toMatchObject({ title: 'Renamed', capacity: 12 });
  });

  it('keeps the original first_published_at across later edits', async () => {
    const values = await freshIds();
    const event = await seedEvent(values, { capacity: 24 });

    const res = await patchEvent(values, event.id, { capacity: 30 });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as EventRow;
    expect(updated.first_published_at).toBe(event.first_published_at);
  });
});

describe('course components', () => {
  it('creates and lists separately bookable modules under a parent course', async () => {
    const parentValues = await freshIds();
    const parentResponse = await postEvent(parentValues, { capacity: 24 });
    expect(parentResponse.status).toBe(201);
    const parent = (await parentResponse.json()) as EventRow;

    const childValues = {
      ...(await freshIds()),
      portalId: parentValues.portalId,
      adminKey: parentValues.adminKey,
    };
    const childResponse = await postEvent(childValues, {
      capacity: 12,
      parentEventId: parent.id,
      courseComponentKind: 'module',
      courseComponentOrder: 1,
      courseModuleProductId: 'hubspot-product-module-1',
      coursePackageRequired: true,
    });
    expect(childResponse.status).toBe(201);
    expect(await childResponse.json()).toMatchObject({
      parent_event_id: parent.id,
      course_component_kind: 'module',
      course_component_order: 1,
      course_module_product_id: 'hubspot-product-module-1',
      course_package_required: 1,
    });

    const componentsResponse = await manageRoutes.request(
      `/events/${parent.id}/course-components`,
      { headers: adminHeaders(parentValues.portalId, parentValues.adminKey) },
      envFor(parentValues.portalId, parentValues.adminKey),
    );
    expect(componentsResponse.status).toBe(200);
    expect(await componentsResponse.json()).toMatchObject([
      {
        parent_event_id: parent.id,
        course_component_kind: 'module',
        course_component_order: 1,
        course_module_product_id: 'hubspot-product-module-1',
        course_package_required: 1,
      },
    ]);

    const publicResponse = await publicRoutes.request(
      `/events/${parent.id}/course-components`,
      { headers: { 'X-Portal-Id': parentValues.portalId } },
      envFor(parentValues.portalId, parentValues.adminKey),
    );
    expect(publicResponse.status).toBe(200);
    expect(await publicResponse.json()).toMatchObject({
      courseEventId: parent.id,
      components: [
        {
          workerEventId: expect.any(String),
          moduleProductId: 'hubspot-product-module-1',
          kind: 'module',
          order: 1,
          includedInCoursePackage: true,
          ticketTypes: [],
        },
      ],
    });
  });

  it('rejects a component without the complete parent-course relationship', async () => {
    const values = await freshIds();
    const response = await postEvent(values, {
      capacity: 12,
      courseComponentKind: 'exam',
      courseComponentOrder: 1,
      courseModuleProductId: 'hubspot-product-exam-1',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ status: 'incomplete_course_component' });
  });
});

describe('ticket type capacity guard', () => {
  async function seedEvent(values: Ids) {
    const res = await postEvent(values, { capacity: 24 });
    return ((await res.json()) as EventRow).id;
  }

  function postTicketType(values: Ids, eventId: string, body: Record<string, unknown>) {
    return manageRoutes.request(
      `/events/${eventId}/ticket-types`,
      {
        method: 'POST',
        headers: adminHeaders(values.portalId, values.adminKey),
        body: JSON.stringify({ name: 'Standard', priceCents: 49_500, ...body }),
      },
      envFor(values.portalId, values.adminKey),
    );
  }

  it('rejects an absent or zero capacity', async () => {
    const values = await freshIds();
    const eventId = await seedEvent(values);

    expect((await postTicketType(values, eventId, {})).status).toBe(400);
    expect((await postTicketType(values, eventId, { capacity: 0 })).status).toBe(400);
  });

  it('accepts a real capacity, and an uncapped type behind the explicit flag', async () => {
    const values = await freshIds();
    const eventId = await seedEvent(values);

    const capped = await postTicketType(values, eventId, { capacity: 10 });
    expect(capped.status).toBe(201);
    expect(await capped.json()).toMatchObject({ capacity: 10, capacity_unlimited: 0 });

    const uncapped = await postTicketType(values, eventId, { capacityUnlimited: true });
    expect(uncapped.status).toBe(201);
    expect(await uncapped.json()).toMatchObject({ capacity_unlimited: 1 });
  });

  it('rejects patching a ticket type down to zero seats', async () => {
    const values = await freshIds();
    const eventId = await seedEvent(values);
    const created = (await (await postTicketType(values, eventId, { capacity: 10 })).json()) as {
      id: string;
    };

    const res = await manageRoutes.request(
      `/events/${eventId}/ticket-types/${created.id}`,
      {
        method: 'PATCH',
        headers: adminHeaders(values.portalId, values.adminKey),
        body: JSON.stringify({ capacity: 0 }),
      },
      envFor(values.portalId, values.adminKey),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ status: 'invalid_capacity' });
  });
});

describe('fast sell-out decision', () => {
  async function seedEvent(
    values: Ids,
    opts: { publishedMinutesAgo: number; capacity?: number; unlimited?: boolean },
  ): Promise<EventRow> {
    const now = new Date().toISOString();
    const published = new Date(Date.now() - opts.publishedMinutesAgo * 60_000).toISOString();
    await BASE_ENV.DB.prepare(
      `INSERT INTO events (id, portal_id, hubspot_event_id, title, starts_at, ends_at,
         capacity, capacity_unlimited, hubspot_owner_id, first_published_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'Confined Space Entry', ?4, ?4, ?5, ?6, 'owner-42', ?7, ?7, ?4)`,
    )
      .bind(
        values.eventId,
        values.portalId,
        values.hubspotEventId,
        now,
        opts.capacity ?? 2,
        opts.unlimited ? 1 : 0,
        published,
      )
      .run();
    return (await BASE_ENV.DB.prepare('SELECT * FROM events WHERE id = ?1')
      .bind(values.eventId)
      .first<EventRow>()) as EventRow;
  }

  /** Put `seats` of `capacity` on hold in the DO, so availability reads back for real. */
  async function sellOut(values: Ids, capacity: number, seats: number = capacity) {
    const idName = `${values.portalId}:${values.hubspotEventId}`;
    const stub = BASE_ENV.EVENT_CAPACITY.get(BASE_ENV.EVENT_CAPACITY.idFromName(idName));
    await stub.fetch('https://do/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventCapacity: capacity,
        perType: { [values.ticketTypeId]: { inventory: capacity } },
      }),
    });
    const res = await stub.fetch('https://do/reserve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        holdId: `hold-${values.eventId}`,
        items: [{ ticketTypeId: values.ticketTypeId, quantity: seats }],
      }),
    });
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  }

  async function openDecisions(portalId: string, eventId: string) {
    const rows = await BASE_ENV.DB.prepare(
      `SELECT * FROM pending_decisions WHERE portal_id = ?1 AND event_id = ?2 AND type = 'fast_sellout'`,
    )
      .bind(portalId, eventId)
      .all<{ id: string; status: string; assigned_owner_id: string; context: string }>();
    return rows.results;
  }

  it('raises an owner-assigned decision when an event sells out minutes after publish', async () => {
    const values = await freshIds();
    const event = await seedEvent(values, { publishedMinutesAgo: 5 });
    await sellOut(values, 2);

    expect(await maybeFlagFastSellout(BASE_ENV, values.portalId, event)).toBe(true);

    const decisions = await openDecisions(values.portalId, values.eventId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].status).toBe('open');
    expect(decisions[0].assigned_owner_id).toBe('owner-42');
    expect(JSON.parse(decisions[0].context)).toMatchObject({ capacity: 2, minutesToSellOut: 5 });

    // The owner is told through the same HubSpot task channel as every other decision.
    const task = await BASE_ENV.DB.prepare(
      `SELECT payload FROM outbox WHERE portal_id = ?1 AND topic = 'notify.owner_task' LIMIT 1`,
    )
      .bind(values.portalId)
      .first<{ payload: string }>();
    expect(JSON.parse(task?.payload ?? '{}')).toMatchObject({
      type: 'fast_sellout',
      assignedOwnerId: 'owner-42',
    });
  });

  it('raises the decision at most once per event, even on a concurrent race', async () => {
    const values = await freshIds();
    const event = await seedEvent(values, { publishedMinutesAgo: 1 });
    await sellOut(values, 2);

    const results = await Promise.all([
      maybeFlagFastSellout(BASE_ENV, values.portalId, event),
      maybeFlagFastSellout(BASE_ENV, values.portalId, event),
      maybeFlagFastSellout(BASE_ENV, values.portalId, event),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await openDecisions(values.portalId, values.eventId)).toHaveLength(1);

    // And it stays raised-once after the owner has closed it.
    const [decision] = await openDecisions(values.portalId, values.eventId);
    expect(
      await resolveDecision(BASE_ENV, values.portalId, decision.id, {
        action: 'acknowledge',
        resolvedBy: 'owner-42',
      }),
    ).toMatchObject({ ok: true });

    expect(await maybeFlagFastSellout(BASE_ENV, values.portalId, event)).toBe(false);
    expect(await openDecisions(values.portalId, values.eventId)).toHaveLength(1);
  });

  it('stays quiet for a sell-out outside the 30-minute window', async () => {
    const values = await freshIds();
    const event = await seedEvent(values, { publishedMinutesAgo: 120 });
    await sellOut(values, 2);

    expect(await maybeFlagFastSellout(BASE_ENV, values.portalId, event)).toBe(false);
    expect(await openDecisions(values.portalId, values.eventId)).toHaveLength(0);
  });

  it('stays quiet while seats remain', async () => {
    const values = await freshIds();
    const event = await seedEvent(values, { publishedMinutesAgo: 5, capacity: 10 });
    await sellOut(values, 10, 4); // 4 of 10 held — not sold out

    expect(await maybeFlagFastSellout(BASE_ENV, values.portalId, event)).toBe(false);
    expect(await openDecisions(values.portalId, values.eventId)).toHaveLength(0);
  });

  it('never fires for an explicitly uncapped event', async () => {
    const values = await freshIds();
    const event = await seedEvent(values, { publishedMinutesAgo: 5, unlimited: true });

    expect(await maybeFlagFastSellout(BASE_ENV, values.portalId, event)).toBe(false);
    expect(await openDecisions(values.portalId, values.eventId)).toHaveLength(0);
  });

  it('rejects a fast sell-out resolution that is not an acknowledgement', async () => {
    const values = await freshIds();
    const event = await seedEvent(values, { publishedMinutesAgo: 2 });
    await sellOut(values, 2);
    await maybeFlagFastSellout(BASE_ENV, values.portalId, event);
    const [decision] = await openDecisions(values.portalId, values.eventId);

    expect(
      await resolveDecision(BASE_ENV, values.portalId, decision.id, { action: 'honour' }),
    ).toMatchObject({ ok: false, error: 'invalid_action' });
  });
});
