/**
 * Provider-agnostic attendance pipeline + the Teams-driven cron jobs.
 *
 * The shape every provider produces is AttendanceRecord (see ./providers/types).
 * processAttendance() is the single place that:
 *   1. matches each record to a registration (ourRegistrationId →
 *      providerRegistrationId → email, in that order),
 *   2. collapses its intervals to earliest-join / latest-leave,
 *   3. enqueues me.attend (stable interactionDateTime = earliest join) and the Phase 2.1
 *      contact.sync_attendance row that lands the same attendance on the contact,
 *   4. logs anything unmatched to attendance_unmatched.
 *
 * Nothing here is Teams-specific — the provider already normalized the records.
 */

import { attendanceSyncSignal, attendanceSyncStatement } from './attendance-writeback';
import type { EventRow } from './db';
import { loadEventByTeamsWebinarId } from './db';
import { getWebinarProvider } from './providers';
import type { AttendanceInterval, AttendanceRecord, PullAttendanceJob } from './providers/types';
import type { Env } from './types';

// ---------------------------------------------------------------------------
// Interval collapsing (exported for unit testing)
// ---------------------------------------------------------------------------

export interface CollapsedInterval {
  join: string | null;
  leave: string | null;
  durationSeconds: number;
}

/** Collapse N join/leave spans to earliest join, latest leave, summed duration. */
export function collapseIntervals(intervals: AttendanceInterval[]): CollapsedInterval {
  let join: string | null = null;
  let leave: string | null = null;
  let durationSeconds = 0;

  for (const iv of intervals) {
    if (iv.join && (join === null || iv.join < join)) join = iv.join;
    if (iv.leave && (leave === null || iv.leave > leave)) leave = iv.leave;
    if (iv.join && iv.leave) {
      const span = (Date.parse(iv.leave) - Date.parse(iv.join)) / 1000;
      if (Number.isFinite(span) && span > 0) durationSeconds += span;
    }
  }

  return { join, leave, durationSeconds: Math.round(durationSeconds) };
}

// ---------------------------------------------------------------------------
// Registration matching
// ---------------------------------------------------------------------------

interface MatchedReg {
  id: string;
  attendee_email: string;
  attendee_name: string;
  hubspot_contact_id: string | null;
  marketing_event_state_synced: number;
}

const REG_COLS =
  'id, attendee_email, attendee_name, hubspot_contact_id, marketing_event_state_synced';

/** ourRegistrationId → providerRegistrationId → email (CLAUDE.md ordering). */
async function matchRegistration(
  db: D1Database,
  portalId: string,
  eventId: string,
  rec: AttendanceRecord,
): Promise<MatchedReg | null> {
  if (rec.ourRegistrationId) {
    const byOurId = await db
      .prepare(
        `SELECT ${REG_COLS} FROM registrations WHERE portal_id = ?1 AND event_id = ?2 AND id = ?3`,
      )
      .bind(portalId, eventId, rec.ourRegistrationId)
      .first<MatchedReg>();
    if (byOurId) return byOurId;
  }

  if (rec.providerRegistrationId) {
    const byProvider = await db
      .prepare(
        `SELECT ${REG_COLS} FROM registrations
         WHERE portal_id = ?1 AND event_id = ?2 AND teams_registration_id = ?3`,
      )
      .bind(portalId, eventId, rec.providerRegistrationId)
      .first<MatchedReg>();
    if (byProvider) return byProvider;
  }

  if (rec.email) {
    const byEmail = await db
      .prepare(
        `SELECT ${REG_COLS} FROM registrations
         WHERE portal_id = ?1 AND event_id = ?2 AND lower(attendee_email) = lower(?3)`,
      )
      .bind(portalId, eventId, rec.email)
      .first<MatchedReg>();
    if (byEmail) return byEmail;
  }

  return null;
}

// ---------------------------------------------------------------------------
// processAttendance
// ---------------------------------------------------------------------------

/**
 * Match + write back one batch of normalized attendance records for an event.
 * Matched → me.attend outbox (idempotent); unmatched → attendance_unmatched.
 */
