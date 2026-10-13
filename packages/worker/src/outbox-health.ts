/**
 * The outbox health heartbeat.
 *
 * Every HubSpot side effect goes through one table, so one query answers "is anything
 * stuck right now" for every tenant at once. Nothing asked it. The data was always there —
 * Weld's live portal held four bookings with no invoice, a `me.register` HubSpot had never
 * heard of, and a `payment.refund` that could not be parsed, all sitting in D1 for days —
 * and the reason nobody knew is that nothing was looking, not that nothing was recorded.
 *
 * Three decisions worth keeping:
 *
 *  - **It logs every run, clean or not.** A heartbeat that only speaks up when something is
 *    wrong cannot be told apart from a cron that has stopped running, which is exactly the
 *    failure that produced this module: `reconcileOutbox` threw on every run for months and
 *    its silence read as health. `level` is `error` when there is something to act on and
 *    `info` when there is not, so an alert filters on the level rather than the absence.
 *
 *  - **Dead rows are counted over a WINDOW, not all time.** Nothing un-deads a row, so an
 *    all-time count never goes down and would alert forever after the first one. CLAUDE.md
 *    already names that failure: a permanently-firing signal is how a real one stops being
 *    noticed. The window is measured from when a row DIED (`_dead_at`), not from when it
 *    was created: `created_at` is when the booking happened, so a row that retried for a
 *    day before dying was never counted as a recent death at all, and one that died at hour
 *    23 of its life left the alert an hour later.
 *
 *  - **It says how long ago the newest death was.** Nothing un-deads a row, so a fixed
 *    cause keeps this alert firing at error level every fifteen minutes until its rows age
 *    out of the window — and `dead: 2` reads identically whether those two died a minute
 *    ago or yesterday. That cost a morning: the registration-confirmation deaths on Weld's
 *    portal were pre-fix corpses, the write-back having created the missing property itself
 *    hours earlier, and nothing in the line said so. `newestDeathMinutes` is the figure
 *    that separates a backlog to re-drive from a fault still biting.
 *
 *  - **It names the reasons.** The counts say a portal is broken; the reason says what to
 *    do about it, and the reason is what every responder asks for first. It used to be left
 *    to `GET /manage/diagnostics/outbox` on the grounds that one line per portal should
 *    stay readable — but that endpoint needs the portal's admin key, and an error-level
 *    alert nobody can act on without going and finding a credential is most of the way to
 *    an alert nobody acts on. The distinct reasons are few (a failure that hits six rows
 *    hits them the same way), so the top few per topic are carried here, truncated. They
 *    stay OUT of the Slack message: see {@link outboxAlertMessage}.
 *
 *  - **It reports, and changes nothing.** No retry, no re-drive, no decision raised. What
 *    to do about a dead row depends on why it died, and re-driving is an operator action
 *    taken after the cause is fixed.
 */

import { alertOps } from './ops-alert';
import type { Env } from './types';

/**
 * How long a row may sit undelivered before it is STUCK rather than in flight.
 *
 * The sweep re-drives every 15 minutes and a retry that names no delay waits 30 seconds, so
 * an hour is several rounds of ordinary recovery. Generous on purpose: a heartbeat that
 * fires on rows which were about to succeed teaches people to ignore it.
 */
export const OUTBOX_STUCK_AFTER_MS = 60 * 60 * 1000;

/** How far back "died recently" reaches, measured from the death rather than the booking. */
export const OUTBOX_DEAD_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * How much of one reason is carried into the log line.
 *
 * A HubSpot 4xx reason is the whole response body, which can run to kilobytes of validation
 * detail. The first couple of hundred characters carry the status, the method, the URL and
 * the error code, which is what a person reads; the rest is what the endpoint is for.
 */
export const MAX_REASON_CHARS = 200;

/**
 * How many distinct reasons one topic contributes.
 *
 * One fault normally kills every row it touches the same way, so this is almost always
 * generous. The cap is here for the other shape — a portal where each booking fails
 * differently — where a line naming forty reasons is a line nobody finishes reading.
 */
export const MAX_REASONS_PER_TOPIC = 3;

/** What a row with no recorded reason is called, rather than being silently dropped. */
export const UNRECORDED_REASON = '(none recorded)';

/** Rows are grouped in SQL; this is one group. */
export interface OutboxHealthGroup {
  portal_id: string;
  topic: string;
  kind: 'stuck' | 'dead';
  count: number;
  oldest_created_at: string;
  max_attempts: number;
  /**
   * When the most recent of these rows DIED. Only the dead half of the query fills it: a
   * row that is still retrying has not died, and `created_at` is the booking rather than
   * the failure. Optional because a caller that has nothing to say here should say nothing
   * rather than pass a date that means something else.
   */
  newest_died_at?: string | null;
}

