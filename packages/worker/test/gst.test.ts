import { env } from 'cloudflare:test';
import * as shared from '@paddock/shared';
import { isGstFreeTreatment } from '@paddock/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleOutboxMessage } from '../src/hubspot-writeback';
import { encryptToken } from '../src/token-crypto';
import type { Env } from '../src/types';
import { seedEvent, seedTicketType } from './support/fixtures';

// Guards the tax contract for HubSpot product lines (hubspot-writeback.ts):
// stored prices are TAX-EXCLUSIVE, so a line goes over at face value carrying
// hs_tax_rate_group_id, and HubSpot applies the portal's own rate on top.
//
// This used to assert the opposite — that a line was divided by 1.1 first, because stored
// prices were read as GST-inclusive. They are not: the tenant enters them ex GST, so every
// invoice came out a tax fraction short of the quoted price. And the 1.1 was an Australian
// 10% hard-coded into a multi-tenant product.

const BASE_ENV = env as unknown as Env;
const TOKEN_KEY = '0'.repeat(64);

let counter = 0;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Captures the properties of every line item POSTed to HubSpot. */
function stubHubSpot() {
  const lineProps: Array<Record<string, string | number>> = [];
  let lineSeq = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;

      if (url.includes('/crm/v4/associations/') && url.endsWith('/labels')) {
        return json({ results: [{ typeId: 1, label: null, category: 'HUBSPOT_DEFINED' }] });
      }
      if (url.includes('/crm/v3/objects/contacts/search')) return json({ results: [{ id: 'c1' }] });
      if (url.includes('/crm/v3/objects/contacts/')) return json({ id: 'c1' });
      if (method === 'POST' && url.endsWith('/crm/v3/objects/invoices'))
        return json({ id: 'inv1' });
      if (url.includes('/crm/v3/objects/line_items/search')) {
        return json({ message: 'invalid property' }, 400);
      }
      if (method === 'POST' && url.endsWith('/crm/v3/objects/line_items')) {
        lineSeq += 1;
        lineProps.push((body?.properties as Record<string, string | number>) ?? {});
        return json({ id: `li-${lineSeq}` });
      }
      return json({ id: 'ok', properties: {}, results: [] });
    }),
  );
  return lineProps;
}

function fakeMessage(body: { kind: string; portalId: string; outboxId: string }) {
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
      // biome-ignore lint/suspicious/noExplicitAny: minimal Message stub
    } as any,
  };
}

async function drainInvoiceCreate(line: {
  quantity: number;
  unitCents: number;
  totalCents: number;
  taxTreatment: string;
}) {
  const n = `${Date.now()}-${counter++}`;
  const portalId = `gst-${n}`;
  const eventId = `evt-${n}`;
  const orderId = `ord-${n}`;
  const now = new Date().toISOString();

  await BASE_ENV.DB.prepare(
    `INSERT INTO tenants (portal_id, display_name, hs_access_token, hs_refresh_token,
                          hs_token_expires_at, xero_gst_rate_id, xero_gst_free_rate_id, created_at)
     VALUES (?1, 'Dev', ?2, ?3, ?4, 'tax-gst', 'tax-free', ?5)`,
  )
    .bind(
      portalId,
      await encryptToken(TOKEN_KEY, 'hs-access-token'),
      await encryptToken(TOKEN_KEY, 'hs-refresh-token'),
      new Date(Date.now() + 3600_000).toISOString(),
      now,
    )
    .run();
  await BASE_ENV.DB.prepare(
    `INSERT INTO events (id, portal_id, hubspot_event_id, title, starts_at, ends_at, capacity, created_at, updated_at)
     VALUES (?1, ?2, 'hs-evt', 'Course', ?3, ?3, 10, ?3, ?3)`,
  )
    .bind(eventId, portalId, now)
    .run();
  await BASE_ENV.DB.prepare(
    `INSERT INTO orders (id, portal_id, event_id, status, buyer_email, buyer_name,
                         total_cents, currency, hubspot_deal_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'pending', 'qa@example.com', 'QA', ?4, 'AUD', 'deal-1', ?5, ?5)`,
  )
    .bind(orderId, portalId, eventId, line.totalCents, now)
    .run();

  const outboxId = crypto.randomUUID();
  await BASE_ENV.DB.prepare(
    `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
     VALUES (?1, ?2, 'invoice.create', ?3, ?4)`,
  )
    .bind(
      outboxId,
      portalId,
      JSON.stringify({
        orderId,
        eventId,
        hubspotEventId: 'hs-evt',
        buyerEmail: 'qa@example.com',
        buyerName: 'QA',
        buyerAbn: null,
        totalCents: line.totalCents,
        currency: 'AUD',
        lineItems: [
          {
            ticketTypeId: `tt-${n}`,
            name: 'AS1796 Cert 10',
            quantity: line.quantity,
            unitCents: line.unitCents,
            totalCents: line.totalCents,
            taxTreatment: line.taxTreatment,
            hsTaxRateId: line.taxTreatment === 'gst_free' ? null : 'tax-gst',
            hsProductId: null,
          },
        ],
      }),
      now,
    )
    .run();

  const lineProps = stubHubSpot();
  const message = fakeMessage({ kind: 'invoice.create', portalId, outboxId });
  await handleOutboxMessage(message.msg, BASE_ENV);
  return lineProps;
}

