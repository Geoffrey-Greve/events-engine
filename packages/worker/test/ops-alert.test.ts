import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { alertOps, decideOpsAlert, type OpsAlertState } from '../src/ops-alert';
import {
  outboxAlertFingerprint,
  outboxAlertMessage,
  summariseOutboxHealth,
} from '../src/outbox-health';
import type { Env } from '../src/types';

/**
 * The alert channel people read, rather than the one they mute.
 *
 * A stuck outbox row stays stuck, so "post when unhealthy" on a fifteen-minute cron is 96
 * identical messages a day. Everything here is about the difference between that and a
 * message worth reading.
 */

const BASE_ENV = env as unknown as Env;
let counter = 0;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const WEBHOOK = 'https://hooks.slack.test/services/T000/B000/xxx';

/** An Env with the webhook configured and a recording fetch. */
function slackEnv(ok = true) {
  const posts: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
      if (url === WEBHOOK) {
        posts.push(String((JSON.parse(String(init?.body)) as { text: string }).text));
        return new Response(ok ? 'ok' : 'no_service', { status: ok ? 200 : 404 });
      }
      return new Response('{}', { status: 200 });
    }),
  );
  return {
    posts,
    env: { ...BASE_ENV, REFUEL_OPS_SLACK_WEBHOOK_URL: WEBHOOK } as unknown as Env,
  };
}

const freshKey = () => `test-${Date.now()}-${counter++}`;

describe('decideOpsAlert', () => {
  const now = new Date('2026-09-19T12:00:00.000Z');
  const state = (fingerprint: string, postedAt: string): OpsAlertState => ({
    fingerprint,
    postedAt,
  });
  const SIX_HOURS = 6 * 60 * 60 * 1000;

  it('posts the first time, and then stays quiet about the same problem', () => {
    expect(decideOpsAlert(null, { firing: true, fingerprint: 'a' }, now, SIX_HOURS)).toBe('post');
    expect(
      decideOpsAlert(
        state('a', '2026-09-19T11:45:00.000Z'),
        { firing: true, fingerprint: 'a' },
        now,
        SIX_HOURS,
      ),
    ).toBe('suppress');
  });

  it('posts again when the problem changes shape', () => {
    // A new portal or a new topic is new information. This is the whole reason the
    // fingerprint is coarser than the message.
    expect(
      decideOpsAlert(
        state('a', '2026-09-19T11:59:00.000Z'),
        { firing: true, fingerprint: 'a,b' },
        now,
        SIX_HOURS,
      ),
    ).toBe('post');
  });

  it('nags once the renotify interval has passed', () => {
    expect(
      decideOpsAlert(
        state('a', '2026-09-19T05:00:00.000Z'),
        { firing: true, fingerprint: 'a' },
        now,
        SIX_HOURS,
      ),
    ).toBe('repost');
  });

  it('says so when it recovers, and only once', () => {
    expect(
      decideOpsAlert(
        state('a', '2026-09-19T11:00:00.000Z'),
        { firing: false, fingerprint: '' },
        now,
        SIX_HOURS,
      ),
    ).toBe('recovered');
    // Nothing was said, so there is nothing to clear: an all-clear nobody asked about is
    // noise of its own.
    expect(decideOpsAlert(null, { firing: false, fingerprint: '' }, now, SIX_HOURS)).toBe(
      'still-clear',
    );
  });

  it('posts rather than guesses when the stored timestamp is unreadable', () => {
    expect(
      decideOpsAlert(state('a', 'not a date'), { firing: true, fingerprint: 'a' }, now, SIX_HOURS),
    ).toBe('post');
  });
});

