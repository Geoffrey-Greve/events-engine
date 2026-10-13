import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleGetOrder } from '../src/routes/reserve';
import type { Env } from '../src/types';

const mocks = vi.hoisted(() => ({
  createWaitlistDecision: vi.fn(),
  loadEvent: vi.fn(),
  loadOrderByInvoice: vi.fn(),
  waitlistSnapshot: vi.fn(),
}));

// Every mock below spreads the real module first, then overrides only what this file
// needs to control. A mock factory that returns a bare object REPLACES the module for the
// whole run — the suite shares one worker, so a later file resolving an export this file
// did not list gets "No export is defined on the mock" and dies. It surfaced as
// MeetProvider failing roughly one run in six, because whether it happens at all depends
// on the order modules happen to load in.
vi.mock('../src/checkin', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/checkin')>()),
  mintTicketForTenant: vi.fn(),
}));

vi.mock('../src/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/db')>()),
  loadEvent: mocks.loadEvent,
  loadOrderByInvoice: mocks.loadOrderByInvoice,
  loadTicketTypes: vi.fn(),
}));

vi.mock('../src/decisions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/decisions')>()),
  createOversellDecision: vi.fn(),
  createWaitlistDecision: mocks.createWaitlistDecision,
}));

vi.mock('../src/refund-policy', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/refund-policy')>()),
  computeRefund: vi.fn(),
  resolveRefundPolicy: vi.fn(),
}));

vi.mock('../src/waitlist', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/waitlist')>()),
  waitlistSnapshot: mocks.waitlistSnapshot,
}));

const { expireHold } = await import('../src/expire');
const { confirmPayment } = await import('../src/payment');

beforeEach(() => {
  vi.clearAllMocks();
});

interface FakeStatement {
  sql: string;
  params: unknown[];
  bind: (...params: unknown[]) => FakeStatement;
  all: () => Promise<{ results: unknown[] }>;
  first: () => Promise<unknown>;
  run: () => Promise<{ success: true; meta: { changes: number } }>;
}

function makeStatement(
  sql: string,
  handlers: {
    all?: (sql: string, params: unknown[]) => Promise<{ results: unknown[] }>;
    first?: (sql: string, params: unknown[]) => Promise<unknown>;
  },
): FakeStatement {
  const stmt: FakeStatement = {
    sql,
    params: [],
    bind: (...params: unknown[]) => {
      stmt.params = params;
      return stmt;
    },
    all: () => handlers.all?.(sql, stmt.params) ?? Promise.resolve({ results: [] }),
    first: () => handlers.first?.(sql, stmt.params) ?? Promise.resolve(null),
    run: () => Promise.resolve({ success: true, meta: { changes: 1 } }),
  };
  return stmt;
}

function makeExpiryEnv(
  options: {
    reservationChanges?: number;
    packageOrder?: { id: string; portal_id: string; reservation_id: string } | null;
    components?: Array<{ id: string; event_id: string; reservation_id: string }>;
  } = {},
) {
  const prepared: FakeStatement[] = [];
  const sendBatch = vi.fn(async () => undefined);
  const capacityCalls: Array<{ id: string; path: string; holdId: string }> = [];
  const reservationChanges = options.reservationChanges ?? 1;
  const handlers = {
    all: async (sql: string) => {
      if (sql.includes('FROM orders') && sql.includes('hubspot_invoice_id IS NOT NULL')) {
        return {
          results: [
            {
              id: 'order_1',
              portal_id: '441838610',
              hubspot_invoice_id: 'invoice_1',
              total_cents: 255500,
            },
          ],
        };
      }
      if (sql.includes('FROM course_bundle_components')) {
        return { results: options.components ?? [] };
      }
      return { results: [] };
    },
    first: async (sql: string) => {
      if (
        sql.includes('FROM orders') &&
        sql.includes("reservation_id = ?1 AND status = 'pending'")
      ) {
        return options.packageOrder ?? null;
      }
      if (sql.includes('SELECT portal_id, event_id FROM reservations')) {
        return { portal_id: '441838610', event_id: 'event_1' };
      }
      if (sql.includes('SELECT event_id FROM reservations')) {
        return { event_id: 'event_1' };
      }
      return null;
    },
  };
  const env = {
    DB: {
      prepare: vi.fn((sql: string) => {
        const stmt = makeStatement(sql, handlers);
        prepared.push(stmt);
        return stmt;
      }),
      batch: vi.fn(async (stmts: FakeStatement[]) =>
        stmts.map((stmt) => ({
          success: true,
          meta: {
            changes: stmt.sql.includes("UPDATE reservations SET status = 'expired'")
              ? reservationChanges
              : 1,
          },
        })),
      ),
    },
    QUEUE: { sendBatch },
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
  } as unknown as Env & {
    DB: { batch: ReturnType<typeof vi.fn> };
    QUEUE: { sendBatch: ReturnType<typeof vi.fn> };
  };

  return { env, prepared, sendBatch, capacityCalls };
}

