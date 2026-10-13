/**
 * Staff notes on a registration or an order (Phase 1.3).
 *
 * Internal text staff type about a booking — who rang, what was agreed, why a seat was
 * comped. Two rules shape everything here:
 *
 *   1. **Append-only.** No UPDATE, no DELETE, no `updated_at`. An edit writes a new row
 *      and the previous one stands, because the value of a note is the sequence: what
 *      staff believed on Tuesday, and what changed by Friday.
 *   2. **Never attendee-facing.** A note reaches the manage surfaces and the HubSpot CRM
 *      timeline, and nothing else. No ticket, invoice, confirmation email or buyer-facing
 *      order poll reads this table — which is a property of the code, and `notes.test.ts`
 *      holds it there.
 *
 * D1 is the record. The HubSpot Note engagement written by the `note.create` outbox topic
 * is a projection of it, using HubSpot's own note object rather than a custom property so
 * it lands on the timeline staff already read.
 */

import type { Env } from './types';

/** Author recorded when no HubSpot user is attributable (the worker wrote the note). */
export const SYSTEM_AUTHOR = 'system';

/**
 * Long enough for a real account of a phone call, short enough that the column can't be
 * used as a document store. The manual-booking form's own `staffNote` caps at 500.
 */
export const MAX_NOTE_BODY = 5000;

const MAX_AUTHOR = 80;

export interface StaffNoteRow {
  id: string;
  portal_id: string;
  registration_id: string | null;
  order_id: string | null;
  author: string;
  body: string;
  hubspot_note_id: string | null;
  created_at: string;
}

export interface StaffNoteTarget {
  registrationId?: string | null;
  orderId?: string | null;
}

export interface StaffNoteInput extends StaffNoteTarget {
  portalId: string;
  /** HubSpot user id of whoever typed it; anything falsy is recorded as 'system'. */
  author?: string | null;
  body: string;
}

/** A validated, id-stamped note, ready to be written. */
export interface PreparedStaffNote {
  id: string;
  portalId: string;
  registrationId: string | null;
  orderId: string | null;
  author: string;
  body: string;
  createdAt: string;
  outboxId: string;
}

export type PrepareNoteResult =
  | { ok: true; note: PreparedStaffNote }
  | { ok: false; status: string; message: string };

function clean(value: unknown, max: number): string {
  return String(value ?? '')
    .trim()
    .slice(0, max);
}

/**
 * Validate and stamp a note without writing it.
 *
 * Separate from the write so a caller already inside a D1 batch — reserve, carrying the
 * staff note typed on a manual booking — can put the note in that batch rather than
 * issuing a second, non-atomic write.
 *
 * The body keeps its internal newlines (staff paste call notes into it); only the ends are
 * trimmed. An empty body is rejected rather than stored, because an append-only table has
 * no way to take one back.
 */
export function prepareStaffNote(input: StaffNoteInput): PrepareNoteResult {
  const registrationId = clean(input.registrationId, 80) || null;
  const orderId = clean(input.orderId, 80) || null;
  if (!registrationId && !orderId) {
    return {
      ok: false,
      status: 'missing_target',
      message: 'A note must name a registration or an order',
    };
  }

  const body = String(input.body ?? '').trim();
  if (!body) {
    return { ok: false, status: 'missing_body', message: 'Note body is required' };
  }

  return {
    ok: true,
    note: {
      id: crypto.randomUUID(),
      portalId: input.portalId,
      registrationId,
      orderId,
      author: clean(input.author, MAX_AUTHOR) || SYSTEM_AUTHOR,
      body: body.slice(0, MAX_NOTE_BODY),
      createdAt: new Date().toISOString(),
      outboxId: crypto.randomUUID(),
    },
  };
}

/**
 * The note row and its outbox row, as statements for the caller's batch.
 *
 * Both together or neither (CLAUDE.md: every HubSpot side effect goes through the outbox
 * in the same D1 transaction as the state change).
 */