describe('alertOps', () => {
  it('posts once, suppresses the repeat, then reports the recovery', async () => {
    const key = freshKey();
    const { posts, env: target } = slackEnv();

    expect(await alertOps(target, { key, firing: true, fingerprint: 'x', message: 'down' })).toBe(
      'post',
    );
    expect(await alertOps(target, { key, firing: true, fingerprint: 'x', message: 'down' })).toBe(
      'suppress',
    );
    expect(
      await alertOps(target, {
        key,
        firing: false,
        fingerprint: '',
        message: 'down',
        recoveryMessage: 'up',
      }),
    ).toBe('recovered');

    expect(posts).toEqual(['down', 'up']);

    // The key is cleared by the recovery, so the next occurrence is news again.
    expect(await alertOps(target, { key, firing: true, fingerprint: 'x', message: 'down' })).toBe(
      'post',
    );
  });

  it('does not let a failed post suppress the next attempt', async () => {
    // One Slack outage must not silence the alert until the fingerprint happens to change.
    const key = freshKey();
    const failing = slackEnv(false);
    expect(
      await alertOps(failing.env, { key, firing: true, fingerprint: 'x', message: 'down' }),
    ).toBe('post');

    const working = slackEnv(true);
    expect(
      await alertOps(working.env, { key, firing: true, fingerprint: 'x', message: 'down' }),
    ).toBe('post');
    expect(working.posts).toEqual(['down']);
  });

  it('posts nothing, and complains about nothing, when no webhook is configured', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response('{}', { status: 200 });
      }),
    );

    const decision = await alertOps(BASE_ENV, {
      key: freshKey(),
      firing: true,
      fingerprint: 'x',
      message: 'down',
    });

    // The decision still says what it would have done; nothing was sent.
    expect(decision).toBe('post');
    expect(calls).toEqual([]);
  });

  it('never throws when Slack does', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    const target = { ...BASE_ENV, REFUEL_OPS_SLACK_WEBHOOK_URL: WEBHOOK } as unknown as Env;
    await expect(
      alertOps(target, { key: freshKey(), firing: true, fingerprint: 'x', message: 'down' }),
    ).resolves.toBe('post');
  });
});

describe('the outbox message', () => {
  const report = () =>
    summariseOutboxHealth(
      [
        {
          portal_id: '441838610',
          topic: 'invoice.create',
          kind: 'stuck',
          count: 4,
          oldest_created_at: '2026-09-18T00:00:00.000Z',
          max_attempts: 136,
        },
        {
          portal_id: '441838610',
          topic: 'contact.sync_registration_confirmation',
          kind: 'dead',
          count: 4,
          oldest_created_at: '2026-09-18T12:00:00.000Z',
          max_attempts: 0,
        },
      ],
      new Date('2026-09-19T12:00:00.000Z'),
    );

  it('names the portal, the counts and where to look', () => {
    const text = outboxAlertMessage(report());
    expect(text).toContain('441838610');
    expect(text).toContain('4 stuck (oldest 36h, 136 attempts)');
    expect(text).toContain('4 dead in 24h');
    expect(text).toContain('invoice.create ×4 stuck');
    expect(text).toContain('/api/v1/manage/diagnostics/outbox');
  });

  it('carries no PII', () => {
    // The worker holds buyer emails, attendee names and dietary answers. None of them
    // belong in a chat channel; the endpoint is where someone with access reads detail.
    const text = outboxAlertMessage(report());
    expect(text).not.toMatch(/@/);
    expect(text).not.toMatch(/_last_error|_dead_reason|orderId/);
  });

  it('changes with the shape of the problem, not with the counts', () => {
    const before = outboxAlertFingerprint(report());
    const worse = summariseOutboxHealth(
      [
        {
          portal_id: '441838610',
          topic: 'invoice.create',
          kind: 'stuck',
          count: 9,
          oldest_created_at: '2026-09-18T00:00:00.000Z',
          max_attempts: 200,
        },
        {
          portal_id: '441838610',
          topic: 'contact.sync_registration_confirmation',
          kind: 'dead',
          count: 40,
          oldest_created_at: '2026-09-18T12:00:00.000Z',
          max_attempts: 0,
        },
      ],
      new Date('2026-09-19T12:00:00.000Z'),
    );
    // More of the same rows is not news; a new topic is.
    expect(outboxAlertFingerprint(worse)).toBe(before);

    const newTopic = summariseOutboxHealth(
      [
        {
          portal_id: '441838610',
          topic: 'deal.create',
          kind: 'stuck',
          count: 1,
          oldest_created_at: '2026-09-18T00:00:00.000Z',
          max_attempts: 2,
        },
      ],
      new Date('2026-09-19T12:00:00.000Z'),
    );
    expect(outboxAlertFingerprint(newTopic)).not.toBe(before);
  });

  it('is empty when nothing is wrong', () => {
    expect(outboxAlertFingerprint(summariseOutboxHealth([], new Date()))).toBe('');
  });
});
