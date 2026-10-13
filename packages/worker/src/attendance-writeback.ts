/**
 * Attendance write-back (Phase 2.1) — the read model, and where attendance lands in HubSpot.
 *
 * The worker deliberately does NOT render, store or deliver certificates. Ollie's Data Hub
 * flow already produces membership certificates from a contact property; events feed that
 * same mechanism so a member never receives two differently-shaped certificates. All this
 * module has to do is put attendance somewhere that flow can read.
 *
 * Two halves, mirroring `attendee-contact.ts` (Phase 1.2):
 *
 *   loadAttendanceContactConfig — which HubSpot CONTACT property the attended flag, the
 *                                 attendance date and the event name map to. Unlike
 *                                 phone/city/state there is no HubSpot standard property
 *                                 for "attended an event", so the default is a named custom
 *                                 property (event_attended / event_last_attended_date /
 *                                 event_last_attended_name) the portal creates once.
 *   listEventAttendance         — per-registration attendance state, derived from the
 *                                 tickets (check-in) and, for online events, the me.attend
 *                                 record. Nothing is stored twice: attendance is a fact
 *                                 about a ticket or a webinar record, not its own column.
 *
 * The contact properties hold the LATEST attendance, not a history — one contact attends
 * many events and a property holds one value. The per-event detail lives in D1 and is read
 * through GET /api/v1/manage/events/:id/attendance.
 */

import { resolveTimeZone } from './timezone';
import type { Env } from './types';

// ---------------------------------------------------------------------------
// Tenant property mapping
// ---------------------------------------------------------------------------

export type AttendanceField = 'attended' | 'attendedDate' | 'eventName';

export const ATTENDANCE_FIELDS: AttendanceField[] = ['attended', 'attendedDate', 'eventName'];

/**
 * What a portal that has expressed no preference gets. `event_attended` is the flag the
 * Data Hub flow keys off; the date is what the certificate prints; the event name is what
 * stops the certificate having to say "an event".
 */
export const DEFAULT_ATTENDANCE_PROPERTIES: Record<AttendanceField, string> = {
  attended: 'event_attended',
  attendedDate: 'event_last_attended_date',
  eventName: 'event_last_attended_name',
};

/** Stored value that turns a field off; NULL means "use the default property". */
export const ATTENDANCE_PROPERTY_OFF = 'off';

/**
 * What each property IS, so the worker can create it in the portal rather than asking a
 * human to key three definitions in by hand and get the types right.
 *
 * The date is deliberately a HubSpot `date`, not a `datetime`: a certificate prints a day,
 * and a `date` is the type that survives being read by a Data Hub flow, a list filter and
 * an export without a timezone argument attached to it. The flag is HubSpot's own
 * Yes/No checkbox shape (`enumeration` + `booleancheckbox`), which is what a workflow
 * enrolment trigger expects to branch on.
 */
export interface AttendancePropertyDefinition {
  label: string;
  description: string;
  type: 'string' | 'date' | 'enumeration';
  fieldType: 'text' | 'date' | 'booleancheckbox';
  options?: Array<{ label: string; value: string; displayOrder: number }>;
}

export const ATTENDANCE_PROPERTY_DEFINITIONS: Record<
  AttendanceField,
  AttendancePropertyDefinition
> = {
  attended: {
    label: 'Attended an event',
    description:
      'Set when this contact checks in to an event or joins an online session. Sticky: it ' +
      'records that they have ever attended, not whether they attended the most recent one.',
    type: 'enumeration',
    // Lowercase: HubSpot's fieldType enum is 'booleancheckbox'. The camelCase spelling is
    // rejected with a 400 that reads as a generic validation failure.
    fieldType: 'booleancheckbox',
    options: [
      { label: 'Yes', value: 'true', displayOrder: 0 },
      { label: 'No', value: 'false', displayOrder: 1 },
    ],
  },
  attendedDate: {
    label: 'Last attended date',
    description:
      'The day this contact most recently attended an event, in the portal display ' +
      'timezone. Never moves backwards: a late-arriving record for an earlier event ' +
      'cannot overwrite a more recent one.',
    type: 'date',
    fieldType: 'date',
  },
  eventName: {
    label: 'Last attended event',
    description:
      'The event this contact most recently attended. Always moves together with the last ' +
      'attended date, so the pair can never describe two different events.',
    type: 'string',
    fieldType: 'text',
  },
};

/** The HubSpot property group the three are created in. */
export const ATTENDANCE_PROPERTY_GROUP = {
  name: 'event_attendance',
  label: 'Event Attendance',
};

export interface AttendanceContactConfig {
  attendedProperty: string | null;
  attendedDateProperty: string | null;
  eventNameProperty: string | null;
  /**
   * The timezone the attendance DATE is expressed in. An instant is not a date until you
   * say where: Adelaide is UTC+9:30, so a morning course's check-ins fall on the previous
   * UTC day, and a certificate built from that prints the wrong one.
   */
  displayTimeZone: string;
}

