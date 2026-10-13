import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { handleGetOrder, handleReserveSelectedModules } from '../src/routes/reserve';
import type { Env } from '../src/types';

// The provider layer, not Graph: these tests are about whether the selected-module path
// CALLS it and persists what it returns, which is exactly what was missing.
vi.mock('../src/teams', () => ({
  provisionWebinarIfNeeded: vi.fn(async () => ({
    teamsWebinarId: 'webinar-selected-module',
    teamsJoinUrl: 'https://teams.example/join/event',
  })),
  registerAttendeeInTeams: vi.fn(
    async (_env, _portalId, _provider, _webinarId, _attendee, registrationId) => ({
      teamsRegistrationId: `provider-reg-${registrationId}`,
      teamsJoinUrl: `https://teams.example/personal/${registrationId}`,
    }),
  ),
  cancelAttendeeInTeams: vi.fn(async () => undefined),
}));

const teamsMock = vi.mocked(await import('../src/teams'));

const BASE_ENV = env as unknown as Env;
let counter = 0;

function ids() {
  const suffix = `${Date.now()}-${counter++}`;
  return {
    portalId: `sel-${suffix}`,
    parentId: `iwe-parent-${suffix}`,
    firstModuleId: `iwe-module-one-${suffix}`,
    secondModuleId: `iwe-module-two-${suffix}`,
    firstTicketId: `ticket-module-one-${suffix}`,
    secondTicketId: `ticket-module-two-${suffix}`,
  };
}

async function seedSelectedModuleCourse(values: ReturnType<typeof ids>) {
  const now = new Date().toISOString();
  await BASE_ENV.DB.prepare(
    `INSERT INTO tenants (portal_id, display_name, stripe_processor_connected, xero_gst_rate_id, created_at)
     VALUES (?1, 'Weld Australia Dev route test', 1, 'gst-rate-dev', ?2)`,
  )
    .bind(values.portalId, now)
    .run();

  await BASE_ENV.DB.prepare(
    `INSERT INTO events
       (id, portal_id, hubspot_event_id, hubspot_marketing_event_object_id, title,
        starts_at, ends_at, location, capacity, capacity_unlimited, booking_kind,
        parent_event_id, course_component_kind, course_component_order,
        course_module_product_id, course_package_required, provider, allow_oversell,
        marketing_event_completed, teams_webinar_id, teams_session_id, teams_join_url,
        refund_policy_id, category, invoice_due_days, hubspot_owner_id,
        first_published_at, created_at, updated_at)
     VALUES
       (?1, ?2, ?3, NULL, 'International Welding Engineer', ?4, ?5, 'Online',
        20, 0, 'course', NULL, 'standalone', NULL, NULL, 0, NULL, 0, 0, NULL,
        NULL, NULL, NULL, 'training', NULL, NULL, NULL, ?6, ?6),
       (?7, ?2, ?8, NULL, 'IWE Module 1', ?4, ?5, 'Online',
        5, 0, 'course', ?1, 'module', 1, 'product-module-one', 0, NULL, 0, 0,
        NULL, NULL, NULL, NULL, 'training', NULL, NULL, NULL, ?6, ?6),
       (?9, ?2, ?10, NULL, 'IWE Module 2', ?4, ?5, 'Online',
        5, 0, 'course', ?1, 'module', 2, 'product-module-two', 0, NULL, 0, 0,
        NULL, NULL, NULL, NULL, 'training', NULL, NULL, NULL, ?6, ?6)`,
  )
    .bind(
      values.parentId,
      values.portalId,
      `hs-${values.parentId}`,
      '2026-10-01T00:00:00.000Z',
      '2026-10-01T01:00:00.000Z',
      now,
      values.firstModuleId,
      `hs-${values.firstModuleId}`,
      values.secondModuleId,
      `hs-${values.secondModuleId}`,
    )
    .run();

  await BASE_ENV.DB.prepare(
    `INSERT INTO ticket_types
       (id, portal_id, event_id, name, price_cents, currency, capacity,
        capacity_unlimited, tax_treatment, member_only, hs_tax_rate_id,
        hs_product_id, internal_only, sort_order, created_at)
     VALUES
       (?1, ?2, ?3, 'Module 1 public', 100000, 'AUD', 5, 0, 'gst', 0, NULL,
        'product-module-one', 0, 1, ?4),
       (?5, ?2, ?6, 'Module 2 public', 150000, 'AUD', 5, 0, 'gst', 0, NULL,
        'product-module-two', 0, 2, ?4)`,
  )
    .bind(
      values.firstTicketId,
      values.portalId,
      values.firstModuleId,
      now,
      values.secondTicketId,
      values.secondModuleId,
    )
    .run();
}

