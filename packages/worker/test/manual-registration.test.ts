import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeHubSpotSignatureUrl } from '../src/hubspot-signature';
import { appHomeRoutes } from '../src/routes/app-home';
import { manageRoutes } from '../src/routes/manage';
import type { Env } from '../src/types';
import { configureWeldMembership } from './support/fixtures';

const BASE_ENV = env as unknown as Env;

let counter = 0;

function freshIds() {
  const n = `${Date.now()}-${counter++}`;
  return {
    portalId: `manual-${n}`,
    adminKey: `admin-${n}`,
    eventId: `evt-${n}`,
    hubspotEventId: `hs-event-${n}`,
    ticketTypeId: `tt-${n}`,
  };
}

function freshNumericIds() {
  return {
    ...freshIds(),
    portalId: `441838610${counter++}`,
  };
}

function envFor(portalId: string, adminKey: string, extras: Record<string, unknown> = {}): Env {
  return {
    ...(BASE_ENV as unknown as Record<string, unknown>),
    [`ADMIN_API_KEY_${portalId}`]: adminKey,
    ...extras,
  } as unknown as Env;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubHubSpotMemberCompany(companyId: string, companyTier = 'Corporate Silver') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('/cms/v3/hubdb/tables/members/rows')) {
        return jsonResponse({ results: [] });
      }

      if (url.includes(`/crm/v3/objects/companies/${encodeURIComponent(companyId)}`)) {
        return jsonResponse({
          properties: {
            corporate_membership_status: 'Current',
            corporate_membership_level_2: companyTier,
          },
        });
      }

      if (url.includes('/crm/v3/objects/contacts/')) {
        return jsonResponse({ message: 'not found' }, 404);
      }

      throw new Error(`Unexpected HubSpot URL: ${url}`);
    }),
  );
}

type DealOutboxPayload = {
  totalCents: number;
  lineItems: Array<{
    ticketTypeId: string;
    quantity: number;
    unitCents: number;
    totalCents: number;
  }>;
  attendees?: Array<{ email: string; hubspotContactId: string | null }>;
  source?: string;
  manualRegistration?: boolean;
  complimentary?: boolean;
  invoiceRequired?: boolean;
  paymentRequired?: boolean;
  staffActor?: string | null;
  staffNote?: string | null;
};

