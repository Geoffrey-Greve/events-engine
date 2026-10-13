import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { manageRoutes } from '../src/routes/manage';
import {
  clampInvoiceDueDays,
  DEFAULT_INVOICE_DUE_DAYS,
  handleReserve,
  MAX_INVOICE_DUE_DAYS,
  resolveInvoiceDueDate,
} from '../src/routes/reserve';
import type { Env } from '../src/types';

/**
 * Public + corporate paid bookings hold their seat until the invoice due date.
 *
 * Danielle's AWS D1.1 case: a customer registers on the public website and pays by bank
 * transfer the next day, but the 15-minute hold had already expired the reservation and
 * voided a valid invoice. These tests pin the payment window that replaced it.
 */

const BASE_ENV = env as unknown as Env;

let counter = 0;

/**
 * Every D1-backed test file builds the schema it needs (vitest-pool-workers hands each run
 * an empty database, and the files share one isolate). Same loose shape the other suites
 * use, plus migration 0015's invoice_due_days columns.
 */
function freshIds() {
  const n = `${Date.now()}-${counter++}`;
  return {
    portalId: `terms-${n}`,
    eventId: `evt-${n}`,
    hubspotEventId: `hs-event-${n}`,
    ticketTypeId: `tt-${n}`,
    adminKey: `admin-${n}`,
  };
}

function dateInDays(days: number): string {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/**
 * The same instant as a calendar date in the tenant's timezone, which is the frame
 * `capDueDateToEventStart` reads a session's start in.
 *
 * `dateInDays` is UTC, and the two disagree for nine and a half hours of every day: at
 * 22:42 UTC a session starting "in 10 days" has already turned over to day 11 in
 * Adelaide. Asserting the cap against the UTC date therefore passes all morning and fails
 * all evening, which is the test being wrong about the thing the code is deliberately
 * right about (see the LOCAL calendar date rule in CLAUDE.md).
 */
function tenantDateInDays(days: number): string {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() + days);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Australia/Adelaide',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

/** Reserve never reaches HubSpot for real here: membership degrades to unverified. */
function stubHubSpot() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 404 })),
  );
}

interface SeedOptions {
  priceCents?: number;
  portalInvoiceDueDays?: number | null;
  eventInvoiceDueDays?: number | null;
  /** How far out the session runs. The due date is capped at it — see capDueDateToEventStart. */
  startsInDays?: number;
}

async function seedEvent(values: ReturnType<typeof freshIds>, options: SeedOptions = {}) {
  const {
    priceCents = 83_500,
    portalInvoiceDueDays = null,
    eventInvoiceDueDays = null,
    startsInDays = 200,
  } = options;
  const now = new Date().toISOString();

  await BASE_ENV.DB.prepare(
    `INSERT INTO tenants
       (portal_id, display_name, stripe_processor_connected, xero_gst_rate_id, invoice_due_days)
     VALUES (?1, 'Weld Australia (test)', 1, ?2, ?3)`,
  )
    .bind(values.portalId, 'hs-gst-rate', portalInvoiceDueDays)
    .run();

  await BASE_ENV.DB.prepare(
    `INSERT INTO events
       (id, portal_id, hubspot_event_id, title, starts_at, ends_at, location, capacity,
        booking_kind, provider, allow_oversell, marketing_event_completed,
        invoice_due_days, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'Adelaide', 20, 'course', NULL, 0, 0, ?7, ?8, ?8)`,
  )
    .bind(
      values.eventId,
      values.portalId,
      values.hubspotEventId,
      'AWS D1.1 Structural Welding',
      // Default is far enough out that the configured terms bind rather than the
      // due-date cap (capDueDateToEventStart); the case below moves it in to test that.
      new Date(Date.now() + startsInDays * 24 * 60 * 60 * 1000).toISOString(),
      new Date(Date.now() + (startsInDays + 1) * 24 * 60 * 60 * 1000).toISOString(),
      eventInvoiceDueDays,
      now,
    )
    .run();

  await BASE_ENV.DB.prepare(
    `INSERT INTO ticket_types
       (id, portal_id, event_id, name, price_cents, currency, capacity, tax_treatment,
        member_only, hs_tax_rate_id, hs_product_id, sort_order, created_at)
     VALUES (?1, ?2, ?3, 'Standard', ?4, 'AUD', 20, 'gst', 0, NULL, NULL, 0, ?5)`,
  )
    .bind(values.ticketTypeId, values.portalId, values.eventId, priceCents, now)
    .run();
}

