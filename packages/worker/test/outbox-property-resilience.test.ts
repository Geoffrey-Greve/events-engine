import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import attendanceSource from '../src/attendance.ts?raw';
import attendanceWritebackSource from '../src/attendance-writeback.ts?raw';
import expireSource from '../src/expire.ts?raw';
import {
  handleOutboxMessage,
  missingPropertyNames,
  PermanentError,
  reconcileOutbox,
} from '../src/hubspot-writeback';
import hubspotWritebackSource from '../src/hubspot-writeback.ts?raw';
import outboxHealthSource from '../src/outbox-health.ts?raw';
import reportingSource from '../src/reporting.ts?raw';
import manageSource from '../src/routes/manage.ts?raw';
import { encryptToken } from '../src/token-crypto';
import type { Env } from '../src/types';
import { seedTenant } from './support/fixtures';

/**
 * A property the portal does not have must not cost a booking its write-back.
 *
 * HubSpot answers a write naming an unknown property with a 400, and a 400 is permanent, so
 * one stray field used to kill the whole outbox row. On the money path that is a customer
 * watching "preparing your invoice" for two minutes with no invoice behind it, over a field
 * that had nothing to do with the money — and the only trace is an `outbox_dead` line in
 * Cloudflare's logs, days from anyone reading it.
 *
 * Weld's live portal produced both halves of this: the registration-confirmation property
 * (migration 0040, never provisioned there) dying once per booking, and a `payment.refund`
 * row whose payload would not parse being re-driven by the reconcile sweep for good.
 */

const BASE_ENV = env as unknown as Env;
const TOKEN_KEY = '0'.repeat(64);

let counter = 0;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // These tests deliberately put an unparseable payload in a table every other suite
  // shares (`isolatedStorage` is off, by config). Leaving one behind breaks their bare
  // `json_extract` assertions — which is the very fault under test here, so clean up
  // rather than making every test file defend against this one.
  await BASE_ENV.DB.prepare('DELETE FROM outbox WHERE json_valid(payload) = 0').run();
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** HubSpot's real refusal, in the shape the parser reads. */
function propertyDoesNotExist(name: string) {
  return json(
    {
      status: 'error',
      message: `Property values were not valid: [{"isValid":false,"message":"Property \\"${name}\\" does not exist","error":"PROPERTY_DOESNT_EXIST","name":"${name}"}]`,
      category: 'VALIDATION_ERROR',
      errors: [
        {
          message: `Property "${name}" does not exist`,
          code: 'PROPERTY_DOESNT_EXIST',
          context: { propertyName: [name] },
        },
      ],
    },
    400,
  );
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
 * A portal with neither ABN property: `abn` on contacts, `hs_buyer_company_abn` on invoices.
 * Everything else behaves.
 */
function stubPortalWithoutAbn() {
  const written: Array<{ url: string; properties: Record<string, string> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      const properties = (body?.properties as Record<string, string> | undefined) ?? null;

      if (properties && properties.abn !== undefined) return propertyDoesNotExist('abn');
      if (properties && properties.hs_buyer_company_abn !== undefined) {
        return propertyDoesNotExist('hs_buyer_company_abn');
      }
      // The contact search posts an array under `properties`; only object writes matter.
      if (properties && !Array.isArray(properties)) written.push({ url, properties });

      if (url.includes('/crm/v4/associations/') && url.endsWith('/labels')) {
        return json({ results: [{ typeId: 1, label: null, category: 'HUBSPOT_DEFINED' }] });
      }
      if (url.includes('/crm/v3/objects/contacts/search'))
        return json({ results: [{ id: 'c-1' }] });
      if (url.includes('/crm/v3/objects/contacts')) return json({ id: 'c-1' });
      if (method === 'POST' && url.endsWith('/crm/v3/objects/invoices'))
        return json({ id: 'inv-1' });
      if (url.includes('/crm/v3/objects/line_items/search')) return json({ message: 'nope' }, 400);
      if (method === 'POST' && url.endsWith('/crm/v3/objects/line_items'))
        return json({ id: 'li-1' });
      if (method === 'GET' && url.includes('/crm/v3/objects/invoices/inv-1')) {
        return json({ id: 'inv-1', properties: { hs_invoice_link: 'https://pay.test/inv-1' } });
      }
      return json({ id: 'ok', properties: {}, results: [] });
    }),
  );
  return written;
}

