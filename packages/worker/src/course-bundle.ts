/**
 * Atomic-at-the-workflow-level holds for a complete course.
 *
 * Capacity remains atomic inside each child EventCapacity Durable Object. A
 * complete course spans several such objects, so this coordinator takes holds
 * in a stable module order and compensates by releasing every earlier hold if
 * a later component cannot be held. No durable order is written here: callers
 * must persist the returned holds and own payment confirmation afterwards.
 */

import type { EventRow, TicketTypeRow } from './db';
import { loadCourseComponents, loadTicketTypes } from './db';
import { syncCapacityBeforeHold } from './hubdb-capacity';
import type { Env } from './types';

export interface CourseBundleComponentConfig {
  event: EventRow;
  /** The private, zero-price ticket type used only by a parent course package. */
  packageTicket: TicketTypeRow;
}

export interface CourseModuleSelectionConfig {
  event: EventRow;
  /** The public ticket type selected by the buyer for this child module. */
  ticketType: TicketTypeRow;
  /** Server-authoritative buyer price for this one module seat. */
  unitCents: number;
}

export interface CourseBundleHold {
  eventId: string;
  ticketTypeId: string;
  reservationId: string;
  /**
   * Seats held in this module — the parent course's attendee count, not one.
   *
   * Payment confirmation clones every parent attendee into every module, so a hold of
   * one under a booking of four oversells each module by three the moment it confirms.
   * The number the DO is asked for has to be the number D1 will go on to write.
   */
  quantity: number;
  expiresAt: string;
}

export interface CourseModuleSelectionHold extends CourseBundleHold {
  unitCents: number;
}

/**
 * A temporary capacity hold plus its owning Durable Object. This is kept
 * internal to the reservation workflow so a failed database write can still
 * release every child hold before a response is sent.
 */
export interface LiveCourseBundleHold extends CourseBundleHold {
  stub: DurableObjectStub;
}

export type CourseBundleHoldResult =
  | { ok: true; holds: LiveCourseBundleHold[] }
  | {
      ok: false;
      status: 'course_component_not_configured' | 'course_component_full' | 'capacity_unconfirmed';
    };

export type CourseModuleSelectionHoldResult =
  | { ok: true; holds: Array<LiveCourseBundleHold & CourseModuleSelectionHold> }
  | {
      ok: false;
      status: 'course_component_not_configured' | 'course_component_full' | 'capacity_unconfirmed';
    };

/**
 * Resolves the required child events and their internal package ticket before
 * checkout takes any capacity. A component must have exactly one zero-price,
 * internal ticket; otherwise package checkout remains unavailable rather than
 * guessing which ticket represents the course entitlement.
 */
export function buildCourseBundleConfiguration(input: {
  components: EventRow[];
  ticketTypesByEvent: Map<string, TicketTypeRow[]>;
}): CourseBundleComponentConfig[] | null {
  const required = input.components.filter((component) => component.course_package_required);
  if (required.length === 0) return null;

  const configured: CourseBundleComponentConfig[] = [];
  for (const event of required) {
    const packageTickets = (input.ticketTypesByEvent.get(event.id) ?? []).filter(
      (ticket) => ticket.internal_only && ticket.price_cents === 0,
    );
    if (packageTickets.length !== 1) return null;
    configured.push({ event, packageTicket: packageTickets[0] });
  }
  return configured;
}

export async function loadCourseBundleConfiguration(input: {
  env: Env;
  portalId: string;
  parentEventId: string;
}): Promise<CourseBundleComponentConfig[] | null> {
  const components = await loadCourseComponents(input.env.DB, input.portalId, input.parentEventId);
  const ticketTypesByEvent = new Map(
    await Promise.all(
      components.map(
        async (component) =>
          [component.id, await loadTicketTypes(input.env.DB, component.id)] as const,
      ),
    ),
  );
  return buildCourseBundleConfiguration({ components, ticketTypesByEvent });
}

/**
 * Reserve one package seat in every required course module. Any failed child
 * reservation releases the prior holds before returning, so a partial package
 * cannot strand capacity.
 */