const publicApp = new Hono<{ Bindings: Env }>();
publicApp.post('/api/v1/events/:slug/reserve', handleReserve);

async function publicReserve(
  values: ReturnType<typeof freshIds>,
  email = 'danielle@example.com',
  idempotencyKey = crypto.randomUUID(),
) {
  return publicApp.request(
    `/api/v1/events/${values.eventId}/reserve`,
    {
      method: 'POST',
      headers: {
        'X-Portal-Id': values.portalId,
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        // Unique per call so the shared public rate-limit window never bites.
        'CF-Connecting-IP': `10.0.0.${counter % 250}`,
      },
      body: JSON.stringify({
        buyer: { name: 'Danielle Buyer', email },
        ticketTypeId: values.ticketTypeId,
      }),
    },
    BASE_ENV,
  );
}

async function reservationExpiry(orderId: string): Promise<string> {
  const row = await BASE_ENV.DB.prepare(
    `SELECT r.expires_at
     FROM reservations r
     JOIN orders o ON o.reservation_id = r.id
     WHERE o.id = ?1`,
  )
    .bind(orderId)
    .first<{ expires_at: string }>();
  return row?.expires_at ?? '';
}

async function invoiceOutboxPayload(portalId: string): Promise<Record<string, unknown>> {
  const row = await BASE_ENV.DB.prepare(
    `SELECT payload FROM outbox WHERE portal_id = ?1 AND topic = 'invoice.create'`,
  )
    .bind(portalId)
    .first<{ payload: string }>();
  return JSON.parse(row?.payload ?? '{}');
}

afterEach(() => vi.unstubAllGlobals());

describe('invoice due date resolution', () => {
  it('defaults to the configured payment terms when no date is supplied', () => {
    const window = resolveInvoiceDueDate(undefined, 30);
    expect(window.date).toBe(dateInDays(30));
    expect(window.expiresAt).toBe(`${window.date}T23:59:59.999Z`);
  });

  it('honours an explicit staff-chosen due date', () => {
    const chosen = dateInDays(7);
    expect(resolveInvoiceDueDate(chosen, 30).date).toBe(chosen);
  });

  it('falls back to the built-in default when the configured terms are unusable', () => {
    expect(resolveInvoiceDueDate(undefined, 0).date).toBe(dateInDays(DEFAULT_INVOICE_DUE_DAYS));
  });

  it('accepts the advertised 90-day maximum', () => {
    // Regression: the cap used to be `now + 90 × 24h` while the hold runs to the END of
    // the due date, so a 90-day configuration rejected every paid reservation.
    expect(resolveInvoiceDueDate(undefined, MAX_INVOICE_DUE_DAYS).date).toBe(
      dateInDays(MAX_INVOICE_DUE_DAYS),
    );
    expect(resolveInvoiceDueDate(dateInDays(MAX_INVOICE_DUE_DAYS), 30).date).toBe(
      dateInDays(MAX_INVOICE_DUE_DAYS),
    );
  });

  it('rejects a malformed, past, or over-cap due date', () => {
    expect(() => resolveInvoiceDueDate('31-12-2026', 30)).toThrow(/YYYY-MM-DD/);
    expect(() => resolveInvoiceDueDate('2026-02-31', 30)).toThrow(/future/);
    expect(() => resolveInvoiceDueDate(dateInDays(-1), 30)).toThrow(/future/);
    expect(() => resolveInvoiceDueDate(dateInDays(MAX_INVOICE_DUE_DAYS + 1), 30)).toThrow(
      /within 90 days/,
    );
  });

  it('clamps configured payment terms to the supported range', () => {
    expect(clampInvoiceDueDays(14)).toBe(14);
    expect(clampInvoiceDueDays('45')).toBe(45);
    expect(clampInvoiceDueDays(365)).toBe(MAX_INVOICE_DUE_DAYS);
    expect(clampInvoiceDueDays(0)).toBeNull();
    expect(clampInvoiceDueDays(null)).toBeNull();
    expect(clampInvoiceDueDays('abc')).toBeNull();
  });
});

