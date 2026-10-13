/**
 * Amend one registration in place (Phase 3.2).
 *
 * The correction path, as distinct from the two reassignment paths either side of it:
 *
 *   transfer (18.2) — a DIFFERENT PERSON takes the seat. Gated on the refund policy's
 *     `allow_transfer`, audited in `transfers`, because it is the buyer exercising a right
 *     the event grants them.
 *   amend (here)    — the same booking, recorded wrongly. `jhon@` for `john@`, a married
 *     name, a phone number typed into the wrong seat's row, a dietary answer given by a
 *     colleague who guessed. Nobody is exercising a right; staff are fixing the record, so
 *     there is no policy to consult and nothing to audit as a reassignment.
 *   cancel (3.2)    — the seat goes away. See `cancel.ts`.
 *
 * The seat never moves, so the EventCapacity DO is not involved at all: an amendment
 * changes who a seat says it is for, never how many there are.
 *
 * What an amendment touches on the HubSpot side is decided field by field, and the
 * asymmetry is deliberate:
 *
 *   email    — the Marketing Event participation is keyed on the CONTACT, so a corrected
 *              email is a different contact and the registration has to move: me.cancel the
 *              old, me.register the new, exactly as transfer does. Anything less leaves
 *              HubSpot holding a seat for an address that does not exist.
 *   name     — D1 only. HubSpot's copy of a person's name is theirs, and 1.2 already
 *              settled that this worker does not rewrite an existing contact's name from
 *              booking data; a typo in our record is not evidence about theirs.
 *   phone /  — through the 1.2 write-back, on 1.2's terms: fill an empty property, leave a
 *   suburb /   difference alone and open a `contact_conflict` for the owner. An amendment
 *   state      is a better-informed guess than a booking form, not a licence to overwrite.
 *   answers  — through the 2.3 write-back as SELF-DECLARED, which is the one place an
 *              amendment claims more authority than a booking does. The rule it turns on
 *              exists to stop a colleague bulk-booking a form from erasing a coeliac's
 *              record; someone who opened this seat and retyped this answer for this person
 *              is the opposite of that, and if their correction could not replace a stale
 *              stored value the correction would not be worth making.
 *
 * The ticket is reissued when the person it names changes, not on every amendment — see
 * `shouldReissue` below.
 */

import type { QuestionAnswers } from '@paddock/shared';
import type { AttendeeContactValues } from './attendee-contact';
import { mintTicketForTenant } from './checkin';
import { loadEvent } from './db';
import {
  type AnswerAmendment,
  answerAmendmentStatements,
  answersToSync,
  loadEventQuestions,
  QuestionValidationError,
  resolveQuestions,
  validateAnswerAmendments,
} from './questions';
import { registerAttendeeInTeams } from './teams';
import type { Env } from './types';

/**
 * The three 1.2 fields, as an amendment expresses them.
 *
 * Deliberately not `ReserveContactDetails`: a booking can only SUPPLY a value, while an
 * amendment must also be able to take one back, so `null` has to be a legal value here and
 * is not one there.
 */
export interface ContactDetailsEdit {
  phone?: string | null;
  suburb?: string | null;
  state?: string | null;
}

/** Order statuses whose seats are live enough for an email to collide with (see reserve.ts). */
const ACTIVE_REGISTRATION_ORDER_STATUSES = ['confirmed', 'paid', 'pending'];

interface RegistrationRow {
  id: string;
  portal_id: string;
  order_id: string;
  event_id: string;
  ticket_type_id: string;
  hubspot_contact_id: string | null;
  attendee_email: string;
  attendee_name: string;
  attendee_phone: string | null;
  attendee_suburb: string | null;
  attendee_state: string | null;
  ticket_id: string | null;
  teams_registration_id: string | null;
  teams_join_url: string | null;
  marketing_event_state_synced: number | null;
  cancelled_at: string | null;
  /** 1 = a seat held with no attendee on it yet (Ref 74b). Optional pre-0039. */
  seat_unnamed?: number | null;
}

