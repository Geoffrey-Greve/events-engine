import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleOutboxMessage } from '../src/hubspot-writeback';
import {
  loadEventQuestions,
  QuestionValidationError,
  resolveQuestions,
  sameAnswerValue,
  validateAnswers,
} from '../src/questions';
import { listEventRegistrations, registrationsToCsv } from '../src/reporting';
import { manageRoutes } from '../src/routes/manage';
import { handleGetEventQuestions, handleGetOrder, handleReserve } from '../src/routes/reserve';
import { encryptToken } from '../src/token-crypto';
import type { Env } from '../src/types';

/**
 * Phase 2.3 — custom registration questions per event.
 *
 * The behaviours worth holding down are the ones the brief and the design argue for, not
 * the CRUD around them:
 *
 *   1. `required` is enforced in the WORKER. The form is a HubSpot CMS module a marketer
 *      can edit, and the staff and corporate booking paths never render it at all.
 *   2. An event's own question overrides the tenant-wide default with the same key.
 *   3. Answers commit in the same batch as the registration, and survive to the 2.2 export
 *      as their own columns.
 *   4. Archival keeps answers readable. There is no delete.
 *   5. The reuse half: an answer mapped to a contact property is written back — but a
 *      booking made by SOMEONE ELSE may only fill a gap, never overwrite. A colleague must
 *      not be able to erase a coeliac's dietary record through a bulk form.
 *   6. Nothing unauthenticated returns anybody's answers.
 */

const BASE_ENV = env as unknown as Env;
const TOKEN_KEY = '0'.repeat(64);

let counter = 0;
function freshIds() {
  const n = `${Date.now()}-${counter++}`;
  return {
    portalId: `q23-${n}`,
    adminKey: `admin-${n}`,
    eventId: `evt-q23-${n}`,
    hubspotEventId: `hs-q23-${n}`,
    ticketTypeId: `tt-q23-${n}`,
  };
}

type Ids = ReturnType<typeof freshIds>;

function envFor(ids: Ids): Env {
  return {
    ...(BASE_ENV as unknown as Record<string, unknown>),
    [`ADMIN_API_KEY_${ids.portalId}`]: ids.adminKey,
  } as unknown as Env;
}