describe('public paid reservations hold until the invoice due date', () => {
  it('holds the seat for the default 30 days instead of 15 minutes', async () => {
    const values = freshIds();
    await seedEvent(values);
    stubHubSpot();

    const res = await publicReserve(values);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; orderId: string };
    expect(body.status).toBe('reserved');

    const expiresAt = await reservationExpiry(body.orderId);
    expect(expiresAt.slice(0, 10)).toBe(dateInDays(DEFAULT_INVOICE_DUE_DAYS));
    // The regression this fixes: the hold must outlive the old 15-minute TTL.
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(24 * 60 * 60 * 1000);
  });

  it('writes the same due date to the HubSpot invoice', async () => {
    const values = freshIds();
    await seedEvent(values, { eventInvoiceDueDays: 21 });
    stubHubSpot();

    const res = await publicReserve(values);
    const body = (await res.json()) as { orderId: string };

    expect(await invoiceOutboxPayload(values.portalId)).toMatchObject({
      invoiceDueDate: dateInDays(21),
    });
    expect((await reservationExpiry(body.orderId)).slice(0, 10)).toBe(dateInDays(21));
  });

  it('never holds a seat past the session it holds it for', async () => {
    // A course running in 10 days on 30-day terms. The hold runs to the invoice due date,
    // so leaving it at 30 would hold the seat for three weeks after the course had been
    // and gone, and leave the buyer an invoice falling due after it ran. Both the invoice
    // and the hold come back to the start date.
    const values = freshIds();
    await seedEvent(values, { startsInDays: 10 });
    stubHubSpot();

    const res = await publicReserve(values);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { orderId: string };

    expect(await invoiceOutboxPayload(values.portalId)).toMatchObject({
      invoiceDueDate: tenantDateInDays(10),
    });
    expect((await reservationExpiry(body.orderId)).slice(0, 10)).toBe(tenantDateInDays(10));
  });

  it('leaves the terms alone when the session is further out than they run', async () => {
    const values = freshIds();
    await seedEvent(values, { startsInDays: 45, eventInvoiceDueDays: 21 });
    stubHubSpot();

    const res = await publicReserve(values);
    const body = (await res.json()) as { orderId: string };

    expect(await invoiceOutboxPayload(values.portalId)).toMatchObject({
      invoiceDueDate: dateInDays(21),
    });
    expect((await reservationExpiry(body.orderId)).slice(0, 10)).toBe(dateInDays(21));
  });

  it('prefers the event override over the portal default', async () => {
    const values = freshIds();
    await seedEvent(values, { portalInvoiceDueDays: 45, eventInvoiceDueDays: 7 });
    stubHubSpot();

    const res = await publicReserve(values);
    const body = (await res.json()) as { orderId: string };
    expect((await reservationExpiry(body.orderId)).slice(0, 10)).toBe(dateInDays(7));
  });

  it('uses the portal default when the event sets no override', async () => {
    const values = freshIds();
    await seedEvent(values, { portalInvoiceDueDays: 14 });
    stubHubSpot();

    const res = await publicReserve(values);
    const body = (await res.json()) as { orderId: string };
    expect((await reservationExpiry(body.orderId)).slice(0, 10)).toBe(dateInDays(14));
  });

  it('reports the payment deadline on the order poll so checkout can show it', async () => {
    const values = freshIds();
    await seedEvent(values, { portalInvoiceDueDays: 10 });
    stubHubSpot();

    const reserved = await publicReserve(values);
    const { orderId } = (await reserved.json()) as { orderId: string };

    const { handleGetOrder } = await import('../src/routes/reserve');
    const app = new Hono<{ Bindings: Env }>();
    app.get('/api/v1/orders/:id', handleGetOrder);
    const res = await app.request(
      `/api/v1/orders/${orderId}`,
      { headers: { 'X-Portal-Id': values.portalId } },
      BASE_ENV,
    );

    expect(await res.json()).toMatchObject({
      status: 'pending',
      paymentDueDate: dateInDays(10),
    });
  });

  it('leaves free public bookings confirming immediately', async () => {
    const values = freshIds();
    await seedEvent(values, { priceCents: 0 });
    stubHubSpot();

    const res = await publicReserve(values);
    const body = (await res.json()) as { status: string; orderId: string };
    expect(body.status).toBe('confirmed');

    // A confirmed booking holds no seat to expire: no invoice, no long-lived hold.
    expect(await invoiceOutboxPayload(values.portalId)).toEqual({});
    expect(Date.parse(await reservationExpiry(body.orderId)) - Date.now()).toBeLessThan(
      60 * 60 * 1000,
    );
  });
});

