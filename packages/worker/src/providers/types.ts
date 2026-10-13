/**
 * Online-event provider abstraction.
 *
 * Online events (Teams, and later Google Meet / Zoom / Wistia / ON24 / Vimeo) all
 * go through a `WebinarProvider`. Teams is the only MVP implementation; nothing
 * provider-specific leaks past this interface. `events.provider` selects the impl
 * (see ./index.ts → getWebinarProvider) and every provider normalizes attendance
 * to the common `AttendanceRecord` shape below so matching + the HubSpot
 * me.attend write-back are provider-agnostic (CLAUDE.md "Microsoft Teams").
 */

/** Normalized event input for createWebinar — never carries provider specifics. */
export interface WebinarEventInput {
  portalId: string;
  /** Our internal events.id. */
  eventId: string;
  /** HubSpot marketing-event externalEventId. */
  hubspotEventId: string;
  title: string;
  /** ISO 8601 UTC. */
  startsAt: string;
  /** ISO 8601 UTC. */
  endsAt: string;
}

export interface CreateWebinarResult {
  providerWebinarId: string;
  providerSessionId: string;
  /** Generic (non-personal) join URL, if the provider exposes one. */
  joinUrl: string | null;
}

/** One attendee to register, carrying OUR registration id for exact matching. */
export interface WebinarAttendeeInput {
  email: string;
  name: string;
  /** Our registrations.id — stamped onto the provider registration at register time. */
  ourRegistrationId: string;
}

export interface RegisterAttendeeResult {
  providerRegistrationId: string | null;
  /** Per-attendee join URL written to the HubSpot contact before the invite fires. */
  personalJoinUrl: string | null;
}

// The normalized attendance shape (AttendanceInterval / AttendanceRole / AttendanceRecord)
// is the cross-boundary contract — it lives in @paddock/shared. Imported for local use in
// the WebinarProvider interface below and re-exported so provider code (and the attendance
// pipeline) keeps importing it from this module.
import type {
  AttendanceInterval,
  AttendanceRecord,
  AttendanceRole,
  VideoEngagement,
} from '@paddock/shared';

export { syntheticInterval } from '@paddock/shared';
export type { AttendanceInterval, AttendanceRecord, AttendanceRole, VideoEngagement };

/** Queue job emitted by webhook-driven providers (and the missed-webhook cron). */
export interface PullAttendanceJob {
  kind: 'graph.pull_attendance';
  portalId: string;
  webinarId: string;
}

export interface WebinarProvider {
  /** Matches the events.provider value that selects this impl. */
  readonly name: string;

  /** Create the webinar (provider owns the IDs) and capture webinar/session/join. */
  createWebinar(event: WebinarEventInput): Promise<CreateWebinarResult>;

  /** Register one attendee, stamping our registration id; return the personal join URL. */
  registerAttendee(
    webinarId: string,
    attendee: WebinarAttendeeInput,
  ): Promise<RegisterAttendeeResult>;

  /**
   * Cancel a previously-registered attendee (used by transfer). Optional — providers
   * that can't cancel a registration omit it; callers treat absence as a no-op.
   */
  cancelRegistration?(webinarId: string, providerRegistrationId: string): Promise<void>;

  /**
   * Ensure the change-notification subscription exists and is fresh.
   * Webhook-driven providers create/renew a subscription here; poll-based
   * providers may no-op. Idempotent — safe to call from the renewal cron.
   */
  ensureSubscription(tenant: { portalId: string }): Promise<void>;

  /**
   * Parse an inbound change notification into zero or more pull jobs.
   * Verifies authenticity (e.g. clientState) and handles lifecycle events
   * (reauthorizationRequired / subscriptionRemoved / missed) as needed.
   */
  handleNotification(payload: unknown): Promise<PullAttendanceJob[]>;

  /** List + normalize attendance for one session into the common shape. */
  fetchAttendance(webinarId: string, sessionId: string): Promise<AttendanceRecord[]>;
}