/**
 * The same rows, grouped again by the reason they failed.
 *
 * A second grouping rather than a column on {@link OutboxHealthGroup} because one topic can
 * fail several ways at once, and folding them into one string in SQL would put the
 * truncation somewhere it cannot be tested.
 */
export interface OutboxFailureReasonGroup {
  portal_id: string;
  topic: string;
  kind: 'stuck' | 'dead';
  reason: string | null;
  count: number;
}

export interface PortalOutboxHealth {
  portalId: string;
  /** Rows that died inside the window. */
  dead: number;
  /** Rows undelivered for longer than {@link OUTBOX_STUCK_AFTER_MS}. */
  stuck: number;
  /** Age of the longest-waiting stuck row, in whole minutes. */
  oldestStuckMinutes: number;
  /** The most attempts any of this portal's stuck rows has burned. */
  maxAttempts: number;
  /**
   * How long ago the most recent death in the window was, in whole minutes; null when
   * nothing died or the timestamp could not be read.
   *
   * This is what tells a reader whether they are looking at something happening NOW or at
   * the same corpses being re-counted. Nothing un-deads a row and the window runs 24 hours,
   * so a fixed cause keeps firing this alert, at error level, every fifteen minutes until
   * the rows age out — and a count of 2 looks identical whether those two died a minute ago
   * or yesterday. A figure that grows run to run is a backlog to re-drive; a small one is a
   * fault still biting.
   */
  newestDeathMinutes: number | null;
  /** Which topics, worst first, so the line names what to go and look at. */
  topics: Array<{
    topic: string;
    kind: 'stuck' | 'dead';
    count: number;
    /** What the rows behind this count say went wrong, commonest first. */
    reasons: Array<{ reason: string; count: number }>;
  }>;
}

export interface OutboxHealth {
  generatedAt: string;
  totals: { portals: number; dead: number; stuck: number };
  portals: PortalOutboxHealth[];
}

/**
 * Group the reason rows by the portal/kind/topic they belong to, commonest first, and cut
 * each one down to something a log line can carry.
 *
 * Null is kept rather than dropped, under {@link UNRECORDED_REASON}: a row with no
 * `_dead_reason` is one whose payload `json_patch` could not touch, which is the row most
 * worth knowing about, and dropping it would leave the reasons not adding up to the count
 * printed beside them.
 */
function foldReasons(
  reasons: OutboxFailureReasonGroup[],
): Map<string, Array<{ reason: string; count: number }>> {
  const byTopic = new Map<string, Map<string, number>>();

  for (const row of reasons) {
    const key = `${row.portal_id}\u0000${row.kind}\u0000${row.topic}`;
    const trimmed = (row.reason ?? '').trim();
    const label =
      trimmed === ''
        ? UNRECORDED_REASON
        : trimmed.length > MAX_REASON_CHARS
          ? `${trimmed.slice(0, MAX_REASON_CHARS)}…`
          : trimmed;
    // Two reasons differing only past the cut collapse into one, which is the right answer:
    // they are the same fault, and the line is meant to name faults rather than rows.
    const bucket = byTopic.get(key) ?? new Map<string, number>();
    bucket.set(label, (bucket.get(label) ?? 0) + row.count);
    byTopic.set(key, bucket);
  }

  const out = new Map<string, Array<{ reason: string; count: number }>>();
  for (const [key, bucket] of byTopic) {
    out.set(
      key,
      [...bucket.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
        .slice(0, MAX_REASONS_PER_TOPIC),
    );
  }
  return out;
}

/**
 * Fold the SQL groups into one line per portal.
 *
 * Pure, so the shape of the report is testable without a database and cannot drift from
 * what the log line claims.
 */
export function summariseOutboxHealth(
  groups: OutboxHealthGroup[],
  now: Date = new Date(),
  reasons: OutboxFailureReasonGroup[] = [],
): OutboxHealth {
  const byPortal = new Map<string, PortalOutboxHealth>();
  const reasonsByTopic = foldReasons(reasons);

  for (const group of groups) {
    let portal = byPortal.get(group.portal_id);
    if (!portal) {
      portal = {
        portalId: group.portal_id,
        dead: 0,
        stuck: 0,
        oldestStuckMinutes: 0,
        maxAttempts: 0,
        newestDeathMinutes: null,
        topics: [],
      };
      byPortal.set(group.portal_id, portal);
    }

    if (group.kind === 'dead') {
      portal.dead += group.count;
      const died = Date.parse(group.newest_died_at ?? '');
      // Same rule as the stuck age: an unreadable timestamp is not evidence of age, and the
      // count carries the finding either way.
      if (!Number.isNaN(died)) {
        const minutes = Math.max(Math.floor((now.getTime() - died) / 60_000), 0);
        portal.newestDeathMinutes =
          portal.newestDeathMinutes === null
            ? minutes
            : Math.min(portal.newestDeathMinutes, minutes);
      }
    } else {
      portal.stuck += group.count;
      portal.maxAttempts = Math.max(portal.maxAttempts, group.max_attempts);
      const since = Date.parse(group.oldest_created_at);
      // An unparseable timestamp is not evidence of age. Counting it as "now" would
      // understate the wait; inventing one would overstate it. Leave the figure alone and
      // let the count carry the finding.
      if (!Number.isNaN(since)) {
        const minutes = Math.floor((now.getTime() - since) / 60_000);
        portal.oldestStuckMinutes = Math.max(portal.oldestStuckMinutes, Math.max(minutes, 0));
      }
    }

    portal.topics.push({
      topic: group.topic,
      kind: group.kind,
      count: group.count,
      reasons:
        reasonsByTopic.get(`${group.portal_id}\u0000${group.kind}\u0000${group.topic}`) ?? [],
    });
  }

  const portals = [...byPortal.values()];
  for (const portal of portals) {
    portal.topics.sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic));
  }
  // Worst first: the portal with the most stuck bookings is the one to open.
  portals.sort((a, b) => b.stuck - a.stuck || b.dead - a.dead);

  return {
    generatedAt: now.toISOString(),
    totals: {
      portals: portals.length,
      dead: portals.reduce((sum, portal) => sum + portal.dead, 0),
      stuck: portals.reduce((sum, portal) => sum + portal.stuck, 0),
    },
    portals,
  };
}

