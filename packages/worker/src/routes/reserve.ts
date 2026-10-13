// The reserve request/response wire contract lives in @paddock/shared (single source of
// truth shared with the CMS registration module). Aliased to the local names used below.
import type {
  ReserveAttendee as Attendee,
  ReserveLineItem as LineItem,
  ReserveRequest as ReserveBody,
} from '@paddock/shared';
import { isGstFreeTreatment } from '@paddock/shared';
import type { Context } from 'hono';
import { type AttendeeContactValues, normaliseContactDetails } from '../attendee-contact';
import { maybeFlagFastSellout } from '../capacity-guard';
import { syncCapacityFromD1 } from '../capacity-sync';
import { mintTicketForTenant } from '../checkin';
import { formatBookingLineItemName } from '../commerce-lines';
import {
  courseBundleHoldStatements,
  courseModuleSelectionHoldStatements,
  holdCourseBundle,
  holdCourseModuleSelection,
  type LiveCourseBundleHold,
  loadCourseBundleConfiguration,
  releaseCourseBundleHolds,
} from '../course-bundle';
import type { EventRow, TicketTypeRow } from '../db';
import { loadCourseComponents, loadEvent, loadTicketTypes } from '../db';
import { syncCapacityBeforeHold, trySyncEventCapacityFromHubDb } from '../hubdb-capacity';
import { type InvoiceEligibility, resolveInvoiceEligibility } from '../invoice-eligibility';
import { resolveMembership } from '../membership';
import { checkRateLimit } from '../middleware/rate-limit';
import { type PreparedStaffNote, prepareStaffNote, staffNoteStatements } from '../notes';
import { loadPublishedPrices, reconcileMemberQuote, resolvePrice } from '../pricing';
import {
  answerStatements,
  answersToSync,
  loadEventQuestions,
  type PreparedAnswer,
  QuestionValidationError,
  validateAnswers,
} from '../questions';
import { registrationConfirmationStatement } from '../registration-confirmation';
import { loadDisplayTimeZone } from '../reporting';
import { resolveSalesWindow, salesWindowRejection, ticketTypePaused } from '../sales-window';
import { cancelAttendeeInTeams, provisionWebinarIfNeeded, registerAttendeeInTeams } from '../teams';
import { localCalendarDate } from '../timezone';
import {
  getTurnstileAllowedHostnames,
  getTurnstileSecret,
  isPublicImportTicket,
  shouldRequireTurnstile,
  verifyTurnstileToken,
} from '../turnstile';
import type { Env } from '../types';
import {
  NO_REDEMPTION,
  planVoucherRedemption,
  resolveVoucherBalance,
  type VoucherMode,
  voucherUsageSyncStatement,
} from '../vouchers';
import { claimWaitlistOffer, joinWaitlist, markOfferPromoted, type OfferClaim } from '../waitlist';

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class ReserveError extends Error {
  constructor(
    public readonly status: string,
    message: string,
    public readonly httpStatus: number = 403,
  ) {
    super(message);
    this.name = 'ReserveError';
  }
}

/** Where the buyer email is parked between parsing the body and answering a refusal. */
const BUYER_EMAIL_CONTEXT_KEY = 'reserveBuyerEmail';

function rememberBuyerEmail(c: Context<{ Bindings: Env }>, body: { buyer?: { email?: string } }) {
  const email = body?.buyer?.email?.trim();
  if (email)
    (c as unknown as { set: (k: string, v: string) => void }).set(BUYER_EMAIL_CONTEXT_KEY, email);
}

function recalledBuyerEmail(c: Context<{ Bindings: Env }>): string | null {
  try {
    const value = (c as unknown as { get: (k: string) => unknown }).get(BUYER_EMAIL_CONTEXT_KEY);
    return typeof value === 'string' && value ? value : null;
  } catch {
    return null;
  }
}

/**
 * Answer a refused reserve, and say so in the log.
 *
 * Every `ReserveError` reached the buyer and was recorded NOWHERE. "We couldn't verify
 * your membership", "the course price changed before checkout", "this attendee email is
 * already registered" — the three most-reported defects on the QA sheet — all left the
 * Worker without a line to search for, so each one had to be re-derived from the
 * customer's description. The one exception was `price_drift`, which logs before it
 * decides, and is the only reason that failure was ever traceable.
 *
 * Buyer email IS logged, matching `price_drift`: a refusal is reported by a named
 * person on a support ticket and the address is how you find their attempt. Answers
 * and attendee details are NOT, for the reason the queue logger gives.
 */
export function refuseReserve(
  c: Context<{ Bindings: Env }>,
  err: ReserveError,
  context: { portalId: string; eventId?: string; buyerEmail?: string; source?: string },
): Response {
  console.log(
    JSON.stringify({
      level: 'warn',
      event: 'reserve_refused',
      status: err.status,
      httpStatus: err.httpStatus,
      portalId: context.portalId,
      eventId: context.eventId ?? null,
      buyerEmail: context.buyerEmail ?? null,
      source: context.source ?? 'public',
      message: err.message,
    }),
  );
  return c.json(
    { status: err.status, message: err.message },
    err.httpStatus as 400 | 403 | 404 | 409 | 500,
  );
}

const ACTIVE_REGISTRATION_ORDER_STATUSES = ['confirmed', 'paid', 'pending'];

/**
 * Paid bookings hold their seat until the HubSpot invoice due date rather than the
 * EventCapacity 15-minute TTL. Public buyers routinely register and then pay by bank
 * transfer or a later card payment, and the short hold was voiding valid invoices
 * minutes after booking (AWS D1.1). Applies to every paid source (public checkout,
 * corporate portal and staff manual), so one payment window governs all of them.
 *
 * Terms resolve most-specific-first:
 *   staff-supplied date > events.invoice_due_days > tenants.invoice_due_days > default.
 *
 * Free bookings never reach this: they confirm immediately and hold no seat.
 */
export const DEFAULT_INVOICE_DUE_DAYS = 30;
export const MAX_INVOICE_DUE_DAYS = 90;
/**
 * Seats one request may hold without names (Ref 74b). A bound rather than a policy: the
 * DO still refuses to oversell, so this only stops a typo'd quantity taking an event off
 * sale and raising an invoice for it before anyone notices.
 */
export const MAX_UNNAMED_SEATS = 200;

export interface InvoiceDueWindow {
  /** Date-only (YYYY-MM-DD), written to the HubSpot invoice as hs_due_date. */
  date: string;
  /** End of the due date in UTC: the reservation/DO hold expiry. */
  expiresAt: string;
}

function dateOnly(daysFromNow: number): string {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() + daysFromNow);
  return value.toISOString().slice(0, 10);
}

/**
 * Whole days from today to `date` (YYYY-MM-DD), floored at zero.
 *
 * `orders.payment_terms_days` is derived from the resolved due DATE rather than from
 * whichever config supplied it, so the recorded terms can never disagree with the invoice
 * the buyer received, including when staff typed a date instead of a number of days.
 * Both ends are UTC calendar dates, so this is a day count and not a duration.
 */
function daysUntilDate(date: string): number {
  const target = Date.parse(`${date}T00:00:00.000Z`);
  const today = Date.parse(`${dateOnly(0)}T00:00:00.000Z`);
  if (!Number.isFinite(target)) return 0;
  return Math.max(0, Math.round((target - today) / (24 * 60 * 60 * 1000)));
}

/**
 * Normalises a configured payment-terms value to whole days within the supported
 * range. Returns null for anything unusable so the caller falls through to the next,
 * less specific source rather than failing the booking.
 */
export function clampInvoiceDueDays(value: unknown): number | null {
  const raw =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(raw)) return null;
  const days = Math.trunc(raw);
  if (days < 1) return null;
  return Math.min(days, MAX_INVOICE_DUE_DAYS);
}

/**
 * Resolves the invoice due date for a paid booking. `value` is the explicit date a
 * staff booking supplies (public checkout passes nothing and gets `defaultDays`).
 */
export function resolveInvoiceDueDate(value: unknown, defaultDays: number): InvoiceDueWindow {
  const hasValue = value !== null && value !== undefined && value !== '';
  if (hasValue && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))) {
    throw new ReserveError('invalid_invoice_due_date', 'Invoice due date must use YYYY-MM-DD', 400);
  }
  const days = clampInvoiceDueDays(defaultDays) ?? DEFAULT_INVOICE_DUE_DAYS;
  const date = hasValue ? (value as string) : dateOnly(days);
  const expiresAt = Date.parse(`${date}T23:59:59.999Z`);
  const now = Date.now();
  // Calendar-date comparison, not now + 90×24h: the hold runs to the END of the due date,
  // so an instant-based cap would reject the configured maximum for all but the last
  // millisecond of a UTC day. ISO date strings sort chronologically.
  const latestDate = dateOnly(MAX_INVOICE_DUE_DAYS);

  if (
    !Number.isFinite(expiresAt) ||
    new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date ||
    expiresAt <= now
  ) {
    throw new ReserveError(
      'invalid_invoice_due_date',
      'Invoice due date must be in the future',
      400,
    );
  }
  if (date > latestDate) {
    throw new ReserveError(
      'invalid_invoice_due_date',
      `Invoice due date must be within ${MAX_INVOICE_DUE_DAYS} days`,
      400,
    );
  }
  return { date, expiresAt: new Date(expiresAt).toISOString() };
}

/**
 * The invoice due date never lands after the session starts.
 *
 * `invoice_due_days` is a day COUNT from the booking, so it cannot express "hold the seat
 * until the course". A flat 30 on a course ten weeks out frees the seat six weeks early;
 * the same 30 on a booking taken the day before the course leaves an invoice falling due a
 * month after it ran. And a per-event day count is worse, not better: it is correct on the
 * day someone types it and stale every day after.
 *
 * So it is a CAP rather than config. The hold runs to the due date, and holding a seat past
 * the moment the course begins is meaningless whatever anyone configured, so the resolved
 * date is pulled back to the session's own start date whenever that is sooner. Nothing to
 * enter per event, and it cannot go stale.
 *
 * The event's start is read as a LOCAL calendar date in the tenant's timezone, never
 * `iso.slice(0, 10)`: a 9am Adelaide start is 23:30 UTC the day before, and a due date a
 * day early would free the seat the afternoon before the course.
 *
 * Two things it deliberately does not do. It never moves a date into the PAST — a session
 * that has already begun is refused by the registration cutoff (migration 0038), not by a
 * due-date error on a booking staff may be making deliberately — and it never overrides a
 * date staff typed by hand, which is a human decision about this one booking and outranks
 * a rule, exactly as it does everywhere else terms resolve.
 */
export function capDueDateToEventStart(
  dueDate: string,
  eventStartsAt: string | null | undefined,
  timeZone: string,
): string {
  if (!eventStartsAt) return dueDate;
  let startDate: string;
  try {
    startDate = localCalendarDate(eventStartsAt, timeZone);
  } catch {
    return dueDate;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return dueDate;
  if (startDate < dateOnly(0)) return dueDate;
  return startDate < dueDate ? startDate : dueDate;
}

/**
 * Portal-level payment terms. Optional config, so it must degrade rather than throw:
 * a D1 provisioned before migration 0015 has no invoice_due_days column, and reading
 * config never fails a booking (Ref 217 schema drift).
 */
async function loadPortalInvoiceDueDays(env: Env, portalId: string): Promise<number | null> {
  try {
    const row = await env.DB.prepare('SELECT invoice_due_days FROM tenants WHERE portal_id = ?1')
      .bind(portalId)
      .first<{ invoice_due_days: number | null }>();
    return clampInvoiceDueDays(row?.invoice_due_days);
  } catch {
    return null;
  }
}

/**
 * A DO hold that has been granted but is not yet durable in D1.
 *
 * A paid hold now runs to the invoice due date (up to 90 days), so a throw between
 * granting it and committing the reservation batch would strand those seats for weeks
 * with no order to pay for them, which is where the old 15-minute TTL used to self-heal. The
 * reserve callers release an uncommitted hold on any failure.
 */
interface HoldGuard {
  stub: DurableObjectStub | null;
  holdId: string | null;
  bundleHolds: LiveCourseBundleHold[];
  /**
   * Provider registrations already made for this attempt. Webinar registration happens
   * before the D1 batch that decides whether the booking exists at all. It has to, since
   * the registration row stores the ids it returns, so a batch that fails leaves a live
   * registration on the provider for a booking that does not exist. A seat has its own
   * expiry as a backstop; a provider registration has none, and the attendee would hold a
   * join URL for a booking nobody sold them.
   */
  providerRegistrations: Array<{
    providerName: string | null;
    webinarId: string;
    providerRegistrationId: string;
  }>;
  committed: boolean;
}

function newHoldGuard(): HoldGuard {
  return {
    stub: null,
    holdId: null,
    bundleHolds: [],
    providerRegistrations: [],
    committed: false,
  };
}

async function releaseUncommittedHold(env: Env, portalId: string, guard: HoldGuard): Promise<void> {
  if (guard.committed) return;
  if (guard.stub && guard.holdId) {
    try {
      await guard.stub.fetch('https://do/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ holdId: guard.holdId }),
      });
    } catch {
      // Best-effort: the hold's own expiry remains the backstop.
    }
  }
  await releaseCourseBundleHolds(guard.bundleHolds);
  for (const registration of guard.providerRegistrations) {
    // Best-effort, like every other undo here: cancelAttendeeInTeams is already
    // non-throwing and already a no-op for a provider that cannot cancel.
    await cancelAttendeeInTeams(
      env,
      portalId,
      registration.providerName,
      registration.webinarId,
      registration.providerRegistrationId,
    );
  }
}

export interface ReserveEventInput {
  eventId: string;
  body: ReserveBody;
  idempotencyKey: string;
  options?: ReserveOptions;
  /** Use the parent course price and reserve every required child module. */
  coursePackage?: boolean;
}

export interface ReserveOptions {
  /**
   * Admin/staff-only override used by protected manage routes for complimentary
   * seats. Public checkout calls do not pass this option, so public users cannot
   * turn a paid ticket into a free one through the ReserveRequest body.
   */
  forceFree?: boolean;
  source?: 'public_checkout' | 'staff_manual' | 'corporate_bulk';
  /**
   * Date-only HubSpot invoice due date chosen by staff for a paid manual booking.
   * Public and corporate checkout never set it; those resolve the date from the
   * event/portal payment terms instead.
   */
  invoiceDueDate?: string | null;
  staffActor?: string | null;
  staffNote?: string | null;
}

// ---------------------------------------------------------------------------
// POST /api/v1/events/:slug/reserve
// ---------------------------------------------------------------------------

/**
 * Outer handler: enforces Idempotency-Key, replays stored responses, and maps
 * ReserveError → clean 403 JSON. All business logic lives in doReserve().
 */
