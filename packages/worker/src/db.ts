// Typed D1 query helpers. Row types use snake_case to match column names.
// INTEGER booleans (0/1) are kept as number — callers cast with !!row.field.

export interface EventRow {
  id: string;
  portal_id: string;
  hubspot_event_id: string;
  hubspot_marketing_event_object_id: string | null;
  title: string;
  starts_at: string;
  ends_at: string;
  location: string | null;
  capacity: number;
  /** 1 = explicitly uncapped (migration 0020); the DO gets `null` inventory. */
  capacity_unlimited: number;
  booking_kind: 'event' | 'course';
  /** Parent course event for a separately bookable module, exam, or practical. */
  parent_event_id: string | null;
  /** `standalone` for existing events, otherwise the child course component type. */
  course_component_kind: CourseComponentKind;
  /** Display and study sequence within the parent course; null for standalone events. */
  course_component_order: number | null;
  /** HubSpot Product ID from the Course Modules HubDB row for this child event. */
  course_module_product_id: string | null;
  /** 1 when this child belongs to the approved complete-course package. */
  course_package_required: number;
  provider: string | null;
  allow_oversell: number;
  marketing_event_completed: number;
  teams_webinar_id: string | null;
  teams_session_id: string | null;
  teams_join_url: string | null;
  refund_policy_id: string | null;
  category: string | null;
  /** Per-event payment terms in days (migration 0015); null = portal/built-in default. */
  invoice_due_days: number | null;
  hubspot_owner_id: string | null;
  /** When the event first went live with a guard-passing capacity (migration 0020). */
  first_published_at: string | null;
  /**
   * Last instant a public booking is accepted (migration 0038). NULL resolves to
   * `starts_at` — see resolveSalesWindow. Optional while an older tenant database is
   * awaiting the additive migration.
   */
  registration_closes_at?: string | null;
  /** 1 = a human has stopped sales by hand (migration 0038). Does not touch capacity. */
  sales_paused?: number;
  /** Last HubDB capacity read (migration 0045); throttles the availability path. */
  capacity_synced_at?: string | null;
  created_at: string;
  updated_at: string;
}

export type CourseComponentKind = 'standalone' | 'module' | 'exam' | 'practical';

export interface TicketTypeRow {
  id: string;
  portal_id: string;
  event_id: string;
  name: string;
  price_cents: number;
  currency: string;
  capacity: number;
  capacity_unlimited: number;
  tax_treatment: string;
  member_only: number;
  hs_tax_rate_id: string | null;
  hs_product_id: string | null;
  /**
   * Internal ticket types reserve capacity but are never selectable in public checkout.
   * Optional while an older tenant database is awaiting the additive migration.
   */
  internal_only?: number;
  /** 1 = this ticket type alone is off sale (migration 0038); the event keeps selling. */
  sales_paused?: number;
  sort_order: number;
  created_at: string;
}