describe('invoice line items are tax-exclusive and carry the portal tax rate', () => {
  it('sends the stored price at FACE VALUE, letting HubSpot add the tax on top', async () => {
    // $5,850.00 ex GST. HubSpot's own 10% rate turns this into $6,435.00 on the invoice.
    // The old behaviour sent $5,318.18 so the invoice came back to $5,850 — the buyer's
    // GST silently absorbed out of the price the tenant charges.
    const [line] = await drainInvoiceCreate({
      quantity: 1,
      unitCents: 585000,
      totalCents: 585000,
      taxTreatment: 'gst',
    });
    expect(line?.amount).toBe('5850.00');
    expect(line?.price).toBe('5850.00');
    expect(line?.hs_tax_rate_group_id).toBe('tax-gst');
    expect(line?.amount).not.toBe('5318.18');
  });

  it('divides the line total by the quantity, not by a tax rate', async () => {
    // Ten $1.00 seats → a $10.00 line at $1.00 each. Nothing in the amount depends on
    // what the portal's tax library charges.
    const [line] = await drainInvoiceCreate({
      quantity: 10,
      unitCents: 100,
      totalCents: 1000,
      taxTreatment: 'gst',
    });
    expect(line?.amount).toBe('10.00');
    expect(line?.price).toBe('1.00');
    expect(line?.quantity).toBe(10);
  });

  it('sends a gst_free line at face value too, against the GST-free rate', async () => {
    const [line] = await drainInvoiceCreate({
      quantity: 1,
      unitCents: 19900,
      totalCents: 19900,
      taxTreatment: 'gst_free',
    });
    expect(line?.amount).toBe('199.00');
    expect(line?.hs_tax_rate_group_id).toBe('tax-free');
  });

  it('holds no tax rate of its own — the rate is HubSpot’s, per portal', () => {
    // A rate constant in shared is the bug this replaced: an Australian 10% in a product
    // that has to invoice a 15% GST or a 20% VAT portal correctly. Re-exporting one is
    // how the division creeps back into the line builder.
    expect(Object.keys(shared)).not.toContain('GST_RATE');
    expect(Object.keys(shared)).not.toContain('gstExclusiveCents');
    expect(shared.PRICES_ARE_TAX_EXCLUSIVE).toBe(true);
  });
});

