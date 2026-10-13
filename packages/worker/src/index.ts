import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  finalizeEndedWebinars,
  pollLiveAttendance,
  pullAttendanceJob,
  renewSubscriptions,
} from './attendance';
import { mintTicketForTenant } from './checkin';
import { expireHold } from './expire';
import { reconcileOutbox } from './hubspot-contacts-and-finish';
import { handleOutboxMessage } from './hubspot-writeback';
import { reconcileHubSpotInvoices } from './invoice-reconcile';
import { alertOps } from './ops-alert';
import { reportOutboxHealth } from './outbox-health';
import {
  type ConfirmPaymentJob,
  confirmPayment,
  flagOversellForReview,
  handleRefund,
  type RefundPaymentJob,
} from './payment';
import type { PullAttendanceJob } from './providers/types';
import { adminRoutes } from './routes/admin';
import { appHomeRoutes } from './routes/app-home';
import { checkinRoutes } from './routes/checkin';
import { connectRoutes } from './routes/connect';
import { corporateTeamRoutes } from './routes/corporate-team';
import { exportRoutes } from './routes/exports';
import { handleInstall } from './routes/install';
import { manageRoutes } from './routes/manage';
import { microsoftOAuthRoutes } from './routes/microsoft-oauth';
import { handleOAuthCallback } from './routes/oauth-callback';
import { handleOAuthInstall } from './routes/oauth-install';
import {
  handleGetAvailability,
  handleGetCourseComponents,
  handleGetEventQuestions,
  handleGetOrder,
  handleReserve,
  handleReserveCoursePackage,
  handleReserveSelectedModules,
} from './routes/reserve';
import { handleAppUninstall } from './routes/webhooks-app-uninstall';
import { handleGraphWebhook } from './routes/webhooks-graph';
import { handleHubspotWebhook } from './routes/webhooks-hubspot';
import { handleRefuelWebhook } from './routes/webhooks-refuel';
import { handleZoomWebhook } from './routes/webhooks-zoom';
import type { Env } from './types';

export { EventCapacity } from './do/EventCapacity';

interface ExpireHoldJob {
  kind: 'expire_hold';
  idName: string | null;
  holdId: string;
}

interface OutboxSignal {
  kind: string;
  portalId: string;
  outboxId?: string;
}

const app = new Hono<{ Bindings: Env }>();

// CORS for the browser-side registration module (CMS origin → worker). Credentials are
// never sent (the module uses credentials:'omit'), so reflecting the request origin is
// safe; restrict it per portal by setting CMS_ALLOWED_ORIGIN (comma-separated). This also
// answers the preflight for the custom Idempotency-Key / X-Portal-Id headers, plus the
// Authorization Bearer header the check-in PWA sends on its cross-origin /checkin/* calls.
app.use(
  '/api/v1/*',
  cors({
    origin: (origin, c) => {
      const allowed = (c.env as unknown as { CMS_ALLOWED_ORIGIN?: string }).CMS_ALLOWED_ORIGIN;
      if (!allowed || allowed === '*') return origin || '*';
      return allowed
        .split(',')
        .map((o) => o.trim())
        .includes(origin)
        ? origin
        : '';
    },
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Portal-Id'],
    maxAge: 86400,
  }),
);

// Any unhandled throw used to fall through to Hono's default handler, which answers
// with the plain-text body "Internal Server Error". Browser clients parse these
// responses as JSON, so a plain-text 500 surfaced to buyers as an unattributable
// "something went wrong reaching the booking service" with nothing to trace. Always
// answer JSON, and put the cause in the Worker log with a reference the buyer can
// quote back.
app.onError((err, c) => {
  const ref = crypto.randomUUID().slice(0, 8);
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'unhandled_error',
      ref,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      portalId: c.req.header('X-Portal-Id') ?? null,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    }),
  );
  return c.json(
    {
      status: 'server_error',
      message: 'The booking service hit an unexpected error. Please try again.',
      ref,
    },
    500,
  );
});

app.get('/health', (c) => c.json({ ok: true }));

