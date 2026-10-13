/**
 * Check-in API (event-day scanning).
 *
 *   POST /api/v1/checkin                 — verify a single scan, mark attended
 *   POST /api/v1/checkin/batch           — flush an offline scan queue
 *   GET  /api/v1/checkin/manifest/:eventId — signed code list + derived verify key
 *   GET  /api/v1/checkin/stats/:eventId  — live registered vs attended
 *   POST /api/v1/checkin/device-token    — issue a device token (ADMIN auth)
 *
 * All scan/read routes are gated by deviceAuth (an event-scoped device token).
 * device-token issuance is gated by admin auth — devices cannot mint their own.
 *
 * Marking attendance follows the CLAUDE.md invariant: the ticket state change and
 * the me.attend + contact.sync_attendance outbox rows are written in one D1 batch,
 * then the queue is signalled (cron is the backstop). The recorded arrival time is
 * used as the STABLE interactionDateTime so HubSpot write-back retries are idempotent.
 */

import type { ManifestAnswer } from '@paddock/shared';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { attendanceSyncSignal, attendanceSyncStatement } from '../attendance-writeback';
import {
  authenticateAdmin,
  type CheckinBindings,
  type DeviceClaims,
  deviceAuth,
  exportKeyB64url,
  getEventVerifyKey,
  issueDeviceToken,
  mintTicketCode,
  verifyTicketCode,
} from '../checkin';
import { loadEvent } from '../db';
import { listEventAnswers } from '../questions';
import { summariseEventRegistrations } from '../reporting';
import type { Env } from '../types';

// ---------------------------------------------------------------------------
// Per-scan processing (shared by single + batch)
// ---------------------------------------------------------------------------

type ScanOutcome =
  | 'checked_in'
  | 'already_checked_in'
  | 'cancelled'
  | 'invalid_signature'
  | 'wrong_event'
  | 'not_found';

interface ScanResult {
  code: string;
  status: ScanOutcome;
  ok: boolean;
  checkedInAt?: string;
  attendeeName?: string;
}

interface TicketJoinRow {
  ticket_status: string;
  checked_in_at: string | null;
  registration_id: string;
  attendee_name: string;
  attendee_email: string;
  hubspot_contact_id: string | null;
  hubspot_event_id: string;
  event_title: string;
}

/**
 * Verify one scanned code and, if valid and not already checked in, mark the
 * ticket attended at `recordedAt`. Pure per-scan unit — single and batch share it.
 */
