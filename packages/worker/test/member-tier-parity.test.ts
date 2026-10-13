/**
 * The tier-label → pricing-level contract, from the Worker's side.
 *
 * The same buyer is priced twice: the CMS quotes them from a HubDB row and this Worker
 * re-resolves the price at reserve. A disagreement reaches the buyer as "the course
 * price changed before checkout" (`price_mismatch`, when we resolve HIGHER than the
 * page quoted) or as a silent undercharge (`honoured_lower`). Neither is a bug the
 * buyer can act on, and neither names membership as the cause.
 *
 * The two live in different repos and cannot share code, so they share a table:
 * `fixtures/member-tier-levels.json` here is a byte-identical copy of
 * `config/member-tier-levels.json` in weld-aus-hubspot, which that repo's
 * `memberPricingParity.test.ts` asserts its own two implementations against. A drift
 * between the repos is therefore a diff between two small JSON files, rather than a
 * customer telling you the price changed.
 *
 * It was written after exactly that drift: a tier of "Member" or "Corporate Member"
 * resolved to `price_individual` on the page and `price_member` here.
 */
import { describe, expect, it } from 'vitest';
import { columnForLevel, type HubDbPriceColumns } from '../src/hubdb-pricing';
import { toCanonicalMemberLevel } from '../src/membership';
import CONTRACT from './fixtures/member-tier-levels.json';

interface ContractEntry {
  label: string;
  level: string;
  note?: string;
}

const LABELS = CONTRACT.labels as ContractEntry[];

/**
 * A fully-mapped portal, so `columnForLevel` returns a distinct name per level and a
 * wrong level shows up as a wrong column rather than as an undefined both sides share.
 */
const COLUMNS: HubDbPriceColumns = {
  gold: 'col_gold',
  silver: 'col_silver',
  bronze: 'col_bronze',
  student: 'col_student',
  individual: 'col_individual',
  member: 'col_member',
  nonMember: 'col_non_member',
};

describe('member tier levels match the CMS contract', () => {
  it.each(
    LABELS.map((entry) => [entry.label || '(empty)', entry.label, entry.level]),
  )('reads %s as the %s level', (_display, label, level) => {
    // An empty label canonicalises to null here (no tier known) where the CMS names
    // it `member`; both then price from the generic member column, which is what the
    // buyer actually sees. Compare the column, which is the shared observable.
    const resolved = toCanonicalMemberLevel(label, undefined);
    expect(columnForLevel(COLUMNS, resolved ?? 'member')).toBe(columnForLevel(COLUMNS, level));
  });

  it('sends a bare "member" label to the generic column, not to individual', () => {
    // The drift itself, kept as its own case so editing the table cannot drop it.
    expect(columnForLevel(COLUMNS, toCanonicalMemberLevel('Member', undefined) ?? '')).toBe(
      'col_member',
    );
    expect(
      columnForLevel(COLUMNS, toCanonicalMemberLevel('Corporate Member', undefined) ?? ''),
    ).toBe('col_member');
    // ...while a label naming a real level still reaches it. Branch order is the reason.
    expect(
      columnForLevel(COLUMNS, toCanonicalMemberLevel('Individual Member', undefined) ?? ''),
    ).toBe('col_individual');
  });

  it('maps an unknown label to the generic member column', () => {
    // toCanonicalMemberLevel returns the label itself for something it does not know,
    // which is not one of the contract's level names. What has to agree with the CMS
    // is the COLUMN that lands on, and columnForLevel defaults it to the member one.
    expect(toCanonicalMemberLevel('Platinum', undefined)).toBe('platinum');
    expect(columnForLevel(COLUMNS, 'platinum')).toBe('col_member');
  });

  it('still honours a tenant value map ahead of the keyword rules', () => {
    // The contract describes the DEFAULT rules. A portal that maps its own labels is
    // unaffected by them, and must stay that way.
    expect(toCanonicalMemberLevel('Tier One', { 'tier one': 'gold' })).toBe('gold');
  });
});
