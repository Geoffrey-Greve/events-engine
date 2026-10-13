import { env } from 'cloudflare:test';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleOutboxMessage } from '../src/hubspot-writeback';
import { matchesValue, resolveInvoiceEligibility } from '../src/invoice-eligibility';
import { reissueInvoice } from '../src/reissue-invoice';
import { manageRoutes } from '../src/routes/manage';
import { DEFAULT_INVOICE_DUE_DAYS, handleGetOrder, handleReserve } from '../src/routes/reserve';
import { encryptToken } from '../src/token-crypto';
import type { Env } from '../src/types';
import { seedTenant } from './support/fixtures';

/**
 * Phase 4.2 — WHO qualifies to pay on invoice terms.
 *
 * 4.1 gave the long hold to every paid booking, which fixed the AWS D1.1 fault by being
 * indiscriminate. These tests pin the gate that narrows it, and — first and loudest — pin
 * the thing that must NOT change: a portal with no rules keeps the long hold. A gate that
 * defaults to "nobody qualifies" would reinstate the fifteen-minute hold for every existing
 * tenant the moment it deployed, which is the fault, not the fix.
 */

const BASE_ENV = env as unknown as Env;
let counter = 0;

// Registers the portal as it mints it: every portal-scoped row REFERENCES `tenants`.
async function freshIds() {
  const n = `${Date.now()}-${counter++}`;
  const portalId = `elig-${n}`;
  await seedTenant(BASE_ENV.DB, portalId);
  return {
    portalId,
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

type Ids = Awaited<ReturnType<typeof freshIds>>;

async function seedEvent(
  values: Ids,
  options: { priceCents?: number; eventInvoiceDueDays?: number | null } = {},
) {
  const { priceCents = 120_000, eventInvoiceDueDays = null } = options;
  const now = new Date().toISOString();

  await BASE_ENV.DB.prepare(
    `UPDATE tenants
        SET display_name = 'Weld Australia (test)', stripe_processor_connected = 1,
            xero_gst_rate_id = 'hs-gst-rate'
      WHERE portal_id = ?1`,
  )
    .bind(values.portalId)
    .run();

  await BASE_ENV.DB.prepare(
    `INSERT INTO events
       (id, portal_id, hubspot_event_id, title, starts_at, ends_at, location, capacity,
        booking_kind, provider, allow_oversell, marketing_event_completed,
        invoice_due_days, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'AWS D1.1 Structural Welding', ?4, ?5, 'Adelaide', 20,
             'course', NULL, 0, 0, ?6, ?7, ?7)`,
  )
    .bind(
      values.eventId,
      values.portalId,
      values.hubspotEventId,
      // Beyond any terms these rules grant, so the due date is the rule's and not the
      // session-start cap's. See capDueDateToEventStart.
      new Date(Date.now() + 200 * 24 * 60 * 60 * 1000).toISOString(),
      new Date(Date.now() + 201 * 24 * 60 * 60 * 1000).toISOString(),
      eventInvoiceDueDays,
      now,
    )
    .run();

  await BASE_ENV.DB.prepare(
    `INSERT INTO ticket_types
       (id, portal_id, event_id, name, price_cents, currency, capacity, tax_treatment,
        member_only, sort_order, created_at)
     VALUES (?1, ?2, ?3, 'Standard', ?4, 'AUD', 20, 'gst', 0, 0, ?5)`,
  )
    .bind(values.ticketTypeId, values.portalId, values.eventId, priceCents, now)
    .run();
}

interface RuleInput {
  matchKind: string;
  matchKey?: string | null;
  matchValue?: string | null;
  termsDays?: number;
  holdMs?: number | null;
  minCents?: number | null;
  priority?: number;
  active?: number;
}

async function addRule(portalId: string, rule: RuleInput): Promise<string> {
  const id = crypto.randomUUID();
  await BASE_ENV.DB.prepare(
    `INSERT INTO invoice_eligibility_rules
       (id, portal_id, match_kind, match_key, match_value, terms_days, hold_ms,
        min_cents, priority, active, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  )
    .bind(
      id,
      portalId,
      rule.matchKind,
      rule.matchKey ?? null,
      rule.matchValue ?? null,
      rule.termsDays ?? 30,
      rule.holdMs ?? null,
      rule.minCents ?? null,
      rule.priority ?? 0,
      rule.active ?? 1,
      new Date().toISOString(),
    )
    .run();
  return id;
}

const MEMBER = {
  isMember: true,
  verified: true,
  level: 'gold',
  category: 'corporate',
} as const;
const NON_MEMBER = {
  isMember: false,
  verified: true,
  level: null,
  category: null,
} as const;
const UNVERIFIED = {
  isMember: false,
  verified: false,
  level: null,
  category: null,
} as const;

/** Reserve reaches HubSpot for membership; 404 keeps it unverified and offline. */
function stubHubSpotMissing() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 404 })),
  );
}

const publicApp = new Hono<{ Bindings: Env }>();
publicApp.post('/api/v1/events/:slug/reserve', handleReserve);
publicApp.get('/api/v1/orders/:id', handleGetOrder);

async function publicReserve(values: Ids, email = 'danielle@example.com', reserveEnv?: Env) {
  return publicApp.request(
    `/api/v1/events/${values.eventId}/reserve`,
    {
      method: 'POST',
      headers: {
        'X-Portal-Id': values.portalId,
        'Content-Type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
        'CF-Connecting-IP': `10.1.0.${counter % 250}`,
      },
      body: JSON.stringify({
        buyer: { name: 'Danielle Buyer', email },
        ticketTypeId: values.ticketTypeId,
      }),
    },
    reserveEnv ?? BASE_ENV,
  );
}

/**
 * An env whose HubSpot reads can actually be attempted. A rule the worker cannot evaluate
 * fails OPEN, so a test that means to exercise the INELIGIBLE path has to give the resolver
 * a real "no" — a token plus a 404 contact — rather than an unanswered question.
 */
function envWithHubSpotToken(values: Ids): Env {
  return { ...BASE_ENV, [`HUBSPOT_API_KEY_${values.portalId}`]: 'tok' } as unknown as Env;
}

const NOT_ON_ACCOUNT: RuleInput = {
  matchKind: 'contact_property',
  matchKey: 'can_pay_on_account',
  matchValue: 'true',
};

async function orderRow(orderId: string) {
  return BASE_ENV.DB.prepare(
    `SELECT o.status, o.payment_method, o.payment_terms_days, r.expires_at
       FROM orders o LEFT JOIN reservations r ON r.id = o.reservation_id
      WHERE o.id = ?1`,
  )
    .bind(orderId)
    .first<{
      status: string;
      payment_method: string | null;
      payment_terms_days: number | null;
      expires_at: string | null;
    }>();
}

async function invoiceOutboxPayload(portalId: string): Promise<Record<string, unknown>> {
  const row = await BASE_ENV.DB.prepare(
    `SELECT payload FROM outbox WHERE portal_id = ?1 AND topic = 'invoice.create'
      ORDER BY created_at DESC`,
  )
    .bind(portalId)
    .first<{ payload: string }>();
  return JSON.parse(row?.payload ?? '{}');
}

afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------------------

describe('matchesValue', () => {
  it('compares case- and whitespace-insensitively', () => {
    expect(matchesValue(' Gold ', 'gold')).toBe(true);
    expect(matchesValue('silver', 'gold')).toBe(false);
  });

  it('treats an empty expectation as "is it set", not "does it exist"', () => {
    // A HubSpot checkbox renders unticked as the string "false", so a present-but-false
    // property must not qualify — "has the property" is never what a rule means.
    expect(matchesValue('true', null)).toBe(true);
    expect(matchesValue('anything', '')).toBe(true);
    expect(matchesValue('false', null)).toBe(false);
    expect(matchesValue('', null)).toBe(false);
    expect(matchesValue(undefined, null)).toBe(false);
  });
});

describe('resolveInvoiceEligibility', () => {
  it('leaves a portal with no rules invoice-eligible', async () => {
    // The single most important assertion in this file. An empty rule set is "not
    // configured", never "nobody qualifies" — the other reading puts the 15-minute hold
    // back on every existing tenant, which is the AWS D1.1 fault itself.
    const { portalId } = await freshIds();
    const result = await resolveInvoiceEligibility(BASE_ENV, {
      portalId,
      buyerEmail: 'a@example.com',
      membership: NON_MEMBER,
      totalCents: 120_000,
    });
    expect(result).toMatchObject({ method: 'invoice', reason: 'no_rules', ruleId: null });
  });

  it('sends a payer who matches no rule to checkout', async () => {
    const { portalId } = await freshIds();
    await addRule(portalId, { matchKind: 'membership_level', matchValue: 'gold' });
    const result = await resolveInvoiceEligibility(BASE_ENV, {
      portalId,
      buyerEmail: 'a@example.com',
      membership: NON_MEMBER,
      totalCents: 120_000,
    });
    expect(result).toMatchObject({ method: 'card', reason: 'no_match' });
  });

  it('grants terms on a membership level, and carries the rule terms through', async () => {
    const { portalId } = await freshIds();
    const ruleId = await addRule(portalId, {
      matchKind: 'membership_level',
      matchValue: 'gold',
      termsDays: 45,
    });
    const result = await resolveInvoiceEligibility(BASE_ENV, {
      portalId,
      buyerEmail: 'a@example.com',
      membership: MEMBER,
      totalCents: 120_000,
    });
    expect(result).toMatchObject({ method: 'invoice', reason: 'matched', ruleId, termsDays: 45 });
  });

  it('matches the membership CATEGORY when the rule names it', async () => {
    const { portalId } = await freshIds();
    await addRule(portalId, {
      matchKind: 'membership_level',
      matchKey: 'category',
      matchValue: 'corporate',
    });
    expect(
      await resolveInvoiceEligibility(BASE_ENV, {
        portalId,
        buyerEmail: 'a@example.com',
        membership: MEMBER,
        totalCents: 1000,
      }),
    ).toMatchObject({ method: 'invoice', reason: 'matched' });
  });

  it('never qualifies an unverified membership on a tier it could not read', async () => {
    // An unverified membership is an unanswered question, not a non-member (CLAUDE.md) —
    // and an unanswered question must not be resolved in either direction here. Nothing
    // else qualifies this payer, so it fails OPEN rather than shortening a real hold.
    const { portalId } = await freshIds();
    await addRule(portalId, { matchKind: 'membership_level', matchValue: 'gold' });
    expect(
      await resolveInvoiceEligibility(BASE_ENV, {
        portalId,
        buyerEmail: 'a@example.com',
        membership: UNVERIFIED,
        totalCents: 1000,
      }),
    ).toMatchObject({ method: 'invoice', reason: 'unresolved' });
  });

  it('honours a min_cents floor, and falls through to a rule without one', async () => {
    const { portalId } = await freshIds();
    await addRule(portalId, { matchKind: 'always', minCents: 100_000, termsDays: 30 });
    expect(
      await resolveInvoiceEligibility(BASE_ENV, {
        portalId,
        buyerEmail: 'a@example.com',
        membership: NON_MEMBER,
        totalCents: 99_999,
      }),
    ).toMatchObject({ method: 'card', reason: 'no_match' });
    expect(
      await resolveInvoiceEligibility(BASE_ENV, {
        portalId,
        buyerEmail: 'a@example.com',
        membership: NON_MEMBER,
        totalCents: 100_000,
      }),
    ).toMatchObject({ method: 'invoice', reason: 'matched' });
  });

  it('ignores an inactive rule', async () => {
    const { portalId } = await freshIds();
    await addRule(portalId, { matchKind: 'always', active: 0 });
    expect(
      await resolveInvoiceEligibility(BASE_ENV, {
        portalId,
        buyerEmail: 'a@example.com',
        membership: NON_MEMBER,
        totalCents: 1000,
      }),
      // Every rule inactive is indistinguishable from no rules: the gate is off.
    ).toMatchObject({ method: 'invoice', reason: 'no_rules' });
  });

  it('resolves most-specific-first, whatever the priorities say', async () => {
    // A rule naming one person beats a portal-wide one even when the portal-wide rule
    // carries a higher priority — specificity belongs to the KIND, not to the row.
    const { portalId } = await freshIds();
    await addRule(portalId, { matchKind: 'always', termsDays: 7, priority: 99 });
    const specific = await addRule(portalId, {
      matchKind: 'contact_property',
      matchKey: 'can_pay_on_account',
      matchValue: 'true',
      termsDays: 60,
      priority: 0,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ properties: { can_pay_on_account: 'true' } }), {
            status: 200,
          }),
      ),
    );

    expect(
      await resolveInvoiceEligibility(
        { ...BASE_ENV, [`HUBSPOT_API_KEY_${portalId}`]: 'tok' } as unknown as Env,
        {
          portalId,
          buyerEmail: 'a@example.com',
          membership: NON_MEMBER,
          totalCents: 120_000,
        },
      ),
    ).toMatchObject({ method: 'invoice', ruleId: specific, termsDays: 60 });
  });

  it('breaks ties inside one kind on priority, then recency', async () => {
    const { portalId } = await freshIds();
    await addRule(portalId, { matchKind: 'always', termsDays: 14, priority: 1 });
    const winner = await addRule(portalId, {
      matchKind: 'always',
      termsDays: 60,
      priority: 5,
    });
    expect(
      await resolveInvoiceEligibility(BASE_ENV, {
        portalId,
        buyerEmail: 'a@example.com',
        membership: NON_MEMBER,
        totalCents: 1000,
      }),
    ).toMatchObject({ ruleId: winner, termsDays: 60 });
  });

  it('reads a company property, falling back to the buyer’s associated company', async () => {
    const { portalId } = await freshIds();
    await addRule(portalId, {
      matchKind: 'company_property',
      matchKey: 'account_customer',
      matchValue: 'yes',
    });

    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(String(url));
        if (String(url).includes('/contacts/')) {
          return new Response(JSON.stringify({ properties: { associatedcompanyid: '55' } }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ properties: { account_customer: 'yes' } }), {
          status: 200,
        });
      }),
    );

    expect(
      await resolveInvoiceEligibility(
        { ...BASE_ENV, [`HUBSPOT_API_KEY_${portalId}`]: 'tok' } as unknown as Env,
        { portalId, buyerEmail: 'a@example.com', membership: NON_MEMBER, totalCents: 1000 },
      ),
    ).toMatchObject({ method: 'invoice', reason: 'matched' });
    expect(calls.some((url) => url.includes('/companies/55'))).toBe(true);
  });

  it('treats a missing contact as an answer, not a failure', async () => {
    // No contact means this buyer holds none of these properties, which is a real "no".
    // Only an unreachable HubSpot is a non-answer.
    const { portalId } = await freshIds();
    await addRule(portalId, {
      matchKind: 'contact_property',
      matchKey: 'can_pay_on_account',
      matchValue: 'true',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 404 })),
    );

    expect(
      await resolveInvoiceEligibility(
        { ...BASE_ENV, [`HUBSPOT_API_KEY_${portalId}`]: 'tok' } as unknown as Env,
        { portalId, buyerEmail: 'ghost@example.com', membership: NON_MEMBER, totalCents: 1000 },
      ),
    ).toMatchObject({ method: 'card', reason: 'no_match' });
  });

  it('fails OPEN when a rule cannot be evaluated at all', async () => {
    // Of the two ways to be wrong, this one grants a longer hold on an unpaid invoice —
    // visible and reversible. The other cancels a real booking's seat and voids its
    // invoice fifteen minutes after a customer made it.
    const { portalId } = await freshIds();
    await addRule(portalId, {
      matchKind: 'contact_property',
      matchKey: 'can_pay_on_account',
      matchValue: 'true',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    expect(
      await resolveInvoiceEligibility(
        { ...BASE_ENV, [`HUBSPOT_API_KEY_${portalId}`]: 'tok' } as unknown as Env,
        { portalId, buyerEmail: 'a@example.com', membership: NON_MEMBER, totalCents: 1000 },
      ),
    ).toMatchObject({ method: 'invoice', reason: 'unresolved' });
  });

  it('still answers a less specific rule when a more specific one is unreadable', async () => {
    const { portalId } = await freshIds();
    await addRule(portalId, {
      matchKind: 'contact_property',
      matchKey: 'can_pay_on_account',
      matchValue: 'true',
      termsDays: 60,
    });
    await addRule(portalId, { matchKind: 'always', termsDays: 14 });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    expect(
      await resolveInvoiceEligibility(
        { ...BASE_ENV, [`HUBSPOT_API_KEY_${portalId}`]: 'tok' } as unknown as Env,
        { portalId, buyerEmail: 'a@example.com', membership: NON_MEMBER, totalCents: 1000 },
      ),
    ).toMatchObject({ method: 'invoice', reason: 'matched', termsDays: 14 });
  });

  it('degrades to eligible when the rules table does not exist', async () => {
    // A D1 provisioned before 0029. Reading optional config must never fail a booking,
    // and must never read "cannot see" as "not there" (Ref 217).
    const brokenDb = {
      prepare: () => ({
        bind: () => ({
          all: () => Promise.reject(new Error('no such table: invoice_eligibility_rules')),
        }),
      }),
    };
    expect(
      await resolveInvoiceEligibility({ ...BASE_ENV, DB: brokenDb } as unknown as Env, {
        portalId: 'p',
        buyerEmail: 'a@example.com',
        membership: NON_MEMBER,
        totalCents: 1000,
      }),
    ).toMatchObject({ method: 'invoice', reason: 'unresolved' });
  });
});

// ---------------------------------------------------------------------------

describe('reserve applies eligibility to the hold it takes', () => {
  it('keeps the long hold for a portal that has configured nothing', async () => {
    const values = await freshIds();
    await seedEvent(values);
    stubHubSpotMissing();

    const res = await publicReserve(values);
    const { orderId } = (await res.json()) as { orderId: string };
    const order = await orderRow(orderId);

    expect(order?.payment_method).toBe('invoice');
    expect(order?.expires_at?.slice(0, 10)).toBe(dateInDays(DEFAULT_INVOICE_DUE_DAYS));
  });

  it('holds an ineligible payer for 15 minutes and invoices due on receipt', async () => {
    const values = await freshIds();
    await seedEvent(values);
    await addRule(values.portalId, NOT_ON_ACCOUNT);
    stubHubSpotMissing();

    const res = await publicReserve(values, 'danielle@example.com', envWithHubSpotToken(values));
    const { orderId } = (await res.json()) as { orderId: string };
    const order = await orderRow(orderId);

    expect(order?.payment_method).toBe('card');
    expect(order?.payment_terms_days).toBeNull();
    // The DO's own DEFAULT_TTL_MS: reserve passes no expiry at all for a card payer.
    const heldMs = Date.parse(order?.expires_at ?? '') - Date.now();
    expect(heldMs).toBeGreaterThan(13 * 60 * 1000);
    expect(heldMs).toBeLessThanOrEqual(15 * 60 * 1000);
    expect(await invoiceOutboxPayload(values.portalId)).toMatchObject({
      invoiceDueDate: dateInDays(0),
    });
  });

  it('gives an eligible payer the rule’s terms, on the invoice and the hold', async () => {
    const values = await freshIds();
    await seedEvent(values);
    await addRule(values.portalId, { matchKind: 'always', termsDays: 60 });
    stubHubSpotMissing();

    const res = await publicReserve(values);
    const { orderId } = (await res.json()) as { orderId: string };
    const order = await orderRow(orderId);

    expect(order?.payment_method).toBe('invoice');
    expect(order?.payment_terms_days).toBe(60);
    expect(order?.expires_at?.slice(0, 10)).toBe(dateInDays(60));
    expect(await invoiceOutboxPayload(values.portalId)).toMatchObject({
      invoiceDueDate: dateInDays(60),
    });
  });

  it('lets the per-event override keep its short window whoever is paying', async () => {
    // 0019 added events.invoice_due_days so a capacity-tight event could hold seats for
    // less time. Who the payer is does not make that event's seats less scarce, so the
    // rule's terms sit BELOW it.
    const values = await freshIds();
    await seedEvent(values, { eventInvoiceDueDays: 7 });
    await addRule(values.portalId, { matchKind: 'always', termsDays: 60 });
    stubHubSpotMissing();

    const res = await publicReserve(values);
    const { orderId } = (await res.json()) as { orderId: string };
    expect((await orderRow(orderId))?.expires_at?.slice(0, 10)).toBe(dateInDays(7));
  });

  it('can hold the seat for less time than the invoice runs', async () => {
    const values = await freshIds();
    await seedEvent(values);
    await addRule(values.portalId, {
      matchKind: 'always',
      termsDays: 60,
      holdMs: 2 * 24 * 60 * 60 * 1000,
    });
    stubHubSpotMissing();

    const res = await publicReserve(values);
    const { orderId } = (await res.json()) as { orderId: string };
    const order = await orderRow(orderId);

    // The seat returns to sale in two days; the invoice stays payable for sixty.
    expect(order?.expires_at?.slice(0, 10)).toBe(dateInDays(2));
    expect(await invoiceOutboxPayload(values.portalId)).toMatchObject({
      invoiceDueDate: dateInDays(60),
    });
  });

  it('tells the order poll which kind of payment it is waiting for', async () => {
    const values = await freshIds();
    await seedEvent(values);
    await addRule(values.portalId, NOT_ON_ACCOUNT);
    stubHubSpotMissing();

    const reserved = await publicReserve(
      values,
      'danielle@example.com',
      envWithHubSpotToken(values),
    );
    const { orderId } = (await reserved.json()) as { orderId: string };
    const res = await publicApp.request(
      `/api/v1/orders/${orderId}`,
      { headers: { 'X-Portal-Id': values.portalId } },
      BASE_ENV,
    );
    expect(await res.json()).toMatchObject({ status: 'pending', paymentMethod: 'card' });
  });

  it('never commits a seat, whichever way eligibility went', async () => {
    // The hard rule of Phase 4: eligibility decides the hold's LENGTH and nothing else.
    // A hold is still a hold, and seats still commit only on payment confirm.
    for (const rules of [[], [{ matchKind: 'always', termsDays: 30 }]] as RuleInput[][]) {
      const values = await freshIds();
      await seedEvent(values);
      for (const rule of rules) await addRule(values.portalId, rule);
      stubHubSpotMissing();

      const res = await publicReserve(values);
      const { orderId } = (await res.json()) as { orderId: string };

      expect((await orderRow(orderId))?.status).toBe('pending');
      const reservation = await BASE_ENV.DB.prepare(
        'SELECT r.status FROM reservations r JOIN orders o ON o.reservation_id = r.id WHERE o.id = ?1',
      )
        .bind(orderId)
        .first<{ status: string }>();
      expect(reservation?.status).toBe('pending');
      const tickets = await BASE_ENV.DB.prepare(
        'SELECT COUNT(*) AS n FROM tickets WHERE order_id = ?1',
      )
        .bind(orderId)
        .first<{ n: number }>();
      expect(tickets?.n).toBe(0);
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------

const manageApp = new Hono<{ Bindings: Env }>();
manageApp.route('/api/v1/manage', manageRoutes);

function manageEnv(values: Ids): Env {
  return { ...BASE_ENV, [`ADMIN_API_KEY_${values.portalId}`]: values.adminKey } as unknown as Env;
}

async function manageRequest(values: Ids, path: string, init: RequestInit = {}) {
  return manageApp.request(
    `/api/v1/manage${path}`,
    {
      ...init,
      headers: {
        'X-Portal-Id': values.portalId,
        Authorization: `Bearer ${values.adminKey}`,
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    },
    manageEnv(values),
  );
}

describe('invoice eligibility rules admin API', () => {
  it('reports the gate as off until an active rule exists', async () => {
    const values = await freshIds();
    await seedEvent(values);

    let res = await manageRequest(values, '/invoice-eligibility-rules');
    expect(await res.json()).toMatchObject({ rules: [], gateActive: false });

    res = await manageRequest(values, '/invoice-eligibility-rules', {
      method: 'POST',
      body: JSON.stringify({ matchKind: 'always', termsDays: 45 }),
    });
    expect(res.status).toBe(201);

    res = await manageRequest(values, '/invoice-eligibility-rules');
    expect(await res.json()).toMatchObject({ gateActive: true });
  });

  it('rejects a property rule with no property to read', async () => {
    const values = await freshIds();
    await seedEvent(values);
    const res = await manageRequest(values, '/invoice-eligibility-rules', {
      method: 'POST',
      body: JSON.stringify({ matchKind: 'contact_property', matchValue: 'true' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ status: 'missing_fields' });
  });

  it('rejects a tier rule with no tier — that is an "always" rule in disguise', async () => {
    const values = await freshIds();
    await seedEvent(values);
    const res = await manageRequest(values, '/invoice-eligibility-rules', {
      method: 'POST',
      body: JSON.stringify({ matchKind: 'membership_level' }),
    });
    expect(res.status).toBe(400);
  });

  it('patches only active and priority, and deactivating turns the gate off', async () => {
    const values = await freshIds();
    await seedEvent(values);
    const created = (await (
      await manageRequest(values, '/invoice-eligibility-rules', {
        method: 'POST',
        body: JSON.stringify({ matchKind: 'always', termsDays: 30 }),
      })
    ).json()) as { id: string };

    const patched = await manageRequest(values, `/invoice-eligibility-rules/${created.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ active: false, priority: 3 }),
    });
    expect(await patched.json()).toMatchObject({ active: 0, priority: 3 });

    const list = (await (await manageRequest(values, '/invoice-eligibility-rules')).json()) as {
      gateActive: boolean;
    };
    expect(list.gateActive).toBe(false);
  });

  it('deletes a rule', async () => {
    const values = await freshIds();
    await seedEvent(values);
    const created = (await (
      await manageRequest(values, '/invoice-eligibility-rules', {
        method: 'POST',
        body: JSON.stringify({ matchKind: 'always' }),
      })
    ).json()) as { id: string };

    expect(
      (
        await manageRequest(values, `/invoice-eligibility-rules/${created.id}`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await manageRequest(values, `/invoice-eligibility-rules/${created.id}`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(404);
  });
});

// ---------------------------------------------------------------------------

describe('reissuing a voided invoice', () => {
  async function bookAndExpire(values: Ids) {
    stubHubSpotMissing();
    const res = await publicReserve(values);
    const { orderId } = (await res.json()) as { orderId: string };
    vi.unstubAllGlobals();

    // What expireHold leaves behind, plus the invoice id the void was issued against.
    await BASE_ENV.DB.prepare(
      `UPDATE orders SET status = 'cancelled', hubspot_invoice_id = 'inv-1',
              hubspot_deal_id = 'deal-1' WHERE id = ?1`,
    )
      .bind(orderId)
      .run();
    await BASE_ENV.DB.prepare(
      `UPDATE reservations SET status = 'expired'
        WHERE id = (SELECT reservation_id FROM orders WHERE id = ?1)`,
    )
      .bind(orderId)
      .run();
    return orderId;
  }

  it('gives the booking a fresh invoice and a live seat', async () => {
    const values = await freshIds();
    await seedEvent(values);
    const orderId = await bookAndExpire(values);

    const res = await manageRequest(
      values,
      `/events/${values.eventId}/orders/${orderId}/reissue-invoice`,
      { method: 'POST', body: '{}' },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      supersededInvoiceId: 'inv-1',
      seats: 1,
      invoiceDueDate: dateInDays(DEFAULT_INVOICE_DUE_DAYS),
    });

    const order = await orderRow(orderId);
    expect(order?.status).toBe('pending');
    expect(order?.payment_method).toBe('invoice');
    // Cleared so handleInvoiceCreate mints a NEW invoice rather than resuming the voided
    // one — it reuses a stored id by design.
    const invoiceId = await BASE_ENV.DB.prepare(
      'SELECT hubspot_invoice_id FROM orders WHERE id = ?1',
    )
      .bind(orderId)
      .first<{ hubspot_invoice_id: string | null }>();
    expect(invoiceId?.hubspot_invoice_id).toBeNull();

    const topics = (
      await BASE_ENV.DB.prepare(
        `SELECT topic, payload FROM outbox WHERE portal_id = ?1 ORDER BY created_at`,
      )
        .bind(values.portalId)
        .all<{ topic: string; payload: string }>()
    ).results;
    // The superseded invoice is explicitly closed, so the portal never holds two payable
    // invoices for one booking.
    expect(
      topics.some(
        (row) =>
          row.topic === 'payment.refund' && JSON.parse(row.payload).reason === 'reissue_superseded',
      ),
    ).toBe(true);
    expect(topics.filter((row) => row.topic === 'invoice.create')).toHaveLength(2);
  });

  it('gives the seats back when the reissue cannot be saved', async () => {
    // The reissued hold runs to the invoice due date — up to 90 days. If D1 rejects the
    // batch there is no reservation and no order pointing at that hold, so nothing would
    // ever release it and a one-seat event would sit unsellable for the whole term.
    const values = await freshIds();
    await seedEvent(values);
    const orderId = await bookAndExpire(values);

    const stub = BASE_ENV.EVENT_CAPACITY.get(
      BASE_ENV.EVENT_CAPACITY.idFromName(`${values.portalId}:${values.hubspotEventId}`),
    );
    const heldBefore = (
      (await (await stub.fetch('https://do/availability')).json()) as { held: number }
    ).held;

    const brokenEnv = {
      ...manageEnv(values),
      DB: {
        prepare: (sql: string) => BASE_ENV.DB.prepare(sql),
        batch: async () => {
          throw new Error('D1 unavailable');
        },
      },
    } as unknown as Env;

    expect(await reissueInvoice(brokenEnv, { portalId: values.portalId, orderId })).toMatchObject({
      ok: false,
      error: 'reissue_persist_failed',
    });

    // The seats the failed attempt took are back: the Durable Object holds no more than
    // it did before, so nothing is stranded until the due date.
    const heldAfter = (
      (await (await stub.fetch('https://do/availability')).json()) as { held: number }
    ).held;
    expect(heldAfter).toBe(heldBefore);

    // And the booking is still reissuable, rather than blocked by a hold nothing owns.
    const retry = await manageRequest(
      values,
      `/events/${values.eventId}/orders/${orderId}/reissue-invoice`,
      { method: 'POST', body: '{}' },
    );
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ ok: true, seats: 1 });
  });

  it('refuses an order that actually took payment', async () => {
    const values = await freshIds();
    await seedEvent(values);
    const orderId = await bookAndExpire(values);
    await BASE_ENV.DB.prepare(`UPDATE orders SET status = 'paid' WHERE id = ?1`)
      .bind(orderId)
      .run();

    const res = await manageRequest(
      values,
      `/events/${values.eventId}/orders/${orderId}/reissue-invoice`,
      { method: 'POST', body: '{}' },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'order_not_reissuable' });
  });

  it('refuses rather than overselling when the seats have since been sold', async () => {
    const values = await freshIds();
    // One seat, and the reissue wants it back after somebody else took it.
    await seedEvent(values);
    await BASE_ENV.DB.prepare('UPDATE events SET capacity = 1 WHERE id = ?1')
      .bind(values.eventId)
      .run();
    await BASE_ENV.DB.prepare('UPDATE ticket_types SET capacity = 1 WHERE id = ?1')
      .bind(values.ticketTypeId)
      .run();

    const orderId = await bookAndExpire(values);
    // The freed seat is taken by a live booking.
    stubHubSpotMissing();
    const rival = await publicReserve(values, 'rival@example.com');
    expect(rival.status).toBe(200);
    vi.unstubAllGlobals();

    const res = await manageRequest(
      values,
      `/events/${values.eventId}/orders/${orderId}/reissue-invoice`,
      { method: 'POST', body: '{}' },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'event_full' });
    // And the order is left exactly as it was — a refused reissue changes nothing.
    expect((await orderRow(orderId))?.status).toBe('cancelled');
  });

  it('will not reissue for an order belonging to another event', async () => {
    const values = await freshIds();
    const other = await freshIds();
    await seedEvent(values);
    const orderId = await bookAndExpire(values);
    const res = await manageRequest(
      values,
      `/events/${other.eventId}/orders/${orderId}/reissue-invoice`,
      { method: 'POST', body: '{}' },
    );
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------

/**
 * The voided-invoice fault, at the other end.
 *
 * `expireHold` enqueues a `payment.refund` when a hold lapses unpaid, and voiding is the
 * only way HubSpot closes an invoice. The row is written at expiry and DRAINS later, and in
 * that gap the booking can come back — a payment lands and the order goes needs_review for
 * an owner to honour, or staff reissue the invoice. Voiding then is irreversible damage to
 * a live invoice, so the handler re-reads the order and stands down.
 */

const TOKEN_KEY = '0'.repeat(64);

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

async function giveTenantAToken(portalId: string) {
  await BASE_ENV.DB.prepare(
    `UPDATE tenants SET hs_access_token = ?1, hs_refresh_token = ?2, hs_token_expires_at = ?3
      WHERE portal_id = ?4`,
  )
    .bind(
      await encryptToken(TOKEN_KEY, 'hs-access-token'),
      await encryptToken(TOKEN_KEY, 'hs-refresh-token'),
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      portalId,
    )
    .run();
}

async function enqueueExpiredHoldVoid(portalId: string, orderId: string): Promise<string> {
  const outboxId = crypto.randomUUID();
  await BASE_ENV.DB.prepare(
    `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
     VALUES (?1, ?2, 'payment.refund', ?3, ?4)`,
  )
    .bind(
      outboxId,
      portalId,
      JSON.stringify({
        orderId,
        hsInvoiceId: 'inv-1',
        amountCents: 120_000,
        kind: 'full',
        reason: 'expired_hold',
      }),
      new Date().toISOString(),
    )
    .run();
  return outboxId;
}

function stubHubSpotCalls() {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
      calls.push({
        method: init?.method ?? 'GET',
        url,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify({ id: 'inv-1', properties: {}, results: [] }), {
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

describe('an expired hold does not void an invoice its booking got back', () => {
  async function seedCancelledOrder(values: Ids, status: string) {
    await seedEvent(values);
    await giveTenantAToken(values.portalId);
    const orderId = crypto.randomUUID();
    await BASE_ENV.DB.prepare(
      `INSERT INTO orders (id, portal_id, event_id, status, buyer_email, buyer_name,
                           total_cents, currency, hubspot_invoice_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'danielle@example.com', 'Danielle', 120000, 'AUD', 'inv-1', ?5, ?5)`,
    )
      .bind(orderId, values.portalId, values.eventId, status, new Date().toISOString())
      .run();
    return orderId;
  }

  it('voids while the order really is cancelled', async () => {
    const values = await freshIds();
    const orderId = await seedCancelledOrder(values, 'cancelled');
    const outboxId = await enqueueExpiredHoldVoid(values.portalId, orderId);
    const calls = stubHubSpotCalls();

    const { msg, state } = fakeMessage({
      kind: 'payment.refund',
      portalId: values.portalId,
      outboxId,
    });
    await handleOutboxMessage(msg, BASE_ENV);

    expect(state.acked).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.method === 'PATCH' &&
          call.url.includes('/invoices/inv-1') &&
          (call.body as { properties: Record<string, string> }).properties.hs_invoice_status ===
            'voided',
      ),
    ).toBe(true);
  });

  it('stands down once a late payment has revived the booking', async () => {
    // needs_review is exactly the state a late payment leaves behind while an owner decides
    // whether to honour it. Voiding here would kill the invoice under a payment already
    // captured against it.
    const values = await freshIds();
    const orderId = await seedCancelledOrder(values, 'needs_review');
    const outboxId = await enqueueExpiredHoldVoid(values.portalId, orderId);
    const calls = stubHubSpotCalls();

    const { msg, state } = fakeMessage({
      kind: 'payment.refund',
      portalId: values.portalId,
      outboxId,
    });
    await handleOutboxMessage(msg, BASE_ENV);

    expect(state.acked).toBe(true);
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
    // Still marked delivered: there was nothing left to do, and retrying forever would only
    // keep a dead row in the queue.
    const row = await BASE_ENV.DB.prepare('SELECT status FROM outbox WHERE id = ?1')
      .bind(outboxId)
      .first<{ status: string }>();
    expect(row?.status).toBe('delivered');
  });

  it('stands down once the invoice has been reissued', async () => {
    const values = await freshIds();
    const orderId = await seedCancelledOrder(values, 'pending');
    const outboxId = await enqueueExpiredHoldVoid(values.portalId, orderId);
    const calls = stubHubSpotCalls();

    const { msg } = fakeMessage({ kind: 'payment.refund', portalId: values.portalId, outboxId });
    await handleOutboxMessage(msg, BASE_ENV);
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('still voids a superseded invoice on the reissue path', async () => {
    // A reissue leaves the order 'pending' by design, so the row it writes to close the OLD
    // invoice carries its own reason and is not subject to the expired-hold stand-down.
    const values = await freshIds();
    const orderId = await seedCancelledOrder(values, 'pending');
    const outboxId = crypto.randomUUID();
    await BASE_ENV.DB.prepare(
      `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
       VALUES (?1, ?2, 'payment.refund', ?3, ?4)`,
    )
      .bind(
        outboxId,
        values.portalId,
        JSON.stringify({
          orderId,
          hsInvoiceId: 'inv-1',
          amountCents: 120_000,
          kind: 'full',
          reason: 'reissue_superseded',
        }),
        new Date().toISOString(),
      )
      .run();
    const calls = stubHubSpotCalls();

    const { msg } = fakeMessage({ kind: 'payment.refund', portalId: values.portalId, outboxId });
    await handleOutboxMessage(msg, BASE_ENV);
    expect(
      calls.some((call) => call.method === 'PATCH' && call.url.includes('/invoices/inv-1')),
    ).toBe(true);
  });
});
