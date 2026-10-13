import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { clearDeathMarks, parseRedriveScope } from '../src/outbox-redrive';
import { manageRoutes } from '../src/routes/manage';
import type { Env } from '../src/types';
import { seedTenant } from './support/fixtures';

/**
 * Re-driving a dead row.
 *
 * `contact.sync_registration_confirmation` is the one HubSpot side effect nothing can
 * recover on its own: `reconcileOutbox` re-derives a missing `me.register` from
 * `marketing_event_state_synced` and a missing deal or invoice from the NULL ids on the
 * order, but whether the confirmation stamp landed is knowable only from the HubSpot
 * contact. So a dead one used to mean an attendee who never got their confirmation email
 * and nothing that would ever try again — which is what four of Weld's bookings were left
 * as after the window before the missing-property repair shipped.
 */

const BASE_ENV = env as unknown as Env;
const ADMIN_KEY = 'redrive-admin-key';

let counter = 0;
// `outbox.portal_id` REFERENCES `tenants`, so the portal is registered as it is minted.
const nextPortal = async () => seedTenant(BASE_ENV.DB, `redrive-${Date.now()}-${counter++}`);

afterEach(async () => {
  await BASE_ENV.DB.prepare("DELETE FROM outbox WHERE portal_id LIKE 'redrive-%'").run();
});

async function seed(
  portalId: string,
  id: string,
  topic: string,
  status: string,
  payload: string,
  attempts = 4,
): Promise<void> {
  await BASE_ENV.DB.prepare(
    `INSERT INTO outbox (id, portal_id, topic, payload, status, attempts, next_attempt_at, stable_interaction_datetime, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?7)`,
  )
    .bind(id, portalId, topic, payload, status, attempts, '2026-09-18T00:00:00.000Z', 'frozen')
    .run();
}

interface RedriveResponse {
  summary: { redriven: number; skipped: number; remaining: number };
  redriven: Array<{ id: string; topic: string }>;
  skipped: Array<{ id: string; topic: string; reason: string }>;
}