interface BookingOpts {
  /** Leave `hubspot_deal_id` NULL so invoice.create hits "deal not yet created". */
  noDeal?: boolean;
  /** An order whose lines carry no money, like Weld's imported CAMS rows. */
  zeroValue?: boolean;
  /** How many times this row has already failed. */
  attempts?: number;
  status?: string;
  paymentMethod?: string | null;
  /** Skip the outbox row entirely, to let the reconcile sweep create it. */
  noOutbox?: boolean;
  /** false = a short id, for a case that is not about the LIKE-pattern ceiling. */
  uuidOrderId?: boolean;
}

async function seedAbnBooking(opts: BookingOpts = {}) {
  const n = `${Date.now()}-${counter++}`;
  const portalId = `abn-${n}`;
  const eventId = `evt-${n}`;
  // A UUID by default, because that is what the live checkout mints and it is the half of
  // this that broke: `%"orderId":"<uuid>"%` is 51 bytes and D1 caps a LIKE pattern at 48.
  const orderId = opts.uuidOrderId === false ? `ord-${n}` : crypto.randomUUID();
  const now = new Date().toISOString();

  await BASE_ENV.DB.prepare(
    `INSERT INTO tenants (portal_id, display_name, hs_access_token, hs_refresh_token,
                          hs_token_expires_at, xero_gst_rate_id, created_at)
     VALUES (?1, 'Weld', ?2, ?3, ?4, 'tax-1', ?5)`,
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
    `INSERT INTO events (id, portal_id, hubspot_event_id, title, starts_at, ends_at, capacity,
                         created_at, updated_at)
     VALUES (?1, ?2, 'hs-evt', 'Course', ?3, ?3, 10, ?3, ?3)`,
  )
    .bind(eventId, portalId, now)
    .run();
  const unitCents = opts.zeroValue ? 0 : 585000;
  await BASE_ENV.DB.prepare(
    `INSERT INTO orders (id, portal_id, event_id, status, payment_method, buyer_email,
                         buyer_name, buyer_abn, total_cents, currency, hubspot_deal_id,
                         created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'buyer@weld.test', 'Bree Buyer', '51824753556',
             ?6, 'AUD', ?7, ?8, ?8)`,
  )
    .bind(
      orderId,
      portalId,
      eventId,
      opts.status ?? 'pending',
      opts.paymentMethod === undefined ? 'invoice' : opts.paymentMethod,
      unitCents,
      opts.noDeal ? null : 'deal-1',
      now,
    )
    .run();

  const outboxId = crypto.randomUUID();
  if (!opts.noOutbox) {
    await BASE_ENV.DB.prepare(
      `INSERT INTO outbox (id, portal_id, topic, payload, attempts, created_at)
       VALUES (?1, ?2, 'invoice.create', ?3, ?4, ?5)`,
    )
      .bind(
        outboxId,
        portalId,
        JSON.stringify({
          orderId,
          eventId,
          hubspotEventId: 'hs-evt',
          buyerEmail: 'buyer@weld.test',
          buyerName: 'Bree Buyer',
          buyerAbn: '51824753556',
          totalCents: unitCents,
          currency: 'AUD',
          lineItems: [
            {
              ticketTypeId: `tt-${n}`,
              name: 'AS1796 Cert 10',
              quantity: 1,
              unitCents,
              totalCents: unitCents,
              taxTreatment: 'gst',
              hsTaxRateId: 'tax-1',
              hsProductId: null,
            },
          ],
        }),
        opts.attempts ?? 0,
        now,
      )
      .run();
  }

  return { portalId, orderId, eventId, outboxId };
}

