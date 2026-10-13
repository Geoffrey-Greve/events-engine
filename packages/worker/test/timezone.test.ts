import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DISPLAY_TIMEZONE,
  isValidTimeZone,
  localCalendarDate,
  resolveTimeZone,
  zonedDayEndUtc,
  zonedDayStartUtc,
} from '../src/timezone';

/**
 * An instant is not a date until you say where.
 *
 * Two things a tenant reads are local facts rather than instants — the attendance date a
 * certificate prints, and a report's date range — and both were being computed in UTC. For
 * an Adelaide portal that is wrong for most morning courses and for both ends of every
 * month. These tests pin the conversions, including the daylight-saving transition, which
 * is the case a hand-rolled offset table gets wrong.
 */

describe('localCalendarDate', () => {
  it('returns the day the attendee was actually in the room', () => {
    // 23:30Z on 4 March is 10:00am on the 5th in Adelaide (ACDT, UTC+10:30).
    expect(localCalendarDate('2026-03-04T23:30:00.000Z', 'Australia/Adelaide')).toBe('2026-03-05');
    // 22:00Z is 08:30am the next day — the morning arrival that the UTC reading got wrong.
    expect(localCalendarDate('2026-03-04T22:00:00.000Z', 'Australia/Adelaide')).toBe('2026-03-05');
    // Mid-afternoon local is the same day either way; the fix must not move this one.
    expect(localCalendarDate('2026-03-05T04:00:00.000Z', 'Australia/Adelaide')).toBe('2026-03-05');
  });

  it('is the UTC date for a UTC portal', () => {
    expect(localCalendarDate('2026-03-04T23:30:00.000Z', 'UTC')).toBe('2026-03-04');
  });

  it('goes backwards for a zone behind UTC', () => {
    // 00:30Z on the 5th is still the evening of the 4th in New York.
    expect(localCalendarDate('2026-03-05T00:30:00.000Z', 'America/New_York')).toBe('2026-03-04');
  });

  it('degrades to the UTC date rather than throwing', () => {
    // This runs on the path that writes attendance to a contact. Losing the write-back
    // entirely would be worse than a date that is at most a day out.
    expect(localCalendarDate('2026-03-04T23:30:00.000Z', 'Not/AZone')).toBe('2026-03-04');
    // An unparseable timestamp passes its first ten characters through, which is exactly
    // what the old UTC-slicing code did. Garbage here would have to come from an outbox
    // payload this worker wrote, and HubSpot rejects it either way — worth not changing
    // while fixing the timezone, so the fix has one effect and not two.
    expect(localCalendarDate('not a date', 'Australia/Adelaide')).toBe('not a date');
  });
});

describe('local day boundaries', () => {
  it('starts and ends an Adelaide day at the right instants', () => {
    // UTC+9:30 in May: the local day begins the previous afternoon.
    expect(zonedDayStartUtc('2026-05-01', 'Australia/Adelaide')).toBe('2026-04-30T14:30:00.000Z');
    expect(zonedDayEndUtc('2026-05-31', 'Australia/Adelaide')).toBe('2026-05-31T14:29:59.999Z');
  });

  it('ends the day at the last representable moment, not the next midnight', () => {
    // An inclusive bound: a course starting exactly at local midnight belongs to the next
    // day's report, not to this one.
    const end = zonedDayEndUtc('2026-05-31', 'Australia/Adelaide') as string;
    const nextStart = zonedDayStartUtc('2026-06-01', 'Australia/Adelaide') as string;
    expect(Date.parse(nextStart) - Date.parse(end)).toBe(1);
  });

  it('handles the daylight-saving transition', () => {
    // Adelaide leaves daylight saving on 5 April 2026: ACDT (+10:30) → ACST (+9:30). The
    // offset that applies is the one in force on the day being asked about, which is why
    // the conversion re-reads the offset at its own answer rather than at the first guess.
    expect(zonedDayStartUtc('2026-04-04', 'Australia/Adelaide')).toBe('2026-04-03T13:30:00.000Z');
    expect(zonedDayStartUtc('2026-04-06', 'Australia/Adelaide')).toBe('2026-04-05T14:30:00.000Z');
  });

  it('is the identity for UTC', () => {
    expect(zonedDayStartUtc('2026-05-01', 'UTC')).toBe('2026-05-01T00:00:00.000Z');
    expect(zonedDayEndUtc('2026-05-01', 'UTC')).toBe('2026-05-01T23:59:59.999Z');
  });

  it('rejects anything that is not a bare date', () => {
    for (const bad of ['', '2026-5-1', '2026-05-01T00:00:00Z', 'June', '2026-05']) {
      expect(zonedDayStartUtc(bad, 'Australia/Adelaide')).toBeNull();
    }
  });
});

describe('resolveTimeZone', () => {
  it('falls back to the default for anything unusable', () => {
    // A typo in tenants.display_timezone must not be able to kill an outbox row.
    for (const bad of [null, undefined, '', '   ', 'Not/AZone', 'Adelaide']) {
      expect(resolveTimeZone(bad)).toBe(DEFAULT_DISPLAY_TIMEZONE);
    }
  });

  it('honours a real IANA name as given', () => {
    // Nothing here is Australian beyond the default — this is a product, and a portal
    // anywhere sets its own zone.
    for (const zone of ['UTC', 'Europe/London', 'America/New_York', 'Pacific/Auckland']) {
      expect(resolveTimeZone(zone)).toBe(zone);
    }
  });

  it('agrees with isValidTimeZone', () => {
    expect(isValidTimeZone('Australia/Adelaide')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
  });
});