describe('the long hold is behind the Turnstile gate', () => {
  /**
   * The hold this file pins is what makes the challenge necessary. A paid public booking
   * holds its seat to the invoice due date — 30 days by default, up to 90 — and the DO takes
   * that expiry without an upper bound, so an unchallenged caller could park a seat for weeks
   * with a throwaway email and no payment, repeating until the event was sold out.
   */
  function envWithTurnstile(): Env {
    return {
      ...(BASE_ENV as unknown as Record<string, unknown>),
      TURNSTILE_SECRET_KEY: 'test-secret',
    } as unknown as Env;
  }

  async function capacityHolds(values: ReturnType<typeof freshIds>) {
    const stub = BASE_ENV.EVENT_CAPACITY.get(
      BASE_ENV.EVENT_CAPACITY.idFromName(`${values.portalId}:${values.hubspotEventId}`),
    );
    const res = await stub.fetch('https://do/availability');
    return (await res.json()) as { held: number; holds: number };
  }

  it('refuses a paid public booking carrying no Turnstile token', async () => {
    const values = freshIds();
    await seedEvent(values);
    stubHubSpot();

    const res = await publicApp.request(
      `/api/v1/events/${values.eventId}/reserve`,
      {
        method: 'POST',
        headers: {
          'X-Portal-Id': values.portalId,
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
          'CF-Connecting-IP': `10.0.1.${counter % 250}`,
        },
        body: JSON.stringify({
          buyer: { name: 'Unchallenged Buyer', email: 'bot@example.com' },
          ticketTypeId: values.ticketTypeId,
        }),
      },
      envWithTurnstile(),
    );

    expect(res.status).toBe(403);
    expect((await res.json()) as { status: string }).toMatchObject({
      status: 'turnstile_required',
    });

    // The point of the gate: no seat was taken, so the 30-day hold never happened.
    expect(await capacityHolds(values)).toMatchObject({ holds: 0, held: 0 });
  });

  it('leaves an unconfigured portal reserving as before', async () => {
    // The gate is opt-in per tenant. A portal with no secret must keep booking — turning
    // "not configured" into "nobody may book" would take the site down on deploy.
    const values = freshIds();
    await seedEvent(values);
    stubHubSpot();

    const res = await publicReserve(values);
    expect(res.status).toBe(200);
    expect((await res.json()) as { status: string }).toMatchObject({ status: 'reserved' });
  });
});