const outboxRow = async (id: string) =>
  await BASE_ENV.DB.prepare('SELECT status, attempts, payload FROM outbox WHERE id = ?1')
    .bind(id)
    .first<{ status: string; attempts: number; payload: string }>();

const outboxStatus = async (id: string) =>
  (
    await BASE_ENV.DB.prepare('SELECT status FROM outbox WHERE id = ?1')
      .bind(id)
      .first<{ status: string }>()
  )?.status;

describe('missingPropertyNames', () => {
  it('reads the name out of the structured error, not the message', () => {
    const body = JSON.stringify({
      status: 'error',
      message:
        'Property values were not valid: [{"isValid":false,"message":"Property \\"last_event_engine_registration_id\\" does not exist","error":"PROPERTY_DOESNT_EXIST","name":"last_event_engine_registration_id"}]',
      errors: [
        {
          message: 'Property "last_event_engine_registration_id" does not exist',
          code: 'PROPERTY_DOESNT_EXIST',
          context: { propertyName: ['last_event_engine_registration_id'] },
        },
      ],
      category: 'VALIDATION_ERROR',
    });
    const err = new PermanentError('HubSpot 400 PATCH url: …', 400, body);
    expect(missingPropertyNames(err)).toEqual(['last_event_engine_registration_id']);
  });

  it('says nothing about a 400 that is not about a missing property', () => {
    const invalidValue = new PermanentError(
      'HubSpot 400',
      400,
      JSON.stringify({
        errors: [{ code: 'INVALID_EMAIL', message: 'Email address is invalid' }],
      }),
    );
    expect(missingPropertyNames(invalidValue)).toEqual([]);
    // A 403 is a scope problem and a 500 is transient: neither is routed around by dropping
    // a field, and treating them as such would hide the real cause.
    expect(missingPropertyNames(new PermanentError('nope', 403, '{}'))).toEqual([]);
    expect(missingPropertyNames(new Error('boom'))).toEqual([]);
  });
});

describe('invoice.create survives a property the portal does not have', () => {
  it('drops the ABN and still issues the invoice', async () => {
    const { portalId, orderId, outboxId } = await seedAbnBooking();
    const written = stubPortalWithoutAbn();

    const { msg, state } = fakeMessage({ kind: 'invoice.create', portalId, outboxId });
    await handleOutboxMessage(msg, BASE_ENV);

    expect(state.acked).toBe(true);
    expect(await outboxStatus(outboxId)).toBe('delivered');

    // The whole point: the booking has an invoice and a payment link to send the buyer to.
    const order = await BASE_ENV.DB.prepare(
      'SELECT hubspot_invoice_id, hubspot_invoice_url FROM orders WHERE id = ?1',
    )
      .bind(orderId)
      .first<{ hubspot_invoice_id: string; hubspot_invoice_url: string }>();
    expect(order?.hubspot_invoice_id).toBe('inv-1');
    expect(order?.hubspot_invoice_url).toBe('https://pay.test/inv-1');

    // Retried without the offending field, not with it — and everything else survived.
    const invoice = written.find((call) => call.url.endsWith('/crm/v3/objects/invoices'));
    expect(invoice?.properties.hs_buyer_company_abn).toBeUndefined();
    expect(invoice?.properties.hs_invoice_status).toBe('draft');
    expect(invoice?.properties.hs_currency).toBe('AUD');
    const contact = written.find((call) => call.url.includes('/crm/v3/objects/contacts/'));
    expect(contact?.properties.abn).toBeUndefined();
    expect(contact?.properties.email).toBe('buyer@weld.test');
  });
});

