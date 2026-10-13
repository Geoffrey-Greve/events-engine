import { syncCapacityFromD1, syncCapacityFromD1Strict } from './capacity-sync';
import type { EventRow, TicketTypeRow } from './db';
import { fetchHubDbPricingRow, type HubDbPricingSource } from './hubdb-pricing';
import { resolveHubSpotReadToken } from './membership';
import type { Env } from './types';

/**
 * HubDB sets an event's CAPACITY (migration 0045); the EventCapacity DO still decides
 * every seat.
 *
 * Staff run the timetable in HubDB, so that is where they raise a course from 24 seats to
 * 30. Until this, nothing read it: `events.capacity` moved only through the app card, the
 * page kept advertising places the checkout refused, and "change the capacity in HubDB"
 * was the answer everyone gave and nothing honoured (QA ref 87).
 *
 * What this does is copy a changed cell into D1. The caller then re-syncs the DO from D1
 * as it always has, so:
 *  - nothing can oversell: a capacity lowered below the seats already sold leaves the
 *    event sold out and cancels nobody, because the DO counts confirmed seats itself;
 *  - D1 stays the durable record, so the DO's cold-start rebuild agrees with HubDB.
 *
 * It degrades to "no change" on anything it cannot read or does not trust: a blank or
 * non-numeric cell, anything below 1 (Phase 1.1 refuses a zero capacity for the reason
 * that it sells nothing), an unmapped portal, no token, HubSpot unreachable. The D1
 * capacity stands in every one of those, which is exactly the pre-0045 behaviour.
 */

/** The availability read is called on every course-page render; reserve is not throttled. */
export const CAPACITY_SYNC_THROTTLE_MS = 60_000;

interface CapacityConfigRow {
  hubdb_courses_table: string | null;
  hubdb_courses_event_id_column: string | null;
  hubdb_courses_capacity_column: string | null;
  hubdb_events_table: string | null;
  hubdb_events_event_id_column: string | null;
  hubdb_events_capacity_column: string | null;
}

export interface HubDbCapacitySource extends HubDbPricingSource {
  capacityColumn: string;
}

/**
 * The tables this tenant takes capacity from, courses first, as pricing does.
 *
 * Deliberately independent of the price mapping: a table is a capacity source when it
 * names a table AND a capacity column, whatever its price columns say. The row lookup is
 * the pricing one (`fetchHubDbPricingRow`), which reads only the table and the event-id
 * column, so a session is found the same way for its price and for its seats.
 */
export async function loadHubDbCapacitySources(
  env: Env,
  portalId: string,
): Promise<HubDbCapacitySource[]> {
  let row: CapacityConfigRow | null = null;
  try {
    row = await env.DB.prepare(
      `SELECT hubdb_courses_table, hubdb_courses_event_id_column, hubdb_courses_capacity_column,
              hubdb_events_table, hubdb_events_event_id_column, hubdb_events_capacity_column
         FROM tenants WHERE portal_id = ?1`,
    )
      .bind(portalId)
      .first<CapacityConfigRow>();
  } catch {
    // A tenants table that predates 0045 (or 0044): capacity stays with the app card.
    return [];
  }
  if (!row) return [];

  const sources: HubDbCapacitySource[] = [];
  const add = (
    kind: HubDbCapacitySource['kind'],
    table: string | null,
    eventIdColumn: string | null,
    capacityColumn: string | null,
  ) => {
    const t = table?.trim();
    const col = capacityColumn?.trim();
    if (!t || !col) return;
    sources.push({
      kind,
      table: t,
      eventIdColumn: eventIdColumn?.trim() || 'worker_event_id',
      columns: {},
      discountColumns: {},
      capacityColumn: col,
    });
  };
  add(
    'courses',
    row.hubdb_courses_table,
    row.hubdb_courses_event_id_column,
    row.hubdb_courses_capacity_column,
  );
  add(
    'events',
    row.hubdb_events_table,
    row.hubdb_events_event_id_column,
    row.hubdb_events_capacity_column,
  );
  return sources;
}

/**
 * A HubDB capacity cell as a whole number of seats, or null when it cannot be trusted.
 * Accepts a number or a numeric string ("30", "30.0"); rejects fractions, blanks and
 * anything below 1.
 */
export function readCapacityCell(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim().replace(/,/g, ''));
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return null;
  return n;
}

export type CapacitySyncOutcome =
  | { status: 'updated'; from: number | null; to: number; ticketTypesMoved: number }
  | { status: 'unchanged'; capacity: number }
  | { status: 'throttled' }
  | { status: 'not_configured' }
  | { status: 'no_token' }
  | { status: 'no_hubdb_row' }
  | { status: 'no_capacity' };

/**
 * Bring `event` (and its ticket types) into line with the HubDB capacity cell.
 *
 * Mutates and returns the SAME objects the caller holds, so the caller's following
 * `syncCapacityFromD1(stub, event, ticketTypes)` hands the DO the new numbers without a
 * second D1 read.
 *
 * Ticket types: a type whose capacity was at or above the OLD event capacity was never
 * capped separately (it simply tracked the event), so it moves with it; otherwise raising
 * the event from 24 to 30 changes nothing, because a 24-seat member ticket still caps the
 * booking. A type deliberately smaller than the event (ten early-bird seats) is left
 * alone. An uncapped event had no old number to compare against, so its types stay put.
 */