/**
 * When a dead row died.
 *
 * `_dead_at` is stamped by `markDead`; `created_at` is the fallback for rows that died
 * before it was, and for the one row `markDead` cannot patch — a payload that will not
 * parse. That fallback is exactly the behaviour this replaced, so a legacy row is no worse
 * off than it was.
 *
 * Every payload read here goes through `IIF(json_valid(...))`, spelled out rather than
 * composed, because SQLite RAISES on `json_extract` of malformed JSON for the WHOLE
 * statement: one unparseable row anywhere in a portal's outbox would take the heartbeat
 * down, and `outbox-property-resilience.test.ts` greps for exactly this spelling.
 */
const DIED_AT = `COALESCE(json_extract(IIF(json_valid(payload), payload, '{}'), '$._dead_at'), created_at)`;

/** Why a dead row stopped, as `markDead` recorded it. */
const DEAD_REASON = `json_extract(IIF(json_valid(payload), payload, '{}'), '$._dead_reason')`;

/** Why a row that is still retrying failed last time, as `recordFailureReason` recorded it. */
const LAST_ERROR = `json_extract(IIF(json_valid(payload), payload, '{}'), '$._last_error')`;

/**
 * Read the counts and the reasons behind them, and log them. Returns the report so a caller
 * (and a test) can read what was said without parsing a log line.
 *
 * Separate queries rather than one `OR`: each half has its own partial index
 * (`idx_outbox_drain` for pending/failed, `idx_outbox_dead_recent` for dead), and an OR
 * across them uses neither. The two reason queries re-read the same rows under the same
 * predicates, so they cost a second pass over a set the counts have just shown to be small
 * — and on a clean run, over nothing at all.
 */
