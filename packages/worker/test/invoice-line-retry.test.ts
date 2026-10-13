import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleOutboxMessage } from '../src/hubspot-writeback';
import { encryptToken } from '../src/token-crypto';
import type { Env } from '../src/types';

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

interface StubOptions {
  /**
   * Ref 40: HubSpot answers the association read with nothing even though the PUT
   * succeeded — an index that has not caught up, or a read the portal refuses. The
   * write-back used to take that for "this line does not exist yet" and POST it again,
   * once per delivery attempt.
   */
  blindAssociationRead?: boolean;
  /** Let the invoice actually open, so the happy path can be asserted too. */
  openSucceeds?: boolean;
  /**
   * Line items already associated with the invoice before this run, as
   * [id, hs_external_id] — the wreckage a previous set of attempts left behind.
   */
  preExistingLines?: Array<[string, string]>;
}

interface StubResult {
  calls: Array<{ method: string; url: string }>;
  invoiceProps: Array<Record<string, string>>;
  deletedLineIds: string[];
}

function stubInvoiceHubSpot(options: StubOptions = {}): StubResult {
  const calls: Array<{ method: string; url: string }> = [];
  const invoiceProps: Array<Record<string, string>> = [];
  const deletedLineIds: string[] = [];
  const associatedLineIds: string[] = [];
  const lineItems = new Map<string, Record<string, string>>();
  let lineSeq = 0;

  for (const [id, externalId] of options.preExistingLines ?? []) {
    lineItems.set(id, { hs_external_id: externalId });
    associatedLineIds.push(id);
  }

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
      const method = init?.method ?? 'GET';
      calls.push({ method, url });
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;

      if (url.includes('/crm/v4/associations/') && url.endsWith('/labels')) {
        return json({ results: [{ typeId: 1, label: null, category: 'HUBSPOT_DEFINED' }] });
      }
      if (url.includes('/crm/v3/objects/contacts/search')) {
        return json({ results: [{ id: 'contact-1' }] });
      }
      if (url.includes('/crm/v3/objects/contacts/')) {
        return json({ id: 'contact-1' });
      }
      if (method === 'POST' && url.endsWith('/crm/v3/objects/invoices')) {
        invoiceProps.push((body?.properties as Record<string, string> | undefined) ?? {});
        return json({ id: 'inv-1' });
      }
      if (method === 'DELETE' && /\/crm\/v3\/objects\/line_items\/[^/]+$/.test(url)) {
        const id = url.split('/').pop() as string;
        deletedLineIds.push(id);
        lineItems.delete(id);
        const at = associatedLineIds.indexOf(id);
        if (at >= 0) associatedLineIds.splice(at, 1);
        return json({});
      }
      if (url.includes('/crm/v3/objects/line_items/search')) {
        return json({ message: 'invalid property' }, 400);
      }
      if (method === 'POST' && url.endsWith('/crm/v3/objects/line_items')) {
        lineSeq += 1;
        const id = `li-${lineSeq}`;
        const props = (body?.properties as Record<string, string> | undefined) ?? {};
        lineItems.set(id, props);
        return json({ id });
      }
      if (method === 'POST' && url.includes('/crm/v3/objects/line_items/batch/read')) {
        const inputs = (body?.inputs as Array<{ id: string }> | undefined) ?? [];
        return json({
          results: inputs.map((row) => ({
            id: row.id,
            properties: lineItems.get(row.id) ?? {},
          })),
        });
      }
      if (
        method === 'GET' &&
        /\/crm\/v4\/objects\/invoices\/[^/]+\/associations\/line_items/.test(url)
      ) {
        if (options.blindAssociationRead) return json({ results: [] });
        return json({ results: associatedLineIds.map((id) => ({ toObjectId: id })) });
      }
      if (
        method === 'PUT' &&
        /\/crm\/v4\/objects\/line_items\/([^/]+)\/associations\/invoices\//.test(url)
      ) {
        const id = url.match(/\/line_items\/([^/]+)\/associations/)?.[1];
        if (id && !associatedLineIds.includes(id)) associatedLineIds.push(id);
        return json({});
      }
      if (method === 'PATCH' && url.includes('/crm/v3/objects/invoices/inv-1')) {
        if (options.openSucceeds) return json({ id: 'inv-1', properties: {} });
        return json({ message: 'server error' }, 500);
      }
      if (method === 'GET' && url.includes('/crm/v3/objects/invoices/inv-1')) {
        return json({ id: 'inv-1', properties: { hs_invoice_link: 'https://pay.test/inv-1' } });
      }
      return json({ id: 'ok', properties: {}, results: [] });
    }),
  );

  return { calls, invoiceProps, deletedLineIds };
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

/**
 * One guest booking of the Ref 40 course: IIW Welding Engineer, $18,786.36 ex GST.
 */