// Dev-only: seed a test registration + ticket (only active when DEV_SEED_ENABLED=true)
app.post('/dev/seed-ticket', async (c) => {
  if ((c.env as unknown as Record<string, string>).DEV_SEED_ENABLED !== 'true') {
    return c.json({ error: 'Not available' }, 404);
  }
  const body = await c.req.json<{
    portalId?: string;
    eventId?: string;
    ticketTypeId?: string;
    email?: string;
    name?: string;
  }>();
  const portalId = body.portalId ?? '99999999';
  const eventId = body.eventId ?? 'evt_dev_001';
  const ticketTypeId = body.ticketTypeId ?? 'tt_dev_001';
  const email = body.email ?? 'test@example.com';
  const name = body.name ?? 'Test User';
  const now = new Date().toISOString();
  const orderId = crypto.randomUUID();
  const regId = crypto.randomUUID();
  const ticketId = crypto.randomUUID();
  const qrCode = await mintTicketForTenant(c.env, portalId, ticketId, regId, eventId);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO orders (id, portal_id, event_id, status, buyer_email, buyer_name, total_cents, currency, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'paid', ?4, ?5, 9900, 'AUD', ?6, ?6)`,
    ).bind(orderId, portalId, eventId, email, name, now),
    c.env.DB.prepare(
      `INSERT INTO registrations (id, portal_id, order_id, event_id, ticket_type_id, attendee_email, attendee_name, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
    ).bind(regId, portalId, orderId, eventId, ticketTypeId, email, name, now),
    c.env.DB.prepare(
      `INSERT INTO tickets (id, portal_id, registration_id, order_id, event_id, ticket_type_id, status, qr_code, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'issued', ?7, ?8)`,
    ).bind(ticketId, portalId, regId, orderId, eventId, ticketTypeId, qrCode, now),
    c.env.DB.prepare(`UPDATE registrations SET ticket_id = ?1 WHERE id = ?2`).bind(ticketId, regId),
  ]);
  return c.json({ orderId, regId, ticketId, qrCode });
});

app.post('/api/v1/events/:slug/reserve', handleReserve);
app.post('/api/v1/events/:slug/reserve-course-package', handleReserveCoursePackage);
app.post('/api/v1/events/:slug/reserve-selected-modules', handleReserveSelectedModules);
app.get('/api/v1/events/:slug/availability', handleGetAvailability);
app.get('/api/v1/events/:slug/course-components', handleGetCourseComponents);
app.get('/api/v1/events/:slug/questions', handleGetEventQuestions);
app.get('/api/v1/orders/:id', handleGetOrder);
app.post('/webhooks/hubspot', handleHubspotWebhook);
app.post('/webhooks/graph', handleGraphWebhook);
app.post('/webhooks/zoom', handleZoomWebhook);
app.post('/webhooks/app-uninstall', handleAppUninstall);
app.post('/webhooks/refuel', handleRefuelWebhook);
app.route('/api/v1/checkin', checkinRoutes);
app.get('/oauth/callback', handleOAuthCallback);
app.get('/oauth/install', handleOAuthInstall);
app.post('/install', handleInstall);
app.route('/admin', adminRoutes);
app.route('/api/v1/app-home', appHomeRoutes);
app.route('/api/v1/manage', manageRoutes);
app.route('/api/v1/exports', exportRoutes);
app.route('/connect', connectRoutes);
app.route('/oauth/microsoft', microsoftOAuthRoutes);
app.route('/api/v1/corporate', corporateTeamRoutes);

/**
 * Queue `max_retries` from wrangler.toml. Only used to tell a retry apart from the
 * attempt that dead-letters, so a drift here mislabels a log line and breaks nothing.
 */
const QUEUE_MAX_RETRIES = 3;

/**
 * The identifying field for each job kind, so a failure can be traced to the booking
 * it belongs to. Each job carries a different one and none of them is `id`.
 */
export function queueJobSubject(job: { kind: string }): Record<string, string | undefined> {
  switch (job.kind) {
    case 'expire_hold':
      return { holdId: (job as ExpireHoldJob).holdId };
    case 'confirm_payment':
    case 'refund_payment': {
      const j = job as ConfirmPaymentJob | RefundPaymentJob;
      return { portalId: j.portalId, hsInvoiceId: j.hsInvoiceId };
    }
    case 'graph.pull_attendance': {
      const j = job as unknown as PullAttendanceJob;
      return { portalId: j.portalId, webinarId: j.webinarId };
    }
    default: {
      // Outbox-driven HubSpot write-back.
      const j = job as OutboxSignal;
      return { portalId: j.portalId, outboxId: j.outboxId };
    }
  }
}

/**
 * Say why a queue job failed.
 *
 * This catch used to be a bare `catch { msg.retry(); }`: every queue failure retried
 * three times in silence and then dead-lettered with nothing written anywhere. The
 * handlers log on the paths that reach their own catches, and nothing recorded a throw
 * that skipped them. What the customer saw was silence rather than an error — seat
 * held, no deal, no invoice, no payment link, and a checkout sitting on "we'll email
 * your invoice shortly" — which is the hardest shape of this failure to find, because
 * there is nothing to search for.
 *
 * `error` on the attempt that dead-letters, `warn` on one that will be retried, so a
 * transient 429 does not read the same as a booking nobody will ever process.
 *
 * IDS ONLY. An outbox payload carries buyer emails and registration answers (dietary
 * requirements among them, which is health information), and a log line is not
 * somewhere those belong. `queueJobSubject` returns identifiers and nothing else; the
 * outbox row keeps the detail, and `_dead_reason` is patched into it when the row is
 * finally given up on. Keep it that way when adding a job kind.
 *
 * Logging must never throw: a failure to describe the failure would swallow the retry.
 */