export async function handleReserve(c: Context<{ Bindings: Env }>): Promise<Response> {
  const limited = await checkRateLimit(c, { prefix: 'rl:reserve', limit: 20, windowSeconds: 60 });
  if (limited) return limited;

  const idempotencyKey = c.req.header('Idempotency-Key');
  if (!idempotencyKey) {
    return c.json(
      { status: 'missing_idempotency_key', message: 'Idempotency-Key header required' },
      400,
    );
  }

  const portalId = c.req.header('X-Portal-Id');
  if (!portalId) {
    return c.json({ status: 'missing_portal_id', message: 'X-Portal-Id header required' }, 400);
  }

  // Replay protection: return the stored response verbatim.
  const replay = await c.env.DB.prepare(
    'SELECT response_status, response_body FROM idempotency_keys WHERE portal_id = ?1 AND key = ?2',
  )
    .bind(portalId, idempotencyKey)
    .first<{ response_status: number; response_body: string }>();
  if (replay) {
    return new Response(replay.response_body, {
      status: replay.response_status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const guard = newHoldGuard();
  try {
    return await doReserve(c, { portalId, idempotencyKey, guard, coursePackage: false });
  } catch (err) {
    await releaseUncommittedHold(c.env, portalId, guard);
    if (err instanceof ReserveError) {
      return refuseReserve(c, err, {
        portalId,
        eventId: c.req.param('slug'),
        buyerEmail: recalledBuyerEmail(c) ?? undefined,
      });
    }
    throw err;
  }
}

export async function reserveEventWithBody(
  c: Context<{ Bindings: Env }>,
  portalId: string,
  input: ReserveEventInput,
): Promise<Response> {
  const replay = await c.env.DB.prepare(
    'SELECT response_status, response_body FROM idempotency_keys WHERE portal_id = ?1 AND key = ?2',
  )
    .bind(portalId, input.idempotencyKey)
    .first<{ response_status: number; response_body: string }>();
  if (replay) {
    return new Response(replay.response_body, {
      status: replay.response_status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const guard = newHoldGuard();
  try {
    return await doReserve(c, {
      portalId,
      idempotencyKey: input.idempotencyKey,
      eventId: input.eventId,
      parsedBody: input.body,
      options: input.options,
      guard,
      coursePackage: input.coursePackage ?? false,
    });
  } catch (err) {
    await releaseUncommittedHold(c.env, portalId, guard);
    if (err instanceof ReserveError) {
      return refuseReserve(c, err, {
        portalId,
        eventId: c.req.param('slug'),
        buyerEmail: recalledBuyerEmail(c) ?? undefined,
      });
    }
    throw err;
  }
}

interface DoReserveParams {
  portalId: string;
  idempotencyKey: string;
  eventId?: string;
  parsedBody?: ReserveBody;
  options?: ReserveOptions;
  /** Reserve every required child module using the parent course price. */
  coursePackage?: boolean;
  /** Set when the hold is granted, so the caller can release it if this throws. */
  guard: HoldGuard;
}

async function doReserve(
  c: Context<{ Bindings: Env }>,
  params: DoReserveParams,
): Promise<Response> {
  const {
    portalId,
    idempotencyKey,
    eventId,
    parsedBody,
    options,
    guard,
    coursePackage = false,
  } = params;
  const env = c.env;
  // :slug = internal event id (events.id, e.g. "evt_dev_001")
  const slug = eventId ?? (c.req.param('slug') as string);

  // ---- 1. Load event -------------------------------------------------------
  const event = await loadEvent(env.DB, portalId, slug);
  if (!event) throw new ReserveError('event_not_found', 'Event not found', 404);
  const coursePackageComponents = coursePackage
    ? await loadCourseBundleConfiguration({ env, portalId, parentEventId: event.id })
    : null;
  if (coursePackage) {
    if (event.parent_event_id !== null || event.booking_kind !== 'course') {
      throw new ReserveError(
        'not_a_parent_course',
        'Complete-course booking is only available on a parent course.',
        400,
      );
    }
    if (!coursePackageComponents) {
      throw new ReserveError(
        'course_package_not_configured',
        'This course package is not configured for checkout yet.',
        409,
      );
    }
  }
  const source = options?.source ?? 'public_checkout';
  const isPublicCheckout = source === 'public_checkout';

  // ---- 1b. Sales window (migration 0038) -----------------------------------
  // Before anything else that costs: a closed or paused event must not reach the DO, and
  // must not reach the waitlist either: an event nobody can book is not one to queue for.
  //
  // STAFF ARE EXEMPT, and only staff. `staff_manual` is a human in the HubSpot app card
  // booking a walk-in or a phone call after the cutoff, which is the ordinary reason a
  // cutoff has an exception; the request is already admin-authed and already audited.
  // `corporate_bulk` is NOT exempt: that is a customer in the member portal serving
  // themselves, and a self-service path that ignores the cutoff is the cutoff not existing.
  if (source !== 'staff_manual') {
    const rejection = salesWindowRejection(resolveSalesWindow(event));
    if (rejection) throw new ReserveError(rejection.status, rejection.message, 409);
  }

  // ---- 2. Parse and validate request body ----------------------------------
  let body: ReserveBody;
  if (parsedBody) {
    body = parsedBody;
  } else {
    try {
      body = await c.req.json<ReserveBody>();
      // Stashed so the refusal log at the route boundary can name WHO was turned away.
      // The body is parsed here, inside the try, and the catch that answers the buyer
      // is two frames up with no access to it.
      rememberBuyerEmail(c, body);
    } catch {
      throw new ReserveError('invalid_body', 'Request body must be valid JSON', 400);
    }
  }

  if (!body.buyer?.email || !body.buyer?.name) {
    throw new ReserveError('invalid_buyer', 'buyer.email and buyer.name are required', 400);
  }
  body.buyer.email = body.buyer.email.trim();
  body.buyer.name = body.buyer.name.trim();

  // Normalise: if attendees omitted, buyer takes the single seat.
  let attendees: Attendee[] = body.attendees ?? [];
  const hasUnnamedSeats = (body.unnamedSeats?.length ?? 0) > 0;
  // A company block supplies seats rather than people (Ref 74b), so it legitimately has no
  // attendees and no single ticketTypeId; §2a below expands it. Without this the buyer
  // would be given a seat they did not ask for, or the request rejected outright.
  if (attendees.length === 0 && !hasUnnamedSeats) {
    if (!body.ticketTypeId) {
      throw new ReserveError('no_attendees', 'attendees or ticketTypeId is required', 400);
    }
    attendees = [
      {
        email: body.buyer.email,
        name: body.buyer.name,
        ticketTypeId: body.ticketTypeId,
        hubspotContactId: body.buyer.hubspotContactId,
        // The buyer IS the attendee here, so their contact details are the attendee's.
        phone: body.buyer.phone,
        suburb: body.buyer.suburb,
        state: body.buyer.state,
        // ...and so are their answers. Without this the single-seat shorthand could not
        // answer an attendee-scoped question at all, so a tenant marking one `required`
        // would break every public one-seat booking with nothing the form could send to
        // fix it. `body.answers` is the ORDER scope and is validated against a different
        // question set, so it cannot stand in (see ReserveRequest.attendeeAnswers).
        answers: body.attendeeAnswers,
      },
    ];
  }
  attendees = normaliseAttendees(attendees);

  // ---- 2a. Company seat block (Ref 74b, migration 0039) ---------------------
  // Expanded into ordinary attendee entries here, at the top, so everything downstream
  // (pricing, the DO, the seat-price decomposition, the invoice lines) treats a block as
  // what it is: a paid booking that happens to have nobody on it yet. Only the handful of
  // person-shaped steps check `unnamed`, rather than every step having to know about a
  // parallel concept.
  if (body.unnamedSeats && body.unnamedSeats.length > 0) {
    if (source === 'public_checkout') {
      throw new ReserveError(
        'unnamed_seats_not_public',
        'Seats can only be held without attendee names by staff or a corporate administrator.',
        403,
      );
    }
    for (const block of body.unnamedSeats) {
      const quantity = Number(block?.quantity);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_UNNAMED_SEATS) {
        throw new ReserveError(
          'invalid_unnamed_seats',
          `quantity must be a whole number between 1 and ${MAX_UNNAMED_SEATS}`,
          400,
        );
      }
      if (!block.ticketTypeId) {
        throw new ReserveError(
          'invalid_unnamed_seats',
          'ticketTypeId is required for every block of unnamed seats',
          400,
        );
      }
      for (let n = 0; n < quantity; n++) {
        attendees.push({ email: '', name: '', ticketTypeId: block.ticketTypeId, unnamed: true });
      }
    }
  }
  if (attendees.length === 0) {
    throw new ReserveError('no_attendees', 'attendees or ticketTypeId is required', 400);
  }

  // ---- 2b. Waitlist offer claim (optional) ---------------------------------
  // If the buyer is reserving against a next-in-line offer, validate the signed token +
  // window now. A valid claim suppresses re-waitlisting below and is marked 'promoted'
  // inside the reservation batch once a hold is actually granted.
  let offerClaim: OfferClaim | null = null;
  if (body.offerToken) {
    const result = await claimWaitlistOffer(env, {
      portalId,
      eventId: event.id,
      token: body.offerToken,
    });
    if (!result.ok) {
      const message =
        result.error === 'offer_expired'
          ? 'This waitlist offer has expired'
          : result.error === 'offer_not_open'
            ? 'This waitlist offer is no longer open'
            : 'Invalid waitlist offer';
      throw new ReserveError(result.error, message, 409);
    }
    offerClaim = result.claim;
  }

  // ---- 2c. Custom registration questions (Phase 2.3) -----------------------
  // Validated HERE: before membership, before pricing, before the DO is asked for a seat.
  // A booking that is going to be rejected for a missing dietary answer must not first
  // take a hold: a paid hold now runs to the invoice due date, so a seat stranded by a
  // validation failure would be out of sale for weeks.
  //
  // Server-side is the whole point (the brief is explicit): the CMS form is a module a
  // marketer can edit, and the staff and corporate booking paths never render it at all.
  const questions = await loadEventQuestions(env, portalId, event.id);
  let orderAnswers: PreparedAnswer[] = [];
  let attendeeAnswers: PreparedAnswer[][] = attendees.map(() => []);
  if (questions.length > 0) {
    try {
      orderAnswers = validateAnswers({ questions, scope: 'order', supplied: body.answers });
      attendeeAnswers = attendees.map((attendee) =>
        // A seat with nobody on it cannot answer a question about the person on it, so a
        // required question is NOT enforced here for an unnamed seat (Ref 74b): enforcing
        // it would make a company block impossible on any event that asks one, which is
        // the opposite of what marking a question required is for. The gap is reported
        // instead: `unnamedSeats` on the 2.2 summary is the seats still to be chased, in
        // the same place every other "the two systems disagree" gap is named.
        attendee.unnamed
          ? []
          : validateAnswers({
              questions,
              scope: 'attendee',
              supplied: attendee.answers,
              // Named, so a bulk booking says which of eight attendees is missing an answer.
              subject: attendee.name || attendee.email || null,
            }),
      );
    } catch (err) {
      if (err instanceof QuestionValidationError) {
        throw new ReserveError(err.status, err.message, 400);
      }
      throw err;
    }
  }

  // ---- 3. Load ticket types ------------------------------------------------
  const ticketTypes = await loadTicketTypes(env.DB, event.id);
  if (ticketTypes.length === 0) {
    throw new ReserveError('no_ticket_types', 'Event has no ticket types configured', 404);
  }
  const ttMap = new Map<string, TicketTypeRow>(ticketTypes.map((tt) => [tt.id, tt]));

  // ---- 4. Membership gate (FIRST, before any seat math) --------------------
  // resolveMembership now returns { isMember, verified, level, category }. The hard
  // gates below only depend on verified + isMember; level/category drive pricing in §5.
  // Guest checkout may also send memberCompanyId (unlocked via Find a Member directory);
  // the worker re-validates that company and merges it into membership so the invoice
  // amount matches the member price shown in checkout.
  const membership = await resolveMembership(env, portalId, body.buyer.email, {
    memberCompanyId: body.memberCompanyId,
  });

  // Corporate bookings draw seats from the company's prepaid training vouchers. Persisted on
  // the order below so consumption can be recomputed from order state (see ./vouchers.ts).
  const voucherCompanyId = body.memberCompanyId?.trim() || null;

  // Event-level gate: if every ticket type is member_only, the event itself is members-only.
  const allMemberOnly = ticketTypes.every((tt) => tt.member_only);
  if (allMemberOnly) {
    if (!membership.verified) {
      throw new ReserveError(
        'membership_unverified',
        'Membership status could not be verified. Please contact support',
      );
    }
    if (!membership.isMember) {
      throw new ReserveError('members_only', 'This event is for members only');
    }
  }

  // Per-ticket-type gate.
  for (const attendee of attendees) {
    const tt = ttMap.get(attendee.ticketTypeId);
    if (!tt) {
      throw new ReserveError(
        'invalid_ticket_type',
        `Unknown ticket type: ${attendee.ticketTypeId}`,
        400,
      );
    }
    if (isPublicCheckout && (tt.internal_only || isPublicImportTicket(tt.id, tt.name))) {
      throw new ReserveError(
        'ticket_not_available',
        'This ticket type is not available for public registration.',
        403,
      );
    }
    // A single type taken off sale (migration 0038), "early bird is over", while the
    // event itself keeps selling its other types. Staff-exempt on the same grounds as the
    // event-level window above.
    if (source !== 'staff_manual' && ticketTypePaused(tt)) {
      throw new ReserveError(
        'ticket_sales_paused',
        `Bookings for "${tt.name}" are temporarily on hold.`,
        409,
      );
    }
    if (tt.member_only) {
      if (!membership.verified) {
        throw new ReserveError(
          'membership_unverified',
          'Membership status could not be verified. Please contact support',
        );
      }
      if (!membership.isMember) {
        throw new ReserveError('members_only', `Ticket type "${tt.name}" is for members only`);
      }
    }
  }

  // ---- 4b. Duplicate attendee gate -----------------------------------------
  // One attendee email may only hold one active registration for a given event.
  // This still allows one buyer to book multiple people, as long as each attendee
  // has their own email. Cancelled/refunded orders do not block a fresh booking.
  // Gold members (canonical level) may book the same email more than once.
  await assertNoDuplicateAttendeeEmails(env, portalId, event.id, attendees, {
    allowDuplicateAttendees: membership.isMember && membership.level === 'gold',
  });

  // ---- 5. Price line items -------------------------------------------------
  // Member pricing is tiered by the buyer's canonical level + category (cloned from the
  // company). All attendees in one reserve share the buyer's membership tier, so resolve
  // each ticket type's price once and cache it. Non-members pay standard (resolvePrice
  // enforces that); the hard member-only gates above already rejected them.
  // Price every seat individually first. Vouchers cover whole seats, and a booking can be
  // only partly covered, so the per-seat prices have to exist before lines are aggregated.
  const priceByType = new Map<string, number>();
  const seats: Array<{ index: number; ticketType: TicketTypeRow; unitCents: number }> = [];
  // A verified member whose quote we would otherwise refuse is reconciled against the
  // prices their own session row publishes (see `reconcileMemberQuote`). Read once, and
  // only when it could apply: one ticket type across the booking, so a single per-unit
  // quote means one thing; a verified member, so a membership disagreement is never
  // resolved as a price; and an ENFORCING quote, since `quotedUnitCents` refuses nothing
  // and has nothing to be rescued from.
  const quotedUnitCents = body.expectedUnitCents;
  const singleTicketType = new Set(attendees.map((a) => a.ticketTypeId)).size === 1;
  const mayReconcileQuote =
    !options?.forceFree &&
    singleTicketType &&
    membership.isMember &&
    membership.verified &&
    typeof quotedUnitCents === 'number';
  for (const [index, attendee] of attendees.entries()) {
    const tt = ttMap.get(attendee.ticketTypeId);
    if (!tt) {
      // Validated in §4; defensive re-check keeps the map lookup typed without `!`.
      throw new ReserveError(
        'invalid_ticket_type',
        `Unknown ticket type: ${attendee.ticketTypeId}`,
        400,
      );
    }
    let unitCents = priceByType.get(tt.id);
    if (unitCents === undefined) {
      const resolvedCents = await resolvePrice(env, {
        portalId,
        eventId: event.id,
        hubspotEventId: event.hubspot_event_id,
        ticketType: tt,
        isMember: membership.isMember,
        level: membership.level,
        category: membership.category,
      });
      unitCents = resolvedCents;
      if (mayReconcileQuote && resolvedCents > (quotedUnitCents as number)) {
        const reconciliation = reconcileMemberQuote({
          resolvedCents,
          quotedCents: quotedUnitCents,
          publishedCents: await loadPublishedPrices(
            env,
            portalId,
            event.id,
            event.hubspot_event_id,
          ),
        });
        if (reconciliation.reconciled) {
          unitCents = reconciliation.chargeCents;
          // The booking is saved; the disagreement is not resolved. This is the line that
          // names the tier mapping to fix, in place of a customer describing an error.
          console.log(
            JSON.stringify({
              level: 'warn',
              event: 'member_quote_reconciled',
              portalId,
              eventId: event.id,
              ticketTypeId: tt.id,
              buyerEmail: body.buyer.email,
              quotedUnitCents,
              resolvedUnitCents: resolvedCents,
              chargedUnitCents: unitCents,
              pageMemberTier: body.memberTier ?? null,
              memberLevel: membership.level,
              memberCategory: membership.category,
            }),
          );
        }
      }
      priceByType.set(tt.id, unitCents);
    }
    seats.push({ index, ticketType: tt, unitCents });
  }

  // ---- 5b. Voucher redemption --------------------------------------------
  // Opt-in per request: a company's prepaid vouchers are only drawn down when the caller
  // asks (corporate bulk register does), so an employee's own checkout can't quietly spend
  // the company balance just by carrying a memberCompanyId for member pricing.
  let redemption = NO_REDEMPTION;
  // The mode the redemption was PLANNED under, kept so each seat can record its share in
  // the right unit. A tenant can switch `voucher_mode` later, and a booking's seats have to
  // keep meaning what they meant when they were sold.
  let voucherMode: VoucherMode = 'off';
  if (voucherCompanyId && body.redeemVouchers === true && !options?.forceFree) {
    const balance = await resolveVoucherBalance(env, portalId, voucherCompanyId);
    voucherMode = balance.config.mode;
    redemption = planVoucherRedemption(
      seats.map((seat) => ({ index: seat.index, unitCents: seat.unitCents })),
      { mode: balance.config.mode, available: balance.available },
    );
  }
  const coveredSeats = new Set(redemption.coveredSeatIndexes);

  // Aggregate into invoice lines, keeping voucher-covered seats on their own $0 line so the
  // attendee still appears on the invoice while the money stays with the voucher sale.
  const lineItemMap = new Map<string, LineItem>();
  for (const seat of seats) {
    const tt = seat.ticketType;
    const covered = coveredSeats.has(seat.index);
    const unitCents = covered ? 0 : seat.unitCents;
    const key = `${tt.id}:${covered ? 'voucher' : 'paid'}`;
    const li = lineItemMap.get(key);
    if (li) {
      li.quantity++;
      li.totalCents += unitCents;
    } else {
      const baseName = formatBookingLineItemName(event.title, tt.name);
      lineItemMap.set(key, {
        ticketTypeId: tt.id,
        name: covered ? `${baseName} (training voucher)` : baseName,
        quantity: 1,
        unitCents,
        totalCents: unitCents,
        taxTreatment: tt.tax_treatment,
        hsTaxRateId: tt.hs_tax_rate_id,
        hsProductId: tt.hs_product_id,
      });
    }
  }
  const lineItems = Array.from(lineItemMap.values());
  const forceFree = options?.forceFree === true;
  if (forceFree) {
    for (const li of lineItems) {
      li.unitCents = 0;
      li.totalCents = 0;
    }
  }
  const totalCents = lineItems.reduce((sum, li) => sum + li.totalCents, 0);
  const isFree = totalCents === 0;
  const isStaffManual = options?.source === 'staff_manual';
  // Resolved inside the paid-order block below, once portal payment config is loaded.
  // `invoiceDue` is what the HubSpot invoice says (hs_due_date); `holdExpiresAt` is what
  // the DO is asked to hold to. They are the same instant for an invoice payer and
  // deliberately different for a card payer, who gets an invoice due on receipt and the
  // DO's own short TTL, so the two must not be read off one variable.
  let invoiceDue: InvoiceDueWindow | null = null;
  let holdExpiresAt: string | null = null;
  let eligibility: InvoiceEligibility | null = null;
  let paymentTermsDays: number | null = null;
  const shouldCreateDeal = !isFree || (isStaffManual && forceFree);
  const turnstileSecret = getTurnstileSecret(env, portalId);

  // Paid orders must not reserve seats until the tenant's payment/tax mapping has
  // been explicitly completed. This prevents an untaxed or misrouted HubSpot invoice.
  if (!isFree) {
    const paymentConfig = await env.DB.prepare(
      'SELECT stripe_processor_connected, xero_gst_rate_id FROM tenants WHERE portal_id = ?1',
    )
      .bind(portalId)
      .first<{ stripe_processor_connected: number; xero_gst_rate_id: string | null }>();
    if (!paymentConfig?.stripe_processor_connected || !paymentConfig.xero_gst_rate_id) {
      throw new ReserveError(
        'payment_not_configured',
        'Online payment configuration is still being finalised. Please contact training support.',
        409,
      );
    }
    for (const li of lineItems) {
      if (!li.hsTaxRateId && !isGstFreeTreatment(li.taxTreatment)) {
        li.hsTaxRateId = paymentConfig.xero_gst_rate_id;
      }
    }

    // ---- Invoice eligibility (Phase 4.2) --------------------------------
    // 4.1 gave the long hold to every paid booking. This decides who it was for.
    //
    // A staff-supplied due date short-circuits the rules entirely: it is a human deciding
    // this booking's terms, and it already sits at the top of the resolution chain
    // (CLAUDE.md). Rules describe the default answer, not a veto over staff.
    const staffChoseDueDate =
      typeof options?.invoiceDueDate === 'string' && options.invoiceDueDate !== '';

    eligibility = staffChoseDueDate
      ? { method: 'invoice', termsDays: null, holdMs: null, ruleId: null, reason: 'matched' }
      : await resolveInvoiceEligibility(env, {
          portalId,
          buyerEmail: body.buyer.email,
          membership,
          memberCompanyId: voucherCompanyId,
          totalCents,
        });

    if (eligibility.method === 'invoice') {
      // The seat is held until the invoice falls due, not for 15 minutes, so a buyer
      // paying by bank transfer keeps both their seat and a live payment link.
      //
      // The rule's terms sit BELOW the per-event override on purpose: 0019 added
      // events.invoice_due_days so a capacity-tight event could keep a short window, and
      // who is paying does not make that event's seats less scarce.
      const dueDays =
        clampInvoiceDueDays(event.invoice_due_days) ??
        clampInvoiceDueDays(eligibility.termsDays) ??
        (await loadPortalInvoiceDueDays(env, portalId)) ??
        DEFAULT_INVOICE_DUE_DAYS;
      invoiceDue = resolveInvoiceDueDate(options?.invoiceDueDate, dueDays);
      // The hold runs to this date, so it must not outlast the session it holds a seat
      // for. Skipped when staff typed a date: that is a decision about this booking.
      if (!staffChoseDueDate) {
        const cappedDate = capDueDateToEventStart(
          invoiceDue.date,
          event.starts_at,
          await loadDisplayTimeZone(env, portalId),
        );
        if (cappedDate !== invoiceDue.date) {
          invoiceDue = resolveInvoiceDueDate(cappedDate, dueDays);
        }
      }
      // A rule may hold the seat for less time than the invoice runs: the seat returns to
      // sale while the invoice stays payable, and a payment landing afterwards takes the
      // existing late-payment route rather than overselling.
      holdExpiresAt = eligibility.holdMs
        ? new Date(Date.now() + eligibility.holdMs).toISOString()
        : invoiceDue.expiresAt;
    } else {
      // Not eligible for terms: pay at checkout. The invoice is still how money is
      // collected (HubSpot hosts the payment link), so it is raised due on receipt rather
      // than not raised at all, and the seat takes the DO's default 15-minute TTL,
      // holdExpiresAt stays null, which is how reserve asks for it.
      invoiceDue = resolveInvoiceDueDate(dateOnly(0), DEFAULT_INVOICE_DUE_DAYS);
    }
    paymentTermsDays = daysUntilDate(invoiceDue.date);

    console.log(
      JSON.stringify({
        level: 'info',
        event: 'invoice_eligibility_resolved',
        portalId,
        eventId: event.id,
        buyerEmail: body.buyer.email,
        source,
        totalCents,
        method: eligibility.method,
        reason: staffChoseDueDate ? 'staff_due_date' : eligibility.reason,
        ruleId: eligibility.ruleId,
        invoiceDueDate: invoiceDue.date,
        holdExpiresAt,
      }),
    );
  }

  // Safety: the CMS checkout sends its displayed per-seat price. The worker never trusts
  // it to set the charge (pricing is server-authoritative above), but a mismatch means
  // the buyer would see one amount and receive an invoice for another.
  //
  // The guard is DIRECTIONAL. Both sides now price from the same HubDB course row
  // (see ../pricing.ts), so a difference means the buyer's page went stale while they
  // filled the form, not that either number is untrustworthy:
  //   resolved > quoted → refuse. Invoicing more than we displayed is never acceptable.
  //   resolved < quoted → honour the lower resolved price and log it. The buyer pays
  //                       less than they were shown, the invoice is internally
  //                       consistent, and nobody is turned away at the till.
  // The symmetric version of this check is what made every gap in `pricing_rules` a
  // failed booking rather than a rounding argument.
  const priceQuote = decidePriceQuote({
    forceFree,
    expectedUnitCents: body.expectedUnitCents,
    quotedUnitCents: body.quotedUnitCents,
    resolvedUnitCents: lineItems.map((li) => li.unitCents),
  });

  if (priceQuote) {
    const { expectedUnitCents, resolvedUnitCents, outcome, enforced } = priceQuote;

    if (outcome !== 'match') {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'price_drift',
          outcome,
          enforced,
          portalId,
          eventId: event.id,
          buyerEmail: body.buyer.email,
          expectedUnitCents,
          resolvedUnitCents,
          memberTier: body.memberTier ?? null,
          memberCompanyId: body.memberCompanyId ?? null,
          isMember: membership.isMember,
          membershipVerified: membership.verified,
          memberLevel: membership.level,
          memberCategory: membership.category,
        }),
      );
    }

    if (priceQuote.reject) {
      throw new ReserveError(
        'price_mismatch',
        'The course price changed before checkout. Please refresh the page and try again.',
        409,
      );
    }
  }

  if (
    shouldRequireTurnstile({
      source,
      secretConfigured: Boolean(turnstileSecret),
    })
  ) {
    const remoteIp = c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For');
    const verification = await verifyTurnstileToken({
      secret: turnstileSecret as string,
      token: body.turnstileToken,
      remoteIp,
      idempotencyKey,
      allowedHostnames: getTurnstileAllowedHostnames(env, portalId),
    });

    if (!verification.success) {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'turnstile_failed',
          portalId,
          eventId: event.id,
          buyerEmail: body.buyer.email,
          reason: verification.reason ?? null,
          errorCodes: verification.errorCodes ?? [],
          hostname: verification.hostname ?? null,
          action: verification.action ?? null,
        }),
      );
      throw new ReserveError(
        'turnstile_required',
        'Please complete the security check and try again.',
        403,
      );
    }
  } else if (isPublicCheckout && !turnstileSecret) {
    // Warn for every unchallenged public booking, not just free ones. A paid booking on an
    // unconfigured portal is the more consequential of the two: its hold runs to the invoice
    // due date, so an unchallenged caller can hold the seat for weeks rather than minutes.
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'turnstile_not_configured',
        portalId,
        eventId: event.id,
        isFree,
      }),
    );
  }

  // ---- 6. EventCapacity DO /reserve ----------------------------------------
  const reservationId = crypto.randomUUID();
  const doIdName = `${portalId}:${event.hubspot_event_id}`;
  const doStub = env.EVENT_CAPACITY.get(env.EVENT_CAPACITY.idFromName(doIdName));
  // Migration 0045: a capacity staff changed in HubDB lands in D1 before the DO is synced
  // from it. Never throttled here — this is the moment the number has to be right. A
  // LOWERED capacity the DO did not acknowledge refuses the hold rather than selling to the
  // old limit.
  if (!(await syncCapacityBeforeHold(env, portalId, doStub, event, ticketTypes))) {
    throw new ReserveError(
      'capacity_unconfirmed',
      'We could not confirm seat availability just now. Please try again in a moment.',
      503,
    );
  }

  const doResp = await doStub.fetch('https://do/reserve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      holdId: reservationId,
      items: lineItems.map((li) => ({ ticketTypeId: li.ticketTypeId, quantity: li.quantity })),
      // Absent for a free booking and for a card payer: the DO applies DEFAULT_TTL_MS,
      // which is the 15-minute hold pay-at-checkout wants.
      ...(holdExpiresAt ? { expiresAt: holdExpiresAt } : {}),
    }),
  });

  const doData = (await doResp.json()) as {
    ok: boolean;
    full?: boolean;
    expiresAt?: string;
  };

  // Seats are held from here on. Nothing durable references them until the batch at
  // step 10 commits, so arm the guard before any code that can throw.
  if (doData.ok) {
    guard.stub = doStub;
    guard.holdId = reservationId;

    // This booking may have been the one that closed the event. If that happened within
    // half an hour of first publish, the capacity is more likely a setup placeholder than
    // real demand, flag it for the owner (Phase 1.1). Advisory and off the critical path:
    // it never blocks or fails the reservation.
    backgroundFlagFastSellout(c, env, portalId, event);
  }

  // ---- 7. Capacity full → join waitlist ------------------------------------
  if (!doData.ok && doData.full) {
    // A claimant whose freed seat was taken by a faster claimant must not be pushed to
    // the back of the queue: surface it as a conflict instead of re-waitlisting.
    if (offerClaim) {
      throw new ReserveError('offer_seat_taken', 'This waitlist offer is no longer available', 409);
    }

    // One waitlist slot per buyer (a group ticket waits together as a single entry).
    const { waitlistId } = await joinWaitlist(env, {
      portalId,
      event,
      ticketTypeId: attendees[0].ticketTypeId,
      email: body.buyer.email,
      hubspotContactId: body.buyer.hubspotContactId ?? null,
      quantity: attendees.length,
    });

    const response = { status: 'waitlisted', waitlistId };
    await persistIdempotencyKey(env, portalId, idempotencyKey, 200, response);
    return c.json(response);
  }

  if (!doData.ok) {
    throw new ReserveError('reserve_failed', 'Reservation could not be created');
  }
  if (!doData.expiresAt) {
    throw new ReserveError('reserve_failed', 'Reservation could not be created');
  }

  const expiresAt = doData.expiresAt;
  // A complete course is paid through the parent course ticket. Its required
  // modules receive $0 private entitlement holds with the same expiry window.
  if (coursePackage && isFree) {
    throw new ReserveError(
      'course_package_payment_required',
      'Complete-course package checkout currently requires a paid parent course ticket.',
      409,
    );
  }
  if (coursePackage && coursePackageComponents) {
    const bundleHold = await holdCourseBundle({
      env,
      portalId,
      // One module seat per attendee on the package. Payment confirmation clones every
      // one of them into every module, so the hold has to be for the same number.
      seats: attendees.length,
      components: coursePackageComponents,
      expiresAt,
    });
    if (!bundleHold.ok) {
      throw new ReserveError(
        bundleHold.status,
        bundleHold.status === 'course_component_full'
          ? 'A required course module is no longer available.'
          : bundleHold.status === 'capacity_unconfirmed'
            ? 'We could not confirm seat availability just now. Please try again in a moment.'
            : 'This course package is not configured for checkout yet.',
        bundleHold.status === 'capacity_unconfirmed' ? 503 : 409,
      );
    }
    guard.bundleHolds = bundleHold.holds;
  }
  const now = new Date().toISOString();
  const orderId = crypto.randomUUID();
  // Stable interactionDateTime: frozen here, not regenerated on retry (CLAUDE.md invariant).
  const interactionDateTime = now;

  // ---- 8. Webinar provisioning + attendee registration (online events) -----
  const isOnline = event.provider !== null;
  const registrationIds = attendees.map(() => crypto.randomUUID());

  if (options?.source === 'staff_manual') {
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'staff_manual_registration',
        portalId,
        eventId: event.id,
        buyerEmail: body.buyer.email,
        attendeeEmails: attendees.map((attendee) => attendee.email),
        forceFree,
        totalCents,
        staffActor: options.staffActor ?? null,
        // Whether a note was left, not what it says: the body is internal text and it is
        // durably stored on the order; a Worker log is the wrong second copy of it.
        staffNoteLeft: Boolean(options.staffNote?.trim()),
      }),
    );
  }

  const teamsResults = attendees.map(() => ({
    teamsRegistrationId: null as string | null,
    teamsJoinUrl: null as string | null,
  }));
  if (isOnline) {
    // Provision the webinar lazily on first reservation if not yet created.
    let webinarId = event.teams_webinar_id;
    let webinarJoinUrl = event.teams_join_url;
    if (!webinarId) {
      const provisioned = await provisionWebinarIfNeeded(env, portalId, event);
      webinarId = provisioned?.teamsWebinarId ?? null;
      webinarJoinUrl = provisioned?.teamsJoinUrl ?? null;
    }
    if (webinarId) {
      for (let i = 0; i < attendees.length; i++) {
        // A seat with no attendee has nobody to register and no personal join URL to mint
        // (Ref 74b). Both are created by the amend that attaches the name, which already
        // does exactly this for an email correction.
        if (attendees[i].unnamed) continue;
        teamsResults[i] = await registerAttendeeInTeams(
          env,
          portalId,
          event.provider,
          webinarId,
          attendees[i],
          registrationIds[i],
          webinarJoinUrl,
        );
        if (teamsResults[i].teamsRegistrationId) {
          guard.providerRegistrations.push({
            providerName: event.provider,
            webinarId,
            providerRegistrationId: teamsResults[i].teamsRegistrationId as string,
          });
        }
      }
    }
  }

  // ---- 9. D1 batch: reservation + items + order + registrations + outbox ---
  const stmts: D1PreparedStatement[] = [];

  // Reservation
  stmts.push(
    env.DB.prepare(
      `INSERT INTO reservations (id, portal_id, event_id, idempotency_key, status, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    ).bind(
      reservationId,
      portalId,
      event.id,
      idempotencyKey,
      isFree ? 'confirmed' : 'pending',
      expiresAt,
      now,
    ),
  );

  // Reservation items
  for (const li of lineItems) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO reservation_items (id, portal_id, reservation_id, ticket_type_id, quantity, unit_cents)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      ).bind(
        crypto.randomUUID(),
        portalId,
        reservationId,
        li.ticketTypeId,
        li.quantity,
        li.unitCents,
      ),
    );
  }

  // Order
  stmts.push(
    env.DB.prepare(
      `INSERT INTO orders
         (id, portal_id, event_id, reservation_id, status,
          buyer_email, buyer_name, buyer_abn, total_cents, currency, member_company_id,
          voucher_seats_redeemed, voucher_credit_cents,
          payment_method, payment_terms_days, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'AUD', ?10, ?11, ?12, ?13, ?14, ?15, ?15)`,
    ).bind(
      orderId,
      portalId,
      event.id,
      reservationId,
      isFree ? 'confirmed' : 'pending',
      body.buyer.email,
      body.buyer.name,
      body.buyer.abn ?? null,
      totalCents,
      // Ties the order to the company whose voucher balance it draws on, and records what it
      // actually redeemed: usage is summed from these rather than counted from seats, which
      // stays correct when a booking is only partly covered.
      voucherCompanyId,
      redemption.seatsRedeemed,
      redemption.creditCents,
      // How this booking was to be paid, recorded where it can be audited afterwards.
      // NULL on a free or comped booking: no payment applies, and it holds no seat to a
      // due date either.
      eligibility?.method ?? null,
      eligibility?.method === 'invoice' ? paymentTermsDays : null,
      now,
    ),
  );

  if (guard.bundleHolds.length > 0) {
    stmts.push(
      ...courseBundleHoldStatements({
        env,
        portalId,
        orderId,
        holds: guard.bundleHolds,
        createdAt: now,
      }),
    );
  }

  // Pre-generate outbox ids so we can include them in queue signals
  const meRegisterOutboxIds = attendees.map(() => crypto.randomUUID());
  const confirmationOutboxIds = attendees.map(() => crypto.randomUUID());
  // Ref 61: whether the registration confirmation email goes out NOW.
  //
  // A free booking is already `confirmed` and an invoice-terms booking holds its seat to
  // the invoice due date with an invoice raised against it. Both are bookings the customer
  // has made and is owed an acknowledgement of, and making a bank-transfer buyer wait for
  // payment would leave them with nothing for up to 90 days.
  //
  // A card-at-checkout booking is an unpaid hold that may simply be abandoned, so its
  // confirmation is raised by the payment-confirm path instead. Sending one here is what
  // told a buyer "registration confirmed" for a seat they lost fifteen minutes later.
  const confirmAtReserve = isFree || eligibility?.method === 'invoice';
  const joinUrlOutboxIds = attendees.map(() => crypto.randomUUID());
  const contactDetailOutboxIds = attendees.map(() => crypto.randomUUID());
  const answerSyncOutboxIds = attendees.map(() => crypto.randomUUID());
  // Phase 2.3: the answers whose question names a HubSpot contact property. An attendee who
  // answered about THEMSELVES (they are the buyer) may replace what HubSpot holds; anyone
  // else's booking may only fill a gap: see handleContactSyncAnswers.
  const buyerEmailKey = normaliseEmail(body.buyer.email);
  const answersToWriteBack = attendeeAnswers.map((answers) => answersToSync(answers));
  // Phase 1.2: phone/suburb/state, persisted with the reservation and written back to the
  // contact only where HubSpot is empty (the handler settles that, not the request).
  const contactDetails = captureContactDetails(attendees);
  const dealOutboxId = crypto.randomUUID();
  const invoiceOutboxId = crypto.randomUUID();
  const voucherSyncOutboxId = crypto.randomUUID();
  // Phase 1.3: the note staff typed on a manual booking. It belongs to the ORDER (it is
  // about the booking ("invoice to head office", "comped, approved by Ollie"), not about
  // one attendee) and it is internal: nothing on the buyer's or attendee's side of this
  // request ever reads it back. Public checkout never sets staffNote.
  const staffNote: PreparedStaffNote | null = (() => {
    const prepared = prepareStaffNote({
      portalId,
      orderId,
      author: options?.staffActor ?? null,
      body: options?.staffNote ?? '',
    });
    return prepared.ok ? prepared.note : null;
  })();
  // Free/complimentary orders commit their seats here rather than at payment confirm, so a
  // voucher they consume has to be projected to HubSpot from this path too. Fully covered
  // bookings land here by definition: redemption zeroes every line, so the total is $0.
  const redeemedAnything = redemption.seatsRedeemed > 0 || redemption.creditCents > 0;
  const syncVouchersNow = isFree && voucherCompanyId !== null && redeemedAnything;

  // Registrations + outbox entries per attendee
  for (let i = 0; i < attendees.length; i++) {
    const attendee = attendees[i];
    const regId = registrationIds[i];
    const teams = teamsResults[i];

    // What THIS seat cost, decomposed exactly as the order's three money columns are
    // (0028). `seats[i]` is attendee `i`, since the list is built from `attendees.entries()`
    // above, so the price and the voucher decision already made for this seat are simply
    // recorded against it instead of being aggregated away into a line item.
    //
    // The charged amount is what the seat contributes to the invoice: zero when a voucher
    // covered it (the money was taken when the voucher was sold) and zero when staff comped
    // the booking. Summed over a booking's seats it is exactly `totalCents`, which is what
    // lets a single seat be refunded for what it actually cost.
    const covered = coveredSeats.has(i);
    const chargedCents = forceFree || covered ? 0 : seats[i].unitCents;
    // Exactly one of these is ever non-zero: 'seat' mode spends one voucher per covered
    // seat whatever it costs, 'credit' mode spends that seat's price. A $0 seat "covered"
    // under credit mode consumed nothing and records nothing, which is the truth.
    const voucherSeats = covered && voucherMode === 'seat' ? 1 : 0;
    const voucherCents = covered && voucherMode === 'credit' ? seats[i].unitCents : 0;

    stmts.push(
      env.DB.prepare(
        `INSERT INTO registrations
           (id, portal_id, order_id, event_id, ticket_type_id, hubspot_contact_id,
            attendee_email, attendee_name, seat_unnamed,
            attendee_phone, attendee_suburb, attendee_state,
            unit_cents, voucher_seats, voucher_cents,
            teams_registration_id, teams_join_url, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?18, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?17)`,
      ).bind(
        regId,
        portalId,
        orderId,
        event.id,
        attendee.ticketTypeId,
        attendee.hubspotContactId ?? null,
        attendee.email,
        attendee.name,
        contactDetails.values[i].phone,
        contactDetails.values[i].suburb,
        contactDetails.values[i].state,
        chargedCents,
        voucherSeats,
        voucherCents,
        teams.teamsRegistrationId,
        teams.teamsJoinUrl,
        now,
        attendee.unnamed ? 1 : 0,
      ),
    );

    // Outbox: me.register (Marketing Event attendance write-back)
    //
    // Skipped for a seat with no attendee (Ref 74b). Marketing Event participation is
    // keyed on a CONTACT, and there is no contact to key it on, and enqueuing one would upsert
    // a contact from an empty email and register it, putting a person HubSpot invented onto
    // the event. The amend that attaches the name raises this row, exactly as an email
    // correction already does.
    if (!attendee.unnamed) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO outbox (id, portal_id, topic, payload, stable_interaction_datetime, created_at)
           VALUES (?1, ?2, 'me.register', ?3, ?4, ?5)`,
        ).bind(
          meRegisterOutboxIds[i],
          portalId,
          JSON.stringify({
            registrationId: regId,
            attendeeEmail: attendee.email,
            hubspotContactId: attendee.hubspotContactId ?? null,
            hubspotEventId: event.hubspot_event_id,
            // portalId doubles as externalAccountId for Weld's single-portal setup
            externalAccountId: portalId,
            ticketTypeId: attendee.ticketTypeId,
          }),
          interactionDateTime,
          now,
        ),
      );
    }

    // Outbox: the registration-confirmation stamp (Ref 61), skipped for the same unnamed
    // seat me.register skips: a seat with nobody on it has nobody to confirm to.
    if (!attendee.unnamed && confirmAtReserve) {
      stmts.push(
        registrationConfirmationStatement(
          env,
          portalId,
          {
            registrationId: regId,
            orderId,
            attendeeEmail: attendee.email,
            hubspotContactId: attendee.hubspotContactId ?? null,
          },
          confirmationOutboxIds[i],
          now,
        ),
      );
    }

    // Answers to the event's attendee-scoped questions, in the SAME batch as the
    // registration they belong to. That is what "persisted with the reservation" means:
    // they commit together, and a hold that later expires carries them into the same
    // cancelled state rather than leaving orphans behind.
    stmts.push(
      ...answerStatements(env, {
        portalId,
        registrationId: regId,
        answers: attendeeAnswers[i],
        createdAt: now,
      }),
    );

    // Outbox: contact.sync_answers, the mapped answers onto the ATTENDEE's contact, so
    // the next booking can offer them back as the default instead of asking again.
    if (answersToWriteBack[i].length > 0) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
           VALUES (?1, ?2, 'contact.sync_answers', ?3, ?4)`,
        ).bind(
          answerSyncOutboxIds[i],
          portalId,
          JSON.stringify({
            registrationId: regId,
            attendeeEmail: attendee.email,
            attendeeName: attendee.name,
            hubspotContactId: attendee.hubspotContactId ?? null,
            selfDeclared: normaliseEmail(attendee.email) === buyerEmailKey,
            answers: answersToWriteBack[i],
          }),
          now,
        ),
      );
    }

    // Outbox: contact.sync_attendee_details, phone/suburb/state onto the HubSpot contact.
    // Only raised when something was actually captured, so a form that does not ask costs
    // nothing. The handler fills empty properties and opens a decision on a mismatch;
    // it never overwrites (CLAUDE.md: attendee contact capture).
    if (contactDetails.anyCaptured[i]) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
           VALUES (?1, ?2, 'contact.sync_attendee_details', ?3, ?4)`,
        ).bind(
          contactDetailOutboxIds[i],
          portalId,
          JSON.stringify({
            registrationId: regId,
            eventId: event.id,
            attendeeEmail: attendee.email,
            attendeeName: attendee.name,
            hubspotContactId: attendee.hubspotContactId ?? null,
            details: contactDetails.values[i],
          }),
          now,
        ),
      );
    }

    // Outbox: contact.set_join_url (online events; no-ops in Phase 6 stub if url is null)
    // No attendee, no personal join URL and no contact to write it to (Ref 74b).
    if (isOnline && !attendee.unnamed) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
           VALUES (?1, ?2, 'contact.set_join_url', ?3, ?4)`,
        ).bind(
          joinUrlOutboxIds[i],
          portalId,
          JSON.stringify({
            registrationId: regId,
            attendeeEmail: attendee.email,
            hubspotContactId: attendee.hubspotContactId ?? null,
            teamsJoinUrl: teams.teamsJoinUrl,
          }),
          now,
        ),
      );
    }
  }

  // Order-scoped answers, asked once for the whole booking (a purchase order number),
  // not once per seat. Never written back to a contact: the buyer did not personally
  // acquire the booking's PO number as a trait of theirs.
  stmts.push(
    ...answerStatements(env, { portalId, orderId, answers: orderAnswers, createdAt: now }),
  );

  // Tickets for free events, issued immediately on confirmation.
  const ticketIds: string[] = [];
  if (isFree) {
    for (let i = 0; i < attendees.length; i++) {
      // A ticket names the person it admits (Ref 74b). An unnamed seat gets none until a
      // name attaches, which is the amend path that already mints one.
      if (attendees[i].unnamed) continue;
      const ticketId = crypto.randomUUID();
      ticketIds.push(ticketId);
      // Signed, scannable QR code (same mint as the paid issueTickets path).
      const qrCode = await mintTicketForTenant(
        env,
        portalId,
        ticketId,
        registrationIds[i],
        event.id,
      );
      stmts.push(
        env.DB.prepare(
          `INSERT INTO tickets (id, portal_id, registration_id, order_id, event_id, ticket_type_id, status, qr_code, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'issued', ?7, ?8)`,
        ).bind(
          ticketId,
          portalId,
          registrationIds[i],
          orderId,
          event.id,
          attendees[i].ticketTypeId,
          qrCode,
          now,
        ),
      );
      stmts.push(
        env.DB.prepare('UPDATE registrations SET ticket_id = ?1 WHERE id = ?2').bind(
          ticketId,
          registrationIds[i],
        ),
      );
    }
  }

  // Outbox: deal.create for paid orders and staff/manual complimentary seats.
  //
  // Public free bookings deliberately remain out of scope here: staff/manual comp
  // seats need a $0 deal for HubSpot reporting and the member portal, but no invoice.
  if (shouldCreateDeal) {
    const dealPayload = JSON.stringify({
      orderId,
      eventId: event.id,
      hubspotEventId: event.hubspot_event_id,
      bookingKind: event.booking_kind ?? 'course',
      buyerEmail: body.buyer.email,
      buyerName: body.buyer.name,
      buyerAbn: body.buyer.abn ?? null,
      buyerHubspotContactId: body.buyer.hubspotContactId ?? null,
      totalCents,
      lineItems,
      attendees: attendees.map((attendee) => ({
        email: attendee.email,
        name: attendee.name,
        ticketTypeId: attendee.ticketTypeId,
        hubspotContactId: attendee.hubspotContactId ?? null,
      })),
      source: options?.source ?? 'public_checkout',
      manualRegistration: isStaffManual,
      complimentary: isStaffManual && forceFree,
      invoiceRequired: !isFree,
      paymentRequired: !isFree,
      staffActor: options?.staffActor ?? null,
      // The note itself is deliberately NOT carried here. It has a home now
      // (registration_notes, keyed to this order) and a HubSpot projection of its own;
      // copying it into a deal payload no handler reads would only give internal text a
      // second route out of the worker.
    });
    stmts.push(
      env.DB.prepare(
        `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
         VALUES (?1, ?2, 'deal.create', ?3, ?4)`,
      ).bind(dealOutboxId, portalId, dealPayload, now),
    );
  }

  // Outbox: invoice.create remains paid-only.
  if (!isFree) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
         VALUES (?1, ?2, 'invoice.create', ?3, ?4)`,
      ).bind(
        invoiceOutboxId,
        portalId,
        JSON.stringify({
          orderId,
          eventId: event.id,
          hubspotEventId: event.hubspot_event_id,
          buyerEmail: body.buyer.email,
          buyerName: body.buyer.name,
          buyerAbn: body.buyer.abn ?? null,
          totalCents,
          currency: 'AUD',
          ...(invoiceDue ? { invoiceDueDate: invoiceDue.date } : {}),
          lineItems,
        }),
        now,
      ),
    );
  }

  // Outbox: project the company's recomputed voucher usage to HubSpot, in the same batch as
  // the seat commit that spent it. Paid orders sync from the payment-confirm path instead.
  if (syncVouchersNow) {
    stmts.push(
      voucherUsageSyncStatement(
        env,
        portalId,
        voucherCompanyId as string,
        voucherSyncOutboxId,
        now,
      ),
    );
  }

  if (staffNote) {
    stmts.push(...staffNoteStatements(env, staffNote));
  }

  // Waitlist offer → promoted, in the same batch as the hold it was claimed for.
  if (offerClaim) {
    stmts.push(markOfferPromoted(env, offerClaim.waitlistId));
  }

  // Idempotency key, included in the same atomic batch.
  const idemExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const responseBody = isFree
    ? { status: 'confirmed', orderId, registrationIds, ticketIds }
    : {
        status: 'reserved',
        orderId,
        registrationIds,
        pollUrl: `/api/v1/orders/${orderId}`,
      };

  stmts.push(
    env.DB.prepare(
      `INSERT OR IGNORE INTO idempotency_keys
         (id, portal_id, key, request_hash, response_status, response_body, expires_at, created_at)
       VALUES (?1, ?2, ?3, '', ?4, ?5, ?6, ?7)`,
    ).bind(
      crypto.randomUUID(),
      portalId,
      idempotencyKey,
      200,
      JSON.stringify(responseBody),
      idemExpiresAt,
      now,
    ),
  );

  // ---- 10. Commit everything atomically ------------------------------------
  await env.DB.batch(stmts);
  // D1 now owns the hold: its expiry/refund path takes over, so it must not be released.
  guard.committed = true;

  // ---- 11. Post-commit: confirm DO hold (free) + enqueue outbox signals ----
  if (isFree) {
    // Commit seats in the DO. Best-effort after D1 commit; D1 is authoritative.
    // A reconciliation cron can detect and fix a missed confirm.
    try {
      await doStub.fetch('https://do/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ holdId: reservationId }),
      });
    } catch {
      // swallow: reconciliation handles it
    }
  }

  // Signal the queue to drain relevant outbox rows (best-effort; cron is the backstop).
  try {
    // Only the seats that actually raised a me.register row above. An unnamed seat has no
    // row, and signalling a non-existent outbox id just wakes the handler to find nothing.
    const signals: { body: Record<string, unknown> }[] = attendees
      .map((attendee, i) => ({ attendee, i }))
      .filter(({ attendee }) => !attendee.unnamed)
      .map(({ i }) => ({
        body: {
          kind: 'me.register',
          portalId,
          outboxId: meRegisterOutboxIds[i],
          registrationId: registrationIds[i],
        },
      }));
    if (confirmAtReserve) {
      for (let i = 0; i < attendees.length; i++) {
        if (attendees[i].unnamed) continue;
        signals.push({
          body: {
            kind: 'contact.sync_registration_confirmation',
            portalId,
            outboxId: confirmationOutboxIds[i],
            registrationId: registrationIds[i],
          },
        });
      }
    }
    if (isOnline) {
      for (let i = 0; i < attendees.length; i++) {
        if (attendees[i].unnamed) continue;
        signals.push({
          body: {
            kind: 'contact.set_join_url',
            portalId,
            outboxId: joinUrlOutboxIds[i],
            registrationId: registrationIds[i],
          },
        });
      }
    }
    for (let i = 0; i < attendees.length; i++) {
      if (!contactDetails.anyCaptured[i]) continue;
      signals.push({
        body: {
          kind: 'contact.sync_attendee_details',
          portalId,
          outboxId: contactDetailOutboxIds[i],
          registrationId: registrationIds[i],
        },
      });
    }
    for (let i = 0; i < attendees.length; i++) {
      if (answersToWriteBack[i].length === 0) continue;
      signals.push({
        body: {
          kind: 'contact.sync_answers',
          portalId,
          outboxId: answerSyncOutboxIds[i],
          registrationId: registrationIds[i],
        },
      });
    }
    if (shouldCreateDeal) {
      signals.push({ body: { kind: 'deal.create', portalId, outboxId: dealOutboxId, orderId } });
    }
    if (!isFree) {
      signals.push({
        body: { kind: 'invoice.create', portalId, outboxId: invoiceOutboxId, orderId },
      });
    }
    if (syncVouchersNow) {
      signals.push({
        body: {
          kind: 'company.sync_voucher_usage',
          portalId,
          companyId: voucherCompanyId,
          outboxId: voucherSyncOutboxId,
        },
      });
    }
    if (staffNote) {
      signals.push({
        body: { kind: 'note.create', portalId, outboxId: staffNote.outboxId, noteId: staffNote.id },
      });
    }
    if (signals.length > 0) await env.QUEUE.sendBatch(signals);
  } catch {
    // swallow: cron will catch pending outbox rows
  }

  return c.json(responseBody, 200);
}