export async function holdCourseBundle(input: {
  env: Env;
  portalId: string;
  /** Attendees on the parent course booking. Each one takes a seat in every module. */
  seats: number;
  components: CourseBundleComponentConfig[];
  expiresAt?: string;
}): Promise<CourseBundleHoldResult> {
  const { env, portalId, components, expiresAt } = input;
  const seats = Math.trunc(input.seats);
  if (!Number.isFinite(seats) || seats < 1) {
    return { ok: false, status: 'course_component_not_configured' };
  }
  const holds: LiveCourseBundleHold[] = [];

  for (const component of components) {
    const { event, packageTicket } = component;
    if (
      event.parent_event_id === null ||
      !event.course_package_required ||
      !packageTicket.internal_only ||
      packageTicket.event_id !== event.id ||
      packageTicket.price_cents !== 0
    ) {
      await releaseCourseBundleHolds(holds);
      return { ok: false, status: 'course_component_not_configured' };
    }

    const doIdName = `${portalId}:${event.hubspot_event_id}`;
    const stub = env.EVENT_CAPACITY.get(env.EVENT_CAPACITY.idFromName(doIdName));
    if (!(await syncCapacityBeforeHold(env, portalId, stub, event, [packageTicket]))) {
      await releaseCourseBundleHolds(holds);
      return { ok: false, status: 'capacity_unconfirmed' };
    }

    const reservationId = crypto.randomUUID();
    const response = await stub.fetch('https://do/reserve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        holdId: reservationId,
        items: [{ ticketTypeId: packageTicket.id, quantity: seats }],
        ...(expiresAt ? { expiresAt } : {}),
      }),
    });
    const data = (await response.json()) as { ok?: boolean; full?: boolean; expiresAt?: string };
    if (!data.ok || !data.expiresAt) {
      await releaseCourseBundleHolds(holds);
      return {
        ok: false,
        status: data.full ? 'course_component_full' : 'course_component_not_configured',
      };
    }

    holds.push({
      eventId: event.id,
      ticketTypeId: packageTicket.id,
      reservationId,
      quantity: seats,
      expiresAt: data.expiresAt,
      stub,
    });
  }

  return { ok: true, holds };
}

/**
 * Reserve one public seat in each buyer-selected child module. This is the
 * arbitrary subset sibling of complete-course checkout: there is no parent
 * capacity hold, only one child hold per selected module. Any failed child
 * reservation releases the earlier holds so one checkout cannot strand a
 * partial module bundle.
 */
export async function holdCourseModuleSelection(input: {
  env: Env;
  portalId: string;
  components: CourseModuleSelectionConfig[];
  expiresAt?: string;
}): Promise<CourseModuleSelectionHoldResult> {
  const { env, portalId, components, expiresAt } = input;
  const holds: Array<LiveCourseBundleHold & CourseModuleSelectionHold> = [];

  for (const component of components) {
    const { event, ticketType, unitCents } = component;
    if (
      event.parent_event_id === null ||
      ticketType.internal_only ||
      ticketType.event_id !== event.id
    ) {
      await releaseCourseBundleHolds(holds);
      return { ok: false, status: 'course_component_not_configured' };
    }

    const doIdName = `${portalId}:${event.hubspot_event_id}`;
    const stub = env.EVENT_CAPACITY.get(env.EVENT_CAPACITY.idFromName(doIdName));
    if (!(await syncCapacityBeforeHold(env, portalId, stub, event, [ticketType]))) {
      await releaseCourseBundleHolds(holds);
      return { ok: false, status: 'capacity_unconfirmed' };
    }

    const reservationId = crypto.randomUUID();
    const response = await stub.fetch('https://do/reserve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        holdId: reservationId,
        items: [{ ticketTypeId: ticketType.id, quantity: 1 }],
        ...(expiresAt ? { expiresAt } : {}),
      }),
    });
    const data = (await response.json()) as { ok?: boolean; full?: boolean; expiresAt?: string };
    if (!data.ok || !data.expiresAt) {
      await releaseCourseBundleHolds(holds);
      return {
        ok: false,
        status: data.full ? 'course_component_full' : 'course_component_not_configured',
      };
    }

    holds.push({
      eventId: event.id,
      ticketTypeId: ticketType.id,
      reservationId,
      // One seat per selected module: a selected-module order registers its buyer against
      // the module directly, so unlike a complete course there are no parent attendees to
      // clone into it and nothing that makes the module carry more than the seat it holds.
      quantity: 1,
      expiresAt: data.expiresAt,
      unitCents,
      stub,
    });
  }

  return { ok: true, holds };
}

/**
 * Builds the D1 rows that make a granted child-event hold durable underneath a
 * parent course order. The caller must add its parent-order INSERT to the same
 * batch, and release the holds if that batch fails.
 */
