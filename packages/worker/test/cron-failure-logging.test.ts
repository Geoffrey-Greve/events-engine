import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import type { Env } from '../src/types';

/**
 * A cron job that throws has to say so itself.
 *
 * A promise handed to `ctx.waitUntil` that rejects is swallowed: no handler, no log line,
 * no failed invocation to notice. `reconcileOutbox` threw on every run for months (a LIKE
 * pattern past D1's 50-byte ceiling) and the only symptom anyone saw was bookings quietly
 * not getting their invoice. There is no user in front of a cron to report it.
 */

const BASE_ENV = env as unknown as Env;

afterEach(() => {
  vi.restoreAllMocks();
});

/** An Env whose every D1 call fails, so each job on the cron rejects. */
function brokenDbEnv(): Env {
  const boom = () => {
    throw new Error('D1 unavailable');
  };
  return {
    ...BASE_ENV,
    DB: { prepare: boom, batch: boom, exec: boom },
  } as unknown as Env;
}

/**
 * An Env whose D1 answers everything with nothing, so every job finishes cleanly.
 *
 * Deliberately NOT the real binding: running the actual sweep here would read and re-enqueue
 * every other suite's rows out of the shared database, which is both slow and a side effect
 * on data this test does not own. What is under test is the wrapper, not the jobs.
 */
function emptyDbEnv(): Env {
  const statement = {
    bind: () => statement,
    all: async () => ({ results: [], meta: {} }),
    first: async () => null,
    run: async () => ({ meta: { changes: 0 } }),
  };
  return {
    ...BASE_ENV,
    DB: {
      prepare: () => statement,
      batch: async (statements: unknown[]) =>
        statements.map(() => ({ results: [], meta: { changes: 0 } })),
      exec: async () => ({ count: 0 }),
    },
    QUEUE: { send: async () => {}, sendBatch: async () => {} },
  } as unknown as Env;
}

function fakeContext() {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    ctx: {
      waitUntil: (promise: Promise<unknown>) => {
        pending.push(promise);
      },
      passThroughOnException: () => {},
      // biome-ignore lint/suspicious/noExplicitAny: minimal ExecutionContext stub
    } as any,
  };
}

async function runCron(cron: string, target: Env) {
  const errors: string[] = [];
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    errors.push(String(line));
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});

  const { ctx, pending } = fakeContext();
  await worker.scheduled({ cron, scheduledTime: Date.now(), noRetry: () => {} }, target, ctx);
  // waitUntil is what the runtime awaits; the handler itself returns immediately.
  await Promise.all(pending);

  return errors
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return { raw: line };
      }
    })
    .filter((entry) => entry.event === 'cron_job_failed');
}

describe('a cron job that throws', () => {
  it('reaches Slack, not only the log', async () => {
    // The one failure the heartbeat cannot report is the heartbeat itself dying, so this
    // is the alert of last resort.
    const posts: string[] = [];
    const webhook = 'https://hooks.slack.test/services/T000/B000/xxx';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === webhook) {
          posts.push((JSON.parse(String(init?.body)) as { text: string }).text);
        }
        return new Response('ok', { status: 200 });
      }),
    );

    await runCron('*/15 * * * *', {
      ...brokenDbEnv(),
      REFUEL_OPS_SLACK_WEBHOOK_URL: webhook,
    } as unknown as Env);

    expect(posts.some((text) => text.includes('cron job failed'))).toBe(true);
    expect(posts.some((text) => text.includes('reconcileOutbox'))).toBe(true);
    vi.unstubAllGlobals();
  });

  it('names itself, its cron and the reason', async () => {
    const failures = await runCron('*/15 * * * *', brokenDbEnv());

    expect(failures.length).toBeGreaterThan(0);
    const reconcile = failures.find((entry) => entry.job === 'reconcileOutbox');
    expect(reconcile).toMatchObject({ level: 'error', cron: '*/15 * * * *' });
    expect(String(reconcile?.reason)).toMatch(/D1 unavailable/);
    // The stack is what turns "it threw" into "it threw here", which is the whole gap
    // between a swallowed rejection and a fixable one.
    expect(reconcile?.stack).toBeTruthy();
  });

  it('does not let one job take down the ones beside it', async () => {
    // Both jobs on this cron fail independently, and both are reported. Wrapping them
    // together would have lost the second the moment the first threw.
    const failures = await runCron('*/15 * * * *', brokenDbEnv());
    expect(failures.map((entry) => entry.job).sort()).toEqual([
      'reconcileOutbox',
      'reportOutboxHealth',
    ]);
  });

  it('says nothing when the jobs succeed', async () => {
    const failures = await runCron('*/15 * * * *', emptyDbEnv());
    expect(failures).toEqual([]);
  });

  it('covers the other crons too', async () => {
    expect((await runCron('*/5 * * * *', brokenDbEnv())).map((entry) => entry.job).sort()).toEqual([
      'finalizeEndedWebinars',
      'pollLiveAttendance',
      'reconcileHubSpotInvoices',
    ]);
    // An unrecognised schedule still runs the sweep, and is still reported.
    expect((await runCron('0 3 * * *', brokenDbEnv())).length).toBeGreaterThan(0);
  });
});
