import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  buildCourseBundleConfiguration,
  courseBundleHoldStatements,
  holdCourseBundle,
  holdCourseModuleSelection,
  persistCourseBundle,
} from '../src/course-bundle';
import type { EventRow, TicketTypeRow } from '../src/db';
import { handleReserveCoursePackage } from '../src/routes/reserve';
import type { Env } from '../src/types';

function event(id: string): EventRow {
  return {
    id,
    portal_id: 'portal',
    hubspot_event_id: `hs-${id}`,
    hubspot_marketing_event_object_id: null,
    title: id,
    starts_at: '2026-10-01T00:00:00.000Z',
    ends_at: '2026-10-01T01:00:00.000Z',
    location: null,
    capacity: 20,
    capacity_unlimited: 0,
    booking_kind: 'course',
    parent_event_id: 'parent-course',
    course_component_kind: 'module',
    course_component_order: 1,
    course_module_product_id: `product-${id}`,
    course_package_required: 1,
    provider: null,
    allow_oversell: 0,
    marketing_event_completed: 0,
    teams_webinar_id: null,
    teams_session_id: null,
    teams_join_url: null,
    refund_policy_id: null,
    category: null,
    invoice_due_days: null,
    hubspot_owner_id: null,
    first_published_at: null,
    created_at: '',
    updated_at: '',
  };
}

function packageTicket(eventId: string): TicketTypeRow {
  return {
    id: `ticket-${eventId}`,
    portal_id: 'portal',
    event_id: eventId,
    name: 'Included in course package',
    price_cents: 0,
    currency: 'AUD',
    capacity: 20,
    capacity_unlimited: 0,
    tax_treatment: 'gst_free',
    member_only: 0,
    hs_tax_rate_id: null,
    hs_product_id: null,
    internal_only: 1,
    sort_order: 0,
    created_at: '',
  };
}

function publicTicket(eventId: string): TicketTypeRow {
  return {
    ...packageTicket(eventId),
    id: `public-ticket-${eventId}`,
    name: 'Member module ticket',
    price_cents: 125_000,
    tax_treatment: 'taxable',
    internal_only: 0,
  };
}

function fakeEnv(
  failEventId: string | null,
  calls: Array<{ eventId: string; path: string; body?: Record<string, unknown> }>,
  batch: () => Promise<unknown> = async () => undefined,
): Env {
  return {
    DB: {
      prepare: () => ({ bind: () => ({}) }),
      batch,
    } as unknown as D1Database,
    EVENT_CAPACITY: {
      idFromName: (name: string) => name,
      get: (id: unknown) => {
        const eventId = String(id).split(':').at(-1)?.replace('hs-', '') ?? '';
        return {
          fetch: async (url: string, init?: RequestInit) => {
            const path = new URL(url).pathname;
            const body =
              typeof init?.body === 'string'
                ? (JSON.parse(init.body) as Record<string, unknown>)
                : undefined;
            calls.push({ eventId, path, body });
            if (path === '/reserve' && eventId === failEventId) {
              return Response.json({ ok: false, full: true }, { status: 409 });
            }
            if (path === '/reserve') {
              return Response.json({ ok: true, expiresAt: '2026-10-01T00:15:00.000Z' });
            }
            return Response.json({ ok: true });
          },
        } as unknown as DurableObjectStub;
      },
    },
  } as unknown as Env;
}

