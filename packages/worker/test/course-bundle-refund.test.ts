import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/types';

const mocks = vi.hoisted(() => ({
  loadCourseBundleComponents: vi.fn(),
  loadEvent: vi.fn(),
  loadOrderByInvoice: vi.fn(),
  resolveRefundPolicy: vi.fn(),
  computeRefund: vi.fn(),
  waitlistSnapshot: vi.fn(),
}));

vi.mock('../src/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/db')>()),
  loadCourseBundleComponents: mocks.loadCourseBundleComponents,
  loadEvent: mocks.loadEvent,
  loadOrderByInvoice: mocks.loadOrderByInvoice,
}));

vi.mock('../src/checkin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/checkin')>()),
  mintTicketForTenant: vi.fn(async () => 'signed-ticket'),
}));

vi.mock('../src/capacity-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/capacity-guard')>()),
  maybeFlagFastSellout: vi.fn(),
}));

vi.mock('../src/refund-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/refund-policy')>()),
  resolveRefundPolicy: mocks.resolveRefundPolicy,
  computeRefund: mocks.computeRefund,
}));

vi.mock('../src/waitlist', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/waitlist')>()),
  waitlistSnapshot: mocks.waitlistSnapshot,
}));

const { confirmPayment, executeRefund, honourOversell } = await import('../src/payment');

beforeEach(() => vi.clearAllMocks());

