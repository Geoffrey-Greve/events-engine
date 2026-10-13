import { effectiveCapacity, loadEventByHubspotId, loadTicketTypes } from '../db';
import type { Env } from '../types';

/**
 * Atomic seat-math gate. ONE instance per event, keyed by `${portalId}:${externalEventId}`.
 *
 * This is the single source of truth for "is there a seat?". The DO is single-threaded
 * per event — that, plus the input/output gating around storage, is the concurrency
 * guarantee that lets us NEVER oversell (see CLAUDE.md) without locks or D1 CAS.
 *
 * Lifecycle of a seat:
 *   reserve  → TTL hold (held, not committed)        — a hold never commits a seat
 *   confirm  → held → confirmed (commit on payment)  — the ONLY place seats commit
 *   release  → drop a hold (checkout abandoned)
 *   refund   → confirmed -= order seats (floor at 0)
 *   cancel-seats → give back PART of a booking (one attendee out of a group), shrinking
 *                  whichever of the two the seats currently sit in
 *
 * Capacity is enforced at BOTH levels, atomically, in `reserve`:
 *   - event-level  : eventCapacity (null = uncapped)
 *   - per-ticket-type: perType[t].inventory (null = uncapped)
 */

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15-minute reservation hold (CLAUDE.md)

interface HoldItem {
  ticketTypeId: string;
  quantity: number;
}

interface Hold {
  holdId: string;
  expiresAt: number; // epoch ms
  items: HoldItem[];
}

interface PerType {
  inventory: number | null; // null = uncapped for this type
  confirmed: number;
}

/** Queue message emitted when a hold lapses, so D1 can mark the reservation expired. */
interface ExpireHoldJob {
  kind: 'expire_hold';
  idName: string | null;
  holdId: string;
}

export class EventCapacity implements DurableObject {
  private eventCapacity: number | null = null; // null = uncapped
  private perType = new Map<string, PerType>();
  private holds: Hold[] = [];
  /** Committed holds kept for confirm-idempotency and refund-by-hold. */
  private confirmedHolds = new Map<string, HoldItem[]>();
  private idName: string | null = null;
  private initialized = false;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    // Load (or rehydrate) all state BEFORE any request is served. blockConcurrencyWhile
    // delays delivery of fetch()/alarm() until this resolves, so handlers always see a
    // consistent in-memory model.
    this.state.blockConcurrencyWhile(async () => {
      await this.load();
    });
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private async load(): Promise<void> {
    const stored = await this.state.storage.get<unknown>([
      'initialized',
      'eventCapacity',
      'perType',
      'holds',
      'confirmedHolds',
      'idName',
    ]);

    this.idName = (stored.get('idName') as string | null) ?? this.state.id.name ?? null;

    if (stored.get('initialized')) {
      this.eventCapacity = (stored.get('eventCapacity') as number | null) ?? null;
      this.perType = new Map(
        Object.entries((stored.get('perType') as Record<string, PerType>) ?? {}),
      );
      this.holds = (stored.get('holds') as Hold[]) ?? [];
      this.confirmedHolds = new Map(
        Object.entries((stored.get('confirmedHolds') as Record<string, HoldItem[]>) ?? {}),
      );
      this.initialized = true;
      return;
    }

    // Cold start, empty storage: rehydrate from D1 (the durable record). Best-effort —
    // if the event isn't in D1 yet (or D1 is unreachable), stay lazily uninitialized and
    // wait for /init or /sync to seed us. Construction must never throw.
    if (this.idName) {
      try {
        await this.rehydrateFromD1(this.idName);
      } catch {
        // swallow: lazy init path
      }
    }
  }

  private async persist(): Promise<void> {
    await this.state.storage.put({
      initialized: this.initialized,
      eventCapacity: this.eventCapacity,
      perType: Object.fromEntries(this.perType),
      holds: this.holds,
      confirmedHolds: Object.fromEntries(this.confirmedHolds),
      idName: this.idName,
    });
  }

  private resetSeatState(): void {
    this.eventCapacity = null;
    this.perType = new Map();
    this.holds = [];
    this.confirmedHolds = new Map();
    this.initialized = false;
  }