function adminHeaders(portalId: string, adminKey: string, idempotencyKey = crypto.randomUUID()) {
  return {
    'X-Portal-Id': portalId,
    Authorization: `Bearer ${adminKey}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey,
  };
}

async function hubSpotSignedHeaders(
  method: string,
  url: string,
  rawBody: string,
  clientSecret: string,
  timestamp = String(Date.now()),
) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(clientSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const source = `${method}${normalizeHubSpotSignatureUrl(url)}${rawBody}${timestamp}`;
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(source));
  const signatureBytes = Array.from(new Uint8Array(signature));
  return {
    'X-HubSpot-Request-Timestamp': timestamp,
    'X-HubSpot-Signature-v3': btoa(String.fromCharCode(...signatureBytes)),
    'Content-Type': 'application/json',
  };
}

async function seedPaidEvent(values: ReturnType<typeof freshIds>, priceCents = 83_500) {
  const now = new Date().toISOString();
  await BASE_ENV.DB.prepare(
    `INSERT INTO tenants
       (portal_id, stripe_processor_connected, xero_gst_rate_id, display_name)
     VALUES (?1, 1, ?2, 'Test Tenant')`,
  )
    .bind(values.portalId, 'hs-gst-rate')
    .run();
  await BASE_ENV.DB.prepare(
    `INSERT INTO events
       (id, portal_id, hubspot_event_id, title, starts_at, ends_at, location, capacity,
        booking_kind, provider, allow_oversell, marketing_event_completed, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'Online', 20, 'course', NULL, 0, 0, ?7, ?7)`,
  )
    .bind(
      values.eventId,
      values.portalId,
      values.hubspotEventId,
      'Manual Registration Test',
      now,
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
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

async function seedMemberPriceRule(
  values: ReturnType<typeof freshIds>,
  fixedPriceCents: number,
  memberLevel = 'silver',
  memberCategory = 'corporate',
) {
  await BASE_ENV.DB.prepare(
    `INSERT INTO pricing_rules
       (id, portal_id, scope, scope_id, member_level, member_category,
        discount_percent, fixed_price_cents, created_at)
     VALUES (?1, ?2, 'event', ?3, ?4, ?5, NULL, ?6, ?7)`,
  )
    .bind(
      `rule-${values.eventId}`,
      values.portalId,
      values.eventId,
      memberLevel,
      memberCategory,
      fixedPriceCents,
      new Date().toISOString(),
    )
    .run();
}

async function readDealOutbox(portalId: string): Promise<DealOutboxPayload> {
  const row = await BASE_ENV.DB.prepare(
    `SELECT payload FROM outbox WHERE portal_id = ?1 AND topic = 'deal.create' LIMIT 1`,
  )
    .bind(portalId)
    .first<{ payload: string }>();
  expect(row).toBeTruthy();
  return JSON.parse(row?.payload ?? '{}') as DealOutboxPayload;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('staff manual registration manage route', () => {
  it('requires admin authentication', async () => {
    const values = freshIds();
    await seedPaidEvent(values);

    const res = await manageRoutes.request(
      `/events/${values.eventId}/registrations`,
      {
        method: 'POST',
        headers: { 'X-Portal-Id': values.portalId },
        body: JSON.stringify({}),
      },
      envFor(values.portalId, values.adminKey),
    );

    expect(res.status).toBe(401);
  });

  it('creates a paid manual registration through the normal pending invoice path', async () => {
    const values = freshIds();
    await seedPaidEvent(values, 64_350);
    const envWithAdmin = envFor(values.portalId, values.adminKey);
    const invoiceDueDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    const res = await manageRoutes.request(
      `/events/${values.eventId}/registrations`,
      {
        method: 'POST',
        headers: adminHeaders(values.portalId, values.adminKey),
        body: JSON.stringify({
          mode: 'paid',
          ticketTypeId: values.ticketTypeId,
          attendeeName: 'Pat Paid',
          attendeeEmail: 'paid@example.com',
          invoiceDueDate,
        }),
      },
      envWithAdmin,
    );
    const body = await res.json<{
      status: string;
      mode: string;
      orderId: string;
      registrationIds: string[];
    }>();

    expect(res.status).toBe(200);
    expect(body.status).toBe('reserved');
    expect(body.mode).toBe('paid');
    expect(body.registrationIds).toHaveLength(1);

    const order = await BASE_ENV.DB.prepare(
      'SELECT status, total_cents FROM orders WHERE portal_id = ?1 AND id = ?2',
    )
      .bind(values.portalId, body.orderId)
      .first<{ status: string; total_cents: number }>();
    expect(order).toMatchObject({ status: 'pending', total_cents: 64_350 });

    const reservation = await BASE_ENV.DB.prepare(
      `SELECT r.expires_at
       FROM reservations r
       JOIN orders o ON o.reservation_id = r.id
       WHERE o.id = ?1`,
    )
      .bind(body.orderId)
      .first<{ expires_at: string }>();
    expect(reservation?.expires_at.slice(0, 10)).toBe(invoiceDueDate);

    const outbox = await BASE_ENV.DB.prepare(
      `SELECT topic FROM outbox WHERE portal_id = ?1 ORDER BY topic ASC`,
    )
      .bind(values.portalId)
      .all<{ topic: string }>();
    expect(outbox.results.map((row) => row.topic)).toEqual(
      expect.arrayContaining(['deal.create', 'invoice.create', 'me.register']),
    );
    const invoiceOutbox = await BASE_ENV.DB.prepare(
      `SELECT payload FROM outbox WHERE portal_id = ?1 AND topic = 'invoice.create'`,
    )
      .bind(values.portalId)
      .first<{ payload: string }>();
    expect(JSON.parse(invoiceOutbox?.payload ?? '{}')).toMatchObject({ invoiceDueDate });

    await expect(readDealOutbox(values.portalId)).resolves.toMatchObject({
      totalCents: 64_350,
      source: 'staff_manual',
      manualRegistration: true,
      complimentary: false,
      invoiceRequired: true,
      paymentRequired: true,
    });
  });

  it('captures attendee phone/suburb/state and queues the contact write-back (Phase 1.2)', async () => {
    const values = freshIds();
    await seedPaidEvent(values, 30_000);
    const envWithAdmin = envFor(values.portalId, values.adminKey);

    const res = await manageRoutes.request(
      `/events/${values.eventId}/registrations`,
      {
        method: 'POST',
        headers: adminHeaders(values.portalId, values.adminKey),
        body: JSON.stringify({
          mode: 'paid',
          ticketTypeId: values.ticketTypeId,
          attendeeName: 'Sam Tan',
          attendeeEmail: 'sam-capture@example.com',
          attendeePhone: '  0412 345 678 ',
          attendeeSuburb: 'Prospect',
          attendeeState: 'SA',
        }),
      },
      envWithAdmin,
    );
    const body = await res.json<{ status: string; registrationIds: string[] }>();
    expect(res.status).toBe(200);

    const registration = await BASE_ENV.DB.prepare(
      'SELECT attendee_phone, attendee_suburb, attendee_state FROM registrations WHERE id = ?1',
    )
      .bind(body.registrationIds[0])
      .first<{ attendee_phone: string; attendee_suburb: string; attendee_state: string }>();
    expect(registration).toEqual({
      attendee_phone: '0412 345 678',
      attendee_suburb: 'Prospect',
      attendee_state: 'SA',
    });

    // The write-back is an outbox row in the same batch as the registration, never a
    // direct HubSpot call from the handler.
    const sync = await BASE_ENV.DB.prepare(
      `SELECT payload FROM outbox
        WHERE portal_id = ?1 AND topic = 'contact.sync_attendee_details'`,
    )
      .bind(values.portalId)
      .first<{ payload: string }>();
    expect(JSON.parse(sync?.payload ?? '{}')).toMatchObject({
      registrationId: body.registrationIds[0],
      eventId: values.eventId,
      attendeeEmail: 'sam-capture@example.com',
      details: { phone: '0412 345 678', suburb: 'Prospect', state: 'SA' },
    });
  });

  it('records no contact details and queues no write-back when none were supplied', async () => {
    const values = freshIds();
    await seedPaidEvent(values, 30_000);
    const envWithAdmin = envFor(values.portalId, values.adminKey);

    const res = await manageRoutes.request(
      `/events/${values.eventId}/registrations`,
      {
        method: 'POST',
        headers: adminHeaders(values.portalId, values.adminKey),
        body: JSON.stringify({
          mode: 'paid',
          ticketTypeId: values.ticketTypeId,
          attendeeName: 'No Details',
          attendeeEmail: 'no-details@example.com',
        }),
      },
      envWithAdmin,
    );
    const body = await res.json<{ registrationIds: string[] }>();
    expect(res.status).toBe(200);

    // NULL, not '' — the registration records "never asked", not an empty answer.
    const registration = await BASE_ENV.DB.prepare(
      'SELECT attendee_phone, attendee_suburb, attendee_state FROM registrations WHERE id = ?1',
    )
      .bind(body.registrationIds[0])
      .first<{ attendee_phone: null; attendee_suburb: null; attendee_state: null }>();
    expect(registration).toEqual({
      attendee_phone: null,
      attendee_suburb: null,
      attendee_state: null,
    });

    const sync = await BASE_ENV.DB.prepare(
      `SELECT COUNT(*) AS n FROM outbox
        WHERE portal_id = ?1 AND topic = 'contact.sync_attendee_details'`,
    )
      .bind(values.portalId)
      .first<{ n: number }>();
    expect(sync?.n).toBe(0);
  });

  it('applies member pricing to a paid manual registration when staff provides a member company ID', async () => {
    const values = freshIds();
    await seedPaidEvent(values, 83_500);
    await seedMemberPriceRule(values, 77_000);
    await configureWeldMembership(BASE_ENV.DB, values.portalId);
    stubHubSpotMemberCompany('123456', 'Corporate Silver');
    const envWithAdmin = envFor(values.portalId, values.adminKey, {
      [`HUBSPOT_API_KEY_${values.portalId}`]: 'hs-token',
    });

    const res = await manageRoutes.request(
      `/events/${values.eventId}/registrations`,
      {
        method: 'POST',
        headers: adminHeaders(values.portalId, values.adminKey),
        body: JSON.stringify({
          mode: 'paid',
          ticketTypeId: values.ticketTypeId,
          attendeeName: 'Pat Member',
          attendeeEmail: 'member-paid@example.com',
          memberCompanyId: '123456',
        }),
      },
      envWithAdmin,
    );
    const body = await res.json<{
      status: string;
      mode: string;
      orderId: string;
      registrationIds: string[];
    }>();

    expect(res.status).toBe(200);
    expect(body.status).toBe('reserved');
    expect(body.mode).toBe('paid');
    expect(body.registrationIds).toHaveLength(1);

    const order = await BASE_ENV.DB.prepare(
      'SELECT status, total_cents FROM orders WHERE portal_id = ?1 AND id = ?2',
    )
      .bind(values.portalId, body.orderId)
      .first<{ status: string; total_cents: number }>();
    expect(order).toMatchObject({ status: 'pending', total_cents: 77_000 });

    const dealPayload = await readDealOutbox(values.portalId);
    expect(dealPayload).toMatchObject({
      totalCents: 77_000,
      source: 'staff_manual',
      manualRegistration: true,
      complimentary: false,
      invoiceRequired: true,
    });
    expect(dealPayload.lineItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ticketTypeId: values.ticketTypeId,
          unitCents: 77_000,
          totalCents: 77_000,
        }),
      ]),
    );
  });

  it('creates a complimentary staff registration with a zero-dollar confirmed order and issued ticket', async () => {
    const values = freshIds();
    await seedPaidEvent(values, 83_500);
    const envWithAdmin = envFor(values.portalId, values.adminKey);

    const res = await manageRoutes.request(
      `/events/${values.eventId}/registrations`,
      {
        method: 'POST',
        headers: adminHeaders(values.portalId, values.adminKey),
        body: JSON.stringify({
          mode: 'complimentary',
          ticketTypeId: values.ticketTypeId,
          attendeeName: 'Pat Comp',
          attendeeEmail: 'comp@example.com',
          hubspotContactId: '12345',
          staffNote: 'Approved complimentary seat',
        }),
      },
      envWithAdmin,
    );
    const body = await res.json<{
      status: string;
      mode: string;
      orderId: string;
      registrationIds: string[];
      ticketIds: string[];
    }>();

    expect(res.status).toBe(200);
    expect(body.status).toBe('confirmed');
    expect(body.mode).toBe('complimentary');
    expect(body.registrationIds).toHaveLength(1);
    expect(body.ticketIds).toHaveLength(1);

    const order = await BASE_ENV.DB.prepare(
      'SELECT status, total_cents FROM orders WHERE portal_id = ?1 AND id = ?2',
    )
      .bind(values.portalId, body.orderId)
      .first<{ status: string; total_cents: number }>();
    expect(order).toMatchObject({ status: 'confirmed', total_cents: 0 });

    const ticket = await BASE_ENV.DB.prepare(
      'SELECT status FROM tickets WHERE portal_id = ?1 AND id = ?2',
    )
      .bind(values.portalId, body.ticketIds[0])
      .first<{ status: string }>();
    expect(ticket).toMatchObject({ status: 'issued' });

    const invoiceOutbox = await BASE_ENV.DB.prepare(
      `SELECT COUNT(*) AS count FROM outbox WHERE portal_id = ?1 AND topic = 'invoice.create'`,
    )
      .bind(values.portalId)
      .first<{ count: number }>();
    expect(invoiceOutbox?.count).toBe(0);

    const outbox = await BASE_ENV.DB.prepare(
      `SELECT topic FROM outbox WHERE portal_id = ?1 ORDER BY topic ASC`,
    )
      .bind(values.portalId)
      .all<{ topic: string }>();
    expect(outbox.results.map((row) => row.topic)).toEqual(
      expect.arrayContaining(['deal.create', 'me.register']),
    );

    const dealPayload = await readDealOutbox(values.portalId);
    expect(dealPayload).toMatchObject({
      totalCents: 0,
      source: 'staff_manual',
      manualRegistration: true,
      complimentary: true,
      invoiceRequired: false,
      paymentRequired: false,
    });
    // The note is not copied into the deal payload — it lives on the order (Phase 1.3).
    expect(dealPayload.staffNote).toBeUndefined();
    const notes = await BASE_ENV.DB.prepare(
      'SELECT author, body, order_id FROM registration_notes WHERE portal_id = ?1',
    )
      .bind(values.portalId)
      .all<{ author: string; body: string; order_id: string }>();
    expect(notes.results).toEqual([
      expect.objectContaining({ body: 'Approved complimentary seat', order_id: body.orderId }),
    ]);
    expect(dealPayload.lineItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ticketTypeId: values.ticketTypeId,
          quantity: 1,
          unitCents: 0,
          totalCents: 0,
        }),
      ]),
    );
    expect(dealPayload.attendees).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          email: 'comp@example.com',
          hubspotContactId: '12345',
        }),
      ]),
    );
  });

  it('rejects unsigned app-home requests', async () => {
    const values = freshNumericIds();
    await seedPaidEvent(values);

    const res = await appHomeRoutes.request(
      `https://event-engine.refuel-creative.workers.dev/events?portalId=${values.portalId}`,
      {},
      envFor(values.portalId, values.adminKey, { HUBSPOT_CLIENT_SECRET: 'hubspot-client-secret' }),
    );

    expect(res.status).toBe(401);
  });

  it('creates a complimentary manual registration from a signed HubSpot app-home request', async () => {
    const values = freshNumericIds();
    await seedPaidEvent(values, 83_500);
    const clientSecret = 'hubspot-client-secret';
    const workerEnv = envFor(values.portalId, values.adminKey, {
      HUBSPOT_CLIENT_SECRET: clientSecret,
    });
    const url =
      `https://event-engine.refuel-creative.workers.dev/events/${values.eventId}/registrations` +
      `?portalId=${values.portalId}&userEmail=staff%40weld.test&userId=123&appId=456`;
    const rawBody = JSON.stringify({
      mode: 'complimentary',
      ticketTypeId: values.ticketTypeId,
      attendeeName: 'App Home Comp',
      attendeeEmail: 'app-home-comp@example.com',
      hubspotContactId: '12345',
      staffNote: 'Approved from app home',
      idempotencyKey: `app-home-test-${values.eventId}`,
    });

    const res = await appHomeRoutes.request(
      url,
      {
        method: 'POST',
        headers: await hubSpotSignedHeaders('POST', url, rawBody, clientSecret),
        body: rawBody,
      },
      workerEnv,
    );
    const body = await res.json<{
      status: string;
      mode: string;
      registrationIds: string[];
      ticketIds: string[];
    }>();

    expect(res.status).toBe(200);
    expect(body.status).toBe('confirmed');
    expect(body.mode).toBe('complimentary');
    expect(body.registrationIds).toHaveLength(1);
    expect(body.ticketIds).toHaveLength(1);

    const invoiceOutbox = await BASE_ENV.DB.prepare(
      `SELECT COUNT(*) AS count FROM outbox WHERE portal_id = ?1 AND topic = 'invoice.create'`,
    )
      .bind(values.portalId)
      .first<{ count: number }>();
    expect(invoiceOutbox?.count).toBe(0);

    const dealPayload = await readDealOutbox(values.portalId);
    expect(dealPayload).toMatchObject({
      totalCents: 0,
      source: 'staff_manual',
      manualRegistration: true,
      complimentary: true,
      invoiceRequired: false,
      paymentRequired: false,
      staffActor: 'staff@weld.test',
    });
    // The note lands on the order (Phase 1.3), not in the deal payload.
    expect(dealPayload.staffNote).toBeUndefined();
    const appHomeNotes = await BASE_ENV.DB.prepare(
      'SELECT author, body FROM registration_notes WHERE portal_id = ?1',
    )
      .bind(values.portalId)
      .all<{ author: string; body: string }>();
    expect(appHomeNotes.results).toEqual([
      expect.objectContaining({ author: 'staff@weld.test', body: 'Approved from app home' }),
    ]);
    expect(dealPayload.lineItems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ticketTypeId: values.ticketTypeId,
          unitCents: 0,
          totalCents: 0,
        }),
      ]),
    );
  });
});
