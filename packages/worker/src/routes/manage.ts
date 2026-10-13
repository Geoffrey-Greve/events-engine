import type { QuestionAnswers } from '@paddock/shared';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { amendRegistration } from '../amend';
import {
  ATTENDANCE_FIELDS,
  attendancePropertyFor,
  listEventAttendance,
  loadAttendanceContactConfig,
  summariseAttendance,
} from '../attendance-writeback';
import { cancelRegistration } from '../cancel';
import { parseCapacity } from '../capacity-guard';
import { syncCapacityFromD1 } from '../capacity-sync';
import { authenticateAdmin } from '../checkin';
import { getSecret } from '../config';
import {
  type CourseComponentKind,
  type EventRow,
  effectiveCapacity,
  loadCourseComponents,
  loadEvent,
  loadTicketTypes,
  type TicketTypeRow,
} from '../db';
import { listPendingDecisions, resolveDecision } from '../decisions';
import { DEFAULT_EXPORT_TTL_SECONDS, issueExportToken } from '../exports';
import { loadHubDbCapacitySources, syncEventCapacityFromHubDb } from '../hubdb-capacity';
import {
  columnForLevel,
  DISCOUNT_COLUMN_KEYS,
  fetchHubDbPricingRow,
  type HubDbPricingSourceKind,
  loadHubDbPricingColumns,
  loadHubDbPricingSources,
  type MemberPriceLevel,
  PRICE_COLUMN_KEYS,
  readHubDbTierPrices,
  stripBlankColumnNames,
  stripBlankDiscountColumnNames,
} from '../hubdb-pricing';
import { getAccessToken } from '../hubspot-oauth';
import {
  INVOICE_ELIGIBILITY_MATCH_KINDS,
  type InvoiceEligibilityMatchKind,
} from '../invoice-eligibility';
import {
  isConfigName,
  loadMembershipConfig,
  MEMBER_CATEGORIES,
  type MembershipConfig,
  parseCompanySources,
  parseMemberDirectoryConfig,
  resolveHubSpotReadToken,
  resolveMembership,
} from '../membership';
import { addStaffNote, listEventStaffNotes, listStaffNotes, loadStaffNote } from '../notes';
import { clearDeathMarks, parseRedriveScope } from '../outbox-redrive';
import { executeRefund } from '../payment';
import { loadPublishedPrices, resolvePrice } from '../pricing';
import {
  ensureQuestionProperty,
  provisionProperties,
  questionPropertyStatement,
  signalQuestionProperty,
} from '../properties';
import { getWebinarProvider } from '../providers';
import { deleteConnection, getConnectionStatus, storeApiKeyConnection } from '../providers/oauth';
import { provisionHubDbTables } from '../provision';
import {
  listAnswersFor,
  listQuestions,
  loadEventQuestions,
  loadQuestion,
  normaliseQuestionDefinition,
  type RegistrationQuestion,
  toAdminQuestion,
} from '../questions';
import { reissueInvoice } from '../reissue-invoice';
import {
  buildRegistrationsReport,
  csvFilename,
  listEventRegistrations,
  loadDisplayTimeZone,
  normaliseRangeBound,
  registrationsToCsv,
  summariseEventRegistrations,
  summariseMoney,
  summariseRegistrations,
} from '../reporting';
import { resolveRegistrationClosesAt, resolveSalesWindow } from '../sales-window';
import { decryptToken, encryptToken } from '../token-crypto';
import { transferRegistration } from '../transfer';
import type { Env } from '../types';
import { loadVoucherConfig } from '../vouchers';
import { DEFAULT_INVOICE_DUE_DAYS, MAX_INVOICE_DUE_DAYS, reserveEventWithBody } from './reserve';

type ManageBindings = {
  Bindings: Env;
  Variables: { portalId: string };
};

type BookingKind = 'event' | 'course';
type ManualRegistrationMode = 'paid' | 'complimentary';
type CourseComponentInputKind = Exclude<CourseComponentKind, 'standalone'>;

const VALID_HUBSPOT_ID = /^\d+$/;

/**
 * Parses a payment-terms value (days a paid booking's seat is held / its invoice runs
 * to). `null` clears the override so the next-least-specific default applies; anything
 * outside 1..MAX_INVOICE_DUE_DAYS is rejected rather than silently clamped, so staff
 * see why a value did not take.
 */
function parseInvoiceDueDays(value: unknown): { ok: true; days: number | null } | { ok: false } {
  if (value === null || value === '') return { ok: true, days: null };
  const days = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(days) || days < 1 || days > MAX_INVOICE_DUE_DAYS) return { ok: false };
  return { ok: true, days };
}

function normalizeBookingKind(value: unknown): BookingKind | null {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  return normalized === 'event' || normalized === 'course' ? normalized : null;
}