async function seedBooking(invoiceDueDate?: string) {
  const n = `${Date.now()}-${counter++}`;
  const portalId = `inv-retry-${n}`;
  const eventId = `evt-${n}`;
  const orderId = `ord-${n}`;
  const ticketTypeId = `tt-${n}`;
  const now = new Date().toISOString();

  await BASE_ENV.DB.prepare(
    `INSERT INTO tenants (portal_id, display_name, hs_access_token, hs_refresh_token,
                          hs_token_expires_at, xero_gst_rate_id, created_at)
     VALUES (?1, 'Dev', ?2, ?3, ?4, 'tax-1', ?5)`,
  )
    .bind(
      portalId,
      await encryptToken(TOKEN_KEY, 'hs-access-token'),
      await encryptToken(TOKEN_KEY, 'hs-refresh-token'),
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
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
     VALUES (?1, ?2, ?3, 'pending', 'qa@example.com', 'QA', 1878636, 'AUD', 'deal-1', ?4, ?4)`,
  )
    .bind(orderId, portalId, eventId, now)
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
        totalCents: 1878636,
        currency: 'AUD',
        ...(invoiceDueDate ? { invoiceDueDate } : {}),
        lineItems: [
          {
            ticketTypeId,
            name: 'Course member',
            quantity: 1,
            unitCents: 1878636,
            totalCents: 1878636,
            taxTreatment: 'gst',
            hsTaxRateId: 'tax-1',
            hsProductId: null,
          },
        ],
      }),
      now,
    )
    .run();

  return { portalId, eventId, orderId, ticketTypeId, outboxId };
}

describe('invoice.create retries do not duplicate line items', () => {
  it('reuses the line already on the invoice when open PATCH 500s', async () => {
    const { portalId, outboxId } = await seedBooking();

    const { calls } = stubInvoiceHubSpot();
    const first = fakeMessage({ kind: 'invoice.create', portalId, outboxId });
    await handleOutboxMessage(first.msg, BASE_ENV);
    expect(first.state.retried).toBe(true);

    const second = fakeMessage({ kind: 'invoice.create', portalId, outboxId });
    await handleOutboxMessage(second.msg, BASE_ENV);
    expect(second.state.retried).toBe(true);

    const lineCreates = calls.filter(
      (call) => call.method === 'POST' && call.url.endsWith('/crm/v3/objects/line_items'),
    );
    const invoiceCreates = calls.filter(
      (call) => call.method === 'POST' && call.url.endsWith('/crm/v3/objects/invoices'),
    );
    expect(invoiceCreates).toHaveLength(1);
    expect(lineCreates).toHaveLength(1);
  });

  it('creates the line once across four attempts even when HubSpot never reports it', async () => {
    // Ref 40 item 2, exactly as Nick hit it: a $18,786.36 guest booking invoiced at
    // $75,145.44 across four identical lines. `max_retries = 3` in wrangler.toml, so a
    // handler that fails after attaching its line runs four times in all — and while
    // "have we created this line" was answered by reading HubSpot's associations back, a
    // read that came up empty meant it created the line again on every one of them.
    const { portalId, orderId, outboxId } = await seedBooking();
    const { calls } = stubInvoiceHubSpot({ blindAssociationRead: true });

    for (let attempt = 0; attempt < 4; attempt++) {
      const delivery = fakeMessage({ kind: 'invoice.create', portalId, outboxId });
      await handleOutboxMessage(delivery.msg, BASE_ENV);
      expect(delivery.state.retried).toBe(true);
    }

    const lineCreates = calls.filter(
      (call) => call.method === 'POST' && call.url.endsWith('/crm/v3/objects/line_items'),
    );
    expect(lineCreates).toHaveLength(1);

    const owned = await BASE_ENV.DB.prepare(
      `SELECT external_id, line_item_id FROM hubspot_line_items
       WHERE portal_id = ?1 AND parent_object_type = 'invoices'`,
    )
      .bind(portalId)
      .all<{ external_id: string; line_item_id: string }>();
    expect(owned.results).toHaveLength(1);
    expect(owned.results[0].external_id).toContain(`inv:${orderId}:`);
  });

  it('clears up the duplicates a previous run already put on the invoice', async () => {
    // The state Ref 40 photographed: four lines for one seat, all carrying the same
    // external id because each delivery attempt wrote the same one. Exactly one is kept
    // and reused; the other three are ours by that id, and go. Without this a repaired
    // invoice would still be billed at four times the course price.
    const { portalId, orderId, ticketTypeId, outboxId } = await seedBooking();
    const externalId = `inv:${orderId}:${ticketTypeId}`;
    const { calls, deletedLineIds } = stubInvoiceHubSpot({
      openSucceeds: true,
      preExistingLines: [
        ['li-dup-1', externalId],
        ['li-dup-2', externalId],
        ['li-dup-3', externalId],
        ['li-dup-4', externalId],
      ],
    });

    const delivery = fakeMessage({ kind: 'invoice.create', portalId, outboxId });
    await handleOutboxMessage(delivery.msg, BASE_ENV);
    expect(delivery.state.acked).toBe(true);

    // One kept, three withdrawn, and nothing new created.
    expect(deletedLineIds.sort()).toEqual(['li-dup-2', 'li-dup-3', 'li-dup-4']);
    expect(
      calls.filter(
        (call) => call.method === 'POST' && call.url.endsWith('/crm/v3/objects/line_items'),
      ),
    ).toHaveLength(0);
  });

  it('leaves a line it did not create alone, whoever put it there', async () => {
    // "Exclusive" is about the lines this worker owns, not about the invoice. A line a
    // human added carries an external id we never wrote, so it is not ours to withdraw —
    // and that is also what stops one booking's write-back rewriting another's invoice.
    const { portalId, outboxId } = await seedBooking();
    const { deletedLineIds } = stubInvoiceHubSpot({
      openSucceeds: true,
      preExistingLines: [['li-human', 'somebody-elses-line']],
    });

    const delivery = fakeMessage({ kind: 'invoice.create', portalId, outboxId });
    await handleOutboxMessage(delivery.msg, BASE_ENV);

    expect(deletedLineIds).not.toContain('li-human');
  });

  it('archives a line whose ticket type has gone from the booking', async () => {
    const { portalId, orderId, ticketTypeId, outboxId } = await seedBooking();
    const { calls, deletedLineIds } = stubInvoiceHubSpot({ openSucceeds: true });

    // A line we made for this booking against a ticket type it no longer carries. Ours by
    // its external id, so ours to withdraw; anything else on the invoice is somebody
    // else's and is left where it is.
    await BASE_ENV.DB.prepare(
      `INSERT INTO hubspot_line_items
         (portal_id, parent_object_type, parent_id, external_id, line_item_id, order_id, created_at)
       VALUES (?1, 'invoices', 'inv-1', ?2, 'li-stale', ?3, ?4)`,
    )
      .bind(portalId, `inv:${orderId}:${ticketTypeId}-gone`, orderId, new Date().toISOString())
      .run();

    const delivery = fakeMessage({ kind: 'invoice.create', portalId, outboxId });
    await handleOutboxMessage(delivery.msg, BASE_ENV);
    expect(delivery.state.acked).toBe(true);

    expect(deletedLineIds).toContain('li-stale');
    const owned = await BASE_ENV.DB.prepare(
      'SELECT external_id FROM hubspot_line_items WHERE portal_id = ?1',
    )
      .bind(portalId)
      .all<{ external_id: string }>();
    expect(owned.results.map((row) => row.external_id)).toEqual([`inv:${orderId}:${ticketTypeId}`]);
    expect(
      calls.filter(
        (call) => call.method === 'POST' && call.url.endsWith('/crm/v3/objects/line_items'),
      ),
    ).toHaveLength(1);
  });
});

describe('the invoice date never falls after the due date', () => {
  it('issues a due-on-receipt invoice dated the same day, so it can be opened', async () => {
    // Ref 40 items 1/3/4/6. A guest paying at checkout gets no invoice terms, so reserve
    // sends TODAY as the due date. The issue date used to be the current INSTANT against a
    // due date pinned to that day's UTC midnight, so the invoice fell due hours before it
    // was issued. HubSpot lets that through on a draft and refuses the PATCH to `open`,
    // which is the whole visible failure: no invoice email, no payment link on the order,
    // a buyer left on "we'll email you shortly", and a draft the HubSpot UI throws
    // "There was a problem with the invoice" on.
    const today = new Date().toISOString().slice(0, 10);
    const { portalId, orderId, outboxId } = await seedBooking(today);
    const { invoiceProps } = stubInvoiceHubSpot({ openSucceeds: true });

    const delivery = fakeMessage({ kind: 'invoice.create', portalId, outboxId });
    await handleOutboxMessage(delivery.msg, BASE_ENV);
    expect(delivery.state.acked).toBe(true);

    expect(invoiceProps).toHaveLength(1);
    expect(invoiceProps[0].hs_due_date).toBe(`${today}T00:00:00.000Z`);
    expect(invoiceProps[0].hs_invoice_date).toBe(`${today}T00:00:00.000Z`);

    // The invoice opened, so the buyer's poll has somewhere to send them.
    const order = await BASE_ENV.DB.prepare('SELECT hubspot_invoice_url FROM orders WHERE id = ?1')
      .bind(orderId)
      .first<{ hubspot_invoice_url: string | null }>();
    expect(order?.hubspot_invoice_url).toBe('https://pay.test/inv-1');
  });

  it('gives way to a due date already in the past rather than moving it', async () => {
    const past = '2026-01-05';
    const { portalId, outboxId } = await seedBooking(past);
    const { invoiceProps } = stubInvoiceHubSpot({ openSucceeds: true });

    const delivery = fakeMessage({ kind: 'invoice.create', portalId, outboxId });
    await handleOutboxMessage(delivery.msg, BASE_ENV);

    expect(invoiceProps[0].hs_due_date).toBe(`${past}T00:00:00.000Z`);
    expect(invoiceProps[0].hs_invoice_date).toBe(`${past}T00:00:00.000Z`);
  });
});