describe('complete-course package refund', () => {
  it('confirms every child module after a simulated paid parent invoice', async () => {
    const calls: Array<{ id: string; path: string; holdId: string }> = [];
    const statements: Array<{ sql: string }> = [];
    const order = {
      id: 'course-order-confirm',
      portal_id: 'portal',
      event_id: 'course-event',
      reservation_id: 'course-hold',
      status: 'pending',
      hubspot_invoice_id: 'invoice-confirm',
      member_company_id: null,
      voucher_seats_redeemed: 0,
      voucher_credit_cents: 0,
    };
    const parentEvent = {
      id: 'course-event',
      hubspot_event_id: 'hs-course',
      starts_at: '2026-10-01',
    };
    const moduleEvent = {
      id: 'module-event',
      hubspot_event_id: 'hs-module',
      starts_at: '2026-10-02',
    };
    mocks.loadOrderByInvoice.mockResolvedValue(order);
    mocks.loadEvent.mockImplementation(async (_db: unknown, _portal: string, id: string) =>
      id === 'course-event' ? parentEvent : id === 'module-event' ? moduleEvent : null,
    );
    mocks.loadCourseBundleComponents.mockResolvedValue([
      {
        id: 'component-confirm',
        portal_id: 'portal',
        order_id: order.id,
        event_id: 'module-event',
        reservation_id: 'module-hold',
        ticket_type_id: 'module-package-ticket',
        status: 'pending',
      },
    ]);
    const env = {
      DB: {
        prepare: (sql: string) => {
          const statement = {
            sql,
            bind: (..._params: unknown[]) => statement,
            all: async () => ({
              results: sql.includes('FROM registrations')
                ? [
                    {
                      id: 'course-registration',
                      ticket_type_id: 'course-ticket',
                      attendee_email: 'member@example.test',
                      attendee_name: 'Member',
                      hubspot_contact_id: 'contact-1',
                    },
                  ]
                : [],
            }),
          };
          return statement;
        },
        batch: async (batch: Array<{ sql: string }>) => {
          statements.push(...batch);
          return [];
        },
      },
      EVENT_CAPACITY: {
        idFromName: (id: string) => id,
        get: (id: string) => ({
          fetch: async (url: string, init: RequestInit) => {
            calls.push({
              id,
              path: new URL(url).pathname,
              holdId: (JSON.parse(String(init.body)) as { holdId: string }).holdId,
            });
            return Response.json({ ok: true });
          },
        }),
      },
      QUEUE: { sendBatch: async () => undefined },
    } as unknown as Env;

    await expect(
      confirmPayment(env, {
        kind: 'confirm_payment',
        portalId: 'portal',
        hsInvoiceId: 'invoice-confirm',
      }),
    ).resolves.toEqual({ oversold: false });
    expect(calls).toEqual([
      { id: 'portal:hs-course', path: '/confirm', holdId: 'course-hold' },
      { id: 'portal:hs-module', path: '/confirm', holdId: 'module-hold' },
    ]);
    expect(statements.some((statement) => statement.sql.includes("SET status = 'confirmed'"))).toBe(
      true,
    );
    expect(
      statements.filter((statement) => statement.sql.includes('INSERT INTO registrations')),
    ).toHaveLength(1);
  });

  it('confirms each module for every attendee on the booking, not for one', async () => {
    // The module hold is taken for the whole party and the confirmation clones every
    // attendee into it, so the number asked of the module's Durable Object has to be the
    // party size. The DO refuses a live hold whose items do not match, so getting this
    // wrong is not a rounding error — it either oversells or fails to confirm.
    const bodies: Array<{ id: string; items?: Array<{ quantity: number }> }> = [];
    const statements: Array<{ sql: string }> = [];
    const order = {
      id: 'course-order-party',
      portal_id: 'portal',
      event_id: 'course-event',
      reservation_id: 'course-hold',
      status: 'pending',
      hubspot_invoice_id: 'invoice-party',
      member_company_id: null,
      voucher_seats_redeemed: 0,
      voucher_credit_cents: 0,
    };
    mocks.loadOrderByInvoice.mockResolvedValue(order);
    mocks.loadEvent.mockImplementation(async (_db: unknown, _portal: string, id: string) =>
      id === 'course-event'
        ? { id: 'course-event', hubspot_event_id: 'hs-course', starts_at: '2026-10-01' }
        : id === 'module-event'
          ? { id: 'module-event', hubspot_event_id: 'hs-module', starts_at: '2026-10-02' }
          : null,
    );
    mocks.loadCourseBundleComponents.mockResolvedValue([
      {
        id: 'component-party',
        portal_id: 'portal',
        order_id: order.id,
        event_id: 'module-event',
        reservation_id: 'module-hold',
        ticket_type_id: 'module-package-ticket',
        seats: 3,
        status: 'pending',
      },
    ]);
    const attendees = ['one', 'two', 'three'].map((n) => ({
      id: `course-registration-${n}`,
      ticket_type_id: 'course-ticket',
      attendee_email: `${n}@example.test`,
      attendee_name: n,
      hubspot_contact_id: null,
    }));
    const env = {
      DB: {
        prepare: (sql: string) => {
          const statement = {
            sql,
            bind: (..._params: unknown[]) => statement,
            all: async () => ({ results: sql.includes('FROM registrations') ? attendees : [] }),
          };
          return statement;
        },
        batch: async (batch: Array<{ sql: string }>) => {
          statements.push(...batch);
          return [];
        },
      },
      EVENT_CAPACITY: {
        idFromName: (id: string) => id,
        get: (id: string) => ({
          fetch: async (_url: string, init: RequestInit) => {
            bodies.push({
              id,
              ...(JSON.parse(String(init.body)) as { items?: Array<{ quantity: number }> }),
            });
            return Response.json({ ok: true });
          },
        }),
      },
      QUEUE: { sendBatch: async () => undefined },
    } as unknown as Env;

    await expect(
      confirmPayment(env, {
        kind: 'confirm_payment',
        portalId: 'portal',
        hsInvoiceId: 'invoice-party',
      }),
    ).resolves.toEqual({ oversold: false });

    const moduleCall = bodies.find((body) => body.id === 'portal:hs-module');
    expect(moduleCall).toBeDefined();
    // biome-ignore lint/suspicious/noExplicitAny: DO payload asserted directly
    expect((moduleCall as any).orderItems).toEqual([
      { ticketTypeId: 'module-package-ticket', quantity: 3 },
    ]);
    // Three module seats written, matching the three the DO was asked for.
    expect(
      statements.filter((statement) => statement.sql.includes('INSERT INTO registrations')),
    ).toHaveLength(3);
  });

  it('takes the missing module seats for a package booked before the seat count existed', async () => {
    // A pre-0036 booking holds one module seat however many people are on it, and those
    // bookings are still out there awaiting payment. Confirming such a hold as it stands
    // would enrol three people against one seat — the oversell 0036 exists to stop.
    const calls: Array<{ id: string; holdId: string; items?: Array<{ quantity: number }> }> = [];
    const statements: Array<{ sql: string }> = [];
    const order = {
      id: 'course-order-legacy',
      portal_id: 'portal',
      event_id: 'course-event',
      reservation_id: 'course-hold',
      status: 'pending',
      hubspot_invoice_id: 'invoice-legacy',
      member_company_id: null,
      voucher_seats_redeemed: 0,
      voucher_credit_cents: 0,
    };
    mocks.loadOrderByInvoice.mockResolvedValue(order);
    mocks.loadEvent.mockImplementation(async (_db: unknown, _portal: string, id: string) =>
      id === 'course-event'
        ? { id: 'course-event', hubspot_event_id: 'hs-course', starts_at: '2026-10-01' }
        : id === 'module-event'
          ? { id: 'module-event', hubspot_event_id: 'hs-module', starts_at: '2026-10-02' }
          : null,
    );
    // seats absent entirely: the column defaulted to 1 when the migration ran.
    mocks.loadCourseBundleComponents.mockResolvedValue([
      {
        id: 'component-legacy',
        portal_id: 'portal',
        order_id: order.id,
        event_id: 'module-event',
        reservation_id: 'module-hold',
        ticket_type_id: 'module-package-ticket',
        status: 'pending',
      },
    ]);
    const attendees = ['one', 'two', 'three'].map((n) => ({
      id: `course-registration-${n}`,
      ticket_type_id: 'course-ticket',
      attendee_email: `${n}@example.test`,
      attendee_name: n,
      hubspot_contact_id: null,
    }));
    const env = {
      DB: {
        prepare: (sql: string) => {
          const statement = {
            sql,
            bind: (..._params: unknown[]) => statement,
            all: async () => ({ results: sql.includes('FROM registrations') ? attendees : [] }),
          };
          return statement;
        },
        batch: async (batch: Array<{ sql: string }>) => {
          statements.push(...batch);
          return [];
        },
      },
      EVENT_CAPACITY: {
        idFromName: (id: string) => id,
        get: (id: string) => ({
          fetch: async (_url: string, init: RequestInit) => {
            const body = JSON.parse(String(init.body)) as {
              holdId: string;
              orderItems?: Array<{ quantity: number }>;
            };
            calls.push({ id, holdId: body.holdId, items: body.orderItems });
            return Response.json({ ok: true });
          },
        }),
      },
      QUEUE: { sendBatch: async () => undefined },
    } as unknown as Env;

    await expect(
      confirmPayment(env, {
        kind: 'confirm_payment',
        portalId: 'portal',
        hsInvoiceId: 'invoice-legacy',
      }),
    ).resolves.toEqual({ oversold: false });

    const moduleCalls = calls.filter((call) => call.id === 'portal:hs-module');
    // The hold it actually has, committed as it stands — the DO refuses a mismatch.
    expect(moduleCalls[0]).toMatchObject({
      holdId: 'module-hold',
      items: [{ ticketTypeId: 'module-package-ticket', quantity: 1 }],
    });
    // Then the two it is short, on a derived id so a replay is idempotent.
    expect(moduleCalls[1]).toMatchObject({
      holdId: 'component-legacy:seats',
      items: [{ ticketTypeId: 'module-package-ticket', quantity: 2 }],
    });
    // And the row is corrected, so a later refund gives back all three.
    expect(statements.some((statement) => statement.sql.includes('SET seats = ?1'))).toBe(true);
  });

  it('sends the order to review when a short module cannot find the missing seats', async () => {
    // Refusing is the right answer: the worker never auto-resolves an oversell, so the
    // order goes to needs_review and an owner decides (Phase 18.3).
    const order = {
      id: 'course-order-short',
      portal_id: 'portal',
      event_id: 'course-event',
      reservation_id: 'course-hold',
      status: 'pending',
      hubspot_invoice_id: 'invoice-short',
      member_company_id: null,
      voucher_seats_redeemed: 0,
      voucher_credit_cents: 0,
    };
    mocks.loadOrderByInvoice.mockResolvedValue(order);
    mocks.loadEvent.mockImplementation(async (_db: unknown, _portal: string, id: string) =>
      id === 'course-event'
        ? { id: 'course-event', hubspot_event_id: 'hs-course', starts_at: '2026-10-01' }
        : id === 'module-event'
          ? { id: 'module-event', hubspot_event_id: 'hs-module', starts_at: '2026-10-02' }
          : null,
    );
    mocks.loadCourseBundleComponents.mockResolvedValue([
      {
        id: 'component-short',
        portal_id: 'portal',
        order_id: order.id,
        event_id: 'module-event',
        reservation_id: 'module-hold',
        ticket_type_id: 'module-package-ticket',
        seats: 1,
        status: 'pending',
      },
    ]);
    const attendees = ['one', 'two'].map((n) => ({
      id: `course-registration-${n}`,
      ticket_type_id: 'course-ticket',
      attendee_email: `${n}@example.test`,
      attendee_name: n,
      hubspot_contact_id: null,
    }));
    const cancelled: string[] = [];
    const env = {
      DB: {
        prepare: (sql: string) => {
          const statement = {
            sql,
            bind: (..._params: unknown[]) => statement,
            all: async () => ({ results: sql.includes('FROM registrations') ? attendees : [] }),
          };
          return statement;
        },
        batch: async () => [],
      },
      EVENT_CAPACITY: {
        idFromName: (id: string) => id,
        get: (id: string) => ({
          fetch: async (url: string, init: RequestInit) => {
            const path = new URL(url).pathname;
            const body = JSON.parse(String(init.body)) as { holdId: string };
            if (path === '/cancel-seats') {
              cancelled.push(body.holdId);
              return Response.json({ ok: true });
            }
            // The module is full: the seats it does not hold, it cannot have.
            if (id === 'portal:hs-module' && body.holdId.endsWith(':seats')) {
              return Response.json({ ok: false, reason: 'expired_and_oversold' });
            }
            return Response.json({ ok: true });
          },
        }),
      },
      QUEUE: { sendBatch: async () => undefined },
    } as unknown as Env;

    await expect(
      confirmPayment(env, {
        kind: 'confirm_payment',
        portalId: 'portal',
        hsInvoiceId: 'invoice-short',
      }),
    ).resolves.toEqual({ oversold: true });
    // Nothing is left committed on the way out — the parent and the module hold it did take.
    expect(cancelled).toContain('course-hold');
    expect(cancelled).toContain('module-hold');
  });

  it('enrols the modules when an oversold course package is HONOURed', async () => {
    // Honour used to mark the parent paid and issue parent tickets only, leaving every
    // module reservation pending and no module registration written: the buyer had paid
    // for a complete course and was enrolled in none of it.
    const calls: Array<{ id: string; force: boolean }> = [];
    const statements: Array<{ sql: string }> = [];
    const order = {
      id: 'course-order-honour',
      portal_id: 'portal',
      event_id: 'course-event',
      reservation_id: 'course-hold',
      status: 'needs_review',
      hubspot_invoice_id: 'invoice-honour',
      member_company_id: null,
      voucher_seats_redeemed: 0,
      voucher_credit_cents: 0,
    };
    mocks.loadEvent.mockImplementation(async (_db: unknown, _portal: string, id: string) =>
      id === 'course-event'
        ? { id: 'course-event', hubspot_event_id: 'hs-course', starts_at: '2026-10-01' }
        : id === 'module-event'
          ? { id: 'module-event', hubspot_event_id: 'hs-module', starts_at: '2026-10-02' }
          : null,
    );
    mocks.loadCourseBundleComponents.mockResolvedValue([
      {
        id: 'component-honour',
        portal_id: 'portal',
        order_id: order.id,
        event_id: 'module-event',
        reservation_id: 'module-hold',
        ticket_type_id: 'module-package-ticket',
        seats: 1,
        status: 'pending',
      },
    ]);
    const env = {
      DB: {
        prepare: (sql: string) => {
          const statement = {
            sql,
            bind: (..._params: unknown[]) => statement,
            first: async () => (sql.includes('FROM orders') ? order : null),
            all: async () => ({
              results: sql.includes('FROM registrations')
                ? [
                    {
                      id: 'course-registration',
                      event_id: 'course-event',
                      ticket_type_id: 'course-ticket',
                      attendee_email: 'member@example.test',
                      attendee_name: 'Member',
                      hubspot_contact_id: 'contact-1',
                    },
                  ]
                : [],
            }),
          };
          return statement;
        },
        batch: async (batch: Array<{ sql: string }>) => {
          statements.push(...batch);
          return [];
        },
      },
      EVENT_CAPACITY: {
        idFromName: (id: string) => id,
        get: (id: string) => ({
          fetch: async (_url: string, init: RequestInit) => {
            const body = JSON.parse(String(init.body)) as { force?: boolean };
            calls.push({ id, force: body.force === true });
            return Response.json({ ok: true });
          },
        }),
      },
      QUEUE: { sendBatch: async () => undefined },
    } as unknown as Env;

    await honourOversell(env, 'portal', order.id);

    // Both the parent and the module are force-confirmed: the owner has decided to breach
    // the capacity, and that decision covers the course the seat is part of.
    expect(calls).toEqual([
      { id: 'portal:hs-course', force: true },
      { id: 'portal:hs-module', force: true },
    ]);
    expect(
      statements.some((statement) => statement.sql.includes('UPDATE course_bundle_components')),
    ).toBe(true);
    expect(
      statements.filter((statement) => statement.sql.includes('INSERT INTO registrations')),
    ).toHaveLength(1);
  });

  it('confirms selected modules without a parent course hold', async () => {
    const calls: Array<{ id: string; path: string; holdId: string }> = [];
    const statements: Array<{ sql: string }> = [];
    const order = {
      id: 'selected-module-order',
      portal_id: 'portal',
      event_id: 'course-event',
      reservation_id: null,
      status: 'pending',
      hubspot_invoice_id: 'invoice-selected',
      member_company_id: null,
      voucher_seats_redeemed: 0,
      voucher_credit_cents: 0,
    };
    const parentEvent = {
      id: 'course-event',
      hubspot_event_id: 'hs-course',
      starts_at: '2026-10-01',
    };
    const firstModule = {
      id: 'module-one',
      hubspot_event_id: 'hs-module-one',
      starts_at: '2026-10-02',
    };
    const secondModule = {
      id: 'module-two',
      hubspot_event_id: 'hs-module-two',
      starts_at: '2026-10-03',
    };
    mocks.loadOrderByInvoice.mockResolvedValue(order);
    mocks.loadEvent.mockImplementation(async (_db: unknown, _portal: string, id: string) =>
      id === 'course-event'
        ? parentEvent
        : id === 'module-one'
          ? firstModule
          : id === 'module-two'
            ? secondModule
            : null,
    );
    mocks.loadCourseBundleComponents.mockResolvedValue([
      {
        id: 'component-one',
        portal_id: 'portal',
        order_id: order.id,
        event_id: 'module-one',
        reservation_id: 'module-hold-one',
        ticket_type_id: 'module-one-ticket',
        status: 'pending',
      },
      {
        id: 'component-two',
        portal_id: 'portal',
        order_id: order.id,
        event_id: 'module-two',
        reservation_id: 'module-hold-two',
        ticket_type_id: 'module-two-ticket',
        status: 'pending',
      },
    ]);
    const env = {
      DB: {
        prepare: (sql: string) => {
          const statement = {
            sql,
            bind: (..._params: unknown[]) => statement,
            all: async () => ({
              results: sql.includes('FROM registrations')
                ? [
                    {
                      id: 'module-registration-one',
                      event_id: 'module-one',
                      ticket_type_id: 'module-one-ticket',
                      attendee_email: 'member@example.test',
                      attendee_name: 'Member',
                      hubspot_contact_id: 'contact-1',
                    },
                    {
                      id: 'module-registration-two',
                      event_id: 'module-two',
                      ticket_type_id: 'module-two-ticket',
                      attendee_email: 'member@example.test',
                      attendee_name: 'Member',
                      hubspot_contact_id: 'contact-1',
                    },
                  ]
                : [],
            }),
          };
          return statement;
        },
        batch: async (batch: Array<{ sql: string }>) => {
          statements.push(...batch);
          return [];
        },
      },
      EVENT_CAPACITY: {
        idFromName: (id: string) => id,
        get: (id: string) => ({
          fetch: async (url: string, init: RequestInit) => {
            calls.push({
              id,
              path: new URL(url).pathname,
              holdId: (JSON.parse(String(init.body)) as { holdId: string }).holdId,
            });
            return Response.json({ ok: true });
          },
        }),
      },
      QUEUE: { sendBatch: async () => undefined },
    } as unknown as Env;

    await expect(
      confirmPayment(env, {
        kind: 'confirm_payment',
        portalId: 'portal',
        hsInvoiceId: 'invoice-selected',
      }),
    ).resolves.toEqual({ oversold: false });
    expect(calls).toEqual([
      { id: 'portal:hs-module-one', path: '/confirm', holdId: 'module-hold-one' },
      { id: 'portal:hs-module-two', path: '/confirm', holdId: 'module-hold-two' },
    ]);
    expect(
      statements.filter((statement) => statement.sql.includes('INSERT INTO tickets')),
    ).toHaveLength(2);
    expect(
      statements.some((statement) => statement.sql.includes('UPDATE course_bundle_components')),
    ).toBe(true);
  });

  it('issues the module tickets when an oversold selected-module order is HONOURed', async () => {
    // A selected-module order's attendees are registered against the modules, not the
    // parent course. Honouring it off the parent-only registration list would mark the
    // order paid and issue nobody a ticket for the modules they just bought.
    const calls: Array<{ id: string; force: boolean }> = [];
    const statements: Array<{ sql: string }> = [];
    const order = {
      id: 'selected-module-review',
      portal_id: 'portal',
      event_id: 'course-event',
      reservation_id: null,
      status: 'needs_review',
      hubspot_invoice_id: 'invoice-review',
      member_company_id: null,
      voucher_seats_redeemed: 0,
      voucher_credit_cents: 0,
    };
    mocks.loadEvent.mockImplementation(async (_db: unknown, _portal: string, id: string) =>
      id === 'course-event'
        ? { id: 'course-event', hubspot_event_id: 'hs-course', starts_at: '2026-10-01' }
        : id === 'module-one'
          ? { id: 'module-one', hubspot_event_id: 'hs-module-one', starts_at: '2026-10-02' }
          : null,
    );
    mocks.loadCourseBundleComponents.mockResolvedValue([
      {
        id: 'component-one',
        portal_id: 'portal',
        order_id: order.id,
        event_id: 'module-one',
        reservation_id: 'module-hold-one',
        ticket_type_id: 'module-one-ticket',
        status: 'pending',
      },
    ]);
    const env = {
      DB: {
        prepare: (sql: string) => {
          const statement = {
            sql,
            bind: (..._params: unknown[]) => statement,
            first: async () => (sql.includes('FROM orders') ? order : null),
            all: async () => ({
              results: sql.includes('FROM registrations')
                ? [
                    {
                      id: 'module-registration-one',
                      event_id: 'module-one',
                      ticket_type_id: 'module-one-ticket',
                      attendee_email: 'member@example.test',
                      attendee_name: 'Member',
                      hubspot_contact_id: 'contact-1',
                    },
                  ]
                : [],
            }),
          };
          return statement;
        },
        batch: async (batch: Array<{ sql: string }>) => {
          statements.push(...batch);
          return [];
        },
      },
      EVENT_CAPACITY: {
        idFromName: (id: string) => id,
        get: (id: string) => ({
          fetch: async (_url: string, init: RequestInit) => {
            calls.push({
              id,
              force: (JSON.parse(String(init.body)) as { force?: boolean }).force === true,
            });
            return Response.json({ ok: true });
          },
        }),
      },
      QUEUE: { sendBatch: async () => undefined },
    } as unknown as Env;

    await honourOversell(env, 'portal', order.id);

    // The parent course holds nothing, so it is never asked to commit; only the module is.
    expect(calls).toEqual([{ id: 'portal:hs-module-one', force: true }]);
    expect(
      statements.filter((statement) => statement.sql.includes('INSERT INTO tickets')),
    ).toHaveLength(1);
    // The module rows already exist — honouring must not clone a second set.
    expect(
      statements.filter((statement) => statement.sql.includes('INSERT INTO registrations')),
    ).toHaveLength(0);
  });

  it('returns parent and module capacity and cancels all linked records', async () => {
    const capacityCalls: Array<{ id: string; path: string; holdId: string }> = [];
    const statements: Array<{ sql: string }> = [];
    const order = {
      id: 'course-order',
      portal_id: 'portal',
      event_id: 'course-event',
      reservation_id: 'course-hold',
      status: 'paid',
      total_cents: 100_000,
      refunded_cents: 0,
      hubspot_invoice_id: 'invoice-1',
    };
    const parentEvent = {
      id: 'course-event',
      hubspot_event_id: 'hs-course',
      starts_at: '2026-10-01',
    };
    const moduleEvent = {
      id: 'module-event',
      hubspot_event_id: 'hs-module',
      starts_at: '2026-10-02',
    };
    mocks.loadEvent.mockImplementation(async (_db: unknown, _portal: string, id: string) =>
      id === 'course-event' ? parentEvent : id === 'module-event' ? moduleEvent : null,
    );
    mocks.loadCourseBundleComponents.mockResolvedValue([
      {
        id: 'component-1',
        portal_id: 'portal',
        order_id: 'course-order',
        event_id: 'module-event',
        reservation_id: 'module-hold',
        ticket_type_id: 'module-package-ticket',
        status: 'confirmed',
      },
    ]);
    mocks.resolveRefundPolicy.mockResolvedValue({ id: null });
    mocks.computeRefund.mockReturnValue({ kind: 'full', amountCents: 100_000 });
    mocks.waitlistSnapshot.mockResolvedValue([]);

    const env = {
      DB: {
        prepare: (sql: string) => {
          const statement = {
            sql,
            bind: (..._params: unknown[]) => statement,
            first: async () => (sql.includes('SELECT * FROM orders') ? order : null),
            all: async () => ({
              results: sql.includes('FROM registrations')
                ? [
                    {
                      id: 'course-registration',
                      event_id: 'course-event',
                      ticket_type_id: 'course-ticket',
                      attendee_email: 'member@example.test',
                      hubspot_contact_id: 'contact-1',
                    },
                    {
                      id: 'module-registration',
                      event_id: 'module-event',
                      ticket_type_id: 'module-package-ticket',
                      attendee_email: 'member@example.test',
                      hubspot_contact_id: 'contact-1',
                    },
                  ]
                : [],
            }),
          };
          return statement;
        },
        batch: async (batch: Array<{ sql: string }>) => {
          statements.push(...batch);
          return [];
        },
      },
      EVENT_CAPACITY: {
        idFromName: (id: string) => id,
        get: (id: string) => ({
          fetch: async (url: string, init: RequestInit) => {
            const body = JSON.parse(String(init.body)) as { holdId: string };
            capacityCalls.push({ id, path: new URL(url).pathname, holdId: body.holdId });
            return Response.json({ ok: true });
          },
        }),
      },
      QUEUE: { sendBatch: async () => undefined },
    } as unknown as Env;

    await expect(executeRefund(env, 'portal', 'course-order')).resolves.toMatchObject({
      status: 'refunded',
    });

    expect(capacityCalls).toEqual([
      { id: 'portal:hs-course', path: '/refund', holdId: 'course-hold' },
      { id: 'portal:hs-module', path: '/refund', holdId: 'module-hold' },
    ]);
    expect(
      statements.some((statement) => statement.sql.includes('UPDATE course_bundle_components')),
    ).toBe(true);
    expect(statements.some((statement) => statement.sql.includes('SET cancelled_at'))).toBe(true);
  });
});