function normalizeCourseComponentKind(value: unknown): CourseComponentInputKind | null {
  if (value === undefined || value === null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  return normalized === 'module' || normalized === 'exam' || normalized === 'practical'
    ? normalized
    : null;
}

function cleanText(value: unknown, max = 240): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanEmail(value: unknown): string {
  return cleanText(value, 254).toLowerCase();
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function normalizeManualRegistrationMode(value: unknown): ManualRegistrationMode | null {
  const normalized = cleanText(value, 40).toLowerCase();
  if (normalized === 'paid') return 'paid';
  if (normalized === 'complimentary' || normalized === 'comp' || normalized === 'free') {
    return 'complimentary';
  }
  return null;
}

async function adminMiddleware(c: Context<ManageBindings>, next: () => Promise<void>) {
  const portalId = authenticateAdmin(c as unknown as Context<{ Bindings: Env }>);
  if (!portalId) {
    return c.json({ status: 'unauthorized', message: 'Admin credentials required' }, 401);
  }
  c.set('portalId', portalId);
  return next();
}

// ---------------------------------------------------------------------------
// GET /events
// ---------------------------------------------------------------------------

async function handleListEvents(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const hubspotEventId = c.req.query('hubspotEventId');

  if (hubspotEventId) {
    const row = await c.env.DB.prepare(
      'SELECT * FROM events WHERE portal_id = ?1 AND hubspot_event_id = ?2',
    )
      .bind(portalId, hubspotEventId)
      .first();
    if (!row) return c.json({ status: 'not_found', message: 'Event not found' }, 404);
    return c.json(row);
  }

  const rows = await c.env.DB.prepare(
    'SELECT * FROM events WHERE portal_id = ?1 ORDER BY starts_at DESC',
  )
    .bind(portalId)
    .all();
  return c.json(rows.results);
}

// ---------------------------------------------------------------------------
// POST /events
// ---------------------------------------------------------------------------

async function handleCreateEvent(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');

  let body: {
    hubspotEventId?: string;
    title?: string;
    startsAt?: string;
    endsAt?: string;
    capacity?: number;
    capacityUnlimited?: boolean;
    location?: string;
    bookingKind?: string;
    parentEventId?: string;
    courseComponentKind?: string;
    courseComponentOrder?: number;
    courseModuleProductId?: string;
    coursePackageRequired?: boolean;
    provider?: string;
    allowOversell?: boolean;
    /** Migration 0038. A date (end of that day, tenant-local) or a full ISO instant. */
    registrationClosesAt?: string | null;
    /** Migration 0038. Create the event already off sale — set up now, sell later. */
    salesPaused?: boolean;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }

  if (!body.hubspotEventId || !body.title || !body.startsAt || !body.endsAt) {
    return c.json(
      {
        status: 'missing_fields',
        message: 'hubspotEventId, title, startsAt, endsAt are required',
      },
      400,
    );
  }

  // Capacity guard (Phase 1.1): an event never goes live on a placeholder. Absent, null
  // and zero are all rejected unless the caller says uncapped explicitly.
  const capacity = parseCapacity(body.capacity, body.capacityUnlimited, 'event');
  if (!capacity.ok) {
    return c.json({ status: capacity.status, message: capacity.message }, 400);
  }

  const bookingKind = normalizeBookingKind(body.bookingKind) ?? 'course';
  if (body.bookingKind !== undefined && !normalizeBookingKind(body.bookingKind)) {
    return c.json(
      { status: 'invalid_booking_kind', message: 'bookingKind must be "event" or "course"' },
      400,
    );
  }

  const courseComponentKind = normalizeCourseComponentKind(body.courseComponentKind);
  if (body.courseComponentKind !== undefined && !courseComponentKind) {
    return c.json(
      {
        status: 'invalid_course_component_kind',
        message: 'courseComponentKind must be "module", "exam", or "practical"',
      },
      400,
    );
  }
  const courseComponentOrder = body.courseComponentOrder;
  if (
    courseComponentOrder !== undefined &&
    (!Number.isInteger(courseComponentOrder) || courseComponentOrder < 1)
  ) {
    return c.json(
      {
        status: 'invalid_course_component_order',
        message: 'courseComponentOrder must be a positive whole number',
      },
      400,
    );
  }
  const hasCourseComponent =
    body.parentEventId !== undefined ||
    courseComponentKind !== null ||
    courseComponentOrder !== undefined;
  if (hasCourseComponent) {
    if (
      !body.parentEventId ||
      !courseComponentKind ||
      courseComponentOrder === undefined ||
      !cleanText(body.courseModuleProductId, 128)
    ) {
      return c.json(
        {
          status: 'incomplete_course_component',
          message:
            'parentEventId, courseComponentKind, courseComponentOrder, and courseModuleProductId are required together',
        },
        400,
      );
    }
    const parent = await loadEvent(c.env.DB, portalId, body.parentEventId);
    if (parent?.booking_kind !== 'course' || parent.parent_event_id !== null) {
      return c.json(
        {
          status: 'invalid_parent_course',
          message: 'parentEventId must reference a top-level course event in this portal',
        },
        400,
      );
    }
  }
  if (body.coursePackageRequired !== undefined && typeof body.coursePackageRequired !== 'boolean') {
    return c.json(
      {
        status: 'invalid_course_package_required',
        message: 'coursePackageRequired must be true or false',
      },
      400,
    );
  }
  if (body.coursePackageRequired === true && !hasCourseComponent) {
    return c.json(
      {
        status: 'invalid_course_package_required',
        message: 'coursePackageRequired can only be set on a course component',
      },
      400,
    );
  }

  const existing = await c.env.DB.prepare(
    'SELECT id FROM events WHERE portal_id = ?1 AND hubspot_event_id = ?2',
  )
    .bind(portalId, body.hubspotEventId)
    .first();
  if (existing) {
    return c.json({ status: 'conflict', message: 'Event already registered for this portal' }, 409);
  }

  // Resolved BEFORE anything is written. The sales window lands in a follow-up UPDATE (see
  // below), and validating it there would leave a rejected create having already inserted
  // the event: the caller sees a 400, retries with the corrected date, and hits the
  // duplicate-event conflict against a half-configured event that is already live.
  const closesAt = resolveRegistrationClosesAt(
    body.registrationClosesAt,
    await loadDisplayTimeZone(c.env, portalId),
  );
  if (!closesAt.ok) {
    return c.json({ status: 'invalid_registration_closes_at', message: closesAt.message }, 400);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // A created event is live, so this is its first publish — the clock a suspiciously fast
  // sell-out is measured against (see capacity-guard.maybeFlagFastSellout).
  if (hasCourseComponent) {
    await c.env.DB.prepare(
      `INSERT INTO events
         (id, portal_id, hubspot_event_id, title, starts_at, ends_at, capacity, capacity_unlimited,
        location, booking_kind, parent_event_id, course_component_kind, course_component_order,
        course_module_product_id, course_package_required,
        provider, allow_oversell, marketing_event_completed,
        first_published_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, 0, ?18, ?18, ?18)`,
    )
      .bind(
        id,
        portalId,
        body.hubspotEventId,
        body.title,
        body.startsAt,
        body.endsAt,
        capacity.capacity,
        capacity.unlimited ? 1 : 0,
        body.location ?? null,
        bookingKind,
        body.parentEventId,
        courseComponentKind,
        courseComponentOrder,
        cleanText(body.courseModuleProductId, 128),
        body.coursePackageRequired ? 1 : 0,
        body.provider ?? null,
        body.allowOversell ? 1 : 0,
        now,
      )
      .run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO events
         (id, portal_id, hubspot_event_id, title, starts_at, ends_at, capacity, capacity_unlimited,
          location, booking_kind, provider, allow_oversell, marketing_event_completed,
          first_published_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0, ?13, ?13, ?13)`,
    )
      .bind(
        id,
        portalId,
        body.hubspotEventId,
        body.title,
        body.startsAt,
        body.endsAt,
        capacity.capacity,
        capacity.unlimited ? 1 : 0,
        body.location ?? null,
        bookingKind,
        body.provider ?? null,
        body.allowOversell ? 1 : 0,
        now,
      )
      .run();
  }

  // Sales window (migration 0038), applied as a follow-up UPDATE rather than folded into
  // the INSERTs above: the same reason internalOnly is, one INSERT per branch that an
  // older tenant database is not guaranteed to have the columns for. The value was
  // validated before the insert, so nothing here can reject a create that already happened.
  // Only written when the caller asked, so a create that says nothing about selling
  // behaves exactly as before.
  if (body.registrationClosesAt !== undefined || body.salesPaused !== undefined) {
    await c.env.DB.prepare(
      'UPDATE events SET registration_closes_at = ?1, sales_paused = ?2 WHERE id = ?3',
    )
      .bind(closesAt.value, body.salesPaused ? 1 : 0, id)
      .run();
  }

  const created = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?1').bind(id).first();
  return c.json(created, 201);
}

// ---------------------------------------------------------------------------
// PATCH /events/:id
// ---------------------------------------------------------------------------

async function handlePatchEvent(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const id = c.req.param('id') as string;

  let body: {
    capacity?: number;
    capacityUnlimited?: boolean;
    provider?: string | null;
    allowOversell?: boolean;
    title?: string;
    startsAt?: string;
    endsAt?: string;
    location?: string | null;
    bookingKind?: string | null;
    parentEventId?: string | null;
    courseComponentKind?: string | null;
    courseComponentOrder?: number | null;
    courseModuleProductId?: string | null;
    coursePackageRequired?: boolean;
    refundPolicyId?: string | null;
    category?: string | null;
    hubspotOwnerId?: string | null;
    /** Payment terms override in days; null clears it back to the portal default. */
    invoiceDueDays?: number | string | null;
    /**
     * Migration 0038. A date ("2026-09-20", meaning the end of that day where the tenant
     * is) or a full ISO instant. null clears it back to the `starts_at` default.
     */
    registrationClosesAt?: string | null;
    /** Migration 0038. Stop or resume sales by hand; capacity is untouched either way. */
    salesPaused?: boolean;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }

  const event = await loadEvent(c.env.DB, portalId, id);
  if (!event) return c.json({ status: 'not_found', message: 'Event not found' }, 404);

  const sets: string[] = [];
  const vals: unknown[] = [];

  // Capacity guard (Phase 1.1): validate the state this PATCH would LEAVE BEHIND, not the
  // fields it happens to carry. That way clearing capacityUnlimited without supplying a
  // real seat count is rejected, and an event already sitting on a placeholder zero cannot
  // be edited further until someone gives it a capacity.
  if (body.capacity !== undefined || body.capacityUnlimited !== undefined) {
    const capacity = parseCapacity(
      body.capacity !== undefined ? body.capacity : event.capacity,
      // An explicit seat count is itself an intent to cap, so it clears a previously
      // uncapped event without the caller having to send both fields.
      body.capacityUnlimited !== undefined
        ? body.capacityUnlimited
        : body.capacity !== undefined
          ? false
          : !!event.capacity_unlimited,
      'event',
    );
    if (!capacity.ok) {
      return c.json({ status: capacity.status, message: capacity.message }, 400);
    }
    sets.push(`capacity = ?${sets.length + 1}`);
    vals.push(capacity.capacity);
    sets.push(`capacity_unlimited = ?${sets.length + 1}`);
    vals.push(capacity.unlimited ? 1 : 0);
  } else if (!event.capacity_unlimited && !(event.capacity > 0)) {
    return c.json(
      {
        status: 'invalid_capacity',
        message:
          'This event has no capacity set. Send a capacity of at least 1 seat (or capacityUnlimited) with this update before changing anything else.',
      },
      400,
    );
  }

  // Sales window (migration 0038). Deliberately NOT guarded the way capacity is: a cutoff
  // in the past is a legitimate way to close an event right now, and pausing is meant to be
  // a one-click stop. Neither can oversell anything, so neither needs protecting from the
  // person setting it.
  if (body.registrationClosesAt !== undefined) {
    const resolved = resolveRegistrationClosesAt(
      body.registrationClosesAt,
      await loadDisplayTimeZone(c.env, portalId),
    );
    if (!resolved.ok) {
      return c.json({ status: 'invalid_registration_closes_at', message: resolved.message }, 400);
    }
    sets.push(`registration_closes_at = ?${sets.length + 1}`);
    vals.push(resolved.value);
  }
  if (body.salesPaused !== undefined) {
    sets.push(`sales_paused = ?${sets.length + 1}`);
    vals.push(body.salesPaused ? 1 : 0);
  }

  if (body.provider !== undefined) {
    sets.push(`provider = ?${sets.length + 1}`);
    vals.push(body.provider);
  }
  if (body.allowOversell !== undefined) {
    sets.push(`allow_oversell = ?${sets.length + 1}`);
    vals.push(body.allowOversell ? 1 : 0);
  }
  if (body.title != null) {
    sets.push(`title = ?${sets.length + 1}`);
    vals.push(body.title);
  }
  if (body.startsAt != null) {
    sets.push(`starts_at = ?${sets.length + 1}`);
    vals.push(body.startsAt);
  }
  if (body.endsAt != null) {
    sets.push(`ends_at = ?${sets.length + 1}`);
    vals.push(body.endsAt);
  }
  if (body.location !== undefined) {
    sets.push(`location = ?${sets.length + 1}`);
    vals.push(body.location);
  }
  if (body.bookingKind !== undefined) {
    const bookingKind = normalizeBookingKind(body.bookingKind);
    if (!bookingKind) {
      return c.json(
        { status: 'invalid_booking_kind', message: 'bookingKind must be "event" or "course"' },
        400,
      );
    }
    sets.push(`booking_kind = ?${sets.length + 1}`);
    vals.push(bookingKind);
  }
  if (
    body.parentEventId !== undefined ||
    body.courseComponentKind !== undefined ||
    body.courseComponentOrder !== undefined ||
    body.courseModuleProductId !== undefined ||
    body.coursePackageRequired !== undefined
  ) {
    const nextParentId =
      body.parentEventId !== undefined ? body.parentEventId : event.parent_event_id;
    const nextKind =
      body.courseComponentKind !== undefined
        ? normalizeCourseComponentKind(body.courseComponentKind)
        : event.course_component_kind === 'standalone'
          ? null
          : event.course_component_kind;
    const nextOrder =
      body.courseComponentOrder !== undefined
        ? body.courseComponentOrder
        : event.course_component_order;
    const nextProductId =
      body.courseModuleProductId !== undefined
        ? cleanText(body.courseModuleProductId, 128)
        : event.course_module_product_id;
    if (
      !nextParentId ||
      !nextKind ||
      !Number.isInteger(nextOrder) ||
      (nextOrder as number) < 1 ||
      !nextProductId
    ) {
      return c.json(
        {
          status: 'incomplete_course_component',
          message:
            'parentEventId, courseComponentKind, courseComponentOrder, and courseModuleProductId are required together',
        },
        400,
      );
    }
    if (nextParentId === event.id) {
      return c.json(
        { status: 'invalid_parent_course', message: 'An event cannot be its own parent course' },
        400,
      );
    }
    const parent = await loadEvent(c.env.DB, portalId, nextParentId);
    if (parent?.booking_kind !== 'course' || parent.parent_event_id !== null) {
      return c.json(
        {
          status: 'invalid_parent_course',
          message: 'parentEventId must reference a top-level course event in this portal',
        },
        400,
      );
    }
    sets.push(`parent_event_id = ?${sets.length + 1}`);
    vals.push(nextParentId);
    sets.push(`course_component_kind = ?${sets.length + 1}`);
    vals.push(nextKind);
    sets.push(`course_component_order = ?${sets.length + 1}`);
    vals.push(nextOrder);
    sets.push(`course_module_product_id = ?${sets.length + 1}`);
    vals.push(nextProductId);
    if (body.coursePackageRequired !== undefined) {
      if (typeof body.coursePackageRequired !== 'boolean') {
        return c.json(
          {
            status: 'invalid_course_package_required',
            message: 'coursePackageRequired must be true or false',
          },
          400,
        );
      }
      sets.push(`course_package_required = ?${sets.length + 1}`);
      vals.push(body.coursePackageRequired ? 1 : 0);
    }
  }
  if (body.refundPolicyId !== undefined) {
    sets.push(`refund_policy_id = ?${sets.length + 1}`);
    vals.push(body.refundPolicyId);
  }
  if (body.category !== undefined) {
    sets.push(`category = ?${sets.length + 1}`);
    vals.push(body.category);
  }
  if (body.hubspotOwnerId !== undefined) {
    sets.push(`hubspot_owner_id = ?${sets.length + 1}`);
    vals.push(body.hubspotOwnerId);
  }
  if (body.invoiceDueDays !== undefined) {
    const parsed = parseInvoiceDueDays(body.invoiceDueDays);
    if (!parsed.ok) {
      return c.json(
        {
          status: 'invalid_invoice_due_days',
          message: `invoiceDueDays must be a whole number of days between 1 and ${MAX_INVOICE_DUE_DAYS}, or null to use the portal default`,
        },
        400,
      );
    }
    sets.push(`invoice_due_days = ?${sets.length + 1}`);
    vals.push(parsed.days);
  }

  if (sets.length === 0) {
    return c.json({ status: 'no_fields', message: 'No updatable fields provided' }, 400);
  }

  const now = new Date().toISOString();
  sets.push(`updated_at = ?${sets.length + 1}`);
  vals.push(now);
  // The event is live and (per the guard above) has a real capacity, so if it was never
  // stamped this is its first publish. COALESCE keeps the original stamp on later edits.
  sets.push(`first_published_at = COALESCE(first_published_at, ?${sets.length + 1})`);
  vals.push(now);

  const result = await c.env.DB.prepare(
    `UPDATE events SET ${sets.join(', ')} WHERE portal_id = ?${vals.length + 1} AND id = ?${vals.length + 2}`,
  )
    .bind(...vals, portalId, id)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ status: 'not_found', message: 'Event not found' }, 404);
  }

  const updated = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?1').bind(id).first();
  return c.json(updated);
}

// ---------------------------------------------------------------------------
// GET /events/:id/ticket-types
// ---------------------------------------------------------------------------

async function handleListTicketTypes(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const id = c.req.param('id');

  const event = await c.env.DB.prepare('SELECT id FROM events WHERE portal_id = ?1 AND id = ?2')
    .bind(portalId, id)
    .first();
  if (!event) return c.json({ status: 'not_found', message: 'Event not found' }, 404);

  const rows = await c.env.DB.prepare(
    'SELECT * FROM ticket_types WHERE event_id = ?1 ORDER BY sort_order ASC, created_at ASC',
  )
    .bind(id)
    .all();
  return c.json(rows.results);
}

// ---------------------------------------------------------------------------
// GET /events/:id/course-components
// ---------------------------------------------------------------------------

/** Lists the separately bookable modules, exams, and practicals of a course. */
async function handleListCourseComponents(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const id = c.req.param('id') as string;
  const course = await loadEvent(c.env.DB, portalId, id);

  if (!course) return c.json({ status: 'not_found', message: 'Event not found' }, 404);
  if (course.parent_event_id !== null || course.booking_kind !== 'course') {
    return c.json(
      {
        status: 'not_a_parent_course',
        message: 'Course components belong to a top-level course event',
      },
      400,
    );
  }

  return c.json(await loadCourseComponents(c.env.DB, portalId, course.id));
}

// ---------------------------------------------------------------------------
// POST /events/:id/ticket-types
// ---------------------------------------------------------------------------

async function handleCreateTicketType(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const id = c.req.param('id');

  const event = await c.env.DB.prepare('SELECT id FROM events WHERE portal_id = ?1 AND id = ?2')
    .bind(portalId, id)
    .first();
  if (!event) return c.json({ status: 'not_found', message: 'Event not found' }, 404);

  let body: {
    name?: string;
    priceCents?: number;
    currency?: string;
    capacity?: number;
    capacityUnlimited?: boolean;
    taxTreatment?: string;
    memberOnly?: boolean;
    internalOnly?: boolean;
    sortOrder?: number;
    hsTaxRateId?: string;
    hsProductId?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }

  if (!body.name || body.priceCents == null) {
    return c.json(
      { status: 'missing_fields', message: 'name, priceCents, capacity are required' },
      400,
    );
  }
  if (body.internalOnly !== undefined && typeof body.internalOnly !== 'boolean') {
    return c.json(
      { status: 'invalid_internal_only', message: 'internalOnly must be true or false' },
      400,
    );
  }

  // Same capacity guard as the event: a ticket type with no seats sells nothing, so it has
  // to be either a real number or explicitly uncapped.
  const capacity = parseCapacity(body.capacity, body.capacityUnlimited, 'ticket type');
  if (!capacity.ok) {
    return c.json({ status: capacity.status, message: capacity.message }, 400);
  }

  // GST toggle: 'gst' (10% included, default) | 'gst_free' (no GST). Reject anything else.
  const taxTreatment = body.taxTreatment ?? 'gst';
  if (taxTreatment !== 'gst' && taxTreatment !== 'gst_free') {
    return c.json(
      { status: 'invalid_tax_treatment', message: "taxTreatment must be 'gst' or 'gst_free'" },
      400,
    );
  }

  const ttId = crypto.randomUUID();
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    `INSERT INTO ticket_types
       (id, portal_id, event_id, name, price_cents, currency, capacity, capacity_unlimited,
        tax_treatment, member_only, hs_tax_rate_id, hs_product_id, sort_order, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
  )
    .bind(
      ttId,
      portalId,
      id,
      body.name,
      body.priceCents,
      body.currency ?? 'AUD',
      capacity.capacity,
      capacity.unlimited ? 1 : 0,
      taxTreatment,
      body.memberOnly ? 1 : 0,
      body.hsTaxRateId ?? null,
      body.hsProductId ?? null,
      body.sortOrder ?? 0,
      now,
    )
    .run();

  // Keep the main INSERT backward-compatible with older D1 schemas used by
  // tenant test fixtures. A true internalOnly value is only accepted after the
  // additive migration has reached that database.
  if (body.internalOnly) {
    await c.env.DB.prepare('UPDATE ticket_types SET internal_only = 1 WHERE id = ?1')
      .bind(ttId)
      .run();
  }

  const created = await c.env.DB.prepare('SELECT * FROM ticket_types WHERE id = ?1')
    .bind(ttId)
    .first();
  return c.json(created, 201);
}

// ---------------------------------------------------------------------------
// PATCH /events/:id/ticket-types/:ttId
// ---------------------------------------------------------------------------

async function handlePatchTicketType(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const id = c.req.param('id');
  const ttId = c.req.param('ttId');

  const event = await c.env.DB.prepare('SELECT id FROM events WHERE portal_id = ?1 AND id = ?2')
    .bind(portalId, id)
    .first();
  if (!event) return c.json({ status: 'not_found', message: 'Event not found' }, 404);

  let body: {
    name?: string;
    priceCents?: number;
    capacity?: number;
    capacityUnlimited?: boolean;
    taxTreatment?: string;
    memberOnly?: boolean;
    internalOnly?: boolean;
    /** Migration 0038. Takes this one type off sale; the event keeps selling the others. */
    salesPaused?: boolean;
    sortOrder?: number;
    hsTaxRateId?: string | null;
    hsProductId?: string | null;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }

  if (
    body.taxTreatment !== undefined &&
    body.taxTreatment !== 'gst' &&
    body.taxTreatment !== 'gst_free'
  ) {
    return c.json(
      { status: 'invalid_tax_treatment', message: "taxTreatment must be 'gst' or 'gst_free'" },
      400,
    );
  }

  // Loaded up front so the capacity guard below can judge the resulting state, not just
  // the fields this PATCH happens to carry.
  const ticketType = await c.env.DB.prepare(
    'SELECT * FROM ticket_types WHERE id = ?1 AND event_id = ?2 AND portal_id = ?3',
  )
    .bind(ttId, id, portalId)
    .first<TicketTypeRow>();
  if (!ticketType) return c.json({ status: 'not_found', message: 'Ticket type not found' }, 404);

  const sets: string[] = [];
  const vals: unknown[] = [];

  if (body.name != null) {
    sets.push(`name = ?${sets.length + 1}`);
    vals.push(body.name);
  }
  if (body.priceCents != null) {
    sets.push(`price_cents = ?${sets.length + 1}`);
    vals.push(body.priceCents);
  }
  if (body.capacity !== undefined || body.capacityUnlimited !== undefined) {
    const capacity = parseCapacity(
      body.capacity !== undefined ? body.capacity : ticketType.capacity,
      body.capacityUnlimited !== undefined
        ? body.capacityUnlimited
        : body.capacity !== undefined
          ? false
          : !!ticketType.capacity_unlimited,
      'ticket type',
    );
    if (!capacity.ok) {
      return c.json({ status: capacity.status, message: capacity.message }, 400);
    }
    sets.push(`capacity = ?${sets.length + 1}`);
    vals.push(capacity.capacity);
    sets.push(`capacity_unlimited = ?${sets.length + 1}`);
    vals.push(capacity.unlimited ? 1 : 0);
  } else if (!ticketType.capacity_unlimited && !(ticketType.capacity > 0)) {
    return c.json(
      {
        status: 'invalid_capacity',
        message:
          'This ticket type has no capacity set. Send a capacity of at least 1 seat (or capacityUnlimited) with this update before changing anything else.',
      },
      400,
    );
  }
  if (body.taxTreatment !== undefined) {
    sets.push(`tax_treatment = ?${sets.length + 1}`);
    vals.push(body.taxTreatment);
  }
  if (body.memberOnly !== undefined) {
    sets.push(`member_only = ?${sets.length + 1}`);
    vals.push(body.memberOnly ? 1 : 0);
  }
  if (body.salesPaused !== undefined) {
    sets.push(`sales_paused = ?${sets.length + 1}`);
    vals.push(body.salesPaused ? 1 : 0);
  }
  if (body.internalOnly !== undefined) {
    if (typeof body.internalOnly !== 'boolean') {
      return c.json(
        { status: 'invalid_internal_only', message: 'internalOnly must be true or false' },
        400,
      );
    }
    sets.push(`internal_only = ?${sets.length + 1}`);
    vals.push(body.internalOnly ? 1 : 0);
  }
  if (body.sortOrder != null) {
    sets.push(`sort_order = ?${sets.length + 1}`);
    vals.push(body.sortOrder);
  }
  if (body.hsTaxRateId !== undefined) {
    sets.push(`hs_tax_rate_id = ?${sets.length + 1}`);
    vals.push(body.hsTaxRateId);
  }
  if (body.hsProductId !== undefined) {
    sets.push(`hs_product_id = ?${sets.length + 1}`);
    vals.push(body.hsProductId);
  }

  if (sets.length === 0) {
    return c.json({ status: 'no_fields', message: 'No updatable fields provided' }, 400);
  }

  const result = await c.env.DB.prepare(
    `UPDATE ticket_types SET ${sets.join(', ')} WHERE id = ?${vals.length + 1} AND event_id = ?${vals.length + 2} AND portal_id = ?${vals.length + 3}`,
  )
    .bind(...vals, ttId, id, portalId)
    .run();

  if (result.meta.changes === 0) {
    return c.json({ status: 'not_found', message: 'Ticket type not found' }, 404);
  }

  const updated = await c.env.DB.prepare('SELECT * FROM ticket_types WHERE id = ?1')
    .bind(ttId)
    .first();
  return c.json(updated);
}

// ---------------------------------------------------------------------------
// Pricing rules (Phase 18.1) — tiered member discounts by level + category.
// Rules visible to an event: its ticket_type rules, its event rules, and portal defaults.
// ---------------------------------------------------------------------------

async function handleListPricingRules(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const id = c.req.param('id');

  const event = await c.env.DB.prepare('SELECT id FROM events WHERE portal_id = ?1 AND id = ?2')
    .bind(portalId, id)
    .first();
  if (!event) return c.json({ status: 'not_found', message: 'Event not found' }, 404);

  const rows = await c.env.DB.prepare(
    `SELECT pr.* FROM pricing_rules pr
      WHERE pr.portal_id = ?1
        AND (
          pr.scope = 'portal'
          OR (pr.scope = 'event' AND pr.scope_id = ?2)
          OR (pr.scope = 'ticket_type' AND pr.scope_id IN
                (SELECT tt.id FROM ticket_types tt WHERE tt.event_id = ?2))
        )
      ORDER BY pr.scope, pr.member_level, pr.member_category`,
  )
    .bind(portalId, id)
    .all();
  return c.json(rows.results);
}

async function handleCreatePricingRule(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const id = c.req.param('id') as string;

  const event = await c.env.DB.prepare('SELECT id FROM events WHERE portal_id = ?1 AND id = ?2')
    .bind(portalId, id)
    .first();
  if (!event) return c.json({ status: 'not_found', message: 'Event not found' }, 404);

  let body: {
    scope?: string;
    scopeId?: string | null;
    memberLevel?: string;
    memberCategory?: string;
    discountPercent?: number | null;
    fixedPriceCents?: number | null;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }

  const scope = body.scope ?? 'event';
  if (scope !== 'portal' && scope !== 'event' && scope !== 'ticket_type') {
    return c.json(
      { status: 'invalid_scope', message: "scope must be 'portal' | 'event' | 'ticket_type'" },
      400,
    );
  }
  if (!body.memberLevel || !body.memberCategory) {
    return c.json(
      { status: 'missing_fields', message: 'memberLevel and memberCategory are required' },
      400,
    );
  }
  if (body.discountPercent == null && body.fixedPriceCents == null) {
    return c.json(
      { status: 'missing_fields', message: 'discountPercent or fixedPriceCents is required' },
      400,
    );
  }

  // scope_id: event → this event; ticket_type → provided ticket type (must belong to event);
  // portal → null. For an event-scoped rule we always pin scope_id to this event.
  let scopeId: string | null = null;
  if (scope === 'event') {
    scopeId = id;
  } else if (scope === 'ticket_type') {
    if (!body.scopeId) {
      return c.json(
        {
          status: 'missing_fields',
          message: 'scopeId (ticket type id) is required for ticket_type scope',
        },
        400,
      );
    }
    const tt = await c.env.DB.prepare(
      'SELECT id FROM ticket_types WHERE id = ?1 AND event_id = ?2 AND portal_id = ?3',
    )
      .bind(body.scopeId, id, portalId)
      .first();
    if (!tt)
      return c.json({ status: 'not_found', message: 'Ticket type not found for this event' }, 404);
    scopeId = body.scopeId;
  }

  const ruleId = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO pricing_rules
       (id, portal_id, scope, scope_id, member_level, member_category,
        discount_percent, fixed_price_cents, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(
      ruleId,
      portalId,
      scope,
      scopeId,
      body.memberLevel,
      body.memberCategory,
      body.fixedPriceCents != null ? null : (body.discountPercent ?? null),
      body.fixedPriceCents ?? null,
      now,
    )
    .run();

  const created = await c.env.DB.prepare('SELECT * FROM pricing_rules WHERE id = ?1')
    .bind(ruleId)
    .first();
  return c.json(created, 201);
}

async function handleDeletePricingRule(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const ruleId = c.req.param('ruleId');

  const result = await c.env.DB.prepare(
    'DELETE FROM pricing_rules WHERE id = ?1 AND portal_id = ?2',
  )
    .bind(ruleId, portalId)
    .run();
  if (result.meta.changes === 0) {
    return c.json({ status: 'not_found', message: 'Pricing rule not found' }, 404);
  }
  return c.json({ ok: true, id: ruleId });
}

// ---------------------------------------------------------------------------
// Invoice eligibility rules (Phase 4.2) — WHO may pay on terms.
//
// Portal-level, not per-event: the rule is about the PAYER. Ordering in the list mirrors
// the resolver's, so what an operator reads top-to-bottom is the order a booking is tested
// in — a rule further down can only apply to a payer the ones above it did not claim.
//
// An empty, or entirely inactive, rule set means this portal has not configured
// eligibility, and every paid booking keeps the invoice terms Phase 4.1 gave it. Adding the
// first active rule is what turns the gate on, so the list response says so plainly rather
// than leaving an operator to infer it from a length.
// ---------------------------------------------------------------------------

const ELIGIBILITY_SPECIFICITY: InvoiceEligibilityMatchKind[] = INVOICE_ELIGIBILITY_MATCH_KINDS;

interface EligibilityRuleBody {
  matchKind?: string;
  matchKey?: string | null;
  matchValue?: string | null;
  termsDays?: number | string | null;
  holdMs?: number | string | null;
  minCents?: number | string | null;
  priority?: number | string | null;
  active?: boolean | number;
}

/** Hold length in ms, bounded by the same 90-day ceiling the due date is. */
function parseHoldMs(value: unknown): { ok: true; ms: number | null } | { ok: false } {
  if (value === null || value === undefined || value === '') return { ok: true, ms: null };
  const ms = typeof value === 'number' ? value : Number(value);
  const max = MAX_INVOICE_DUE_DAYS * 24 * 60 * 60 * 1000;
  if (!Number.isInteger(ms) || ms < 60_000 || ms > max) return { ok: false };
  return { ok: true, ms };
}

function parseOptionalCents(value: unknown): { ok: true; cents: number | null } | { ok: false } {
  if (value === null || value === undefined || value === '') return { ok: true, cents: null };
  const cents = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(cents) || cents < 0) return { ok: false };
  return { ok: true, cents };
}

async function handleListInvoiceEligibilityRules(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const rows = (
    await c.env.DB.prepare('SELECT * FROM invoice_eligibility_rules WHERE portal_id = ?1')
      .bind(portalId)
      .all<{ match_kind: string; priority: number; created_at: string; active: number }>()
  ).results;

  const ordered = [...rows].sort((a, b) => {
    const bySpecificity =
      ELIGIBILITY_SPECIFICITY.indexOf(a.match_kind as InvoiceEligibilityMatchKind) -
      ELIGIBILITY_SPECIFICITY.indexOf(b.match_kind as InvoiceEligibilityMatchKind);
    if (bySpecificity !== 0) return bySpecificity;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
  });

  return c.json({
    rules: ordered,
    // False = the gate is off and every paid booking is invoice-eligible, which is what a
    // portal that has never touched this looks like.
    gateActive: ordered.some((rule) => rule.active === 1),
  });
}

async function handleCreateInvoiceEligibilityRule(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  let body: EligibilityRuleBody;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }

  const matchKind = body.matchKind as InvoiceEligibilityMatchKind;
  if (!ELIGIBILITY_SPECIFICITY.includes(matchKind)) {
    return c.json(
      {
        status: 'invalid_match_kind',
        message: `matchKind must be one of ${ELIGIBILITY_SPECIFICITY.join(' | ')}`,
      },
      400,
    );
  }

  const matchKey = body.matchKey?.trim() || null;
  // A property rule with no property to read matches nothing and would sit in the list
  // looking like configuration. Reject it here rather than let the resolver skip it.
  if ((matchKind === 'contact_property' || matchKind === 'company_property') && !matchKey) {
    return c.json(
      {
        status: 'missing_fields',
        message: `matchKey (the property name) is required for ${matchKind}`,
      },
      400,
    );
  }
  if (matchKind === 'membership_level' && matchKey && !['level', 'category'].includes(matchKey)) {
    return c.json(
      {
        status: 'invalid_match_key',
        message: "matchKey for membership_level must be 'level' or 'category' (or omitted)",
      },
      400,
    );
  }
  // 'membership_level' with no value would qualify every member of any tier, which is an
  // 'always' rule wearing a tier's name. Say so instead of storing the ambiguity.
  if (matchKind === 'membership_level' && !body.matchValue?.trim()) {
    return c.json(
      {
        status: 'missing_fields',
        message:
          "matchValue (the qualifying tier) is required for membership_level — use matchKind 'always' to qualify everyone",
      },
      400,
    );
  }

  const terms = parseInvoiceDueDays(body.termsDays ?? DEFAULT_INVOICE_DUE_DAYS);
  if (!terms.ok || terms.days === null) {
    return c.json(
      {
        status: 'invalid_terms_days',
        message: `termsDays must be a whole number of days between 1 and ${MAX_INVOICE_DUE_DAYS}`,
      },
      400,
    );
  }
  const hold = parseHoldMs(body.holdMs);
  if (!hold.ok) {
    return c.json(
      {
        status: 'invalid_hold_ms',
        message: `holdMs must be at least 60000 (one minute) and at most ${MAX_INVOICE_DUE_DAYS} days, or null to hold to the invoice due date`,
      },
      400,
    );
  }
  const floor = parseOptionalCents(body.minCents);
  if (!floor.ok) {
    return c.json(
      { status: 'invalid_min_cents', message: 'minCents must be a whole number of cents, or null' },
      400,
    );
  }

  const ruleId = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO invoice_eligibility_rules
       (id, portal_id, match_kind, match_key, match_value, terms_days, hold_ms,
        min_cents, priority, active, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  )
    .bind(
      ruleId,
      portalId,
      matchKind,
      matchKind === 'always' ? null : matchKey,
      body.matchValue?.trim() || null,
      terms.days,
      hold.ms,
      floor.cents,
      Number.isInteger(Number(body.priority)) ? Number(body.priority) : 0,
      body.active === false || body.active === 0 ? 0 : 1,
      now,
    )
    .run();

  const created = await c.env.DB.prepare('SELECT * FROM invoice_eligibility_rules WHERE id = ?1')
    .bind(ruleId)
    .first();
  return c.json(created, 201);
}

/**
 * Only `active` and `priority` are patchable. Everything else changes what the rule MEANS —
 * which payers it covers, and on what terms — and a rule that quietly starts covering
 * different people is worse than a second row: deactivate this one and write the rule you
 * want, and the list still says what was in force before.
 */
async function handlePatchInvoiceEligibilityRule(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const ruleId = c.req.param('ruleId') as string;
  let body: { active?: boolean | number; priority?: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  if (body.active !== undefined) {
    sets.push(`active = ?${params.length + 1}`);
    params.push(body.active === false || body.active === 0 ? 0 : 1);
  }
  if (body.priority !== undefined) {
    if (!Number.isInteger(body.priority)) {
      return c.json(
        { status: 'invalid_priority', message: 'priority must be a whole number' },
        400,
      );
    }
    sets.push(`priority = ?${params.length + 1}`);
    params.push(body.priority);
  }
  if (sets.length === 0) {
    return c.json({ status: 'no_fields', message: 'active or priority is required' }, 400);
  }

  const result = await c.env.DB.prepare(
    `UPDATE invoice_eligibility_rules SET ${sets.join(', ')}
      WHERE id = ?${params.length + 1} AND portal_id = ?${params.length + 2}`,
  )
    .bind(...params, ruleId, portalId)
    .run();
  if (result.meta.changes === 0) {
    return c.json({ status: 'not_found', message: 'Invoice eligibility rule not found' }, 404);
  }

  const updated = await c.env.DB.prepare('SELECT * FROM invoice_eligibility_rules WHERE id = ?1')
    .bind(ruleId)
    .first();
  return c.json(updated);
}

async function handleDeleteInvoiceEligibilityRule(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const ruleId = c.req.param('ruleId') as string;
  const result = await c.env.DB.prepare(
    'DELETE FROM invoice_eligibility_rules WHERE id = ?1 AND portal_id = ?2',
  )
    .bind(ruleId, portalId)
    .run();
  if (result.meta.changes === 0) {
    return c.json({ status: 'not_found', message: 'Invoice eligibility rule not found' }, 404);
  }
  return c.json({ ok: true, id: ruleId });
}

// ---------------------------------------------------------------------------
// POST /events/:id/orders/:orderId/reissue-invoice  (Phase 4.2)
//
// A voided HubSpot invoice cannot be un-voided, re-sent or paid — so the way back for a
// booking whose invoice was killed prematurely is a NEW invoice for the same order, and a
// seat to go with it. The seat is re-taken through the DO like any other booking and the
// reissue fails if the event has since sold out; nothing is committed either way.
// ---------------------------------------------------------------------------

async function handleReissueInvoice(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const eventId = c.req.param('id') as string;
  const orderId = c.req.param('orderId') as string;

  // The order is reached THROUGH its event, as every other :orderId route here is.
  const owned = await c.env.DB.prepare(
    'SELECT id FROM orders WHERE id = ?1 AND portal_id = ?2 AND event_id = ?3',
  )
    .bind(orderId, portalId, eventId)
    .first();
  if (!owned) return c.json({ status: 'not_found', message: 'Order not found' }, 404);

  const body = (await c.req.json().catch(() => ({}))) as { invoiceDueDate?: string | null };

  const result = await reissueInvoice(c.env, {
    portalId,
    orderId,
    invoiceDueDate: body.invoiceDueDate ?? null,
  });
  if (!result.ok) {
    const status =
      result.error === 'reissue_persist_failed'
        ? // Ours, not the caller's: the seats were re-held and handed straight back. A 409
          // would read as "the booking is in a state you can't reissue", which it is not.
          500
        : result.error === 'capacity_unconfirmed'
          ? 503
          : result.error === 'event_full'
            ? 409
            : result.error.endsWith('_not_found')
              ? 404
              : 409;
    return c.json({ ok: false, error: result.error, message: result.message }, status);
  }
  return c.json(result);
}

// ---------------------------------------------------------------------------
// Refund policy templates (Phase 18.2)
// ---------------------------------------------------------------------------

async function handleListRefundPolicies(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const rows = await c.env.DB.prepare(
    'SELECT * FROM refund_policies WHERE portal_id = ?1 ORDER BY is_default DESC, name ASC',
  )
    .bind(portalId)
    .all();
  return c.json(rows.results);
}

async function handleCreateRefundPolicy(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  let body: {
    name?: string;
    isDefault?: boolean;
    category?: string | null;
    fullRefundCutoffDays?: number | null;
    partialRefundPercent?: number | null;
    allowTransfer?: boolean;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }
  if (!body.name) {
    return c.json({ status: 'missing_fields', message: 'name is required' }, 400);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO refund_policies
       (id, portal_id, name, is_default, category, full_refund_cutoff_days,
        partial_refund_percent, allow_transfer, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(
      id,
      portalId,
      body.name,
      body.isDefault ? 1 : 0,
      body.category ?? null,
      body.fullRefundCutoffDays ?? 30,
      body.partialRefundPercent ?? null,
      body.allowTransfer === false ? 0 : 1,
      now,
    )
    .run();

  const created = await c.env.DB.prepare('SELECT * FROM refund_policies WHERE id = ?1')
    .bind(id)
    .first();
  return c.json(created, 201);
}

async function handlePatchRefundPolicy(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const id = c.req.param('id') as string;
  let body: {
    name?: string;
    isDefault?: boolean;
    category?: string | null;
    fullRefundCutoffDays?: number | null;
    partialRefundPercent?: number | null;
    allowTransfer?: boolean;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (body.name != null) {
    sets.push(`name = ?${sets.length + 1}`);
    vals.push(body.name);
  }
  if (body.isDefault !== undefined) {
    sets.push(`is_default = ?${sets.length + 1}`);
    vals.push(body.isDefault ? 1 : 0);
  }
  if (body.category !== undefined) {
    sets.push(`category = ?${sets.length + 1}`);
    vals.push(body.category);
  }
  if (body.fullRefundCutoffDays !== undefined) {
    sets.push(`full_refund_cutoff_days = ?${sets.length + 1}`);
    vals.push(body.fullRefundCutoffDays);
  }
  if (body.partialRefundPercent !== undefined) {
    sets.push(`partial_refund_percent = ?${sets.length + 1}`);
    vals.push(body.partialRefundPercent);
  }
  if (body.allowTransfer !== undefined) {
    sets.push(`allow_transfer = ?${sets.length + 1}`);
    vals.push(body.allowTransfer ? 1 : 0);
  }
  if (sets.length === 0) {
    return c.json({ status: 'no_fields', message: 'No updatable fields provided' }, 400);
  }

  const result = await c.env.DB.prepare(
    `UPDATE refund_policies SET ${sets.join(', ')} WHERE id = ?${vals.length + 1} AND portal_id = ?${vals.length + 2}`,
  )
    .bind(...vals, id, portalId)
    .run();
  if (result.meta.changes === 0) {
    return c.json({ status: 'not_found', message: 'Refund policy not found' }, 404);
  }
  const updated = await c.env.DB.prepare('SELECT * FROM refund_policies WHERE id = ?1')
    .bind(id)
    .first();
  return c.json(updated);
}

async function handleDeleteRefundPolicy(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const id = c.req.param('id') as string;
  const result = await c.env.DB.prepare(
    'DELETE FROM refund_policies WHERE id = ?1 AND portal_id = ?2',
  )
    .bind(id, portalId)
    .run();
  if (result.meta.changes === 0) {
    return c.json({ status: 'not_found', message: 'Refund policy not found' }, 404);
  }
  return c.json({ ok: true, id });
}

// ---------------------------------------------------------------------------
// Registrations list + refund + transfer (Phase 18.2)
// Reporting + export (Phase 2.2)
// ---------------------------------------------------------------------------

/** Default page size for the attendee list; a typical course fits in one page. */
const REGISTRATIONS_PAGE_SIZE = 100;
/** Ceiling on ?limit, so one request can't be asked to serialise an unbounded list. */
const REGISTRATIONS_MAX_PAGE_SIZE = 500;

function parsePageParam(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

type ReportEventRow = {
  id: string;
  title: string;
  category: string | null;
  starts_at: string;
  ends_at: string;
};

async function loadReportEvent(
  c: Context<ManageBindings>,
  portalId: string,
  eventId: string,
): Promise<ReportEventRow | null> {
  return c.env.DB.prepare(
    'SELECT id, title, category, starts_at, ends_at FROM events WHERE portal_id = ?1 AND id = ?2',
  )
    .bind(portalId, eventId)
    .first<ReportEventRow>();
}

/**
 * GET /events/:id/registrations — the full attendee list (Phase 2.2).
 *
 * Paginated, but the summary always describes the WHOLE event: a headline count that moved
 * because someone asked for page 2 is exactly the kind of number that started this
 * argument. Read entirely from D1 — never from HubSpot, or the report and the engine that
 * sold the seats will disagree and the argument repeats with fresh figures.
 */
async function handleListRegistrations(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const id = c.req.param('id') as string;

  const event = await loadReportEvent(c, portalId, id);
  if (!event) return c.json({ status: 'not_found', message: 'Event not found' }, 404);

  const rows = await listEventRegistrations(c.env, portalId, id);
  const limit = parsePageParam(
    c.req.query('limit'),
    REGISTRATIONS_PAGE_SIZE,
    REGISTRATIONS_MAX_PAGE_SIZE,
  );
  const offset = parsePageParam(c.req.query('offset'), 0, Number.MAX_SAFE_INTEGER);
  const page = rows.slice(offset, offset + limit);

  return c.json({
    eventId: event.id,
    eventTitle: event.title,
    eventCategory: event.category,
    eventStartsAt: event.starts_at,
    generatedAt: new Date().toISOString(),
    page: {
      limit,
      offset,
      total: rows.length,
      returned: page.length,
      hasMore: offset + page.length < rows.length,
    },
    summary: summariseRegistrations(rows),
    money: summariseMoney(rows),
    registrations: page,
  });
}

/**
 * GET /events/:id/registrations.csv — the same data as a download.
 *
 * The whole event, never a page: this is the artefact someone reconciles against a hand
 * count, and a hand count is of everybody. Same rows and same derivations as the JSON list
 * above, so the two can't disagree.
 */
async function handleExportRegistrationsCsv(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const id = c.req.param('id') as string;

  const event = await loadReportEvent(c, portalId, id);
  if (!event) return c.json({ status: 'not_found', message: 'Event not found' }, 404);

  // The event's question set supplies the answer columns, so a question that was asked but
  // that nobody answered still gets an (empty) column.
  const [rows, questions] = await Promise.all([
    listEventRegistrations(c.env, portalId, id),
    loadEventQuestions(c.env, portalId, id),
  ]);
  const generatedAt = new Date().toISOString();

  return new Response(registrationsToCsv(rows, questions), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${csvFilename(event.title, event.id, generatedAt)}"`,
      // A report is a point-in-time answer; a cached copy answering a later reconciliation
      // with yesterday's numbers is the failure mode this whole phase exists to end.
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * POST /events/:id/export-token — mint a short-lived CSV download link.
 *
 * The CSV route below is admin-bearer-authed, which a browser download cannot satisfy: a
 * navigation carries no headers, and a HubSpot App Card can only open a URL. An
 * authenticated caller mints a token here and hands the returned `url` to the browser.
 *
 * The response carries the absolute URL rather than just the token so every client builds
 * the same link — and so the token's short life is stated next to it, because a link that
 * silently stopped working would read as the export being broken.
 */
async function handleCreateExportToken(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const id = c.req.param('id') as string;

  const event = await loadReportEvent(c, portalId, id);
  if (!event) return c.json({ status: 'not_found', message: 'Event not found' }, 404);

  const { token, expiresAt } = await issueExportToken(
    c.env,
    portalId,
    id,
    'registrations.csv',
    DEFAULT_EXPORT_TTL_SECONDS,
  );

  const url = new URL(c.req.url);
  url.search = '';
  url.pathname = `/api/v1/exports/events/${encodeURIComponent(id)}/registrations.csv`;
  url.searchParams.set('token', token);

  return c.json({ url: url.toString(), expiresAt, expiresInSeconds: DEFAULT_EXPORT_TTL_SECONDS });
}

/**
 * GET /reports/registrations?from=&to=&category= — cross-event roll-up.
 *
 * Grouped by course category over a range of event start dates. Every figure is aggregated
 * from the same per-event lists the endpoint above returns, so the roll-up reconciles to
 * them by construction rather than by luck.
 */
async function handleRegistrationsReport(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');

  // A bare from/to date is a LOCAL calendar day. HubSpot's dashboards group by the portal's
  // timezone, so bounding the range in UTC would guarantee a few records' disagreement at
  // each end with the very report this is meant to reconcile against.
  const timeZone = await loadDisplayTimeZone(c.env, portalId);
  const from = normaliseRangeBound(c.req.query('from'), 'from', timeZone);
  const to = normaliseRangeBound(c.req.query('to'), 'to', timeZone);
  if (from !== null && to !== null && from > to) {
    return c.json({ status: 'invalid_range', message: '`from` must not be after `to`' }, 400);
  }

  const category = (c.req.query('category') ?? '').trim();
  const report = await buildRegistrationsReport(c.env, portalId, {
    from,
    to,
    category: category === '' ? null : category,
    timeZone,
  });
  return c.json(report);
}

async function handleCreateManualRegistration(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const id = c.req.param('id') as string;
  const idempotencyKey = cleanText(c.req.header('Idempotency-Key'), 180);

  if (!idempotencyKey) {
    return c.json(
      { status: 'missing_idempotency_key', message: 'Idempotency-Key header required' },
      400,
    );
  }

  const event = await c.env.DB.prepare('SELECT id FROM events WHERE portal_id = ?1 AND id = ?2')
    .bind(portalId, id)
    .first<{ id: string }>();
  if (!event) return c.json({ status: 'not_found', message: 'Event not found' }, 404);

  let body: {
    mode?: string;
    ticketTypeId?: string;
    attendeeEmail?: string;
    attendeeName?: string;
    attendeePhone?: string | null;
    attendeeSuburb?: string | null;
    attendeeState?: string | null;
    hubspotContactId?: string | null;
    memberCompanyId?: string | null;
    companyId?: string | null;
    buyerEmail?: string | null;
    buyerName?: string | null;
    invoiceDueDate?: string | null;
    staffActor?: string | null;
    staffNote?: string | null;
    /** Phase 2.3 — answers to the event's questions, keyed by question `key`. */
    answers?: QuestionAnswers;
    /** Order-scoped answers, asked once for the booking rather than per seat. */
    orderAnswers?: QuestionAnswers;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }

  const mode = normalizeManualRegistrationMode(body.mode ?? 'paid');
  if (!mode) {
    return c.json(
      { status: 'invalid_mode', message: 'mode must be "paid" or "complimentary"' },
      400,
    );
  }

  const ticketTypeId = cleanText(body.ticketTypeId, 120);
  const attendeeEmail = cleanEmail(body.attendeeEmail);
  const attendeeName = cleanText(body.attendeeName, 160);
  const buyerEmail = cleanEmail(body.buyerEmail || attendeeEmail);
  const buyerName = cleanText(body.buyerName || attendeeName, 160);
  const hubspotContactId = cleanText(body.hubspotContactId, 80);
  const memberCompanyId = cleanText(body.memberCompanyId || body.companyId, 80);
  // Phase 1.2 — optional on a staff booking; whatever is supplied is written back to the
  // contact only where HubSpot is empty (see contact.sync_attendee_details).
  const attendeePhone = cleanText(body.attendeePhone, 40);
  const attendeeSuburb = cleanText(body.attendeeSuburb, 120);
  const attendeeState = cleanText(body.attendeeState, 60);

  if (!ticketTypeId) {
    return c.json({ status: 'missing_ticket_type', message: 'ticketTypeId is required' }, 400);
  }
  if (!attendeeName || !isValidEmail(attendeeEmail)) {
    return c.json(
      {
        status: 'invalid_attendee',
        message: 'attendeeName and a valid attendeeEmail are required',
      },
      400,
    );
  }
  if (!buyerName || !isValidEmail(buyerEmail)) {
    return c.json(
      { status: 'invalid_buyer', message: 'buyerName and a valid buyerEmail are required' },
      400,
    );
  }
  if (hubspotContactId && !VALID_HUBSPOT_ID.test(hubspotContactId)) {
    return c.json(
      { status: 'invalid_contact_id', message: 'hubspotContactId must be a numeric HubSpot ID' },
      400,
    );
  }
  if (memberCompanyId && !VALID_HUBSPOT_ID.test(memberCompanyId)) {
    return c.json(
      {
        status: 'invalid_company_id',
        message: 'memberCompanyId must be a numeric HubSpot Company ID',
      },
      400,
    );
  }

  const reserveResponse = await reserveEventWithBody(
    c as unknown as Context<{ Bindings: Env }>,
    portalId,
    {
      eventId: id,
      idempotencyKey,
      body: {
        buyer: {
          email: buyerEmail,
          name: buyerName,
          ...(hubspotContactId ? { hubspotContactId } : {}),
        },
        attendees: [
          {
            email: attendeeEmail,
            name: attendeeName,
            ticketTypeId,
            ...(hubspotContactId ? { hubspotContactId } : {}),
            ...(attendeePhone ? { phone: attendeePhone } : {}),
            ...(attendeeSuburb ? { suburb: attendeeSuburb } : {}),
            ...(attendeeState ? { state: attendeeState } : {}),
            // Validated by reserve against the event's own question set, exactly as a
            // public booking's are: a required question a staff booking could not satisfy
            // would make the manage route unusable on any event that asks one.
            ...(body.answers ? { answers: body.answers } : {}),
          },
        ],
        ...(body.orderAnswers ? { answers: body.orderAnswers } : {}),
        ...(memberCompanyId ? { memberCompanyId } : {}),
      },
      options: {
        forceFree: mode === 'complimentary',
        source: 'staff_manual',
        invoiceDueDate: body.invoiceDueDate ?? null,
        staffActor: cleanText(body.staffActor, 160) || null,
        staffNote: cleanText(body.staffNote, 500) || null,
      },
    },
  );

  const responseBody = (await reserveResponse
    .clone()
    .json()
    .catch(() => ({}))) as Record<string, unknown>;
  return c.json(
    {
      ok: reserveResponse.ok,
      mode,
      manual: true,
      ...responseBody,
    },
    reserveResponse.status as 200 | 400 | 403 | 404 | 409 | 500,
  );
}

// ---------------------------------------------------------------------------
// POST /events/:id/seat-blocks
// ---------------------------------------------------------------------------

/**
 * Hold and invoice N seats for a company before the attendee names are known (Ref 74b).
 *
 * Not a new kind of booking — it goes through the same reserve as everything else, so it
 * prices, holds and invoices identically and drops public availability the moment it is
 * placed. What it skips is the people: each seat becomes a registration carrying
 * `seat_unnamed`, and names attach one at a time through
 * `PATCH /events/:id/registrations/:regId` whenever the company sends them.
 *
 * Staff-authed rather than public, because the buyer here is a company being invoiced on
 * terms and an anonymous caller must not be able to take twenty seats off sale.
 */
async function handleCreateSeatBlock(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const id = c.req.param('id') as string;
  const idempotencyKey = cleanText(c.req.header('Idempotency-Key'), 180);
  if (!idempotencyKey) {
    return c.json(
      { status: 'missing_idempotency_key', message: 'Idempotency-Key header required' },
      400,
    );
  }

  const event = await c.env.DB.prepare('SELECT id FROM events WHERE portal_id = ?1 AND id = ?2')
    .bind(portalId, id)
    .first<{ id: string }>();
  if (!event) return c.json({ status: 'not_found', message: 'Event not found' }, 404);

  let body: {
    ticketTypeId?: string;
    seats?: number;
    buyerEmail?: string;
    buyerName?: string;
    buyerAbn?: string | null;
    memberCompanyId?: string | null;
    companyId?: string | null;
    invoiceDueDate?: string | null;
    staffActor?: string | null;
    staffNote?: string | null;
    /** Order-scoped answers — a purchase order number for the block, asked once. */
    orderAnswers?: QuestionAnswers;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }

  const ticketTypeId = cleanText(body.ticketTypeId, 120);
  const buyerEmail = cleanEmail(body.buyerEmail);
  const buyerName = cleanText(body.buyerName, 160);
  const seats = Number(body.seats);
  if (!ticketTypeId || !buyerEmail || !buyerName || !Number.isInteger(seats) || seats < 1) {
    return c.json(
      {
        status: 'missing_fields',
        message: 'ticketTypeId, seats (at least 1), buyerEmail and buyerName are required',
      },
      400,
    );
  }

  const memberCompanyId = cleanText(body.memberCompanyId || body.companyId, 80);

  const reserveResponse = await reserveEventWithBody(
    c as unknown as Context<{ Bindings: Env }>,
    portalId,
    {
      eventId: id,
      idempotencyKey,
      body: {
        buyer: {
          email: buyerEmail,
          name: buyerName,
          ...(cleanText(body.buyerAbn, 20) ? { abn: cleanText(body.buyerAbn, 20) } : {}),
        },
        unnamedSeats: [{ ticketTypeId, quantity: seats }],
        ...(body.orderAnswers ? { answers: body.orderAnswers } : {}),
        ...(memberCompanyId ? { memberCompanyId } : {}),
      },
      options: {
        source: 'staff_manual',
        invoiceDueDate: body.invoiceDueDate ?? null,
        staffActor: cleanText(body.staffActor, 160) || null,
        staffNote: cleanText(body.staffNote, 500) || null,
      },
    },
  );

  const responseBody = (await reserveResponse
    .clone()
    .json()
    .catch(() => ({}))) as Record<string, unknown>;
  return c.json(
    { ok: reserveResponse.ok, seats, ...responseBody },
    reserveResponse.status as 200 | 400 | 403 | 404 | 409 | 500,
  );
}

async function handleRefundRegistration(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const id = c.req.param('id') as string;
  const regId = c.req.param('regId') as string;

  // Resolve the registration's order (refunds are order-level: one invoice per order).
  const reg = await c.env.DB.prepare(
    'SELECT order_id FROM registrations WHERE id = ?1 AND portal_id = ?2 AND event_id = ?3',
  )
    .bind(regId, portalId, id)
    .first<{ order_id: string }>();
  if (!reg) return c.json({ status: 'not_found', message: 'Registration not found' }, 404);

  const result = await executeRefund(c.env, portalId, reg.order_id);
  if (result.status === 'noop') {
    return c.json({ ok: false, reason: result.reason }, 409);
  }
  return c.json({ ok: true, outcome: result.outcome });
}

async function handleTransferRegistration(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const regId = c.req.param('regId') as string;
  let body: { toEmail?: string; toName?: string; reason?: string | null };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }
  if (!body.toEmail || !body.toName) {
    return c.json({ status: 'missing_fields', message: 'toEmail and toName are required' }, 400);
  }

  const result = await transferRegistration(c.env, {
    portalId,
    registrationId: regId,
    toEmail: body.toEmail,
    toName: body.toName,
    reason: body.reason ?? null,
  });
  if (!result.ok) {
    const code = result.error === 'transfer_not_allowed' ? 403 : 404;
    return c.json({ ok: false, error: result.error }, code);
  }
  return c.json({ ok: true, ticketId: result.ticketId });
}

// ---------------------------------------------------------------------------
// Amend / cancel one registration (Phase 3.2)
//
// Both are per-REGISTRATION, which is the point: a corporate booking is one order holding
// several seats, and until now the only thing that could be edited or cancelled was the
// whole booking. `:regId` is checked against `:id` so a registration can only be reached
// through the event it belongs to.
// ---------------------------------------------------------------------------

async function handleAmendRegistration(c: Context<ManageBindings>): Promise<Response> {
  const resolved = await resolveRegistrationForNotes(c);
  if (resolved instanceof Response) return resolved;

  let body: {
    name?: string | null;
    email?: string | null;
    contact?: { phone?: string | null; suburb?: string | null; state?: string | null } | null;
    answers?: QuestionAnswers | null;
    reissueTicket?: boolean;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }

  const result = await amendRegistration(c.env, {
    portalId: resolved.portalId,
    registrationId: resolved.registrationId,
    name: body.name,
    email: body.email,
    contact: body.contact,
    answers: body.answers,
    reissueTicket: body.reissueTicket === true,
  });

  if (!result.ok) {
    // 404 for "no such thing", 409 for a state that forbids the edit, 400 for a bad edit.
    const code =
      result.error === 'registration_not_found' || result.error === 'event_not_found'
        ? 404
        : result.error === 'registration_cancelled' || result.error === 'duplicate_attendee'
          ? 409
          : 400;
    return c.json(
      { ok: false, error: result.error, message: result.message, questionKey: result.questionKey },
      code,
    );
  }
  return c.json({
    ok: true,
    changed: result.changed,
    ticketId: result.ticketId,
    ticketReissued: result.ticketReissued,
  });
}

async function handleCancelRegistration(c: Context<ManageBindings>): Promise<Response> {
  const resolved = await resolveRegistrationForNotes(c);
  if (resolved instanceof Response) return resolved;

  // DELETE carries a body here (reason, refund choice) rather than query parameters: a
  // cancellation reason is free text a person types, and putting it in a URL would land it
  // in every access log between the App Card and the Worker.
  let body: { reason?: string | null; refund?: string; refundAmountCents?: number | null } = {};
  try {
    const raw = await c.req.text();
    if (raw.trim() !== '') body = JSON.parse(raw);
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }

  if (body.refund !== undefined && body.refund !== 'policy' && body.refund !== 'none') {
    return c.json({ status: 'invalid_refund', message: "refund must be 'policy' or 'none'" }, 400);
  }

  const result = await cancelRegistration(c.env, {
    portalId: resolved.portalId,
    registrationId: resolved.registrationId,
    reason: cleanText(body.reason ?? '', 500) || null,
    refund: body.refund as 'policy' | 'none' | undefined,
    refundAmountCents: body.refundAmountCents ?? null,
  });

  if (!result.ok) {
    const code = result.error === 'already_cancelled' ? 409 : 404;
    return c.json({ ok: false, error: result.error, message: result.message }, code);
  }
  return c.json(result);
}

// ---------------------------------------------------------------------------
// Pending decisions (Phase 18.3) — oversell + waitlist, resolved by the event owner.
// ---------------------------------------------------------------------------

async function handleListPendingDecisions(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const id = c.req.param('id') as string;

  const event = await c.env.DB.prepare('SELECT id FROM events WHERE portal_id = ?1 AND id = ?2')
    .bind(portalId, id)
    .first();
  if (!event) return c.json({ status: 'not_found', message: 'Event not found' }, 404);

  const decisions = await listPendingDecisions(c.env, portalId, id);
  // Parse context JSON for the card so it doesn't have to.
  const out = decisions.map((d) => ({
    ...d,
    context: d.context ? JSON.parse(d.context) : null,
  }));
  return c.json(out);
}

async function handleResolveDecision(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const decisionId = c.req.param('id') as string;
  let body: { action?: string; waitlistIds?: string[]; resolvedBy?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }

  const result = await resolveDecision(c.env, portalId, decisionId, {
    action: body.action,
    waitlistIds: body.waitlistIds,
    resolvedBy: body.resolvedBy,
  });
  if (!result.ok) {
    const code = result.error === 'decision_not_found' ? 404 : 409;
    return c.json({ ok: false, error: result.error }, code);
  }
  return c.json({ ok: true, detail: result.detail });
}

// ---------------------------------------------------------------------------
// PATCH /onboarding/membership-config (Phase 18.1)
// Sets which HubSpot contact properties hold the membership status + level + category, the
// raw→canonical value maps (JSON), and the imported Xero GST-free rate id.
// membership_status_property falls back to 'membership_status' when unset (see 0012).
//
// 0046 adds the sources that used to be Weld's names hard-coded in membership.ts: the
// company property families (`companySources`, priority order), the contact's mirror of
// its employer (`mirrorStatusProperty` / `mirrorTierProperty`) and the Find a Member HubDB
// directory (`memberDirectory`). Each is the tenant's schema with no built-in default, so a
// malformed one is refused here rather than stored and read as nothing, and `null` clears
// it, which stops that source being read at all.
// ---------------------------------------------------------------------------

async function handlePatchMembershipConfig(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  let body: {
    membershipStatusProperty?: string | null;
    membershipLevelProperty?: string | null;
    memberCategoryProperty?: string | null;
    valueMaps?: unknown;
    xeroGstFreeRateId?: string | null;
    companySources?: unknown;
    mirrorStatusProperty?: unknown;
    mirrorTierProperty?: unknown;
    memberDirectory?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }

  // Validate the 0046 sources before anything is written, so one bad field cannot leave
  // the rest of the body half-applied.
  let companySources: string | null | undefined;
  if (body.companySources !== undefined) {
    if (body.companySources === null) {
      companySources = null;
    } else {
      const parsed = parseCompanySources(body.companySources);
      if (!parsed) {
        return c.json(
          {
            status: 'invalid_company_sources',
            message:
              'companySources must be an array of { category, statusProperty, levelProperty }, ' +
              `category one of ${MEMBER_CATEGORIES.join(', ')}, property names of letters, ` +
              'digits and underscores (levelProperty may be null)',
          },
          400,
        );
      }
      companySources = JSON.stringify(parsed);
    }
  }
  for (const key of ['mirrorStatusProperty', 'mirrorTierProperty'] as const) {
    const value = body[key];
    if (value !== undefined && value !== null && !isConfigName(value)) {
      return c.json(
        {
          status: 'invalid_mirror_property',
          message: `${key} must be a HubSpot property name (letters, digits, underscores) or null`,
        },
        400,
      );
    }
  }
  let memberDirectory: string | null | undefined;
  if (body.memberDirectory !== undefined) {
    if (body.memberDirectory === null) {
      memberDirectory = null;
    } else {
      const parsed = parseMemberDirectoryConfig(body.memberDirectory);
      if (!parsed) {
        return c.json(
          {
            status: 'invalid_member_directory',
            message:
              'memberDirectory must be { table, emailColumn, tierColumn, activeColumn, ' +
              'companyIdColumn }, every one a HubDB name of letters, digits and underscores',
          },
          400,
        );
      }
      memberDirectory = JSON.stringify(parsed);
    }
  }

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (body.membershipStatusProperty !== undefined) {
    sets.push(`membership_status_property = ?${sets.length + 1}`);
    vals.push(body.membershipStatusProperty);
  }
  if (body.membershipLevelProperty !== undefined) {
    sets.push(`membership_level_property = ?${sets.length + 1}`);
    vals.push(body.membershipLevelProperty);
  }
  if (body.memberCategoryProperty !== undefined) {
    sets.push(`member_category_property = ?${sets.length + 1}`);
    vals.push(body.memberCategoryProperty);
  }
  if (body.valueMaps !== undefined) {
    sets.push(`membership_value_maps = ?${sets.length + 1}`);
    vals.push(body.valueMaps == null ? null : JSON.stringify(body.valueMaps));
  }
  if (body.xeroGstFreeRateId !== undefined) {
    sets.push(`xero_gst_free_rate_id = ?${sets.length + 1}`);
    vals.push(body.xeroGstFreeRateId);
  }
  if (companySources !== undefined) {
    sets.push(`membership_company_sources = ?${sets.length + 1}`);
    vals.push(companySources);
  }
  if (body.mirrorStatusProperty !== undefined) {
    sets.push(`membership_mirror_status_property = ?${sets.length + 1}`);
    vals.push(body.mirrorStatusProperty);
  }
  if (body.mirrorTierProperty !== undefined) {
    sets.push(`membership_mirror_tier_property = ?${sets.length + 1}`);
    vals.push(body.mirrorTierProperty);
  }
  if (memberDirectory !== undefined) {
    sets.push(`member_directory_config = ?${sets.length + 1}`);
    vals.push(memberDirectory);
  }
  if (sets.length === 0) {
    return c.json({ status: 'no_fields', message: 'No updatable fields provided' }, 400);
  }

  await c.env.DB.prepare(
    `UPDATE tenants SET ${sets.join(', ')} WHERE portal_id = ?${vals.length + 1}`,
  )
    .bind(...vals, portalId)
    .run();
  return c.json({ ok: true });
}

// ---------------------------------------------------------------------------
// PATCH /onboarding/hubdb-pricing (0035, extended by 0044)
// Points the Worker at the HubDB tables the tenant adds their sessions in, so prices are
// read from the row the buyer was actually quoted from rather than from a second copy in
// `pricing_rules`. Clearing a table (null) reverts that table to pricing_rules-only.
//
// TWO TABLES, ONE ENDPOINT. 0035 configured the courses table; 0044 added the events one,
// because nothing about the resolver was ever course-specific and Weld were typing member
// prices into their `events` rows that nothing read (QA ref 73). The `courses*` keys keep
// their original names so no existing caller changes.
//
// `priceColumns` is the tenant's own schema and is REQUIRED alongside a table — there are
// no built-in column names to fall back on (../hubdb-pricing.ts). Enabling a table without
// them would read columns the portal does not have, find nothing, and quietly price every
// member from the stale `pricing_rules` copy instead, which is the failure this path
// exists to end. So a table arrives with a mapping or it is refused here, rather than
// half-configured and silently inert.
//
// `discountColumns` (0044) map a member level to a column holding a PERCENTAGE off the
// non-member price, which is how Weld's events table states its tiers. Optional, and
// refused without a `nonMember` price column to take the percentage off: a discount with
// no base can never apply, which is the same silent inertness.
// ---------------------------------------------------------------------------

interface HubDbPricingTablePatch {
  kind: HubDbPricingSourceKind;
  /** Body keys, in the shape each table's caller already uses. */
  tableKey: 'coursesTable' | 'eventsTable';
  eventIdKey: 'eventIdColumn' | 'eventsEventIdColumn';
  priceKey: 'priceColumns' | 'eventPriceColumns';
  discountKey: 'discountColumns' | 'eventDiscountColumns';
  /** Tenants columns. */
  tableCol: string;
  eventIdCol: string;
  priceCol: string;
  discountCol: string;
}

const HUBDB_PRICING_TABLES: HubDbPricingTablePatch[] = [
  {
    kind: 'courses',
    tableKey: 'coursesTable',
    eventIdKey: 'eventIdColumn',
    priceKey: 'priceColumns',
    discountKey: 'discountColumns',
    tableCol: 'hubdb_courses_table',
    eventIdCol: 'hubdb_courses_event_id_column',
    priceCol: 'hubdb_course_price_columns',
    discountCol: 'hubdb_course_discount_columns',
  },
  {
    kind: 'events',
    tableKey: 'eventsTable',
    eventIdKey: 'eventsEventIdColumn',
    priceKey: 'eventPriceColumns',
    discountKey: 'eventDiscountColumns',
    tableCol: 'hubdb_events_table',
    eventIdCol: 'hubdb_events_event_id_column',
    priceCol: 'hubdb_event_price_columns',
    discountCol: 'hubdb_event_discount_columns',
  },
];

async function handlePatchHubDbPricing(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }

  const sets: string[] = [];
  const vals: unknown[] = [];

  for (const table of HUBDB_PRICING_TABLES) {
    const rawTable = body[table.tableKey];
    const rawPrice = body[table.priceKey];
    const rawDiscount = body[table.discountKey];

    const priceColumns =
      rawPrice === undefined || rawPrice === null ? null : stripBlankColumnNames(rawPrice);
    const discountColumns =
      rawDiscount === undefined || rawDiscount === null
        ? null
        : stripBlankDiscountColumnNames(rawDiscount);

    if (priceColumns != null && Object.keys(priceColumns).length === 0) {
      return c.json(
        {
          status: 'invalid_price_columns',
          table: table.kind,
          message:
            `${table.priceKey} must map at least one of ` +
            `${PRICE_COLUMN_KEYS.join(', ')} to a HubDB column name in this portal's ` +
            `${table.kind} table.`,
        },
        400,
      );
    }

    if (discountColumns != null && Object.keys(discountColumns).length === 0) {
      return c.json(
        {
          status: 'invalid_discount_columns',
          table: table.kind,
          message:
            `${table.discountKey} must map at least one of ` +
            `${DISCOUNT_COLUMN_KEYS.join(', ')} to a HubDB column name, or be null.`,
        },
        400,
      );
    }

    // Turning the table ON: the portal must end this request with a price mapping, whether
    // it came in this body or was set by an earlier call.
    const enablingTable = typeof rawTable === 'string' && rawTable.trim() !== '';
    const effectivePriceColumns =
      priceColumns ?? (await loadHubDbPricingColumns(c.env, portalId, table.kind));

    if (enablingTable && !effectivePriceColumns) {
      return c.json(
        {
          status: 'price_columns_required',
          table: table.kind,
          message:
            `Set ${table.priceKey} in the same request as ${table.tableKey}. There are no ` +
            'default HubDB column names: an unmapped portal reads no prices and stays on ' +
            'pricing_rules.',
        },
        400,
      );
    }

    // A discount is a percentage OFF the public price, so without a public column it can
    // never be applied — configuration that looks set and prices nothing.
    if (discountColumns && !effectivePriceColumns?.nonMember) {
      return c.json(
        {
          status: 'discount_needs_non_member_column',
          table: table.kind,
          message:
            `${table.discountKey} is a percentage off the non-member price, so ` +
            `${table.priceKey}.nonMember must name the column holding it.`,
        },
        400,
      );
    }

    if (rawTable !== undefined) {
      sets.push(`${table.tableCol} = ?${sets.length + 1}`);
      vals.push(rawTable);
    }
    if (body[table.eventIdKey] !== undefined) {
      sets.push(`${table.eventIdCol} = ?${sets.length + 1}`);
      vals.push(body[table.eventIdKey]);
    }
    if (rawPrice !== undefined) {
      sets.push(`${table.priceCol} = ?${sets.length + 1}`);
      vals.push(priceColumns == null ? null : JSON.stringify(priceColumns));
    }
    if (rawDiscount !== undefined) {
      sets.push(`${table.discountCol} = ?${sets.length + 1}`);
      vals.push(discountColumns == null ? null : JSON.stringify(discountColumns));
    }
  }

  if (sets.length === 0) {
    return c.json({ status: 'no_fields', message: 'No updatable fields provided' }, 400);
  }

  await c.env.DB.prepare(
    `UPDATE tenants SET ${sets.join(', ')} WHERE portal_id = ?${vals.length + 1}`,
  )
    .bind(...vals, portalId)
    .run();
  return c.json({ ok: true });
}

// ---------------------------------------------------------------------------
// POST /onboarding/hubdb-pricing/sync (0035)
// Backfill: mirror every event's HubDB member prices into `pricing_rules`.
//
// HubDB is read live at reserve time (../pricing.ts), so this sync is not what makes
// member pricing correct day to day — it keeps the FALLBACK honest for when the HubDB
// read cannot happen (expired token, HubSpot outage, a session whose row was deleted).
// Before it existed those fallback rows were hand-entered and had drifted badly: on the
// live Weld portal 11 upcoming events had no rules at all and the rest had ragged
// per-tier coverage, so any member landing on the fallback path was quoted a member
// price and charged the standard one.
//
// Idempotent. Re-running replaces the event-scoped rules this sync owns
// (member_category = 'member') and leaves every hand-written rule alone, including the
// more-specific ticket_type-scoped ones — those still shadow event rules in the
// fallback, so the response counts them for review.
//
// Query: ?dryRun=true to report the plan without writing.
// ---------------------------------------------------------------------------

interface HubDbPricingSyncEvent {
  eventId: string;
  title: string;
  status: 'synced' | 'no_hubdb_row' | 'no_prices';
  /** Which configured table held the row. Two tables, so "which one" is a real question. */
  source?: HubDbPricingSourceKind;
  prices?: Partial<Record<MemberPriceLevel, number>>;
  shadowedByTicketTypeRules?: number;
}

async function handleSyncHubDbPricing(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const dryRun = c.req.query('dryRun') === 'true';

  const sources = await loadHubDbPricingSources(c.env, portalId);
  if (sources.length === 0) {
    return c.json(
      {
        status: 'not_configured',
        message:
          'No HubDB pricing table configured for this portal. PATCH /onboarding/hubdb-pricing first.',
      },
      409,
    );
  }

  const token = await resolveHubSpotReadToken(c.env, portalId);
  if (!token) {
    return c.json(
      { status: 'no_token', message: 'No HubSpot read token available for this portal' },
      409,
    );
  }

  const events = await c.env.DB.prepare(
    'SELECT id, hubspot_event_id, title FROM events WHERE portal_id = ?1 ORDER BY starts_at DESC',
  )
    .bind(portalId)
    .all<{ id: string; hubspot_event_id: string; title: string }>();

  const results: HubDbPricingSyncEvent[] = [];
  let rulesWritten = 0;

  for (const event of events.results ?? []) {
    const hit = await fetchHubDbPricingRow({
      sources,
      token,
      eventId: event.id,
      hubspotEventId: event.hubspot_event_id,
      portalId,
    });
    if (!hit) {
      results.push({ eventId: event.id, title: event.title, status: 'no_hubdb_row' });
      continue;
    }

    // Resolved against the source the row actually came out of, so a portal pricing its
    // courses absolutely and its events by discount mirrors both correctly.
    const prices = readHubDbTierPrices(hit.row, hit.source);
    const levels = Object.keys(prices) as MemberPriceLevel[];
    if (levels.length === 0) {
      results.push({
        eventId: event.id,
        title: event.title,
        status: 'no_prices',
        source: hit.source.kind,
      });
      continue;
    }

    const shadowing = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM pricing_rules
        WHERE portal_id = ?1 AND scope = 'ticket_type'
          AND scope_id IN (SELECT id FROM ticket_types WHERE event_id = ?2 AND portal_id = ?1)`,
    )
      .bind(portalId, event.id)
      .first<{ n: number }>();

    if (!dryRun) {
      const now = new Date().toISOString();
      const statements = [
        c.env.DB.prepare(
          `DELETE FROM pricing_rules
            WHERE portal_id = ?1 AND scope = 'event' AND scope_id = ?2 AND member_category = 'member'`,
        ).bind(portalId, event.id),
        ...levels.map((level) =>
          c.env.DB.prepare(
            `INSERT INTO pricing_rules
               (id, portal_id, scope, scope_id, member_level, member_category,
                discount_percent, fixed_price_cents, created_at)
             VALUES (?1, ?2, 'event', ?3, ?4, 'member', NULL, ?5, ?6)`,
          ).bind(crypto.randomUUID(), portalId, event.id, level, prices[level], now),
        ),
      ];
      // One batch per event: a half-written price table is worse than an unchanged one.
      await c.env.DB.batch(statements);
      rulesWritten += levels.length;
    }

    results.push({
      eventId: event.id,
      title: event.title,
      status: 'synced',
      source: hit.source.kind,
      prices,
      shadowedByTicketTypeRules: shadowing?.n ?? 0,
    });
  }

  return c.json({
    ok: true,
    dryRun,
    eventsScanned: results.length,
    eventsSynced: results.filter((r) => r.status === 'synced').length,
    eventsWithoutHubDbRow: results.filter((r) => r.status === 'no_hubdb_row').length,
    rulesWritten,
    events: results,
  });
}

// ---------------------------------------------------------------------------
// PATCH /onboarding/hubdb-capacity (0045)
// Which HubDB column holds each session's TOTAL seats. Staff edit the timetable in HubDB,
// so that is where they raise a course from 24 to 30 seats, and until 0045 nothing read
// it (QA ref 87). Tenant schema, no default, like the price columns: a portal that maps
// nothing keeps managing capacity in the app card. null clears a mapping.
//
// A capacity column needs its TABLE configured (PATCH /onboarding/hubdb-pricing): the row
// is found by the same lookup a price is, so a session's seats and its price cannot come
// from two different rows.
// ---------------------------------------------------------------------------

const HUBDB_CAPACITY_TABLES = [
  {
    kind: 'courses',
    key: 'coursesCapacityColumn',
    col: 'hubdb_courses_capacity_column',
    tableCol: 'hubdb_courses_table',
  },
  {
    kind: 'events',
    key: 'eventsCapacityColumn',
    col: 'hubdb_events_capacity_column',
    tableCol: 'hubdb_events_table',
  },
] as const;

async function handlePatchHubDbCapacity(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }

  const tenant = await c.env.DB.prepare(
    'SELECT hubdb_courses_table, hubdb_events_table FROM tenants WHERE portal_id = ?1',
  )
    .bind(portalId)
    .first<{ hubdb_courses_table: string | null; hubdb_events_table: string | null }>();

  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const t of HUBDB_CAPACITY_TABLES) {
    const raw = body[t.key];
    if (raw === undefined) continue;
    if (raw !== null && typeof raw !== 'string') {
      return c.json(
        {
          status: 'invalid_capacity_column',
          table: t.kind,
          message: `${t.key} must be a string or null`,
        },
        400,
      );
    }
    const value = typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
    if (value && !tenant?.[t.tableCol]?.trim()) {
      return c.json(
        {
          status: 'table_required',
          table: t.kind,
          message:
            `No HubDB ${t.kind} table is configured for this portal. Set it with ` +
            'PATCH /onboarding/hubdb-pricing first: capacity is read from the same row as price.',
        },
        400,
      );
    }
    sets.push(`${t.col} = ?${sets.length + 1}`);
    vals.push(value);
  }

  if (sets.length === 0) {
    return c.json({ status: 'no_fields', message: 'No updatable fields provided' }, 400);
  }
  await c.env.DB.prepare(
    `UPDATE tenants SET ${sets.join(', ')} WHERE portal_id = ?${vals.length + 1}`,
  )
    .bind(...vals, portalId)
    .run();
  return c.json({ ok: true });
}

// ---------------------------------------------------------------------------
// POST /onboarding/hubdb-capacity/sync (0045)
// Reconcile every event's capacity with its HubDB row NOW, rather than waiting for the
// next reserve or page view. Run after mapping the column or after a bulk HubDB edit.
// Each changed event's DO is re-synced from D1 on the spot, so the website reads the new
// number on its next availability call. Seats already sold are untouched whatever the
// new number is: the DO counts them itself.
// ---------------------------------------------------------------------------

async function handleSyncHubDbCapacity(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const sources = await loadHubDbCapacitySources(c.env, portalId);
  if (sources.length === 0) {
    return c.json(
      {
        status: 'not_configured',
        message:
          'No HubDB capacity column configured for this portal. PATCH /onboarding/hubdb-capacity first.',
      },
      409,
    );
  }

  // Upcoming events only: capacity on a session that has run changes nothing a buyer sees.
  const events = await c.env.DB.prepare(
    `SELECT * FROM events WHERE portal_id = ?1 AND ends_at >= ?2 ORDER BY starts_at ASC`,
  )
    .bind(portalId, new Date().toISOString())
    .all<EventRow>();

  const results: Array<{
    eventId: string;
    title: string;
    status: string;
    from?: number | null;
    to?: number;
  }> = [];
  for (const event of events.results ?? []) {
    const ticketTypes = await loadTicketTypes(c.env.DB, event.id);
    const outcome = await syncEventCapacityFromHubDb(c.env, portalId, event, ticketTypes);
    if (outcome.status === 'updated') {
      const stub = c.env.EVENT_CAPACITY.get(
        c.env.EVENT_CAPACITY.idFromName(`${portalId}:${event.hubspot_event_id}`),
      );
      await syncCapacityFromD1(stub, event, ticketTypes);
      results.push({
        eventId: event.id,
        title: event.title,
        status: 'updated',
        from: outcome.from,
        to: outcome.to,
      });
    } else {
      results.push({ eventId: event.id, title: event.title, status: outcome.status });
    }
    if (outcome.status === 'no_token') break;
  }

  return c.json({
    ok: true,
    eventsScanned: results.length,
    eventsUpdated: results.filter((r) => r.status === 'updated').length,
    eventsWithoutHubDbRow: results.filter((r) => r.status === 'no_hubdb_row').length,
    eventsWithoutCapacity: results.filter((r) => r.status === 'no_capacity').length,
    events: results,
  });
}

// ---------------------------------------------------------------------------
// PATCH /onboarding/contact-property-config (Phase 1.2)
// Which HubSpot CONTACT properties attendee phone / suburb / state write back to.
// Null/'' resets a field to HubSpot's standard property (phone / city / state); 'off'
// stops the worker writing that field at all. Only a portal that keys these somewhere
// non-standard needs to send anything here.
// ---------------------------------------------------------------------------

async function handlePatchContactPropertyConfig(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  let body: {
    contactPhoneProperty?: string | null;
    contactSuburbProperty?: string | null;
    contactStateProperty?: string | null;
    /** 0026 — where the online-event join URL goes. 'off' stops it being written. */
    contactJoinUrlProperty?: string | null;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }

  const columns: Array<[keyof typeof body, string]> = [
    ['contactPhoneProperty', 'contact_phone_property'],
    ['contactSuburbProperty', 'contact_suburb_property'],
    ['contactStateProperty', 'contact_state_property'],
    ['contactJoinUrlProperty', 'contact_join_url_property'],
  ];

  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [key, column] of columns) {
    const value = body[key];
    if (value === undefined) continue;
    // '' resets to the standard property rather than mapping to a property named ''.
    const normalised = typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
    sets.push(`${column} = ?${sets.length + 1}`);
    vals.push(normalised);
  }
  if (sets.length === 0) {
    return c.json({ status: 'no_fields', message: 'No updatable fields provided' }, 400);
  }

  await c.env.DB.prepare(
    `UPDATE tenants SET ${sets.join(', ')} WHERE portal_id = ?${vals.length + 1}`,
  )
    .bind(...vals, portalId)
    .run();
  return c.json({ ok: true });
}

// ---------------------------------------------------------------------------
// PATCH /onboarding/attendance-property-config (Phase 2.1)
// Which HubSpot CONTACT properties attendance writes to. Null/'' resets a field to its
// default name (event_attended / event_last_attended_date / event_last_attended_name);
// 'off' stops the worker writing that field at all. Only a portal that keys attendance
// somewhere else needs to send anything here.
// ---------------------------------------------------------------------------

async function handlePatchAttendancePropertyConfig(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  let body: {
    contactAttendedProperty?: string | null;
    contactAttendedDateProperty?: string | null;
    contactAttendedEventProperty?: string | null;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }

  const columns: Array<[keyof typeof body, string]> = [
    ['contactAttendedProperty', 'contact_attended_property'],
    ['contactAttendedDateProperty', 'contact_attended_date_property'],
    ['contactAttendedEventProperty', 'contact_attended_event_property'],
  ];

  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [key, column] of columns) {
    const value = body[key];
    if (value === undefined) continue;
    // '' resets to the default property rather than mapping to a property named ''.
    const normalised = typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
    sets.push(`${column} = ?${sets.length + 1}`);
    vals.push(normalised);
  }
  if (sets.length === 0) {
    return c.json({ status: 'no_fields', message: 'No updatable fields provided' }, 400);
  }

  await c.env.DB.prepare(
    `UPDATE tenants SET ${sets.join(', ')} WHERE portal_id = ?${vals.length + 1}`,
  )
    .bind(...vals, portalId)
    .run();

  const config = await loadAttendanceContactConfig(c.env, portalId);
  return c.json({
    ok: true,
    propertyMapping: Object.fromEntries(
      ATTENDANCE_FIELDS.map((field) => [field, attendancePropertyFor(config, field)]),
    ),
  });
}

// ---------------------------------------------------------------------------
// PATCH /onboarding/voucher-config
//
// Which HubSpot COMPANY properties hold the tenant's voucher allowance and usage, and
// which unit they are counted in. Every other per-tenant mapping has had an endpoint since
// the feature landed; this one did not, so the only way to configure vouchers was a hand
// written UPDATE against production D1 — the same "fully built, nothing to drive it with"
// gap Phase 2.3's questions had before the app card rendered them.
//
// **The default is ON, and that is the trap this guards.** `loadVoucherConfig` falls back
// to `seat` / `vouchers_total` / `vouchers_used`, so an unconfigured portal is not
// vouchers-off: it reads an allowance property it does not have, resolves every company to
// a zero balance, covers no seats, and dies on the usage write-back. Weld is in exactly
// that state — their allowance is `vouchers_allowance` and usage `vouchers_used__training`.
//
// So turning vouchers on REQUIRES both property names, the same rule and the same reason
// `PATCH /onboarding/hubdb-pricing` refuses a courses table without its price columns:
// there are no built-in names worth falling back on, and a half-configured portal is
// silently inert rather than visibly broken. `mode: 'off'` needs nothing.
// ---------------------------------------------------------------------------

const VOUCHER_MODES = ['seat', 'credit', 'off'] as const;

async function handlePatchVoucherConfig(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  let body: {
    mode?: string | null;
    totalProperty?: string | null;
    usedProperty?: string | null;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }

  // '' and null reset the column, which resolves back to the shipped default. An
  // unrecognised mode is refused rather than silently ignored: stored, it would resolve to
  // `seat` and spend a company's allowance in the wrong unit.
  const mode =
    body.mode === undefined
      ? undefined
      : typeof body.mode === 'string' && body.mode.trim() !== ''
        ? body.mode.trim()
        : null;
  if (mode != null && !(VOUCHER_MODES as readonly string[]).includes(mode)) {
    return c.json(
      {
        status: 'invalid_mode',
        message: `mode must be one of: ${VOUCHER_MODES.join(', ')}.`,
      },
      400,
    );
  }

  const clean = (value: string | null | undefined) =>
    value === undefined
      ? undefined
      : typeof value === 'string' && value.trim() !== ''
        ? value.trim()
        : null;
  const totalProperty = clean(body.totalProperty);
  const usedProperty = clean(body.usedProperty);

  if (mode === undefined && totalProperty === undefined && usedProperty === undefined) {
    return c.json({ status: 'no_fields', message: 'No updatable fields provided' }, 400);
  }

  // What the portal would be left with. A field this request does not name keeps whatever
  // is stored, so the guard is about the END state rather than about this body.
  const current = await loadVoucherConfig(c.env, portalId);
  const stored = await c.env.DB.prepare(
    'SELECT voucher_total_property, voucher_used_property FROM tenants WHERE portal_id = ?1',
  )
    .bind(portalId)
    .first<{ voucher_total_property: string | null; voucher_used_property: string | null }>()
    // Guarded exactly as `loadVoucherConfig` is, and for the same reason: a tenant schema
    // that predates these columns must read as "nothing mapped" rather than throw. Here
    // that means the guard below refuses, which is the right end of the trade.
    .catch(() => null);

  const nextMode = mode === undefined ? current.mode : (mode ?? 'seat');
  const nextTotal =
    totalProperty === undefined ? (stored?.voucher_total_property ?? null) : totalProperty;
  const nextUsed =
    usedProperty === undefined ? (stored?.voucher_used_property ?? null) : usedProperty;

  if (nextMode !== 'off' && (nextTotal === null || nextUsed === null)) {
    return c.json(
      {
        status: 'voucher_properties_required',
        message:
          'Set totalProperty and usedProperty in the same request as a mode of seat or ' +
          'credit. There are no default company property names worth falling back on: an ' +
          'unmapped portal reads no allowance, covers no seats, and its usage write-back ' +
          'dies on a property the portal does not have. Use mode "off" to disable vouchers.',
      },
      400,
    );
  }

  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [value, column] of [
    [mode, 'voucher_mode'],
    [totalProperty, 'voucher_total_property'],
    [usedProperty, 'voucher_used_property'],
  ] as Array<[string | null | undefined, string]>) {
    if (value === undefined) continue;
    sets.push(`${column} = ?${sets.length + 1}`);
    vals.push(value);
  }

  await c.env.DB.prepare(
    `UPDATE tenants SET ${sets.join(', ')} WHERE portal_id = ?${vals.length + 1}`,
  )
    .bind(...vals, portalId)
    .run();

  // Echoed through the loader the write-backs read, so the caller sees what the worker will
  // actually do rather than what they sent.
  return c.json({ ok: true, vouchers: await describeVoucherConfig(c.env, portalId) });
}

/**
 * The voucher config as the worker resolves it, plus whether anyone CHOSE it.
 *
 * `source: 'default'` is the state above: vouchers on, pointed at names the app invented.
 * Phase 6.1 draws the same distinction for provisioning, for the same reason — a default
 * name is a question, not a success.
 */
async function describeVoucherConfig(env: ManageBindings['Bindings'], portalId: string) {
  const config = await loadVoucherConfig(env, portalId);
  const stored = await env.DB.prepare(
    'SELECT voucher_mode, voucher_total_property, voucher_used_property FROM tenants WHERE portal_id = ?1',
  )
    .bind(portalId)
    .first<{
      voucher_mode: string | null;
      voucher_total_property: string | null;
      voucher_used_property: string | null;
    }>()
    // `GET /onboarding` reads this, so a portal whose tenant schema predates these columns
    // (Ref 217 drift) must get the defaults reported back, not a 500 on the one endpoint
    // that says how the portal is configured.
    .catch(() => null);
  const mapped = !!stored?.voucher_total_property && !!stored?.voucher_used_property;
  return {
    mode: config.mode,
    totalProperty: config.totalProperty,
    usedProperty: config.usedProperty,
    source: mapped ? 'mapped' : 'default',
    // The one state worth acting on: vouchers are live against property names nobody chose.
    usingDefaultProperties: config.mode !== 'off' && !mapped,
  };
}

// ---------------------------------------------------------------------------
// GET /events/:id/attendance (Phase 2.1)
//
// Per-registration attendance for one event, derived from the tickets (the check-in
// record) and, for online events, the matched me.attend record. This is the queryable half
// of attendance write-back; the other half lands the same facts on the attendee's contact,
// where Ollie's Data Hub flow renders the certificate. The worker renders none itself.
//
// `propertyMapping` is echoed so whoever wires the certificate flow can see which contact
// properties this portal actually writes to without going through onboarding, and
// `writeback` per row says whether that write has landed — which is the first question
// asked when a certificate did not go out.
// ---------------------------------------------------------------------------

async function handleEventAttendance(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const eventId = c.req.param('id') as string;

  const event = await c.env.DB.prepare(
    'SELECT id, title FROM events WHERE portal_id = ?1 AND id = ?2',
  )
    .bind(portalId, eventId)
    .first<{ id: string; title: string }>();
  if (!event) return c.json({ status: 'not_found', message: 'Event not found' }, 404);

  const [rows, config] = await Promise.all([
    listEventAttendance(c.env, portalId, eventId),
    loadAttendanceContactConfig(c.env, portalId),
  ]);

  const attendedOnly = c.req.query('attended');
  const attendees =
    attendedOnly === 'true'
      ? rows.filter((row) => row.attended)
      : attendedOnly === 'false'
        ? rows.filter((row) => !row.attended)
        : rows;

  return c.json({
    eventId,
    eventTitle: event.title,
    generatedAt: new Date().toISOString(),
    // Always summarises the whole event, never the filtered slice — a door count that
    // changed because someone added ?attended=true would be a trap.
    summary: summariseAttendance(rows),
    propertyMapping: Object.fromEntries(
      ATTENDANCE_FIELDS.map((field) => [field, attendancePropertyFor(config, field)]),
    ),
    attendees,
  });
}

// ---------------------------------------------------------------------------
// GET /events/:id/stats
// ---------------------------------------------------------------------------

async function handleEventStats(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const id = c.req.param('id') as string;

  const event = await loadEvent(c.env.DB, portalId, id);
  if (!event) return c.json({ status: 'not_found', message: 'Event not found' }, 404);

  // One shared count (Phase 2.2), so this card, the App Home card and the door scanner
  // cannot report three different answers to "how many people are coming".
  const summary = await summariseEventRegistrations(c.env, portalId, id);

  // An uncapped event reports null rather than 0 — 0 would read as "sold out" on the card.
  const capacity = effectiveCapacity(event);
  // Seats HELD, not seats registered: a seat held against an unpaid invoice is not for
  // sale, and a cancelled one is — even if the person it was cancelled on attended anyway.
  const availableSeats = capacity === null ? null : Math.max(0, capacity - summary.seatsHeld);

  // Migration 0038. Seats available and seats SELLABLE are different questions, and a card
  // reporting only the first one is how an event sits closed with nobody noticing.
  const window = resolveSalesWindow(event);

  return c.json({
    eventId: id,
    capacity,
    registered: summary.registered,
    attended: summary.attended,
    notYetArrived: summary.notYetArrived,
    availableSeats,
    registrationClosesAt: window.closesAt,
    registrationClosesAtIsDefault: window.closesAtIsDefault,
    registrationClosed: window.closed,
    salesPaused: window.paused,
    sellingNow: window.open && availableSeats !== 0,
    summary,
  });
}

// ---------------------------------------------------------------------------
// POST /events/:id/rebuild-capacity
// Admin-only maintenance action. Rebuilds the Durable Object seat state from D1
// after database cleanup/imports so stale in-memory counters do not survive.
// ---------------------------------------------------------------------------

async function handleRebuildCapacity(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const id = c.req.param('id') ?? '';
  if (!id) return c.json({ status: 'missing_event_id', message: 'Event id is required' }, 400);

  const event = await loadEvent(c.env.DB, portalId, id);
  if (!event) return c.json({ status: 'not_found', message: 'Event not found' }, 404);

  const idName = `${portalId}:${event.hubspot_event_id}`;
  const stub = c.env.EVENT_CAPACITY.get(c.env.EVENT_CAPACITY.idFromName(idName));
  const resp = await stub.fetch('https://do.local/rebuild', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idName }),
  });
  const capacity = await resp.json();

  return c.json(
    {
      ok: resp.ok,
      eventId: event.id,
      hubspotEventId: event.hubspot_event_id,
      capacity,
    },
    resp.status as Parameters<typeof c.json>[1],
  );
}

// ---------------------------------------------------------------------------
// POST /events/:id/provision-webinar
// Admin-only diagnostic/provisioning action. Creates the provider webinar for an
// online event and stores the provider ids on the Event Engine event row.
//
// This deliberately does NOT create reservations, orders, registrations, tickets,
// or HubSpot outbox jobs. It is safe for staging provider validation.
// ---------------------------------------------------------------------------

async function handleProvisionWebinar(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const id = c.req.param('id') ?? '';
  if (!id) return c.json({ status: 'missing_event_id', message: 'Event id is required' }, 400);

  const event = await loadEvent(c.env.DB, portalId, id);
  if (!event) return c.json({ status: 'not_found', message: 'Event not found' }, 404);
  if (!event.provider) {
    return c.json(
      { status: 'not_online_event', message: 'Event has no webinar provider configured' },
      409,
    );
  }

  if (event.teams_webinar_id && event.teams_session_id) {
    return c.json({
      ok: true,
      existing: true,
      provider: event.provider,
      teamsWebinarId: event.teams_webinar_id,
      teamsSessionId: event.teams_session_id,
      teamsJoinUrl: event.teams_join_url,
    });
  }

  const provider = getWebinarProvider(c.env, portalId, event.provider);
  if (!provider) {
    return c.json(
      { status: 'unknown_provider', message: `Unsupported webinar provider: ${event.provider}` },
      400,
    );
  }

  let created: Awaited<ReturnType<typeof provider.createWebinar>>;
  try {
    created = await provider.createWebinar({
      portalId,
      eventId: event.id,
      hubspotEventId: event.hubspot_event_id,
      title: event.title,
      startsAt: event.starts_at,
      endsAt: event.ends_at,
    });
  } catch (error) {
    return c.json(
      {
        status: 'webinar_create_failed',
        provider: event.provider,
        message: error instanceof Error ? error.message : String(error),
      },
      502,
    );
  }

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE events
       SET teams_webinar_id = ?1, teams_session_id = ?2, teams_join_url = ?3, updated_at = ?4
     WHERE portal_id = ?5 AND id = ?6`,
  )
    .bind(created.providerWebinarId, created.providerSessionId, created.joinUrl, now, portalId, id)
    .run();

  return c.json({
    ok: true,
    existing: false,
    provider: event.provider,
    teamsWebinarId: created.providerWebinarId,
    teamsSessionId: created.providerSessionId,
    teamsJoinUrl: created.joinUrl,
  });
}

// ---------------------------------------------------------------------------
// POST /events/:id/register-webinar-attendee
// Admin-only diagnostic action. Registers one attendee with the already-created
// provider webinar, without creating an Event Engine reservation/order/ticket or
// HubSpot outbox jobs. Safe for validating provider permissions in staging.
// Body: { email: string, name: string }
// ---------------------------------------------------------------------------

async function handleRegisterWebinarAttendee(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const id = c.req.param('id') ?? '';
  if (!id) return c.json({ status: 'missing_event_id', message: 'Event id is required' }, 400);

  const event = await loadEvent(c.env.DB, portalId, id);
  if (!event) return c.json({ status: 'not_found', message: 'Event not found' }, 404);
  if (!event.provider) {
    return c.json(
      { status: 'not_online_event', message: 'Event has no webinar provider configured' },
      409,
    );
  }
  if (!event.teams_webinar_id) {
    return c.json(
      {
        status: 'webinar_not_provisioned',
        message: 'Provision the webinar before registering attendees',
      },
      409,
    );
  }

  let body: { email?: string; name?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }
  if (!body.email || !body.name) {
    return c.json({ status: 'missing_fields', message: 'email and name are required' }, 400);
  }

  const provider = getWebinarProvider(c.env, portalId, event.provider);
  if (!provider) {
    return c.json(
      { status: 'unknown_provider', message: `Unsupported webinar provider: ${event.provider}` },
      400,
    );
  }

  try {
    const result = await provider.registerAttendee(event.teams_webinar_id, {
      email: body.email,
      name: body.name,
      ourRegistrationId: `diagnostic-${crypto.randomUUID()}`,
    });
    return c.json({
      ok: true,
      provider: event.provider,
      providerRegistrationId: result.providerRegistrationId,
      personalJoinUrl: result.personalJoinUrl,
    });
  } catch (error) {
    return c.json(
      {
        status: 'webinar_registration_failed',
        provider: event.provider,
        message: error instanceof Error ? error.message : String(error),
      },
      502,
    );
  }
}

// ---------------------------------------------------------------------------
// GET /onboarding
// Returns the current onboarding / billing state for the portal.
// ---------------------------------------------------------------------------

interface OnboardingRow {
  status: string;
  refuel_billing_status: string | null;
  refuel_plan: string | null;
  trial_ends_at: string | null;
  stripe_processor_connected: number;
  xero_gst_rate_id: string | null;
  webinar_provider: string | null;
  hubdb_events_table_id: string | null;
  hubdb_ticket_types_table_id: string | null;
  hubdb_dynamic_page_domain: string | null;
  events_pipeline_id: string | null;
  events_registered_stage_id: string | null;
  events_registered_stage_label: string | null;
  training_pipeline_id: string | null;
  training_invoice_sent_stage_id: string | null;
  training_invoice_sent_stage_label: string | null;
  deal_type_property_name: string | null;
  event_deal_type_label: string | null;
  course_deal_type_label: string | null;
  invoice_due_days: number | null;
}

async function handleGetOnboarding(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const row = await c.env.DB.prepare(
    `SELECT status, refuel_billing_status, refuel_plan, trial_ends_at,
            stripe_processor_connected, xero_gst_rate_id, webinar_provider,
            hubdb_events_table_id, hubdb_ticket_types_table_id, hubdb_dynamic_page_domain,
            events_pipeline_id, events_registered_stage_id, events_registered_stage_label,
            training_pipeline_id, training_invoice_sent_stage_id, training_invoice_sent_stage_label,
            deal_type_property_name, event_deal_type_label, course_deal_type_label,
            invoice_due_days
     FROM tenants WHERE portal_id = ?1`,
  )
    .bind(portalId)
    .first<OnboardingRow>();

  if (!row) return c.json({ status: 'not_found', message: 'Tenant not found' }, 404);

  return c.json({
    status: row.status,
    refuelBillingStatus: row.refuel_billing_status ?? 'trial',
    refuelPlan: row.refuel_plan,
    trialEndsAt: row.trial_ends_at,
    stripeProcessorConnected: !!row.stripe_processor_connected,
    xeroGstRateId: row.xero_gst_rate_id,
    // Reported because the unconfigured state is live rather than inert: vouchers default
    // to ON against property names the app invented, so a portal that has never set this
    // resolves every company to a zero allowance. `usingDefaultProperties` is the flag.
    vouchers: await describeVoucherConfig(c.env, portalId),
    // Every membership source is the tenant's schema since 0046, and an unmapped one is
    // simply not read, so this is where "why does this portal verify nobody's employer"
    // is answered without reading D1 by hand.
    membership: describeMembershipConfig(await loadMembershipConfig(c.env, portalId)),
    webinarProvider: row.webinar_provider,
    hubdbEventsTableId: row.hubdb_events_table_id,
    hubdbTicketTypesTableId: row.hubdb_ticket_types_table_id,
    hubdbDynamicPageDomain: row.hubdb_dynamic_page_domain,
    crmRouting: {
      eventsPipelineId: row.events_pipeline_id,
      eventsRegisteredStageId: row.events_registered_stage_id,
      eventsRegisteredStageLabel: row.events_registered_stage_label,
      trainingPipelineId: row.training_pipeline_id,
      trainingInvoiceSentStageId: row.training_invoice_sent_stage_id,
      trainingInvoiceSentStageLabel: row.training_invoice_sent_stage_label,
      dealTypePropertyName: row.deal_type_property_name,
      eventDealTypeLabel: row.event_deal_type_label,
      courseDealTypeLabel: row.course_deal_type_label,
    },
    // Portal default payment terms; null means the built-in default applies.
    invoiceDueDays: row.invoice_due_days,
    defaultInvoiceDueDays: DEFAULT_INVOICE_DUE_DAYS,
    maxInvoiceDueDays: MAX_INVOICE_DUE_DAYS,
    publishingEnabled: row.status === 'active',
  });
}

/** The membership config in the PATCH /onboarding/membership-config body's own shape. */
function describeMembershipConfig(config: MembershipConfig) {
  return {
    membershipStatusProperty: config.statusProperty,
    membershipLevelProperty: config.levelProperty,
    memberCategoryProperty: config.categoryProperty,
    companySources: config.companySources,
    mirrorStatusProperty: config.mirrorStatusProperty,
    mirrorTierProperty: config.mirrorTierProperty,
    memberDirectory: config.memberDirectory,
  };
}

// ---------------------------------------------------------------------------
// PATCH /onboarding/stripe
// Marks the tenant's Stripe processor as connected (called after the customer
// completes the HubSpot payment settings flow and confirms back to the worker).
// ---------------------------------------------------------------------------

async function handlePatchStripe(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  let body: { connected?: boolean };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }
  if (body.connected == null) {
    return c.json({ status: 'missing_fields', message: 'connected is required' }, 400);
  }
  await c.env.DB.prepare('UPDATE tenants SET stripe_processor_connected = ?1 WHERE portal_id = ?2')
    .bind(body.connected ? 1 : 0, portalId)
    .run();
  return c.json({ ok: true, stripeProcessorConnected: body.connected });
}

// ---------------------------------------------------------------------------
// PATCH /onboarding/xero-gst
// Saves the HubSpot tax rate id (imported from Xero) for this portal.
// ---------------------------------------------------------------------------

async function handlePatchXeroGst(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  let body: { xeroGstRateId?: string | null };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }
  if (!('xeroGstRateId' in body)) {
    return c.json({ status: 'missing_fields', message: 'xeroGstRateId is required' }, 400);
  }
  await c.env.DB.prepare('UPDATE tenants SET xero_gst_rate_id = ?1 WHERE portal_id = ?2')
    .bind(body.xeroGstRateId ?? null, portalId)
    .run();
  return c.json({ ok: true, xeroGstRateId: body.xeroGstRateId });
}

// ---------------------------------------------------------------------------
// PATCH /onboarding/crm-routing
// Stores per-portal Deal routing values for Events vs Courses.
// ---------------------------------------------------------------------------

async function handlePatchCrmRouting(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  let body: {
    eventsPipelineId?: string | null;
    eventsRegisteredStageId?: string | null;
    eventsRegisteredStageLabel?: string | null;
    trainingPipelineId?: string | null;
    trainingInvoiceSentStageId?: string | null;
    trainingInvoiceSentStageLabel?: string | null;
    dealTypePropertyName?: string | null;
    eventDealTypeLabel?: string | null;
    courseDealTypeLabel?: string | null;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }

  const updates: Array<[string, string | null]> = [];
  const optionalFields: Array<[keyof typeof body, string]> = [
    ['eventsPipelineId', 'events_pipeline_id'],
    ['eventsRegisteredStageId', 'events_registered_stage_id'],
    ['eventsRegisteredStageLabel', 'events_registered_stage_label'],
    ['trainingPipelineId', 'training_pipeline_id'],
    ['trainingInvoiceSentStageId', 'training_invoice_sent_stage_id'],
    ['trainingInvoiceSentStageLabel', 'training_invoice_sent_stage_label'],
    ['dealTypePropertyName', 'deal_type_property_name'],
    ['eventDealTypeLabel', 'event_deal_type_label'],
    ['courseDealTypeLabel', 'course_deal_type_label'],
  ];

  for (const [bodyKey, column] of optionalFields) {
    if (body[bodyKey] !== undefined) {
      const raw = body[bodyKey];
      updates.push([column, raw == null || raw === '' ? null : String(raw)]);
    }
  }

  if (updates.length === 0) {
    return c.json({ status: 'no_fields', message: 'No CRM routing fields provided' }, 400);
  }

  const assignments = updates.map(([column], index) => `${column} = ?${index + 1}`);
  await c.env.DB.prepare(
    `UPDATE tenants SET ${assignments.join(', ')} WHERE portal_id = ?${updates.length + 1}`,
  )
    .bind(...updates.map(([, value]) => value), portalId)
    .run();

  return c.json({ ok: true });
}

// ---------------------------------------------------------------------------
// PATCH /onboarding/payment-terms
// Portal default payment terms for paid bookings: how long the seat is held and the
// HubSpot invoice runs to. Applies to public, corporate and staff bookings that do not
// carry a more specific value (events.invoice_due_days, or a staff-chosen due date).
// Body: { invoiceDueDays: number | null }  — null restores the built-in default.
// ---------------------------------------------------------------------------

async function handlePatchPaymentTerms(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  let body: { invoiceDueDays?: number | string | null };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }

  if (body.invoiceDueDays === undefined) {
    return c.json({ status: 'no_fields', message: 'invoiceDueDays is required' }, 400);
  }
  const parsed = parseInvoiceDueDays(body.invoiceDueDays);
  if (!parsed.ok) {
    return c.json(
      {
        status: 'invalid_invoice_due_days',
        message: `invoiceDueDays must be a whole number of days between 1 and ${MAX_INVOICE_DUE_DAYS}, or null to use the ${DEFAULT_INVOICE_DUE_DAYS}-day default`,
      },
      400,
    );
  }

  await c.env.DB.prepare('UPDATE tenants SET invoice_due_days = ?1 WHERE portal_id = ?2')
    .bind(parsed.days, portalId)
    .run();
  return c.json({ ok: true, invoiceDueDays: parsed.days });
}

// ---------------------------------------------------------------------------
// PATCH /onboarding/unpaid-invoice-mode
// ---------------------------------------------------------------------------

/**
 * Who voids a lapsed booking's unpaid invoice (migration 0039).
 *
 * 'auto_void' is the default and is what the worker has always done: right for a
 * stranger's abandoned checkout, wrong for a company block, where the invoice is the
 * booking and a void is terminal in HubSpot. 'manual_review' opens a decision instead and
 * leaves the invoice payable until a human says otherwise.
 *
 * Governs the INVOICE only. The seat still returns to sale when its hold lapses under
 * either mode.
 */
async function handlePatchUnpaidInvoiceMode(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  let body: { unpaidInvoiceMode?: string | null };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }

  if (body.unpaidInvoiceMode === undefined) {
    return c.json({ status: 'no_fields', message: 'unpaidInvoiceMode is required' }, 400);
  }
  // null is spelled out as the default rather than left as a third meaning of NULL: a
  // tenant clearing the setting is choosing auto, and the read path treats them the same.
  const mode = body.unpaidInvoiceMode === null ? 'auto_void' : String(body.unpaidInvoiceMode);
  if (mode !== 'auto_void' && mode !== 'manual_review') {
    return c.json(
      {
        status: 'invalid_unpaid_invoice_mode',
        message: "unpaidInvoiceMode must be 'auto_void' or 'manual_review'",
      },
      400,
    );
  }

  await c.env.DB.prepare('UPDATE tenants SET unpaid_invoice_mode = ?1 WHERE portal_id = ?2')
    .bind(mode, portalId)
    .run();
  return c.json({ ok: true, unpaidInvoiceMode: mode });
}

// ---------------------------------------------------------------------------
// PATCH /onboarding/webinar-creds
// Saves (encrypted) webinar provider credentials for this portal.
// Body: { provider: 'teams', tenantId: string, clientId: string, clientSecret: string }
// ---------------------------------------------------------------------------

async function handlePatchWebinarCreds(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  let body: { provider?: string; tenantId?: string; clientId?: string; clientSecret?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }
  if (!body.provider) {
    return c.json({ status: 'missing_fields', message: 'provider is required' }, 400);
  }
  if (body.provider === 'teams' && (!body.tenantId || !body.clientId || !body.clientSecret)) {
    return c.json(
      {
        status: 'missing_fields',
        message: 'tenantId, clientId, and clientSecret are required for teams provider',
      },
      400,
    );
  }

  const credsJson = JSON.stringify({
    provider: body.provider,
    tenantId: body.tenantId,
    clientId: body.clientId,
    clientSecret: body.clientSecret,
  });

  const encKey = getSecret(c.env, 'TOKEN_ENCRYPTION_KEY');
  const encCreds = await encryptToken(encKey, credsJson);

  await c.env.DB.prepare(
    'UPDATE tenants SET webinar_provider = ?1, webinar_creds_enc = ?2 WHERE portal_id = ?3',
  )
    .bind(body.provider, encCreds, portalId)
    .run();

  if (body.provider === 'teams') {
    const provider = getWebinarProvider(c.env, portalId, 'teams');
    if (provider) {
      c.executionCtx.waitUntil(
        provider.ensureSubscription({ portalId }).catch((error) => {
          console.log(
            JSON.stringify({
              level: 'warn',
              event: 'teams_subscription_setup_failed',
              portalId,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }),
      );
    }
  }

  return c.json({ ok: true, webinarProvider: body.provider });
}

// ---------------------------------------------------------------------------
// GET /onboarding/webinar-creds
// Returns decrypted webinar credentials (clientSecret redacted).
// ---------------------------------------------------------------------------

async function handleGetWebinarCreds(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const row = await c.env.DB.prepare(
    'SELECT webinar_provider, webinar_creds_enc FROM tenants WHERE portal_id = ?1',
  )
    .bind(portalId)
    .first<{ webinar_provider: string | null; webinar_creds_enc: string | null }>();

  if (!row?.webinar_creds_enc) {
    return c.json({ webinarProvider: null, configured: false });
  }

  const encKey = getSecret(c.env, 'TOKEN_ENCRYPTION_KEY');
  const json = await decryptToken(encKey, row.webinar_creds_enc);
  const creds = JSON.parse(json) as { tenantId?: string; clientId?: string };

  return c.json({
    configured: true,
    webinarProvider: row.webinar_provider,
    tenantId: creds.tenantId ?? null,
    clientId: creds.clientId ?? null,
    // clientSecret intentionally omitted
  });
}

// ---------------------------------------------------------------------------
// GET /onboarding/connections
// Lists the tenant's connected webinar providers (OAuth + ON24). No secrets
// returned — only which providers are connected, the account ref, and when.
// ---------------------------------------------------------------------------

async function handleListConnections(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const connections = await getConnectionStatus(c.env, portalId);
  return c.json({ connections });
}

// ---------------------------------------------------------------------------
// PUT /onboarding/connections/on24
// ON24 has no OAuth — the customer pastes their token-key/secret here and we
// store it AES-GCM encrypted (same key as OAuth tokens). The OAuth providers
// (zoom/meet/vimeo/wistia) are connected via the /connect/:provider flow.
// Body: { clientId, tokenKey, tokenSecret }
// ---------------------------------------------------------------------------

async function handlePutOn24(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  let body: { clientId?: string; tokenKey?: string; tokenSecret?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }
  if (!body.clientId || !body.tokenKey || !body.tokenSecret) {
    return c.json(
      { status: 'missing_fields', message: 'clientId, tokenKey, and tokenSecret are required' },
      400,
    );
  }
  await storeApiKeyConnection(c.env, portalId, 'on24', {
    clientId: body.clientId,
    tokenKey: body.tokenKey,
    tokenSecret: body.tokenSecret,
  });
  return c.json({ ok: true, provider: 'on24', connected: true });
}

// ---------------------------------------------------------------------------
// DELETE /onboarding/connections/:provider
// Disconnects a webinar provider for the tenant (deletes the stored creds).
// ---------------------------------------------------------------------------

async function handleDisconnect(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const provider = c.req.param('provider') ?? '';
  const removed = await deleteConnection(c.env, portalId, provider);
  if (!removed) {
    return c.json(
      { status: 'not_found', message: `No ${provider} connection for this portal` },
      404,
    );
  }
  return c.json({ ok: true, provider, connected: false });
}

// ---------------------------------------------------------------------------
// POST /onboarding/provision
// (Re-)runs HubDB table provisioning for the portal.
// ---------------------------------------------------------------------------

async function handleProvision(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');

  let accessToken: string;
  try {
    accessToken = await getAccessToken(c.env, portalId);
  } catch (err) {
    return c.json({ status: 'error', message: `Cannot get access token: ${String(err)}` }, 400);
  }

  let result: Awaited<ReturnType<typeof provisionHubDbTables>>;
  try {
    result = await provisionHubDbTables(c.env, portalId, accessToken);
  } catch (err) {
    return c.json({ status: 'error', message: `Provisioning failed: ${String(err)}` }, 502);
  }

  // Every property the write-backs target, in the same call as the tables. Deliberately NOT
  // fatal to the install: HubDB provisioning is what makes the front end render, while a
  // missing schema scope only stops write-backs reaching the contact — reporting that is
  // more useful than refusing to finish an install over it.
  let properties: Awaited<ReturnType<typeof provisionProperties>> | null = null;
  let propertiesError: string | null = null;
  try {
    properties = await provisionProperties(c.env, portalId, accessToken);
  } catch (err) {
    propertiesError = String(err);
  }

  return c.json({
    ok: true,
    eventsTableId: result.eventsTableId,
    ticketTypesTableId: result.ticketTypesTableId,
    created: result.created,
    properties,
    propertiesError,
  });
}

// ---------------------------------------------------------------------------
// GET/POST /onboarding/properties (Phase 6.1)
//
// The general case of the contact-property provisioning below: every property this tenant's
// configuration implies, not only the attendance three — the personal join URL, any 1.2
// field remapped off HubSpot's standard `phone`/`city`/`state`, every 2.3 question's mapped
// property, and the company voucher fields. Resolved through the same tenant mappings the
// write-backs read, so the list cannot describe a different portal from the one the writes
// target.
//
// GET reports without changing anything, which is the answer to "setup is broken, what is
// missing?" that otherwise means reading the portal by hand.
// ---------------------------------------------------------------------------

async function resolveProvisionToken(
  c: Context<ManageBindings>,
): Promise<{ portalId: string; token: string } | Response> {
  const portalId = c.get('portalId');
  try {
    return { portalId, token: await getAccessToken(c.env, portalId) };
  } catch (err) {
    return c.json({ status: 'error', message: `Cannot get access token: ${String(err)}` }, 400);
  }
}

async function handleInspectProperties(c: Context<ManageBindings>): Promise<Response> {
  const resolved = await resolveProvisionToken(c);
  if (resolved instanceof Response) return resolved;
  return c.json(
    await provisionProperties(c.env, resolved.portalId, resolved.token, { dryRun: true }),
  );
}

/**
 * Idempotent: the only write is a create, and a create only happens for a name the portal's
 * own property list did not contain. Safe to press repeatedly, which is what makes this the
 * "repair setup" button as well as the install step.
 *
 * 200 even when properties could not be created — a report naming what a human must create
 * by hand is a successful answer to "what is the state of this portal", not a failed
 * request.
 */
async function handleProvisionProperties(c: Context<ManageBindings>): Promise<Response> {
  const resolved = await resolveProvisionToken(c);
  if (resolved instanceof Response) return resolved;
  return c.json(await provisionProperties(c.env, resolved.portalId, resolved.token));
}

// ---------------------------------------------------------------------------
// GET /diagnostics/hubspot
// Read-only metadata needed to configure CRM write-back. Tokens never leave the Worker.
// ---------------------------------------------------------------------------

async function handleHubSpotDiagnostics(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const invoiceId = c.req.query('invoiceId');
  const token = await getAccessToken(c.env, portalId);
  const headers = { Authorization: `Bearer ${token}` };
  const getJson = async (url: string) => {
    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`HubSpot ${response.status}: ${await response.text()}`);
    return response.json<unknown>();
  };

  const propertyNames = [
    'hs_external_id',
    'abn',
    'hs_buyer_company_abn',
    'dealtype',
    'hs_tax_rate_id',
    'hs_invoice_link',
    'hs_invoice_status',
  ];
  const dealPropertyNeedles = ['type', 'event', 'course'];
  const schemaUrls = ['contacts', 'deals', 'line_items', 'invoices'].map(
    (object) => `https://api.hubapi.com/crm/v3/properties/${object}`,
  );
  const [pipelines, ...schemas] = await Promise.all([
    getJson('https://api.hubapi.com/crm/v3/pipelines/deals?archived=false'),
    ...schemaUrls.map(getJson),
  ]);

  const properties = Object.fromEntries(
    schemas.map((schema, index) => {
      const results = (schema as { results?: Array<Record<string, unknown>> }).results ?? [];
      return [
        ['contacts', 'deals', 'line_items', 'invoices'][index],
        results
          .filter((property) => {
            const name = String(property.name);
            const label = String(property.label ?? '');
            const objectName = ['contacts', 'deals', 'line_items', 'invoices'][index];
            const lowerName = name.toLowerCase();
            const lowerLabel = label.toLowerCase();
            const isDealRoutingProperty =
              objectName === 'deals' &&
              dealPropertyNeedles.some(
                (needle) => lowerName.includes(needle) || lowerLabel.includes(needle),
              );
            return (
              propertyNames.includes(name) || lowerName.includes('tax') || isDealRoutingProperty
            );
          })
          .map(({ name, label, type, fieldType, options }) => ({
            name,
            label,
            type,
            fieldType,
            options,
          })),
      ];
    }),
  );

  let invoice: unknown = null;
  let lineItems: unknown = null;
  const marketingEventDealAssociations = await Promise.all(
    ['marketing_events', 'marketing_event', '0-54'].map(async (toObjectType) => {
      const response = await fetch(
        `https://api.hubapi.com/crm/v4/associations/deals/${encodeURIComponent(toObjectType)}/labels`,
        { headers },
      );
      const text = await response.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      return {
        fromObjectType: 'deals',
        toObjectType,
        ok: response.ok,
        status: response.status,
        body,
      };
    }),
  );
  if (invoiceId) {
    invoice = await getJson(
      `https://api.hubapi.com/crm/v3/objects/invoices/${encodeURIComponent(invoiceId)}?properties=hs_invoice_status,hs_currency,hs_invoice_date,hs_invoice_link,hs_number,hs_total_amount`,
    );
    const associations = (await getJson(
      `https://api.hubapi.com/crm/v4/objects/invoices/${encodeURIComponent(invoiceId)}/associations/line_items`,
    )) as { results?: Array<{ toObjectId: string }> };
    const ids = (associations.results ?? []).map((item) => item.toObjectId);
    if (ids.length > 0) {
      const response = await fetch('https://api.hubapi.com/crm/v3/objects/line_items/batch/read', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          properties: [
            'name',
            'quantity',
            'price',
            'amount',
            'hs_product_id',
            'hs_external_tax_rate_id',
            'hs_tax_rate',
            'hs_tax_rate_group_id',
            'hs_tax_label',
            'tax',
          ],
          inputs: ids.map((id) => ({ id })),
        }),
      });
      if (!response.ok) throw new Error(`HubSpot ${response.status}: ${await response.text()}`);
      lineItems = await response.json<unknown>();
    }
  }

  return c.json({
    portalId,
    pipelines,
    properties,
    marketingEventDealAssociations,
    invoice,
    lineItems,
  });
}

// ---------------------------------------------------------------------------
// GET /diagnostics/hubspot/tax-rates
// Read-only helper for onboarding: HubSpot stores selectable tax rates as the
// option values on the line item `hs_tax_rate_group_id` property.
// ---------------------------------------------------------------------------

async function handleHubSpotTaxRateDiagnostics(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const token = await getAccessToken(c.env, portalId);

  const [propertyResponse, taxRatesResponse, tenant] = await Promise.all([
    fetch('https://api.hubapi.com/crm/v3/properties/line_items/hs_tax_rate_group_id', {
      headers: { Authorization: `Bearer ${token}` },
    }),
    fetch('https://api.hubapi.com/tax-rates/v1/tax-rates', {
      headers: { Authorization: `Bearer ${token}` },
    }),
    c.env.DB.prepare(
      'SELECT xero_gst_rate_id, xero_gst_free_rate_id FROM tenants WHERE portal_id = ?1',
    )
      .bind(portalId)
      .first<{ xero_gst_rate_id: string | null; xero_gst_free_rate_id: string | null }>(),
  ]);

  const propertyBody = await propertyResponse.text();
  const taxRatesBody = await taxRatesResponse.text();

  let property: unknown = null;
  if (propertyResponse.ok) {
    const parsed = JSON.parse(propertyBody) as {
      name: string;
      label: string;
      type: string;
      fieldType: string;
      options?: Array<{
        label: string;
        value: string;
        hidden?: boolean;
        displayOrder?: number;
      }>;
    };
    property = {
      name: parsed.name,
      label: parsed.label,
      type: parsed.type,
      fieldType: parsed.fieldType,
      options: parsed.options ?? [],
    };
  }

  let taxRates: unknown = null;
  if (taxRatesResponse.ok) {
    try {
      taxRates = JSON.parse(taxRatesBody);
    } catch {
      taxRates = taxRatesBody;
    }
  }

  const configuredId = tenant?.xero_gst_rate_id ?? null;
  let configuredRate: unknown = null;
  let configuredRateFound = false;
  if (configuredId && taxRates && typeof taxRates === 'object') {
    const results =
      (taxRates as { results?: Array<{ id: string }> }).results ??
      (Array.isArray(taxRates) ? taxRates : []);
    configuredRate =
      results.find((rate) => String((rate as { id: string }).id) === configuredId) ?? null;
    configuredRateFound = configuredRate != null;
  }

  const ok = propertyResponse.ok && taxRatesResponse.ok;
  return c.json(
    {
      portalId,
      property,
      taxRates,
      tenant: {
        xeroGstRateId: configuredId,
        xeroGstFreeRateId: tenant?.xero_gst_free_rate_id ?? null,
        configuredRateFound,
        configuredRate,
      },
      errors: {
        property: propertyResponse.ok
          ? null
          : { status: propertyResponse.status, body: propertyBody },
        taxRates: taxRatesResponse.ok
          ? null
          : { status: taxRatesResponse.status, body: taxRatesBody },
      },
    },
    ok ? 200 : 502,
  );
}

// ---------------------------------------------------------------------------
// PATCH /onboarding/dynamic-page
// Records the CMS domain where the tenant has set up the events listing page.
// ---------------------------------------------------------------------------

async function handlePatchDynamicPage(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  let body: { domain?: string | null };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }
  await c.env.DB.prepare('UPDATE tenants SET hubdb_dynamic_page_domain = ?1 WHERE portal_id = ?2')
    .bind(body.domain ?? null, portalId)
    .run();
  return c.json({ ok: true, hubdbDynamicPageDomain: body.domain ?? null });
}

// ---------------------------------------------------------------------------
// Staff notes (Phase 1.3)
//
// Internal text against a registration or the order behind it. Append-only: there is no
// PATCH and no DELETE here on purpose — an edit is a new note, and the earlier one stays
// readable. Everything is admin-authenticated (the sub-app's middleware), and nothing in
// this file has a public counterpart: notes never leave the manage surfaces.
// ---------------------------------------------------------------------------

/** Confirms the registration belongs to this portal AND this event before touching notes. */
async function resolveRegistrationForNotes(
  c: Context<ManageBindings>,
): Promise<{ portalId: string; registrationId: string } | Response> {
  const portalId = c.get('portalId');
  const eventId = c.req.param('id') as string;
  const registrationId = c.req.param('regId') as string;

  const row = await c.env.DB.prepare(
    'SELECT id FROM registrations WHERE id = ?1 AND portal_id = ?2 AND event_id = ?3',
  )
    .bind(registrationId, portalId, eventId)
    .first<{ id: string }>();
  if (!row) return c.json({ status: 'not_found', message: 'Registration not found' }, 404);
  return { portalId, registrationId };
}

/** Same, for an order. */
async function resolveOrderForNotes(
  c: Context<ManageBindings>,
): Promise<{ portalId: string; orderId: string } | Response> {
  const portalId = c.get('portalId');
  const eventId = c.req.param('id') as string;
  const orderId = c.req.param('orderId') as string;

  const row = await c.env.DB.prepare(
    'SELECT id FROM orders WHERE id = ?1 AND portal_id = ?2 AND event_id = ?3',
  )
    .bind(orderId, portalId, eventId)
    .first<{ id: string }>();
  if (!row) return c.json({ status: 'not_found', message: 'Order not found' }, 404);
  return { portalId, orderId };
}

async function readNoteBody(
  c: Context<ManageBindings>,
): Promise<{ body: string; author: string | null } | Response> {
  let payload: { body?: string; note?: string; author?: string | null };
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }
  return {
    // `note` is accepted as an alias so the App Card's field name and the wire name can
    // differ without a silently dropped note.
    body: String(payload.body ?? payload.note ?? ''),
    author: payload.author ?? null,
  };
}

async function handleListRegistrationNotes(c: Context<ManageBindings>): Promise<Response> {
  const resolved = await resolveRegistrationForNotes(c);
  if (resolved instanceof Response) return resolved;
  const notes = await listStaffNotes(c.env, resolved.portalId, {
    registrationId: resolved.registrationId,
  });
  return c.json(notes);
}

async function handleCreateRegistrationNote(c: Context<ManageBindings>): Promise<Response> {
  const resolved = await resolveRegistrationForNotes(c);
  if (resolved instanceof Response) return resolved;

  const input = await readNoteBody(c);
  if (input instanceof Response) return input;

  const result = await addStaffNote(c.env, {
    portalId: resolved.portalId,
    registrationId: resolved.registrationId,
    author: input.author,
    body: input.body,
  });
  if (!result.ok) return c.json({ status: result.status, message: result.message }, 400);
  return c.json({ ok: true, note: await noteResponse(c, resolved.portalId, result.note.id) }, 201);
}

async function handleListOrderNotes(c: Context<ManageBindings>): Promise<Response> {
  const resolved = await resolveOrderForNotes(c);
  if (resolved instanceof Response) return resolved;
  const notes = await listStaffNotes(c.env, resolved.portalId, { orderId: resolved.orderId });
  return c.json(notes);
}

async function handleCreateOrderNote(c: Context<ManageBindings>): Promise<Response> {
  const resolved = await resolveOrderForNotes(c);
  if (resolved instanceof Response) return resolved;

  const input = await readNoteBody(c);
  if (input instanceof Response) return input;

  const result = await addStaffNote(c.env, {
    portalId: resolved.portalId,
    orderId: resolved.orderId,
    author: input.author,
    body: input.body,
  });
  if (!result.ok) return c.json({ status: result.status, message: result.message }, 400);
  return c.json({ ok: true, note: await noteResponse(c, resolved.portalId, result.note.id) }, 201);
}

/** Echo the stored row rather than the request, so the caller sees what was actually kept. */
async function noteResponse(c: Context<ManageBindings>, portalId: string, noteId: string) {
  return loadStaffNote(c.env, portalId, noteId);
}

/**
 * Every note for the event in one call — registration- and order-scoped alike.
 *
 * The card needs to mark an attendee list without a request per row, and 2.2's export
 * needs one source to join against.
 */
async function handleListEventNotes(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const eventId = c.req.param('id') as string;

  const event = await c.env.DB.prepare('SELECT id FROM events WHERE portal_id = ?1 AND id = ?2')
    .bind(portalId, eventId)
    .first();
  if (!event) return c.json({ status: 'not_found', message: 'Event not found' }, 404);

  return c.json(await listEventStaffNotes(c.env, portalId, eventId));
}

// ---------------------------------------------------------------------------
// Custom registration questions (Phase 2.3)
//
// Two levels of the same resource. A question with no event is a tenant-wide default asked
// on everything; one under an event narrows or overrides it. The routes mirror that:
// /questions manages the defaults, /events/:id/questions manages one event's, and the
// event-level GET returns the RESOLVED set — what a registration form for that event
// actually asks — because that is the question staff are really asking when they open it.
// ---------------------------------------------------------------------------

/**
 * A question is archived, never deleted (the brief's rule, and the reason it holds): an
 * archived row keeps every answer it collected readable, so last year's attendee list still
 * shows what people answered to a question nobody asks any more. A DELETE route would have
 * to either orphan those answers or destroy them.
 */
async function archiveQuestionRow(
  c: Context<ManageBindings>,
  portalId: string,
  questionId: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await c.env.DB.prepare(
    `UPDATE registration_questions SET archived_at = ?1, updated_at = ?1
      WHERE portal_id = ?2 AND id = ?3 AND archived_at IS NULL`,
  )
    .bind(now, portalId, questionId)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

async function readQuestionBody(
  c: Context<ManageBindings>,
): Promise<Record<string, unknown> | Response> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }
}