type AttendanceConfigRow = {
  contact_attended_property: string | null;
  contact_attended_date_property: string | null;
  contact_attended_event_property: string | null;
  display_timezone: string | null;
};

function emptyToNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function resolveProperty(configured: unknown, field: AttendanceField): string | null {
  const value = emptyToNull(configured);
  if (value === null) return DEFAULT_ATTENDANCE_PROPERTIES[field];
  if (value.toLowerCase() === ATTENDANCE_PROPERTY_OFF) return null;
  return value;
}

/**
 * Resolve the tenant's attendance property mapping.
 *
 * Reading optional config must never fail the caller (Ref 217): against a tenants table
 * that predates 0023 this query throws "no such column", which degrades to the defaults —
 * the correct target for a portal that has expressed no preference, and an un-migrated
 * tenant has expressed none.
 */
export async function loadAttendanceContactConfig(
  env: Env,
  portalId: string,
): Promise<AttendanceContactConfig> {
  let row: Partial<AttendanceConfigRow> | null = null;
  try {
    row = await env.DB.prepare(
      `SELECT contact_attended_property, contact_attended_date_property,
              contact_attended_event_property, display_timezone
         FROM tenants WHERE portal_id = ?1`,
    )
      .bind(portalId)
      .first<AttendanceConfigRow>();
  } catch {
    // `display_timezone` arrived in migration 0025, and D1 fails the WHOLE statement on an
    // unknown column. Between deploying this code and applying that migration, retrying
    // without it is what keeps a portal's CONFIGURED property names working — falling all
    // the way back to the defaults would silently write attendance to the wrong property,
    // and the only trace would be a warn line.
    try {
      row = await env.DB.prepare(
        `SELECT contact_attended_property, contact_attended_date_property,
                contact_attended_event_property
           FROM tenants WHERE portal_id = ?1`,
      )
        .bind(portalId)
        .first<Omit<AttendanceConfigRow, 'display_timezone'>>();
    } catch (err) {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'attendance_contact_config_unreadable',
          portalId,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  return {
    attendedProperty: resolveProperty(row?.contact_attended_property, 'attended'),
    attendedDateProperty: resolveProperty(row?.contact_attended_date_property, 'attendedDate'),
    eventNameProperty: resolveProperty(row?.contact_attended_event_property, 'eventName'),
    displayTimeZone: resolveTimeZone(row?.display_timezone),
  };
}

export function attendancePropertyFor(
  config: AttendanceContactConfig,
  field: AttendanceField,
): string | null {
  if (field === 'attended') return config.attendedProperty;
  if (field === 'attendedDate') return config.attendedDateProperty;
  return config.eventNameProperty;
}

export function hasAnyAttendanceMapping(config: AttendanceContactConfig): boolean {
  return ATTENDANCE_FIELDS.some((field) => attendancePropertyFor(config, field) !== null);
}

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

/** How a registration came to be marked attended. */
export type AttendanceSource = 'checkin' | 'marketing_event';

export type AttendanceStatus = 'attended' | 'registered' | 'cancelled';

/**
 * The columns "did this seat attend, and when" is decided from, as a SQL fragment.
 *
 * Exported because the Phase 2.2 reporting surfaces answer the same question over a
 * different shape of query — one event's paginated list, a CSV of the whole event, a
 * roll-up across a date range. Reimplementing the derivation there would let the report
 * and this endpoint drift, which is the exact argument 2.2 exists to end: a report that
 * disagrees with the engine is worse than no report.
 *
 * Assumes the caller's FROM aliases `registrations` as `r` and `orders` as `o`.
 */
export const ATTENDANCE_DERIVATION_COLUMNS = `
         o.status                        AS order_status,
         r.cancelled_at                  AS registration_cancelled_at,
         r.marketing_event_state_synced  AS marketing_event_state_synced,
         (SELECT t.status FROM tickets t
           WHERE t.portal_id = r.portal_id AND t.id = r.ticket_id)          AS ticket_status,
         (SELECT COUNT(*) FROM tickets t
           WHERE t.portal_id = r.portal_id AND t.registration_id = r.id
             AND t.status = 'checked_in')                                   AS checked_in_count,
         (SELECT MIN(t.checked_in_at) FROM tickets t
           WHERE t.portal_id = r.portal_id AND t.registration_id = r.id
             AND t.checked_in_at IS NOT NULL)                               AS first_checked_in_at,
         (SELECT ob.stable_interaction_datetime FROM outbox ob
           WHERE ob.portal_id = r.portal_id AND ob.topic = 'me.attend'
             AND ob.status != 'dead'
             AND json_extract(IIF(json_valid(ob.payload), ob.payload, '{}'), '$.registrationId') = r.id
           ORDER BY ob.created_at ASC LIMIT 1)                              AS me_attend_at`;

/** What `ATTENDANCE_DERIVATION_COLUMNS` selects — the input to `deriveAttendance`. */
export interface AttendanceDerivationRow {
  order_status: string;
  /** Set when THIS seat was cancelled on its own, its booking left standing (Phase 3.2). */
  registration_cancelled_at: string | null;
  ticket_status: string | null;
  checked_in_count: number | null;
  first_checked_in_at: string | null;
  marketing_event_state_synced: number | null;
  me_attend_at: string | null;
}

export interface AttendanceVerdict {
  attended: boolean;
  /** When they arrived (check-in) or joined (webinar). Null when they did not attend. */
  attendedAt: string | null;
  source: AttendanceSource | null;
  /**
   * The DISPLAY status, in which attending beats being cancelled — someone who walked in
   * the door and was refunded afterwards reads as `attended`, because they were there.
   */
  status: AttendanceStatus;
  /**
   * Whether the SEAT was cancelled, before that override. A separate question from
   * `status`: the seat can be cancelled and its occupant still have attended, and a report
   * that counts booking states has to be able to say so.
   */
  seatCancelled: boolean;
}

/**
 * Decide whether a registration attended, when, and how.
 *
 * A scan is the stronger signal and is checked first: a check-in also enqueues me.attend,
 * so reading the outbox first would relabel every door arrival as a webinar join.
 *
 * Attending is a fact. A later refund does not un-attend someone who walked in the door,
 * so `attended` wins over `cancelled` when both are true — a certificate for a course they
 * sat is still owed.
 */
export function deriveAttendance(row: AttendanceDerivationRow): AttendanceVerdict {
  let source: AttendanceSource | null = null;
  let attendedAt: string | null = null;
  if ((row.checked_in_count ?? 0) > 0) {
    source = 'checkin';
    attendedAt = row.first_checked_in_at;
  } else if (row.marketing_event_state_synced === 2 || row.me_attend_at !== null) {
    source = 'marketing_event';
    attendedAt = row.me_attend_at;
  }

  const attended = source !== null;
  // Three ways a seat stops being a seat, and none of them subsumes the others:
  //   - the registration was cancelled on its own (Phase 3.2) while its booking stands,
  //     which is the ONLY signal for one attendee dropping out of a group booking — the
  //     order is still 'paid' on behalf of the colleagues who are still coming;
  //   - a partial refund leaves the order 'partially_refunded' but still cancels the
  //     tickets, which is why the ticket status is read as well as the order's;
  //   - the whole order was refunded or cancelled.
  const cancelled =
    row.registration_cancelled_at !== null ||
    row.ticket_status === 'cancelled' ||
    row.order_status === 'cancelled' ||
    row.order_status === 'refunded';

  return {
    attended,
    attendedAt,
    source,
    status: attended ? 'attended' : cancelled ? 'cancelled' : 'registered',
    seatCancelled: cancelled,
  };
}

export interface RegistrationAttendance {
  registrationId: string;
  orderId: string;
  ticketTypeId: string;
  attendeeName: string;
  attendeeEmail: string;
  hubspotContactId: string | null;
  ticketId: string | null;
  ticketStatus: string | null;
  orderStatus: string;
  status: AttendanceStatus;
  attended: boolean;
  /** When they arrived (check-in) or joined (webinar). Null when they did not attend. */
  attendedAt: string | null;
  source: AttendanceSource | null;
  /** State of this registration's contact.sync_attendance outbox row, if any. */
  writeback: { status: string; attempts: number } | null;
}

interface AttendanceQueryRow extends AttendanceDerivationRow {
  registration_id: string;
  order_id: string;
  ticket_type_id: string;
  attendee_name: string;
  attendee_email: string;
  hubspot_contact_id: string | null;
  ticket_id: string | null;
  writeback_status: string | null;
  writeback_attempts: number | null;
}

/**
 * Attendance for one event, one row per registration.
 *
 * The ticket columns are sub-selects rather than a join because a registration can carry
 * more than one ticket row — a transfer voids the old code and issues a new one — and a
 * join would then report that attendee twice. `registrations.ticket_id` names the live
 * ticket; the count answers "did this seat ever check in".
 *
 * `me.attend` is the online-event equivalent of a scan: a Teams/Zoom attendance record is
 * matched to a registration and enqueued with the earliest join time as its stable
 * interaction time, which is exactly the arrival time a certificate wants. Reading it here
 * is what makes this endpoint answer for online events too, not just the door.
 */
const ATTENDANCE_SELECT = `
  SELECT r.id                            AS registration_id,
         r.order_id                      AS order_id,
         r.ticket_type_id                AS ticket_type_id,
         r.attendee_name                 AS attendee_name,
         r.attendee_email                AS attendee_email,
         r.hubspot_contact_id            AS hubspot_contact_id,
         r.ticket_id                     AS ticket_id,
${ATTENDANCE_DERIVATION_COLUMNS},
         (SELECT ob.status FROM outbox ob
           WHERE ob.portal_id = r.portal_id AND ob.topic = 'contact.sync_attendance'
             AND json_extract(IIF(json_valid(ob.payload), ob.payload, '{}'), '$.registrationId') = r.id
           ORDER BY ob.created_at DESC LIMIT 1)                             AS writeback_status,
         (SELECT ob.attempts FROM outbox ob
           WHERE ob.portal_id = r.portal_id AND ob.topic = 'contact.sync_attendance'
             AND json_extract(IIF(json_valid(ob.payload), ob.payload, '{}'), '$.registrationId') = r.id
           ORDER BY ob.created_at DESC LIMIT 1)                             AS writeback_attempts
    FROM registrations r
    JOIN orders o ON o.id = r.order_id
`;

function toAttendance(row: AttendanceQueryRow): RegistrationAttendance {
  const verdict = deriveAttendance(row);

  return {
    registrationId: row.registration_id,
    orderId: row.order_id,
    ticketTypeId: row.ticket_type_id,
    attendeeName: row.attendee_name,
    attendeeEmail: row.attendee_email,
    hubspotContactId: row.hubspot_contact_id,
    ticketId: row.ticket_id,
    ticketStatus: row.ticket_status,
    orderStatus: row.order_status,
    status: verdict.status,
    attended: verdict.attended,
    attendedAt: verdict.attendedAt,
    source: verdict.source,
    writeback: row.writeback_status
      ? { status: row.writeback_status, attempts: row.writeback_attempts ?? 0 }
      : null,
  };
}

export async function listEventAttendance(
  env: Env,
  portalId: string,
  eventId: string,
): Promise<RegistrationAttendance[]> {
  const rows = await env.DB.prepare(
    `${ATTENDANCE_SELECT}
      WHERE r.portal_id = ?1 AND r.event_id = ?2
      ORDER BY r.attendee_name ASC, r.id ASC`,
  )
    .bind(portalId, eventId)
    .all<AttendanceQueryRow>();
  return rows.results.map(toAttendance);
}

export async function loadRegistrationAttendance(
  env: Env,
  portalId: string,
  registrationId: string,
): Promise<RegistrationAttendance | null> {
  const row = await env.DB.prepare(`${ATTENDANCE_SELECT} WHERE r.portal_id = ?1 AND r.id = ?2`)
    .bind(portalId, registrationId)
    .first<AttendanceQueryRow>();
  return row ? toAttendance(row) : null;
}

export interface AttendanceSummary {
  registered: number;
  attended: number;
  notYetArrived: number;
  cancelled: number;
}

export function summariseAttendance(rows: RegistrationAttendance[]): AttendanceSummary {
  const attended = rows.filter((row) => row.attended).length;
  const cancelled = rows.filter((row) => row.status === 'cancelled').length;
  // "Registered" is the denominator a door count is read against: seats still expected,
  // which excludes refunded/cancelled ones but includes everyone who has already arrived.
  const registered = rows.length - cancelled;
  return {
    registered,
    attended,
    notYetArrived: Math.max(0, registered - attended),
    cancelled,
  };
}

// ---------------------------------------------------------------------------
// Write-back payload
// ---------------------------------------------------------------------------

export interface AttendanceSyncPayload {
  registrationId: string;
  eventId: string;
  attendeeEmail: string;
  attendeeName?: string | null;
  hubspotContactId?: string | null;
  /** ISO arrival time. Stable across retries — the recorded scan/join, never Date.now(). */
  attendedAt: string;
  /** Event title at the time of attendance, for the "which course" property. */
  eventTitle?: string | null;
}

/**
 * The outbox row for an attendance write-back, as a statement for the caller's batch.
 *
 * A statement rather than a write so check-in can put it in the SAME D1 batch as the ticket
 * state change (CLAUDE.md: every HubSpot side effect goes through the outbox in the same
 * transaction as the state change).
 */
export function attendanceSyncStatement(
  env: Env,
  portalId: string,
  outboxId: string,
  payload: AttendanceSyncPayload,
  now: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO outbox (id, portal_id, topic, payload, stable_interaction_datetime, created_at)
     VALUES (?1, ?2, 'contact.sync_attendance', ?3, ?4, ?5)`,
  ).bind(outboxId, portalId, JSON.stringify(payload), payload.attendedAt, now);
}

/** The queue signal for a row written by `attendanceSyncStatement`. */
export function attendanceSyncSignal(
  portalId: string,
  outboxId: string,
  registrationId: string,
): Record<string, unknown> {
  return { kind: 'contact.sync_attendance', portalId, outboxId, registrationId };
}
