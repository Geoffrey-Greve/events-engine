import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_REASON_CHARS,
  MAX_REASONS_PER_TOPIC,
  OUTBOX_DEAD_WINDOW_MS,
  OUTBOX_STUCK_AFTER_MS,
  outboxAlertMessage,
  reportOutboxHealth,
  summariseOutboxHealth,
  UNRECORDED_REASON,
} from '../src/outbox-health';
import type { Env } from '../src/types';
import { seedTenant } from './support/fixtures';

/**
 * The heartbeat. The data was always in D1; nothing was looking at it, which is why four
 * live bookings sat without an invoice for a day and a half.
 */

const BASE_ENV = env as unknown as Env;
let counter = 0;

afterEach(async () => {
  vi.restoreAllMocks();
  await BASE_ENV.DB.prepare("DELETE FROM outbox WHERE portal_id LIKE 'health-%'").run();
});

const agoIso = (ms: number) => new Date(Date.now() - ms).toISOString();

// `outbox.portal_id` REFERENCES `tenants`, so every row's portal is registered first.
async function seedRow(
  portalId: string,
  topic: string,
  status: string,
  createdAgoMs: number,
  attempts = 0,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await seedTenant(BASE_ENV.DB, portalId);
  await BASE_ENV.DB.prepare(
    `INSERT INTO outbox (id, portal_id, topic, payload, status, attempts, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(
      crypto.randomUUID(),
      portalId,
      topic,
      JSON.stringify(payload),
      status,
      attempts,
      agoIso(createdAgoMs),
    )
    .run();
}

describe('summariseOutboxHealth', () => {
  it('folds the groups into one line per portal, worst first', () => {
    const now = new Date('2026-09-19T00:00:00.000Z');
    const report = summariseOutboxHealth(
      [
        {
          portal_id: 'quiet',
          topic: 'note.create',
          kind: 'dead',
          count: 1,
          oldest_created_at: '2026-09-18T23:00:00.000Z',
          max_attempts: 0,
        },
        {
          portal_id: 'busy',
          topic: 'invoice.create',
          kind: 'stuck',
          count: 4,
          oldest_created_at: '2026-09-18T14:00:00.000Z',
          max_attempts: 136,
        },
        {
          portal_id: 'busy',
          topic: 'me.register',
          kind: 'dead',
          count: 2,
          oldest_created_at: '2026-09-18T20:00:00.000Z',
          max_attempts: 0,
        },
      ],
      now,
    );

    expect(report.totals).toEqual({ portals: 2, dead: 3, stuck: 4 });
    // The portal with stuck bookings opens first; a portal with only dead rows follows.
    expect(report.portals.map((portal) => portal.portalId)).toEqual(['busy', 'quiet']);
    const busy = report.portals[0];
    expect(busy).toMatchObject({ stuck: 4, dead: 2, maxAttempts: 136, oldestStuckMinutes: 600 });
    expect(busy.topics[0]).toEqual({
      topic: 'invoice.create',
      kind: 'stuck',
      count: 4,
      reasons: [],
    });
  });

  it('does not invent an age from a timestamp it cannot read', () => {
    const report = summariseOutboxHealth(
      [
        {
          portal_id: 'p',
          topic: 'invoice.create',
          kind: 'stuck',
          count: 1,
          oldest_created_at: 'not a date',
          max_attempts: 3,
        },
      ],
      new Date('2026-09-19T00:00:00.000Z'),
    );
    // The row is still counted: the finding is that it is stuck, not how long for.
    expect(report.totals.stuck).toBe(1);
    expect(report.portals[0].oldestStuckMinutes).toBe(0);
  });

  it('never reports a negative age for a row created in the future', () => {
    const report = summariseOutboxHealth(
      [
        {
          portal_id: 'p',
          topic: 'invoice.create',
          kind: 'stuck',
          count: 1,
          oldest_created_at: '2026-09-20T00:00:00.000Z',
          max_attempts: 0,
        },
      ],
      new Date('2026-09-19T00:00:00.000Z'),
    );
    expect(report.portals[0].oldestStuckMinutes).toBe(0);
  });

  it('hangs each reason off the topic it belongs to, commonest first', () => {
    const report = summariseOutboxHealth(
      [
        {
          portal_id: 'weld',
          topic: 'contact.sync_registration_confirmation',
          kind: 'dead',
          count: 4,
          oldest_created_at: '2026-09-19T03:41:00.000Z',
          max_attempts: 0,
        },
        {
          portal_id: 'weld',
          topic: 'me.register',
          kind: 'dead',
          count: 2,
          oldest_created_at: '2026-09-19T03:41:00.000Z',
          max_attempts: 0,
        },
      ],
      new Date('2026-09-20T00:30:00.000Z'),
      [
        {
          portal_id: 'weld',
          topic: 'contact.sync_registration_confirmation',
          kind: 'dead',
          reason: 'HubSpot 400: last_event_engine_registration_id does not exist',
          count: 3,
        },
        {
          portal_id: 'weld',
          topic: 'contact.sync_registration_confirmation',
          kind: 'dead',
          reason: 'HubSpot 404: contact not found',
          count: 1,
        },
        {
          portal_id: 'weld',
          topic: 'me.register',
          kind: 'dead',
          reason: 'HubSpot 400: marketing event not found',
          count: 2,
        },
      ],
    );

    const topics = report.portals[0].topics;
    const confirmation = topics.find((topic) => topic.topic.startsWith('contact.'));
    expect(confirmation?.reasons).toEqual([
      { reason: 'HubSpot 400: last_event_engine_registration_id does not exist', count: 3 },
      { reason: 'HubSpot 404: contact not found', count: 1 },
    ]);
    // A reason belongs to the topic that failed that way, not to the portal: two topics
    // failing for two reasons is the whole of what a responder needs off this line.
    expect(topics.find((topic) => topic.topic === 'me.register')?.reasons).toEqual([
      { reason: 'HubSpot 400: marketing event not found', count: 2 },
    ]);
  });

  it('names a row that recorded no reason rather than dropping it', () => {
    const report = summariseOutboxHealth(
      [
        {
          portal_id: 'p',
          topic: 'payment.refund',
          kind: 'dead',
          count: 1,
          oldest_created_at: '2026-09-19T00:00:00.000Z',
          max_attempts: 0,
        },
      ],
      new Date('2026-09-19T01:00:00.000Z'),
      [{ portal_id: 'p', topic: 'payment.refund', kind: 'dead', reason: null, count: 1 }],
    );
    // The row with no reason is the one whose payload `json_patch` could not touch, which
    // is the row most worth knowing about. Dropping it would also leave the reasons not
    // adding up to the count printed beside them.
    expect(report.portals[0].topics[0].reasons).toEqual([{ reason: UNRECORDED_REASON, count: 1 }]);
  });

  it('ages the NEWEST death, so a falling backlog cannot read as a live fault', () => {
    const now = new Date('2026-09-20T05:45:00.000Z');
    const report = summariseOutboxHealth(
      [
        {
          portal_id: '441838610',
          topic: 'contact.sync_registration_confirmation',
          kind: 'dead',
          count: 2,
          oldest_created_at: '2026-09-19T06:00:00.000Z',
          max_attempts: 0,
          newest_died_at: '2026-09-19T12:45:00.000Z',
        },
        {
          portal_id: '441838610',
          topic: 'me.register',
          kind: 'dead',
          count: 1,
          oldest_created_at: '2026-09-19T06:00:00.000Z',
          max_attempts: 0,
          newest_died_at: '2026-09-19T07:45:00.000Z',
        },
      ],
      now,
    );

    // 17 hours, not 22: the question is whether anything is dying NOW, and the most recent
    // death is the only row that can answer it. This is the line that separates a cause
    // already fixed — the property the write-back creates on demand, created hours ago —
    // from one still biting, which the count alone cannot do for a further 24 hours.
    expect(report.portals[0].newestDeathMinutes).toBe(17 * 60);
  });

  it('says nothing about a death age it cannot read', () => {
    const report = summariseOutboxHealth(
      [
        {
          portal_id: 'p',
          topic: 'me.register',
          kind: 'dead',
          count: 1,
          oldest_created_at: '2026-09-19T00:00:00.000Z',
          max_attempts: 0,
          newest_died_at: null,
        },
      ],
      new Date('2026-09-19T01:00:00.000Z'),
    );
    // Counted, but no age invented: same rule the stuck age follows.
    expect(report.portals[0].dead).toBe(1);
    expect(report.portals[0].newestDeathMinutes).toBeNull();
  });

  it('truncates a reason and caps how many of them one topic contributes', () => {
    const long = `HubSpot 400 ${'x'.repeat(MAX_REASON_CHARS * 2)}`;
    const report = summariseOutboxHealth(
      [
        {
          portal_id: 'p',
          topic: 'invoice.create',
          kind: 'dead',
          count: 9,
          oldest_created_at: '2026-09-19T00:00:00.000Z',
          max_attempts: 0,
        },
      ],
      new Date('2026-09-19T01:00:00.000Z'),
      [
        { portal_id: 'p', topic: 'invoice.create', kind: 'dead', reason: long, count: 5 },
        ...Array.from({ length: MAX_REASONS_PER_TOPIC + 2 }, (_, i) => ({
          portal_id: 'p',
          topic: 'invoice.create',
          kind: 'dead' as const,
          reason: `reason ${i}`,
          count: 1,
        })),
      ],
    );

    const reasons = report.portals[0].topics[0].reasons;
    expect(reasons).toHaveLength(MAX_REASONS_PER_TOPIC);
    expect(reasons[0].count).toBe(5);
    // A HubSpot 4xx reason is the whole response body; the head of it is what is read.
    expect(reasons[0].reason.length).toBeLessThanOrEqual(MAX_REASON_CHARS + 1);
    expect(reasons[0].reason.startsWith('HubSpot 400 ')).toBe(true);
  });
});

describe('reportOutboxHealth', () => {
  it('finds a stuck row and a recent death, and names the portal', async () => {
    const portalId = `health-${Date.now()}-${counter++}`;
    await seedRow(portalId, 'invoice.create', 'failed', OUTBOX_STUCK_AFTER_MS * 3, 136);
    await seedRow(portalId, 'me.register', 'dead', OUTBOX_DEAD_WINDOW_MS / 2);

    const report = await reportOutboxHealth(BASE_ENV);
    const portal = report.portals.find((row) => row.portalId === portalId);

    expect(portal).toMatchObject({ stuck: 1, dead: 1, maxAttempts: 136 });
    expect(portal?.oldestStuckMinutes).toBeGreaterThanOrEqual(
      (OUTBOX_STUCK_AFTER_MS * 3) / 60_000 - 1,
    );
  });

  it('ignores a row that is still in flight, and a death from last week', async () => {
    const portalId = `health-${Date.now()}-${counter++}`;
    // Younger than the threshold: the sweep has not had its rounds yet, and a heartbeat
    // that fires on rows about to succeed teaches people to ignore it.
    await seedRow(portalId, 'invoice.create', 'failed', 60 * 1000);
    // Nothing un-deads a row, so an all-time count would alert for ever after the first.
    await seedRow(portalId, 'me.register', 'dead', OUTBOX_DEAD_WINDOW_MS * 7);
    await seedRow(portalId, 'deal.create', 'delivered', OUTBOX_STUCK_AFTER_MS * 5);

    const report = await reportOutboxHealth(BASE_ENV);
    expect(report.portals.find((row) => row.portalId === portalId)).toBeUndefined();
  });

  it('logs on a clean run too, because silence is what a dead cron looks like', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });

    await reportOutboxHealth(BASE_ENV);

    const health = lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry.event === 'outbox_health');
    expect(health).toBeTruthy();
    // Level is what an alert filters on, so a clean run is an `info` line rather than none.
    expect(['info', 'error']).toContain(health?.level);
    expect(health?.detail).toBe('GET /api/v1/manage/diagnostics/outbox');
  });

  it('raises the level only when there is something to act on', async () => {
    const portalId = `health-${Date.now()}-${counter++}`;
    const read = async () => {
      const lines: string[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
        lines.push(String(line));
      });
      await reportOutboxHealth(BASE_ENV);
      spy.mockRestore();
      return lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((entry) => entry.event === 'outbox_health');
    };

    const clean = await read();
    const cleanLevel = clean?.level;

    await seedRow(portalId, 'invoice.create', 'failed', OUTBOX_STUCK_AFTER_MS * 2, 40);
    const dirty = await read();

    expect(dirty?.level).toBe('error');
    // The shared D1 may already hold another suite's stuck rows, so the clean run only has
    // to be no worse than the dirty one; what matters is that a stuck row forces `error`.
    expect(['info', 'error']).toContain(cleanLevel);
  });

  it('counts a row by when it DIED, not by when the booking was made', async () => {
    const portalId = `health-${Date.now()}-${counter++}`;
    // The shape this exists for: an `invoice.create` that retried for days and gave up an
    // hour ago. Windowed on `created_at` it was never a recent death at all, so the one
    // kind of row the heartbeat is for was the one kind it could not see.
    await seedRow(portalId, 'invoice.create', 'dead', OUTBOX_DEAD_WINDOW_MS * 5, 96, {
      _dead_at: agoIso(60 * 60 * 1000),
      _dead_reason: 'HubSpot 400 POST /crm/v3/objects/invoices: it is always something',
    });

    const report = await reportOutboxHealth(BASE_ENV);
    const portal = report.portals.find((row) => row.portalId === portalId);

    expect(portal).toMatchObject({ dead: 1 });
    expect(portal?.topics[0].reasons[0]).toMatchObject({ count: 1 });
    expect(portal?.topics[0].reasons[0].reason).toContain('HubSpot 400');
  });

  it('lets a death age out on its own clock, not the booking’s', async () => {
    const portalId = `health-${Date.now()}-${counter++}`;
    // Created inside the window, died before it. Counting this would keep an alert firing
    // over something already dealt with — and it would stop firing at 24h from the BOOKING,
    // which is a deadline nobody chose.
    await seedRow(portalId, 'me.register', 'dead', OUTBOX_DEAD_WINDOW_MS / 2, 4, {
      _dead_at: agoIso(OUTBOX_DEAD_WINDOW_MS * 3),
      _dead_reason: 'settled last week',
    });

    const report = await reportOutboxHealth(BASE_ENV);
    expect(report.portals.find((row) => row.portalId === portalId)).toBeUndefined();
  });

  it('carries the reason into the log line, where the alert is read', async () => {
    const portalId = `health-${Date.now()}-${counter++}`;
    await seedRow(portalId, 'contact.sync_registration_confirmation', 'dead', 60_000, 4, {
      _dead_at: agoIso(60_000),
      _dead_reason: 'HubSpot 400: property last_event_engine_registration_id does not exist',
    });

    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    await reportOutboxHealth(BASE_ENV);

    const health = lines
      .map((line) => JSON.parse(line) as { event?: string; portals?: unknown })
      .find((entry) => entry.event === 'outbox_health');
    const printed = JSON.stringify(
      (health?.portals as Array<{ portalId: string }>).find(
        (portal) => portal.portalId === portalId,
      ),
    );
    expect(printed).toContain('last_event_engine_registration_id');
  });

  it('keeps the reason out of Slack, where a HubSpot body would carry a buyer’s email', () => {
    const message = outboxAlertMessage({
      generatedAt: '2026-09-20T00:30:00.000Z',
      totals: { portals: 1, dead: 1, stuck: 0 },
      portals: [
        {
          portalId: '441838610',
          dead: 1,
          stuck: 0,
          oldestStuckMinutes: 0,
          maxAttempts: 0,
          newestDeathMinutes: 5,
          topics: [
            {
              topic: 'contact.sync_registration_confirmation',
              kind: 'dead',
              count: 1,
              reasons: [
                {
                  reason: 'HubSpot 404 GET /crm/v3/objects/contacts/buyer%40example.com',
                  count: 1,
                },
              ],
            },
          ],
        },
      ],
    });

    expect(message).toContain('contact.sync_registration_confirmation');
    expect(message).not.toContain('buyer%40example.com');
  });

  it('tells Slack how long ago the newest death was', () => {
    const message = outboxAlertMessage({
      generatedAt: '2026-09-20T05:45:00.000Z',
      totals: { portals: 1, dead: 2, stuck: 0 },
      portals: [
        {
          portalId: '441838610',
          dead: 2,
          stuck: 0,
          oldestStuckMinutes: 0,
          maxAttempts: 0,
          newestDeathMinutes: 17 * 60,
          topics: [
            {
              topic: 'contact.sync_registration_confirmation',
              kind: 'dead',
              count: 2,
              reasons: [],
            },
          ],
        },
      ],
    });

    expect(message).toContain('2 dead in 24h (newest 17h ago)');
  });

  it('reads the newest death off the row, an hour after it died', async () => {
    const portalId = `health-${Date.now()}-${counter++}`;
    await seedRow(portalId, 'contact.sync_registration_confirmation', 'dead', 60 * 60 * 1000, 4, {
      _dead_at: agoIso(3 * 60 * 60 * 1000),
      _dead_reason: 'HubSpot 400: property last_event_engine_registration_id does not exist',
    });
    await seedRow(portalId, 'me.register', 'dead', 60 * 60 * 1000, 4, {
      _dead_at: agoIso(60 * 60 * 1000),
      _dead_reason: 'HubSpot 400: marketing event not found',
    });

    const report = await reportOutboxHealth(BASE_ENV);
    const portal = report.portals.find((row) => row.portalId === portalId);

    expect(portal?.dead).toBe(2);
    // The newest of the two, to the minute either side of the clock ticking mid-test.
    expect(portal?.newestDeathMinutes).toBeGreaterThanOrEqual(59);
    expect(portal?.newestDeathMinutes).toBeLessThanOrEqual(61);
  });
});