async function insertQuestion(
  c: Context<ManageBindings>,
  portalId: string,
  eventId: string | null,
  body: Record<string, unknown>,
): Promise<Response> {
  const parsed = normaliseQuestionDefinition(body);
  if (!parsed.ok) return c.json({ status: parsed.status, message: parsed.message }, 400);

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  // Creating the mapped contact property is a HubSpot side effect, so it goes in the SAME
  // D1 batch as the question that earns it and drains through the queue (CLAUDE.md's outbox
  // invariant). Done inline, a timeout left the question stored and the editor told the
  // save had failed, and the retry could only ever earn `duplicate_key`.
  const createProperty = body.createHsProperty === true && parsed.definition.hsProperty !== null;
  const propertyOutboxId = crypto.randomUUID();
  try {
    const statements = [
      c.env.DB.prepare(
        `INSERT INTO registration_questions
         (id, portal_id, event_id, key, label, field_type, options_json,
          required, scope, hs_property, prefill, help_text, sort_order,
          archived_at, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, NULL, ?14, ?14)`,
      ).bind(
        id,
        portalId,
        eventId,
        parsed.definition.key,
        parsed.definition.label,
        parsed.definition.fieldType,
        parsed.definition.optionsJson,
        parsed.definition.required,
        parsed.definition.scope,
        parsed.definition.hsProperty,
        parsed.definition.prefill,
        parsed.definition.helpText,
        parsed.definition.sortOrder,
        now,
      ),
    ];
    if (createProperty) {
      statements.push(
        questionPropertyStatement(
          c.env,
          portalId,
          { questionId: id, hsProperty: parsed.definition.hsProperty as string },
          propertyOutboxId,
          now,
        ),
      );
    }
    await c.env.DB.batch(statements);
  } catch (err) {
    // The partial unique index rejected a second LIVE question with this key at this level.
    // Named rather than surfaced as a 500: the fix is to edit the existing one or archive
    // it first, and a caller cannot work that out from "constraint failed".
    return c.json(
      {
        status: 'duplicate_key',
        message: `A question with key "${parsed.definition.key}" already exists${
          eventId ? ' on this event' : ' for this portal'
        }`,
        detail: err instanceof Error ? err.message : String(err),
      },
      409,
    );
  }

  // Best-effort wake for the row just committed; the reconcile sweep is the backstop.
  if (createProperty) {
    try {
      await signalQuestionProperty(c.env, portalId, propertyOutboxId);
    } catch {
      // Queue unavailable — the row is committed and the sweep will drive it.
    }
  }

  const row = await loadQuestion(c.env, portalId, id);
  const question = row ? toAdminQuestion(row) : null;
  return c.json(
    {
      ok: true,
      question,
      hsProperty: await checkQuestionProperty(c, portalId, question, { queued: createProperty }),
    },
    201,
  );
}

