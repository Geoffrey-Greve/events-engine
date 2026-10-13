/**
 * Queue failures used to be silent.
 *
 * `queue()` wrapped every job in `catch { msg.retry(); }` — no log, no job kind, no
 * booking id, no error. The outbox path writes its own failure rows, but the four
 * non-outbox kinds (an expiring hold, a payment confirmation, a refund, an attendance
 * pull) retried three times into a dead-letter queue with nothing written anywhere.
 * The first anyone heard of one was a customer, and by then there was no trace of why.
 *
 * These tests pin the log: that it happens at all, that it names the booking, that it
 * distinguishes a retry from the attempt that dead-letters, that it cannot itself throw,
 * and that one failing message does not stop the rest of the batch.
 */
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { logQueueFailure, queueJobSubject } from '../src/index';
import type { Env } from '../src/types';

interface StubMessage {
  id: string;
  attempts: number;
  body: unknown;
  ack: () => void;
  retry: () => void;
}

function stubMessage(body: unknown, attempts = 1, onAck?: () => void): StubMessage {
  return {
    id: `msg-${Math.random().toString(16).slice(2)}`,
    attempts,
    body,
    ack: onAck ?? vi.fn(),
    retry: vi.fn(),
  };
}

/** Captures console.error and returns every line parsed as JSON. */
function captureLogs() {
  const lines: Array<Record<string, unknown>> = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    for (const arg of args) {
      if (typeof arg !== 'string') continue;
      try {
        lines.push(JSON.parse(arg));
      } catch {
        lines.push({ raw: arg });
      }
    }
  });
  return { lines, spy };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('queueJobSubject', () => {
  // Each job kind carries a different identifying field and none of them is `id`, so a
  // generic log would name the message and not the booking behind it.
  it('names the hold for expire_hold', () => {
    expect(queueJobSubject({ kind: 'expire_hold', holdId: 'hold-1' } as never)).toEqual({
      holdId: 'hold-1',
    });
  });

  it('names the invoice and portal for the payment kinds', () => {
    const subject = { portalId: '441838610', hsInvoiceId: 'inv-9' };
    expect(queueJobSubject({ kind: 'confirm_payment', ...subject } as never)).toEqual(subject);
    expect(queueJobSubject({ kind: 'refund_payment', ...subject } as never)).toEqual(subject);
  });

  it('names the webinar for an attendance pull', () => {
    expect(
      queueJobSubject({
        kind: 'graph.pull_attendance',
        portalId: '441838610',
        webinarId: 'web-3',
      } as never),
    ).toEqual({ portalId: '441838610', webinarId: 'web-3' });
  });

  it('names the outbox row for a HubSpot write-back', () => {
    expect(
      queueJobSubject({ kind: 'invoice.create', portalId: '441838610', outboxId: 'ob-7' } as never),
    ).toEqual({ portalId: '441838610', outboxId: 'ob-7' });
  });
});

describe('logQueueFailure', () => {
  it('warns while the job will still be retried', () => {
    const { lines } = captureLogs();
    logQueueFailure(
      stubMessage(null, 2) as unknown as Message<unknown>,
      { kind: 'confirm_payment', portalId: '441838610', hsInvoiceId: 'inv-9' } as never,
      new Error('HubSpot 429'),
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'warn',
      event: 'queue_job_failed',
      kind: 'confirm_payment',
      hsInvoiceId: 'inv-9',
      portalId: '441838610',
      attempt: 2,
      willRetry: true,
      deadLettered: false,
      message: 'HubSpot 429',
    });
  });

  it('escalates to error on the attempt that dead-letters', () => {
    // max_retries = 3 in wrangler.toml, so the 4th attempt is the last one.
    const { lines } = captureLogs();
    logQueueFailure(
      stubMessage(null, 4) as unknown as Message<unknown>,
      { kind: 'expire_hold', holdId: 'hold-1' } as never,
      new Error('D1 unavailable'),
    );

    expect(lines[0]).toMatchObject({
      level: 'error',
      willRetry: false,
      deadLettered: true,
      holdId: 'hold-1',
    });
  });

  it('carries the stack, because the point is to find the cause later', () => {
    const { lines } = captureLogs();
    logQueueFailure(
      stubMessage(null, 1) as unknown as Message<unknown>,
      { kind: 'refund_payment', portalId: 'p', hsInvoiceId: 'i' } as never,
      new Error('boom'),
    );
    expect(typeof lines[0].stack).toBe('string');
  });

  it('describes a non-Error throw rather than logging [object Object]', () => {
    const { lines } = captureLogs();
    logQueueFailure(
      stubMessage(null, 1) as unknown as Message<unknown>,
      { kind: 'expire_hold', holdId: 'h' } as never,
      'plain string failure',
    );
    expect(lines[0].message).toBe('plain string failure');
  });

  it('never throws, so it cannot swallow the retry it is describing', () => {
    const { lines } = captureLogs();
    const hostile = {
      get id(): string {
        throw new Error('message is unreadable');
      },
      attempts: 1,
    };

    expect(() =>
      logQueueFailure(hostile as unknown as Message<unknown>, undefined as never, new Error('x')),
    ).not.toThrow();
    expect(lines[0]).toMatchObject({ event: 'queue_job_failed', kind: 'unloggable' });
  });
});

/**
 * An env whose D1 is unavailable. Deterministic regardless of what the rest of the
 * suite has migrated: an earlier version of these tests leaned on `orders` not
 * existing yet, which passed alone and failed in the full run once another file had
 * created it. "D1 is down" is also the real failure this logging exists to surface.
 */
function envWithBrokenDb(): Env {
  return {
    ...(env as unknown as Record<string, unknown>),
    DB: {
      prepare() {
        throw new Error('D1_ERROR: connection lost');
      },
      batch() {
        throw new Error('D1_ERROR: connection lost');
      },
    },
  } as unknown as Env;
}

describe('queue()', () => {
  it('logs and retries a failing job instead of failing silently', async () => {
    const { lines } = captureLogs();
    const failing = stubMessage({ kind: 'expire_hold', holdId: 'hold-42' });

    await worker.queue(
      { messages: [failing] } as unknown as MessageBatch,
      envWithBrokenDb(),
      {} as ExecutionContext,
    );

    expect(failing.retry).toHaveBeenCalledTimes(1);
    const failure = lines.find((line) => line.event === 'queue_job_failed');
    // The identity of the failing job is the point: before this, none of it was written.
    expect(failure).toMatchObject({
      kind: 'expire_hold',
      holdId: 'hold-42',
      willRetry: true,
      deadLettered: false,
      message: 'D1_ERROR: connection lost',
    });
  });

  it('does not let one bad message take down the rest of the batch', async () => {
    captureLogs();
    const failing = stubMessage({ kind: 'expire_hold', holdId: 'hold-bad' });
    // No outboxId, so handleOutboxMessage acks and returns before it reads D1.
    const healthy = stubMessage({ kind: 'contact.upsert', portalId: '441838610' });

    await worker.queue(
      { messages: [failing, healthy] } as unknown as MessageBatch,
      envWithBrokenDb(),
      {} as ExecutionContext,
    );

    expect(failing.retry).toHaveBeenCalledTimes(1);
    expect(healthy.ack).toHaveBeenCalledTimes(1);
    expect(healthy.retry).not.toHaveBeenCalled();
  });
});