export function staffNoteStatements(env: Env, note: PreparedStaffNote): D1PreparedStatement[] {
  return [
    env.DB.prepare(
      `INSERT INTO registration_notes
         (id, portal_id, registration_id, order_id, author, body, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(
      note.id,
      note.portalId,
      note.registrationId,
      note.orderId,
      note.author,
      note.body,
      note.createdAt,
    ),
    env.DB.prepare(
      `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
       VALUES (?1, ?2, 'note.create', ?3, ?4)`,
    ).bind(
      note.outboxId,
      note.portalId,
      // The id only: the handler re-reads the row at delivery, so a replay mirrors what
      // the note actually says rather than a stale copy carried in the payload.
      JSON.stringify({ noteId: note.id }),
      note.createdAt,
    ),
  ];
}

/** Best-effort drain of a note's outbox row; the cron sweep is the backstop. */
export async function enqueueStaffNote(env: Env, note: PreparedStaffNote): Promise<void> {
  try {
    await env.QUEUE.send({
      kind: 'note.create',
      portalId: note.portalId,
      outboxId: note.outboxId,
      noteId: note.id,
    });
  } catch {
    // swallow — reconcileOutbox picks it up
  }
}

/** Write a note (row + outbox) and signal the queue. */
export async function addStaffNote(
  env: Env,
  input: StaffNoteInput,
): Promise<PrepareNoteResult & { ok: boolean }> {
  const prepared = prepareStaffNote(input);
  if (!prepared.ok) return prepared;

  await env.DB.batch(staffNoteStatements(env, prepared.note));
  await enqueueStaffNote(env, prepared.note);
  return prepared;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Every note against one registration or one order, oldest first — the thread, in the
 * order it was written, which is the only order an append-only log reads correctly in.
 *
 * The tiebreak is `rowid`, NOT `id`. `created_at` has millisecond resolution and the
 * Workers clock is frozen between I/O, so two notes typed in the same breath — a
 * correction right after the note it corrects — routinely carry the SAME timestamp. `id`
 * is a random UUID, so tiebreaking on it returned the thread in random order and lost the
 * one thing an append-only log exists to preserve. SQLite's implicit rowid is assigned in
 * insertion order, which is exactly the sequence being asked for.
 */
export async function listStaffNotes(
  env: Env,
  portalId: string,
  target: StaffNoteTarget,
): Promise<StaffNoteRow[]> {
  const registrationId = target.registrationId ?? null;
  const orderId = target.orderId ?? null;
  if (!registrationId && !orderId) return [];

  const rows = await env.DB.prepare(
    `SELECT * FROM registration_notes
      WHERE portal_id = ?1
        AND ((?2 IS NOT NULL AND registration_id = ?2)
          OR (?3 IS NOT NULL AND order_id = ?3))
      ORDER BY created_at ASC, rowid ASC`,
  )
    .bind(portalId, registrationId, orderId)
    .all<StaffNoteRow>();
  return rows.results;
}

/**
 * Every note for one event, whether it hangs off a registration or the order behind it.
 *
 * One query so the manage card can mark up a whole attendee list without a fetch per row,
 * and so the 2.2 export has a single source to join against.
 *
 * Ordered by `rowid` within a timestamp for the same reason as `listStaffNotes` above.
 */
export async function listEventStaffNotes(
  env: Env,
  portalId: string,
  eventId: string,
): Promise<StaffNoteRow[]> {
  const rows = await env.DB.prepare(
    `SELECT n.* FROM registration_notes n
      WHERE n.portal_id = ?1
        AND (
          n.registration_id IN (
            SELECT id FROM registrations WHERE portal_id = ?1 AND event_id = ?2
          )
          OR n.order_id IN (
            SELECT id FROM orders WHERE portal_id = ?1 AND event_id = ?2
          )
        )
      ORDER BY n.created_at ASC, n.rowid ASC`,
  )
    .bind(portalId, eventId)
    .all<StaffNoteRow>();
  return rows.results;
}

export async function loadStaffNote(
  env: Env,
  portalId: string,
  noteId: string,
): Promise<StaffNoteRow | null> {
  return env.DB.prepare('SELECT * FROM registration_notes WHERE portal_id = ?1 AND id = ?2')
    .bind(portalId, noteId)
    .first<StaffNoteRow>();
}

// ---------------------------------------------------------------------------
// Tenant config
// ---------------------------------------------------------------------------

/** Stored value that stops notes being mirrored to HubSpot at all. */
export const NOTE_SYNC_OFF = 'off';

/**
 * Whether this tenant's notes are mirrored onto the HubSpot record.
 *
 * Defaults to ON: a staff note belongs on the CRM timeline next to the calls and emails
 * about the same booking, and HubSpot's own note object is where that lives. A tenant that
 * wants its notes kept inside the worker sets `note_sync_mode = 'off'`.
 *
 * Reading optional config must never fail the caller (Ref 217): against a tenants table
 * that predates 0022 this query throws "no such column", which degrades to the default.
 */
export async function isNoteSyncEnabled(env: Env, portalId: string): Promise<boolean> {
  try {
    const row = await env.DB.prepare('SELECT note_sync_mode FROM tenants WHERE portal_id = ?1')
      .bind(portalId)
      .first<{ note_sync_mode: string | null }>();
    return (row?.note_sync_mode ?? '').trim().toLowerCase() !== NOTE_SYNC_OFF;
  } catch {
    return true;
  }
}
