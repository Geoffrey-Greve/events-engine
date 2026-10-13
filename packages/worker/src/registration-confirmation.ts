/**
 * Registration confirmation trigger (Ref 61).
 *
 * HubSpot sends the confirmation email, not the worker. It does so by watching one contact
 * property: when it changes, a workflow enrols the contact and sends. All this module owns
 * is deciding WHEN that property changes, WHAT it is called in a given portal, and making
 * sure a value that has already been superseded can never be written back over a newer one.
 *
 * ## The value is the ORDER id
 *
 * A course package or a ten-seat corporate checkout is one order across many registration
 * rows. Stamping the registration id would change the property once per seat and enrol the
 * workflow once per seat, so one booking would send one attendee several emails. The order
 * id changes exactly once per booking, which is the cadence the email wants.
 *
 * ## Why it is not part of `me.register`
 *
 * It was, briefly. `me.register` is enqueued at RESERVE time — before payment, free or paid
 * — so riding it sent "registration confirmed" to a card buyer who then abandoned the
 * checkout and lost the seat at hold expiry. It also put a second HubSpot call inside the
 * Marketing Event handler, ahead of the `marketing_event_state_synced` mirror: a 400 from a
 * portal that had never been asked to create the property killed the whole outbox row AFTER
 * the Marketing Event registration had succeeded, which reporting then read as a real
 * "HubSpot has never heard of this attendee" gap, and which `reconcileOutbox` re-drove
 * forever with a fresh `interactionDateTime` on every sweep.
 *
 * Its own topic, per the standing invariant that every HubSpot side effect goes through the
 * outbox: one side effect, one row, one failure domain.
 *
 * ## When it is enqueued
 *
 * Split on how the booking is paid, which the worker already records on
 * `orders.payment_method` (Phase 4.2):
 *
 *   free / invoice terms — at reserve. The seat is held to the invoice due date and there
 *     is an invoice to pay, so the buyer is owed the confirmation now; waiting would leave
 *     a bank-transfer customer with no acknowledgement for up to 90 days.
 *   card at checkout     — at payment confirm. Nothing is confirmed until the money lands,
 *     and an abandoned checkout must not receive a confirmation for a seat it is about to
 *     lose.
 *
 * {@link shouldStampConfirmation} states that rule once so an enqueue point cannot get it
 * wrong: the amend and transfer paths raise a row whenever the person on a seat changes,
 * and a still-unpaid card order is filtered out at drain time rather than at each call site.
 */

import type { Env } from './types';

/**
 * The name a portal that has expressed no preference gets. Also what the shipped HubSpot
 * workflow spec reads, so a portal that never touches this setting works out of the box.
 */
export const DEFAULT_REGISTRATION_CONFIRMATION_PROPERTY = 'last_event_engine_registration_id';

/** Stored value that turns the write-back off entirely; NULL means "use the default". */
export const REGISTRATION_CONFIRMATION_PROPERTY_OFF = 'off';

/**
 * What the property IS, so the worker can create it rather than leaving an installer to
 * guess. Plain text: it holds an opaque order id and is read by a workflow enrolment
 * trigger, neither of which wants a typed field.
 */
export const REGISTRATION_CONFIRMATION_PROPERTY_DEFINITION = {
  label: 'Last event registration',
  description:
    'The id of the most recent confirmed event booking this contact is on a seat for. ' +
    'Set by the event engine once a booking is paid or invoiced, and watched by the ' +
    'registration confirmation workflow. Never moves backwards: a late-arriving write for ' +
    'an earlier booking cannot overwrite a newer one.',
  type: 'string' as const,
  fieldType: 'text' as const,
};

function emptyToNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The property this portal keys the confirmation trigger on, or null when it is off.
 *
 * Reading optional config must never fail the caller (Ref 217): against a tenants table
 * that predates migration 0040 the SELECT throws "no such column", which degrades to the
 * default — the correct target for a portal that has expressed no preference, and an
 * un-migrated tenant has expressed none.
 */
export async function loadRegistrationConfirmationProperty(
  env: Env,
  portalId: string,
): Promise<string | null> {
  let row: { contact_registration_confirmation_property: string | null } | null = null;
  try {
    row = await env.DB.prepare(
      'SELECT contact_registration_confirmation_property FROM tenants WHERE portal_id = ?1',
    )
      .bind(portalId)
      .first<{ contact_registration_confirmation_property: string | null }>();
  } catch (err) {
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'registration_confirmation_property_unreadable',
        portalId,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  const value = emptyToNull(row?.contact_registration_confirmation_property);
  if (value === null) return DEFAULT_REGISTRATION_CONFIRMATION_PROPERTY;
  if (value.toLowerCase() === REGISTRATION_CONFIRMATION_PROPERTY_OFF) return null;
  return value;
}

/** The outbox topic. One side effect, one row. */
export const REGISTRATION_CONFIRMATION_TOPIC = 'contact.sync_registration_confirmation';

export interface RegistrationConfirmationPayload {
  registrationId: string;
  orderId: string;
  attendeeEmail: string;
  hubspotContactId: string | null;
}

/**
 * Is this booking confirmed enough to tell the customer so?
 *
 * The one case that is not: a card-at-checkout order still sitting `pending`. That is an
 * unpaid hold on a seat the buyer may never pay for, and it is the state a reserve-time
 * email was landing in. Everything else — free (already `confirmed`), invoice terms (held
 * to the due date, with an invoice raised), anything `paid` — is a booking the customer
 * has made and is owed an acknowledgement of.
 *
 * A NULL `payment_method` is a free or comped booking, which has no payment to wait for.
 */
export function shouldStampConfirmation(order: {
  status: string;
  payment_method: string | null;
}): boolean {
  return !(order.status === 'pending' && order.payment_method === 'card');
}

/**
 * The outbox row, to go in the SAME D1 batch as the state change that earns it.
 *
 * Unnamed seats (Ref 74b) are the caller's business to exclude, as they are for
 * `me.register`: a seat with nobody on it has no contact to stamp and no one to email.
 */
export function registrationConfirmationStatement(
  env: Env,
  portalId: string,
  payload: RegistrationConfirmationPayload,
  outboxId: string,
  now: string,
) {
  return env.DB.prepare(
    `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).bind(outboxId, portalId, REGISTRATION_CONFIRMATION_TOPIC, JSON.stringify(payload), now);
}

/** Wake the queue for a row just committed. Best-effort; cron is the backstop. */
export async function signalRegistrationConfirmation(
  env: Env,
  portalId: string,
  outboxId: string,
  registrationId: string,
): Promise<void> {
  await env.QUEUE.send({
    kind: REGISTRATION_CONFIRMATION_TOPIC,
    portalId,
    outboxId,
    registrationId,
  });
}