  /**
   * Rebuild seat state from D1:
   *   confirmed    = paid/confirmed registrations (grouped by ticket type)
   *   active holds = pending reservations not yet expired
   *
   * Both exclude seats cancelled per-registration (Phase 3.2). Skipping that would make a
   * cold start or an admin rebuild silently RE-TAKE every seat that has ever been cancelled
   * out of a booking whose other seats are still live — the order is still 'paid' and its
   * reservation_items still say four, because three colleagues are still coming.
   */
  private async rehydrateFromD1(idName: string, reset = false): Promise<boolean> {
    const sep = idName.indexOf(':');
    if (sep < 0) return false;
    const portalId = idName.slice(0, sep);
    const externalEventId = idName.slice(sep + 1);

    const event = await loadEventByHubspotId(this.env.DB, portalId, externalEventId);
    if (!event) return false; // not in D1 yet — nothing to rehydrate

    if (reset) this.resetSeatState();
    this.idName = idName;

    // capacity_unlimited = 1 maps to null (uncapped). Reading the flag rather than
    // treating 0 as "uncapped" is what makes a zero capacity a hard stop.
    this.eventCapacity = effectiveCapacity(event);

    for (const tt of await loadTicketTypes(this.env.DB, event.id)) {
      this.perType.set(tt.id, { inventory: effectiveCapacity(tt), confirmed: 0 });
    }

    // confirmed = paid registrations and free/manual confirmed registrations
    const confirmedRows = await this.env.DB.prepare(
      `SELECT r.ticket_type_id AS ticket_type_id, COUNT(*) AS c
         FROM registrations r
         JOIN orders o ON o.id = r.order_id
        WHERE r.event_id = ?1 AND o.status IN ('paid', 'confirmed')
          AND r.cancelled_at IS NULL
        GROUP BY r.ticket_type_id`,
    )
      .bind(event.id)
      .all<{ ticket_type_id: string; c: number }>();
    for (const row of confirmedRows.results) {
      const pt = this.perType.get(row.ticket_type_id) ?? { inventory: null, confirmed: 0 };
      pt.confirmed = row.c;
      this.perType.set(row.ticket_type_id, pt);
    }

    // active holds = pending, unexpired reservations
    const nowIso = new Date().toISOString();
    const resvRows = await this.env.DB.prepare(
      `SELECT id, expires_at FROM reservations
        WHERE event_id = ?1 AND status = 'pending' AND expires_at > ?2`,
    )
      .bind(event.id, nowIso)
      .all<{ id: string; expires_at: string }>();
    for (const r of resvRows.results) {
      const items = await this.env.DB.prepare(
        `SELECT ticket_type_id, quantity FROM reservation_items
          WHERE reservation_id = ?1 AND portal_id = ?2`,
      )
        .bind(r.id, portalId)
        .all<{ ticket_type_id: string; quantity: number }>();
      // reservation_items is the PRICED record of what was booked and is never rewritten —
      // it is what the invoice was built from. The seats a cancellation gave back are
      // therefore subtracted here rather than there, so the money record stays intact and
      // the seat record is still right.
      const cancelled = await this.env.DB.prepare(
        `SELECT r.ticket_type_id AS ticket_type_id, COUNT(*) AS c
           FROM registrations r
           JOIN orders o ON o.id = r.order_id
          WHERE o.reservation_id = ?1 AND r.portal_id = ?2 AND r.cancelled_at IS NOT NULL
          GROUP BY r.ticket_type_id`,
      )
        .bind(r.id, portalId)
        .all<{ ticket_type_id: string; c: number }>();

      const held = subtractItems(
        items.results.map((i) => ({ ticketTypeId: i.ticket_type_id, quantity: i.quantity })),
        cancelled.results.map((i) => ({ ticketTypeId: i.ticket_type_id, quantity: i.c })),
      );
      if (held.length === 0) continue; // every seat on this hold was cancelled

      this.holds.push({
        holdId: r.id,
        expiresAt: Date.parse(r.expires_at),
        items: held,
      });
    }

    this.initialized = true;
    await this.persist();
    await this.rearmAlarm();
    return true;
  }