export function logQueueFailure(msg: Message<unknown>, job: { kind: string }, err: unknown): void {
  try {
    const attempt = msg.attempts;
    const willRetry = attempt <= QUEUE_MAX_RETRIES;
    console.error(
      JSON.stringify({
        level: willRetry ? 'warn' : 'error',
        event: 'queue_job_failed',
        kind: job?.kind ?? 'unknown',
        ...queueJobSubject(job ?? { kind: 'unknown' }),
        messageId: msg.id,
        attempt,
        willRetry,
        deadLettered: !willRetry,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }),
    );
  } catch {
    // Never let the logger take down the retry it is describing.
    console.error(
      JSON.stringify({ level: 'error', event: 'queue_job_failed', kind: 'unloggable' }),
    );
  }
}

export default {
  fetch: app.fetch,

  async queue(batch: MessageBatch, env: Env, _ctx: ExecutionContext): Promise<void> {
    for (const msg of batch.messages) {
      const job = msg.body as { kind: string };
      try {
        if (job.kind === 'expire_hold') {
          const j = job as ExpireHoldJob;
          await expireHold(env, j.holdId);
          msg.ack();
        } else if (job.kind === 'confirm_payment') {
          const j = job as ConfirmPaymentJob;
          const result = await confirmPayment(env, j);
          if (result.oversold) {
            // No auto-resolve (Phase 18.3): flag for the event owner to decide.
            await flagOversellForReview(env, j);
          }
          msg.ack();
        } else if (job.kind === 'refund_payment') {
          await handleRefund(env, job as RefundPaymentJob);
          msg.ack();
        } else if (job.kind === 'graph.pull_attendance') {
          await pullAttendanceJob(env, job as unknown as PullAttendanceJob);
          msg.ack();
        } else {
          // All other kinds are outbox-driven HubSpot write-backs.
          await handleOutboxMessage(msg as Message<OutboxSignal>, env);
        }
      } catch (err) {
        logQueueFailure(msg, job, err);
        msg.retry();
      }
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    /**
     * Run one cron job, and say so if it throws.
     *
     * A promise handed to `ctx.waitUntil` that rejects is swallowed: there is no handler,
     * no log line, and no failed invocation to notice. `reconcileOutbox` threw on EVERY
     * run for months (a LIKE pattern past D1's 50-byte ceiling) and the only symptom
     * anybody ever saw was bookings quietly not getting their invoice. A cron job that
     * dies is the one kind of failure with no user in front of it to report it, so it has
     * to report itself.
     *
     * Each job is independent: one that throws must not stop the two beside it, which is
     * why they are wrapped one at a time rather than together.
     */
    const run = (job: string, work: Promise<unknown>): void => {
      ctx.waitUntil(
        work.catch(async (err: unknown) => {
          const reason = err instanceof Error ? err.message : String(err);
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'cron_job_failed',
              job,
              cron: controller.cron,
              reason,
              stack: err instanceof Error ? err.stack : undefined,
            }),
          );
          // Slack as well as the log, because this is the one failure the heartbeat cannot
          // report: if `reportOutboxHealth` is the job that died, nothing else is watching.
          // Keyed per job so one broken cron does not drown out another, and no recovery
          // message: a successful run would otherwise cost a KV read on every tick of every
          // cron to discover there was nothing to clear.
          await alertOps(env, {
            key: `cron:${job}`,
            firing: true,
            fingerprint: `${job}:${reason}`,
            message: `:rotating_light: *Event Engine — cron job failed*\n• \`${job}\` on \`${controller.cron}\`\n    ${reason}`,
            renotifyAfterMs: 60 * 60 * 1000,
          });
        }),
      );
    };

    // Cron dispatch:
    //   */5  * * * *  → poll live-window attendance (poll-based providers) +
    //                   finalize ended webinars (pull-once safety, then me.complete)
    //   0 */12 * * *  → renew Graph change-notification subscriptions (~23h expiry)
    //   */15 * * * *  → outbox reconciliation sweep + health heartbeat
    switch (controller.cron) {
      case '*/5 * * * *':
        run('pollLiveAttendance', pollLiveAttendance(env));
        run('finalizeEndedWebinars', finalizeEndedWebinars(env));
        run('reconcileHubSpotInvoices', reconcileHubSpotInvoices(env));
        break;
      case '0 */12 * * *':
        run('renewSubscriptions', renewSubscriptions(env));
        break;
      case '*/15 * * * *':
        run('reconcileOutbox', reconcileOutbox(env));
        run('reportOutboxHealth', reportOutboxHealth(env));
        break;
      default:
        run('reconcileOutbox', reconcileOutbox(env));
        run('reportOutboxHealth', reportOutboxHealth(env));
    }
  },
} satisfies ExportedHandler<Env>;