describe('an uncommitted hold is released, not left for the invoice window', () => {
  async function capacitySnapshot(values: ReturnType<typeof freshIds>) {
    const stub = BASE_ENV.EVENT_CAPACITY.get(
      BASE_ENV.EVENT_CAPACITY.idFromName(`${values.portalId}:${values.hubspotEventId}`),
    );
    const res = await stub.fetch('https://do/availability');
    return (await res.json()) as { held: number; holds: number; available: number | null };
  }

  it('frees the seats when the reservation batch fails after the hold is granted', async () => {
    const values = freshIds();
    await seedEvent(values);
    stubHubSpot();

    // A reservation already holding this (portal, idempotency_key) makes the step-10
    // batch fail on the UNIQUE constraint — after the DO has granted the hold. Without
    // the release, those seats would stay held until the invoice due date with no order.
    const collidingKey = crypto.randomUUID();
    await BASE_ENV.DB.prepare(
      `INSERT INTO reservations (id, portal_id, event_id, idempotency_key, status, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, 'expired', ?5, ?5)`,
    )
      .bind(
        `resv-collide-${values.eventId}`,
        values.portalId,
        values.eventId,
        collidingKey,
        new Date().toISOString(),
      )
      .run();

    const res = await publicReserve(values, 'danielle@example.com', collidingKey);
    expect(res.status).toBe(500);

    const snapshot = await capacitySnapshot(values);
    expect(snapshot.holds).toBe(0);
    expect(snapshot.held).toBe(0);
    expect(snapshot.available).toBe(20);
  });

  it('keeps the hold once the reservation is committed', async () => {
    const values = freshIds();
    await seedEvent(values);
    stubHubSpot();

    const res = await publicReserve(values);
    expect(res.status).toBe(200);

    // The committed booking still owns its seat — release must not fire on success.
    const snapshot = await capacitySnapshot(values);
    expect(snapshot.holds).toBe(1);
    expect(snapshot.held).toBe(1);
    expect(snapshot.available).toBe(19);
  });
});

describe('payment terms admin surface', () => {
  function adminEnv(values: ReturnType<typeof freshIds>): Env {
    return {
      ...(BASE_ENV as unknown as Record<string, unknown>),
      [`ADMIN_API_KEY_${values.portalId}`]: values.adminKey,
    } as unknown as Env;
  }

  function adminHeaders(values: ReturnType<typeof freshIds>) {
    return {
      'X-Portal-Id': values.portalId,
      Authorization: `Bearer ${values.adminKey}`,
      'Content-Type': 'application/json',
    };
  }

  it('saves a per-event override and rejects an out-of-range one', async () => {
    const values = freshIds();
    await seedEvent(values);

    const ok = await manageRoutes.request(
      `/events/${values.eventId}`,
      {
        method: 'PATCH',
        headers: adminHeaders(values),
        body: JSON.stringify({ invoiceDueDays: 7 }),
      },
      adminEnv(values),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ invoice_due_days: 7 });

    const tooLong = await manageRoutes.request(
      `/events/${values.eventId}`,
      {
        method: 'PATCH',
        headers: adminHeaders(values),
        body: JSON.stringify({ invoiceDueDays: MAX_INVOICE_DUE_DAYS + 1 }),
      },
      adminEnv(values),
    );
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toMatchObject({ status: 'invalid_invoice_due_days' });
  });

  it('clears the event override back to the portal default with null', async () => {
    const values = freshIds();
    await seedEvent(values, { eventInvoiceDueDays: 5 });

    const res = await manageRoutes.request(
      `/events/${values.eventId}`,
      {
        method: 'PATCH',
        headers: adminHeaders(values),
        body: JSON.stringify({ invoiceDueDays: null }),
      },
      adminEnv(values),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ invoice_due_days: null });
  });

  it('saves the portal default payment terms', async () => {
    const values = freshIds();
    await seedEvent(values);

    const res = await manageRoutes.request(
      '/onboarding/payment-terms',
      {
        method: 'PATCH',
        headers: adminHeaders(values),
        body: JSON.stringify({ invoiceDueDays: 45 }),
      },
      adminEnv(values),
    );
    expect(res.status).toBe(200);

    const onboarding = await manageRoutes.request(
      '/onboarding',
      { headers: adminHeaders(values) },
      adminEnv(values),
    );
    expect(await onboarding.json()).toMatchObject({
      invoiceDueDays: 45,
      defaultInvoiceDueDays: DEFAULT_INVOICE_DUE_DAYS,
      maxInvoiceDueDays: MAX_INVOICE_DUE_DAYS,
    });
  });
});