async function processScan(
  env: Env,
  claims: DeviceClaims,
  eventKey: CryptoKey,
  code: string,
  recordedAt: string,
): Promise<ScanResult> {
  const portalId = claims.portalId;

  const payload = await verifyTicketCode(code, eventKey);
  if (!payload) return { code, status: 'invalid_signature', ok: false };
  if (payload.eid !== claims.eid) return { code, status: 'wrong_event', ok: false };

  const row = await env.DB.prepare(
    `SELECT t.status            AS ticket_status,
            t.checked_in_at     AS checked_in_at,
            t.registration_id   AS registration_id,
            r.attendee_name     AS attendee_name,
            r.attendee_email    AS attendee_email,
            r.hubspot_contact_id AS hubspot_contact_id,
            e.hubspot_event_id  AS hubspot_event_id,
            e.title             AS event_title
     FROM tickets t
     JOIN registrations r ON r.id = t.registration_id
     JOIN events e        ON e.id = t.event_id
     WHERE t.id = ?1 AND t.portal_id = ?2 AND t.event_id = ?3`,
  )
    .bind(payload.tid, portalId, claims.eid)
    .first<TicketJoinRow>();

  // Unknown ticket, or signed payload references a different registration than
  // the stored ticket — treat as not found rather than leaking which check failed.
  if (!row || row.registration_id !== payload.rid) {
    return { code, status: 'not_found', ok: false };
  }

  if (row.ticket_status === 'cancelled' || row.ticket_status === 'voided') {
    return { code, status: 'cancelled', ok: false, attendeeName: row.attendee_name };
  }

  // Idempotent: an already-checked-in ticket returns its ORIGINAL arrival time.
  if (row.ticket_status === 'checked_in') {
    return {
      code,
      status: 'already_checked_in',
      ok: true,
      checkedInAt: row.checked_in_at ?? undefined,
      attendeeName: row.attendee_name,
    };
  }

  const now = new Date().toISOString();
  const outboxId = crypto.randomUUID();
  const attendanceOutboxId = crypto.randomUUID();

  // State change + outbox rows in one batch (CLAUDE.md invariant). The guarded
  // UPDATE (status = 'issued') makes a concurrent double-scan a no-op on the
  // loser; me.attend is idempotent via the stable interactionDateTime regardless.
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE tickets SET status = 'checked_in', checked_in_at = ?1
       WHERE id = ?2 AND status = 'issued'`,
    ).bind(recordedAt, payload.tid),
    env.DB.prepare(
      `UPDATE registrations SET marketing_event_state_synced = 0, updated_at = ?1 WHERE id = ?2`,
    ).bind(now, payload.rid),
    env.DB.prepare(
      `INSERT INTO outbox (id, portal_id, topic, payload, stable_interaction_datetime, created_at)
       VALUES (?1, ?2, 'me.attend', ?3, ?4, ?5)`,
    ).bind(
      outboxId,
      portalId,
      JSON.stringify({
        registrationId: payload.rid,
        attendeeEmail: row.attendee_email,
        hubspotContactId: row.hubspot_contact_id,
        hubspotEventId: row.hubspot_event_id,
        // portalId doubles as externalAccountId for Weld's single-portal setup
        externalAccountId: portalId,
      }),
      recordedAt,
      now,
    ),
    // Phase 2.1: the same arrival, projected onto the attendee's contact as an attended
    // flag + date. That property is what Ollie's Data Hub flow renders a certificate from,
    // so the worker builds no certificate of its own. `recordedAt` is the stable arrival
    // time the me.attend row already uses, which keeps a replay writing the same value.
    attendanceSyncStatement(
      env,
      portalId,
      attendanceOutboxId,
      {
        registrationId: payload.rid,
        eventId: claims.eid,
        attendeeEmail: row.attendee_email,
        attendeeName: row.attendee_name,
        hubspotContactId: row.hubspot_contact_id,
        attendedAt: recordedAt,
        eventTitle: row.event_title,
      },
      now,
    ),
  ]);

  // Best-effort signals; the outbox reconciliation cron is the backstop.
  try {
    await env.QUEUE.sendBatch([
      {
        body: {
          kind: 'me.attend',
          portalId,
          outboxId,
          registrationId: payload.rid,
        },
      },
      { body: attendanceSyncSignal(portalId, attendanceOutboxId, payload.rid) },
    ]);
  } catch {
    // swallow — cron will pick up the pending outbox rows
  }

  return {
    code,
    status: 'checked_in',
    ok: true,
    checkedInAt: recordedAt,
    attendeeName: row.attendee_name,
  };
}

/** Normalise a caller-supplied scan time to an ISO string, else fall back to now. */
function normaliseRecordedAt(value: unknown): string {
  if (typeof value === 'string') {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return new Date().toISOString();
}

const HTTP_FOR_STATUS: Record<ScanOutcome, 200 | 404 | 409 | 422> = {
  checked_in: 200,
  already_checked_in: 200,
  cancelled: 409,
  invalid_signature: 422,
  wrong_event: 422,
  not_found: 404,
};

// ---------------------------------------------------------------------------
// POST /api/v1/checkin
// ---------------------------------------------------------------------------

async function handleCheckin(c: Context<CheckinBindings>): Promise<Response> {
  const claims = c.get('device');

  let body: { code?: string; scannedAt?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }
  if (!body.code) {
    return c.json({ status: 'missing_code', message: 'code is required' }, 400);
  }

  const eventKey = await getEventVerifyKey(c.env, claims.portalId, claims.eid);
  const recordedAt = normaliseRecordedAt(body.scannedAt);
  const result = await processScan(c.env, claims, eventKey, body.code, recordedAt);

  return c.json(result, HTTP_FOR_STATUS[result.status]);
}

// ---------------------------------------------------------------------------
// POST /api/v1/checkin/batch  — flush an offline scan queue
// ---------------------------------------------------------------------------

async function handleBatch(c: Context<CheckinBindings>): Promise<Response> {
  const claims = c.get('device');

  let body: { scans?: Array<{ code?: string; scannedAt?: string }> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }
  if (!Array.isArray(body.scans)) {
    return c.json({ status: 'invalid_body', message: 'scans[] is required' }, 400);
  }

  // Derive the event key once for the whole batch.
  const eventKey = await getEventVerifyKey(c.env, claims.portalId, claims.eid);

  const results: ScanResult[] = [];
  // Sequential: each scan's own scannedAt is the recorded time, and a duplicate
  // code within the batch must observe the first scan's committed state.
  for (const scan of body.scans) {
    if (!scan || typeof scan.code !== 'string') {
      results.push({ code: String(scan?.code ?? ''), status: 'invalid_signature', ok: false });
      continue;
    }
    const recordedAt = normaliseRecordedAt(scan.scannedAt);
    results.push(await processScan(c.env, claims, eventKey, scan.code, recordedAt));
  }

  const accepted = results.filter((r) => r.ok).length;
  return c.json({ status: 'processed', total: results.length, accepted, results });
}

// ---------------------------------------------------------------------------
// GET /api/v1/checkin/manifest/:eventId
// ---------------------------------------------------------------------------

interface ManifestTicketRow {
  id: string;
  registration_id: string;
  event_id: string;
  status: string;
  checked_in_at: string | null;
  attendee_name: string;
  qr_code: string | null;
}

async function handleManifest(c: Context<CheckinBindings>): Promise<Response> {
  const claims = c.get('device');
  const eventId = c.req.param('eventId');
  if (eventId !== claims.eid) {
    return c.json({ status: 'forbidden', message: 'Device token not scoped to this event' }, 403);
  }

  const eventKey = await getEventVerifyKey(c.env, claims.portalId, eventId);
  const verifyKey = await exportKeyB64url(eventKey);

  const rows = await c.env.DB.prepare(
    `SELECT t.id, t.registration_id, t.event_id, t.status, t.checked_in_at,
            t.qr_code, r.attendee_name
     FROM tickets t
     JOIN registrations r ON r.id = t.registration_id
     WHERE t.portal_id = ?1 AND t.event_id = ?2
       AND t.status IN ('issued', 'checked_in')
     ORDER BY r.attendee_name ASC`,
  )
    .bind(claims.portalId, eventId)
    .all<ManifestTicketRow>();

  // Answers for the door (Ref 74d). Reuses the reader the CSV export uses rather than a
  // second join, so the two cannot disagree about which questions are in scope — notably
  // archived ones, whose answers stay readable by design.
  //
  // Attendee-scoped only: an order-scoped answer is not something the door acts on, and it
  // would repeat on every seat of a company block. Both this read and the ticket query
  // above are bound to the device token's portal id, so nothing crosses a tenant.
  const answersByRegistration = new Map<string, ManifestAnswer[]>();
  for (const answer of await listEventAnswers(c.env, claims.portalId, eventId)) {
    if (answer.scope !== 'attendee') continue;
    if (!answer.registration_id) continue;
    const value = answer.value_text ?? '';
    // An unanswered optional question still has no business taking up a line at the door.
    if (value.trim() === '') continue;
    const list = answersByRegistration.get(answer.registration_id) ?? [];
    list.push({ key: answer.key, label: answer.label, value });
    answersByRegistration.set(answer.registration_id, list);
  }

  const tickets = await Promise.all(
    rows.results.map(async (row) => ({
      code:
        row.qr_code ??
        (await mintTicketCode(
          { tid: row.id, rid: row.registration_id, eid: row.event_id },
          eventKey,
        )),
      name: row.attendee_name,
      status: row.status,
      checkedInAt: row.checked_in_at,
      answers: answersByRegistration.get(row.registration_id) ?? [],
    })),
  );

  return c.json({
    eventId,
    algorithm: 'HMAC-SHA256',
    // The DERIVED per-event verify key — not the tenant master. Lets the scanner
    // verify codes offline without ever holding the master secret.
    verifyKey,
    generatedAt: new Date().toISOString(),
    count: tickets.length,
    tickets,
  });
}

// ---------------------------------------------------------------------------
// GET /api/v1/checkin/stats/:eventId  — live registered vs attended
// ---------------------------------------------------------------------------

async function handleStats(c: Context<CheckinBindings>): Promise<Response> {
  const claims = c.get('device');
  const eventId = c.req.param('eventId');
  if (eventId !== claims.eid) {
    return c.json({ status: 'forbidden', message: 'Device token not scoped to this event' }, 403);
  }

  // The shared count (Phase 2.2). The door used to read `attended` from checked-in tickets
  // alone, which is right for a scanner at a door and wrong for a hybrid event: anyone who
  // joined online counted as still to arrive, and staff went looking for people who were
  // already in the session.
  const summary = await summariseEventRegistrations(c.env, claims.portalId, eventId);

  return c.json({
    eventId,
    registered: summary.registered,
    attended: summary.attended,
    notYetArrived: summary.notYetArrived,
    summary,
  });
}

// ---------------------------------------------------------------------------
// POST /api/v1/checkin/device-token  — ADMIN auth (NOT device auth)
// ---------------------------------------------------------------------------

async function handleIssueDeviceToken(c: Context<{ Bindings: Env }>): Promise<Response> {
  const portalId = authenticateAdmin(c);
  if (!portalId) {
    return c.json({ status: 'unauthorized', message: 'Admin credentials required' }, 401);
  }

  let body: { eventId?: string; deviceId?: string; ttlSeconds?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }
  if (!body.eventId) {
    return c.json({ status: 'missing_event_id', message: 'eventId is required' }, 400);
  }

  // Confirm the event exists and belongs to this tenant before issuing a token.
  const event = await loadEvent(c.env.DB, portalId, body.eventId);
  if (!event) {
    return c.json({ status: 'event_not_found', message: 'Event not found' }, 404);
  }

  const deviceId = body.deviceId ?? crypto.randomUUID();
  const issued = await issueDeviceToken(c.env, portalId, event.id, deviceId, body.ttlSeconds);

  return c.json({
    token: issued.token,
    eventId: event.id,
    deviceId: issued.deviceId,
    expiresAt: issued.expiresAt,
  });
}

// ---------------------------------------------------------------------------
// Sub-app — mounted at /api/v1/checkin in index.ts
// ---------------------------------------------------------------------------

const checkin = new Hono<CheckinBindings>();

checkin.post('/', deviceAuth, handleCheckin);
checkin.post('/batch', deviceAuth, handleBatch);
checkin.get('/manifest/:eventId', deviceAuth, handleManifest);
checkin.get('/stats/:eventId', deviceAuth, handleStats);
checkin.post('/device-token', handleIssueDeviceToken);

export const checkinRoutes = checkin;