export interface AmendRegistrationArgs {
  portalId: string;
  registrationId: string;
  /** New attendee name. Absent = leave it; empty string is rejected, not a clear. */
  name?: string | null;
  /** New attendee email. Absent = leave it; empty string is rejected, not a clear. */
  email?: string | null;
  /**
   * Phone / suburb / state. Absent keys are left alone; an explicitly empty one CLEARS the
   * stored value back to NULL ("never asked"), which is how a value entered against the
   * wrong seat is taken back rather than replaced with a blank.
   */
  contact?: ContactDetailsEdit | null;
  /** Partial map of question key → value. Absent keys untouched; empty value deletes. */
  answers?: QuestionAnswers | null;
  /**
   * Force a fresh ticket even when the person it names did not change. For the case the
   * heuristic cannot see — a code believed to have leaked, a ticket printed wrong.
   */
  reissueTicket?: boolean;
}

/** Field names that actually changed, for the caller's response and the audit line. */
export type AmendedField = 'name' | 'email' | 'phone' | 'suburb' | 'state' | 'answers';

export type AmendResult =
  | {
      ok: true;
      changed: AmendedField[];
      /** The live ticket after the amendment; null when the seat has never had one. */
      ticketId: string | null;
      ticketReissued: boolean;
      /** True when this amendment put a person on a seat that was held without one. */
      seatNamed: boolean;
    }
  | { ok: false; error: string; message?: string; questionKey?: string | null };

function trimmed(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const value_ = value.trim();
  return value_ === '' ? null : value_;
}

/** Present-but-empty is a clear; absent is "leave it alone". */
function contactEdit(
  supplied: ContactDetailsEdit | null | undefined,
  key: 'phone' | 'suburb' | 'state',
): { present: boolean; value: string | null } {
  if (!supplied || !(key in supplied)) return { present: false, value: null };
  return { present: true, value: trimmed((supplied as Record<string, unknown>)[key]) };
}

/**
 * Whether this amendment invalidates the ticket in the attendee's inbox.
 *
 * A QR code carries `{ ticketId, registrationId, eventId }` — not a name, not an email —
 * so nothing about a phone number or a dietary answer can make an issued code wrong. What
 * makes it wrong is the ticket naming a different person from the one holding it, which is
 * exactly an identity change. Reissuing on every amendment would break the code in the
 * wallet of someone whose only crime was having their suburb corrected, and the door staff
 * would find out at 8:30 in the morning.
 *
 * `force` exists for the reasons this cannot see, and a checked-in ticket is never
 * reissued: it has already been used, and voiding it would erase the attendance record the
 * certificate flow reads.
 */
function shouldReissue(identityChanged: boolean, force: boolean, ticketStatus: string | null) {
  if (ticketStatus !== 'issued') return false;
  return identityChanged || force;
}