function makeOrderContext(row: Record<string, unknown> | null) {
  return {
    env: {
      DB: {
        prepare: vi.fn(() => ({
          bind: vi.fn(() => ({
            first: vi.fn(async () => row),
          })),
        })),
      },
    },
    req: {
      header: vi.fn((name: string) => (name === 'X-Portal-Id' ? '441838610' : null)),
      param: vi.fn(() => 'order_1'),
    },
    json: vi.fn((body: unknown, status = 200) => {
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  };
}

describe('expired paid reservation invoice lifecycle', () => {
  it('queues a HubSpot invoice void when a paid hold expires', async () => {
    mocks.waitlistSnapshot.mockResolvedValue([]);
    const { env, prepared, sendBatch } = makeExpiryEnv();

    await expireHold(env, 'reservation_1');

    const outboxInsert = prepared.find(
      (stmt) => stmt.sql.includes('INSERT INTO outbox') && stmt.sql.includes("'payment.refund'"),
    );
    expect(outboxInsert).toBeDefined();
    const payload = JSON.parse(String(outboxInsert?.params[2]));
    expect(payload).toMatchObject({
      orderId: 'order_1',
      hsInvoiceId: 'invoice_1',
      amountCents: 255500,
      kind: 'full',
      reason: 'expired_hold',
    });
    expect(sendBatch).toHaveBeenCalledWith([
      {
        body: {
          kind: 'payment.refund',
          portalId: '441838610',
          outboxId: expect.any(String),
        },
      },
    ]);
  });

  it('does not signal invoice voids when the hold was already expired', async () => {
    mocks.waitlistSnapshot.mockResolvedValue([]);
    const { env, sendBatch } = makeExpiryEnv({ reservationChanges: 0 });

    await expireHold(env, 'reservation_1');

    expect(sendBatch).not.toHaveBeenCalled();
  });

  it('expires the complete package and releases all sibling module holds', async () => {
    mocks.waitlistSnapshot.mockResolvedValue([]);
    mocks.loadEvent.mockImplementation(async (_db: unknown, _portal: string, eventId: string) => ({
      id: eventId,
      hubspot_event_id: `hs-${eventId}`,
    }));
    const { env, prepared, capacityCalls } = makeExpiryEnv({
      packageOrder: { id: 'course_order', portal_id: '441838610', reservation_id: 'parent_hold' },
      components: [
        { id: 'component_1', event_id: 'module_1', reservation_id: 'module_hold_1' },
        { id: 'component_2', event_id: 'module_2', reservation_id: 'module_hold_2' },
      ],
    });

    // A child alarm firing first must cancel the entire parent package.
    await expireHold(env, 'module_hold_1');

    expect(prepared.some((stmt) => stmt.sql.includes('UPDATE course_bundle_components'))).toBe(
      true,
    );
    expect(
      prepared.some(
        (stmt) =>
          stmt.sql.includes('UPDATE reservations') && stmt.sql.includes('course_bundle_components'),
      ),
    ).toBe(true);
    expect(capacityCalls).toEqual([
      { id: '441838610:hs-event_1', path: '/release', holdId: 'parent_hold' },
      { id: '441838610:hs-module_2', path: '/release', holdId: 'module_hold_2' },
    ]);
  });

  it('does not expose stale payment URLs for cancelled orders', async () => {
    const ctx = makeOrderContext({
      id: 'order_1',
      status: 'cancelled',
      hubspot_invoice_id: 'invoice_1',
      hubspot_invoice_url: 'https://example.com/stale-invoice',
    });

    const response = await handleGetOrder(ctx as never);
    const body = (await response.json()) as { status: string; paymentUrl: string | null };

    expect(body.status).toBe('cancelled');
    expect(body.paymentUrl).toBeNull();
  });

  it('routes late payment notifications for cancelled orders to review instead of issuing tickets', async () => {
    mocks.loadOrderByInvoice.mockResolvedValue({
      id: 'order_1',
      status: 'cancelled',
      event_id: 'event_1',
      reservation_id: 'reservation_1',
    });

    await expect(
      confirmPayment({} as Env, {
        kind: 'confirm_payment',
        portalId: '441838610',
        hsInvoiceId: 'invoice_1',
      }),
    ).resolves.toEqual({ oversold: true });
    expect(mocks.loadEvent).not.toHaveBeenCalled();
  });
});
