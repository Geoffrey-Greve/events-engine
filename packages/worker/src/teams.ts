/**
 * Reserve-flow integration for online events (Phase 3 wiring).
 *
 * These helpers are the bridge between the reservation handler and the
 * WebinarProvider abstraction. They are deliberately non-throwing: if Graph
 * isn't configured for a tenant (or a call fails), the reservation still
 * completes — the attendee row is recorded, me.register is still queued, and
 * the join URL is simply left null. The renewal/finalize crons and the pull
 * pipeline reconcile attendance independently.
 */

import type { EventRow } from './db';
import { getWebinarProvider } from './providers';
import type { CreateWebinarResult } from './providers/types';
import type { Env } from './types';

export interface TeamsRegistrationResult {
  teamsRegistrationId: string | null;
  teamsJoinUrl: string | null;
}

export interface ProvisionedWebinar {
  teamsWebinarId: string;
  teamsSessionId: string;
  teamsJoinUrl: string | null;
}

/**
 * Registers one attendee with the event's webinar provider, stamping our
 * registration id so attendance matching is exact (CLAUDE.md:
 * externalRegistrationInformation.registrationId). Returns provider ids mapped
 * onto the columns the reserve flow persists (teams_registration_id / _join_url).
 */
export async function registerAttendeeInTeams(
  env: Env,
  portalId: string,
  providerName: string | null,
  webinarId: string,
  attendee: { email: string; name: string },
  registrationId: string,
  fallbackJoinUrl: string | null = null,
): Promise<TeamsRegistrationResult> {
  const provider = getWebinarProvider(env, portalId, providerName);
  if (!provider) return { teamsRegistrationId: null, teamsJoinUrl: null };

  try {
    const result = await provider.registerAttendee(webinarId, {
      email: attendee.email,
      name: attendee.name,
      ourRegistrationId: registrationId,
    });
    return {
      teamsRegistrationId: result.providerRegistrationId,
      teamsJoinUrl: result.personalJoinUrl ?? fallbackJoinUrl,
    };
  } catch {
    // Non-fatal — see module note. Registration proceeds without a join URL.
    return { teamsRegistrationId: null, teamsJoinUrl: null };
  }
}

/**
 * Cancels an attendee's webinar registration (used by transfer). Non-throwing and a
 * no-op when the provider can't cancel or no provider registration id was stored.
 */
export async function cancelAttendeeInTeams(
  env: Env,
  portalId: string,
  providerName: string | null,
  webinarId: string,
  providerRegistrationId: string | null,
): Promise<void> {
  try {
    await cancelWebinarRegistration(env, portalId, providerName, webinarId, providerRegistrationId);
  } catch {
    // Non-fatal — the old registration is orphaned; attendance matching uses our id.
  }
}

/**
 * The same cancellation, but it THROWS.
 *
 * Swallowing the failure is right where the call is the last word on the subject and an
 * orphan is the only cost. It is wrong where something is waiting to retry: an amendment
 * that has already overwritten the stored provider registration id cannot reconstruct it,
 * so a silent failure leaves the previous attendee's personal join URL live for good. That
 * path drives this through the outbox, which needs to be told when to come back.
 *
 * A provider that cannot cancel at all, or a registration id we never had, is not a
 * failure — there is nothing to retry — so both return quietly.
 */
export async function cancelWebinarRegistration(
  env: Env,
  portalId: string,
  providerName: string | null,
  webinarId: string,
  providerRegistrationId: string | null,
): Promise<void> {
  if (!providerRegistrationId) return;
  const provider = getWebinarProvider(env, portalId, providerName);
  if (!provider?.cancelRegistration) return;
  await provider.cancelRegistration(webinarId, providerRegistrationId);
}

/**
 * Lazily provisions the webinar on first reservation for an online event whose
 * provider hasn't created one yet, persisting the captured ids onto the event.
 *
 * Returns the effective webinar ids (newly created, or another concurrent
 * reserver's, re-read after a guarded UPDATE), or null if provisioning failed
 * or the provider is unconfigured. (Note: under heavy concurrent first-reserves
 * a duplicate draft webinar can be created and orphaned; only one wins the
 * guarded UPDATE. Provisioning at event-setup time avoids this — left for the
 * future event-creation path.)
 */
export async function provisionWebinarIfNeeded(
  env: Env,
  portalId: string,
  event: EventRow,
): Promise<ProvisionedWebinar | null> {
  if (event.teams_webinar_id && event.teams_session_id) {
    return {
      teamsWebinarId: event.teams_webinar_id,
      teamsSessionId: event.teams_session_id,
      teamsJoinUrl: event.teams_join_url,
    };
  }

  const provider = getWebinarProvider(env, portalId, event.provider);
  if (!provider) return null;

  let created: CreateWebinarResult;
  try {
    created = await provider.createWebinar({
      portalId,
      eventId: event.id,
      hubspotEventId: event.hubspot_event_id,
      title: event.title,
      startsAt: event.starts_at,
      endsAt: event.ends_at,
    });
  } catch {
    return null;
  }

  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    `UPDATE events
       SET teams_webinar_id = ?1, teams_session_id = ?2, teams_join_url = ?3, updated_at = ?4
     WHERE id = ?5 AND teams_webinar_id IS NULL`,
  )
    .bind(created.providerWebinarId, created.providerSessionId, created.joinUrl, now, event.id)
    .run();

  if (res.meta.changes === 0) {
    // Another reserver won the race — use the values they persisted.
    const fresh = await env.DB.prepare(
      'SELECT teams_webinar_id, teams_session_id, teams_join_url FROM events WHERE id = ?1',
    )
      .bind(event.id)
      .first<{
        teams_webinar_id: string | null;
        teams_session_id: string | null;
        teams_join_url: string | null;
      }>();
    if (fresh?.teams_webinar_id && fresh.teams_session_id) {
      return {
        teamsWebinarId: fresh.teams_webinar_id,
        teamsSessionId: fresh.teams_session_id,
        teamsJoinUrl: fresh.teams_join_url,
      };
    }
    return null;
  }

  return {
    teamsWebinarId: created.providerWebinarId,
    teamsSessionId: created.providerSessionId,
    teamsJoinUrl: created.joinUrl,
  };
}