  // ---------------------------------------------------------------------------
  // Seat math helpers
  // ---------------------------------------------------------------------------

  private heldByType(ticketTypeId: string): number {
    let n = 0;
    for (const h of this.holds) {
      for (const it of h.items) if (it.ticketTypeId === ticketTypeId) n += it.quantity;
    }
    return n;
  }

  private totalHeld(): number {
    let n = 0;
    for (const h of this.holds) for (const it of h.items) n += it.quantity;
    return n;
  }

  private totalConfirmed(): number {
    let n = 0;
    for (const pt of this.perType.values()) n += pt.confirmed;
    return n;
  }

  /**
   * Drop every hold whose TTL has lapsed, emit one expire_hold job per reaped hold so
   * D1 can reconcile, and return the reaped holds. Whoever reaps a hold first owns its
   * event — alarm and reserve share this path, so a hold is never double-emitted.
   */
  private async reapExpired(now = Date.now()): Promise<Hold[]> {
    if (this.holds.length === 0) return [];
    const expired: Hold[] = [];
    const live: Hold[] = [];
    for (const h of this.holds) (h.expiresAt <= now ? expired : live).push(h);
    if (expired.length === 0) return [];

    this.holds = live;
    await this.emitExpireJobs(expired.map((h) => h.holdId));
    return expired;
  }

  private async emitExpireJobs(holdIds: string[]): Promise<void> {
    if (holdIds.length === 0) return;
    const jobs: { body: ExpireHoldJob }[] = holdIds.map((holdId) => ({
      body: { kind: 'expire_hold', idName: this.idName, holdId },
    }));
    try {
      await this.env.QUEUE.sendBatch(jobs);
    } catch {
      // Queue not bound / unavailable (e.g. tests): seats are already freed in-DO; the
      // reconciliation cron will catch the orphaned D1 reservation.
    }
  }

  private async rearmAlarm(): Promise<void> {
    if (this.holds.length === 0) {
      await this.state.storage.deleteAlarm();
      return;
    }
    let earliest = Infinity;
    for (const h of this.holds) if (h.expiresAt < earliest) earliest = h.expiresAt;
    await this.state.storage.setAlarm(earliest);
  }

  private perTypeView(): Record<
    string,
    { inventory: number | null; confirmed: number; held: number; available: number | null }
  > {
    const out: Record<
      string,
      { inventory: number | null; confirmed: number; held: number; available: number | null }
    > = {};
    const ids = new Set<string>(this.perType.keys());
    for (const h of this.holds) for (const it of h.items) ids.add(it.ticketTypeId);
    for (const id of ids) {
      const pt = this.perType.get(id) ?? { inventory: null, confirmed: 0 };
      const held = this.heldByType(id);
      out[id] = {
        inventory: pt.inventory,
        confirmed: pt.confirmed,
        held,
        available: pt.inventory === null ? null : pt.inventory - pt.confirmed - held,
      };
    }
    return out;
  }

  private snapshot() {
    const confirmed = this.totalConfirmed();
    const held = this.totalHeld();
    return {
      eventCapacity: this.eventCapacity,
      confirmed,
      held,
      available: this.eventCapacity === null ? null : this.eventCapacity - confirmed - held,
      holds: this.holds.length,
      perType: this.perTypeView(),
    };
  }