export async function processAttendance(
  env: Env,
  portalId: string,
  event: EventRow,
  records: AttendanceRecord[],
): Promise<void> {
  const now = new Date().toISOString();
  const stmts: D1PreparedStatement[] = [];
  const signals: { body: Record<string, unknown> }[] = [];

  for (const rec of records) {
    if (rec.role !== 'Attendee') continue;

    const collapsed = collapseIntervals(rec.intervals);
    const reg = await matchRegistration(env.DB, portalId, event.id, rec);

    if (!reg) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO attendance_unmatched
             (id, portal_id, event_id, teams_webinar_id, display_name, email,
              join_time, leave_time, duration_seconds, raw, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
        ).bind(
          crypto.randomUUID(),
          portalId,
          event.id,
          event.teams_webinar_id ?? '',
          rec.displayName ?? null,
          rec.email ?? null,
          collapsed.join,
          collapsed.leave,
          collapsed.durationSeconds,
          JSON.stringify(rec.raw ?? rec),
          now,
        ),
      );
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'attendance_unmatched',
          portalId,
          eventId: event.id,
          webinarId: event.teams_webinar_id ?? null,
          email: rec.email ?? null,
          displayName: rec.displayName ?? null,
          ourRegistrationId: rec.ourRegistrationId ?? null,
          providerRegistrationId: rec.providerRegistrationId ?? null,
        }),
      );
      continue;
    }

    // Idempotency: already attended, or an me.attend is already queued.
    //
    // By json_extract, not LIKE: `%"registrationId":"<uuid>"%` is 57 bytes and D1 caps a
    // LIKE pattern at 50, answering a longer one with an error rather than a non-match.
    // See reconcileOutbox, where the same pattern was silently killing the repair sweep.
    if (reg.marketing_event_state_synced === 2) continue;
    const existing = await env.DB.prepare(
      `SELECT id FROM outbox WHERE topic = 'me.attend'
          AND json_extract(IIF(json_valid(payload), payload, '{}'), '$.registrationId') = ?1
          AND status NOT IN ('dead')`,
    )
      .bind(reg.id)
      .first<{ id: string }>();
    if (existing) continue;

    const outboxId = crypto.randomUUID();
    const attendanceOutboxId = crypto.randomUUID();
    // Stable interactionDateTime so HubSpot attendance retries are idempotent.
    const interactionDateTime = collapsed.join ?? now;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO outbox (id, portal_id, topic, payload, stable_interaction_datetime, created_at)
         VALUES (?1, ?2, 'me.attend', ?3, ?4, ?5)`,
      ).bind(
        outboxId,
        portalId,
        JSON.stringify({
          registrationId: reg.id,
          attendeeEmail: reg.attendee_email,
          hubspotContactId: reg.hubspot_contact_id,
          hubspotEventId: event.hubspot_event_id,
          externalAccountId: portalId,
        }),
        interactionDateTime,
        now,
      ),
      // Phase 2.1: joining a webinar is attending, so it reaches the contact by the same
      // route a door scan does — the certificate flow should not care which kind of event
      // it was. Same stable join time, so a replay writes the same date.
      attendanceSyncStatement(
        env,
        portalId,
        attendanceOutboxId,
        {
          registrationId: reg.id,
          eventId: event.id,
          attendeeEmail: reg.attendee_email,
          attendeeName: reg.attendee_name,
          hubspotContactId: reg.hubspot_contact_id,
          attendedAt: interactionDateTime,
          eventTitle: event.title,
        },
        now,
      ),
    );
    signals.push(
      { body: { kind: 'me.attend', portalId, outboxId, registrationId: reg.id } },
      { body: attendanceSyncSignal(portalId, attendanceOutboxId, reg.id) },
    );
  }

  if (stmts.length > 0) await env.DB.batch(stmts);
  if (signals.length > 0) {
    try {
      await env.QUEUE.sendBatch(signals);
    } catch {
      // Best-effort — reconcileOutbox re-drives any pending rows.
    }
  }
}

// ---------------------------------------------------------------------------
// Pull a single webinar's attendance (queue: graph.pull_attendance)
// ---------------------------------------------------------------------------

export async function pullAttendanceJob(env: Env, job: PullAttendanceJob): Promise<void> {
  const event = await loadEventByTeamsWebinarId(env.DB, job.portalId, job.webinarId);
  if (!event) return;
  await pullAttendanceForEvent(env, job.portalId, event);
}

async function pullAttendanceForEvent(env: Env, portalId: string, event: EventRow): Promise<void> {
  if (!event.teams_session_id || !event.teams_webinar_id) return;
  const provider = getWebinarProvider(env, portalId, event.provider);
  if (!provider) return;

  const records = await provider.fetchAttendance(event.teams_webinar_id, event.teams_session_id);
  await processAttendance(env, portalId, event, records);
}

// ---------------------------------------------------------------------------
// Cron: renew change-notification subscriptions (0 */12 * * *)
// ---------------------------------------------------------------------------

/**
 * Renew (or create) each tenant's webinar subscription. ensureSubscription is
 * idempotent: it PATCHes a live subscription's expiry or creates a fresh one.
 */
export async function renewSubscriptions(env: Env): Promise<void> {
  const tenants = await env.DB.prepare(
    `SELECT DISTINCT portal_id, provider FROM events WHERE provider IS NOT NULL`,
  ).all<{ portal_id: string; provider: string }>();

  for (const t of tenants.results) {
    const provider = getWebinarProvider(env, t.portal_id, t.provider);
    if (!provider) continue;
    try {
      await provider.ensureSubscription({ portalId: t.portal_id });
    } catch {
      // One tenant's Graph hiccup must not block the others — next cron retries.
    }
  }
}

// ---------------------------------------------------------------------------
// Cron: poll live-window attendance for poll-based providers (*/5 * * * *)
// ---------------------------------------------------------------------------

/**
 * Pull attendance for in-window events on poll-based providers (Meet / ON24 /
 * Wistia / Vimeo) and Zoom (as a missed-webhook backstop). Teams is excluded:
 * it's driven by its change-notification subscription + missed-event catch-up.
 *
 * Idempotent: processAttendance dedups me.attend per registration, so repeatedly
 * polling the same live event is safe.
 */
export async function pollLiveAttendance(env: Env): Promise<void> {
  const now = new Date().toISOString();
  const due = await env.DB.prepare(
    `SELECT * FROM events
     WHERE provider IS NOT NULL AND provider != 'teams'
       AND teams_webinar_id IS NOT NULL
       AND marketing_event_completed = 0 AND starts_at <= ?1
     LIMIT 50`,
  )
    .bind(now)
    .all<EventRow>();

  for (const event of due.results) {
    try {
      await pullAttendanceForEvent(env, event.portal_id, event);
    } catch {
      // One provider's hiccup must not block the rest — next cron retries.
    }
  }
}

// ---------------------------------------------------------------------------
// Cron: finalize ended webinars (*/5 * * * *)
// ---------------------------------------------------------------------------

/**
 * After ends_at, pull attendance once (missed-webhook safety) then enqueue
 * me.complete and flag the event so it's finalized exactly once.
 */
export async function finalizeEndedWebinars(env: Env): Promise<void> {
  const now = new Date().toISOString();
  const due = await env.DB.prepare(
    `SELECT * FROM events
     WHERE provider IS NOT NULL AND teams_webinar_id IS NOT NULL
       AND marketing_event_completed = 0 AND ends_at < ?1
     LIMIT 50`,
  )
    .bind(now)
    .all<EventRow>();

  for (const event of due.results) {
    // 1. One last pull in case the report-ready notification was missed.
    try {
      await pullAttendanceForEvent(env, event.portal_id, event);
    } catch {
      // Best-effort — completion still proceeds; cron re-pulls live webinars.
    }

    // 2. Enqueue me.complete + mark completed atomically (so we finalize once).
    const outboxId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
         VALUES (?1, ?2, 'me.complete', ?3, ?4)`,
      ).bind(
        outboxId,
        event.portal_id,
        JSON.stringify({
          externalEventId: event.hubspot_event_id,
          externalAccountId: event.portal_id,
          // HubSpot's complete endpoint requires both; the handler falls back to reading
          // them off the event when an older row does not carry them.
          startDateTime: event.starts_at,
          endDateTime: event.ends_at,
        }),
        now,
      ),
      env.DB.prepare(
        `UPDATE events SET marketing_event_completed = 1, updated_at = ?1 WHERE id = ?2`,
      ).bind(now, event.id),
    ]);

    try {
      await env.QUEUE.send({ kind: 'me.complete', portalId: event.portal_id, outboxId });
    } catch {
      // reconcileOutbox re-drives the pending row.
    }
  }
}
