/**
 * Measuring price drift for guests before enforcing it.
 *
 * `expectedUnitCents` is sent only for a buyer the CMS believes is a member, so a GUEST
 * reached reserve with no price guard at all: the page could display one amount and the
 * invoice carry another, with nothing anywhere noticing. That is a money bug on the most
 * common path through the checkout.
 *
 * Turning the enforcing guard on for guests in one step would have risked refusing
 * bookings that work today, over a disagreement nobody had measured, so guests first sent
 * `quotedUnitCents`: the same comparison and the same `price_drift` log, marked
 * `enforced: false`, which can never refuse. That step is done - the CMS sends guests
 * `expectedUnitCents` now that both sides price a guest from one HubDB row - and both
 * fields remain, because which one may refuse is the half that is easy to get wrong and
 * the worker still answers callers it does not write.
 *
 * So that is what these pin.
 */
import { describe, expect, it } from 'vitest';
import { comparePriceQuote, decidePriceQuote } from '../src/routes/reserve';

const RESOLVED = [58500];

describe('comparePriceQuote', () => {
  it('matches an exact quote', () => {
    expect(comparePriceQuote(58500, RESOLVED)).toBe('match');
  });

  it('rejects only when the resolved price is HIGHER than displayed', () => {
    // Invoicing more than the page showed is never acceptable.
    expect(comparePriceQuote(58500, [64350])).toBe('rejected');
  });

  it('honours a lower resolved price rather than turning the buyer away', () => {
    expect(comparePriceQuote(64350, RESOLVED)).toBe('honoured_lower');
  });

  it('matches if any line matches, and rejects if any line is higher', () => {
    expect(comparePriceQuote(58500, [58500, 30000])).toBe('match');
    expect(comparePriceQuote(58500, [30000, 64350])).toBe('rejected');
  });
});

describe('decidePriceQuote', () => {
  it('compares nothing when the page sent no price', () => {
    // A guest before this change, and the gap it closes.
    expect(decidePriceQuote({ forceFree: false, resolvedUnitCents: RESOLVED })).toBeNull();
  });

  it('compares nothing for a comped booking', () => {
    // There is no price to disagree about.
    expect(
      decidePriceQuote({ forceFree: true, expectedUnitCents: 1, resolvedUnitCents: RESOLVED }),
    ).toBeNull();
  });

  describe('expectedUnitCents — enforcing', () => {
    it('refuses a resolved price above the displayed one', () => {
      const decision = decidePriceQuote({
        forceFree: false,
        expectedUnitCents: 58500,
        resolvedUnitCents: [64350],
      });
      expect(decision).toMatchObject({ outcome: 'rejected', enforced: true, reject: true });
    });

    it('still honours a lower resolved price', () => {
      const decision = decidePriceQuote({
        forceFree: false,
        expectedUnitCents: 64350,
        resolvedUnitCents: RESOLVED,
      });
      expect(decision).toMatchObject({ outcome: 'honoured_lower', reject: false });
    });
  });

  describe('quotedUnitCents — measuring only', () => {
    it('reports a mismatch without refusing the booking', () => {
      // The property that matters: a guest whose quote disagrees is LOGGED and booked.
      const decision = decidePriceQuote({
        forceFree: false,
        quotedUnitCents: 58500,
        resolvedUnitCents: [64350],
      });
      expect(decision).toMatchObject({
        outcome: 'rejected',
        enforced: false,
        reject: false,
        expectedUnitCents: 58500,
      });
    });

    it('marks a clean comparison as unenforced too, so the logs can be counted', () => {
      const decision = decidePriceQuote({
        forceFree: false,
        quotedUnitCents: 58500,
        resolvedUnitCents: RESOLVED,
      });
      expect(decision).toMatchObject({ outcome: 'match', enforced: false, reject: false });
    });
  });

  it('lets expectedUnitCents win when a caller sends both', () => {
    // A caller asking to be held to its number is not let off by also reporting one.
    const decision = decidePriceQuote({
      forceFree: false,
      expectedUnitCents: 58500,
      quotedUnitCents: 1,
      resolvedUnitCents: [64350],
    });
    expect(decision).toMatchObject({ expectedUnitCents: 58500, enforced: true, reject: true });
  });
});
