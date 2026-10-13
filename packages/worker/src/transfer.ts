/**
 * Transfer a registration to a different attendee (Phase 18.2).
 *
 * Reassigns the seat to a new person WITHOUT refunding — the seat is kept, so there is no
 * DO change. Steps (all D1 mutations + outbox rows in one batch, per CLAUDE.md):
 *   1. Gate on the resolved refund policy's allow_transfer.
 *   2. (Teams) re-register the new attendee stamping the SAME registration.id so
 *      attendance matching stays exact; cancel the old Teams registration.
 *   3. Move the registration's attendee_email/name/hubspot_contact_id (+ teams ids).
 *   4. Reissue the ticket: mint a new signed QR, void the old code.
 *   5. Outbox: upsert the new contact, me.cancel the old contact, me.register the new
 *      contact (+ contact.set_join_url for online events).
 *   6. Log to the transfers audit table.
 */

import { mintTicketForTenant } from './checkin';
import { loadEvent } from './db';
import { resolveRefundPolicy } from './refund-policy';
import { registrationConfirmationStatement } from './registration-confirmation';
import { cancelAttendeeInTeams, registerAttendeeInTeams } from './teams';
import type { Env } from './types';

interface RegistrationRow {
  id: string;
  portal_id: string;
  order_id: string;
  event_id: string;
  ticket_type_id: string;
  hubspot_contact_id: string | null;
  attendee_email: string;
  attendee_name: string;
  ticket_id: string | null;
  teams_registration_id: string | null;
  teams_join_url: string | null;
}

export interface TransferArgs {
  portalId: string;
  registrationId: string;
  toEmail: string;
  toName: string;
  reason?: string | null;
}

export type TransferResult = { ok: true; ticketId: string } | { ok: false; error: string };