describe('holdCourseBundle', () => {
  it('rejects package checkout before any hold when required modules are not configured', async () => {
    const parent = event('parent-course');
    parent.parent_event_id = null;
    parent.course_component_kind = 'standalone';
    const app = new Hono<{ Bindings: Env }>();
    app.post('/events/:slug/reserve-course-package', handleReserveCoursePackage);
    const env = {
      DB: {
        prepare: (sql: string) => ({
          bind: () => ({
            first: async () => (sql.includes('idempotency_keys') ? null : parent),
            all: async () => ({ results: [] }),
          }),
        }),
      },
      KV: {
        get: async () => null,
        put: async () => undefined,
      },
    } as unknown as Env;

    const response = await app.request(
      '/events/parent-course/reserve-course-package',
      {
        method: 'POST',
        headers: { 'Idempotency-Key': 'bundle-test', 'X-Portal-Id': 'portal' },
      },
      env,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ status: 'course_package_not_configured' });
  });

  it('requires exactly one private zero-price ticket for every package module', () => {
    const required = event('module-one');
    const optional = event('practical');
    optional.course_package_required = 0;

    expect(
      buildCourseBundleConfiguration({
        components: [required, optional],
        ticketTypesByEvent: new Map([[required.id, [packageTicket(required.id)]]]),
      }),
    ).toMatchObject([
      { event: { id: required.id }, packageTicket: { id: `ticket-${required.id}` } },
    ]);

    expect(
      buildCourseBundleConfiguration({
        components: [required],
        ticketTypesByEvent: new Map([[required.id, []]]),
      }),
    ).toBeNull();
  });

  it('holds every required module when all child capacities are available', async () => {
    const calls: Array<{ eventId: string; path: string }> = [];
    const first = event('module-one');
    const second = event('module-two');

    const result = await holdCourseBundle({
      env: fakeEnv(null, calls),
      portalId: 'portal',
      seats: 1,
      components: [
        { event: first, packageTicket: packageTicket(first.id) },
        { event: second, packageTicket: packageTicket(second.id) },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      holds: [{ eventId: first.id }, { eventId: second.id }],
    });
    expect(calls.filter((call) => call.path === '/release')).toEqual([]);
  });

  it('holds selected public module tickets without requiring package tickets', async () => {
    const calls: Array<{ eventId: string; path: string }> = [];
    const first = event('module-one');
    const second = event('module-two');

    const result = await holdCourseModuleSelection({
      env: fakeEnv(null, calls),
      portalId: 'portal',
      components: [
        { event: first, ticketType: publicTicket(first.id), unitCents: 125_000 },
        { event: second, ticketType: publicTicket(second.id), unitCents: 125_000 },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      holds: [
        { eventId: first.id, ticketTypeId: `public-ticket-${first.id}`, unitCents: 125_000 },
        { eventId: second.id, ticketTypeId: `public-ticket-${second.id}`, unitCents: 125_000 },
      ],
    });
    expect(calls.filter((call) => call.path === '/reserve')).toHaveLength(2);
    expect(calls.filter((call) => call.path === '/release')).toEqual([]);
  });

  it('holds one module seat per attendee, not one per booking', async () => {
    // The bug this exists for: payment confirmation clones EVERY parent attendee into every
    // module, so a hold of one under a booking of four oversold each module by three the
    // instant it confirmed — and the Durable Object was not wrong, it was asked for one.
    const calls: Array<{ eventId: string; path: string; body?: Record<string, unknown> }> = [];
    const first = event('module-one');
    const second = event('module-two');

    const result = await holdCourseBundle({
      env: fakeEnv(null, calls),
      portalId: 'portal',
      seats: 4,
      components: [
        { event: first, packageTicket: packageTicket(first.id) },
        { event: second, packageTicket: packageTicket(second.id) },
      ],
    });

    expect(result.ok).toBe(true);
    for (const call of calls.filter((entry) => entry.path === '/reserve')) {
      expect(call.body?.items).toEqual([{ ticketTypeId: `ticket-${call.eventId}`, quantity: 4 }]);
    }
    if (!result.ok) throw new Error('unreachable');
    expect(result.holds.map((hold) => hold.quantity)).toEqual([4, 4]);
  });

  it('records the module seat count on the durable rows, so confirmation asks for the same number', () => {
    // The DO refuses to commit a live hold against mismatched items, so the number written
    // here and the number the hold was taken with have to be one number.
    const bound: unknown[][] = [];
    const env = {
      DB: {
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => {
            bound.push([sql, ...args]);
            return {};
          },
        }),
      },
    } as unknown as Env;

    courseBundleHoldStatements({
      env,
      portalId: 'portal',
      orderId: 'order-1',
      holds: [
        {
          eventId: 'module-one',
          ticketTypeId: 'ticket-module-one',
          reservationId: 'resv-1',
          quantity: 3,
          expiresAt: '2026-10-01T00:15:00.000Z',
        },
      ],
      createdAt: '2026-09-01T00:00:00.000Z',
    });

    const items = bound.find(([sql]) => String(sql).includes('INSERT INTO reservation_items'));
    expect(items).toContain(3);
    const components = bound.find(([sql]) =>
      String(sql).includes('INSERT INTO course_bundle_components'),
    );
    expect(components).toContain(3);
  });

  it('refuses a package hold for a booking with no attendees rather than holding zero seats', async () => {
    const calls: Array<{ eventId: string; path: string }> = [];
    const first = event('module-one');

    const result = await holdCourseBundle({
      env: fakeEnv(null, calls),
      portalId: 'portal',
      seats: 0,
      components: [{ event: first, packageTicket: packageTicket(first.id) }],
    });

    expect(result).toEqual({ ok: false, status: 'course_component_not_configured' });
    expect(calls).toEqual([]);
  });

  it('releases earlier holds when a later module is full', async () => {
    const calls: Array<{ eventId: string; path: string }> = [];
    const first = event('module-one');
    const second = event('module-two');

    const result = await holdCourseBundle({
      env: fakeEnv(second.id, calls),
      portalId: 'portal',
      seats: 1,
      components: [
        { event: first, packageTicket: packageTicket(first.id) },
        { event: second, packageTicket: packageTicket(second.id) },
      ],
    });

    expect(result).toEqual({ ok: false, status: 'course_component_full' });
    expect(calls.some((call) => call.eventId === first.id && call.path === '/release')).toBe(true);
  });

  it('releases every hold when the parent order batch fails', async () => {
    const calls: Array<{ eventId: string; path: string }> = [];
    const first = event('module-one');
    const second = event('module-two');
    const env = fakeEnv(null, calls, async () => {
      throw new Error('D1 unavailable');
    });
    const held = await holdCourseBundle({
      env,
      portalId: 'portal',
      seats: 1,
      components: [
        { event: first, packageTicket: packageTicket(first.id) },
        { event: second, packageTicket: packageTicket(second.id) },
      ],
    });
    expect(held.ok).toBe(true);
    if (!held.ok) return;

    const persisted = await persistCourseBundle({
      env,
      portalId: 'portal',
      orderId: 'course-order',
      holds: held.holds,
      createdAt: '2026-10-01T00:00:00.000Z',
      parentStatements: [],
    });

    expect(persisted).toBe(false);
    expect(calls.filter((call) => call.path === '/release')).toHaveLength(2);
  });
});