describe('a component cancelled before payment', () => {
  it('is not re-confirmed when the invoice is later paid', async () => {
    const calls: Array<{ id: string; path: string; holdId: string }> = [];
    const statements: Array<{ sql: string }> = [];
    const order = {
      id: 'order-partly-cancelled',
      portal_id: 'portal',
      event_id: 'course-event',
      // NULL reservation_id plus components is what marks a selected-module order.
      reservation_id: null,
      status: 'pending',
      hubspot_invoice_id: 'invoice-partly-cancelled',
      member_company_id: null,
      voucher_seats_redeemed: 0,
      voucher_credit_cents: 0,
    };
    const parentEvent = {
      id: 'course-event',
      hubspot_event_id: 'hs-course',
      starts_at: '2026-10-01',
    };
    const liveModule = {
      id: 'module-live',
      hubspot_event_id: 'hs-module-live',
      starts_at: '2026-10-02',
    };
    const cancelledModule = {
      id: 'module-cancelled',
      hubspot_event_id: 'hs-module-cancelled',
      starts_at: '2026-10-03',
    };
    mocks.loadOrderByInvoice.mockResolvedValue(order);
    mocks.loadEvent.mockImplementation(async (_db: unknown, _portal: string, id: string) =>
      id === 'course-event'
        ? parentEvent
        : id === 'module-live'
          ? liveModule
          : id === 'module-cancelled'
            ? cancelledModule
            : null,
    );
    // One module cancelled out of a two-module booking. Cancelling a single seat leaves the
    // order `pending` for the module still being attended, so payment still arrives.
    mocks.loadCourseBundleComponents.mockResolvedValue([
      {
        id: 'component-live',
        portal_id: 'portal',
        order_id: order.id,
        event_id: 'module-live',
        reservation_id: 'hold-live',
        ticket_type_id: 'ticket-live',
        seats: 1,
        status: 'pending',
      },
      {
        id: 'component-cancelled',
        portal_id: 'portal',
        order_id: order.id,
        event_id: 'module-cancelled',
        reservation_id: 'hold-cancelled',
        ticket_type_id: 'ticket-cancelled',
        seats: 1,
        status: 'cancelled',
      },
    ]);

    const env = {
      DB: {
        prepare: (sql: string) => {
          const statement = {
            sql,
            bind: (..._params: unknown[]) => statement,
            all: async () => ({
              results: sql.includes('FROM registrations')
                ? [
                    {
                      id: 'registration-live',
                      event_id: 'module-live',
                      ticket_type_id: 'ticket-live',
                      attendee_email: 'member@example.test',
                      attendee_name: 'Member',
                      hubspot_contact_id: 'contact-1',
                    },
                  ]
                : [],
            }),
          };
          return statement;
        },
        batch: async (batch: Array<{ sql: string }>) => {
          statements.push(...batch);
          return [];
        },
      },
      EVENT_CAPACITY: {
        idFromName: (id: string) => id,
        get: (id: string) => ({
          fetch: async (url: string, init: RequestInit) => {
            calls.push({
              id,
              path: new URL(url).pathname,
              holdId: (JSON.parse(String(init.body)) as { holdId: string }).holdId,
            });
            return Response.json({ ok: true });
          },
        }),
      },
      QUEUE: { sendBatch: async () => undefined },
    } as unknown as Env;

    await expect(
      confirmPayment(env, {
        kind: 'confirm_payment',
        portalId: 'portal',
        hsInvoiceId: 'invoice-partly-cancelled',
      }),
    ).resolves.toEqual({ oversold: false });

    // The live module is confirmed. The cancelled one is not touched at all: its hold was
    // already released, so confirming it would either commit a seat nobody is attending or
    // — if that seat has since sold — report a false oversell and send a paid booking to
    // needs_review.
    expect(calls).toEqual([{ id: 'portal:hs-module-live', path: '/confirm', holdId: 'hold-live' }]);
    expect(calls.some((call) => call.holdId === 'hold-cancelled')).toBe(false);

    // And its rows are not written back to confirmed.
    const sql = statements.map((statement) => statement.sql).join('\n');
    expect(sql).not.toContain('component-cancelled');
  });
});