export async function transferRegistration(env: Env, args: TransferArgs): Promise<TransferResult> {
  const { portalId, registrationId, toEmail, toName } = args;

  const reg = await env.DB.prepare('SELECT * FROM registrations WHERE id = ?1 AND portal_id = ?2')
    .bind(registrationId, portalId)
    .first<RegistrationRow>();
  if (!reg) return { ok: false, error: 'registration_not_found' };

  const event = await loadEvent(env.DB, portalId, reg.event_id);
  if (!event) return { ok: false, error: 'event_not_found' };

  // 1. Policy gate.
  const policy = await resolveRefundPolicy(env, event);
  if (!policy.allowTransfer) return { ok: false, error: 'transfer_not_allowed' };

  const fromEmail = reg.attendee_email;
  const now = new Date().toISOString();

  // 2. Teams: re-register the new attendee under the SAME registration id, cancel the old.
  let teamsRegistrationId = reg.teams_registration_id;
  let teamsJoinUrl = reg.teams_join_url;
  const isOnline = event.provider !== null && event.teams_webinar_id !== null;
  if (isOnline) {
    const result = await registerAttendeeInTeams(
      env,
      portalId,
      event.provider,
      event.teams_webinar_id as string,
      { email: toEmail, name: toName },
      reg.id,
    );
    await cancelAttendeeInTeams(
      env,
      portalId,
      event.provider,
      event.teams_webinar_id as string,
      reg.teams_registration_id,
    );
    teamsRegistrationId = result.teamsRegistrationId;
    teamsJoinUrl = result.teamsJoinUrl;
  }

  // 4. Reissue the ticket (new signed QR; the old code is voided in the batch below).
  const newTicketId = crypto.randomUUID();
  const newQr = await mintTicketForTenant(env, portalId, newTicketId, reg.id, event.id);

  const transferId = crypto.randomUUID();
  const contactUpsertOutboxId = crypto.randomUUID();
  const meCancelOutboxId = crypto.randomUUID();
  const meRegisterOutboxId = crypto.randomUUID();
  const joinUrlOutboxId = crypto.randomUUID();

  const stmts: D1PreparedStatement[] = [
    // 3. Move the registration to the new attendee (contact id cleared; contact.upsert sets it).
    env.DB.prepare(
      `UPDATE registrations
         SET attendee_email = ?1, attendee_name = ?2, hubspot_contact_id = NULL,
             teams_registration_id = ?3, teams_join_url = ?4,
             marketing_event_state_synced = 0, updated_at = ?5
       WHERE id = ?6`,
    ).bind(toEmail, toName, teamsRegistrationId, teamsJoinUrl, now, reg.id),

    // 4. Void the old ticket code, issue the new one, repoint the registration.
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

    // 5. Outbox: upsert the new contact (sets the name + contact id back on the reg).
    env.DB.prepare(
      `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
       VALUES (?1, ?2, 'contact.upsert', ?3, ?4)`,
    ).bind(
      contactUpsertOutboxId,
      portalId,
      JSON.stringify({ email: toEmail, name: toName, registrationId: reg.id }),
      now,
    ),

    // me.cancel the OLD contact (old email carried in payload, not the now-updated row).
    env.DB.prepare(
      `INSERT INTO outbox (id, portal_id, topic, payload, stable_interaction_datetime, created_at)
       VALUES (?1, ?2, 'me.cancel', ?3, ?4, ?5)`,
    ).bind(
      meCancelOutboxId,
      portalId,
      JSON.stringify({
        registrationId: reg.id,
        attendeeEmail: fromEmail,
        hubspotContactId: reg.hubspot_contact_id,
        hubspotEventId: event.hubspot_event_id,
        externalAccountId: portalId,
      }),
      now,
      now,
    ),

    // me.register the NEW contact.
    env.DB.prepare(
      `INSERT INTO outbox (id, portal_id, topic, payload, stable_interaction_datetime, created_at)
       VALUES (?1, ?2, 'me.register', ?3, ?4, ?5)`,
    ).bind(
      meRegisterOutboxId,
      portalId,
      JSON.stringify({
        registrationId: reg.id,
        attendeeEmail: toEmail,
        hubspotContactId: null,
        hubspotEventId: event.hubspot_event_id,
        externalAccountId: portalId,
        ticketTypeId: reg.ticket_type_id,
      }),
      now,
      now,
    ),

    // 6. Audit row.
    env.DB.prepare(
      `INSERT INTO transfers (id, portal_id, registration_id, from_email, to_email, reason, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(transferId, portalId, reg.id, fromEmail, toEmail, args.reason ?? null, now),
  ];

  // The seat is now somebody else's, so the confirmation is theirs too (Ref 61). The
  // handler declines for an order whose card payment has not landed.
  const confirmationOutboxId = crypto.randomUUID();
  stmts.push(
    registrationConfirmationStatement(
      env,
      portalId,
      {
        registrationId: reg.id,
        orderId: reg.order_id,
        attendeeEmail: toEmail,
        hubspotContactId: null,
      },
      confirmationOutboxId,
      now,
    ),
  );

  // Write the new personal join URL to the new contact before the confirmation fires.
  if (isOnline) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
         VALUES (?1, ?2, 'contact.set_join_url', ?3, ?4)`,
      ).bind(
        joinUrlOutboxId,
        portalId,
        JSON.stringify({
          registrationId: reg.id,
          attendeeEmail: toEmail,
          hubspotContactId: null,
          teamsJoinUrl,
        }),
        now,
      ),
    );
  }

  await env.DB.batch(stmts);

  // Drain the outbox signals (best-effort; the reconciliation cron is the backstop).
  try {
    const signals: { body: Record<string, unknown> }[] = [
      { body: { kind: 'contact.upsert', portalId, outboxId: contactUpsertOutboxId } },
      { body: { kind: 'me.cancel', portalId, outboxId: meCancelOutboxId, registrationId: reg.id } },
      {
        body: {
          kind: 'me.register',
          portalId,
          outboxId: meRegisterOutboxId,
          registrationId: reg.id,
        },
      },
      {
        body: {
          kind: 'contact.sync_registration_confirmation',
          portalId,
          outboxId: confirmationOutboxId,
          registrationId: reg.id,
        },
      },
    ];
    if (isOnline) {
      signals.push({ body: { kind: 'contact.set_join_url', portalId, outboxId: joinUrlOutboxId } });
    }
    await env.QUEUE.sendBatch(signals);
  } catch {
    // swallow — the cron re-drives pending outbox rows.
  }

  return { ok: true, ticketId: newTicketId };
}