/**
 * Whether the contact property a question maps to exists. A READ, and only a read.
 *
 * The editor is owed this answer while it is still looking at the form: a typo'd property
 * name is worth knowing about now, not at the next drain. The CREATE is a side effect and
 * left to the `question.ensure_property` outbox row enqueued alongside the question, so
 * `queued` is what turns "this property does not exist" into "it is being created".
 *
 * Best-effort by contract. The question is already stored in D1 by the time this runs, so
 * every failure reports rather than throws — losing a question because HubSpot could not be
 * reached would be a far worse trade than an unchecked property.
 */
async function checkQuestionProperty(
  c: Context<ManageBindings>,
  portalId: string,
  question: ReturnType<typeof toAdminQuestion> | null,
  options: { queued: boolean },
): Promise<{ property: string; status: string; detail: string | null; queued: boolean } | null> {
  if (!question?.hsProperty) return null;
  let token: string;
  try {
    token = await getAccessToken(c.env, portalId);
  } catch {
    return {
      property: question.hsProperty,
      status: 'unavailable',
      detail: 'HubSpot is not connected',
      queued: options.queued,
    };
  }
  const result = await ensureQuestionProperty(token, {
    ...question,
    hsProperty: question.hsProperty,
  });
  return { property: question.hsProperty, ...result, queued: options.queued };
}