// ---------------------------------------------------------------------------
// GET /api/v1/orders/:id
// ---------------------------------------------------------------------------

export async function handleGetOrder(c: Context<{ Bindings: Env }>): Promise<Response> {
  const portalId = c.req.header('X-Portal-Id');
  if (!portalId) {
    return c.json({ error: 'X-Portal-Id header required' }, 400);
  }

  const orderId = c.req.param('id') as string;
  let row: {
    id: string;
    status: string;
    hubspot_invoice_id: string | null;
    hubspot_invoice_url: string | null;
    payment_method: string | null;
    expires_at: string | null;
  } | null;
  try {
    row = await c.env.DB.prepare(
      `SELECT o.id, o.status, o.hubspot_invoice_id, o.hubspot_invoice_url,
              o.payment_method,
              COALESCE(
                r.expires_at,
                (
                  SELECT MIN(cr.expires_at)
                    FROM course_bundle_components cbc
                    JOIN reservations cr ON cr.id = cbc.reservation_id
                   WHERE cbc.portal_id = o.portal_id
                     AND cbc.order_id = o.id
                )
              ) AS expires_at
       FROM orders o
       LEFT JOIN reservations r ON r.id = o.reservation_id
       WHERE o.id = ?1 AND o.portal_id = ?2`,
    )
      .bind(orderId, portalId)
      .first<typeof row>();
  } catch {
    row = await c.env.DB.prepare(
      `SELECT o.id, o.status, o.hubspot_invoice_id, o.hubspot_invoice_url,
              o.payment_method, r.expires_at
       FROM orders o
       LEFT JOIN reservations r ON r.id = o.reservation_id
       WHERE o.id = ?1 AND o.portal_id = ?2`,
    )
      .bind(orderId, portalId)
      .first<typeof row>();
  }

  if (!row) return c.json({ error: 'order_not_found', message: 'Order not found' }, 404);

  if (row.status === 'cancelled') {
    return c.json({
      status: row.status,
      paymentUrl: null,
      message: 'This reservation has expired. Please start checkout again to create a new hold.',
    });
  }

  if (row.status === 'refunded' || row.status === 'partially_refunded') {
    return c.json({
      status: row.status,
      paymentUrl: null,
      message: 'This order is no longer payable.',
    });
  }

  return c.json({
    status: row.status,
    // The HubSpot-hosted invoice payment link, written by the invoice.create write-back
    // once the invoice is opened. Null until then; the module keeps polling.
    paymentUrl: row.hubspot_invoice_url,
    // Date-only deadline the seat is held to, so checkout can tell the buyer how long
    // they have to pay. Null on a free/confirmed order that holds no seat. This is the
    // HOLD's deadline, not the invoice's: where a rule holds the seat for less time than
    // the invoice runs (Phase 4.2), the seat going is what actually costs the buyer their
    // place, so that is the date checkout must show.
    paymentDueDate: row.status === 'pending' ? (row.expires_at?.slice(0, 10) ?? null) : null,
    // 'invoice' → the buyer has terms; 'card' → pay now, on a short hold. Lets the CMS
    // module say "pay within 15 minutes" or "invoice due 30 September" without guessing
    // from the date. Null on a free booking.
    paymentMethod: row.payment_method,
  });
}

