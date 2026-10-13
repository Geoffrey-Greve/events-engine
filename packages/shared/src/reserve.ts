/**
 * Reserve request / response contract.
 *
 * This is the wire contract between the HubSpot CMS registration module (which POSTs
 * a {@link ReserveRequest} to `POST /api/v1/events/:slug/reserve`) and the worker
 * (which validates it, runs seat math, and returns a {@link ReserveResponse}).
 * Both sides import these types so the request/response shapes can never drift.
 */

import type { QuestionAnswers } from './questions';

/**
 * Contact details captured alongside a booking (Phase 1.2). All optional — a form that
 * does not ask leaves them absent, which is stored as NULL ("never asked") rather than ''.
 *
 * These are written back to the ATTENDEE's HubSpot contact (never the buyer's — a booker
 * taking a seat for a colleague must not collect their details) through the outbox, into
 * HubSpot's standard `phone` / `city` / `state` properties unless the tenant has mapped
 * them elsewhere, and ONLY where HubSpot currently holds nothing. A differing stored value
 * opens a `contact_conflict` decision instead of being overwritten.
 */
export interface ReserveContactDetails {
  phone?: string;
  /** Free text; maps to whichever HubSpot property the tenant uses for suburb/city. */
  suburb?: string;
  /** Australian state or territory, in whatever form the form collects ('SA', 'South Australia'). */
  state?: string;
}

/** The buyer placing the order (may also be the sole attendee). */
export interface ReserveBuyer extends ReserveContactDetails {
  email: string;
  name: string;
  hubspotContactId?: string;
  /** Captured for company orders (ATO requires identity/ABN on invoices ≥ AUD 1,000). */
  abn?: string;
}

/** One registration per entry. */
export interface ReserveAttendee extends ReserveContactDetails {
  email: string;
  name: string;
  ticketTypeId: string;
  hubspotContactId?: string;
  /**
   * Answers to the event's attendee-scoped custom questions (Phase 2.3), keyed by question
   * `key`. Per attendee, because that is the scope: four seats on one booking carry four
   * dietary answers.
   *
   * The worker validates these against the event's own question set — `required` is
   * enforced there, never only in the form, and an unknown key is rejected rather than
   * silently stored.
   */
  answers?: QuestionAnswers;
  /**
   * This seat is sold and held but nobody is on it yet (Ref 74b, migration 0039).
   *
   * Set by expanding {@link ReserveRequest.unnamedSeats}; a caller does not send it
   * directly. `email` and `name` are '' on such an entry and nothing person-shaped runs
   * for it — no Marketing Event registration, no webinar registration, no ticket, no
   * contact write-back — until a name arrives through an ordinary amend.
   */
  unnamed?: boolean;
}