/**
 * GET /questions — the tenant-wide defaults.
 * `?includeArchived=1` shows retired ones, which is how staff find the answers behind a
 * question that is no longer asked.
 */
async function handleListPortalQuestions(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const includeArchived = c.req.query('includeArchived') === '1';
  const rows = await listQuestions(c.env, portalId, { includeArchived });
  // The tenant-wide set only — an event's own questions belong to that event's endpoint.
  return c.json(rows.filter((question) => question.eventId === null));
}

async function handleCreatePortalQuestion(c: Context<ManageBindings>): Promise<Response> {
  const body = await readQuestionBody(c);
  if (body instanceof Response) return body;
  return insertQuestion(c, c.get('portalId'), null, body);
}

/**
 * GET /events/:id/questions — what this event actually asks.
 *
 * Returns the RESOLVED set by default (tenant-wide defaults plus the event's own, with the
 * event's winning on a shared key), because that is the list a registration form renders
 * and the list staff want to check. `?raw=1` returns the underlying rows instead, which is
 * what an editor needs to tell an inherited default from an override.
 */
async function handleListEventQuestions(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const eventId = c.req.param('id') as string;

  const event = await c.env.DB.prepare('SELECT id FROM events WHERE portal_id = ?1 AND id = ?2')
    .bind(portalId, eventId)
    .first();
  if (!event) return c.json({ status: 'not_found', message: 'Event not found' }, 404);

  if (c.req.query('raw') === '1') {
    const includeArchived = c.req.query('includeArchived') === '1';
    return c.json(await listQuestions(c.env, portalId, { eventId, includeArchived }));
  }
  return c.json(await loadEventQuestions(c.env, portalId, eventId));
}