export interface OrderRow {
  id: string;
  portal_id: string;
  event_id: string;
  reservation_id: string | null;
  hubspot_invoice_id: string | null;
  hubspot_invoice_url: string | null;
  hubspot_deal_id: string | null;
  status: string;
  buyer_email: string;
  buyer_name: string;
  buyer_abn: string | null;
  total_cents: number;
  refunded_cents: number;
  currency: string;
  /** HubSpot company whose training vouchers this order draws on (corporate bookings). */
  member_company_id: string | null;
  /** Vouchers this order redeemed — the basis for derived usage. Units follow voucher_mode. */
  voucher_seats_redeemed: number;
  voucher_credit_cents: number;
  /**
   * How this booking was to be paid (migration 0029): 'invoice' = qualified for terms and
   * held to the due date, 'card' = pays at checkout on the default hold, NULL = free or
   * comped, so no payment applies.
   */
  payment_method: string | null;
  /** Terms granted, in days. NULL alongside 'card' and on free bookings. */
  payment_terms_days: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * The seat cap to hand the EventCapacity DO: `null` means uncapped. Reading the explicit
 * flag here — rather than treating 0 as "uncapped" — is what keeps a zero capacity a hard
 * stop instead of silently unlimited seats (migration 0020).
 */
export function effectiveCapacity(row: {
  capacity: number;
  capacity_unlimited?: number | null;
}): number | null {
  return row.capacity_unlimited ? null : row.capacity;
}

export function loadEvent(
  db: D1Database,
  portalId: string,
  eventId: string,
): Promise<EventRow | null> {
  return db
    .prepare('SELECT * FROM events WHERE portal_id = ?1 AND id = ?2')
    .bind(portalId, eventId)
    .first<EventRow>();
}

export function loadEventByHubspotId(
  db: D1Database,
  portalId: string,
  hubspotEventId: string,
): Promise<EventRow | null> {
  return db
    .prepare('SELECT * FROM events WHERE portal_id = ?1 AND hubspot_event_id = ?2')
    .bind(portalId, hubspotEventId)
    .first<EventRow>();
}

export function loadEventByTeamsWebinarId(
  db: D1Database,
  portalId: string,
  teamsWebinarId: string,
): Promise<EventRow | null> {
  return db
    .prepare('SELECT * FROM events WHERE portal_id = ?1 AND teams_webinar_id = ?2')
    .bind(portalId, teamsWebinarId)
    .first<EventRow>();
}

export async function loadOrderByInvoice(
  db: D1Database,
  portalId: string,
  hubspotInvoiceId: string,
): Promise<OrderRow | null> {
  return db
    .prepare('SELECT * FROM orders WHERE portal_id = ?1 AND hubspot_invoice_id = ?2')
    .bind(portalId, hubspotInvoiceId)
    .first<OrderRow>();
}

export async function loadTicketTypes(db: D1Database, eventId: string): Promise<TicketTypeRow[]> {
  const result = await db
    .prepare(
      'SELECT * FROM ticket_types WHERE event_id = ?1 ORDER BY sort_order ASC, created_at ASC',
    )
    .bind(eventId)
    .all<TicketTypeRow>();
  return result.results;
}

/** A child-module seat held or confirmed by one complete-course order. */
export interface CourseBundleComponentRow {
  id: string;
  portal_id: string;
  order_id: string;
  event_id: string;
  reservation_id: string;
  ticket_type_id: string;
  /**
   * Seats held in this module (migration 0036). One per attendee on the parent booking:
   * confirmation clones every parent attendee into every module, so the DO has to be
   * asked for the same number D1 goes on to write. Rows written before 0036 default to 1.
   */
  seats: number;
  status: 'pending' | 'confirmed' | 'released' | 'cancelled';
  created_at: string;
  updated_at: string;
}

/**
 * Returns the individually bookable parts of a parent course in learning order.
 * Each result is still a normal event and therefore uses the existing capacity
 * and registration lifecycle.
 */
export async function loadCourseComponents(
  db: D1Database,
  portalId: string,
  parentEventId: string,
): Promise<EventRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM events
        WHERE portal_id = ?1 AND parent_event_id = ?2
        ORDER BY course_component_order ASC, starts_at ASC, created_at ASC`,
    )
    .bind(portalId, parentEventId)
    .all<EventRow>();
  return result.results;
}

/**
 * Returns the child-event reservations owned by one complete-course order.
 * Payment, expiry and refund flows use this rather than assuming an order has
 * only the single reservation stored directly on `orders`.
 */
export async function loadCourseBundleComponents(
  db: D1Database,
  portalId: string,
  orderId: string,
): Promise<CourseBundleComponentRow[]> {
  try {
    const result = await db
      .prepare(
        `SELECT * FROM course_bundle_components
          WHERE portal_id = ?1 AND order_id = ?2
          ORDER BY created_at ASC, id ASC`,
      )
      .bind(portalId, orderId)
      .all<CourseBundleComponentRow>();
    return result.results;
  } catch {
    // Additive migration may not yet have been applied to an older tenant.
    // Those orders are ordinary one-event orders and keep their existing path.
    return [];
  }
}