export function courseBundleHoldStatements(input: {
  env: Env;
  portalId: string;
  orderId: string;
  holds: CourseBundleHold[];
  createdAt: string;
}): D1PreparedStatement[] {
  const { env, portalId, orderId, holds, createdAt } = input;
  return holds.flatMap((hold) => [
    // The reservation id deliberately equals the DO hold id. This keeps expiry
    // and later confirmation tied to the same authoritative capacity record.
    env.DB.prepare(
      `INSERT INTO reservations (id, portal_id, event_id, idempotency_key, status, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6)`,
    ).bind(
      hold.reservationId,
      portalId,
      hold.eventId,
      `course-package:${orderId}:${hold.eventId}`,
      hold.expiresAt,
      createdAt,
    ),
    // The package ticket costs $0; the parent order is the only charged item.
    env.DB.prepare(
      `INSERT INTO reservation_items (id, portal_id, reservation_id, ticket_type_id, quantity, unit_cents)
       VALUES (?1, ?2, ?3, ?4, ?5, 0)`,
    ).bind(crypto.randomUUID(), portalId, hold.reservationId, hold.ticketTypeId, hold.quantity),
    env.DB.prepare(
      `INSERT INTO course_bundle_components
         (id, portal_id, order_id, event_id, reservation_id, ticket_type_id, seats, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?8)`,
    ).bind(
      crypto.randomUUID(),
      portalId,
      orderId,
      hold.eventId,
      hold.reservationId,
      hold.ticketTypeId,
      hold.quantity,
      createdAt,
    ),
  ]);
}

/**
 * D1 rows for an arbitrary selected-module order. These use the same child-hold
 * ledger as complete-course packages, but reservation_items keep the real
 * module price because the selected modules are the charged seats.
 */
export function courseModuleSelectionHoldStatements(input: {
  env: Env;
  portalId: string;
  orderId: string;
  /**
   * The caller's Idempotency-Key header, NOT a value derived from this request.
   * `reservations.idempotency_key` carries `UNIQUE (portal_id, idempotency_key)`, and
   * that index — not the `idempotency_keys` table, whose insert is `OR IGNORE` on both
   * paths — is what makes a concurrent duplicate reserve abort its whole batch. Keying
   * these rows by the per-request `orderId` instead made the index uncollidable, so two
   * requests sharing a key both committed: two orders, two invoices, two deals.
   */
  idempotencyKey: string;
  holds: CourseModuleSelectionHold[];
  createdAt: string;
}): D1PreparedStatement[] {
  const { env, portalId, orderId, idempotencyKey, holds, createdAt } = input;
  return holds.flatMap((hold) => [
    env.DB.prepare(
      `INSERT INTO reservations (id, portal_id, event_id, idempotency_key, status, expires_at, created_at)
       VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6)`,
    ).bind(
      hold.reservationId,
      portalId,
      hold.eventId,
      `selected-modules:${idempotencyKey}:${hold.eventId}`,
      hold.expiresAt,
      createdAt,
    ),
    env.DB.prepare(
      `INSERT INTO reservation_items (id, portal_id, reservation_id, ticket_type_id, quantity, unit_cents)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(
      crypto.randomUUID(),
      portalId,
      hold.reservationId,
      hold.ticketTypeId,
      hold.quantity,
      hold.unitCents,
    ),
    env.DB.prepare(
      `INSERT INTO course_bundle_components
         (id, portal_id, order_id, event_id, reservation_id, ticket_type_id, seats, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8, ?8)`,
    ).bind(
      crypto.randomUUID(),
      portalId,
      orderId,
      hold.eventId,
      hold.reservationId,
      hold.ticketTypeId,
      hold.quantity,
      createdAt,
    ),
  ]);
}

/**
 * Persists a parent course order and every granted child hold in one D1 batch.
 * If D1 rejects the batch, capacity must be returned immediately: the caller
 * never receives an order response that is missing one of its module seats.
 */
export async function persistCourseBundle(input: {
  env: Env;
  portalId: string;
  orderId: string;
  holds: LiveCourseBundleHold[];
  createdAt: string;
  /** Parent order, invoice/outbox and registration statements owned by the route. */
  parentStatements: D1PreparedStatement[];
}): Promise<boolean> {
  const { env, portalId, orderId, holds, createdAt, parentStatements } = input;
  try {
    await env.DB.batch([
      ...parentStatements,
      ...courseBundleHoldStatements({ env, portalId, orderId, holds, createdAt }),
    ]);
    return true;
  } catch {
    await releaseCourseBundleHolds(holds);
    return false;
  }
}

export async function releaseCourseBundleHolds(holds: LiveCourseBundleHold[]) {
  await Promise.allSettled(
    holds.map((hold) =>
      hold.stub.fetch('https://do/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ holdId: hold.reservationId }),
      }),
    ),
  );
}