async function handleCreateEventQuestion(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const eventId = c.req.param('id') as string;

  const event = await c.env.DB.prepare('SELECT id FROM events WHERE portal_id = ?1 AND id = ?2')
    .bind(portalId, eventId)
    .first();
  if (!event) return c.json({ status: 'not_found', message: 'Event not found' }, 404);

  const body = await readQuestionBody(c);
  if (body instanceof Response) return body;
  return insertQuestion(c, portalId, eventId, body);
}

/**
 * PATCH /questions/:qid — edit the presentation, never the meaning.
 *
 * `key`, `field_type` and `scope` are immutable, and that is the point of the route rather
 * than an omission from it. Every one of them changes what already-stored answers MEAN:
 * repointing a key silently relabels last year's answers, and switching a textarea to a
 * select leaves stored values that are not options. The supported way to change a question's
 * meaning is to archive it and add its replacement — which keeps both readable side by side.
 */
async function handlePatchQuestion(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const questionId = c.req.param('qid') as string;

  const existing = await loadQuestion(c.env, portalId, questionId);
  if (!existing) return c.json({ status: 'not_found', message: 'Question not found' }, 404);

  const body = await readQuestionBody(c);
  if (body instanceof Response) return body;

  for (const immutable of ['key', 'fieldType', 'field_type', 'scope'] as const) {
    if (body[immutable] === undefined) continue;
    const supplied = String(body[immutable]);
    const current =
      immutable === 'key'
        ? existing.key
        : immutable === 'scope'
          ? existing.scope
          : existing.field_type;
    if (supplied === current) continue;
    return c.json(
      {
        status: 'immutable_field',
        message:
          `"${immutable}" cannot be changed once a question exists — it would change what ` +
          'stored answers mean. Archive this question and add a replacement instead.',
      },
      409,
    );
  }

  // Re-validated as a whole rather than field by field: a patch that adds `options` to a
  // select and a patch that removes them have to be judged against the same rules a create
  // is, or a question can be edited into a state it could never have been created in.
  const parsed = normaliseQuestionDefinition({
    key: existing.key,
    scope: existing.scope,
    fieldType: existing.field_type,
    label: body.label ?? existing.label,
    options: body.options ?? JSON.parse(existing.options_json ?? 'null'),
    required: body.required ?? existing.required === 1,
    hsProperty: body.hsProperty ?? existing.hs_property,
    prefill: body.prefill ?? existing.prefill === 1,
    helpText: body.helpText ?? existing.help_text,
    sortOrder: body.sortOrder ?? existing.sort_order,
  });
  if (!parsed.ok) return c.json({ status: parsed.status, message: parsed.message }, 400);

  // Same batch, same reason as the create: an edit that repoints the question at a property
  // the portal does not have yet needs that property made, and making it is a side effect.
  const now = new Date().toISOString();
  const createProperty = body.createHsProperty === true && parsed.definition.hsProperty !== null;
  const propertyOutboxId = crypto.randomUUID();
  const statements = [
    c.env.DB.prepare(
      `UPDATE registration_questions
        SET label = ?1, options_json = ?2, required = ?3, hs_property = ?4,
            prefill = ?5, help_text = ?6, sort_order = ?7, updated_at = ?8
      WHERE portal_id = ?9 AND id = ?10`,
    ).bind(
      parsed.definition.label,
      parsed.definition.optionsJson,
      parsed.definition.required,
      parsed.definition.hsProperty,
      parsed.definition.prefill,
      parsed.definition.helpText,
      parsed.definition.sortOrder,
      now,
      portalId,
      questionId,
    ),
  ];
  if (createProperty) {
    statements.push(
      questionPropertyStatement(
        c.env,
        portalId,
        { questionId, hsProperty: parsed.definition.hsProperty as string },
        propertyOutboxId,
        now,
      ),
    );
  }
  await c.env.DB.batch(statements);

  if (createProperty) {
    try {
      await signalQuestionProperty(c.env, portalId, propertyOutboxId);
    } catch {
      // Queue unavailable — the row is committed and the sweep will drive it.
    }
  }

  const row = await loadQuestion(c.env, portalId, questionId);
  const question = row ? toAdminQuestion(row) : null;
  return c.json({
    ok: true,
    question,
    hsProperty: await checkQuestionProperty(c, portalId, question, { queued: createProperty }),
  });
}

