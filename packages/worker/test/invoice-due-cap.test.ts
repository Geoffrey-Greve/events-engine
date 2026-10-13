/**
 * The invoice due date never outlasts the session it holds a seat for.
 *
 * `invoice_due_days` is a day COUNT from the booking, so it cannot say "hold the seat
 * until the course": a flat 30 on a course ten weeks out frees the seat six weeks early,
 * and the same 30 on a booking taken the day before the course leaves an invoice falling
 * due a month after it ran. Configuring it per event is worse rather than better, because
 * a day count is correct on the day it is typed and stale every day after.
 *
 * So it is a cap, applied per booking, and these pin the edges of it.
 */
import { describe, expect, it } from 'vitest';
import { capDueDateToEventStart } from '../src/routes/reserve';

const ADELAIDE = 'Australia/Adelaide';

function isoDaysFromNow(days: number, timeOfDayUtc = '00:30:00.000Z'): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.toISOString().slice(0, 10)}T${timeOfDayUtc}`;
}

function dateDaysFromNow(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe('capDueDateToEventStart', () => {
  it('pulls the due date back to a session that starts sooner', () => {
    // 30-day terms on a course running in 10 days: the seat has to be held to the course,
    // not a fortnight past it.
    const due = dateDaysFromNow(30);
    expect(capDueDateToEventStart(due, isoDaysFromNow(10), ADELAIDE)).toBe(dateDaysFromNow(10));
  });

  it('leaves the due date alone when the session is further out', () => {
    // A course in 60 days keeps the configured 30-day terms; the 90-day ceiling and the
    // tenant's own config still decide, and this only ever shortens.
    const due = dateDaysFromNow(30);
    expect(capDueDateToEventStart(due, isoDaysFromNow(60), ADELAIDE)).toBe(due);
  });

  it('reads the start as a LOCAL calendar date, not the UTC one', () => {
    // A 9am Adelaide start is 23:30 UTC the day before. Slicing the ISO string would cap a
    // day early and free the seat the afternoon before the course.
    const due = dateDaysFromNow(30);
    const nineAmAdelaide = `${dateDaysFromNow(9)}T23:30:00.000Z`;
    expect(capDueDateToEventStart(due, nineAmAdelaide, ADELAIDE)).toBe(dateDaysFromNow(10));
  });

  it('never moves the due date into the past', () => {
    // A session that has already begun is refused by the registration cutoff, not by a
    // due-date error on a booking staff may be making deliberately.
    const due = dateDaysFromNow(30);
    expect(capDueDateToEventStart(due, isoDaysFromNow(-5), ADELAIDE)).toBe(due);
  });

  it('caps to today for a session starting today', () => {
    // Due on receipt, which resolveInvoiceDueDate accepts: the hold runs to the END of the
    // due date, so today is still in the future.
    const due = dateDaysFromNow(30);
    expect(capDueDateToEventStart(due, isoDaysFromNow(0, '12:00:00.000Z'), ADELAIDE)).toBe(
      dateDaysFromNow(0),
    );
  });

  it('leaves the due date alone when the session has no start, or an unusable one', () => {
    // "We cannot tell when this runs" is not evidence that it runs soon.
    const due = dateDaysFromNow(30);
    expect(capDueDateToEventStart(due, null, ADELAIDE)).toBe(due);
    expect(capDueDateToEventStart(due, undefined, ADELAIDE)).toBe(due);
    expect(capDueDateToEventStart(due, 'not-a-date', ADELAIDE)).toBe(due);
  });
});