// ---------------------------------------------------------------------------
// GET /api/v1/events/:slug/availability
// ---------------------------------------------------------------------------

/**
 * Live seat availability for an event, read from the EventCapacity DO, the single source
 * of truth for seats (never D1 counters, never HubDB). Shapes the DO snapshot into the
 * contract the CMS registration module consumes: per ticket type
 * {available, soldOut, waitlistAvailable} plus an event-level `eventFull` flag.
 */
export async function handleGetAvailability(c: Context<{ Bindings: Env }>): Promise<Response> {
  const limited = await checkRateLimit(c, {
    prefix: 'rl:availability',
    limit: 60,
    windowSeconds: 60,
  });
  if (limited) return limited;

  const portalId = c.req.header('X-Portal-Id');
  if (!portalId) {
    return c.json({ error: 'X-Portal-Id header required' }, 400);
  }

  const slug = c.req.param('slug') as string;
  const event = await loadEvent(c.env.DB, portalId, slug);
  if (!event) {
    return c.json({ status: 'event_not_found', message: 'Event not found' }, 404);
  }

  const ticketTypes = await loadTicketTypes(c.env.DB, event.id);

  // Read the live snapshot from the DO (the same instance reserve holds against).
  const doIdName = `${portalId}:${event.hubspot_event_id}`;
  const doStub = c.env.EVENT_CAPACITY.get(c.env.EVENT_CAPACITY.idFromName(doIdName));
  // Migration 0045, throttled: every course-page render calls this, and the page is only
  // advisory (reserve re-reads HubDB unthrottled before it holds a seat).
  await trySyncEventCapacityFromHubDb(c.env, portalId, event, ticketTypes, { throttle: true });
  await syncCapacityFromD1(doStub, event, ticketTypes);
  let snapshot: {
    available: number | null;
    perType: Record<string, { available: number | null }>;
  } = { available: null, perType: {} };
  try {
    const resp = await doStub.fetch('https://do/availability', { method: 'POST' });
    const data = (await resp.json()) as typeof snapshot & { ok?: boolean };
    if (data && typeof data === 'object') snapshot = data;
  } catch {
    // DO unreachable: fall back to "available" (null) so the widget stays usable. The DO
    // is still authoritative at reserve time, so this can never cause an oversell.
  }

  // null event capacity = uncapped → never event-full.
  const eventFull = snapshot.available !== null && snapshot.available <= 0;

  // Migration 0038. Reported alongside the seat counts rather than instead of them: a
  // closed event still has a true seat count, and the front end says different things
  // about "sold out" and "registrations have closed".
  const window = resolveSalesWindow(event);

  const publicTicketTypes = ticketTypes.filter(
    (tt) => !tt.internal_only && !isPublicImportTicket(tt.id, tt.name),
  );
  const out = publicTicketTypes.map((tt: TicketTypeRow) => {
    const v = snapshot.perType ? snapshot.perType[tt.id] : undefined;
    const typeAvail = v ? v.available : null;
    const typeSoldOut = typeAvail !== null && typeAvail <= 0;
    const soldOut = typeSoldOut || eventFull;
    const salesPaused = ticketTypePaused(tt);
    // The one field a caller needs to decide whether to render a Register button. Kept
    // distinct from `soldOut`, which stays purely about seats, so a consumer reading only
    // the old fields cannot mistake a closed event for a full one, or a paused one for a
    // bookable one.
    const bookable = !soldOut && !salesPaused && window.open;
    return {
      ticketTypeId: tt.id,
      available: typeAvail,
      soldOut,
      salesPaused,
      bookable,
      // A sold-out type can still take waitlist joins: reserve auto-waitlists when full.
      // A closed or paused one cannot: reserve rejects before it reaches the waitlist, so
      // offering the option here would be a form that always fails.
      waitlistAvailable: soldOut && !salesPaused && window.open,
    };
  });

  return c.json({
    status: 'ok',
    eventFull,
    registrationClosed: window.closed,
    salesPaused: window.paused,
    registrationClosesAt: window.closesAt,
    // Derived from the TYPES, not just the event: seats can remain at the event level
    // while every public type is individually sold out or paused, and an event-level flag
    // that ignored that would have a consumer render a Register button with nothing
    // selectable behind it. An event with no public types at all is not bookable either.
    bookable: window.open && !eventFull && out.some((ticketType) => ticketType.bookable),
    ticketTypes: out,
  });
}

