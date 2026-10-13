const BOOKING_LINE_SEPARATOR = ' — ';

function cleanLineName(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function lineNameKey(value: string): string {
  return value.toLocaleLowerCase();
}

/**
 * HubSpot invoice/deal line items must identify the bookable course/event as well
 * as the commercial ticket/member type. Ticket type names alone are often just
 * "Member" or "Corporate Silver", which makes bulk-registration invoices unclear.
 */
export function formatBookingLineItemName(bookingTitle: unknown, ticketTypeName: unknown): string {
  const title = cleanLineName(bookingTitle);
  const ticketType = cleanLineName(ticketTypeName) || 'Ticket';

  if (!title) return ticketType;

  const titleKey = lineNameKey(title);
  const ticketKey = lineNameKey(ticketType);
  if (
    ticketKey === titleKey ||
    ticketKey.startsWith(`${titleKey}${BOOKING_LINE_SEPARATOR}`) ||
    ticketKey.startsWith(`${titleKey} - `) ||
    ticketKey.startsWith(`${titleKey}: `)
  ) {
    return ticketType;
  }

  return `${title}${BOOKING_LINE_SEPARATOR}${ticketType}`;
}