export async function syncEventCapacityFromHubDb(
  env: Env,
  portalId: string,
  event: EventRow,
  ticketTypes: TicketTypeRow[],
  opts: { throttle?: boolean; now?: Date } = {},
): Promise<CapacitySyncOutcome> {
  const now = opts.now ?? new Date();

  if (opts.throttle && event.capacity_synced_at) {
    const last = Date.parse(event.capacity_synced_at);
    if (Number.isFinite(last) && now.getTime() - last < CAPACITY_SYNC_THROTTLE_MS) {
      return { status: 'throttled' };
    }
  }

  const sources = await loadHubDbCapacitySources(env, portalId);
  if (sources.length === 0) return { status: 'not_configured' };

  const token = await resolveHubSpotReadToken(env, portalId);
  if (!token) return { status: 'no_token' };

  const hit = await fetchHubDbPricingRow({
    sources,
    token,
    eventId: event.id,
    hubspotEventId: event.hubspot_event_id,
    portalId,
  });

  // Stamp the attempt whatever it found, so a throttled read does not retry a missing
  // row on every render. A failed stamp (0045 not applied yet) is not a failed booking.
  const stamp = now.toISOString();
  try {
    await env.DB.prepare('UPDATE events SET capacity_synced_at = ?1 WHERE id = ?2')
      .bind(stamp, event.id)
      .run();
    event.capacity_synced_at = stamp;
  } catch {
    // Pre-0045 events table.
  }

  if (!hit) return { status: 'no_hubdb_row' };

  const source = hit.source as HubDbCapacitySource;
  const capacity = readCapacityCell(hit.row[source.capacityColumn]);
  if (capacity === null) return { status: 'no_capacity' };

  const wasUnlimited = !!event.capacity_unlimited;
  if (!wasUnlimited && event.capacity === capacity) {
    return { status: 'unchanged', capacity };
  }

  const from = wasUnlimited ? null : event.capacity;
  const oldCapacity = event.capacity;

  // The follow rule runs in D1 rather than over the caller's list: the course-bundle
  // paths hand in a single ticket type, and the rest of the event's types must still
  // move or the DO's cold-start rebuild would disagree with this one.
  const statements = [
    env.DB.prepare(
      `UPDATE events SET capacity = ?1, capacity_unlimited = 0,
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
        WHERE id = ?2 AND portal_id = ?3`,
    ).bind(capacity, event.id, portalId),
  ];
  if (!wasUnlimited) {
    statements.push(
      env.DB.prepare(
        `UPDATE ticket_types SET capacity = ?1
          WHERE event_id = ?2 AND capacity_unlimited = 0 AND capacity >= ?3`,
      ).bind(capacity, event.id, oldCapacity),
    );
  }
  const results = await env.DB.batch(statements);
  const ticketTypesMoved = wasUnlimited ? 0 : (results[1]?.meta?.changes ?? 0);

  event.capacity = capacity;
  event.capacity_unlimited = 0;
  if (!wasUnlimited) {
    for (const tt of ticketTypes) {
      if (!tt.capacity_unlimited && tt.capacity >= oldCapacity) tt.capacity = capacity;
    }
  }

  console.log(
    JSON.stringify({
      level: 'info',
      event: 'capacity_synced_from_hubdb',
      portalId,
      eventId: event.id,
      source: source.kind,
      table: source.table,
      from,
      to: capacity,
      ticketTypesMoved,
    }),
  );

  return { status: 'updated', from, to: capacity, ticketTypesMoved };
}

/**
 * The reserve / availability call site: never throws. A HubDB capacity read is a
 * refinement, and no failure in it may cost a booking or a page render; the D1 capacity
 * the caller already holds stands.
 */
export async function trySyncEventCapacityFromHubDb(
  env: Env,
  portalId: string,
  event: EventRow,
  ticketTypes: TicketTypeRow[],
  opts: { throttle?: boolean } = {},
): Promise<CapacitySyncOutcome | null> {
  try {
    return await syncEventCapacityFromHubDb(env, portalId, event, ticketTypes, opts);
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'warn',
        event: 'capacity_sync_failed',
        portalId,
        eventId: event.id,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}

/** True when this sync LOWERED the event's capacity (an uncapped event now has a cap). */
export function isCapacityDecrease(outcome: CapacitySyncOutcome | null): boolean {
  return outcome?.status === 'updated' && (outcome.from === null || outcome.to < outcome.from);
}

/**
 * The seat-holding call site in one line: read HubDB, then hand D1's numbers to the DO.
 *
 * Returns false ONLY when capacity was just lowered and the DO did not acknowledge it, in
 * which case the caller must refuse the hold: the DO may still be selling to its old,
 * higher limit (PR review, events-engine#69). Every other case is the pre-0045 best-effort
 * sync and returns true, so a raise, an unchanged number or an unreadable HubDB cannot
 * cost a booking.
 */
export async function syncCapacityBeforeHold(
  env: Env,
  portalId: string,
  doStub: DurableObjectStub,
  event: EventRow,
  ticketTypes: TicketTypeRow[],
): Promise<boolean> {
  const outcome = await trySyncEventCapacityFromHubDb(env, portalId, event, ticketTypes);
  if (!isCapacityDecrease(outcome)) {
    await syncCapacityFromD1(doStub, event, ticketTypes);
    return true;
  }
  const acknowledged = await syncCapacityFromD1Strict(doStub, event, ticketTypes);
  if (!acknowledged) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'capacity_decrease_unacknowledged',
        portalId,
        eventId: event.id,
        message:
          'HubDB lowered capacity and the EventCapacity DO did not confirm it; hold refused.',
      }),
    );
  }
  return acknowledged;
}