/**
 * Full-course checkout. The parent course provides the paid ticket; the
 * reservation additionally holds every required child module as an included
 * package entitlement.
 */
export async function handleReserveCoursePackage(c: Context<{ Bindings: Env }>): Promise<Response> {
  const limited = await checkRateLimit(c, {
    prefix: 'rl:reserve-course-package',
    limit: 20,
    windowSeconds: 60,
  });
  if (limited) return limited;

  const idempotencyKey = c.req.header('Idempotency-Key');
  if (!idempotencyKey) {
    return c.json(
      { status: 'missing_idempotency_key', message: 'Idempotency-Key header required' },
      400,
    );
  }
  const portalId = c.req.header('X-Portal-Id');
  if (!portalId) {
    return c.json({ status: 'missing_portal_id', message: 'X-Portal-Id header required' }, 400);
  }

  const replay = await c.env.DB.prepare(
    'SELECT response_status, response_body FROM idempotency_keys WHERE portal_id = ?1 AND key = ?2',
  )
    .bind(portalId, idempotencyKey)
    .first<{ response_status: number; response_body: string }>();
  if (replay) {
    return new Response(replay.response_body, {
      status: replay.response_status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const guard = newHoldGuard();
  try {
    return await doReserve(c, { portalId, idempotencyKey, guard, coursePackage: true });
  } catch (err) {
    await releaseUncommittedHold(c.env, portalId, guard);
    if (err instanceof ReserveError) {
      return refuseReserve(c, err, {
        portalId,
        eventId: c.req.param('slug'),
        buyerEmail: recalledBuyerEmail(c) ?? undefined,
      });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// POST /api/v1/events/:slug/reserve-selected-modules
// ---------------------------------------------------------------------------

/**
 * Parent-course checkout for an arbitrary subset of child modules. This keeps
 * the existing single-module and complete-course paths unchanged, but lets the
 * CMS submit "Module 1 + Module 3 + Module 4" as one order/invoice.
 */
export async function handleReserveSelectedModules(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  const limited = await checkRateLimit(c, {
    prefix: 'rl:reserve-selected-modules',
    limit: 20,
    windowSeconds: 60,
  });
  if (limited) return limited;

  const idempotencyKey = c.req.header('Idempotency-Key');
  if (!idempotencyKey) {
    return c.json(
      { status: 'missing_idempotency_key', message: 'Idempotency-Key header required' },
      400,
    );
  }
  const portalId = c.req.header('X-Portal-Id');
  if (!portalId) {
    return c.json({ status: 'missing_portal_id', message: 'X-Portal-Id header required' }, 400);
  }

  const replay = await c.env.DB.prepare(
    'SELECT response_status, response_body FROM idempotency_keys WHERE portal_id = ?1 AND key = ?2',
  )
    .bind(portalId, idempotencyKey)
    .first<{ response_status: number; response_body: string }>();
  if (replay) {
    return new Response(replay.response_body, {
      status: replay.response_status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const guard = newHoldGuard();
  try {
    return await doReserveSelectedModules(c, { portalId, idempotencyKey, guard });
  } catch (err) {
    await releaseUncommittedHold(c.env, portalId, guard);
    if (err instanceof ReserveError) {
      return refuseReserve(c, err, {
        portalId,
        eventId: c.req.param('slug'),
        buyerEmail: recalledBuyerEmail(c) ?? undefined,
      });
    }
    throw err;
  }
}

async function doReserveSelectedModules(
  c: Context<{ Bindings: Env }>,
  params: { portalId: string; idempotencyKey: string; guard: HoldGuard },
): Promise<Response> {
  const { portalId, idempotencyKey, guard } = params;
  const env = c.env;
  const parentEventId = c.req.param('slug') as string;

  const parentEvent = await loadEvent(env.DB, portalId, parentEventId);
  if (!parentEvent) throw new ReserveError('event_not_found', 'Event not found', 404);
  if (parentEvent.parent_event_id !== null || parentEvent.booking_kind !== 'course') {
    throw new ReserveError(
      'not_a_parent_course',
      'Selected-module booking is only available on a parent course.',
      400,
    );
  }

  // ---- Sales window (migration 0038) --------------------------------------
  // The same gate doReserve applies, on the route that had none. This handler is public
  // and unauthenticated, so without it a cutoff or a hand-set pause on the course stopped
  // its single-session and complete-course checkouts and left this one selling — which is
  // the cutoff not existing for anyone who reached the course page's module selector.
  // There is no staff exemption to carry over: selected-module checkout has no
  // `staff_manual` caller, and staff book modules through the manage path.
  const parentRejection = salesWindowRejection(resolveSalesWindow(parentEvent));
  if (parentRejection) {
    throw new ReserveError(parentRejection.status, parentRejection.message, 409);
  }

  let body: ReserveBody;
  try {
    body = await c.req.json<ReserveBody>();
  } catch {
    throw new ReserveError('invalid_body', 'Request body must be valid JSON', 400);
  }
  // As in doReserve: the catch that answers a refusal is a frame up and cannot see this.
  rememberBuyerEmail(c, body);

  if (!body.buyer?.email || !body.buyer?.name) {
    throw new ReserveError('invalid_buyer', 'buyer.email and buyer.name are required', 400);
  }
  body.buyer.email = body.buyer.email.trim();
  body.buyer.name = body.buyer.name.trim();

  const requestedModules = Array.isArray(body.selectedModules) ? body.selectedModules : [];
  if (requestedModules.length === 0) {
    throw new ReserveError(
      'no_selected_modules',
      'Select at least one module before continuing.',
      400,
    );
  }
  if (requestedModules.length > 12) {
    throw new ReserveError(
      'too_many_selected_modules',
      'Too many modules were selected for one checkout.',
      400,
    );
  }
  if (body.attendees && body.attendees.length > 0) {
    throw new ReserveError(
      'selected_modules_attendees_not_supported',
      'Selected-module checkout currently supports one buyer/attendee.',
      400,
    );
  }
  if (body.offerToken || body.redeemVouchers) {
    throw new ReserveError(
      'selected_modules_option_not_supported',
      'Selected-module checkout does not support this booking option yet.',
      400,
    );
  }

  const seenModules = new Set<string>();
  for (const module of requestedModules) {
    const eventId = module?.eventId?.trim();
    const ticketTypeId = module?.ticketTypeId?.trim();
    if (!eventId || !ticketTypeId) {
      throw new ReserveError(
        'invalid_selected_module',
        'Each selected module needs an event id and ticket type id.',
        400,
      );
    }
    if (seenModules.has(eventId)) {
      throw new ReserveError(
        'duplicate_selected_module',
        'Each module can only be selected once per checkout.',
        409,
      );
    }
    seenModules.add(eventId);
  }

  const components = await loadCourseComponents(env.DB, portalId, parentEvent.id);
  const componentById = new Map(components.map((component) => [component.id, component]));
  const membership = await resolveMembership(env, portalId, body.buyer.email, {
    memberCompanyId: body.memberCompanyId,
  });
  const attendee: Attendee = {
    email: body.buyer.email,
    name: body.buyer.name,
    ticketTypeId: '',
    hubspotContactId: body.buyer.hubspotContactId,
    phone: body.buyer.phone,
    suburb: body.buyer.suburb,
    state: body.buyer.state,
  };

  // ---- Parent course questions --------------------------------------------
  // Before any hold, for the reason spelled out in doReserve: a paid hold runs to the
  // invoice due date, so a booking rejected after taking one strands child seats for
  // weeks. The child components are refused outright if they carry questions (below);
  // the PARENT's order-scoped questions are the course's own checkout fields (a required
  // PO number, say) and were neither validated nor stored, so a required one could be
  // skipped and any supplied answer was silently discarded.
  const parentQuestions = await loadEventQuestions(env, portalId, parentEvent.id);
  let orderAnswers: PreparedAnswer[] = [];
  if (parentQuestions.length > 0) {
    if (parentQuestions.some((question) => question.scope === 'attendee')) {
      // Per-attendee answers belong to a seat, and a selected-module order's seats are
      // the child modules. Refuse rather than guess which module an answer describes.
      throw new ReserveError(
        'selected_modules_questions_not_supported',
        'This course asks per-attendee registration questions. Please book it as a complete course.',
        409,
      );
    }
    try {
      orderAnswers = validateAnswers({
        questions: parentQuestions,
        scope: 'order',
        supplied: body.answers,
      });
    } catch (err) {
      if (err instanceof QuestionValidationError) {
        throw new ReserveError(err.status, err.message, 400);
      }
      throw err;
    }
  }

  const preparedModules: Array<{
    event: EventRow;
    ticketType: TicketTypeRow;
    attendee: Attendee;
    unitCents: number;
  }> = [];

  for (const requested of requestedModules) {
    const eventId = requested.eventId.trim();
    const ticketTypeId = requested.ticketTypeId.trim();
    const component = componentById.get(eventId);
    if (!component) {
      throw new ReserveError(
        'invalid_selected_module',
        'One selected module does not belong to this course.',
        400,
      );
    }

    // Each selected module is a separately sold session with its own cutoff and its own
    // pause, so the parent's window does not answer for it: a course still selling can
    // carry a module that ran last week. Named, because "one module is unavailable" is
    // not something a buyer can act on with twelve tickboxes on the page.
    const moduleRejection = salesWindowRejection(resolveSalesWindow(component));
    if (moduleRejection) {
      throw new ReserveError(
        moduleRejection.status,
        moduleRejection.status === 'sales_paused'
          ? `Bookings for "${component.title}" are temporarily on hold. Please check back shortly.`
          : `Registrations for "${component.title}" have closed.`,
        409,
      );
    }

    const questions = await loadEventQuestions(env, portalId, component.id);
    if (questions.length > 0) {
      throw new ReserveError(
        'selected_modules_questions_not_supported',
        'One selected module needs extra registration questions. Please book it separately.',
        409,
      );
    }

    const ticketTypes = await loadTicketTypes(env.DB, component.id);
    if (ticketTypes.length === 0) {
      throw new ReserveError(
        'no_ticket_types',
        `Module "${component.title}" has no ticket types configured.`,
        404,
      );
    }
    const ticketType = ticketTypes.find((ticket) => ticket.id === ticketTypeId);
    if (!ticketType) {
      throw new ReserveError(
        'invalid_ticket_type',
        `Unknown ticket type for module "${component.title}".`,
        400,
      );
    }
    if (ticketType.internal_only || isPublicImportTicket(ticketType.id, ticketType.name)) {
      throw new ReserveError(
        'ticket_not_available',
        'This ticket type is not available for public registration.',
        403,
      );
    }
    // A single ticket type taken off sale, as doReserve checks for a single-session
    // booking. The module's own window above does not cover it: pausing "early bird"
    // leaves the module selling on its other types.
    if (ticketTypePaused(ticketType)) {
      throw new ReserveError(
        'ticket_sales_paused',
        `Bookings for "${component.title}" are temporarily on hold.`,
        409,
      );
    }

    const allMemberOnly = ticketTypes.every((ticket) => ticket.member_only);
    if (allMemberOnly || ticketType.member_only) {
      if (!membership.verified) {
        throw new ReserveError(
          'membership_unverified',
          'Membership status could not be verified. Please contact support',
        );
      }
      if (!membership.isMember) {
        throw new ReserveError(
          'members_only',
          `Ticket type "${ticketType.name}" is for members only`,
        );
      }
    }

    const moduleAttendee = normaliseAttendees([{ ...attendee, ticketTypeId: ticketType.id }])[0];
    await assertNoDuplicateAttendeeEmails(env, portalId, component.id, [moduleAttendee], {
      allowDuplicateAttendees: membership.isMember && membership.level === 'gold',
    });

    const unitCents = await resolvePrice(env, {
      portalId,
      eventId: component.id,
      // Without this a module whose HubDB row never had `worker_event_id` filled in
      // cannot be found by the pricing read at all, so it silently drops to
      // `pricing_rules`, the stale second copy, and disagrees with the page.
      hubspotEventId: component.hubspot_event_id,
      ticketType,
      isMember: membership.isMember,
      level: membership.level,
      category: membership.category,
    });
    // Same DIRECTIONAL guard the single-seat path uses (see comparePriceQuote). This
    // compared for exact equality, so a module resolving BELOW the quoted price (the
    // buyer paying less than they were shown) failed the whole booking. Nothing is
    // different about a module that would justify turning that into a refusal.
    if (typeof requested.expectedUnitCents === 'number') {
      const outcome = comparePriceQuote(requested.expectedUnitCents, [unitCents]);
      if (outcome !== 'match') {
        console.log(
          JSON.stringify({
            level: 'warn',
            event: 'price_drift',
            outcome,
            scope: 'selected_module',
            portalId,
            eventId: component.id,
            buyerEmail: body.buyer.email,
            expectedUnitCents: requested.expectedUnitCents,
            resolvedUnitCents: [unitCents],
            memberTier: body.memberTier ?? null,
            memberCompanyId: body.memberCompanyId ?? null,
            isMember: membership.isMember,
            membershipVerified: membership.verified,
            memberLevel: membership.level,
            memberCategory: membership.category,
          }),
        );
      }
      if (outcome === 'rejected') {
        throw new ReserveError(
          'price_mismatch',
          'The course price changed before checkout. Please refresh the page and try again.',
          409,
        );
      }
    }

    preparedModules.push({ event: component, ticketType, attendee: moduleAttendee, unitCents });
  }

  preparedModules.sort((a, b) => {
    const aOrder = a.event.course_component_order ?? Number.MAX_SAFE_INTEGER;
    const bOrder = b.event.course_component_order ?? Number.MAX_SAFE_INTEGER;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return (
      a.event.starts_at.localeCompare(b.event.starts_at) || a.event.id.localeCompare(b.event.id)
    );
  });

  const lineItems = preparedModules.map(
    ({ event, ticketType, unitCents }): LineItem => ({
      ticketTypeId: ticketType.id,
      name: formatBookingLineItemName(event.title, ticketType.name),
      quantity: 1,
      unitCents,
      totalCents: unitCents,
      taxTreatment: ticketType.tax_treatment,
      hsTaxRateId: ticketType.hs_tax_rate_id,
      hsProductId: ticketType.hs_product_id ?? event.course_module_product_id,
    }),
  );
  const totalCents = lineItems.reduce((sum, li) => sum + li.totalCents, 0);
  if (totalCents === 0) {
    throw new ReserveError(
      'selected_modules_payment_required',
      'Selected-module checkout currently requires paid module tickets.',
      409,
    );
  }
  // Directional, for the reason above: a bundle that resolves cheaper than the page
  // quoted is honoured, never refused. Exact equality here also made the per-module
  // `honoured_lower` outcome unreachable, since a honoured-lower module always lands the
  // total below what the checkout displayed.
  //
  // A lower total is LOGGED as well as honoured. `expectedUnitCents` is optional per
  // module, so a caller sending only the total is the one case where nothing else on this
  // path would record the drift, and a booking invoiced under the displayed price with no
  // trace of why is the hardest kind to investigate afterwards.
  if (typeof body.expectedTotalCents === 'number' && totalCents !== body.expectedTotalCents) {
    const totalOutcome = totalCents > body.expectedTotalCents ? 'rejected' : 'honoured_lower';
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'price_drift',
        outcome: totalOutcome,
        scope: 'selected_modules_total',
        portalId,
        eventId: parentEvent.id,
        buyerEmail: body.buyer.email,
        expectedTotalCents: body.expectedTotalCents,
        resolvedTotalCents: totalCents,
        isMember: membership.isMember,
        membershipVerified: membership.verified,
        memberLevel: membership.level,
        memberCategory: membership.category,
      }),
    );
    if (totalOutcome === 'rejected') {
      throw new ReserveError(
        'price_mismatch',
        'The course price changed before checkout. Please refresh the page and try again.',
        409,
      );
    }
  }

  const paymentConfig = await env.DB.prepare(
    'SELECT stripe_processor_connected, xero_gst_rate_id FROM tenants WHERE portal_id = ?1',
  )
    .bind(portalId)
    .first<{ stripe_processor_connected: number; xero_gst_rate_id: string | null }>();
  if (!paymentConfig?.stripe_processor_connected || !paymentConfig.xero_gst_rate_id) {
    throw new ReserveError(
      'payment_not_configured',
      'Online payment configuration is still being finalised. Please contact training support.',
      409,
    );
  }
  for (const li of lineItems) {
    if (!li.hsTaxRateId && !isGstFreeTreatment(li.taxTreatment)) {
      li.hsTaxRateId = paymentConfig.xero_gst_rate_id;
    }
  }

  const eligibility = await resolveInvoiceEligibility(env, {
    portalId,
    buyerEmail: body.buyer.email,
    membership,
    memberCompanyId: body.memberCompanyId?.trim() || null,
    totalCents,
  });
  const dueDays =
    eligibility.method === 'invoice'
      ? (clampInvoiceDueDays(parentEvent.invoice_due_days) ??
        clampInvoiceDueDays(eligibility.termsDays) ??
        (await loadPortalInvoiceDueDays(env, portalId)) ??
        DEFAULT_INVOICE_DUE_DAYS)
      : DEFAULT_INVOICE_DUE_DAYS;
  const invoiceDue = resolveInvoiceDueDate(
    eligibility.method === 'card' ? dateOnly(0) : undefined,
    dueDays,
  );
  const holdExpiresAt =
    eligibility.method === 'invoice' && eligibility.holdMs
      ? new Date(Date.now() + eligibility.holdMs).toISOString()
      : eligibility.method === 'invoice'
        ? invoiceDue.expiresAt
        : null;
  const paymentTermsDays = daysUntilDate(invoiceDue.date);

  console.log(
    JSON.stringify({
      level: 'info',
      event: 'selected_modules_invoice_eligibility_resolved',
      portalId,
      eventId: parentEvent.id,
      buyerEmail: body.buyer.email,
      selectedModuleEventIds: preparedModules.map((module) => module.event.id),
      totalCents,
      method: eligibility.method,
      reason: eligibility.reason,
      ruleId: eligibility.ruleId,
      invoiceDueDate: invoiceDue.date,
      holdExpiresAt,
    }),
  );

  const holdResult = await holdCourseModuleSelection({
    env,
    portalId,
    components: preparedModules.map((module) => ({
      event: module.event,
      ticketType: module.ticketType,
      unitCents: module.unitCents,
    })),
    ...(holdExpiresAt ? { expiresAt: holdExpiresAt } : {}),
  });
  if (!holdResult.ok) {
    throw new ReserveError(
      holdResult.status,
      holdResult.status === 'course_component_full'
        ? 'One selected module is no longer available.'
        : holdResult.status === 'capacity_unconfirmed'
          ? 'We could not confirm seat availability just now. Please try again in a moment.'
          : 'One selected module is not configured for checkout yet.',
      holdResult.status === 'capacity_unconfirmed' ? 503 : 409,
    );
  }
  guard.bundleHolds = holdResult.holds;

  const now = new Date().toISOString();
  const orderId = crypto.randomUUID();
  const registrationIds = preparedModules.map(() => crypto.randomUUID());
  const joinUrlOutboxIds = preparedModules.map(() => crypto.randomUUID());

  // ---- Webinar provisioning per selected module (online modules) -----------
  // Each selected module is its own event and gets its own registration row and its own
  // me.register, so an online one needs its own provider registration too. Without this
  // the seat is sold, HubSpot sends the confirmation, and the attendee has no join URL,
  // and the personal URL has to reach the contact BEFORE that workflow fires.
  const moduleTeamsResults = preparedModules.map(() => ({
    teamsRegistrationId: null as string | null,
    teamsJoinUrl: null as string | null,
  }));
  for (let i = 0; i < preparedModules.length; i++) {
    const moduleEvent = preparedModules[i].event;
    if (moduleEvent.provider === null) continue;
    let webinarId = moduleEvent.teams_webinar_id;
    let webinarJoinUrl = moduleEvent.teams_join_url;
    if (!webinarId) {
      const provisioned = await provisionWebinarIfNeeded(env, portalId, moduleEvent);
      webinarId = provisioned?.teamsWebinarId ?? null;
      webinarJoinUrl = provisioned?.teamsJoinUrl ?? null;
    }
    if (!webinarId) continue;
    moduleTeamsResults[i] = await registerAttendeeInTeams(
      env,
      portalId,
      moduleEvent.provider,
      webinarId,
      preparedModules[i].attendee,
      registrationIds[i],
      webinarJoinUrl,
    );
    if (moduleTeamsResults[i].teamsRegistrationId) {
      guard.providerRegistrations.push({
        providerName: moduleEvent.provider,
        webinarId,
        providerRegistrationId: moduleTeamsResults[i].teamsRegistrationId as string,
      });
    }
  }
  const meRegisterOutboxIds = preparedModules.map(() => crypto.randomUUID());
  const contactDetailOutboxIds = preparedModules.map(() => crypto.randomUUID());
  const dealOutboxId = crypto.randomUUID();
  const invoiceOutboxId = crypto.randomUUID();
  const contactDetails = captureContactDetails(preparedModules.map((module) => module.attendee));
  const idemExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const responseBody = {
    status: 'reserved',
    orderId,
    registrationIds,
    pollUrl: `/api/v1/orders/${orderId}`,
  };

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO orders
         (id, portal_id, event_id, reservation_id, status,
          buyer_email, buyer_name, buyer_abn, total_cents, currency, member_company_id,
          voucher_seats_redeemed, voucher_credit_cents,
          payment_method, payment_terms_days, created_at, updated_at)
       VALUES (?1, ?2, ?3, NULL, 'pending', ?4, ?5, ?6, ?7, 'AUD', ?8, 0, 0, ?9, ?10, ?11, ?11)`,
    ).bind(
      orderId,
      portalId,
      parentEvent.id,
      body.buyer.email,
      body.buyer.name,
      body.buyer.abn ?? null,
      totalCents,
      body.memberCompanyId?.trim() || null,
      eligibility.method,
      eligibility.method === 'invoice' ? paymentTermsDays : null,
      now,
    ),
    ...courseModuleSelectionHoldStatements({
      env,
      portalId,
      orderId,
      idempotencyKey,
      holds: holdResult.holds,
      createdAt: now,
    }),
  ];

  for (let i = 0; i < preparedModules.length; i++) {
    const module = preparedModules[i];
    const registrationId = registrationIds[i];
    const attendeeForModule = module.attendee;
    const moduleContact = contactDetails.values[i];
    stmts.push(
      env.DB.prepare(
        `INSERT INTO registrations
           (id, portal_id, order_id, event_id, ticket_type_id, hubspot_contact_id,
            attendee_email, attendee_name,
            attendee_phone, attendee_suburb, attendee_state,
            unit_cents, voucher_seats, voucher_cents,
            teams_registration_id, teams_join_url,
            created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0, 0, ?13, ?14, ?15, ?15)`,
      ).bind(
        registrationId,
        portalId,
        orderId,
        module.event.id,
        module.ticketType.id,
        attendeeForModule.hubspotContactId ?? null,
        attendeeForModule.email,
        attendeeForModule.name,
        moduleContact.phone,
        moduleContact.suburb,
        moduleContact.state,
        module.unitCents,
        moduleTeamsResults[i].teamsRegistrationId,
        moduleTeamsResults[i].teamsJoinUrl,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO outbox (id, portal_id, topic, payload, stable_interaction_datetime, created_at)
         VALUES (?1, ?2, 'me.register', ?3, ?4, ?5)`,
      ).bind(
        meRegisterOutboxIds[i],
        portalId,
        JSON.stringify({
          registrationId,
          attendeeEmail: attendeeForModule.email,
          hubspotContactId: attendeeForModule.hubspotContactId ?? null,
          hubspotEventId: module.event.hubspot_event_id,
          externalAccountId: portalId,
          ticketTypeId: module.ticketType.id,
        }),
        now,
        now,
      ),
    );
    if (contactDetails.anyCaptured[i]) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
           VALUES (?1, ?2, 'contact.sync_attendee_details', ?3, ?4)`,
        ).bind(
          contactDetailOutboxIds[i],
          portalId,
          JSON.stringify({
            registrationId,
            eventId: module.event.id,
            attendeeEmail: attendeeForModule.email,
            attendeeName: attendeeForModule.name,
            hubspotContactId: attendeeForModule.hubspotContactId ?? null,
            details: moduleContact,
          }),
          now,
        ),
      );
    }
    if (moduleTeamsResults[i].teamsJoinUrl) {
      // HubSpot renders the calendar invite and the confirmation email, so the personal
      // join URL has to be on the contact before that workflow fires (CLAUDE.md).
      stmts.push(
        env.DB.prepare(
          `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
           VALUES (?1, ?2, 'contact.set_join_url', ?3, ?4)`,
        ).bind(
          joinUrlOutboxIds[i],
          portalId,
          JSON.stringify({
            registrationId,
            attendeeEmail: attendeeForModule.email,
            hubspotContactId: attendeeForModule.hubspotContactId ?? null,
            teamsJoinUrl: moduleTeamsResults[i].teamsJoinUrl,
          }),
          now,
        ),
      );
    }
  }

  stmts.push(
    env.DB.prepare(
      `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
       VALUES (?1, ?2, 'deal.create', ?3, ?4)`,
    ).bind(
      dealOutboxId,
      portalId,
      JSON.stringify({
        orderId,
        eventId: parentEvent.id,
        hubspotEventId: parentEvent.hubspot_event_id,
        bookingKind: parentEvent.booking_kind ?? 'course',
        buyerEmail: body.buyer.email,
        buyerName: body.buyer.name,
        buyerAbn: body.buyer.abn ?? null,
        buyerHubspotContactId: body.buyer.hubspotContactId ?? null,
        totalCents,
        lineItems,
        attendees: preparedModules.map((module) => ({
          email: module.attendee.email,
          name: module.attendee.name,
          ticketTypeId: module.ticketType.id,
          hubspotContactId: module.attendee.hubspotContactId ?? null,
        })),
        source: 'public_checkout',
        manualRegistration: false,
        complimentary: false,
        invoiceRequired: true,
        paymentRequired: true,
      }),
      now,
    ),
    env.DB.prepare(
      `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
       VALUES (?1, ?2, 'invoice.create', ?3, ?4)`,
    ).bind(
      invoiceOutboxId,
      portalId,
      JSON.stringify({
        orderId,
        eventId: parentEvent.id,
        hubspotEventId: parentEvent.hubspot_event_id,
        buyerEmail: body.buyer.email,
        buyerName: body.buyer.name,
        buyerAbn: body.buyer.abn ?? null,
        totalCents,
        currency: 'AUD',
        invoiceDueDate: invoiceDue.date,
        lineItems,
      }),
      now,
    ),
    ...answerStatements(env, { portalId, orderId, answers: orderAnswers, createdAt: now }),
    // Deliberately NOT `OR IGNORE`, unlike doReserve's copy. There the replay guard is
    // reservations.idempotency_key, which doReserve populates with this same header value;
    // here that index is the guard too (see courseModuleSelectionHoldStatements), and this
    // plain INSERT is the second belt. Reaching it with the row already present means a
    // concurrent duplicate (the replay SELECT above has already returned for a real retry)
    // so aborting the batch is the correct outcome, not skipping one statement.
    env.DB.prepare(
      `INSERT INTO idempotency_keys
         (id, portal_id, key, request_hash, response_status, response_body, expires_at, created_at)
       VALUES (?1, ?2, ?3, '', 200, ?4, ?5, ?6)`,
    ).bind(
      crypto.randomUUID(),
      portalId,
      idempotencyKey,
      JSON.stringify(responseBody),
      idemExpiresAt,
      now,
    ),
  );

  await env.DB.batch(stmts);
  guard.committed = true;

  try {
    const signals: { body: Record<string, unknown> }[] = preparedModules.map((_, i) => ({
      body: {
        kind: 'me.register',
        portalId,
        outboxId: meRegisterOutboxIds[i],
        registrationId: registrationIds[i],
      },
    }));
    for (let i = 0; i < preparedModules.length; i++) {
      if (!contactDetails.anyCaptured[i]) continue;
      signals.push({
        body: {
          kind: 'contact.sync_attendee_details',
          portalId,
          outboxId: contactDetailOutboxIds[i],
          registrationId: registrationIds[i],
        },
      });
    }
    for (let i = 0; i < preparedModules.length; i++) {
      if (!moduleTeamsResults[i].teamsJoinUrl) continue;
      signals.push({
        body: {
          kind: 'contact.set_join_url',
          portalId,
          outboxId: joinUrlOutboxIds[i],
          registrationId: registrationIds[i],
        },
      });
    }
    signals.push(
      { body: { kind: 'deal.create', portalId, outboxId: dealOutboxId, orderId } },
      { body: { kind: 'invoice.create', portalId, outboxId: invoiceOutboxId, orderId } },
    );
    await env.QUEUE.sendBatch(signals);
  } catch {
    // swallow: cron will catch pending outbox rows
  }

  return c.json(responseBody, 200);
}

// ---------------------------------------------------------------------------
// GET /api/v1/events/:slug/course-components
// ---------------------------------------------------------------------------

/**
 * Public, read-only course-component catalogue for the course page. It exposes
 * only commercially necessary booking information: a module's Product ID, its
 * child Event Engine ID, schedule, and public ticket choices. The browser still
 * calls the normal child-event availability and reserve endpoints, so live seat
 * capacity remains owned by the EventCapacity Durable Object.
 */
export async function handleGetCourseComponents(c: Context<{ Bindings: Env }>): Promise<Response> {
  const limited = await checkRateLimit(c, {
    prefix: 'rl:course-components',
    limit: 60,
    windowSeconds: 60,
  });
  if (limited) return limited;

  const portalId = c.req.header('X-Portal-Id');
  if (!portalId) {
    return c.json({ status: 'missing_portal_id', message: 'X-Portal-Id header required' }, 400);
  }

  const slug = c.req.param('slug') as string;
  const course = await loadEvent(c.env.DB, portalId, slug);
  if (!course) return c.json({ status: 'event_not_found', message: 'Event not found' }, 404);
  if (course.parent_event_id !== null || course.booking_kind !== 'course') {
    return c.json(
      {
        status: 'not_a_parent_course',
        message: 'Course components belong to a top-level course event',
      },
      400,
    );
  }

  const components = await loadCourseComponents(c.env.DB, portalId, course.id);
  return c.json({
    courseEventId: course.id,
    components: await Promise.all(
      components.map(async (component) => {
        const ticketTypes = await loadTicketTypes(c.env.DB, component.id);
        return {
          workerEventId: component.id,
          moduleProductId: component.course_module_product_id,
          kind: component.course_component_kind,
          order: component.course_component_order,
          includedInCoursePackage: Boolean(component.course_package_required),
          title: component.title,
          startsAt: component.starts_at,
          endsAt: component.ends_at,
          location: component.location,
          ticketTypes: ticketTypes
            .filter(
              (ticketType) =>
                !ticketType.internal_only && !isPublicImportTicket(ticketType.id, ticketType.name),
            )
            .map((ticketType) => ({
              ticketTypeId: ticketType.id,
              name: ticketType.name,
              priceCents: ticketType.price_cents,
              currency: ticketType.currency,
              memberOnly: Boolean(ticketType.member_only),
            })),
        };
      }),
    ),
  });
}

// ---------------------------------------------------------------------------
// GET /api/v1/events/:slug/questions
// ---------------------------------------------------------------------------

/**
 * The custom questions a registration form for this event must render (Phase 2.3).
 *
 * Public, and deliberately DEFINITIONS ONLY: no answers, for anyone. The prefill half of
 * "you should not have to type this again" is delivered through `hsProperty`: the CMS owns
 * the front end and knows which contact it is rendering for, so it populates the field from
 * the visitor's own HubSpot contact. The worker does not know who is on the other end of an
 * unauthenticated request, and an endpoint here that answered `?email=` with someone's
 * dietary requirements would hand out contact data to anyone who could guess an address.
 * Staff booking on someone's behalf use the admin-authed prefill lookup instead.
 */
export async function handleGetEventQuestions(c: Context<{ Bindings: Env }>): Promise<Response> {
  const portalId = c.req.header('X-Portal-Id');
  if (!portalId) {
    return c.json({ status: 'missing_portal_id', message: 'X-Portal-Id header required' }, 400);
  }

  const slug = c.req.param('slug') as string;
  const event = await loadEvent(c.env.DB, portalId, slug);
  if (!event) return c.json({ status: 'event_not_found', message: 'Event not found' }, 404);

  return c.json({
    eventId: event.id,
    questions: await loadEventQuestions(c.env, portalId, event.id),
  });
}

// ---------------------------------------------------------------------------
// Duplicate registration guard
// ---------------------------------------------------------------------------

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normaliseAttendees(attendees: Attendee[]): Attendee[] {
  return attendees.map((attendee) => ({
    ...attendee,
    email: attendee.email?.trim() ?? '',
    name: attendee.name?.trim() ?? '',
    ticketTypeId: attendee.ticketTypeId?.trim() ?? '',
  }));
}

/**
 * Contact details (phone/suburb/state) per attendee, in reserve order. Absent fields stay
 * null, so the registration records "never asked" rather than an empty answer, and only an
 * attendee with at least one captured value produces a write-back row.
 */
function captureContactDetails(attendees: Attendee[]): {
  values: AttendeeContactValues[];
  anyCaptured: boolean[];
} {
  const normalised = attendees.map((attendee) => normaliseContactDetails(attendee));
  return {
    values: normalised.map((entry) => entry.values),
    anyCaptured: normalised.map((entry) => entry.any),
  };
}

export async function assertNoDuplicateAttendeeEmails(
  env: Env,
  portalId: string,
  eventId: string,
  attendees: Attendee[],
  options: { allowDuplicateAttendees?: boolean } = {},
): Promise<void> {
  const uniqueEmails: string[] = [];
  const seen = new Set<string>();

  for (const attendee of attendees) {
    // A seat held without a name (Ref 74b) has nobody to collide with. It still needs a
    // ticket type (that is what it is a seat OF) but it is invisible to this guard until
    // an amend attaches an email, and the amend runs the same check then.
    if (attendee.unnamed) {
      if (!attendee.ticketTypeId) {
        throw new ReserveError('invalid_attendee', 'Every seat needs a ticket type.', 400);
      }
      continue;
    }
    if (!attendee.email || !attendee.name || !attendee.ticketTypeId) {
      throw new ReserveError(
        'invalid_attendee',
        'Each attendee needs a name, email address, and ticket type.',
        400,
      );
    }

    const email = normaliseEmail(attendee.email);
    if (!email) {
      throw new ReserveError('invalid_attendee', 'Each attendee needs an email address.', 400);
    }

    if (!options.allowDuplicateAttendees && seen.has(email)) {
      // THIS booking lists the same address twice, which is a different fault from
      // "somebody already holds a seat" and needs a different sentence. The CMS events
      // widget expanded a quantity of N into N attendees all carrying the BUYER's own
      // email (its attendee fields were hidden inputs nobody could fill), so a
      // first-time buyer asking for two seats was told their brand-new address was
      // "already registered for this event" — true of nothing, and unactionable. The
      // widget asks for the other people now; this names what is wrong for every other
      // caller that gets it wrong, including the ones we do not write.
      throw new ReserveError(
        'duplicate_attendee_in_booking',
        'Each place needs its own attendee email address. ' +
          `"${email}" is listed more than once in this booking.`,
        409,
      );
    }

    seen.add(email);
    uniqueEmails.push(email);
  }

  if (options.allowDuplicateAttendees) return;
  if (uniqueEmails.length === 0) return;

  // Cancelled seats are excluded: cancel-then-rebook is a supported story (it is exactly
  // why the seat/person counts in the 2.2 report are allowed to diverge), and a seat that
  // was given back must not go on blocking the person who gave it back from booking again.
  // Its booking is usually still 'paid' on behalf of colleagues who are still coming, so
  // the order status alone cannot tell the two apart.

  const emailPlaceholders = uniqueEmails.map((_, index) => `?${index + 3}`).join(', ');
  const statusPlaceholders = ACTIVE_REGISTRATION_ORDER_STATUSES.map(
    (_, index) => `?${index + 3 + uniqueEmails.length}`,
  ).join(', ');

  const existing = await env.DB.prepare(
    `SELECT r.attendee_email
       FROM registrations r
       JOIN orders o ON o.id = r.order_id AND o.portal_id = r.portal_id
      WHERE r.portal_id = ?1
        AND r.event_id = ?2
        AND lower(trim(r.attendee_email)) IN (${emailPlaceholders})
        AND o.status IN (${statusPlaceholders})
        AND r.cancelled_at IS NULL
      LIMIT 1`,
  )
    .bind(portalId, eventId, ...uniqueEmails, ...ACTIVE_REGISTRATION_ORDER_STATUSES)
    .first<{ attendee_email: string }>();

  if (existing) {
    throw new ReserveError(
      'duplicate_attendee',
      'This attendee email is already registered for this event.',
      409,
    );
  }
}

/** What to do about a quoted price that no longer matches what the Worker resolved. */
export type PriceQuoteOutcome = 'match' | 'honoured_lower' | 'rejected';

/**
 * Compare the per-seat price the checkout displayed against the prices the Worker
 * resolved, and say whether the booking may proceed.
 *
 * Deliberately asymmetric. Both sides price from the same HubDB course row now
 * (../pricing.ts), so a difference means the buyer's page went stale while they filled
 * the form, not that either number is suspect:
 *   - resolved above the quote → 'rejected'. We never invoice more than we displayed.
 *   - resolved below the quote → 'honoured_lower'. The buyer pays the lower resolved
 *     price; the invoice is internally consistent and nobody is turned away at the till.
 *
 * The symmetric version of this check is what turned every gap in `pricing_rules` into a
 * failed booking and the "The course price changed before checkout" reports.
 */
/** What the price-quote check decided, or null when there is nothing to compare. */
export interface PriceQuoteDecision {
  expectedUnitCents: number;
  resolvedUnitCents: number[];
  outcome: PriceQuoteOutcome;
  /** True when a mismatch is allowed to refuse the booking. */
  enforced: boolean;
  /** True only for an enforced rejection. */
  reject: boolean;
}

/**
 * Which displayed price to compare against, and whether a mismatch may refuse.
 *
 * Two fields carry the page's price and they mean different things:
 *
 *   `expectedUnitCents` ENFORCES. A resolved price above it refuses the booking, because
 *   invoicing more than was displayed is never acceptable. The CMS sends it for a buyer
 *   it believes is a member.
 *
 *   `quotedUnitCents` only MEASURES. Same comparison, same log, no refusal. It exists
 *   because a GUEST sent neither: the page could display one amount and the invoice
 *   carry another with nothing anywhere noticing, which is a money bug on the most
 *   common path through the checkout. It was the first step of closing that - measure
 *   the drift, refuse nothing - and the CMS now sends guests the enforcing field, both
 *   sides pricing a guest from one HubDB row. The measuring field stays for callers we
 *   do not write.
 *
 * `expectedUnitCents` wins when both arrive: a caller asking to be held to its number
 * is not overridden by also reporting one.
 *
 * A comped/free booking compares nothing — there is no price to disagree about.
 */
export function decidePriceQuote(input: {
  forceFree: boolean;
  expectedUnitCents?: number;
  quotedUnitCents?: number;
  resolvedUnitCents: number[];
}): PriceQuoteDecision | null {
  if (input.forceFree) return null;

  const enforced = typeof input.expectedUnitCents === 'number';
  const expectedUnitCents = enforced ? input.expectedUnitCents : input.quotedUnitCents;
  if (typeof expectedUnitCents !== 'number') return null;

  const outcome = comparePriceQuote(expectedUnitCents, input.resolvedUnitCents);
  return {
    expectedUnitCents,
    resolvedUnitCents: input.resolvedUnitCents,
    outcome,
    enforced,
    reject: outcome === 'rejected' && enforced,
  };
}

export function comparePriceQuote(
  expectedUnitCents: number,
  resolvedUnitCents: number[],
): PriceQuoteOutcome {
  if (resolvedUnitCents.some((cents) => cents === expectedUnitCents)) return 'match';
  if (resolvedUnitCents.some((cents) => cents > expectedUnitCents)) return 'rejected';
  return 'honoured_lower';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fire the fast-sell-out check without making the buyer wait for it. Outside the
 * 30-minute window the check is a date comparison that returns immediately, so the
 * fallback of awaiting it inline (no execution context, e.g. under test) is cheap.
 */
function backgroundFlagFastSellout(
  c: Context<{ Bindings: Env }>,
  env: Env,
  portalId: string,
  event: EventRow,
): void {
  const pending = maybeFlagFastSellout(env, portalId, event);
  try {
    c.executionCtx.waitUntil(pending);
  } catch {
    // No execution context available; the promise still settles on its own and
    // maybeFlagFastSellout never rejects.
  }
}

async function persistIdempotencyKey(
  env: Env,
  portalId: string,
  key: string,
  status: number,
  body: unknown,
): Promise<void> {
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO idempotency_keys
       (id, portal_id, key, request_hash, response_status, response_body, expires_at, created_at)
     VALUES (?1, ?2, ?3, '', ?4, ?5, ?6, ?7)`,
  )
    .bind(crypto.randomUUID(), portalId, key, status, JSON.stringify(body), expiresAt, now)
    .run();
}
