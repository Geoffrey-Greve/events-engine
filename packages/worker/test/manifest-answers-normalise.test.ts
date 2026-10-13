import { type ManifestEntry, normaliseManifestTickets } from '@paddock/shared';
import { describe, expect, it } from 'vitest';

/**
 * Ref 74d follow-up - a manifest that predates `answers`.
 *
 * The field arrived with 74d, and two things outlive a deploy: the manifest already sitting
 * in a scanner's IndexedDB, and a worker on an older build (the PWA ships to Pages and the
 * worker to Workers, on separate commands, so either side can be the stale one). Both are
 * read back as `ManifestEntry`, which declares `answers` required, so nothing in the type
 * system objected and `ticket.answers.length` in the manual search threw mid-render -
 * after the results list had been cleared, so the door saw an empty list and no error, on
 * the offline fallback path that is the scanner's whole reason for holding a manifest.
 */

// The shape a pre-74d record actually deserialises to: no `answers` key at all. Cast
// because that is precisely what the type will not admit, which is how this got through.
const legacyEntry = (name: string): ManifestEntry =>
  ({ code: `code-${name}`, name, status: 'issued', checkedInAt: null }) as unknown as ManifestEntry;

describe('normaliseManifestTickets (Ref 74d follow-up)', () => {
  it('gives a pre-74d ticket an empty answer list rather than undefined', () => {
    const [ticket] = normaliseManifestTickets([legacyEntry('Ada')]);
    expect(ticket?.answers).toEqual([]);
    // The read that threw. Guarding the call site would fix this one line; normalising is
    // what makes it true of every reader, including ones not written yet.
    expect(ticket?.answers.length).toBe(0);
  });

  it('leaves a current ticket alone, and does not copy it', () => {
    // app.ts marks a local check-in by mutating the entry it finds in this array, so an
    // entry replaced by a copy would silently detach that write from the stored manifest.
    const current: ManifestEntry = {
      code: 'code-grace',
      name: 'Grace',
      status: 'issued',
      checkedInAt: null,
      answers: [{ key: 'dietary_requirements', label: 'Dietary requirements', value: 'Coeliac' }],
    };
    const [ticket] = normaliseManifestTickets([current]);
    expect(ticket).toBe(current);
  });

  it('normalises per ticket, not per manifest', () => {
    // A mixed manifest is not hypothetical: it is what a partial write or a future column
    // default produces, and stopping at the first entry that already has answers would
    // leave the rest to throw.
    const tickets = normaliseManifestTickets([
      {
        code: 'code-ada',
        name: 'Ada',
        status: 'issued',
        checkedInAt: null,
        answers: [{ key: 'shirt_size', label: 'Shirt size', value: 'L' }],
      },
      legacyEntry('Grace'),
    ]);
    expect(tickets[0]?.answers).toHaveLength(1);
    expect(tickets[1]?.answers).toEqual([]);
  });

  it('replaces a non-array answers field rather than trusting it', () => {
    // `null` is what a JSON column serialises an absent list to, and it fails the same way.
    const [ticket] = normaliseManifestTickets([
      { ...legacyEntry('Ada'), answers: null } as unknown as ManifestEntry,
    ]);
    expect(ticket?.answers).toEqual([]);
  });

  it('holds an empty manifest', () => {
    expect(normaliseManifestTickets([])).toEqual([]);
  });
});