export async function reportOutboxHealth(env: Env): Promise<OutboxHealth> {
  const now = new Date();
  const stuckBefore = new Date(now.getTime() - OUTBOX_STUCK_AFTER_MS).toISOString();
  const deadSince = new Date(now.getTime() - OUTBOX_DEAD_WINDOW_MS).toISOString();

  const [stuck, dead, stuckReasons, deadReasons] = await env.DB.batch<
    OutboxHealthGroup | OutboxFailureReasonGroup
  >([
    env.DB.prepare(
      `SELECT portal_id, topic, 'stuck' AS kind, COUNT(*) AS count,
              MIN(created_at) AS oldest_created_at, MAX(attempts) AS max_attempts,
              NULL AS newest_died_at
         FROM outbox
        WHERE status IN ('pending', 'failed') AND created_at <= ?1
        GROUP BY portal_id, topic`,
    ).bind(stuckBefore),
    env.DB.prepare(
      `SELECT portal_id, topic, 'dead' AS kind, COUNT(*) AS count,
              MIN(created_at) AS oldest_created_at, MAX(attempts) AS max_attempts,
              MAX(${DIED_AT}) AS newest_died_at
         FROM outbox
        WHERE status = 'dead' AND ${DIED_AT} >= ?1
        GROUP BY portal_id, topic`,
    ).bind(deadSince),
    env.DB.prepare(
      `SELECT portal_id, topic, 'stuck' AS kind,
              ${LAST_ERROR} AS reason, COUNT(*) AS count
         FROM outbox
        WHERE status IN ('pending', 'failed') AND created_at <= ?1
        GROUP BY portal_id, topic, reason`,
    ).bind(stuckBefore),
    env.DB.prepare(
      `SELECT portal_id, topic, 'dead' AS kind,
              ${DEAD_REASON} AS reason, COUNT(*) AS count
         FROM outbox
        WHERE status = 'dead' AND ${DIED_AT} >= ?1
        GROUP BY portal_id, topic, reason`,
    ).bind(deadSince),
  ]);

  const report = summariseOutboxHealth(
    [...(stuck.results as OutboxHealthGroup[]), ...(dead.results as OutboxHealthGroup[])],
    now,
    [
      ...(stuckReasons.results as OutboxFailureReasonGroup[]),
      ...(deadReasons.results as OutboxFailureReasonGroup[]),
    ],
  );

  console.log(
    JSON.stringify({
      // Clean runs log too: silence here would be indistinguishable from a cron that has
      // stopped, which is the failure this exists to end.
      level: report.totals.stuck > 0 || report.totals.dead > 0 ? 'error' : 'info',
      event: 'outbox_health',
      ...report,
      stuckAfterMinutes: OUTBOX_STUCK_AFTER_MS / 60_000,
      deadWindowHours: OUTBOX_DEAD_WINDOW_MS / 3_600_000,
      // The top few reasons ride along above; the endpoint is still where the payload, the
      // order id and the whole untruncated body are read.
      detail: 'GET /api/v1/manage/diagnostics/outbox',
    }),
  );

  await alertOutboxHealth(env, report);

  return report;
}

/**
 * The Slack half. Split out and pure where it can be, because the message is the part a
 * person reads and the fingerprint is the part that decides whether they read it twice.
 */
export function outboxAlertFingerprint(report: OutboxHealth): string {
  // Coarser than the message ON PURPOSE: a new portal or a new topic is new information, a
  // count ticking from 4 to 5 is not. Without that distinction a standing problem reposts
  // every fifteen minutes and the channel gets muted.
  return report.portals
    .flatMap((portal) => portal.topics.map((t) => `${portal.portalId}:${t.kind}:${t.topic}`))
    .sort()
    .join(',');
}

/**
 * An age a person reads at a glance. Minutes under the hour, hours above it: nobody acting
 * on this needs to know a backlog is 1,387 minutes old.
 */
function humaniseMinutes(minutes: number): string {
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h` : `${minutes}m`;
}

export function outboxAlertMessage(report: OutboxHealth): string {
  // Counts and topics only. A failure reason is a HubSpot response body, and those carry
  // the contact URL the write was for — which is a buyer's email address. The log line
  // above is the worker's own and may hold it; a chat channel may not. Same rule as
  // everything else in ops-alert.ts.
  const lines = [
    `:rotating_light: *Event Engine — the HubSpot write-back is stuck*`,
    ...report.portals.map((portal) => {
      const parts: string[] = [];
      if (portal.stuck > 0) {
        parts.push(
          `${portal.stuck} stuck (oldest ${humaniseMinutes(portal.oldestStuckMinutes)}, ` +
            `${portal.maxAttempts} attempts)`,
        );
      }
      if (portal.dead > 0) {
        // The age of the NEWEST death, because that is what separates "this is happening
        // now" from "these are the same rows you read at the last alert". Without it a
        // fixed cause reads identically to a live one for a further 24 hours.
        const newest =
          portal.newestDeathMinutes === null
            ? ''
            : ` (newest ${humaniseMinutes(portal.newestDeathMinutes)} ago)`;
        parts.push(`${portal.dead} dead in 24h${newest}`);
      }
      const topics = portal.topics
        .slice(0, 4)
        .map((t) => `${t.topic} ×${t.count} ${t.kind}`)
        .join(' · ');
      return `• Portal \`${portal.portalId}\` — ${parts.join(', ')}\n    ${topics}`;
    }),
    // No reason, no email, no order id: the detail lives behind the admin API, where the
    // person reading it has access to it. See the PII rule in ops-alert.ts.
    '_Detail:_ `GET /api/v1/manage/diagnostics/outbox`',
  ];
  return lines.join('\n');
}

async function alertOutboxHealth(env: Env, report: OutboxHealth): Promise<void> {
  const firing = report.totals.stuck > 0 || report.totals.dead > 0;
  await alertOps(env, {
    key: 'outbox-health',
    firing,
    fingerprint: outboxAlertFingerprint(report),
    message: outboxAlertMessage(report),
    recoveryMessage:
      ':white_check_mark: *Event Engine* — outbox clear. Nothing stuck, nothing dead in the last 24h.',
  });
}