/** DELETE /questions/:qid — archives. See `archiveQuestionRow`. */
async function handleArchiveQuestion(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const questionId = c.req.param('qid') as string;

  const existing = await loadQuestion(c.env, portalId, questionId);
  if (!existing) return c.json({ status: 'not_found', message: 'Question not found' }, 404);
  if (existing.archived_at !== null) {
    return c.json({ ok: true, alreadyArchived: true, question: toAdminQuestion(existing) });
  }

  await archiveQuestionRow(c, portalId, questionId);
  const row = await loadQuestion(c.env, portalId, questionId);
  return c.json({ ok: true, question: row ? toAdminQuestion(row) : null });
}

/**
 * GET /events/:id/questions/prefill?email= — what this person already answered.
 *
 * The staff half of "you should not have to type this again". Public checkout gets its
 * prefill from HubSpot itself: the CMS renders the front end, knows who is logged in, and
 * can populate a field from the visitor's OWN contact using the `hsProperty` the public
 * questions endpoint hands it. Staff booking on someone else's behalf have no such
 * session, so they ask here — and this route is admin-authed, which is the whole reason it
 * exists separately. An unauthenticated endpoint that returned a person's dietary
 * requirements given only their email address would be a data leak with a convenience
 * feature's name on it.
 *
 * Only questions with `prefill` set are looked up: a question mapped to a property for
 * reporting but meant to be answered fresh each event is deliberately not pre-answered.
 */
async function handleQuestionPrefill(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const eventId = c.req.param('id') as string;
  const email = cleanEmail(c.req.query('email'));

  if (!email || !isValidEmail(email)) {
    return c.json({ status: 'invalid_email', message: 'A valid email is required' }, 400);
  }

  const questions = await loadEventQuestions(c.env, portalId, eventId);
  const mapped = questions.filter(
    (question): question is RegistrationQuestion & { hsProperty: string } =>
      question.prefill && question.hsProperty !== null,
  );
  if (mapped.length === 0) return c.json({ email, answers: {} });

  let token: string;
  try {
    token = await getAccessToken(c.env, portalId);
  } catch {
    return c.json({ status: 'hubspot_unavailable', message: 'HubSpot is not connected' }, 502);
  }

  const properties = [...new Set(mapped.map((question) => question.hsProperty))];
  const url =
    `https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(email)}` +
    `?idProperty=email&properties=${properties.map(encodeURIComponent).join(',')}`;

  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  // No contact yet is the ordinary case for a first-time attendee, not an error: there is
  // simply nothing to offer back.
  if (response.status === 404) return c.json({ email, answers: {} });
  if (!response.ok) {
    return c.json({ status: 'hubspot_error', message: `HubSpot returned ${response.status}` }, 502);
  }

  const contact = (await response.json()) as {
    properties?: Record<string, string | null | undefined>;
  };
  const answers: Record<string, string> = {};
  for (const question of mapped) {
    const value = (contact.properties?.[question.hsProperty] ?? '').trim();
    if (value !== '') answers[question.key] = value;
  }
  return c.json({ email, answers });
}

/** GET /events/:id/registrations/:regId/answers — one seat's answers, plus its booking's. */
async function handleListRegistrationAnswers(c: Context<ManageBindings>): Promise<Response> {
  const resolved = await resolveRegistrationForNotes(c);
  if (resolved instanceof Response) return resolved;

  const registration = await c.env.DB.prepare(
    'SELECT order_id FROM registrations WHERE portal_id = ?1 AND id = ?2',
  )
    .bind(resolved.portalId, resolved.registrationId)
    .first<{ order_id: string }>();

  const [own, booking] = await Promise.all([
    listAnswersFor(c.env, resolved.portalId, { registrationId: resolved.registrationId }),
    registration?.order_id
      ? listAnswersFor(c.env, resolved.portalId, { orderId: registration.order_id })
      : Promise.resolve([]),
  ]);
  return c.json({ attendee: own, order: booking });
}

// ---------------------------------------------------------------------------
// Sub-app — mounted at /api/v1/manage in index.ts
// ---------------------------------------------------------------------------

const manage = new Hono<ManageBindings>();

manage.use('/*', adminMiddleware);

manage.get('/events', handleListEvents);
manage.post('/events', handleCreateEvent);
manage.patch('/events/:id', handlePatchEvent);
manage.post('/events/:id/provision-webinar', handleProvisionWebinar);
manage.post('/events/:id/register-webinar-attendee', handleRegisterWebinarAttendee);
manage.get('/events/:id/ticket-types', handleListTicketTypes);
manage.get('/events/:id/course-components', handleListCourseComponents);
manage.post('/events/:id/ticket-types', handleCreateTicketType);
manage.patch('/events/:id/ticket-types/:ttId', handlePatchTicketType);
manage.get('/events/:id/pricing-rules', handleListPricingRules);
manage.post('/events/:id/pricing-rules', handleCreatePricingRule);
manage.delete('/events/:id/pricing-rules/:ruleId', handleDeletePricingRule);
manage.get('/events/:id/registrations', handleListRegistrations);
manage.get('/events/:id/registrations.csv', handleExportRegistrationsCsv);
manage.post('/events/:id/export-token', handleCreateExportToken);
manage.post('/events/:id/registrations', handleCreateManualRegistration);
manage.post('/events/:id/seat-blocks', handleCreateSeatBlock);
manage.post('/events/:id/registrations/:regId/refund', handleRefundRegistration);
manage.post('/events/:id/registrations/:regId/transfer', handleTransferRegistration);
manage.patch('/events/:id/registrations/:regId', handleAmendRegistration);
manage.delete('/events/:id/registrations/:regId', handleCancelRegistration);
manage.get('/events/:id/questions', handleListEventQuestions);
manage.post('/events/:id/questions', handleCreateEventQuestion);
manage.get('/events/:id/questions/prefill', handleQuestionPrefill);
manage.get('/events/:id/registrations/:regId/answers', handleListRegistrationAnswers);
manage.get('/events/:id/notes', handleListEventNotes);
manage.get('/events/:id/registrations/:regId/notes', handleListRegistrationNotes);
manage.post('/events/:id/registrations/:regId/notes', handleCreateRegistrationNote);
manage.get('/events/:id/orders/:orderId/notes', handleListOrderNotes);
manage.post('/events/:id/orders/:orderId/notes', handleCreateOrderNote);
manage.get('/events/:id/pending-decisions', handleListPendingDecisions);
manage.post('/decisions/:id/resolve', handleResolveDecision);
manage.get('/events/:id/attendance', handleEventAttendance);
manage.get('/events/:id/stats', handleEventStats);
manage.post('/events/:id/rebuild-capacity', handleRebuildCapacity);

// Question definitions are portal-level objects: the tenant-wide set lives here, and
// PATCH/DELETE address a question by id whichever level it belongs to.
manage.get('/questions', handleListPortalQuestions);
manage.post('/questions', handleCreatePortalQuestion);
manage.patch('/questions/:qid', handlePatchQuestion);
manage.delete('/questions/:qid', handleArchiveQuestion);

manage.post('/events/:id/orders/:orderId/reissue-invoice', handleReissueInvoice);

// Invoice eligibility is about the payer, so it is portal-level configuration and not an
// event's. Adding the first active rule turns the gate on; an empty set leaves every paid
// booking invoice-eligible (Phase 4.1's behaviour).
manage.get('/invoice-eligibility-rules', handleListInvoiceEligibilityRules);
manage.post('/invoice-eligibility-rules', handleCreateInvoiceEligibilityRule);
manage.patch('/invoice-eligibility-rules/:ruleId', handlePatchInvoiceEligibilityRule);
manage.delete('/invoice-eligibility-rules/:ruleId', handleDeleteInvoiceEligibilityRule);

