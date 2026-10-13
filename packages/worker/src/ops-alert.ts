/**
 * Operator alerts to Slack.
 *
 * REFUEL operates this worker, so these go to REFUEL's own channel, not a tenant's: one
 * incoming webhook, no per-portal routing. When there is more than one operator that
 * becomes a config question, and it is not this one.
 *
 * Four rules, each of which is the difference between an alert channel people read and one
 * they mute:
 *
 *  1. **Never post the same problem twice.** A stuck outbox row stays stuck, so a naive
 *     "post when unhealthy" on a fifteen-minute cron is 96 identical messages a day. A
 *     FINGERPRINT of what is wrong is held in KV, and a repost happens only when the
 *     fingerprint CHANGES (a new portal, a new topic) or when `renotifyAfterMs` has passed.
 *     This is the same argument CLAUDE.md makes for `notify.owner_task`: a permanently
 *     firing signal is how a real one stops being noticed.
 *  2. **Say when it recovers.** An alert with no all-clear leaves someone guessing whether
 *     they fixed it. The recovery posts once and clears the key.
 *  3. **No PII, ever.** These messages carry portal ids, topics and counts. Not a buyer's
 *     email, not an attendee's name, not an answer. The worker holds all three and none of
 *     them belong in a chat channel; the diagnostic endpoint is where a person with access
 *     looks at the detail.
 *  4. **Never fail the thing it describes.** Slack being down, misconfigured or slow must
 *     not fail a cron job. Every failure here is caught and logged.
 *
 * Unconfigured is not an error: without the webhook secret nothing posts and nothing
 * complains, which is what the dev environment and any self-hosted deployment want.
 */

import type { Env } from './types';

/** Wrangler secret holding REFUEL's Slack incoming-webhook URL. */
export const OPS_SLACK_WEBHOOK_SECRET = 'REFUEL_OPS_SLACK_WEBHOOK_URL';

/** What was last said about one alert key. */
export interface OpsAlertState {
  /** What was wrong, at the granularity a repost is worth making. */
  fingerprint: string;
  /** When it was last posted. */
  postedAt: string;
}

export type OpsAlertDecision = 'post' | 'repost' | 'recovered' | 'suppress' | 'still-clear';

/**
 * Whether to say something, given what was last said.
 *
 * Pure, and separate from the posting, because this is the whole design: everything else
 * here is a fetch and a KV write.
 */
export function decideOpsAlert(
  previous: OpsAlertState | null,
  next: { firing: boolean; fingerprint: string },
  now: Date,
  renotifyAfterMs: number,
): OpsAlertDecision {
  if (!next.firing) return previous ? 'recovered' : 'still-clear';
  if (!previous) return 'post';
  // A different set of portals or topics is new information; a count ticking from 4 to 5 is
  // not, which is why the fingerprint is deliberately coarser than the message.
  if (previous.fingerprint !== next.fingerprint) return 'post';
  const since = Date.parse(previous.postedAt);
  if (Number.isNaN(since)) return 'post';
  return now.getTime() - since >= renotifyAfterMs ? 'repost' : 'suppress';
}

async function readState(env: Env, key: string): Promise<OpsAlertState | null> {
  try {
    const raw = await env.KV.get(`ops-alert:${key}`);
    return raw ? (JSON.parse(raw) as OpsAlertState) : null;
  } catch {
    // KV unreadable: treat as "nothing said yet". A duplicate message is a far better
    // failure than a silent one.
    return null;
  }
}

/**
 * Post to the ops channel, at most as often as the rules above allow.
 *
 * Returns what it decided, so a caller (and a test) can assert on the decision rather than
 * on whether a fetch happened.
 */
export async function alertOps(
  env: Env,
  options: {
    /** Groups reposts. One key per kind of problem, e.g. `outbox-health`, `cron:reconcileOutbox`. */
    key: string;
    firing: boolean;
    /** What is wrong, coarsely. Unchanged = the same problem. */
    fingerprint: string;
    /** Posted when firing. */
    message: string;
    /** Posted once when it clears. Omit to stay quiet on recovery. */
    recoveryMessage?: string;
    /** How long an unchanged problem stays quiet before a nag. Default 6 hours. */
    renotifyAfterMs?: number;
  },
): Promise<OpsAlertDecision> {
  const renotifyAfterMs = options.renotifyAfterMs ?? 6 * 60 * 60 * 1000;
  const now = new Date();
  const previous = await readState(env, options.key);
  const decision = decideOpsAlert(
    previous,
    { firing: options.firing, fingerprint: options.fingerprint },
    now,
    renotifyAfterMs,
  );

  if (decision === 'suppress' || decision === 'still-clear') return decision;
  if (decision === 'recovered' && !options.recoveryMessage) {
    await forgetOpsAlert(env, options.key);
    return decision;
  }

  const sent = await postToSlack(
    env,
    decision === 'recovered' ? (options.recoveryMessage as string) : options.message,
    options.key,
  );

  // Only record what was actually said. A failed post must not suppress the next attempt,
  // or one Slack outage silences the alert until the fingerprint happens to change.
  if (sent) {
    if (decision === 'recovered') {
      await forgetOpsAlert(env, options.key);
    } else {
      await writeState(env, options.key, {
        fingerprint: options.fingerprint,
        postedAt: now.toISOString(),
      });
    }
  }

  return decision;
}

async function writeState(env: Env, key: string, state: OpsAlertState): Promise<void> {
  try {
    await env.KV.put(`ops-alert:${key}`, JSON.stringify(state), {
      // Expires well after any renotify interval, so a key cannot outlive the problem it
      // describes and silence a recurrence months later.
      expirationTtl: 7 * 24 * 60 * 60,
    });
  } catch {
    // Same trade as the read: a duplicate message beats a silent one.
  }
}

async function forgetOpsAlert(env: Env, key: string): Promise<void> {
  try {
    await env.KV.delete(`ops-alert:${key}`);
  } catch {
    // Nothing to do; the TTL above clears it eventually.
  }
}

async function postToSlack(env: Env, text: string, key: string): Promise<boolean> {
  const webhook = (env as unknown as Record<string, unknown>)[OPS_SLACK_WEBHOOK_SECRET];
  // Unconfigured is not a failure: dev has no webhook, and neither does a deployment whose
  // operator watches logs instead.
  if (typeof webhook !== 'string' || webhook === '') return false;

  try {
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'ops_alert_failed',
          key,
          status: response.status,
        }),
      );
      return false;
    }
    return true;
  } catch (err) {
    // Never let the notifier fail the job it is describing.
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'ops_alert_failed',
        key,
        reason: err instanceof Error ? err.message : String(err),
      }),
    );
    return false;
  }
}