async function redrive(portalId: string, body: unknown, key = ADMIN_KEY) {
  const envWithKey = { ...BASE_ENV, [`ADMIN_API_KEY_${portalId}`]: ADMIN_KEY } as unknown as Env;
  const resp = await manageRoutes.fetch(
    new Request('https://worker.test/diagnostics/outbox/redrive', {
      method: 'POST',
      headers: {
        'X-Portal-Id': portalId,
        'X-Admin-Key': key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    envWithKey,
  );
  return { resp, json: resp.status === 200 ? await resp.json<RedriveResponse>() : null };
}

const row = (id: string) =>
  BASE_ENV.DB.prepare(
    'SELECT status, attempts, payload, stable_interaction_datetime FROM outbox WHERE id = ?1',
  )
    .bind(id)
    .first<{
      status: string;
      attempts: number;
      payload: string;
      stable_interaction_datetime: string | null;
    }>();

describe('parseRedriveScope', () => {
  it('refuses an unscoped request rather than replaying a portal’s whole history', () => {
    expect(parseRedriveScope({})).toMatchObject({ ok: false });
    expect(parseRedriveScope(undefined)).toMatchObject({ ok: false });
  });

  it('treats an empty ids array as a caller that resolved nothing, not as "all"', () => {
    const parsed = parseRedriveScope({ ids: [] });
    expect(parsed.ok).toBe(false);
  });

  it('refuses an ids list nobody assembled by hand', () => {
    const many = Array.from({ length: 501 }, (_, i) => `row-${i}`);
    expect(parseRedriveScope({ ids: many })).toMatchObject({ ok: false });
    expect(parseRedriveScope({ ids: many.slice(0, 500) })).toMatchObject({ ok: true });
  });

  it('takes a topic, an orderId or ids, and clamps the limit', () => {
    expect(parseRedriveScope({ topic: 'me.register' })).toMatchObject({
      ok: true,
      scope: { topic: 'me.register', limit: 50 },
    });
    expect(parseRedriveScope({ orderId: 'o1', limit: 9999 })).toMatchObject({
      ok: true,
      scope: { orderId: 'o1', limit: 200 },
    });
    expect(parseRedriveScope({ ids: [' a ', 'a', 'b'], limit: 0 })).toMatchObject({
      ok: true,
      scope: { ids: ['a', 'b'], limit: 1 },
    });
  });
});

describe('clearDeathMarks', () => {
  it('strips how the row died and keeps everything else', () => {
    const cleared = clearDeathMarks(
      JSON.stringify({
        orderId: 'o1',
        _dead_reason: 'property does not exist',
        // The heartbeat windows its dead count on this one, so a stale copy on a row that
        // has been sent round again would report a delivered row as having died.
        _dead_at: '2026-09-18T00:00:01.000Z',
        _last_error: 'property does not exist',
        _last_error_at: '2026-09-18T00:00:00.000Z',
      }),
    );
    expect(JSON.parse(cleared as string)).toEqual({ orderId: 'o1' });
  });

  it('returns null for a payload the dispatcher could never read', () => {
    expect(clearDeathMarks('{not json')).toBeNull();
    expect(clearDeathMarks('[]')).toBeNull();
  });
});

describe('POST /diagnostics/outbox/redrive', () => {
  it('sends a dead confirmation row round again, cleared of how it died', async () => {
    const portalId = await nextPortal();
    await seed(
      portalId,
      'dead-1',
      'contact.sync_registration_confirmation',
      'dead',
      JSON.stringify({ orderId: 'o1', _dead_reason: 'last_event_engine_registration_id' }),
    );

    const { resp, json } = await redrive(portalId, {
      topic: 'contact.sync_registration_confirmation',
    });

    expect(resp.status).toBe(200);
    expect(json?.summary).toEqual({ redriven: 1, skipped: 0, remaining: 0 });

    const after = await row('dead-1');
    expect(after?.status).toBe('pending');
    // The attempt count that earned it a death is reset; the reason it died is gone, so the
    // next failure speaks for itself rather than repeating the old one.
    expect(after?.attempts).toBe(0);
    expect(JSON.parse(after?.payload as string)).toEqual({ orderId: 'o1' });
    // Frozen at first attempt, and a re-drive is still a retry: regenerating it is the one
    // thing the Marketing Event idempotency invariant forbids.
    expect(after?.stable_interaction_datetime).toBe('frozen');
  });

  it('touches only dead rows: a failed row keeps the attempt count that says how long it has been failing', async () => {
    const portalId = await nextPortal();
    await seed(
      portalId,
      'failed-1',
      'invoice.create',
      'failed',
      JSON.stringify({ orderId: 'o1' }),
      136,
    );
    await seed(
      portalId,
      'delivered-1',
      'invoice.create',
      'delivered',
      JSON.stringify({ orderId: 'o1' }),
      1,
    );

    const { json } = await redrive(portalId, { orderId: 'o1' });

    expect(json?.summary).toEqual({ redriven: 0, skipped: 0, remaining: 0 });
    expect(await row('failed-1')).toMatchObject({ status: 'failed', attempts: 136 });
    expect(await row('delivered-1')).toMatchObject({ status: 'delivered' });
  });

  it('skips a payload that will not parse instead of guaranteeing it a second death', async () => {
    const portalId = await nextPortal();
    await seed(portalId, 'malformed-1', 'payment.refund', 'dead', '{not json');

    const { json } = await redrive(portalId, { ids: ['malformed-1'] });

    // Still dead, so still counted as remaining: `remaining` is what this scope has left,
    // not what the re-drive failed to move, and a row that will never move is exactly the
    // thing an operator should see a number for.
    expect(json?.summary).toEqual({ redriven: 0, skipped: 1, remaining: 1 });
    expect(json?.skipped[0]).toMatchObject({ id: 'malformed-1' });
    expect(await row('malformed-1')).toMatchObject({ status: 'dead' });
  });

  it('scopes to one booking, and never reaches another portal’s rows', async () => {
    const portalId = await nextPortal();
    const neighbour = await nextPortal();
    await seed(portalId, 'mine-1', 'me.register', 'dead', JSON.stringify({ orderId: 'o1' }));
    await seed(portalId, 'mine-2', 'me.register', 'dead', JSON.stringify({ orderId: 'o2' }));
    await seed(neighbour, 'theirs-1', 'me.register', 'dead', JSON.stringify({ orderId: 'o1' }));

    const { json } = await redrive(portalId, { orderId: 'o1' });

    expect(json?.summary).toEqual({ redriven: 1, skipped: 0, remaining: 0 });
    expect(await row('mine-1')).toMatchObject({ status: 'pending' });
    expect(await row('mine-2')).toMatchObject({ status: 'dead' });
    expect(await row('theirs-1')).toMatchObject({ status: 'dead' });
  });

  it('reports how many dead rows the scope still holds, so a backlog can be cleared in passes', async () => {
    const portalId = await nextPortal();
    for (let i = 0; i < 5; i++) {
      await seed(portalId, `bulk-${i}`, 'me.register', 'dead', JSON.stringify({ orderId: 'o1' }));
    }

    const first = await redrive(portalId, { topic: 'me.register', limit: 2 });
    expect(first.json?.summary).toEqual({ redriven: 2, skipped: 0, remaining: 3 });

    const second = await redrive(portalId, { topic: 'me.register', limit: 2 });
    expect(second.json?.summary).toEqual({ redriven: 2, skipped: 0, remaining: 1 });

    const third = await redrive(portalId, { topic: 'me.register', limit: 2 });
    expect(third.json?.summary).toEqual({ redriven: 1, skipped: 0, remaining: 0 });
  });

  it('refuses an unscoped request, and an unauthenticated one', async () => {
    const portalId = await nextPortal();
    await seed(portalId, 'dead-2', 'me.register', 'dead', JSON.stringify({ orderId: 'o1' }));

    const unscoped = await redrive(portalId, {});
    expect(unscoped.resp.status).toBe(400);

    const unauthorised = await redrive(portalId, { topic: 'me.register' }, 'wrong-key');
    expect(unauthorised.resp.status).toBe(401);

    expect(await row('dead-2')).toMatchObject({ status: 'dead' });
  });
});

describe('GET /diagnostics/outbox', () => {
  interface DiagnosticResponse {
    scope: { orderId: string | null; topic: string | null; status: string | null; limit: number };
    matched: number;
    summary: { byStatus: Record<string, number> };
    rows: Array<{
      id: string;
      topic: string;
      status: string;
      orderId: string | null;
      reason: string | null;
      attempts: number;
    }>;
  }

  async function diagnose(portalId: string, query = '') {
    const envWithKey = { ...BASE_ENV, [`ADMIN_API_KEY_${portalId}`]: ADMIN_KEY } as unknown as Env;
    const resp = await manageRoutes.fetch(
      new Request(`https://worker.test/diagnostics/outbox${query}`, {
        headers: { 'X-Portal-Id': portalId, 'X-Admin-Key': ADMIN_KEY },
      }),
      envWithKey,
    );
    return { resp, json: resp.status === 200 ? await resp.json<DiagnosticResponse>() : null };
  }

  async function seedMixed(portalId: string): Promise<void> {
    await seed(
      portalId,
      'conf-1',
      'contact.sync_registration_confirmation',
      'dead',
      '{"orderId":"o1"}',
    );
    await seed(
      portalId,
      'conf-2',
      'contact.sync_registration_confirmation',
      'dead',
      '{"orderId":"o2"}',
    );
    await seed(portalId, 'inv-1', 'invoice.create', 'dead', '{"orderId":"o3"}');
    await seed(portalId, 'inv-2', 'invoice.create', 'failed', '{"orderId":"o4"}');
    await seed(portalId, 'deal-1', 'deal.create', 'delivered', '{"orderId":"o1"}');
  }

  it('narrows by topic, which it used to accept and ignore', async () => {
    const portalId = await nextPortal();
    await seedMixed(portalId);

    const { json } = await diagnose(portalId, '?topic=contact.sync_registration_confirmation');

    // The bug this covers: the row list is the most recent undelivered rows up to `limit`,
    // and Weld's portal carries 72 dead ones. A filter that reads as applied and is not one
    // hands a responder a list that can silently omit the rows they asked about.
    expect(json?.rows.map((row) => row.id).sort()).toEqual(['conf-1', 'conf-2']);
    expect(json?.scope.topic).toBe('contact.sync_registration_confirmation');
    expect(json?.matched).toBe(2);
  });

  it('narrows by status, and by both at once', async () => {
    const portalId = await nextPortal();
    await seedMixed(portalId);

    const dead = await diagnose(portalId, '?status=dead');
    expect(dead.json?.rows.map((row) => row.id).sort()).toEqual(['conf-1', 'conf-2', 'inv-1']);

    const both = await diagnose(portalId, '?status=dead&topic=invoice.create');
    expect(both.json?.rows.map((row) => row.id)).toEqual(['inv-1']);
    expect(both.json?.scope).toMatchObject({ status: 'dead', topic: 'invoice.create' });
  });

  it('refuses a status it does not recognise rather than answering with nothing', async () => {
    const portalId = await nextPortal();
    await seedMixed(portalId);

    const { resp } = await diagnose(portalId, '?status=died');

    // An empty list for a typo is indistinguishable from a portal with nothing wrong, which
    // is "we did not look" rendering as "nothing found".
    expect(resp.status).toBe(400);
  });

  it('leaves delivered rows out unless they were asked for', async () => {
    const portalId = await nextPortal();
    await seedMixed(portalId);

    const plain = await diagnose(portalId);
    expect(plain.json?.rows.map((row) => row.id)).not.toContain('deal-1');
    expect(plain.json?.scope.status).toBe('not delivered');

    // Tracing one booking, the delivered rows are half the story: the deal landed, the
    // invoice never did.
    const traced = await diagnose(portalId, '?orderId=o1');
    expect(traced.json?.rows.map((row) => row.id).sort()).toEqual(['conf-1', 'deal-1']);
  });

  it('reports no failure reason against a row that succeeded', async () => {
    const portalId = await nextPortal();
    // A row delivered before the marks were cleared on delivery. Weld's `deal.create` is
    // this exactly: a HubSpot 403 it recovered from days earlier, read back during an
    // incident as though it were the row's current state.
    await seed(
      portalId,
      'deal-recovered',
      'deal.create',
      'delivered',
      JSON.stringify({
        orderId: 'o9',
        _last_error: 'HubSpot 403 POST /crm/v3/objects/deals: MISSING_SCOPES',
        _last_error_at: '2026-09-18T00:00:00.000Z',
      }),
      145,
    );

    const { json } = await diagnose(portalId, '?orderId=o9');
    const row = json?.rows.find((entry) => entry.id === 'deal-recovered') as
      | { reason: string | null; attempts: number }
      | undefined;

    expect(row?.reason).toBeNull();
    // `attempts` is what says the row struggled, and it cannot be read as a live failure.
    expect(row?.attempts).toBe(145);
  });

  it('says how many rows the scope holds, so a truncated list cannot read as a whole one', async () => {
    const portalId = await nextPortal();
    await seedMixed(portalId);

    const { json } = await diagnose(portalId, '?status=dead&limit=1');

    expect(json?.rows).toHaveLength(1);
    expect(json?.matched).toBe(3);
    // The portal picture stays whole on purpose: it is what says where else to look.
    expect(json?.summary.byStatus.delivered).toBe(1);
  });
});
