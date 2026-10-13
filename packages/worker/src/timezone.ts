/**
 * Display-timezone handling.
 *
 * D1 stores every timestamp as ISO 8601 UTC and that does not change — UTC is the only sane
 * storage contract for a multi-tenant system. But two things a tenant reads are LOCAL facts,
 * not instants, and computing them in UTC produces answers that are quietly wrong:
 *
 *   1. **The attendance date on a contact.** A certificate prints a calendar day. Adelaide is
 *      UTC+9:30 (+10:30 over daylight saving), so a 9am course whose attendees scan in from
 *      8:30 has a UTC date of the PREVIOUS day. Morning courses are the normal case for
 *      training, so taking `iso.slice(0, 10)` put the wrong day on the certificate for most
 *      of them.
 *   2. **A report's date range.** HubSpot stores datetimes in UTC but its reports group by
 *      the PORTAL's timezone, so a HubSpot dashboard's "June" is June in Adelaide. A range
 *      built in UTC drops courses starting on the morning of 1 June and picks up ones
 *      starting the morning of 1 July — a report disagreeing with the dashboard by a handful
 *      of records, which is the exact failure Phase 2.2 exists to end.
 *
 * Both are the same bug: an instant is not a date until you say where. Everything here
 * converts between the two and nothing here changes what is stored.
 *
 * `Intl` carries the IANA database, so daylight saving is handled by the platform rather
 * than by an offset table that would need maintaining.
 */

/**
 * Used when a tenant has expressed no preference. Australian, because the first portals are
 * — a portal anywhere else sets `tenants.display_timezone` and everything here follows it.
 * There is nothing tenant-specific in this module beyond this constant.
 */
export const DEFAULT_DISPLAY_TIMEZONE = 'Australia/Adelaide';

/**
 * Resolve a stored timezone, falling back to the default.
 *
 * An unrecognised IANA name degrades to the default rather than throwing: this is read on
 * the path that writes attendance to a contact, and a typo in a config column must not be
 * able to kill an outbox row.
 */
export function resolveTimeZone(stored: string | null | undefined): string {
  const value = (stored ?? '').trim();
  if (value === '') return DEFAULT_DISPLAY_TIMEZONE;
  return isValidTimeZone(value) ? value : DEFAULT_DISPLAY_TIMEZONE;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall-clock reading in `timeZone` at a given instant. */
function wallClockAt(instantMs: number, timeZone: string): WallClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instantMs));

  const field = (type: string): number => {
    const found = parts.find((part) => part.type === type)?.value ?? '0';
    return Number.parseInt(found, 10);
  };

  return {
    year: field('year'),
    month: field('month'),
    day: field('day'),
    // Some ICU builds render midnight as hour 24 under hour12:false. Left as 24 it would
    // push a date a whole day forward, which is the precise class of error this module
    // exists to remove.
    hour: field('hour') % 24,
    minute: field('minute'),
    second: field('second'),
  };
}

/** The offset (ms) that `timeZone` is ahead of UTC at a given instant. */
function offsetMsAt(instantMs: number, timeZone: string): number {
  const local = wallClockAt(instantMs, timeZone);
  const asIfUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  // Second-resolution: the wall clock above carries no milliseconds, so compare like for
  // like or every offset is out by the instant's sub-second part.
  return asIfUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * The local calendar date ('YYYY-MM-DD') at an instant — what a certificate prints and what
 * a HubSpot `date` property should hold.
 *
 * An unparseable timestamp falls back to the UTC date, which is the old behaviour: wrong by
 * a day at worst, where throwing would lose the write-back entirely.
 */
export function localCalendarDate(iso: string, timeZone: string): string {
  const instantMs = Date.parse(iso);
  if (Number.isNaN(instantMs)) return iso.slice(0, 10);
  try {
    const local = wallClockAt(instantMs, timeZone);
    const mm = String(local.month).padStart(2, '0');
    const dd = String(local.day).padStart(2, '0');
    return `${local.year}-${mm}-${dd}`;
  } catch {
    return iso.slice(0, 10);
  }
}

/**
 * The UTC instant of a local wall-clock time on a local calendar date.
 *
 * Two passes: guess using the offset at the naive instant, then re-read the offset at that
 * guess. The second pass is what makes a daylight-saving boundary come out right — the
 * offset that applies is the one in force at the ANSWER, not the one at the guess.
 */
function zonedWallClockToUtc(
  dateStr: string,
  timeZone: string,
  time: { hour: number; minute: number; second: number; ms: number },
): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!match) return null;

  const naive = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    time.hour,
    time.minute,
    time.second,
    time.ms,
  );
  if (Number.isNaN(naive)) return null;

  try {
    let instant = naive - offsetMsAt(naive, timeZone);
    instant = naive - offsetMsAt(instant, timeZone);
    return new Date(instant).toISOString();
  } catch {
    return null;
  }
}

/** The UTC instant at which a local calendar day begins. */
export function zonedDayStartUtc(dateStr: string, timeZone: string): string | null {
  return zonedWallClockToUtc(dateStr, timeZone, { hour: 0, minute: 0, second: 0, ms: 0 });
}

/**
 * The UTC instant at the last representable moment of a local calendar day.
 *
 * `23:59:59.999` rather than the next day's midnight, so the bound stays INCLUSIVE — a
 * course starting exactly at midnight on the following day belongs to that day, not to this
 * report.
 */
export function zonedDayEndUtc(dateStr: string, timeZone: string): string | null {
  return zonedWallClockToUtc(dateStr, timeZone, { hour: 23, minute: 59, second: 59, ms: 999 });
}