function adminHeaders(ids: Ids, idempotencyKey = crypto.randomUUID()) {
  return {
    'X-Portal-Id': ids.portalId,
    Authorization: `Bearer ${ids.adminKey}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey,
  };
}

/** The public endpoints, mounted exactly as index.ts mounts them. */
const publicApp = new Hono<{ Bindings: Env }>();
publicApp.get('/api/v1/events/:slug/questions', handleGetEventQuestions);
publicApp.get('/api/v1/orders/:id', handleGetOrder);
publicApp.post('/api/v1/events/:slug/reserve', handleReserve);

/** A queue Message stub: records ack/retry so a test can assert how the row was settled. */
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function seedEvent(ids: Ids): Promise<void> {
  const now = new Date().toISOString();
  await BASE_ENV.DB.prepare(
    `INSERT INTO tenants
       (portal_id, stripe_processor_connected, xero_gst_rate_id,
        hs_access_token, hs_refresh_token, hs_token_expires_at, display_name)
     VALUES (?1, 1, 'hs-gst-rate', ?2, ?3, ?4, 'Test Tenant')`,
  )
    .bind(
      ids.portalId,
      await encryptToken(TOKEN_KEY, 'hs-access-token'),
      await encryptToken(TOKEN_KEY, 'hs-refresh-token'),
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    )
    .run();

  await BASE_ENV.DB.prepare(
    `INSERT INTO events
       (id, portal_id, hubspot_event_id, title, starts_at, ends_at, location, capacity,
        booking_kind, provider, allow_oversell, marketing_event_completed, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'Welding Fundamentals', ?4, ?5, 'Adelaide', 20,
             'course', NULL, 0, 0, ?4, ?4)`,
  )
    .bind(
      ids.eventId,
      ids.portalId,
      ids.hubspotEventId,
      now,
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    )
    .run();

  await BASE_ENV.DB.prepare(
    `INSERT INTO ticket_types
       (id, portal_id, event_id, name, price_cents, currency, capacity, tax_treatment,
        member_only, sort_order, created_at)
     VALUES (?1, ?2, ?3, 'Standard', 83500, 'AUD', 20, 'gst', 0, 0, ?4)`,
  )
    .bind(ids.ticketTypeId, ids.portalId, ids.eventId, now)
    .run();
}

interface QuestionSeed {
  key: string;
  label?: string;
  fieldType?: string;
  options?: unknown;
  required?: boolean;
  scope?: string;
  hsProperty?: string | null;
  prefill?: boolean;
  sortOrder?: number;
}

/** Create a question through the manage API — the same path staff use. */
async function createQuestion(
  ids: Ids,
  seed: QuestionSeed,
  opts: { eventId?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const path = opts.eventId ? `/events/${opts.eventId}/questions` : '/questions';
  const res = await manageRoutes.request(
    path,
    {
      method: 'POST',
      headers: adminHeaders(ids),
      body: JSON.stringify({
        label: seed.label ?? seed.key,
        fieldType: seed.fieldType ?? 'text',
        ...seed,
      }),
    },
    envFor(ids),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** HubSpot answers nothing useful — enough for reserve's optional lookups to degrade. */
function stubHubSpotSilent() {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ status: 'error', message: 'not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    ),
  );
}

/** A staff booking through the manage route, carrying answers. */
async function book(
  ids: Ids,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await manageRoutes.request(
    `/events/${ids.eventId}/registrations`,
    {
      method: 'POST',
      headers: adminHeaders(ids),
      body: JSON.stringify({
        mode: 'complimentary',
        ticketTypeId: ids.ticketTypeId,
        attendeeName: 'Sam Tan',
        attendeeEmail: 'sam@weld.test',
        ...body,
      }),
    },
    envFor(ids),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/**
 * A PUBLIC booking through the single-seat shorthand — `ticketTypeId`, no `attendees`
 * array, the buyer taking the seat themselves. This is the shape the CMS checkout sends,
 * and the one shape that cannot build its own attendee to hang answers off.
 *
 * The fixture event starts now, and migration 0038 closes public sales at the start, so
 * the start is pushed out first. Staff bookings through `book()` above are exempt from the
 * cutoff and do not need it.
 */
async function publicBook(
  ids: Ids,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  await BASE_ENV.DB.prepare('UPDATE events SET starts_at = ?1 WHERE id = ?2')
    .bind(new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(), ids.eventId)
    .run();

  const res = await publicApp.request(
    `/api/v1/events/${ids.eventId}/reserve`,
    {
      method: 'POST',
      headers: {
        'X-Portal-Id': ids.portalId,
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
        'CF-Connecting-IP': `10.0.3.${Math.floor(Math.random() * 250)}`,
      },
      body: JSON.stringify({
        buyer: { name: 'Sam Tan', email: 'sam@weld.test' },
        ticketTypeId: ids.ticketTypeId,
        ...body,
      }),
    },
    BASE_ENV,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Pure validation
// ---------------------------------------------------------------------------

const question = (over: Partial<Awaited<ReturnType<typeof loadEventQuestions>>[number]> = {}) => ({
  id: 'q1',
  key: 'dietary_requirements',
  label: 'Dietary requirements',
  fieldType: 'textarea' as const,
  options: null,
  required: false,
  scope: 'attendee' as const,
  helpText: null,
  sortOrder: 0,
  eventId: null,
  hsProperty: null,
  prefill: true,
  ...over,
});

describe('answer validation', () => {
  it('rejects a booking that skips a required question, naming who it is about', () => {
    expect(() =>
      validateAnswers({
        questions: [question({ required: true })],
        scope: 'attendee',
        supplied: {},
        subject: 'Sam Tan',
      }),
    ).toThrow(/required for Sam Tan/);
  });

  it('treats whitespace as no answer at all', () => {
    expect(() =>
      validateAnswers({
        questions: [question({ required: true })],
        scope: 'attendee',
        supplied: { dietary_requirements: '   ' },
      }),
    ).toThrow(QuestionValidationError);
  });

  it('stores an optional unanswered question as nothing, not as a blank', () => {
    const prepared = validateAnswers({
      questions: [question()],
      scope: 'attendee',
      supplied: {},
    });
    expect(prepared).toEqual([]);
  });

  it('keeps the line breaks someone typed into a textarea', () => {
    const prepared = validateAnswers({
      questions: [question()],
      scope: 'attendee',
      supplied: { dietary_requirements: '  Coeliac.\nAlso no shellfish.  ' },
    });
    expect(prepared[0].value).toBe('Coeliac.\nAlso no shellfish.');
  });

  it('rejects a select answer that is not one of the options', () => {
    const q = question({
      key: 'coffee',
      fieldType: 'select',
      options: [
        { value: 'flat_white', label: 'Flat white' },
        { value: 'long_black', label: 'Long black' },
      ],
    });
    expect(() =>
      validateAnswers({ questions: [q], scope: 'attendee', supplied: { coffee: 'affogato' } }),
    ).toThrow(/not an option/);
    expect(
      validateAnswers({ questions: [q], scope: 'attendee', supplied: { coffee: 'long_black' } })[0]
        .value,
    ).toBe('long_black');
  });

  it("joins a multiselect with HubSpot's own delimiter, deduped", () => {
    const q = question({
      key: 'access',
      fieldType: 'multiselect',
      options: [
        { value: 'wheelchair', label: 'Wheelchair' },
        { value: 'hearing_loop', label: 'Hearing loop' },
      ],
    });
    const prepared = validateAnswers({
      questions: [q],
      scope: 'attendee',
      supplied: { access: ['wheelchair', 'hearing_loop', 'wheelchair'] },
    });
    expect(prepared[0].value).toBe('wheelchair;hearing_loop');
  });

  it('records a false checkbox as an answer, distinct from never being asked', () => {
    const q = question({ key: 'parking', fieldType: 'checkbox' });
    const answered = validateAnswers({
      questions: [q],
      scope: 'attendee',
      supplied: { parking: false },
    });
    expect(answered[0].value).toBe('false');
    expect(validateAnswers({ questions: [q], scope: 'attendee', supplied: {} })).toEqual([]);
  });

  it('rejects an unknown key rather than silently dropping the answer', () => {
    expect(() =>
      validateAnswers({ questions: [question()], scope: 'attendee', supplied: { shirt: 'L' } }),
    ).toThrow(/does not ask "shirt"/);
  });

  it('says so when an order-level answer is sent per attendee', () => {
    const q = question({ key: 'po_number', scope: 'order', fieldType: 'text' });
    expect(() =>
      validateAnswers({ questions: [q], scope: 'attendee', supplied: { po_number: 'PO-1' } }),
    ).toThrow(/order-level question/);
  });

  it('only asks each scope its own questions', () => {
    const questions = [
      question({ id: 'a', key: 'dietary_requirements', required: true }),
      question({ id: 'b', key: 'po_number', scope: 'order', fieldType: 'text', required: true }),
    ];
    // The attendee scope must not demand the order's required question, or a booking could
    // never satisfy both at once.
    const attendee = validateAnswers({
      questions,
      scope: 'attendee',
      supplied: { dietary_requirements: 'None' },
    });
    expect(attendee.map((a) => a.key)).toEqual(['dietary_requirements']);
  });
});

describe('resolveQuestions', () => {
  it("lets an event's own question override the tenant-wide default with the same key", () => {
    const resolved = resolveQuestions([
      question({ id: 'tenant', label: 'Dietary requirements', eventId: null }),
      question({ id: 'event', label: 'Any allergies for the site BBQ?', eventId: 'evt-1' }),
    ]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].id).toBe('event');
  });

  it('orders by sort_order, then by key so an export column order is stable', () => {
    const resolved = resolveQuestions([
      question({ id: '1', key: 'zebra', sortOrder: 0 }),
      question({ id: '2', key: 'apple', sortOrder: 0 }),
      question({ id: '3', key: 'first', sortOrder: -1 }),
    ]);
    expect(resolved.map((q) => q.key)).toEqual(['first', 'apple', 'zebra']);
  });
});

describe('sameAnswerValue', () => {
  it('ignores reformatting, and compares a multiselect as a set', () => {
    expect(sameAnswerValue('textarea', 'Vegetarian ', 'vegetarian')).toBe(true);
    expect(sameAnswerValue('multiselect', 'a;b', 'b;a')).toBe(true);
    expect(sameAnswerValue('multiselect', 'a;b', 'a')).toBe(false);
    expect(sameAnswerValue('textarea', 'Vegan', 'Vegetarian')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Definitions through the manage API
// ---------------------------------------------------------------------------

describe('question definitions', () => {
  it('requires admin authentication', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    const res = await manageRoutes.request(
      '/questions',
      { method: 'GET', headers: { 'X-Portal-Id': ids.portalId } },
      envFor(ids),
    );
    expect(res.status).toBe(401);
  });

  it('refuses a definition that could never be answered', async () => {
    const ids = freshIds();
    await seedEvent(ids);

    expect((await createQuestion(ids, { key: 'Coffee Choice' })).body.status).toBe('invalid_key');
    expect((await createQuestion(ids, { key: 'coffee', fieldType: 'select' })).body.status).toBe(
      'missing_options',
    );
    expect(
      (
        await createQuestion(ids, {
          key: 'coffee',
          fieldType: 'select',
          options: [{ value: 'flat;white', label: 'Flat white' }],
        })
      ).body.status,
    ).toBe('invalid_option');
    // An order-scoped question has no attendee whose contact to write to.
    expect(
      (
        await createQuestion(ids, {
          key: 'po_number',
          scope: 'order',
          hsProperty: 'purchase_order',
        })
      ).body.status,
    ).toBe('invalid_hs_property');
  });

  it('refuses a second live question with the same key at the same level', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    expect((await createQuestion(ids, { key: 'shirt_size' })).status).toBe(201);
    const second = await createQuestion(ids, { key: 'shirt_size' });
    expect(second.status).toBe(409);
    expect(second.body.status).toBe('duplicate_key');
  });

  it("returns the resolved set an event's form should render", async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await createQuestion(ids, { key: 'dietary_requirements', fieldType: 'textarea' });
    await createQuestion(
      ids,
      { key: 'dietary_requirements', label: 'Allergies for the site BBQ', fieldType: 'textarea' },
      { eventId: ids.eventId },
    );
    await createQuestion(ids, { key: 'shirt_size', sortOrder: 5 });

    const res = await manageRoutes.request(
      `/events/${ids.eventId}/questions`,
      { headers: adminHeaders(ids) },
      envFor(ids),
    );
    const questions = (await res.json()) as { key: string; label: string; eventId: string }[];
    expect(questions.map((q) => q.key)).toEqual(['dietary_requirements', 'shirt_size']);
    expect(questions[0].label).toBe('Allergies for the site BBQ');
    expect(questions[0].eventId).toBe(ids.eventId);
  });

  it('refuses to change what stored answers mean', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    const created = await createQuestion(ids, { key: 'shirt_size' });
    const questionId = (created.body.question as { id: string }).id;

    for (const patch of [{ key: 'tshirt_size' }, { fieldType: 'select' }, { scope: 'order' }]) {
      const res = await manageRoutes.request(
        `/questions/${questionId}`,
        { method: 'PATCH', headers: adminHeaders(ids), body: JSON.stringify(patch) },
        envFor(ids),
      );
      expect(res.status).toBe(409);
      expect(((await res.json()) as { status: string }).status).toBe('immutable_field');
    }

    // The presentation is editable.
    const ok = await manageRoutes.request(
      `/questions/${questionId}`,
      {
        method: 'PATCH',
        headers: adminHeaders(ids),
        body: JSON.stringify({ label: 'T-shirt size', required: true, sortOrder: 3 }),
      },
      envFor(ids),
    );
    expect(ok.status).toBe(200);
    const patched = (await ok.json()) as { question: { label: string; required: boolean } };
    expect(patched.question).toMatchObject({ label: 'T-shirt size', required: true });
  });

  it('archives rather than deletes, and stops asking', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    const created = await createQuestion(ids, { key: 'shirt_size' });
    const questionId = (created.body.question as { id: string }).id;

    const res = await manageRoutes.request(
      `/questions/${questionId}`,
      { method: 'DELETE', headers: adminHeaders(ids) },
      envFor(ids),
    );
    expect(res.status).toBe(200);

    // Gone from what the event asks…
    expect(await loadEventQuestions(BASE_ENV, ids.portalId, ids.eventId)).toEqual([]);
    // …but the row is still there, with its answers still reachable.
    const listed = await manageRoutes.request(
      '/questions?includeArchived=1',
      { headers: adminHeaders(ids) },
      envFor(ids),
    );
    const rows = (await listed.json()) as { id: string; archivedAt: string | null }[];
    expect(rows.find((row) => row.id === questionId)?.archivedAt).toBeTruthy();

    // Archiving frees the key for a replacement.
    expect((await createQuestion(ids, { key: 'shirt_size' })).status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// The public endpoint
// ---------------------------------------------------------------------------

describe('GET /api/v1/events/:slug/questions', () => {
  it('returns definitions, including the property the CMS prefills from', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await createQuestion(ids, {
      key: 'dietary_requirements',
      fieldType: 'textarea',
      hsProperty: 'dietary_requirements',
    });

    const res = await publicApp.request(
      `/api/v1/events/${ids.eventId}/questions`,
      { headers: { 'X-Portal-Id': ids.portalId } },
      envFor(ids),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      questions: { key: string; hsProperty: string; prefill: boolean }[];
    };
    expect(body.questions[0]).toMatchObject({
      key: 'dietary_requirements',
      hsProperty: 'dietary_requirements',
      prefill: true,
    });
  });

  it("hands out nobody's answers, however it is asked", async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await createQuestion(ids, {
      key: 'dietary_requirements',
      fieldType: 'textarea',
      hsProperty: 'dietary_requirements',
    });
    stubHubSpotSilent();
    await book(ids, { answers: { dietary_requirements: 'Coeliac' } });

    const res = await publicApp.request(
      `/api/v1/events/${ids.eventId}/questions?email=sam@weld.test`,
      { headers: { 'X-Portal-Id': ids.portalId } },
      envFor(ids),
    );
    expect(await res.text()).not.toContain('Coeliac');
  });
});

// ---------------------------------------------------------------------------
// Capture at reserve time
// ---------------------------------------------------------------------------

describe('answers are captured with the reservation', () => {
  it('rejects a booking that skips a required question, and holds no seat for it', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await createQuestion(ids, {
      key: 'dietary_requirements',
      fieldType: 'textarea',
      required: true,
    });
    stubHubSpotSilent();

    const result = await book(ids, {});
    expect(result.status).toBe(400);
    expect(result.body.status).toBe('missing_required_answer');

    // Nothing was written: no order, no registration, and no seat taken out of sale.
    const orders = await BASE_ENV.DB.prepare(
      'SELECT COUNT(*) AS n FROM orders WHERE portal_id = ?1',
    )
      .bind(ids.portalId)
      .first<{ n: number }>();
    expect(orders?.n).toBe(0);
  });

  it('persists attendee and order answers against the right targets', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await createQuestion(ids, { key: 'dietary_requirements', fieldType: 'textarea' });
    await createQuestion(ids, { key: 'po_number', scope: 'order', fieldType: 'text' });
    stubHubSpotSilent();

    const result = await book(ids, {
      answers: { dietary_requirements: 'Coeliac' },
      orderAnswers: { po_number: 'PO-4471' },
    });
    expect(result.status).toBe(200);
    const registrationId = (result.body.registrationIds as string[])[0];
    const orderId = result.body.orderId as string;

    const rows = await BASE_ENV.DB.prepare(
      `SELECT q.key AS key, a.value_text AS value, a.registration_id AS reg, a.order_id AS ord
         FROM registration_answers a
         JOIN registration_questions q ON q.id = a.question_id
        WHERE a.portal_id = ?1 ORDER BY q.key`,
    )
      .bind(ids.portalId)
      .all<{ key: string; value: string; reg: string | null; ord: string | null }>();

    expect(rows.results).toEqual([
      { key: 'dietary_requirements', value: 'Coeliac', reg: registrationId, ord: null },
      { key: 'po_number', value: 'PO-4471', reg: null, ord: orderId },
    ]);
  });

  it('lets the public single-seat shorthand answer an attendee question', async () => {
    // The buyer IS the attendee on this path, and the worker builds that attendee itself.
    // Before `attendeeAnswers` there was nowhere on the wire to put their answer, so a
    // REQUIRED attendee question made every public one-seat booking impossible: the form
    // had no field that would satisfy it and no field that would be accepted.
    const ids = freshIds();
    await seedEvent(ids);
    await createQuestion(ids, {
      key: 'dietary_requirements',
      fieldType: 'textarea',
      required: true,
    });
    stubHubSpotSilent();

    const result = await publicBook(ids, {
      attendeeAnswers: { dietary_requirements: 'Coeliac' },
    });
    expect(result.body.status).toBe('reserved');

    const row = await BASE_ENV.DB.prepare(
      `SELECT a.value_text AS value, a.registration_id AS reg
         FROM registration_answers a
         JOIN registration_questions q ON q.id = a.question_id
        WHERE a.portal_id = ?1 AND q.key = 'dietary_requirements'`,
    )
      .bind(ids.portalId)
      .first<{ value: string; reg: string | null }>();
    expect(row?.value).toBe('Coeliac');
    // Against the SEAT, not the booking — it is an attendee-scoped question.
    expect(row?.reg).toBeTruthy();
  });

  it('still refuses the shorthand when the required answer is simply missing', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await createQuestion(ids, { key: 'dietary_requirements', required: true });
    stubHubSpotSilent();

    const result = await publicBook(ids, {});
    expect(result.status).toBe(400);
    expect(result.body.status).toBe('missing_required_answer');
  });

  it('rejects an attendee question sent in the ORDER answers, by name', async () => {
    // The two scopes validate against different question sets, which is why they are two
    // fields rather than one the worker has to guess about.
    const ids = freshIds();
    await seedEvent(ids);
    await createQuestion(ids, { key: 'dietary_requirements' });
    stubHubSpotSilent();

    const result = await publicBook(ids, { answers: { dietary_requirements: 'Coeliac' } });
    expect(result.status).toBe(400);
    expect(result.body.status).toBe('unknown_question');
    expect(String(result.body.message)).toContain('attendee-level');
  });

  it('raises no write-back row for a question that maps to no property', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await createQuestion(ids, { key: 'workshop_stream', fieldType: 'text' });
    stubHubSpotSilent();
    await book(ids, { answers: { workshop_stream: 'Structural' } });

    const outbox = await BASE_ENV.DB.prepare(
      `SELECT COUNT(*) AS n FROM outbox WHERE portal_id = ?1 AND topic = 'contact.sync_answers'`,
    )
      .bind(ids.portalId)
      .first<{ n: number }>();
    expect(outbox?.n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The 2.2 export
// ---------------------------------------------------------------------------

describe('answers reach the 2.2 export', () => {
  it('gives every question its own CSV column, answered or not', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await createQuestion(ids, { key: 'dietary_requirements', fieldType: 'textarea' });
    await createQuestion(ids, { key: 'po_number', scope: 'order', fieldType: 'text' });
    // Asked, but nobody answers it — the empty column IS the answer to "did anyone declare
    // an allergy", where a missing column reads as the export being wrong.
    await createQuestion(ids, { key: 'shirt_size', fieldType: 'text' });
    stubHubSpotSilent();

    await book(ids, {
      answers: { dietary_requirements: 'Coeliac' },
      orderAnswers: { po_number: 'PO-4471' },
    });

    const rows = await listEventRegistrations(BASE_ENV, ids.portalId, ids.eventId);
    expect(rows).toHaveLength(1);
    // The booking's order-scoped answer shows against the attendee too: it is true of the
    // seat, and staff read one row per person.
    expect(rows[0].answers.map((a) => [a.key, a.value, a.scope])).toEqual(
      expect.arrayContaining([
        ['dietary_requirements', 'Coeliac', 'attendee'],
        ['po_number', 'PO-4471', 'order'],
      ]),
    );

    const questions = await loadEventQuestions(BASE_ENV, ids.portalId, ids.eventId);
    const csv = registrationsToCsv(rows, questions);
    const [header, body] = csv.split('\r\n');
    expect(header.split(',')).toEqual(
      expect.arrayContaining([
        'question_dietary_requirements',
        'question_po_number',
        'question_shirt_size',
      ]),
    );
    const columns = header.split(',');
    const cells = body.split(',');
    expect(cells[columns.indexOf('question_dietary_requirements')]).toBe('Coeliac');
    expect(cells[columns.indexOf('question_po_number')]).toBe('PO-4471');
    expect(cells[columns.indexOf('question_shirt_size')]).toBe('');
  });

  it('keeps the column for a question that has since been archived', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    const created = await createQuestion(ids, { key: 'shirt_size', fieldType: 'text' });
    stubHubSpotSilent();
    await book(ids, { answers: { shirt_size: 'L' } });

    await manageRoutes.request(
      `/questions/${(created.body.question as { id: string }).id}`,
      { method: 'DELETE', headers: adminHeaders(ids) },
      envFor(ids),
    );

    const rows = await listEventRegistrations(BASE_ENV, ids.portalId, ids.eventId);
    const questions = await loadEventQuestions(BASE_ENV, ids.portalId, ids.eventId);
    expect(questions).toEqual([]);
    const csv = registrationsToCsv(rows, questions);
    expect(csv.split('\r\n')[0]).toContain('question_shirt_size');
    expect(csv).toContain('L');
  });

  it('neutralises an answer a spreadsheet would execute', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await createQuestion(ids, { key: 'notes_for_venue', fieldType: 'textarea' });
    stubHubSpotSilent();
    await book(ids, { answers: { notes_for_venue: '=cmd|calc' } });

    const rows = await listEventRegistrations(BASE_ENV, ids.portalId, ids.eventId);
    const csv = registrationsToCsv(rows, []);
    expect(csv).toContain("'=cmd|calc");
    expect(csv).not.toMatch(/,=cmd/);
  });
});

// ---------------------------------------------------------------------------
// Write-back: reuse of the contact field
// ---------------------------------------------------------------------------

/** Captures HubSpot traffic; `existing` is what the contact already holds (null = no contact). */
function stubHubSpotContact(existing: Record<string, string> | null) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });

      if (method === 'GET' && url.includes('/crm/v3/objects/contacts/')) {
        if (existing === null) {
          return new Response(JSON.stringify({ message: 'not found' }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ id: 'contact-7', properties: existing }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ id: 'contact-7' }), {
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

async function enqueueAnswerSync(
  ids: Ids,
  payload: Record<string, unknown>,
): Promise<{ outboxId: string }> {
  const outboxId = crypto.randomUUID();
  await BASE_ENV.DB.prepare(
    `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
     VALUES (?1, ?2, 'contact.sync_answers', ?3, ?4)`,
  )
    .bind(outboxId, ids.portalId, JSON.stringify(payload), new Date().toISOString())
    .run();
  return { outboxId };
}

const dietaryPayload = (over: Record<string, unknown> = {}) => ({
  registrationId: 'reg-x',
  attendeeEmail: 'sam@weld.test',
  attendeeName: 'Sam Tan',
  selfDeclared: true,
  answers: [
    {
      key: 'dietary_requirements',
      property: 'dietary_requirements',
      value: 'Vegan',
      fieldType: 'textarea',
    },
  ],
  ...over,
});

describe('contact.sync_answers', () => {
  it("raises a write-back row for a mapped answer, marked as the attendee's own", async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await createQuestion(ids, {
      key: 'dietary_requirements',
      fieldType: 'textarea',
      hsProperty: 'dietary_requirements',
    });
    stubHubSpotSilent();
    // The attendee IS the buyer here: the manual route defaults buyerEmail to the attendee.
    await book(ids, { answers: { dietary_requirements: 'Coeliac' } });

    const row = await BASE_ENV.DB.prepare(
      `SELECT payload FROM outbox WHERE portal_id = ?1 AND topic = 'contact.sync_answers'`,
    )
      .bind(ids.portalId)
      .first<{ payload: string }>();
    expect(JSON.parse(row?.payload ?? '{}')).toMatchObject({
      attendeeEmail: 'sam@weld.test',
      selfDeclared: true,
      answers: [
        {
          key: 'dietary_requirements',
          property: 'dietary_requirements',
          value: 'Coeliac',
        },
      ],
    });
  });

  it('marks a booking made for someone else as not self-declared', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await createQuestion(ids, {
      key: 'dietary_requirements',
      fieldType: 'textarea',
      hsProperty: 'dietary_requirements',
    });
    stubHubSpotSilent();
    await book(ids, {
      buyerEmail: 'office@weld.test',
      buyerName: 'Office Manager',
      answers: { dietary_requirements: 'None' },
    });

    const row = await BASE_ENV.DB.prepare(
      `SELECT payload FROM outbox WHERE portal_id = ?1 AND topic = 'contact.sync_answers'`,
    )
      .bind(ids.portalId)
      .first<{ payload: string }>();
    expect(JSON.parse(row?.payload ?? '{}').selfDeclared).toBe(false);
  });

  it('replaces a stored value when the attendee answered about themselves', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    const calls = stubHubSpotContact({ dietary_requirements: 'Vegetarian' });
    const { outboxId } = await enqueueAnswerSync(ids, dietaryPayload());

    const { msg, state } = fakeMessage({
      kind: 'contact.sync_answers',
      portalId: ids.portalId,
      outboxId,
    });
    await handleOutboxMessage(msg, BASE_ENV);
    expect(state.acked).toBe(true);

    const patch = calls.find((c) => c.method === 'PATCH');
    expect((patch?.body as { properties: Record<string, string> }).properties).toEqual({
      dietary_requirements: 'Vegan',
    });
  });

  it("never overwrites when someone ELSE answered on the attendee's behalf", async () => {
    const ids = freshIds();
    await seedEvent(ids);
    const calls = stubHubSpotContact({ dietary_requirements: 'Coeliac — severe' });
    const { outboxId } = await enqueueAnswerSync(
      ids,
      dietaryPayload({
        selfDeclared: false,
        answers: [
          {
            key: 'dietary_requirements',
            property: 'dietary_requirements',
            value: 'None',
            fieldType: 'textarea',
          },
        ],
      }),
    );

    const { msg, state } = fakeMessage({
      kind: 'contact.sync_answers',
      portalId: ids.portalId,
      outboxId,
    });
    await handleOutboxMessage(msg, BASE_ENV);
    expect(state.acked).toBe(true);

    // The stored answer stands. A colleague ticking "None" must not erase it.
    expect(calls.find((c) => c.method === 'PATCH')).toBeUndefined();
  });

  it('fills a gap even when someone else answered — there is nothing to lose', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    const calls = stubHubSpotContact({ dietary_requirements: '' });
    const { outboxId } = await enqueueAnswerSync(ids, dietaryPayload({ selfDeclared: false }));

    const { msg } = fakeMessage({
      kind: 'contact.sync_answers',
      portalId: ids.portalId,
      outboxId,
    });
    await handleOutboxMessage(msg, BASE_ENV);

    expect(
      (calls.find((c) => c.method === 'PATCH')?.body as { properties: Record<string, string> })
        .properties,
    ).toEqual({ dietary_requirements: 'Vegan' });
  });

  it('writes nothing when HubSpot already says the same thing', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    const calls = stubHubSpotContact({ dietary_requirements: 'vegan ' });
    const { outboxId } = await enqueueAnswerSync(ids, dietaryPayload({ selfDeclared: false }));

    const { msg } = fakeMessage({
      kind: 'contact.sync_answers',
      portalId: ids.portalId,
      outboxId,
    });
    await handleOutboxMessage(msg, BASE_ENV);
    expect(calls.find((c) => c.method === 'PATCH')).toBeUndefined();
  });

  it("carries the attendee's name when it has to create the contact", async () => {
    const ids = freshIds();
    await seedEvent(ids);
    const calls = stubHubSpotContact(null);
    const { outboxId } = await enqueueAnswerSync(ids, dietaryPayload());

    const { msg } = fakeMessage({
      kind: 'contact.sync_answers',
      portalId: ids.portalId,
      outboxId,
    });
    await handleOutboxMessage(msg, BASE_ENV);

    expect(
      (calls.find((c) => c.method === 'PATCH')?.body as { properties: Record<string, string> })
        .properties,
    ).toMatchObject({
      email: 'sam@weld.test',
      firstname: 'Sam',
      lastname: 'Tan',
      dietary_requirements: 'Vegan',
    });
  });
});

// ---------------------------------------------------------------------------
// Staff prefill
// ---------------------------------------------------------------------------

describe('GET /events/:id/questions/prefill', () => {
  it('offers back what the contact already holds, for prefillable questions only', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await createQuestion(ids, {
      key: 'dietary_requirements',
      fieldType: 'textarea',
      hsProperty: 'dietary_requirements',
    });
    await createQuestion(ids, {
      key: 'photo_consent',
      fieldType: 'checkbox',
      hsProperty: 'photo_consent',
      // Mapped for reporting, but must be given fresh each event.
      prefill: false,
    });
    stubHubSpotContact({ dietary_requirements: 'Coeliac', photo_consent: 'true' });

    const res = await manageRoutes.request(
      `/events/${ids.eventId}/questions/prefill?email=sam@weld.test`,
      { headers: adminHeaders(ids) },
      envFor(ids),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      email: 'sam@weld.test',
      answers: { dietary_requirements: 'Coeliac' },
    });
  });

  it('reports a first-time attendee as having nothing stored, not as an error', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    await createQuestion(ids, {
      key: 'dietary_requirements',
      fieldType: 'textarea',
      hsProperty: 'dietary_requirements',
    });
    stubHubSpotContact(null);

    const res = await manageRoutes.request(
      `/events/${ids.eventId}/questions/prefill?email=new@weld.test`,
      { headers: adminHeaders(ids) },
      envFor(ids),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { answers: unknown }).answers).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// The mapped contact property is created through the OUTBOX (Ref 74)
//
// Creating it is a HubSpot side effect, and the worker's first invariant is that a side
// effect goes in the same D1 transaction as the state change and drains through the queue.
// Done inline, a timeout left the question stored and the editor told the save had failed,
// and the retry could only ever earn `duplicate_key`.
// ---------------------------------------------------------------------------

/** Records every call, answering 404 for the property GET so a create is what follows. */
function stubHubSpotProperty(options: { exists?: boolean; createFails?: boolean } = {}) {
  const calls: Array<{ method: string; url: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url });

      if (method === 'GET' && url.includes('/crm/v3/properties/contacts/')) {
        if (options.exists) {
          return new Response(JSON.stringify({ name: 'dietary_requirements' }), {
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ message: 'not found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (method === 'POST' && url.endsWith('/crm/v3/properties/contacts')) {
        if (options.createFails) {
          return new Response(JSON.stringify({ message: 'upstream unavailable' }), {
            status: 502,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ name: 'dietary_requirements' }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({}), { headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}

const propertyCreates = (calls: Array<{ method: string; url: string }>) =>
  calls.filter(
    (call) => call.method === 'POST' && call.url.endsWith('/crm/v3/properties/contacts'),
  );

async function propertyOutboxRow(portalId: string) {
  return BASE_ENV.DB.prepare(
    `SELECT id, status, payload FROM outbox
      WHERE portal_id = ?1 AND topic = 'question.ensure_property'`,
  )
    .bind(portalId)
    .first<{ id: string; status: string; payload: string }>();
}

describe('a question’s contact property is created through the outbox', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('enqueues the create instead of POSTing it from the request', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    const calls = stubHubSpotProperty();

    const created = await createQuestion(ids, {
      key: 'dietary_requirements',
      fieldType: 'textarea',
      hsProperty: 'dietary_requirements',
      // biome-ignore lint/suspicious/noExplicitAny: the create flag rides the same body
      ...({ createHsProperty: true } as any),
    });

    expect(created.status).toBe(201);
    // The request still READS — an admin is owed "that property does not exist" now — but
    // it must not have written.
    expect(propertyCreates(calls)).toHaveLength(0);
    expect(created.body.hsProperty).toMatchObject({
      property: 'dietary_requirements',
      status: 'missing',
      queued: true,
    });

    const row = await propertyOutboxRow(ids.portalId);
    expect(row?.status).toBe('pending');
    expect(JSON.parse(row?.payload ?? '{}')).toMatchObject({ hsProperty: 'dietary_requirements' });
  });

  it('creates the property when the row drains, and a replay writes nothing', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    stubHubSpotProperty();
    await createQuestion(ids, {
      key: 'dietary_requirements',
      fieldType: 'textarea',
      hsProperty: 'dietary_requirements',
      // biome-ignore lint/suspicious/noExplicitAny: the create flag rides the same body
      ...({ createHsProperty: true } as any),
    });
    const row = await propertyOutboxRow(ids.portalId);

    const calls = stubHubSpotProperty();
    const first = fakeMessage({
      kind: 'question.ensure_property',
      portalId: ids.portalId,
      outboxId: row?.id,
    });
    await handleOutboxMessage(first.msg, BASE_ENV);
    expect(first.state.acked).toBe(true);
    expect(propertyCreates(calls)).toHaveLength(1);
    expect((await propertyOutboxRow(ids.portalId))?.status).toBe('delivered');

    // A delivered row is not re-driven, and even if it were, the GET-then-create shape
    // means an existing property is left exactly as it is.
    const replayCalls = stubHubSpotProperty({ exists: true });
    const second = fakeMessage({
      kind: 'question.ensure_property',
      portalId: ids.portalId,
      outboxId: row?.id,
    });
    await handleOutboxMessage(second.msg, BASE_ENV);
    expect(propertyCreates(replayCalls)).toHaveLength(0);
  });

  it('retries the create without losing the question', async () => {
    const ids = freshIds();
    await seedEvent(ids);
    stubHubSpotProperty();
    const created = await createQuestion(ids, {
      key: 'dietary_requirements',
      fieldType: 'textarea',
      hsProperty: 'dietary_requirements',
      // biome-ignore lint/suspicious/noExplicitAny: the create flag rides the same body
      ...({ createHsProperty: true } as any),
    });
    expect(created.status).toBe(201);

    const row = await propertyOutboxRow(ids.portalId);
    stubHubSpotProperty({ createFails: true });
    const { msg, state } = fakeMessage({
      kind: 'question.ensure_property',
      portalId: ids.portalId,
      outboxId: row?.id,
    });
    await handleOutboxMessage(msg, BASE_ENV);

    expect(state.retried).toBe(true);
    expect((await propertyOutboxRow(ids.portalId))?.status).toBe('failed');
    // The whole point: the question itself survived the failed side effect.
    const questions = await BASE_ENV.DB.prepare(
      'SELECT COUNT(*) AS c FROM registration_questions WHERE portal_id = ?1',
    )
      .bind(ids.portalId)
      .first<{ c: number }>();
    expect(questions?.c).toBe(1);
  });
});