manage.get('/refund-policies', handleListRefundPolicies);
manage.post('/refund-policies', handleCreateRefundPolicy);
manage.patch('/refund-policies/:id', handlePatchRefundPolicy);
manage.delete('/refund-policies/:id', handleDeleteRefundPolicy);

manage.get('/onboarding', handleGetOnboarding);
manage.patch('/onboarding/stripe', handlePatchStripe);
manage.patch('/onboarding/xero-gst', handlePatchXeroGst);
manage.patch('/onboarding/crm-routing', handlePatchCrmRouting);
manage.patch('/onboarding/membership-config', handlePatchMembershipConfig);
manage.patch('/onboarding/hubdb-pricing', handlePatchHubDbPricing);
manage.post('/onboarding/hubdb-pricing/sync', handleSyncHubDbPricing);
manage.patch('/onboarding/hubdb-capacity', handlePatchHubDbCapacity);
manage.post('/onboarding/hubdb-capacity/sync', handleSyncHubDbCapacity);
manage.patch('/onboarding/contact-property-config', handlePatchContactPropertyConfig);
manage.patch('/onboarding/attendance-property-config', handlePatchAttendancePropertyConfig);
manage.patch('/onboarding/voucher-config', handlePatchVoucherConfig);
manage.patch('/onboarding/payment-terms', handlePatchPaymentTerms);
manage.patch('/onboarding/unpaid-invoice-mode', handlePatchUnpaidInvoiceMode);
manage.patch('/onboarding/webinar-creds', handlePatchWebinarCreds);
manage.get('/onboarding/webinar-creds', handleGetWebinarCreds);
manage.get('/onboarding/connections', handleListConnections);
manage.put('/onboarding/connections/on24', handlePutOn24);
manage.delete('/onboarding/connections/:provider', handleDisconnect);
manage.post('/onboarding/provision', handleProvision);
manage.get('/onboarding/properties', handleInspectProperties);
manage.post('/onboarding/properties', handleProvisionProperties);
manage.patch('/onboarding/dynamic-page', handlePatchDynamicPage);
manage.get('/reports/registrations', handleRegistrationsReport);

// ---------------------------------------------------------------------------
// GET /diagnostics/outbox
//
// What the write-back is stuck on, for this portal, right now.
//
// Every HubSpot side effect goes through the outbox, so "the customer has no invoice" and
// "the contact never got stamped" are both answered by one table — and until now the only
// way to read it was Cloudflare's log search, which shows what failed at the moment it
// failed and nothing about what is still failing. A dead row is days of silence by design:
// the booking succeeded, the seat is held, and only the HubSpot half is missing.
//
// Read-only, admin-authed, and it names the row's topic, its order and the reason it
// stopped. `?orderId=` traces one booking end to end, which is the shape of the question a
// support ticket actually arrives in ("this person paid and has no invoice"); `?topic=` and
// `?status=` narrow it to the fault being chased.
//
// Those last two used to be accepted and IGNORED. The row list is the 50 most recent
// undelivered rows, and Weld's portal carries 72 dead ones, so a `?topic=` that reads as an
// applied filter and is not one hands a responder a list that can silently omit the very
// rows they asked for — during an incident, off the endpoint whose whole job is triage.
// `scope` now echoes exactly what was applied, and `matched` says how many rows the scope
// holds, so a truncated list cannot read as a complete one.
// ---------------------------------------------------------------------------

/**
 * The statuses a row can actually be in.
 *
 * An unrecognised one is a 400 rather than an empty list: `?status=died` returning no rows
 * is indistinguishable from a portal with nothing wrong, and "we did not look" must never
 * render as "nothing found".
 */
const OUTBOX_STATUSES = ['pending', 'failed', 'delivered', 'dead'] as const;

/**
 * The scope half of the diagnostic's WHERE, shared by the row read and the `matched` count
 * for the reason the re-drive shares its own: two copies is how a count starts answering a
 * different question from the one the list asked.
 *
 * Binds ?2 (orderId), ?3 (topic), ?4 (status) and ?5 (1 = keep delivered rows).
 */
const OUTBOX_DIAGNOSTIC_FILTER = `
        AND (?2 IS NULL OR json_extract(IIF(json_valid(payload), payload, '{}'), '$.orderId') = ?2)
        AND (?3 IS NULL OR topic = ?3)
        AND (?4 IS NULL OR status = ?4)
        AND (?5 = 1 OR status != 'delivered')`;

interface OutboxDiagnosticRow {
  id: string;
  topic: string;
  status: string;
  attempts: number;
  created_at: string;
  next_attempt_at: string | null;
  payload: string;
}

function summariseOutboxRow(row: OutboxDiagnosticRow) {
  let orderId: string | null = null;
  let registrationId: string | null = null;
  let deadReason: string | null = null;
  let deadAt: string | null = null;
  let lastError: string | null = null;
  let lastErrorAt: string | null = null;
  let malformed = false;
  try {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    orderId = typeof payload.orderId === 'string' ? payload.orderId : null;
    registrationId = typeof payload.registrationId === 'string' ? payload.registrationId : null;
    deadReason = typeof payload._dead_reason === 'string' ? payload._dead_reason : null;
    // When it stopped, which is not when it was created: a row can retry for a day first,
    // and "did this die before or after we shipped the fix" is the question being asked.
    deadAt = typeof payload._dead_at === 'string' ? payload._dead_at : null;
    // A row that is still retrying has no `_dead_reason` and used to say nothing at all
    // about what was wrong with it — the reason lived only in a warn-level log line.
    lastError = typeof payload._last_error === 'string' ? payload._last_error : null;
    lastErrorAt = typeof payload._last_error_at === 'string' ? payload._last_error_at : null;
  } catch {
    // A payload that will not parse is itself the finding: the dispatcher can do nothing
    // with such a row but record it, and this is where someone finds out which row it was.
    malformed = true;
  }
  // A DELIVERED row has no reason: it succeeded. `_last_error` is only cleared on delivery
  // as of this change, so every row delivered before it still carries whatever it failed on
  // the way through — and reporting that as the row's reason is a fault being named against
  // a booking that does not have one. Weld's `deal.create` read back a HubSpot 403
  // `MISSING_SCOPES` it had recovered from days earlier. `attempts` is what says a row
  // struggled, and it cannot be mistaken for a live failure.
  const settled = row.status === 'delivered';
  return {
    id: row.id,
    topic: row.topic,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.created_at,
    nextAttemptAt: row.next_attempt_at,
    orderId,
    registrationId,
    reason: settled ? null : (deadReason ?? lastError),
    deadAt: settled ? null : deadAt,
    lastErrorAt: settled || deadReason ? null : lastErrorAt,
    malformedPayload: malformed,
  };
}

async function handleOutboxDiagnostics(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const orderId = c.req.query('orderId')?.trim() || null;
  const topic = c.req.query('topic')?.trim() || null;
  const status = c.req.query('status')?.trim() || null;
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? '50') || 50, 1), 200);

  if (status !== null && !(OUTBOX_STATUSES as readonly string[]).includes(status)) {
    return c.json(
      {
        error: 'unknown_status',
        message: `"${status}" is not an outbox status. Use one of: ${OUTBOX_STATUSES.join(', ')}.`,
      },
      400,
    );
  }

  // `delivered` is the boring majority, so it is excluded unless somebody asked for it —
  // either by naming a status, or by tracing one booking, where the delivered rows are half
  // the story ("the deal landed, the invoice never did").
  const includeDelivered = orderId !== null || status !== null;

  const counts = await c.env.DB.prepare(
    `SELECT topic, status, COUNT(*) AS count
       FROM outbox
      WHERE portal_id = ?1
      GROUP BY topic, status`,
  )
    .bind(portalId)
    .all<{ topic: string; status: string; count: number }>();

  // Everything a person would act on: dead rows, and rows still trying, narrowed by
  // whatever the caller scoped it to. `matched` comes off the same filter, so the caller
  // can tell a complete list from the head of a longer one.
  const scopeBinds = [orderId, topic, status, includeDelivered ? 1 : 0] as const;
  const [rows, matched] = await c.env.DB.batch<OutboxDiagnosticRow | { count: number }>([
    c.env.DB.prepare(
      `SELECT id, topic, status, attempts, created_at, next_attempt_at, payload
         FROM outbox
        WHERE portal_id = ?1${OUTBOX_DIAGNOSTIC_FILTER}
        ORDER BY created_at DESC
        LIMIT ?6`,
    ).bind(portalId, ...scopeBinds, limit),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM outbox
        WHERE portal_id = ?1${OUTBOX_DIAGNOSTIC_FILTER}`,
    ).bind(portalId, ...scopeBinds),
  ]);

  const byStatus: Record<string, number> = {};
  for (const row of counts.results) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + row.count;
  }

  return c.json({
    portalId,
    generatedAt: new Date().toISOString(),
    // Exactly what was applied to `rows`, so a filter that was not honoured cannot look
    // like one that was. `status` is what the caller asked for, or the default exclusion.
    scope: {
      orderId,
      topic,
      status: status ?? (includeDelivered ? null : 'not delivered'),
      limit,
    },
    // The whole portal, deliberately unscoped: this is the picture that says where else to
    // look, and narrowing it to the scope would answer only the question already asked.
    summary: {
      byStatus,
      byTopic: counts.results.map((row) => ({
        topic: row.topic,
        status: row.status,
        count: row.count,
      })),
    },
    // How many rows the SCOPE holds, against the `rows.length` returned: a list cut off at
    // `limit` and a list that is everything look identical otherwise.
    matched: (matched.results[0] as { count: number } | undefined)?.count ?? 0,
    rows: (rows.results as OutboxDiagnosticRow[]).map(summariseOutboxRow),
  });
}

// ---------------------------------------------------------------------------
// POST /diagnostics/outbox/redrive
//
// Send dead rows round again, once the reason they died has been dealt with.
//
// The read-only diagnostic above answers "why has this booking no invoice"; this is the
// other half, because until now the answer was "it never will". Nothing un-deads a row,
// and only two of the topics that die can be re-derived from D1 by `reconcileOutbox`
// (`me.register` from `marketing_event_state_synced`, the deal and invoice from the NULL
// ids on the order). `contact.sync_registration_confirmation` has no marker in D1 at all —
// whether the stamp landed is knowable only from the HubSpot contact — so a dead one is an
// attendee who never gets their confirmation email and nothing that will ever try again.
//
// An operator action rather than a sweep, for the reason `reportOutboxHealth` changes
// nothing: re-driving against a cause nobody has fixed re-kills the row, and a fresh dead
// row every fifteen minutes is how the real ones stop being visible. Read the diagnostic,
// fix the cause, re-drive. See `outbox-redrive.ts` for the rest of the argument.
// ---------------------------------------------------------------------------

interface RedriveCandidate {
  id: string;
  topic: string;
  payload: string;
}

/**
 * The scope half of the re-drive's WHERE, shared by the row read and the `remaining` count.
 *
 * Two copies is how `remaining` starts answering a different question from the one the
 * re-drive asked — it would still be a number, and it would still look right. Binds ?2
 * (topic), ?3 (orderId) and ?4 (ids as a JSON array), in that order, so a caller of either
 * query binds the same three in the same places.
 */
const REDRIVE_SCOPE_FILTER = `
        AND (?2 IS NULL OR topic = ?2)
        AND (?3 IS NULL OR json_extract(IIF(json_valid(payload), payload, '{}'), '$.orderId') = ?3)
        AND (?4 IS NULL OR id IN (SELECT value FROM json_each(?4)))`;

async function handleOutboxRedrive(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');

  let body: unknown = {};
  try {
    body = await c.req.json();
  } catch {
    // An absent or unreadable body is an unscoped request, which the parse below refuses
    // by name rather than quietly re-driving the portal's whole history.
    body = {};
  }

  const parsed = parseRedriveScope(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { ids, topic, orderId, limit } = parsed.scope;

  // Only `dead` rows. A `pending` or `failed` row already belongs to the reconcile sweep,
  // and resetting its attempt count would erase the one number that says how long it has
  // been failing.
  const candidates = await c.env.DB.prepare(
    `SELECT id, topic, payload
       FROM outbox
      WHERE portal_id = ?1
        AND status = 'dead'${REDRIVE_SCOPE_FILTER}
      ORDER BY created_at ASC
      LIMIT ?5`,
  )
    .bind(portalId, topic ?? null, orderId ?? null, ids ? JSON.stringify(ids) : null, limit)
    .all<RedriveCandidate>();

  const now = new Date().toISOString();
  const redriven: Array<{ id: string; topic: string }> = [];
  const skipped: Array<{ id: string; topic: string; reason: string }> = [];
  const updates: D1PreparedStatement[] = [];

  for (const row of candidates.results) {
    const payload = clearDeathMarks(row.payload);
    if (payload === null) {
      // Permanent by definition: the dispatcher can do nothing with a payload it cannot
      // parse but record it, so re-driving is a guaranteed second death.
      skipped.push({ id: row.id, topic: row.topic, reason: 'payload will not parse' });
      continue;
    }

    // `stable_interaction_datetime` is untouched on purpose: Marketing Event attendance
    // writes are idempotent only because it is frozen at first attempt.
    updates.push(
      c.env.DB.prepare(
        `UPDATE outbox
            SET status = 'pending', attempts = 0, next_attempt_at = ?1, payload = ?2
          WHERE id = ?3 AND portal_id = ?4 AND status = 'dead'`,
      ).bind(now, payload, row.id, portalId),
    );
    redriven.push({ id: row.id, topic: row.topic });
  }

  // Batched rather than a statement and a queue send per row. At the 200 ceiling the
  // serial version was 400 round trips inside one request, which is a lot of wall time to
  // spend on what is two writes per row.
  //
  // **D1 first, and only then the queue.** A row the queue is told about but D1 never
  // flipped is still `dead`, and `handleOutboxMessage` would find it in a state it does
  // not drain; the reverse (flipped but not signalled) is recovered by `reconcileOutbox`
  // step 1 on the next sweep, which is what that step is for. Of the two ways to be
  // wrong, one needs a human and the other fixes itself within fifteen minutes.
  if (updates.length > 0) await c.env.DB.batch(updates);

  // Queues caps a batch at 100 messages.
  for (let i = 0; i < redriven.length; i += 100) {
    await c.env.QUEUE.sendBatch(
      redriven.slice(i, i + 100).map((row) => ({
        body: { kind: row.topic, portalId, outboxId: row.id },
      })),
    );
  }

  // How many dead rows this scope still holds after the re-drive. An operator clearing a
  // backlog 200 at a time was otherwise guessing whether to call again — and a non-zero
  // `remaining` beside a non-zero `redriven` is the difference between "more to do" and
  // "these will not move".
  const remainingRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count
       FROM outbox
      WHERE portal_id = ?1
        AND status = 'dead'${REDRIVE_SCOPE_FILTER}`,
  )
    .bind(portalId, topic ?? null, orderId ?? null, ids ? JSON.stringify(ids) : null)
    .first<{ count: number }>();
  const remaining = remainingRow?.count ?? 0;

  console.log(
    JSON.stringify({
      level: 'info',
      event: 'outbox_redriven',
      portalId,
      scope: { ids: ids ?? null, topic: topic ?? null, orderId: orderId ?? null },
      redriven: redriven.length,
      skipped: skipped.length,
      remaining,
    }),
  );

  return c.json({
    portalId,
    redrivenAt: now,
    scope: { ids: ids ?? null, topic: topic ?? null, orderId: orderId ?? null, limit },
    summary: { redriven: redriven.length, skipped: skipped.length, remaining },
    redriven,
    skipped,
  });
}

// ---------------------------------------------------------------------------
// GET /diagnostics/pricing?email=&eventId=
//
// "Why was this member told the course price changed before checkout."
//
// `price_mismatch` is raised when the worker resolves a price ABOVE the one the CMS
// displayed, and for a logged-in member that is almost never a stale page. It is the two
// sides resolving the same buyer differently: a membership the worker cannot verify, a
// tier it reads from a different property, or a HubDB row it cannot find. All three end as
// one sentence to the customer and nothing anywhere else, so the cause has had to be
// re-derived from a customer describing an error, every time.
//
// This answers it directly, for one buyer on one event: what membership we resolve and
// from where, whether the HubDB row was found, which column that level picks, and the
// cents we would charge each ticket type. Read-only, admin-authed, and it reads the SAME
// functions reserve does, so it cannot describe a different worker from the one refusing
// the booking.
//
// It deliberately returns no contact details beyond the email that was asked about.
// ---------------------------------------------------------------------------

async function handlePricingDiagnostics(c: Context<ManageBindings>): Promise<Response> {
  const portalId = c.get('portalId');
  const email = (c.req.query('email') ?? '').trim();
  const eventId = (c.req.query('eventId') ?? '').trim();
  const memberCompanyId = (c.req.query('memberCompanyId') ?? '').trim() || undefined;

  if (!email || !eventId) {
    return c.json({ error: 'email and eventId are both required' }, 400);
  }

  const event = await loadEvent(c.env.DB, portalId, eventId);
  if (!event) return c.json({ error: 'event_not_found', eventId }, 404);

  const membership = await resolveMembership(c.env, portalId, email, { memberCompanyId });
  const membershipConfig = await loadMembershipConfig(c.env, portalId);
  const ticketTypes = await loadTicketTypes(c.env.DB, event.id);

  const sources = await loadHubDbPricingSources(c.env, portalId);
  const token = await resolveHubSpotReadToken(c.env, portalId);
  const hit =
    sources.length > 0 && token
      ? await fetchHubDbPricingRow({
          sources,
          token,
          eventId: event.id,
          hubspotEventId: event.hubspot_event_id,
          portalId,
        })
      : null;

  // The column this buyer's level lands on, which is the half that silently differs from
  // the CMS. Null level is not an error: it takes the generic member column, as the CMS
  // does for a member with no tier. Read off the source the row came from - with two
  // tables configured, naming the courses column for a row that came out of events would
  // describe a lookup that never happened.
  const levelColumn = hit ? columnForLevel(hit.source.columns, membership.level ?? 'member') : null;

  const published = await loadPublishedPrices(c.env, portalId, event.id, event.hubspot_event_id);

  const prices = [];
  for (const tt of ticketTypes) {
    prices.push({
      ticketTypeId: tt.id,
      name: tt.name,
      memberOnly: Boolean(tt.member_only),
      storedPriceCents: tt.price_cents,
      resolvedUnitCents: await resolvePrice(c.env, {
        portalId,
        eventId: event.id,
        hubspotEventId: event.hubspot_event_id,
        ticketType: tt,
        isMember: membership.isMember,
        level: membership.level,
        category: membership.category,
      }),
    });
  }

  return c.json({
    portalId,
    generatedAt: new Date().toISOString(),
    buyer: { email, memberCompanyId: memberCompanyId ?? null },
    event: { id: event.id, title: event.title, hubspotEventId: event.hubspot_event_id },
    // The verdict the reserve gates and the pricing chain both run off. `isMember: false`
    // here on somebody the portal shows as a member is the whole answer: the fault is the
    // membership gate, not pricing, and no price change will fix it.
    membership: {
      isMember: membership.isMember,
      verified: membership.verified,
      level: membership.level,
      category: membership.category,
      // WHICH contact properties that verdict was read from, and whether anyone chose
      // them. `verified: false` is "nothing in the CRM said anything at all", and the
      // commonest reason for that is not the contact: it is this mapping never having
      // been set, so the worker asks HubSpot for a property the portal does not have and
      // correctly finds nothing. The company, mirror and directory sources are mapped
      // separately (0046, `sources` below), so a portal can verify its CORPORATE members
      // and not see an individual one, or the other way round. That is the "some
      // logged-in members" shape, and it is unreadable from the verdict alone.
      //
      // `source: 'default'` carries the same warning `provisionProperties` gives a
      // defaulted write-back name: the app invented it, nobody confirmed it.
      contactProperties: {
        status: {
          name: membershipConfig.statusProperty ?? 'membership_status',
          source: membershipConfig.statusProperty ? 'mapped' : 'default',
        },
        // No default at all: unmapped means the level is never even requested, so a
        // member whose only signal is a tier on their own contact reads as nothing.
        level: {
          name: membershipConfig.levelProperty,
          source: membershipConfig.levelProperty ? 'mapped' : 'unmapped',
        },
        category: {
          name: membershipConfig.categoryProperty,
          source: membershipConfig.categoryProperty ? 'mapped' : 'unmapped',
        },
      },
      // The other three sources (0046). Empty / null means that source is not read at all,
      // so an employee whose membership lives only on their employer verifies as nothing.
      sources: {
        company: membershipConfig.companySources,
        mirror: {
          status: membershipConfig.mirrorStatusProperty,
          tier: membershipConfig.mirrorTierProperty,
        },
        directory: membershipConfig.memberDirectory,
      },
    },
    hubDb: {
      // "Not configured" and "configured but the row was not found" are different faults
      // with the same symptom, so they are reported separately.
      configured: sources.length > 0,
      tokenResolved: Boolean(token),
      // Every table this portal prices from, and then the one this event's row came out
      // of. Both, because "configured but no source held a row" and "found, in the table
      // you did not expect" are different answers and the first is unreadable from the
      // second alone.
      configuredSources: sources.map((source) => ({
        kind: source.kind,
        table: source.table,
        eventIdColumn: source.eventIdColumn,
        mappedColumns: source.columns,
        mappedDiscountColumns: source.discountColumns,
      })),
      rowFound: Boolean(hit),
      source: hit?.source.kind ?? null,
      table: hit?.source.table ?? null,
      eventIdColumn: hit?.source.eventIdColumn ?? null,
      // Which column this buyer's resolved level reads. Compare it against the column the
      // page priced from: a difference here IS the price disagreement.
      levelColumn,
      levelDiscountColumn: hit
        ? (hit.source.discountColumns[(membership.level ?? 'member') as MemberPriceLevel] ??
          hit.source.discountColumns.member ??
          null)
        : null,
      mappedColumns: hit?.source.columns ?? null,
    },
    // What a quote has to match for the reserve guard to accept it, and what
    // `reconcileMemberQuote` checks a verified member's quote against.
    publishedPricesCents: published.sort((a, b) => a - b),
    ticketTypes: prices,
  });
}

manage.get('/diagnostics/hubspot', handleHubSpotDiagnostics);
manage.get('/diagnostics/hubspot/tax-rates', handleHubSpotTaxRateDiagnostics);
manage.get('/diagnostics/outbox', handleOutboxDiagnostics);
manage.post('/diagnostics/outbox/redrive', handleOutboxRedrive);
manage.get('/diagnostics/pricing', handlePricingDiagnostics);

export const manageRoutes = manage;
