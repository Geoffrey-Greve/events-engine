/**
 * When an event is for sale (migration 0038).
 *
 * Reserve had no time bound and no manual stop: a course that finished last week still
 * accepted public bookings, and the only way to close one early was to zero its capacity,
 * which Phase 1.1 refuses for good reason. Two independent gates, resolved here so the
 * reserve path, the public availability read and the manage writes all answer the same
 * question the same way.
 *
 *   CLOSED — the clock. `registration_closes_at`, defaulting to the event's own
 *            `starts_at`. Passing it is a fact about time; nobody has to do anything.
 *   PAUSED — a person. `sales_paused`, set deliberately and cleared deliberately.
 *
 * They are reported separately all the way out to the buyer, because "registrations for
 * this course have closed" and "bookings are temporarily on hold" are different sentences
 * and only one of them is worth checking back on.
 *
 * Neither gate touches a seat. A closed event stops SELLING: existing holds run to their
 * own expiry, confirmed seats stay confirmed, and an unpaid invoice stays payable. Closing
 * sales is not a cancellation.
 */

import { resolveTimeZone, zonedDayEndUtc } from './timezone';

/** The shape this module needs. Loosened so a row read before migration 0038 still works. */
export interface SalesWindowFields {
  starts_at: string;
  registration_closes_at?: string | null;
  sales_paused?: number | null;
}

export interface SalesWindow {
  /** The last instant a public booking is accepted. Always resolved, never null. */
  closesAt: string;
  /** True once `closesAt` has passed. */
  closed: boolean;
  /** True when a human has stopped sales by hand. */
  paused: boolean;
  /** Neither closed nor paused — the only state in which public checkout may hold a seat. */
  open: boolean;
  /** Set when the cutoff is the event's own start rather than a chosen date. */
  closesAtIsDefault: boolean;
}

/** Matches the SHAPE of a date-only cutoff: "2026-09-20". Says nothing about the day. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether a shape-valid date names a day that exists.
 *
 * 31 November and 30 February both pass `DATE_ONLY` and both are silently rolled forward
 * by `Date.UTC`, so this compares the parsed components back against what UTC made of
 * them. Leap years come out right for free: 2024-02-29 round-trips, 2026-02-29 does not.
 */
function isRealCalendarDate(dateStr: string): boolean {
  const [year, month, day] = dateStr.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day
  );
}

/**
 * Resolve an event's sales window.
 *
 * A NULL `registration_closes_at` resolves to `starts_at` rather than to "never": selling
 * a seat on a course that has already begun is the bug this exists to fix, so the safe
 * default has to be the one that closes. A tenant wanting a walk-up window past the start
 * says so by setting the column.
 */
export function resolveSalesWindow(event: SalesWindowFields, now: Date = new Date()): SalesWindow {
  const chosen =
    typeof event.registration_closes_at === 'string' ? event.registration_closes_at : '';
  const closesAtIsDefault = chosen.trim() === '';
  const closesAt = closesAtIsDefault ? event.starts_at : chosen;

  // A cutoff that will not parse is treated as no cutoff at all rather than as a closed
  // event: this gate runs in front of every booking, and a malformed value in one column
  // must not be able to take an event off sale with no way for the tenant to see why.
  const closesAtMs = Date.parse(closesAt);
  const closed = Number.isFinite(closesAtMs) && now.getTime() > closesAtMs;
  const paused = event.sales_paused === 1;

  return { closesAt, closed, paused, open: !closed && !paused, closesAtIsDefault };
}

export type SalesWindowRejection =
  | { status: 'registration_closed'; message: string }
  | { status: 'sales_paused'; message: string };

/**
 * The rejection a closed or paused event earns, or null when it is open.
 *
 * PAUSED is reported ahead of CLOSED when both apply. A tenant who has deliberately
 * stopped sales should be told that, not handed the clock's answer — the pause is the
 * decision, and it is the one someone can reverse.
 */
export function salesWindowRejection(window: SalesWindow): SalesWindowRejection | null {
  if (window.paused) {
    return {
      status: 'sales_paused',
      message: 'Bookings for this event are temporarily on hold. Please check back shortly.',
    };
  }
  if (window.closed) {
    return {
      status: 'registration_closed',
      message: 'Registrations for this event have closed.',
    };
  }
  return null;
}

/** A per-ticket-type pause. Types carry no cutoff of their own — see migration 0038. */
export function ticketTypePaused(ticketType: { sales_paused?: number | null }): boolean {
  return ticketType.sales_paused === 1;
}

export type RegistrationClosesAtResult =
  | { ok: true; value: string | null }
  | { ok: false; message: string };

/**
 * Normalise a `registrationClosesAt` write into the stored ISO 8601 UTC instant.
 *
 * Accepts either form, because they mean different things to the person typing them:
 *   - a full instant ("2026-09-20T09:00:00Z") is stored as given, normalised to UTC;
 *   - a DATE ("2026-09-20") means the END of that day where the tenant lives, so "close
 *     on the 20th" leaves the 20th open. Resolved through the tenant's display timezone,
 *     so an Adelaide portal does not lose its last nine and a half hours to UTC.
 *
 * null / '' clears the cutoff back to the `starts_at` default.
 */
export function resolveRegistrationClosesAt(
  input: unknown,
  displayTimeZone: string | null | undefined,
): RegistrationClosesAtResult {
  if (input === null || input === undefined || input === '') return { ok: true, value: null };
  if (typeof input !== 'string') {
    return { ok: false, message: 'registrationClosesAt must be a date or an ISO 8601 timestamp' };
  }

  const trimmed = input.trim();
  if (trimmed === '') return { ok: true, value: null };

  if (DATE_ONLY.test(trimmed)) {
    // The regex proves the SHAPE, not that the day exists. `Date.UTC` silently rolls an
    // impossible one over — 2026-02-30 becomes 2 March — so a mistyped cutoff would leave
    // sales open two days longer than the person setting it intended, and nothing would
    // say so. Round-tripping the parsed parts is what turns that into a rejection.
    if (!isRealCalendarDate(trimmed)) {
      return { ok: false, message: `registrationClosesAt is not a real date: ${trimmed}` };
    }
    const instant = zonedDayEndUtc(trimmed, resolveTimeZone(displayTimeZone));
    if (!instant)
      return { ok: false, message: `registrationClosesAt is not a valid date: ${trimmed}` };
    return { ok: true, value: instant };
  }

  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) {
    return { ok: false, message: `registrationClosesAt is not a valid timestamp: ${trimmed}` };
  }
  return { ok: true, value: new Date(ms).toISOString() };
}