describe('isGstFreeTreatment', () => {
  it('treats legacy gst_inclusive (and gst) as taxable', () => {
    expect(isGstFreeTreatment('gst_inclusive')).toBe(false);
    expect(isGstFreeTreatment('gst')).toBe(false);
    expect(isGstFreeTreatment(null)).toBe(false);
    expect(isGstFreeTreatment(undefined)).toBe(false);
  });

  it('recognises gst_free and exempt', () => {
    expect(isGstFreeTreatment('gst_free')).toBe(true);
    expect(isGstFreeTreatment('exempt')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The other half of "prices are tax-exclusive": a refund computed off those prices
// is smaller than what the buyer actually paid, and the difference is the tax.
// ---------------------------------------------------------------------------

async function drainPartialRefund(
  invoiceProperties: Record<string, string> | 'unreadable',
  amountCents: number,
  // Tax treatment per seat on the order. The FIRST seat is the one refunded, so a
  // ['gst_free', 'gst'] order is the mixed invoice the blended ratio got wrong.
  seatTreatments: string[] = ['gst'],
  opts: { sendRegistrationId?: boolean } = { sendRegistrationId: true },
) {
  const n = `${Date.now()}-${counter++}`;
  const portalId = `refund-${n}`;
  const orderId = `ord-${n}`;
  const now = new Date().toISOString();

  await BASE_ENV.DB.prepare(
    `INSERT INTO tenants (portal_id, display_name, hs_access_token, hs_refresh_token,
                          hs_token_expires_at, created_at)
     VALUES (?1, 'Dev', ?2, ?3, ?4, ?5)`,
  )
    .bind(
      portalId,
      await encryptToken(TOKEN_KEY, 'hs-access-token'),
      await encryptToken(TOKEN_KEY, 'hs-refresh-token'),
      new Date(Date.now() + 3600_000).toISOString(),
      now,
    )
    .run();
  const eventId = `evt-${n}`;
  await seedEvent(BASE_ENV.DB, { portalId, eventId, hubspotEventId: `hs-${n}` });
  await BASE_ENV.DB.prepare(
    `INSERT INTO orders (id, portal_id, event_id, status, buyer_email, buyer_name, total_cents,
                         currency, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'paid', 'qa@example.com', 'QA', 100000, 'AUD', ?4, ?4)`,
  )
    .bind(orderId, portalId, eventId, now)
    .run();

  const registrationIds: string[] = [];
  for (const [index, treatment] of seatTreatments.entries()) {
    const ticketTypeId = `tt-${n}-${index}`;
    const registrationId = `reg-${n}-${index}`;
    registrationIds.push(registrationId);
    await seedTicketType(BASE_ENV.DB, {
      portalId,
      eventId,
      ticketTypeId,
      name: `Seat ${index}`,
      extra: { tax_treatment: treatment },
    });
    await BASE_ENV.DB.prepare(
      `INSERT INTO registrations
         (id, portal_id, order_id, event_id, ticket_type_id, attendee_email, attendee_name)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
      .bind(
        registrationId,
        portalId,
        orderId,
        eventId,
        ticketTypeId,
        `seat${index}@example.com`,
        `Seat ${index}`,
      )
      .run();
  }

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
        hsInvoiceId: 'inv1',
        amountCents,
        kind: 'partial',
        ...(opts.sendRegistrationId ? { registrationId: registrationIds[0] } : {}),
      }),
      now,
    )
    .run();

  const refunds: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      if (url.includes('/associations/payments'))
        return json({ results: [{ toObjectId: 'pay1' }] });
      if (url.includes('/crm/v3/objects/invoices/inv1?properties=')) {
        if (invoiceProperties === 'unreadable') return json({ message: 'forbidden' }, 403);
        return json({ id: 'inv1', properties: invoiceProperties });
      }
      if (method === 'POST' && url.includes('/payments/pay1/refunds')) {
        refunds.push(body ?? {});
        return json({ id: 'ref1' });
      }
      return json({ id: 'ok', properties: {}, results: [] });
    }),
  );

  const message = fakeMessage({ kind: 'payment.refund', portalId, outboxId });
  await handleOutboxMessage(message.msg, BASE_ENV);
  return refunds;
}

describe('a partial refund is grossed up to the tax on the invoice', () => {
  it('returns the seat price PLUS the tax the buyer paid on it', async () => {
    // A $500 ex-GST seat out of a $1,000 ex-GST booking that HubSpot invoiced at $1,100.
    // Refunding the stored $500 would keep $50 of the buyer's GST.
    const refunds = await drainPartialRefund(
      { hs_amount_billed: '1100.00', hs_subtotal: '1000.00' },
      50000,
    );
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.amount).toBe('550.00');
  });

  it('changes nothing on a tax-free invoice', async () => {
    const refunds = await drainPartialRefund(
      { hs_amount_billed: '1000.00', hs_subtotal: '1000.00' },
      50000,
    );
    expect(refunds[0]?.amount).toBe('500.00');
  });

  it('falls back to the stored amount when HubSpot will not say', async () => {
    // Under-refunding is recoverable by a human; over-refunding is not.
    const refunds = await drainPartialRefund('unreadable', 50000);
    expect(refunds[0]?.amount).toBe('500.00');
  });

  it('never scales a gst_free seat, even on a mixed invoice', async () => {
    // Codex P1: total/subtotal is an invoice-wide BLEND. Equal $100 taxable and $100
    // gst_free lines give 210/200 = 1.05, which would hand a gst_free seat $105 for a
    // $100 seat that never carried tax — over-refunding, the one direction that cannot
    // be walked back.
    const refunds = await drainPartialRefund(
      { hs_amount_billed: '210.00', hs_subtotal: '200.00' },
      10000,
      ['gst_free', 'gst'],
    );
    expect(refunds[0]?.amount).toBe('100.00');
    expect(refunds[0]?.amount).not.toBe('105.00');
  });

  it('scales a taxable seat on a single-treatment invoice exactly', async () => {
    const refunds = await drainPartialRefund(
      { hs_amount_billed: '220.00', hs_subtotal: '200.00' },
      10000,
      ['gst', 'gst'],
    );
    expect(refunds[0]?.amount).toBe('110.00');
  });

  it('errs low, never high, for a taxable seat on a mixed invoice', async () => {
    // The blend under-states this seat's true 1.10, and an under-refund is recoverable
    // by a human where an over-refund is not.
    const refunds = await drainPartialRefund(
      { hs_amount_billed: '210.00', hs_subtotal: '200.00' },
      10000,
      ['gst', 'gst_free'],
    );
    const amount = Number(refunds[0]?.amount);
    expect(amount).toBeGreaterThanOrEqual(100);
    expect(amount).toBeLessThanOrEqual(110);
  });

  it('does not scale when the refunded seat cannot be identified on a mixed order', async () => {
    const refunds = await drainPartialRefund(
      { hs_amount_billed: '210.00', hs_subtotal: '200.00' },
      10000,
      ['gst', 'gst_free'],
      { sendRegistrationId: false },
    );
    expect(refunds[0]?.amount).toBe('100.00');
  });

  it('falls back when the figures do not make sense together', async () => {
    const refunds = await drainPartialRefund(
      { hs_amount_billed: '900.00', hs_subtotal: '1000.00' },
      50000,
    );
    expect(refunds[0]?.amount).toBe('500.00');
  });
});