  // ---------------------------------------------------------------------------
  // Request routing
  // ---------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    let body: Record<string, unknown> = {};
    if (request.method === 'POST') {
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        body = {};
      }
    }

    switch (pathname) {
      case '/reserve':
        return this.reserve(body);
      case '/confirm':
        return this.confirm(body);
      case '/release':
        return this.release(body);
      case '/cancel-seats':
        return this.cancelSeats(body);
      case '/refund':
        return this.refund(body);
      case '/availability':
        return this.availability();
      case '/sync':
        return this.sync(body);
      case '/init':
        return this.init(body);
      case '/rebuild':
        return this.rebuild(body);
      default:
        return json({ ok: false, error: 'not_found' }, 404);
    }
  }

  async alarm(): Promise<void> {
    const reaped = await this.reapExpired();
    if (reaped.length > 0) await this.persist();
    await this.rearmAlarm();
  }

  // ---------------------------------------------------------------------------
  // Methods
  // ---------------------------------------------------------------------------

  /**
   * Atomic seat grant. GC expired holds, then check per-type AND event-level
   * availability together; on success push a hold and arm the alarm at the earliest
   * expiry. Returns {holdId, expiresAt} or {full, shortfall}.
   */
  private async reserve(body: Record<string, unknown>): Promise<Response> {
    const items = parseItems(body.items);
    if (!items) return json({ ok: false, error: 'invalid_items' }, 400);

    const holdId = typeof body.holdId === 'string' ? body.holdId : crypto.randomUUID();
    const ttlMs = typeof body.ttlMs === 'number' && body.ttlMs > 0 ? body.ttlMs : DEFAULT_TTL_MS;
    const requestedExpiry = typeof body.expiresAt === 'string' ? Date.parse(body.expiresAt) : null;
    if (
      requestedExpiry !== null &&
      (!Number.isFinite(requestedExpiry) || requestedExpiry <= Date.now())
    ) {
      return json({ ok: false, error: 'invalid_expiry' }, 400);
    }

    // Idempotency: same hold already live or already committed.
    const existing = this.holds.find((h) => h.holdId === holdId);
    if (existing) {
      return json({
        ok: true,
        holdId,
        expiresAt: new Date(existing.expiresAt).toISOString(),
        idempotent: true,
      });
    }
    if (this.confirmedHolds.has(holdId)) {
      return json({ ok: false, error: 'already_confirmed', holdId }, 409);
    }

    await this.reapExpired();

    // Check both levels atomically. Nothing mutates until every constraint passes.
    const byType: Record<string, number> = {};
    let eventShortfall = 0;

    // Aggregate quantities by ticket type FIRST, so a request that lists the same
    // ticketTypeId on multiple lines is gated on its combined quantity. Checking each
    // line independently against the same untouched availability would let duplicate
    // lines each pass and oversell that type (no held quantity is added until below).
    const requestedByType: Record<string, number> = {};
    let requestedTotal = 0;
    for (const it of items) {
      requestedByType[it.ticketTypeId] = (requestedByType[it.ticketTypeId] ?? 0) + it.quantity;
      requestedTotal += it.quantity;
    }

    if (this.eventCapacity !== null) {
      const avail = this.eventCapacity - this.totalConfirmed() - this.totalHeld();
      if (requestedTotal > avail) eventShortfall = requestedTotal - avail;
    }

    for (const [ticketTypeId, qty] of Object.entries(requestedByType)) {
      const pt = this.perType.get(ticketTypeId);
      if (pt && pt.inventory !== null) {
        const avail = pt.inventory - pt.confirmed - this.heldByType(ticketTypeId);
        if (qty > avail) byType[ticketTypeId] = qty - avail;
      }
    }

    const shortfallSeats = Math.max(eventShortfall, ...Object.values(byType), 0);
    if (shortfallSeats > 0) {
      return json(
        {
          ok: false,
          full: true,
          shortfall: { seats: shortfallSeats, event: eventShortfall, byType },
        },
        409,
      );
    }

    const expiresAt = requestedExpiry ?? Date.now() + ttlMs;
    this.holds.push({ holdId, expiresAt, items });
    await this.persist();
    await this.rearmAlarm();

    return json({ ok: true, holdId, expiresAt: new Date(expiresAt).toISOString() });
  }

  /**
   * Commit a hold's seats on payment. Idempotent. If the hold lapsed AND committing
   * would now oversell, refuse with {confirmed:false, reason:"expired_and_oversold"}
   * unless `force` (per-event allow_oversell honour path).
   */
  private async confirm(body: Record<string, unknown>): Promise<Response> {
    const holdId = typeof body.holdId === 'string' ? body.holdId : null;
    if (!holdId) return json({ ok: false, error: 'missing_holdId' }, 400);
    const force = body.force === true;
    const orderItems = body.orderItems === undefined ? null : parseItems(body.orderItems);
    if (body.orderItems !== undefined && orderItems === null) {
      return json({ ok: false, error: 'invalid_orderItems' }, 400);
    }

    const now = Date.now();
    const idx = this.holds.findIndex((h) => h.holdId === holdId);
    let hold: Hold | null = null;
    let holdItems: HoldItem[] | null = null;
    let expired = false;

    if (idx >= 0) {
      hold = this.holds[idx];
      holdItems = hold.items;
      expired = hold.expiresAt <= now;
      this.holds.splice(idx, 1); // consume the hold either way
    } else if (this.confirmedHolds.has(holdId)) {
      // Already committed — idempotent replay.
      return json({ ok: true, confirmed: true, holdId, idempotent: true });
    } else {
      // Hold is gone (GC'd / never existed): treat as the expired path.
      expired = true;
    }

    if (!expired && hold && holdItems) {
      // Live hold: seats were already counted within capacity at reserve time, so we
      // commit exactly what was held — never the caller-supplied orderItems. Trusting
      // orderItems here would let a mismatched payload (e.g. a 1-seat hold confirmed
      // with orderItems for 2) commit seats that were never reserved, breaking the
      // no-oversell invariant. If orderItems are supplied they must match the hold.
      if (orderItems && !itemsEqual(orderItems, holdItems)) {
        this.holds.push(hold); // not a clean confirm — leave the hold live to retry
        return json({ ok: false, error: 'orderItems_mismatch', holdId }, 409);
      }
      this.commit(holdId, holdItems);
      await this.persist();
      await this.rearmAlarm();
      return json({ ok: true, confirmed: true, holdId });
    }

    const items = orderItems ?? holdItems;
    if (!items) {
      // Nothing to commit and no record of the hold — caller must supply orderItems.
      return json({ ok: false, error: 'unknown_hold', holdId }, 409);
    }

    // Expired path: the seat may have been taken. Check committed-vs-capacity.
    const { oversold, shortfall } = this.checkOversell(items);
    if (oversold && !force) {
      await this.persist(); // we may have reaped the expired hold above
      await this.rearmAlarm();
      return json({
        ok: false,
        confirmed: false,
        reason: 'expired_and_oversold',
        holdId,
        shortfall,
      });
    }

    this.commit(holdId, items);
    await this.persist();
    await this.rearmAlarm();
    return json({
      ok: true,
      confirmed: true,
      holdId,
      expired: true,
      forced: oversold ? true : undefined,
    });
  }

  private commit(holdId: string, items: HoldItem[]): void {
    for (const it of items) {
      const pt = this.perType.get(it.ticketTypeId) ?? { inventory: null, confirmed: 0 };
      pt.confirmed += it.quantity;
      this.perType.set(it.ticketTypeId, pt);
    }
    this.confirmedHolds.set(holdId, items);
  }

  /** Would committing `items` push confirmed seats past a cap? (Holds don't count here.) */
  private checkOversell(items: HoldItem[]): {
    oversold: boolean;
    shortfall: { seats: number; event: number; byType: Record<string, number> };
  } {
    const byType: Record<string, number> = {};
    let eventShortfall = 0;

    let requestedTotal = 0;
    for (const it of items) requestedTotal += it.quantity;
    if (this.eventCapacity !== null) {
      const over = this.totalConfirmed() + requestedTotal - this.eventCapacity;
      if (over > 0) eventShortfall = over;
    }
    for (const it of items) {
      const pt = this.perType.get(it.ticketTypeId);
      if (pt && pt.inventory !== null) {
        const over = pt.confirmed + it.quantity - pt.inventory;
        if (over > 0) byType[it.ticketTypeId] = over;
      }
    }
    const seats = Math.max(eventShortfall, ...Object.values(byType), 0);
    return { oversold: seats > 0, shortfall: { seats, event: eventShortfall, byType } };
  }

  /** Drop a hold without committing (checkout abandoned). */
  private async release(body: Record<string, unknown>): Promise<Response> {
    const holdId = typeof body.holdId === 'string' ? body.holdId : null;
    if (!holdId) return json({ ok: false, error: 'missing_holdId' }, 400);

    const idx = this.holds.findIndex((h) => h.holdId === holdId);
    if (idx < 0) return json({ ok: true, released: false, holdId });

    this.holds.splice(idx, 1);
    await this.persist();
    await this.rearmAlarm();
    return json({ ok: true, released: true, holdId });
  }

  /**
   * Give back SOME of a booking's seats — one attendee cancelling out of a group booking
   * (Phase 3.2). The seat math is here for the same reason every other seat change is:
   * D1 never decrements a capacity counter, so "release the seat" has to be an operation
   * on this object, not an UPDATE somewhere else.
   *
   * Which counter moves depends on where the seat currently lives, and the caller does not
   * have to know:
   *   - a LIVE hold (the booking is awaiting payment, possibly for weeks on an invoice due
   *     date) — the seats were never committed, so the hold SHRINKS. `release` cannot do
   *     this: it drops the whole hold, which would free the colleagues still coming.
   *   - a COMMITTED booking — `confirmed` comes down, and the recorded commit is shrunk in
   *     step so a later whole-order `/refund` for the same holdId cannot subtract this seat
   *     a second time.
   *   - neither (a cold DO, a `needs_review` order whose seats were never committed) — the
   *     confirmed decrement floors at 0 and the call is a no-op, which is the correct
   *     answer rather than an error: there is no seat here to give back.
   */
  private async cancelSeats(body: Record<string, unknown>): Promise<Response> {
    const items = parseItems(body.items ?? body.orderItems);
    if (!items) return json({ ok: false, error: 'invalid_items' }, 400);
    const holdId = typeof body.holdId === 'string' ? body.holdId : null;

    const idx = holdId ? this.holds.findIndex((h) => h.holdId === holdId) : -1;
    if (idx >= 0) {
      const hold = this.holds[idx];
      const remaining = subtractItems(hold.items, items);
      if (totalQuantity(remaining) === 0) this.holds.splice(idx, 1);
      else hold.items = remaining;
      await this.persist();
      await this.rearmAlarm();
      return json({ ok: true, released: 'hold', holdId, remaining, ...this.snapshot() });
    }

    if (holdId) {
      const committed = this.confirmedHolds.get(holdId);
      if (committed) {
        const remaining = subtractItems(committed, items);
        if (totalQuantity(remaining) === 0) this.confirmedHolds.delete(holdId);
        else this.confirmedHolds.set(holdId, remaining);
      }
    }
    for (const it of items) {
      const pt = this.perType.get(it.ticketTypeId);
      if (pt) pt.confirmed = Math.max(0, pt.confirmed - it.quantity);
    }
    await this.persist();
    return json({ ok: true, released: 'confirmed', holdId, items, ...this.snapshot() });
  }

  /** Subtract an order's seats from confirmed, floored at 0. */
  private async refund(body: Record<string, unknown>): Promise<Response> {
    const holdId = typeof body.holdId === 'string' ? body.holdId : null;
    let items: HoldItem[] | null = null;

    if (holdId) {
      const stored = this.confirmedHolds.get(holdId);
      if (stored) {
        items = stored;
        this.confirmedHolds.delete(holdId);
      }
    }
    if (!items && (body.orderItems !== undefined || body.items !== undefined)) {
      items = parseItems(body.orderItems ?? body.items);
    }
    if (!items) return json({ ok: false, error: 'nothing_to_refund', holdId }, 400);

    for (const it of items) {
      const pt = this.perType.get(it.ticketTypeId);
      if (pt) pt.confirmed = Math.max(0, pt.confirmed - it.quantity);
    }
    await this.persist();
    return json({ ok: true, refunded: true, holdId, items });
  }

  private async availability(): Promise<Response> {
    const reaped = await this.reapExpired();
    if (reaped.length > 0) {
      await this.persist();
      await this.rearmAlarm();
    }
    return json({ ok: true, ...this.snapshot() });
  }

  /** Admin capacity / per-type inventory edits. Does not touch confirmed or holds. */
  private async sync(body: Record<string, unknown>): Promise<Response> {
    if ('eventCapacity' in body) {
      const cap = body.eventCapacity;
      this.eventCapacity = cap === null ? null : Number(cap);
    }
    if (body.perType && typeof body.perType === 'object') {
      for (const [id, raw] of Object.entries(body.perType as Record<string, unknown>)) {
        const edit = raw as { inventory?: number | null };
        const pt = this.perType.get(id) ?? { inventory: null, confirmed: 0 };
        if (edit && 'inventory' in edit) {
          pt.inventory = edit.inventory === null ? null : Number(edit.inventory);
        }
        this.perType.set(id, pt);
      }
    }
    this.initialized = true;
    await this.persist();
    return json({ ok: true, ...this.snapshot() });
  }

  /**
   * Store our idName (`${portalId}:${externalEventId}`) so a future cold start can
   * rehydrate from D1, and trigger a first rehydrate if we're still uninitialized.
   */
  private async init(body: Record<string, unknown>): Promise<Response> {
    if (typeof body.idName === 'string') this.idName = body.idName;
    else if (!this.idName) this.idName = this.state.id.name ?? null;

    let rehydrated = false;
    if (!this.initialized && this.idName) {
      try {
        rehydrated = await this.rehydrateFromD1(this.idName);
      } catch {
        // best-effort
      }
    }
    this.initialized = true;
    await this.persist();
    return json({ ok: true, idName: this.idName, rehydrated });
  }

  /**
   * Admin maintenance hook: discard stale in-memory/persisted seat counters and rebuild
   * from D1, which is the durable record after data cleanup or migration.
   */
  private async rebuild(body: Record<string, unknown>): Promise<Response> {
    if (typeof body.idName === 'string') this.idName = body.idName;
    else if (!this.idName) this.idName = this.state.id.name ?? null;

    if (!this.idName) return json({ ok: false, error: 'missing_idName' }, 400);

    const rebuilt = await this.rehydrateFromD1(this.idName, true);
    if (!rebuilt) {
      return json({ ok: false, error: 'event_not_found', idName: this.idName }, 404);
    }

    return json({ ok: true, rebuilt: true, idName: this.idName, ...this.snapshot() });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Compare two seat-item lists as ticketTypeId→quantity multisets (line order ignored). */
function itemsEqual(a: HoldItem[], b: HoldItem[]): boolean {
  const sum = (items: HoldItem[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const it of items) m.set(it.ticketTypeId, (m.get(it.ticketTypeId) ?? 0) + it.quantity);
    return m;
  };
  const ma = sum(a);
  const mb = sum(b);
  if (ma.size !== mb.size) return false;
  for (const [k, v] of ma) if (mb.get(k) !== v) return false;
  return true;
}

/** Total seats across a list of items. */
function totalQuantity(items: HoldItem[]): number {
  let n = 0;
  for (const it of items) n += it.quantity;
  return n;
}

/**
 * `a` minus `b`, per ticket type, floored at 0 and dropping emptied lines.
 *
 * Flooring rather than throwing is deliberate: the caller is reconciling D1's view of a
 * booking with this object's, and the two can legitimately disagree after a rebuild. Giving
 * back more seats than are recorded must leave zero, never a negative that would later read
 * as free inventory and oversell the event.
 */
function subtractItems(a: HoldItem[], b: HoldItem[]): HoldItem[] {
  const remaining = new Map<string, number>();
  for (const it of a)
    remaining.set(it.ticketTypeId, (remaining.get(it.ticketTypeId) ?? 0) + it.quantity);
  for (const it of b) {
    const current = remaining.get(it.ticketTypeId);
    if (current === undefined) continue;
    remaining.set(it.ticketTypeId, Math.max(0, current - it.quantity));
  }
  const out: HoldItem[] = [];
  for (const [ticketTypeId, quantity] of remaining) {
    if (quantity > 0) out.push({ ticketTypeId, quantity });
  }
  return out;
}

/** Validate a seat-items array: non-empty, positive integer quantities. */
function parseItems(raw: unknown): HoldItem[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const items: HoldItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null;
    const { ticketTypeId, quantity } = entry as Record<string, unknown>;
    if (typeof ticketTypeId !== 'string' || ticketTypeId === '') return null;
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity <= 0) return null;
    items.push({ ticketTypeId, quantity });
  }
  return items;
}
