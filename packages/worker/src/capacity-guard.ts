/**
 * Capacity guards (Phase 1.1).
 *
 * Two halves, both aimed at the same failure: a placeholder capacity entered during
 * setup and never replaced.
 *
 *   parseCapacity        — write-path validation. An event or ticket type cannot go live
 *                          with a capacity of 0, null or absent; uncapped has to be said
 *                          out loud via capacityUnlimited.
 *   maybeFlagFastSellout — read-back detection. If an event sells out within 30 minutes
 *                          of first publish, that is far more likely to be a placeholder
 *                          capacity than genuine demand, so a human is asked before the
 *                          listing quietly closes.
 */

import type { EventRow } from './db';
import { createFastSelloutDecision } from './decisions';
import type { Env } from './types';

/** A sell-out inside this window of first publish is treated as suspicious, not success. */
export const FAST_SELLOUT_WINDOW_MS = 30 * 60 * 1000;

export interface CapacityFields {
  /** Seats. Ignored (and stored as 0) when `unlimited`. */
  capacity: number;
  unlimited: boolean;
}

export type CapacityResult =
  | ({ ok: true } & CapacityFields)
  | { ok: false; status: string; message: string };

/**
 * Validate the capacity a write would leave behind.
 *
 * Callers pass the RESULTING state, not the patch: on PATCH that means the request's
 * values merged over the stored row, so clearing `capacityUnlimited` without supplying a
 * real capacity is rejected the same way creating one would be.
 */
export function parseCapacity(
  capacity: unknown,
  unlimited: unknown,
  label: 'event' | 'ticket type' = 'event',
): CapacityResult {
  if (unlimited === true || unlimited === 1) {
    // Uncapped is explicit, so the stored number is meaningless — normalize it to 0
    // rather than carrying a stale seat count that a later un-flagging would resurrect.
    return { ok: true, capacity: 0, unlimited: true };
  }

  const seats = typeof capacity === 'number' ? capacity : Number(capacity);
  if (
    capacity === null ||
    capacity === undefined ||
    capacity === '' ||
    !Number.isInteger(seats) ||
    seats < 1
  ) {
    return {
      ok: false,
      status: 'invalid_capacity',
      message: `A ${label} needs a capacity of at least 1 seat. Set capacityUnlimited to true if it genuinely has no seat limit.`,
    };
  }
  return { ok: true, capacity: seats, unlimited: false };
}

interface AvailabilitySnapshot {
  available: number | null;
  perType?: Record<string, { inventory: number | null; available: number | null }>;
}

/** Sold out = nothing left to sell, at the event level or across every capped type. */
function isSoldOut(snapshot: AvailabilitySnapshot): boolean {
  if (snapshot.available !== null && snapshot.available <= 0) return true;

  const types = Object.values(snapshot.perType ?? {});
  if (types.length === 0) return false;
  // An uncapped type can always take another booking, so one is enough to stay open.
  return types.every((t) => t.inventory !== null && (t.available ?? 0) <= 0);
}

/**
 * Raise a `fast_sellout` decision if this event has just sold out within
 * FAST_SELLOUT_WINDOW_MS of first publish.
 *
 * Called on the booking hot path, so the cheap checks come first: outside the window —
 * which is every event after its first half hour — this costs one date comparison and
 * touches neither D1 nor the DO. Never throws: a booking must not fail because we could
 * not raise an advisory flag.
 */
export async function maybeFlagFastSellout(
  env: Env,
  portalId: string,
  event: EventRow,
): Promise<boolean> {
  try {
    // An explicitly uncapped event cannot sell out, so there is nothing to second-guess.
    if (event.capacity_unlimited) return false;

    const publishedAt = event.first_published_at ?? event.created_at;
    const publishedMs = publishedAt ? Date.parse(publishedAt) : Number.NaN;
    if (!Number.isFinite(publishedMs)) return false;
    if (Date.now() - publishedMs > FAST_SELLOUT_WINDOW_MS) return false;

    // Raised at most once per event (see the partial unique index in 0020) — skip the DO
    // round trip once the owner has already been told.
    const existing = await env.DB.prepare(
      `SELECT id FROM pending_decisions
        WHERE portal_id = ?1 AND event_id = ?2 AND type = 'fast_sellout'`,
    )
      .bind(portalId, event.id)
      .first<{ id: string }>();
    if (existing) return false;

    const stub = env.EVENT_CAPACITY.get(
      env.EVENT_CAPACITY.idFromName(`${portalId}:${event.hubspot_event_id}`),
    );
    const resp = await stub.fetch('https://do/availability', { method: 'POST' });
    const snapshot = (await resp.json()) as AvailabilitySnapshot;
    if (!snapshot || !isSoldOut(snapshot)) return false;

    await createFastSelloutDecision(env, {
      portalId,
      event,
      context: {
        capacity: event.capacity,
        firstPublishedAt: publishedAt,
        soldOutAt: new Date().toISOString(),
        minutesToSellOut: Math.round((Date.now() - publishedMs) / 60000),
        available: snapshot.available,
        perType: snapshot.perType ?? {},
      },
    });
    return true;
  } catch (error) {
    // Includes the unique-index collision when two bookings race to raise the same
    // decision: the loser has nothing left to do.
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'fast_sellout_flag_failed',
        portalId,
        eventId: event.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return false;
  }
}