describe('an outbox payload that will not parse', () => {
  it('is marked dead and acked, not re-driven forever', async () => {
    const n = `${Date.now()}-${counter++}`;
    const portalId = await seedTenant(BASE_ENV.DB, `bad-payload-${n}`);
    const outboxId = crypto.randomUUID();
    await BASE_ENV.DB.prepare(
      `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
       VALUES (?1, ?2, 'payment.refund', ?3, ?4)`,
    )
      .bind(outboxId, portalId, '{not json', new Date().toISOString())
      .run();

    const { msg, state } = fakeMessage({ kind: 'payment.refund', portalId, outboxId });
    await handleOutboxMessage(msg, BASE_ENV);

    // It used to throw straight out of the dispatcher: never marked, never logged as dead,
    // and left `pending` for reconcileOutbox to re-send every fifteen minutes, for good.
    expect(state.acked).toBe(true);
    expect(state.retried).toBe(false);
    expect(await outboxStatus(outboxId)).toBe('dead');
  });
});

describe('a malformed payload cannot take an unrelated query down with it', () => {
  it('reads every outbox json_extract through json_valid', () => {
    // SQLite RAISES on `json_extract` of a payload that is not well-formed JSON, and it
    // raises for the WHOLE statement — so one unparseable row in a portal's outbox broke
    // the expiring-hold batch, the staff-note write-back, the attendance derivation and
    // the 2.2 registration report, none of which had anything to do with that row. The
    // guard is cheap; leaving one of these bare is how the fault comes back somewhere new.
    const sources: Array<[string, string]> = [
      ['expire.ts', expireSource],
      ['attendance-writeback.ts', attendanceWritebackSource],
      ['reporting.ts', reportingSource],
      ['hubspot-writeback.ts', hubspotWritebackSource],
      // The heartbeat runs every fifteen minutes across every portal at once, so one
      // unparseable row here would silence the thing that reports unparseable rows.
      ['outbox-health.ts', outboxHealthSource],
    ];
    for (const [name, source] of sources) {
      const extracts = source.match(/json_extract\([^,]+,/g) ?? [];
      expect(extracts.length, `${name} should still be reading the outbox payload`).toBeGreaterThan(
        0,
      );
      for (const extract of extracts) {
        expect(extract, `${name}: ${extract}`).toContain('json_valid(');
      }
    }
  });

  it('survives one in the table, rather than raising for the whole statement', async () => {
    const n = `${Date.now()}-${counter++}`;
    const portalId = await seedTenant(BASE_ENV.DB, `poison-${n}`);
    await BASE_ENV.DB.prepare(
      `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
       VALUES (?1, ?2, 'payment.refund', ?3, ?4)`,
    )
      .bind(crypto.randomUUID(), portalId, '{not json', new Date().toISOString())
      .run();

    const guarded = BASE_ENV.DB.prepare(
      `SELECT COUNT(*) AS c FROM outbox
        WHERE portal_id = ?1
          AND json_extract(IIF(json_valid(payload), payload, '{}'), '$.orderId') = 'ord-1'`,
    ).bind(portalId);
    await expect(guarded.first<{ c: number }>()).resolves.toMatchObject({ c: 0 });

    // The shape this replaced, kept as the reason the guard is there.
    const bare = BASE_ENV.DB.prepare(
      `SELECT COUNT(*) AS c FROM outbox
        WHERE portal_id = ?1 AND json_extract(payload, '$.orderId') = 'ord-1'`,
    ).bind(portalId);
    await expect(bare.first()).rejects.toThrow(/malformed JSON/i);
  });
});

describe('a row that keeps failing says so, and eventually stops', () => {
  it('records the reason on the row, not only in a warn-level log', async () => {
    // Weld's live portal carried invoice.create rows at 88 and 136 attempts with a blank
    // reason: `_dead_reason` only ever existed for rows that DIED, and the retry path logs
    // at warn, so an error-level search for "why has this booking no invoice" found nothing.
    const { portalId, outboxId } = await seedAbnBooking({ noDeal: true });
    stubPortalWithoutAbn();

    const { msg, state } = fakeMessage({ kind: 'invoice.create', portalId, outboxId });
    await handleOutboxMessage(msg, BASE_ENV);

    expect(state.retried).toBe(true);
    const row = await outboxRow(outboxId);
    expect(row?.status).toBe('failed');
    expect(row?.attempts).toBe(1);
    const payload = JSON.parse(row?.payload ?? '{}') as Record<string, string>;
    expect(payload._last_error).toMatch(/Deal not yet created/);
    expect(payload._last_error_at).toBeTruthy();
    // And the payload it describes is still intact — the reason is added, never swapped in.
    expect(payload.orderId).toBeTruthy();
  });

  it('dies at the attempt ceiling, naming the reason it never got past', async () => {
    const { portalId, outboxId } = await seedAbnBooking({ noDeal: true, attempts: 95 });
    stubPortalWithoutAbn();

    const { msg, state } = fakeMessage({ kind: 'invoice.create', portalId, outboxId });
    await handleOutboxMessage(msg, BASE_ENV);

    // Acked, not retried: there is nothing left to retry into. It is now in `outbox_dead`
    // and in the outbox diagnostic, where a person looks, and can be re-driven by hand.
    expect(state.acked).toBe(true);
    expect(state.retried).toBe(false);
    const row = await outboxRow(outboxId);
    expect(row?.status).toBe('dead');
    const payload = JSON.parse(row?.payload ?? '{}') as Record<string, string>;
    expect(payload._dead_reason).toMatch(/Gave up after 96 attempts.*Deal not yet created/);
  });

  it('waits before retrying an error that names no delay', async () => {
    // `msg.retry()` with no delay re-runs within milliseconds, so a race like "deal.create
    // has not finished yet" spent all four queue attempts before it could possibly have.
    const { portalId, outboxId } = await seedAbnBooking({ noDeal: true });
    stubPortalWithoutAbn();

    let delay: number | undefined;
    const msg = {
      body: { kind: 'invoice.create', portalId, outboxId },
      ack: () => {},
      retry: (opts?: { delaySeconds?: number }) => {
        delay = opts?.delaySeconds;
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal Message stub
    } as any;
    await handleOutboxMessage(msg, BASE_ENV);

    expect(delay).toBeGreaterThan(0);
  });
});

describe('an order with nothing to bill', () => {
  it('declines a free booking without calling it a fault', async () => {
    // `invoice_skipped_zero_value` at warn level reads as "somebody mispriced this course".
    // A free course is not mispriced, and there is nothing for anyone to go and fix.
    const { portalId, outboxId } = await seedAbnBooking({
      zeroValue: true,
      status: 'confirmed',
      paymentMethod: null,
    });
    stubPortalWithoutAbn();
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });

    const { msg, state } = fakeMessage({ kind: 'invoice.create', portalId, outboxId });
    await handleOutboxMessage(msg, BASE_ENV);

    expect(state.acked).toBe(true);
    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const skip = logged.find(
      (entry) =>
        entry.event === 'invoice_not_required_free_booking' ||
        entry.event === 'invoice_skipped_zero_value',
    );
    expect(skip?.event).toBe('invoice_not_required_free_booking');
    expect(skip?.level).toBe('info');
  });

  it('keeps the warning for an order that owes money and bills nothing', async () => {
    // Weld's imported CAMS orders: a total that did not survive into the lines. That is a
    // real fault and still says so.
    const { portalId, orderId, outboxId } = await seedAbnBooking({ zeroValue: true });
    await BASE_ENV.DB.prepare('UPDATE orders SET total_cents = 585000 WHERE id = ?1')
      .bind(orderId)
      .run();
    stubPortalWithoutAbn();
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });

    const { msg } = fakeMessage({ kind: 'invoice.create', portalId, outboxId });
    await handleOutboxMessage(msg, BASE_ENV);

    const logged = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const skip = logged.find((entry) => entry.event === 'invoice_skipped_zero_value');
    expect(skip?.level).toBe('warn');
  });

  it('raises no invoice rather than a draft HubSpot will not open', async () => {
    // Weld's imported CAMS orders all died on `hs_amount_billed 0.00 must be greater than
    // zero` — at the PATCH to `open`, so each attempt left a junk draft on the portal.
    const { portalId, orderId, outboxId } = await seedAbnBooking({ zeroValue: true });
    const written = stubPortalWithoutAbn();

    const { msg, state } = fakeMessage({ kind: 'invoice.create', portalId, outboxId });
    await handleOutboxMessage(msg, BASE_ENV);

    expect(state.acked).toBe(true);
    expect(await outboxStatus(outboxId)).toBe('delivered');
    expect(written.some((call) => call.url.endsWith('/crm/v3/objects/invoices'))).toBe(false);
    const order = await BASE_ENV.DB.prepare('SELECT hubspot_invoice_id FROM orders WHERE id = ?1')
      .bind(orderId)
      .first<{ hubspot_invoice_id: string | null }>();
    expect(order?.hubspot_invoice_id).toBeNull();
  });
});