const app = new Hono<{ Bindings: Env }>();
app.post('/api/v1/events/:slug/reserve-selected-modules', handleReserveSelectedModules);
app.get('/api/v1/orders/:id', handleGetOrder);

describe('POST /api/v1/events/:slug/reserve-selected-modules', () => {
  it('creates one parent order and child reservations for the selected modules', async () => {
    const values = ids();
    await seedSelectedModuleCourse(values);
    const sendBatch = vi.fn(async () => undefined);
    const testEnv = {
      ...BASE_ENV,
      QUEUE: { sendBatch },
    } as unknown as Env;

    const response = await app.request(
      `/api/v1/events/${values.parentId}/reserve-selected-modules`,
      {
        method: 'POST',
        headers: {
          'X-Portal-Id': values.portalId,
          'Content-Type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
          'CF-Connecting-IP': `10.42.0.${counter % 250}`,
        },
        body: JSON.stringify({
          buyer: { name: 'Melwyn Tester', email: 'melwyn+selected-modules@refuelcreative.com.au' },
          selectedModules: [
            {
              eventId: values.firstModuleId,
              ticketTypeId: values.firstTicketId,
              expectedUnitCents: 100000,
            },
            {
              eventId: values.secondModuleId,
              ticketTypeId: values.secondTicketId,
              expectedUnitCents: 150000,
            },
          ],
          expectedTotalCents: 250000,
        }),
      },
      testEnv,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { orderId: string; registrationIds: string[] };
    expect(body.registrationIds).toHaveLength(2);

    const order = await BASE_ENV.DB.prepare(
      `SELECT event_id, reservation_id, total_cents, currency, status
         FROM orders WHERE portal_id = ?1 AND id = ?2`,
    )
      .bind(values.portalId, body.orderId)
      .first<{
        event_id: string;
        reservation_id: string | null;
        total_cents: number;
        currency: string;
        status: string;
      }>();
    expect(order).toMatchObject({
      event_id: values.parentId,
      reservation_id: null,
      total_cents: 250000,
      currency: 'AUD',
      status: 'pending',
    });

    const registrations = await BASE_ENV.DB.prepare(
      `SELECT event_id, ticket_type_id, unit_cents
         FROM registrations
        WHERE portal_id = ?1 AND order_id = ?2
        ORDER BY event_id ASC`,
    )
      .bind(values.portalId, body.orderId)
      .all<{ event_id: string; ticket_type_id: string; unit_cents: number }>();
    expect(registrations.results).toEqual([
      {
        event_id: values.firstModuleId,
        ticket_type_id: values.firstTicketId,
        unit_cents: 100000,
      },
      {
        event_id: values.secondModuleId,
        ticket_type_id: values.secondTicketId,
        unit_cents: 150000,
      },
    ]);

    const childHolds = await BASE_ENV.DB.prepare(
      `SELECT event_id, ticket_type_id, status
         FROM course_bundle_components
        WHERE portal_id = ?1 AND order_id = ?2
        ORDER BY event_id ASC`,
    )
      .bind(values.portalId, body.orderId)
      .all<{ event_id: string; ticket_type_id: string; status: string }>();
    expect(childHolds.results).toEqual([
      {
        event_id: values.firstModuleId,
        ticket_type_id: values.firstTicketId,
        status: 'pending',
      },
      {
        event_id: values.secondModuleId,
        ticket_type_id: values.secondTicketId,
        status: 'pending',
      },
    ]);

    const outbox = await BASE_ENV.DB.prepare(
      `SELECT topic, COUNT(*) AS count
         FROM outbox
        WHERE portal_id = ?1
        GROUP BY topic
        ORDER BY topic ASC`,
    )
      .bind(values.portalId)
      .all<{ topic: string; count: number }>();
    expect(outbox.results).toEqual([
      { topic: 'deal.create', count: 1 },
      { topic: 'invoice.create', count: 1 },
      { topic: 'me.register', count: 2 },
    ]);
    expect(sendBatch).toHaveBeenCalledTimes(1);

    const poll = await app.request(
      `/api/v1/orders/${body.orderId}`,
      { headers: { 'X-Portal-Id': values.portalId } },
      testEnv,
    );
    expect(poll.status).toBe(200);
    await expect(poll.json()).resolves.toMatchObject({
      status: 'pending',
      paymentMethod: 'invoice',
    });
  });
});

// ---------------------------------------------------------------------------
// Regression cover for the four confirmed review findings on this path. Each of
// these passed before the fix only because nothing exercised it.
// ---------------------------------------------------------------------------

function reserveRequest(
  values: ReturnType<typeof ids>,
  init: {
    idempotencyKey: string;
    answers?: Record<string, unknown>;
    modules?: Array<{ eventId: string; ticketTypeId: string; expectedUnitCents: number }>;
  },
) {
  const modules = init.modules ?? [
    {
      eventId: values.firstModuleId,
      ticketTypeId: values.firstTicketId,
      expectedUnitCents: 100000,
    },
  ];
  return {
    method: 'POST',
    headers: {
      'X-Portal-Id': values.portalId,
      'Content-Type': 'application/json',
      'Idempotency-Key': init.idempotencyKey,
      'CF-Connecting-IP': `10.43.0.${counter % 250}`,
    },
    body: JSON.stringify({
      buyer: { name: 'Melwyn Tester', email: `melwyn+sel-${counter}@refuelcreative.com.au` },
      selectedModules: modules,
      expectedTotalCents: modules.reduce((sum, m) => sum + m.expectedUnitCents, 0),
      ...(init.answers ? { answers: init.answers } : {}),
    }),
  };
}

function queueEnv() {
  return {
    env: { ...BASE_ENV, QUEUE: { sendBatch: vi.fn(async () => undefined) } } as unknown as Env,
  };
}

describe('selected modules: idempotency is exclusive, not best effort', () => {
  it('creates ONE order when two concurrent requests share an Idempotency-Key', async () => {
    const values = ids();
    await seedSelectedModuleCourse(values);
    const { env: testEnv } = queueEnv();
    const key = crypto.randomUUID();

    // Both requests miss the replay SELECT, so exclusivity has to come from a UNIQUE
    // index. It used to come from neither: the child reservations were keyed by a
    // per-request orderId, so nothing could collide and both batches committed.
    const [a, b] = await Promise.all([
      app.request(
        `/api/v1/events/${values.parentId}/reserve-selected-modules`,
        reserveRequest(values, { idempotencyKey: key }),
        testEnv,
      ),
      app.request(
        `/api/v1/events/${values.parentId}/reserve-selected-modules`,
        reserveRequest(values, { idempotencyKey: key }),
        testEnv,
      ),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(200);

    const orders = await BASE_ENV.DB.prepare(
      'SELECT COUNT(*) AS c FROM orders WHERE portal_id = ?1',
    )
      .bind(values.portalId)
      .first<{ c: number }>();
    expect(orders?.c).toBe(1);

    // One order means one of each money-side side effect, which is the thing a double
    // commit would have doubled.
    const outbox = await BASE_ENV.DB.prepare(
      `SELECT topic, COUNT(*) AS count FROM outbox
        WHERE portal_id = ?1 AND topic IN ('deal.create','invoice.create')
        GROUP BY topic ORDER BY topic ASC`,
    )
      .bind(values.portalId)
      .all<{ topic: string; count: number }>();
    expect(outbox.results).toEqual([
      { topic: 'deal.create', count: 1 },
      { topic: 'invoice.create', count: 1 },
    ]);
  });

  it('carries the caller key into the child reservations, so the UNIQUE index can bite', async () => {
    const values = ids();
    await seedSelectedModuleCourse(values);
    const { env: testEnv } = queueEnv();
    const key = `caller-key-${crypto.randomUUID()}`;

    const response = await app.request(
      `/api/v1/events/${values.parentId}/reserve-selected-modules`,
      reserveRequest(values, { idempotencyKey: key }),
      testEnv,
    );
    expect(response.status).toBe(200);

    const reservation = await BASE_ENV.DB.prepare(
      'SELECT idempotency_key FROM reservations WHERE portal_id = ?1',
    )
      .bind(values.portalId)
      .first<{ idempotency_key: string }>();
    expect(reservation?.idempotency_key).toContain(key);
  });
});

describe('selected modules: an online module reaches its provider', () => {
  it('registers the attendee, stores the provider ids, and queues the join URL', async () => {
    const values = ids();
    await seedSelectedModuleCourse(values);
    await BASE_ENV.DB.prepare('UPDATE events SET provider = ?1 WHERE id = ?2')
      .bind('teams', values.firstModuleId)
      .run();
    const { env: testEnv } = queueEnv();

    const response = await app.request(
      `/api/v1/events/${values.parentId}/reserve-selected-modules`,
      reserveRequest(values, { idempotencyKey: crypto.randomUUID() }),
      testEnv,
    );
    expect(response.status).toBe(200);

    const reg = await BASE_ENV.DB.prepare(
      `SELECT id, teams_registration_id, teams_join_url FROM registrations
        WHERE portal_id = ?1 AND event_id = ?2`,
    )
      .bind(values.portalId, values.firstModuleId)
      .first<{ id: string; teams_registration_id: string | null; teams_join_url: string | null }>();

    // Both were NULL before the fix: the seat was sold and the attendee had no way in.
    expect(reg?.teams_registration_id).toBe(`provider-reg-${reg?.id}`);
    expect(reg?.teams_join_url).toBe(`https://teams.example/personal/${reg?.id}`);

    // The URL has to reach the contact BEFORE HubSpot's confirmation workflow fires.
    const joinUrl = await BASE_ENV.DB.prepare(
      `SELECT payload FROM outbox
        WHERE portal_id = ?1 AND topic = 'contact.set_join_url'`,
    )
      .bind(values.portalId)
      .first<{ payload: string }>();
    expect(joinUrl).not.toBeNull();
    expect(JSON.parse(joinUrl?.payload ?? '{}')).toMatchObject({
      registrationId: reg?.id,
      teamsJoinUrl: reg?.teams_join_url,
    });
  });

  it('raises no join-URL row for an in-person module', async () => {
    const values = ids();
    await seedSelectedModuleCourse(values);
    const { env: testEnv } = queueEnv();

    await app.request(
      `/api/v1/events/${values.parentId}/reserve-selected-modules`,
      reserveRequest(values, { idempotencyKey: crypto.randomUUID() }),
      testEnv,
    );

    const joinUrl = await BASE_ENV.DB.prepare(
      `SELECT COUNT(*) AS c FROM outbox
        WHERE portal_id = ?1 AND topic = 'contact.set_join_url'`,
    )
      .bind(values.portalId)
      .first<{ c: number }>();
    expect(joinUrl?.c).toBe(0);
  });
});

describe("selected modules: the parent course's own questions are enforced", () => {
  async function seedParentQuestion(
    values: ReturnType<typeof ids>,
    overrides: { required?: number; scope?: string } = {},
  ) {
    const questionId = `q-${values.portalId}`;
    await BASE_ENV.DB.prepare(
      `INSERT INTO registration_questions
         (id, portal_id, event_id, key, label, field_type, required, scope, sort_order, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'po_number', 'Purchase order number', 'text', ?4, ?5, 1, ?6, ?6)`,
    )
      .bind(
        questionId,
        values.portalId,
        values.parentId,
        overrides.required ?? 1,
        overrides.scope ?? 'order',
        new Date().toISOString(),
      )
      .run();
    return questionId;
  }

  it('refuses a booking that skips a required order-scoped parent question', async () => {
    const values = ids();
    await seedSelectedModuleCourse(values);
    await seedParentQuestion(values);
    const { env: testEnv } = queueEnv();

    const response = await app.request(
      `/api/v1/events/${values.parentId}/reserve-selected-modules`,
      reserveRequest(values, { idempotencyKey: crypto.randomUUID() }),
      testEnv,
    );

    expect(response.status).toBe(400);

    // Rejected BEFORE any hold: a paid hold runs to the invoice due date, so a seat
    // stranded by a validation failure would be out of sale for weeks.
    const reservations = await BASE_ENV.DB.prepare(
      'SELECT COUNT(*) AS c FROM reservations WHERE portal_id = ?1',
    )
      .bind(values.portalId)
      .first<{ c: number }>();
    expect(reservations?.c).toBe(0);
    const orders = await BASE_ENV.DB.prepare(
      'SELECT COUNT(*) AS c FROM orders WHERE portal_id = ?1',
    )
      .bind(values.portalId)
      .first<{ c: number }>();
    expect(orders?.c).toBe(0);
  });

  it('stores a supplied parent answer instead of discarding it', async () => {
    const values = ids();
    await seedSelectedModuleCourse(values);
    const questionId = await seedParentQuestion(values);
    const { env: testEnv } = queueEnv();

    const response = await app.request(
      `/api/v1/events/${values.parentId}/reserve-selected-modules`,
      reserveRequest(values, {
        idempotencyKey: crypto.randomUUID(),
        answers: { po_number: 'PO-4417' },
      }),
      testEnv,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { orderId: string };

    const answer = await BASE_ENV.DB.prepare(
      `SELECT order_id, question_id, value_text FROM registration_answers
        WHERE portal_id = ?1`,
    )
      .bind(values.portalId)
      .first<{ order_id: string; question_id: string; value_text: string }>();
    expect(answer).toMatchObject({
      order_id: body.orderId,
      question_id: questionId,
      value_text: 'PO-4417',
    });
  });

  it('refuses rather than guesses when the parent asks a per-attendee question', async () => {
    const values = ids();
    await seedSelectedModuleCourse(values);
    await seedParentQuestion(values, { scope: 'attendee', required: 0 });
    const { env: testEnv } = queueEnv();

    const response = await app.request(
      `/api/v1/events/${values.parentId}/reserve-selected-modules`,
      reserveRequest(values, { idempotencyKey: crypto.randomUUID() }),
      testEnv,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      status: 'selected_modules_questions_not_supported',
    });
  });
});

describe('selected modules: a losing concurrent request leaves no provider orphan', () => {
  it('cancels the provider registration it made when its batch loses the key race', async () => {
    const values = ids();
    await seedSelectedModuleCourse(values);
    await BASE_ENV.DB.prepare('UPDATE events SET provider = ?1 WHERE id = ?2')
      .bind('teams', values.firstModuleId)
      .run();
    const { env: testEnv } = queueEnv();
    teamsMock.cancelAttendeeInTeams.mockClear();
    const key = crypto.randomUUID();

    // Webinar registration has to happen before the batch, because the registration row
    // stores the ids it returns. So both requests register with the provider, and only then
    // does the UNIQUE index decide which booking exists. The loser has to undo its own.
    const responses = await Promise.all([
      app.request(
        `/api/v1/events/${values.parentId}/reserve-selected-modules`,
        reserveRequest(values, { idempotencyKey: key }),
        testEnv,
      ),
      app.request(
        `/api/v1/events/${values.parentId}/reserve-selected-modules`,
        reserveRequest(values, { idempotencyKey: key }),
        testEnv,
      ),
    ]);

    const winners = responses.filter((response) => response.status === 200);
    expect(winners).toHaveLength(1);

    const orders = await BASE_ENV.DB.prepare(
      'SELECT COUNT(*) AS c FROM orders WHERE portal_id = ?1',
    )
      .bind(values.portalId)
      .first<{ c: number }>();
    expect(orders?.c).toBe(1);

    // The loser registered with the provider and then failed to commit, so exactly one
    // cancellation is owed. A seat has its own expiry as a backstop; a provider
    // registration has none, and the attendee would hold a join URL to a booking nobody
    // sold them.
    expect(teamsMock.cancelAttendeeInTeams).toHaveBeenCalledTimes(1);
    const [, , providerName, webinarId, providerRegistrationId] =
      teamsMock.cancelAttendeeInTeams.mock.calls[0];
    expect(providerName).toBe('teams');
    expect(webinarId).toBe('webinar-selected-module');
    expect(String(providerRegistrationId)).toContain('provider-reg-');

    // And the surviving booking keeps its own registration: the rollback cancelled the
    // loser's, not the winner's.
    const survivor = await BASE_ENV.DB.prepare(
      `SELECT teams_registration_id FROM registrations
        WHERE portal_id = ?1 AND event_id = ?2`,
    )
      .bind(values.portalId, values.firstModuleId)
      .first<{ teams_registration_id: string | null }>();
    expect(survivor?.teams_registration_id).not.toBe(providerRegistrationId);
  });

  it('cancels nothing when the booking commits', async () => {
    const values = ids();
    await seedSelectedModuleCourse(values);
    await BASE_ENV.DB.prepare('UPDATE events SET provider = ?1 WHERE id = ?2')
      .bind('teams', values.firstModuleId)
      .run();
    const { env: testEnv } = queueEnv();
    teamsMock.cancelAttendeeInTeams.mockClear();

    const response = await app.request(
      `/api/v1/events/${values.parentId}/reserve-selected-modules`,
      reserveRequest(values, { idempotencyKey: crypto.randomUUID() }),
      testEnv,
    );
    expect(response.status).toBe(200);
    expect(teamsMock.cancelAttendeeInTeams).not.toHaveBeenCalled();
  });
});

describe('selected modules: the sales window (migration 0038)', () => {
  /** Nothing was held, nothing was ordered: the rejection has to come before the DO. */
  async function expectNothingBooked(values: ReturnType<typeof ids>) {
    const orders = await BASE_ENV.DB.prepare(
      'SELECT COUNT(*) AS c FROM orders WHERE portal_id = ?1',
    )
      .bind(values.portalId)
      .first<{ c: number }>();
    expect(orders?.c).toBe(0);
    const reservations = await BASE_ENV.DB.prepare(
      'SELECT COUNT(*) AS c FROM reservations WHERE portal_id = ?1',
    )
      .bind(values.portalId)
      .first<{ c: number }>();
    expect(reservations?.c).toBe(0);
  }

  it('refuses when the parent course has been paused by hand', async () => {
    const values = ids();
    await seedSelectedModuleCourse(values);
    await BASE_ENV.DB.prepare('UPDATE events SET sales_paused = 1 WHERE id = ?1')
      .bind(values.parentId)
      .run();
    const { env: testEnv } = queueEnv();

    const response = await app.request(
      `/api/v1/events/${values.parentId}/reserve-selected-modules`,
      reserveRequest(values, { idempotencyKey: crypto.randomUUID() }),
      testEnv,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ status: 'sales_paused' });
    await expectNothingBooked(values);
  });

  it("refuses when the parent course's cutoff has passed", async () => {
    const values = ids();
    await seedSelectedModuleCourse(values);
    await BASE_ENV.DB.prepare('UPDATE events SET registration_closes_at = ?1 WHERE id = ?2')
      .bind('2020-01-01T00:00:00.000Z', values.parentId)
      .run();
    const { env: testEnv } = queueEnv();

    const response = await app.request(
      `/api/v1/events/${values.parentId}/reserve-selected-modules`,
      reserveRequest(values, { idempotencyKey: crypto.randomUUID() }),
      testEnv,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ status: 'registration_closed' });
    await expectNothingBooked(values);
  });

  // A module is a separately sold session: a course still selling can carry one that ran
  // last week, so the parent's window cannot answer for it.
  it('refuses a selected module whose own cutoff has passed, and names it', async () => {
    const values = ids();
    await seedSelectedModuleCourse(values);
    await BASE_ENV.DB.prepare('UPDATE events SET registration_closes_at = ?1 WHERE id = ?2')
      .bind('2020-01-01T00:00:00.000Z', values.secondModuleId)
      .run();
    const { env: testEnv } = queueEnv();

    const response = await app.request(
      `/api/v1/events/${values.parentId}/reserve-selected-modules`,
      reserveRequest(values, {
        idempotencyKey: crypto.randomUUID(),
        modules: [
          {
            eventId: values.firstModuleId,
            ticketTypeId: values.firstTicketId,
            expectedUnitCents: 100000,
          },
          {
            eventId: values.secondModuleId,
            ticketTypeId: values.secondTicketId,
            expectedUnitCents: 150000,
          },
        ],
      }),
      testEnv,
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { status: string; message: string };
    expect(body.status).toBe('registration_closed');
    expect(body.message).toContain('IWE Module 2');
    await expectNothingBooked(values);
  });

  it('refuses a selected module whose ticket type alone is paused', async () => {
    const values = ids();
    await seedSelectedModuleCourse(values);
    await BASE_ENV.DB.prepare('UPDATE ticket_types SET sales_paused = 1 WHERE id = ?1')
      .bind(values.firstTicketId)
      .run();
    const { env: testEnv } = queueEnv();

    const response = await app.request(
      `/api/v1/events/${values.parentId}/reserve-selected-modules`,
      reserveRequest(values, { idempotencyKey: crypto.randomUUID() }),
      testEnv,
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ status: 'ticket_sales_paused' });
    await expectNothingBooked(values);
  });

  it('still sells a module the window leaves open', async () => {
    const values = ids();
    await seedSelectedModuleCourse(values);
    await BASE_ENV.DB.prepare('UPDATE events SET registration_closes_at = ?1 WHERE id = ?2')
      .bind(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), values.firstModuleId)
      .run();
    const { env: testEnv } = queueEnv();

    const response = await app.request(
      `/api/v1/events/${values.parentId}/reserve-selected-modules`,
      reserveRequest(values, { idempotencyKey: crypto.randomUUID() }),
      testEnv,
    );

    expect(response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// The price guard, which was the only one in the worker still symmetric.
//
// The single-seat path has been directional since the pricing_rules gaps were turning
// every drift into a failed booking: resolved ABOVE the quote is refused (we never
// invoice more than we displayed), resolved BELOW it is honoured. This path compared
// for exact equality, so a module that resolved cheaper than the page quoted failed the
// whole bundle with "The course price changed before checkout".
// ---------------------------------------------------------------------------
describe('selected modules: the price guard is directional', () => {
  it('honours a resolved price BELOW what the checkout displayed', async () => {
    const values = ids();
    await seedSelectedModuleCourse(values);
    const { env: testEnv } = queueEnv();

    const response = await app.request(
      `/api/v1/events/${values.parentId}/reserve-selected-modules`,
      reserveRequest(values, {
        idempotencyKey: crypto.randomUUID(),
        // Ticket is 100000; the page quoted 120000.
        modules: [
          {
            eventId: values.firstModuleId,
            ticketTypeId: values.firstTicketId,
            expectedUnitCents: 120000,
          },
        ],
      }),
      testEnv,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { orderId: string };
    const order = await BASE_ENV.DB.prepare(
      'SELECT total_cents FROM orders WHERE portal_id = ?1 AND id = ?2',
    )
      .bind(values.portalId, body.orderId)
      .first<{ total_cents: number }>();
    // Charged the lower resolved price, not the higher quote.
    expect(order?.total_cents).toBe(100000);
  });

  it('still refuses a resolved price ABOVE what the checkout displayed', async () => {
    const values = ids();
    await seedSelectedModuleCourse(values);
    const { env: testEnv } = queueEnv();

    const response = await app.request(
      `/api/v1/events/${values.parentId}/reserve-selected-modules`,
      reserveRequest(values, {
        idempotencyKey: crypto.randomUUID(),
        modules: [
          {
            eventId: values.firstModuleId,
            ticketTypeId: values.firstTicketId,
            expectedUnitCents: 90000,
          },
        ],
      }),
      testEnv,
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as { error?: string; code?: string };
    expect(JSON.stringify(body)).toContain('price_mismatch');

    const reservations = await BASE_ENV.DB.prepare(
      'SELECT COUNT(*) AS c FROM reservations WHERE portal_id = ?1',
    )
      .bind(values.portalId)
      .first<{ c: number }>();
    expect(reservations?.c).toBe(0);
  });
});
