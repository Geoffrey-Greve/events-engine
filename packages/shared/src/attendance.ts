/**
 * Normalized attendance contract.
 *
 * Every online-event provider (Teams today; Google Meet / Zoom / Wistia / ON24 / Vimeo
 * later) normalizes its raw attendance data into {@link AttendanceRecord} before the
 * worker's shared pipeline matches it to a registration and writes back `me.attend`.
 * This is the boundary shape — nothing provider-specific leaks past it.
 */

/** A single join→leave span for one attendee within one session. */
export interface AttendanceInterval {
  /** ISO 8601 UTC, or null if the provider omits it. */
  join: string | null;
  /** ISO 8601 UTC, or null. */
  leave: string | null;
}

export type AttendanceRole = 'Attendee' | 'Presenter' | 'Organizer' | (string & {});

/**
 * Video-engagement summary for on-demand / recorded providers (Wistia, Vimeo).
 *
 * Unlike live webinars (Teams / Meet / Zoom / ON24) there is no real join→leave
 * window — only how much of the media a viewer watched. Providers populate this
 * AND synthesize an {@link AttendanceInterval} (see {@link syntheticInterval}) so
 * the shared pipeline's attended/no-show + duration logic stays provider-agnostic.
 */
export interface VideoEngagement {
  /** 0–100, fraction of the media watched. */
  percentWatched?: number;
  /** Total seconds of the media actually watched (de-duplicated across plays). */
  secondsWatched?: number;
  /** Number of distinct view sessions/plays. */
  viewSessions?: number;
}

/**
 * Common attendance shape every provider normalizes to. The shared pipeline matches each
 * record to a registration by ourRegistrationId → providerRegistrationId → email, in that
 * order (CLAUDE.md "Microsoft Teams").
 */
export interface AttendanceRecord {
  email: string | null;
  ourRegistrationId?: string | null;
  providerRegistrationId?: string | null;
  role: AttendanceRole;
  intervals: AttendanceInterval[];
  /** Display name kept for the attendance_unmatched audit row. */
  displayName?: string | null;
  /**
   * Video-view analytics for on-demand providers. Optional — live providers
   * leave it undefined, so their records are byte-for-byte unchanged.
   */
  engagement?: VideoEngagement;
  /** Original provider record, persisted on unmatched rows for re-matching. */
  raw?: unknown;
}

/**
 * Derive a synthetic join→leave span from a video view so a recorded-media
 * provider's record flows through the same interval-collapsing + duration math
 * as a live webinar. `start` anchors the span (the event start or first-play
 * time); the leave is `start + secondsWatched`. A non-positive duration yields a
 * zero-length span (counts as "showed up" but no watched time), mirroring how
 * collapseIntervals treats zero-length live spans.
 */
export function syntheticInterval(start: string, secondsWatched: number): AttendanceInterval {
  if (!Number.isFinite(secondsWatched) || secondsWatched <= 0) {
    return { join: start, leave: start };
  }
  const startMs = Date.parse(start);
  if (!Number.isFinite(startMs)) return { join: start, leave: null };
  return { join: start, leave: new Date(startMs + secondsWatched * 1000).toISOString() };
}