describe('every contact and company property write goes through writeProperties', () => {
  it('leaves no bare hs() PATCH against a contact or a company', () => {
    // CLAUDE.md says `writeProperties` is how every property write goes out. It was true of
    // ONE handler. `contact.set_join_url` died three times on Weld's portal with
    // `teams_join_url does not exist` while the repair built for exactly that sat one
    // function away, and `contact.sync_attendance` was the same bug armed and waiting:
    // `event_attended`, `event_last_attended_date` and `event_last_attended_name` are all
    // absent from that portal, so the next check-in would have died the same way.
    //
    // Scoped to contacts and companies deliberately. An invoice PATCH writes HubSpot's own
    // standard properties, which the portal cannot be missing, and `hs_invoice_status` has
    // no repair to attempt.
    const bare =
      hubspotWritebackSource.match(
        /\bhs\(\s*token,\s*'PATCH',\s*`\$\{HS_API\}\/crm\/v3\/objects\/(?:contacts|companies)[^`]*`/g,
      ) ?? [];

    expect(bare).toEqual([]);
  });
});

describe('a row that recovers stops carrying the reason it failed', () => {
  it('clears the failure marks when it delivers', async () => {
    const { portalId, outboxId } = await seedAbnBooking({ zeroValue: true });
    stubPortalWithoutAbn();
    // What a row looks like after a failure it later recovers from. Weld's `deal.create`
    // is this: a HubSpot 403 MISSING_SCOPES from days earlier, still on a delivered row,
    // read back during an incident as though it were the row's current state.
    await BASE_ENV.DB.prepare(
      `UPDATE outbox SET payload = json_patch(payload, ?1), attempts = 144 WHERE id = ?2`,
    )
      .bind(
        JSON.stringify({
          _last_error: 'HubSpot 403 POST /crm/v3/objects/deals: MISSING_SCOPES',
          _last_error_at: '2026-09-18T00:00:00.000Z',
        }),
        outboxId,
      )
      .run();

    const { msg } = fakeMessage({ kind: 'invoice.create', portalId, outboxId });
    await handleOutboxMessage(msg, BASE_ENV);

    expect(await outboxStatus(outboxId)).toBe('delivered');
    const row = await outboxRow(outboxId);
    const payload = JSON.parse(row?.payload ?? '{}') as Record<string, unknown>;
    expect(payload._last_error).toBeUndefined();
    expect(payload._last_error_at).toBeUndefined();
    // The payload it was describing is untouched, and `attempts` still says it struggled:
    // a count cannot be mistaken for a live failure the way a reason string can.
    expect(payload.orderId).toBeTruthy();
    expect(row?.attempts).toBe(145);
  });

  it('still reaches a terminal status when the payload will not parse', async () => {
    // `json_remove` RAISES on malformed JSON, for the whole statement, so the row that most
    // needs to reach a terminal status would be the one that could not.
    const { portalId, outboxId } = await seedAbnBooking({ zeroValue: true });
    stubPortalWithoutAbn();
    await BASE_ENV.DB.prepare('UPDATE outbox SET payload = ?1 WHERE id = ?2')
      .bind('{not json', outboxId)
      .run();

    const { msg } = fakeMessage({ kind: 'invoice.create', portalId, outboxId });
    await handleOutboxMessage(msg, BASE_ENV);

    // Dead rather than delivered — an unparseable payload is permanent — but it moved, and
    // did not throw out of the dispatcher.
    expect(['dead', 'delivered']).toContain(await outboxStatus(outboxId));
  });
});

describe('the repair sweep reaches a booking on invoice terms', () => {
  it('re-enqueues the deal and invoice for a pending order that owes money', async () => {
    // It only looked at `status = 'paid'`. A booking on invoice terms stays `pending` until
    // the money lands, up to 90 days, which is the ordinary shape of a Weld booking — so
    // the one sweep that repairs a missing deal never looked at the orders most likely to
    // need it, and their invoice.create waited on a deal nothing was going to create.
    const { portalId, orderId } = await seedAbnBooking({
      noDeal: true,
      noOutbox: true,
      status: 'pending',
      paymentMethod: 'invoice',
    });

    await reconcileOutbox(BASE_ENV, { portalId });

    const topics = await BASE_ENV.DB.prepare(
      `SELECT topic FROM outbox WHERE portal_id = ?1 ORDER BY topic`,
    )
      .bind(portalId)
      .all<{ topic: string }>();
    expect(topics.results.map((row) => row.topic)).toEqual(['deal.create', 'invoice.create']);

    // Idempotent: a second sweep finds the live rows and adds nothing.
    await reconcileOutbox(BASE_ENV, { portalId });
    const again = await BASE_ENV.DB.prepare(`SELECT COUNT(*) AS c FROM outbox WHERE portal_id = ?1`)
      .bind(portalId)
      .first<{ c: number }>();
    expect(again?.c).toBe(2);
    expect(orderId).toBeTruthy();
  });

  it('leaves a free pending booking alone', async () => {
    // NULL payment_method is a free booking (migration 0029): no invoice is owed, and
    // reserve deliberately raises no deal for a public free seat.
    const { portalId } = await seedAbnBooking({
      noDeal: true,
      noOutbox: true,
      status: 'pending',
      paymentMethod: null,
    });

    await reconcileOutbox(BASE_ENV, { portalId });

    const rows = await BASE_ENV.DB.prepare(`SELECT COUNT(*) AS c FROM outbox WHERE portal_id = ?1`)
      .bind(portalId)
      .first<{ c: number }>();
    expect(rows?.c).toBe(0);
  });
});

describe('D1 caps a LIKE pattern at 50 bytes, and our ids are UUIDs', () => {
  it('is the ceiling the reconcile sweep used to build a pattern past', async () => {
    // Not a hypothetical. `%"registrationId":"<uuid>"%` is 57 bytes, and D1 answers a
    // pattern over the limit with an ERROR rather than a non-match — so step 2 of the
    // reconcile sweep threw, and step 3, which repairs a missing deal or invoice, never
    // ran at all. On every portal, since the day it was written.
    //
    // The row is needed: the limit is checked inside the LIKE function, which an empty
    // table never calls, so this passes vacuously without one.
    const probePortal = await seedTenant(BASE_ENV.DB, 'like-probe');
    await BASE_ENV.DB.prepare(
      `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
       VALUES (?1, ?3, 'noop', '{}', ?2)`,
    )
      .bind(crypto.randomUUID(), new Date().toISOString(), probePortal)
      .run();

    const at = BASE_ENV.DB.prepare('SELECT COUNT(*) AS c FROM outbox WHERE payload LIKE ?1').bind(
      'a'.repeat(50),
    );
    await expect(at.first()).resolves.toBeTruthy();

    const over = BASE_ENV.DB.prepare('SELECT COUNT(*) AS c FROM outbox WHERE payload LIKE ?1').bind(
      `%"registrationId":"${crypto.randomUUID()}"%`,
    );
    await expect(over.first()).rejects.toThrow(/pattern too complex/i);
  });

  it('leaves no LIKE over an outbox payload in the worker to hit it', () => {
    for (const [name, source] of [
      ['hubspot-writeback.ts', hubspotWritebackSource],
      ['attendance.ts', attendanceSource],
      ['manage.ts', manageSource],
    ] as Array<[string, string]>) {
      // The SQL shape, not prose about it: a backtick-quoted `payload LIKE ?` inside a
      // query string is what breaks; a comment explaining why it was removed is not.
      expect(
        source,
        `${name} should match an outbox payload by json_extract, not LIKE`,
      ).not.toMatch(/payload LIKE \?/);
    }
  });

  it('finds a UUID booking a live row already holds, and does not double it', async () => {
    // The guard that stops the sweep enqueuing a second deal for an order it is already
    // trying to create one for. Under LIKE this threw, so the guard never ran at all.
    const { portalId, orderId } = await seedAbnBooking({ noDeal: true });

    await reconcileOutbox(BASE_ENV, { portalId });

    const rows = await BASE_ENV.DB.prepare(
      `SELECT topic, COUNT(*) AS c FROM outbox WHERE portal_id = ?1 GROUP BY topic`,
    )
      .bind(portalId)
      .all<{ topic: string; c: number }>();
    // One deal.create raised (the order has none), and the invoice.create already seeded is
    // recognised rather than duplicated.
    expect(rows.results).toEqual(
      expect.arrayContaining([
        { topic: 'deal.create', c: 1 },
        { topic: 'invoice.create', c: 1 },
      ]),
    );
    expect(orderId).toHaveLength(36);
  });
});

describe('an order with nothing to bill is not an order missing its invoice', () => {
  it('raises no invoice.create for a $0 order, however many times the sweep runs', async () => {
    // `handleInvoiceCreate` returns early when the billable total is 0 (HubSpot cannot open
    // an invoice for 0.00), and returning early is what stopped the junk drafts — but it
    // also leaves `hubspot_invoice_id` NULL for ever, which the sweep read as "still
    // missing". So every $0 order was handed a fresh row every fifteen minutes, each one
    // delivering as a no-op: an outbox row per order per sweep, in a table that is never
    // purged, and a share of a `LIMIT 50` budget that the orders which CAN be repaired had
    // to compete for. Weld's imported CAMS bookings are all $0.
    const { portalId } = await seedAbnBooking({ zeroValue: true, noOutbox: true, noDeal: true });

    await reconcileOutbox(BASE_ENV, { portalId });
    await reconcileOutbox(BASE_ENV, { portalId });
    await reconcileOutbox(BASE_ENV, { portalId });

    const rows = await BASE_ENV.DB.prepare(
      `SELECT topic, COUNT(*) AS c FROM outbox WHERE portal_id = ?1 GROUP BY topic`,
    )
      .bind(portalId)
      .all<{ topic: string; c: number }>();

    // The DEAL is still raised, once: a $0 booking is a real booking and HubSpot takes a
    // $0 deal quite happily. It is only the invoice that has nothing to be.
    expect(rows.results).toEqual([{ topic: 'deal.create', c: 1 }]);
  });

  it('still raises one for an order that does have something to bill', async () => {
    const { portalId } = await seedAbnBooking({ noOutbox: true, noDeal: true });

    await reconcileOutbox(BASE_ENV, { portalId });

    const topics = await BASE_ENV.DB.prepare(
      `SELECT topic FROM outbox WHERE portal_id = ?1 ORDER BY topic`,
    )
      .bind(portalId)
      .all<{ topic: string }>();
    expect(topics.results.map((r) => r.topic)).toEqual(['deal.create', 'invoice.create']);
  });
});