export async function amendRegistration(
  env: Env,
  args: AmendRegistrationArgs,
): Promise<AmendResult> {
  const { portalId, registrationId } = args;

  const reg = await env.DB.prepare('SELECT * FROM registrations WHERE id = ?1 AND portal_id = ?2')
    .bind(registrationId, portalId)
    .first<RegistrationRow>();
  if (!reg) return { ok: false, error: 'registration_not_found' };
  // A cancelled seat is a historical record. Editing it would quietly change what an
  // attendee list says happened, and the seat it describes is already gone.
  if (reg.cancelled_at !== null) {
    return {
      ok: false,
      error: 'registration_cancelled',
      message: 'This registration was cancelled and can no longer be amended.',
    };
  }

  const event = await loadEvent(env.DB, portalId, reg.event_id);
  if (!event) return { ok: false, error: 'event_not_found' };

  // ---- What is actually changing -------------------------------------------
  const changed: AmendedField[] = [];

  // Naming a seat a company booked without one (Ref 74b). Mechanically an amendment like
  // any other — it is the same seat, at the same price, on the same order — but two things
  // differ: the seat has no previous participation to cancel, and both fields have to
  // arrive together, because half a name is not a person to register.
  const wasUnnamed = reg.seat_unnamed === 1;
  if (wasUnnamed) {
    const suppliedName = trimmed(args.name);
    const suppliedEmail = trimmed(args.email);
    if (!suppliedName || !suppliedEmail) {
      return {
        ok: false,
        error: 'incomplete_attendee',
        message: 'A held seat needs both a name and an email address to be assigned.',
      };
    }
  }

  let name = reg.attendee_name;
  if (args.name !== undefined) {
    const next = trimmed(args.name);
    if (next === null) {
      return { ok: false, error: 'invalid_name', message: 'Attendee name cannot be empty.' };
    }
    if (next !== reg.attendee_name) {
      name = next;
      changed.push('name');
    }
  }

  let email = reg.attendee_email;
  if (args.email !== undefined) {
    const next = trimmed(args.email);
    if (next === null || !next.includes('@')) {
      return { ok: false, error: 'invalid_email', message: 'A valid email address is required.' };
    }
    // Case and surrounding space are not a change: rewriting them would move the Marketing
    // Event registration to "another" contact HubSpot resolves to the same person.
    if (next.toLowerCase() !== reg.attendee_email.trim().toLowerCase()) {
      email = next;
      changed.push('email');
    }
  }
  const emailChanged = changed.includes('email');

  if (emailChanged) {
    // Same guard reserve applies, for the same reason: two live seats for one person on one
    // event is a booking mistake, and an amendment is an easy way to make one by hand.
    const clash = await env.DB.prepare(
      `SELECT r.id
         FROM registrations r
         JOIN orders o ON o.id = r.order_id AND o.portal_id = r.portal_id
        WHERE r.portal_id = ?1 AND r.event_id = ?2 AND r.id != ?3
          AND lower(trim(r.attendee_email)) = ?4
          AND r.cancelled_at IS NULL
          AND o.status IN (${ACTIVE_REGISTRATION_ORDER_STATUSES.map((_, i) => `?${i + 5}`).join(', ')})
        LIMIT 1`,
    )
      .bind(
        portalId,
        reg.event_id,
        reg.id,
        email.toLowerCase(),
        ...ACTIVE_REGISTRATION_ORDER_STATUSES,
      )
      .first<{ id: string }>();
    if (clash) {
      return {
        ok: false,
        error: 'duplicate_attendee',
        message: 'That email address already holds a seat at this event.',
      };
    }
  }

  const details: AttendeeContactValues = {
    phone: reg.attendee_phone,
    suburb: reg.attendee_suburb,
    state: reg.attendee_state,
  };
  /** Only the fields this request touched, for the 1.2 write-back — never the stored rest. */
  const capturedForSync: AttendeeContactValues = { phone: null, suburb: null, state: null };
  for (const field of ['phone', 'suburb', 'state'] as const) {
    const edit = contactEdit(args.contact, field);
    if (!edit.present || edit.value === details[field]) continue;
    details[field] = edit.value;
    capturedForSync[field] = edit.value;
    changed.push(field);
  }
  // A cleared field is a retraction, not something to push: there is nothing to write and
  // 1.2 never blanks a HubSpot property.
  const syncContactDetails = (['phone', 'suburb', 'state'] as const).some(
    (field) => capturedForSync[field] !== null,
  );

  // ---- Answers --------------------------------------------------------------
  let amendment: AnswerAmendment = { upserts: [], deletes: [] };
  if (args.answers && Object.keys(args.answers).length > 0) {
    try {
      const questions = resolveQuestions(await loadEventQuestions(env, portalId, reg.event_id));
      amendment = validateAnswerAmendments({
        questions,
        scope: 'attendee',
        supplied: args.answers,
        subject: name,
      });
    } catch (err) {
      if (err instanceof QuestionValidationError) {
        return {
          ok: false,
          error: err.status,
          message: err.message,
          questionKey: err.questionKey,
        };
      }
      throw err;
    }
    if (amendment.upserts.length > 0 || amendment.deletes.length > 0) changed.push('answers');
  }

  if (changed.length === 0 && args.reissueTicket !== true) {
    return {
      ok: true,
      changed: [],
      ticketId: reg.ticket_id,
      ticketReissued: false,
      seatNamed: false,
    };
  }

  const now = new Date().toISOString();
  const identityChanged = emailChanged || changed.includes('name');

  // ---- Webinar registration -------------------------------------------------
  // Provider-agnostic (CLAUDE.md: nothing provider-specific leaks past the interface), so
  // this covers Teams and everything behind `WebinarProvider` after it. The new
  // registration carries OUR registration id again, which is what keeps attendance matching
  // exact across the correction.
  //
  // Only the replacement is created here. Cancelling the OLD one waits until D1 has
  // accepted the amendment, because until then D1 still names it: a batch that failed
  // between the two would leave the stored registration and join URL pointing at something
  // already cancelled, and send the attendee to a webinar they can no longer enter. The
  // cost of the other order is a spare provider-side registration nobody uses.
  let teamsRegistrationId = reg.teams_registration_id;
  let teamsJoinUrl = reg.teams_join_url;
  const isOnline = event.provider !== null && event.teams_webinar_id !== null;
  const reregisterWebinar = isOnline && identityChanged;
  if (reregisterWebinar) {
    const result = await registerAttendeeInTeams(
      env,
      portalId,
      event.provider,
      event.teams_webinar_id as string,
      { email, name },
      reg.id,
      reg.teams_join_url,
    );
    teamsRegistrationId = result.teamsRegistrationId;
    teamsJoinUrl = result.teamsJoinUrl;
  }

  // ---- Ticket ---------------------------------------------------------------
  const ticketStatus = reg.ticket_id
    ? ((
        await env.DB.prepare('SELECT status FROM tickets WHERE id = ?1 AND portal_id = ?2')
          .bind(reg.ticket_id, portalId)
          .first<{ status: string }>()
      )?.status ?? null)
    : null;
  const reissue = shouldReissue(identityChanged, args.reissueTicket === true, ticketStatus);

  // A seat named for the first time (Ref 74b) has never had a ticket, so there is nothing
  // to REISSUE — there is one to ISSUE, but only once the booking is actually paid. A held
  // seat on an unpaid invoice has no ticket for the same reason no other unpaid booking
  // does; payment confirm issues it then, from the name that is now on the seat.
  const orderPaid = wasUnnamed
    ? ['paid', 'confirmed'].includes(
        (
          await env.DB.prepare('SELECT status FROM orders WHERE id = ?1 AND portal_id = ?2')
            .bind(reg.order_id, portalId)
            .first<{ status: string }>()
        )?.status ?? '',
      )
    : false;
  const issueFirstTicket = wasUnnamed && orderPaid && reg.ticket_id === null;

  const newTicketId = reissue || issueFirstTicket ? crypto.randomUUID() : null;
  const newQr = newTicketId
    ? await mintTicketForTenant(env, portalId, newTicketId, reg.id, event.id)
    : null;

  // ---- The batch ------------------------------------------------------------
  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE registrations
          SET attendee_name = ?1, attendee_email = ?2,
              attendee_phone = ?3, attendee_suburb = ?4, attendee_state = ?5,
              hubspot_contact_id = ?6,
              teams_registration_id = ?7, teams_join_url = ?8,
              marketing_event_state_synced = ?9, seat_unnamed = 0, updated_at = ?10
        WHERE id = ?11 AND portal_id = ?12`,
    ).bind(
      name,
      email,
      details.phone,
      details.suburb,
      details.state,
      // A corrected email is a different contact; clearing the id makes contact.upsert
      // resolve it afresh instead of writing the correction onto the wrong person.
      emailChanged ? null : reg.hubspot_contact_id,
      teamsRegistrationId,
      teamsJoinUrl,
      // Only an email change moves the participation record, so only that resets the sync
      // flag. Clearing it for a suburb correction would re-drive a Marketing Event write
      // that has nothing new to say.
      emailChanged ? 0 : (reg.marketing_event_state_synced ?? 0),
      now,
      reg.id,
      portalId,
    ),
  ];

  stmts.push(
    ...answerAmendmentStatements(env, {
      portalId,
      registrationId: reg.id,
      amendment,
      createdAt: now,
    }),
  );

  if ((reissue || issueFirstTicket) && newTicketId && newQr) {
    stmts.push(
      env.DB.prepare(
        `UPDATE tickets SET status = 'voided' WHERE registration_id = ?1 AND status = 'issued'`,
      ).bind(reg.id),
      env.DB.prepare(
        `INSERT INTO tickets
           (id, portal_id, registration_id, order_id, event_id, ticket_type_id, status, qr_code, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'issued', ?7, ?8)`,
      ).bind(newTicketId, portalId, reg.id, reg.order_id, event.id, reg.ticket_type_id, newQr, now),
      env.DB.prepare('UPDATE registrations SET ticket_id = ?1, updated_at = ?2 WHERE id = ?3').bind(
        newTicketId,
        now,
        reg.id,
      ),
    );
  }

  // ---- Outbox ---------------------------------------------------------------
  const signals: Array<Record<string, unknown>> = [];
  const push = (topic: string, payload: unknown, stable?: string): string => {
    const outboxId = crypto.randomUUID();
    stmts.push(
      stable
        ? env.DB.prepare(
            `INSERT INTO outbox (id, portal_id, topic, payload, stable_interaction_datetime, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
          ).bind(outboxId, portalId, topic, JSON.stringify(payload), stable, now)
        : env.DB.prepare(
            `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)`,
          ).bind(outboxId, portalId, topic, JSON.stringify(payload), now),
    );
    signals.push({ kind: topic, portalId, outboxId, registrationId: reg.id });
    return outboxId;
  };

  if (emailChanged) {
    push('contact.upsert', { email, name, registrationId: reg.id });
    // A seat that never had an attendee has no participation record to retire, and
    // me.cancel on an empty email would ask HubSpot to un-register a contact that does not
    // exist — a dead outbox row per named seat (Ref 74b).
    if (!wasUnnamed) {
      // The OLD address travels in the payload, because the row above now holds the new one.
      push(
        'me.cancel',
        {
          registrationId: reg.id,
          attendeeEmail: reg.attendee_email,
          hubspotContactId: reg.hubspot_contact_id,
          hubspotEventId: event.hubspot_event_id,
          externalAccountId: portalId,
        },
        now,
      );
    }
    push(
      'me.register',
      {
        registrationId: reg.id,
        attendeeEmail: email,
        hubspotContactId: null,
        hubspotEventId: event.hubspot_event_id,
        externalAccountId: portalId,
        ticketTypeId: reg.ticket_type_id,
      },
      now,
    );
    // The confirmation belongs to whoever is on the seat, so a corrected address — or an
    // unnamed seat finally getting a name (Ref 74b) — is stamped too. The handler declines
    // for an order whose card payment has not landed, so no call site has to know (Ref 61).
    push('contact.sync_registration_confirmation', {
      registrationId: reg.id,
      orderId: reg.order_id,
      attendeeEmail: email,
      hubspotContactId: null,
    });
  }

  if (syncContactDetails) {
    push('contact.sync_attendee_details', {
      registrationId: reg.id,
      eventId: event.id,
      attendeeEmail: email,
      attendeeName: name,
      hubspotContactId: emailChanged ? null : reg.hubspot_contact_id,
      details: capturedForSync,
    });
  }

  const answersForSync = answersToSync(amendment.upserts);
  if (answersForSync.length > 0) {
    push('contact.sync_answers', {
      registrationId: reg.id,
      attendeeEmail: email,
      attendeeName: name,
      hubspotContactId: emailChanged ? null : reg.hubspot_contact_id,
      // See the module note: a staff correction of one named person's answer is the
      // authoritative statement about them, not a by-product of somebody's bulk booking.
      selfDeclared: true,
      answers: answersForSync,
    });
  }

  // The join URL is minted per registration, so a re-registration invalidates the copy on
  // the contact. 0026's rule applies: this one is overwritten, never preserved.
  if (reregisterWebinar) {
    push('contact.set_join_url', {
      registrationId: reg.id,
      attendeeEmail: email,
      hubspotContactId: emailChanged ? null : reg.hubspot_contact_id,
      teamsJoinUrl,
    });
  }

  // Retiring the PREVIOUS provider registration is an outbox row, not an inline call, and
  // it carries the old id because the batch below overwrites it. Called inline it could
  // only be attempted once: a transient provider failure was unrecoverable, since nothing
  // afterwards knows the id to retry with, and the former attendee's personal join URL
  // stays live indefinitely — an unauthorised way into the webinar and a second attendance
  // record for a person who is no longer on the seat. Written here it drains with the
  // retry and backoff every other external side effect gets, and it commits in the same
  // batch as the amendment, so it exists exactly when the amendment does.
  if (reregisterWebinar && reg.teams_registration_id) {
    push('webinar.cancel_registration', {
      registrationId: reg.id,
      eventId: event.id,
      provider: event.provider,
      webinarId: event.teams_webinar_id,
      providerRegistrationId: reg.teams_registration_id,
    });
  }

  await env.DB.batch(stmts);

  if (signals.length > 0) {
    try {
      await env.QUEUE.sendBatch(signals.map((body) => ({ body })));
    } catch {
      // Best-effort drain; the reconciliation cron re-drives pending outbox rows.
    }
  }

  return {
    ok: true,
    changed,
    ticketId: newTicketId ?? reg.ticket_id,
    ticketReissued: reissue,
    seatNamed: wasUnnamed,
  };
}