export interface ReserveRequest {
  buyer: ReserveBuyer;
  /** One registration per entry. If absent, buyer becomes the sole attendee. */
  attendees?: ReserveAttendee[];
  /**
   * Seats to hold and invoice with no attendee on them yet — a company block (Ref 74b).
   *
   * There is no separate block state: these price, hold and invoice exactly as a named
   * seat does, so the booking drops public availability the moment it is placed and the
   * company is invoiced for it now. What is deferred is only the person: each seat becomes
   * an ordinary registration carrying `unnamed`, and a name attaches at any time through
   * `PATCH /manage/events/:id/registrations/:regId`. Partial naming is therefore free —
   * five of ten now and five later is five amendments, not a special case.
   *
   * Combinable with `attendees`: "book Sam and hold four more" is one booking.
   */
  unnamedSeats?: Array<{ ticketTypeId: string; quantity: number }>;
  /** Used only when attendees is absent — the ticket type the buyer wants. */
  ticketTypeId?: string;
  /**
   * Selected child modules for one parent-course checkout. Each entry is one
   * module seat for the buyer. The worker still validates parent/child
   * membership, capacity, and price server-side.
   */
  selectedModules?: Array<{
    eventId: string;
    ticketTypeId: string;
    expectedUnitCents?: number;
  }>;
  /** Client-displayed total for selected-module checkout, in cents. Advisory only. */
  expectedTotalCents?: number;
  /** Signed waitlist offer token — present when claiming a next-in-line offer. */
  offerToken?: string;
  /**
   * Client's view of the buyer's membership tier and expected per-seat price (cents).
   * Advisory only — the worker independently resolves membership + tiered pricing
   * server-side (see resolveMembership / resolvePrice) and never trusts these to set the
   * charged amount. Sent by the CMS checkout so the worker can log price drift between
   * the displayed and charged price.
   */
  memberTier?: string;
  expectedUnitCents?: number;
  /**
   * The per-seat price the page displayed, in cents, when it is NOT asking for the
   * guard to be enforced. Logged and compared, never able to refuse a booking.
   *
   * Why it exists: `expectedUnitCents` is sent only for a buyer the CMS believes is a
   * member, so a GUEST had no price guard at all — the page could display one amount
   * and the invoice carry another with nothing to notice it. Turning the enforcing
   * guard on for guests in one step could start refusing bookings that work today,
   * for a disagreement nobody has measured. So guests send this instead: it produces
   * the same `price_drift` log with `enforced: false`, and once those logs are clean
   * the CMS moves guests onto `expectedUnitCents` and the guard becomes real.
   *
   * Ignored when `expectedUnitCents` is present, which is the enforcing field.
   */
  quotedUnitCents?: number;
  /**
   * HubSpot Company ID entered at guest checkout to unlock member pricing
   * (matches the Find a Member directory's `hubspot_company_id`). The worker
   * re-validates this server-side against CRM company membership and/or the
   * HubDB members directory before applying tiered pricing — never trust the
   * client-displayed amount alone.
   */
  memberCompanyId?: string;
  /**
   * Draw on `memberCompanyId`'s prepaid training vouchers to cover seats in this booking.
   *
   * Opt-in, because `memberCompanyId` is also sent purely to unlock member pricing: an
   * employee's own checkout must not quietly spend their company's balance. Corporate bulk
   * register sets it; public CMS checkout does not. The worker resolves the available
   * balance server-side and never trusts a client-supplied voucher count.
   */
  redeemVouchers?: boolean;
  /**
   * Answers to the event's ORDER-scoped custom questions (Phase 2.3), keyed by question
   * `key` — asked once for the whole booking (a purchase order number, who to invoice),
   * not once per seat. Attendee-scoped answers travel on each {@link ReserveAttendee}.
   */
  answers?: QuestionAnswers;
  /**
   * Attendee-scoped answers for the SINGLE-SEAT shorthand — the `ticketTypeId` form where
   * `attendees` is absent and the buyer takes the seat themselves.
   *
   * Without it that shorthand cannot answer an attendee-scoped question at all: the worker
   * synthesises the attendee from the buyer, and a synthesised attendee carries no answers.
   * A tenant marking dietary requirements `required` would therefore make every public
   * one-seat booking fail `missing_required_answer` with nothing the form could send to fix
   * it — the manage and corporate paths escape it only because they build an explicit
   * `attendees` array.
   *
   * Kept separate from `answers` rather than merged into it because the two scopes are
   * validated against different question sets and a key in the wrong one is rejected by
   * name. One field carrying both would have to guess, and guessing wrong on a required
   * answer is a booking nobody can complete.
   *
   * IGNORED when `attendees` is supplied: there, each seat carries its own.
   */
  attendeeAnswers?: QuestionAnswers;
  /** Cloudflare Turnstile token. Required for EVERY public registration, paid or free,
   *  when a Turnstile secret is configured for the portal. */
  turnstileToken?: string;
}

/**
 * A priced order line, one per distinct ticket type. Money is in integer cents, AUD.
 * Carried through to the deal/invoice write-back payloads.
 */
export interface ReserveLineItem {
  ticketTypeId: string;
  name: string;
  quantity: number;
  unitCents: number;
  totalCents: number;
  taxTreatment: string;
  hsTaxRateId: string | null;
  hsProductId: string | null;
}

/** Paid event: a hold was granted; poll `pollUrl` for the payment link + status. */
export interface ReservedResponse {
  status: 'reserved';
  orderId: string;
  registrationIds: string[];
  pollUrl: string;
}

/** Free event: confirmed immediately, tickets issued. */
export interface ConfirmedResponse {
  status: 'confirmed';
  orderId: string;
  registrationIds: string[];
  ticketIds: string[];
}

/** Capacity full: the buyer was placed on the waitlist. */
export interface WaitlistedResponse {
  status: 'waitlisted';
  waitlistId: string;
}

/** Validation / gate / capacity failure (e.g. members_only, offer_expired). */
export interface ReserveErrorResponse {
  status: string;
  message: string;
}

export type ReserveResponse =
  | ReservedResponse
  | ConfirmedResponse
  | WaitlistedResponse
  | ReserveErrorResponse;
