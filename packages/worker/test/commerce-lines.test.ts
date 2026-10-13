import { describe, expect, it } from 'vitest';
import { formatBookingLineItemName } from '../src/commerce-lines';

describe('formatBookingLineItemName', () => {
  it('includes the course name and member/ticket type on commerce lines', () => {
    expect(
      formatBookingLineItemName('Welding Supervisor – AS1796 Cert 10', 'Corporate Silver'),
    ).toBe('Welding Supervisor – AS1796 Cert 10 — Corporate Silver');
  });

  it('keeps event names visible for plain ticket labels', () => {
    expect(formatBookingLineItemName('Industry Breakfast', 'General admission')).toBe(
      'Industry Breakfast — General admission',
    );
  });

  it('does not duplicate the booking title on retry/rebuild paths', () => {
    expect(
      formatBookingLineItemName(
        'Welding Supervisor – AS1796 Cert 10',
        'Welding Supervisor – AS1796 Cert 10 — Corporate Silver',
      ),
    ).toBe('Welding Supervisor – AS1796 Cert 10 — Corporate Silver');
  });

  it('falls back to the ticket type when no booking title is available', () => {
    expect(formatBookingLineItemName('', 'Member')).toBe('Member');
  });
});
