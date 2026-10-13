/**
 * Waitlist: join + next-in-line promotion.
 *
 * When capacity is full, a buyer JOINS the waitlist — one row per buyer; a group waits as
 * a single entry carrying its `quantity`. Positions are tracked per (event, ticket type).
 *
 * When seats free up — a hold lapses (expireHold) or an order is refunded (handleRefund) —
 * we PROMOTE: expire any stale offers, read the live seat availability from the
 * EventCapacity DO, then walk each queue in position order and offer freed seats to the
 * next-in-line whose quantity fits (CLAUDE.md: offers go next-in-line, NOT notify-all;
 * 30-minute offer TTL).
 *
 * An offer carries a signed, self-describing token. The holder hands it back at /reserve;
 * `claimWaitlistOffer` re-checks the signature and the offer window before a hold is
 * granted, then the entry is marked `promoted`. The DO re-validates the seat math at
 * confirm, so even two claimants racing for the same freed seat can never oversell — the
 * loser's confirm fails `expired_and_oversold` (see do/EventCapacity.ts).
 */

import type { EventRow } from './db';
import type { Env } from './types';

/** 30-minute waitlist offer TTL (CLAUDE.md). */
const OFFER_TTL_MS = 30 * 60 * 1000;

type EventRef = Pick<EventRow, 'id' | 'hubspot_event_id'>;

// ---------------------------------------------------------------------------
// Signed offer tokens
//
// Stateless capability over `${waitlistId}.${expiresAtMs}`, HMAC-SHA256 signed. Validity
// is re-derived from the waitlist row at claim time (status must be 'offered' and the
// stored offer_expires_at must equal the token's expiry), so a token from a superseded
// offer round can't be replayed once the row is re-offered with a new expiry. Signing key
// is HUBSPOT_WEBHOOK_SECRET, as for ticket QR codes — add a dedicated secret if/when
// operational separation is required (see payment.ts).
// ---------------------------------------------------------------------------

function base64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const raw = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return base64url(raw);
}

export async function signOffer(
  secret: string,
  waitlistId: string,
  expiresAtMs: number,
): Promise<string> {
  const body = `${waitlistId}.${expiresAtMs}`;
  return `${body}.${await hmac(secret, body)}`;
}

export async function verifyWaitlistOffer(
  secret: string,
  token: string,
): Promise<{ waitlistId: string; expiresAtMs: number } | null> {
  if (typeof token !== 'string' || token.length === 0) return null;
  // Split signature off the end, then the expiry, so a waitlistId is parsed verbatim.
  const sigDot = token.lastIndexOf('.');
  if (sigDot <= 0) return null;
  const body = token.slice(0, sigDot);
  const sig = token.slice(sigDot + 1);

  const expDot = body.lastIndexOf('.');
  if (expDot <= 0) return null;
  const waitlistId = body.slice(0, expDot);
  const expStr = body.slice(expDot + 1);
  const expiresAtMs = Number(expStr);
  if (!Number.isFinite(expiresAtMs) || !/^\d+$/.test(expStr)) return null;

  const expected = await hmac(secret, body);
  if (!timingSafeEqual(sig, expected)) return null;
  return { waitlistId, expiresAtMs };
}

/** Length-and-content compare that doesn't short-circuit on the first differing byte. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// DO availability read
// ---------------------------------------------------------------------------

interface Availability {
  available: number | null;
  perType: Record<string, { available: number | null }>;
}

async function doAvailability(env: Env, doIdName: string): Promise<Availability | null> {
  const stub = env.EVENT_CAPACITY.get(env.EVENT_CAPACITY.idFromName(doIdName));
  const resp = await stub.fetch('https://do/availability', { method: 'POST' });
  const data = (await resp.json()) as {
    ok?: boolean;
    available?: number | null;
    perType?: Record<string, { available: number | null }>;
  };
  if (!data.ok) return null;
  return { available: data.available ?? null, perType: data.perType ?? {} };
}

async function sendSignals(
  env: Env,
  signals: Array<{ kind: string; portalId: string; outboxId: string }>,
): Promise<void> {
  if (signals.length === 0) return;
  try {
    await env.QUEUE.sendBatch(signals.map((body) => ({ body })));
  } catch {
    // Queue unbound/unavailable (e.g. tests): the outbox rows persist and the
    // reconciliation cron re-drives them.
  }
}

// ---------------------------------------------------------------------------
// joinWaitlist
// ---------------------------------------------------------------------------

export interface JoinWaitlistArgs {
  portalId: string;
  event: EventRef;
  /** Ticket type the buyer wants, or null for "any type". */
  ticketTypeId: string | null;
  email: string;
  hubspotContactId?: string | null;
  /** Seats the buyer wants (group size). Defaults to 1. */
  quantity?: number;
}

/**
 * Add a buyer to the waitlist for an event + ticket type, then enqueue a "you're on the
 * list" notification. Position is the next slot within that (event, ticket type) queue.
 */
export async function joinWaitlist(
  env: Env,
  args: JoinWaitlistArgs,
): Promise<{ waitlistId: string; position: number }> {
  const { portalId, event, ticketTypeId, email } = args;
  const quantity = args.quantity && args.quantity > 0 ? args.quantity : 1;
  const hubspotContactId = args.hubspotContactId ?? null;
  const now = new Date().toISOString();
  const waitlistId = crypto.randomUUID();

  // Position is per (event, ticket type) — each queue numbers itself 1..N.
  const posRow = await env.DB.prepare(
    `SELECT COALESCE(MAX(position), 0) + 1 AS next_pos FROM waitlist
      WHERE event_id = ?1 AND portal_id = ?2
        AND (ticket_type_id = ?3 OR (?3 IS NULL AND ticket_type_id IS NULL))`,
  )
    .bind(event.id, portalId, ticketTypeId)
    .first<{ next_pos: number }>();
  const position = posRow?.next_pos ?? 1;

  const notifyOutboxId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO waitlist
         (id, portal_id, event_id, ticket_type_id, hubspot_contact_id, email, position, quantity, status, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'waiting', ?9)`,
    ).bind(
      waitlistId,
      portalId,
      event.id,
      ticketTypeId,
      hubspotContactId,
      email,
      position,
      quantity,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
       VALUES (?1, ?2, 'notify.waitlist_joined', ?3, ?4)`,
    ).bind(
      notifyOutboxId,
      portalId,
      JSON.stringify({
        waitlistId,
        email,
        eventId: event.id,
        hubspotEventId: event.hubspot_event_id,
        ticketTypeId,
        position,
        quantity,
      }),
      now,
    ),
  ]);

  await sendSignals(env, [{ kind: 'notify.waitlist_joined', portalId, outboxId: notifyOutboxId }]);
  return { waitlistId, position };
}

// ---------------------------------------------------------------------------
// promoteWaitlist
// ---------------------------------------------------------------------------

export interface PromoteWaitlistArgs {
  portalId: string;
  event: EventRef;
}

interface WaitingRow {
  id: string;
  email: string;
  ticket_type_id: string | null;
  quantity: number;
  hubspot_contact_id: string | null;
}

/**
 * Offer freed seats to the front of the queue. Called after a seat is released
 * (expireHold) or refunded (handleRefund). Safe to call repeatedly: it expires lapsed
 * offers, never offers more than the genuinely-free seat count, and subtracts seats
 * already under a live offer so a second pass can't double-offer the same freed seat.
 */
export async function promoteWaitlist(env: Env, args: PromoteWaitlistArgs): Promise<void> {
  const { portalId, event } = args;
  const secret = env.HUBSPOT_WEBHOOK_SECRET;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  // 1. Expire stale offers whose window lapsed without a claim.
  await env.DB.prepare(
    `UPDATE waitlist SET status = 'expired'
      WHERE portal_id = ?1 AND event_id = ?2 AND status = 'offered'
        AND offer_expires_at IS NOT NULL AND offer_expires_at <= ?3`,
  )
    .bind(portalId, event.id, nowIso)
    .run();

  // 2. Read live availability from the DO — the single source of truth for seats.
  const doIdName = `${portalId}:${event.hubspot_event_id}`;
  let avail: Availability | null;
  try {
    avail = await doAvailability(env, doIdName);
  } catch {
    return; // DO unreachable — a later free or the reconciliation cron retries.
  }
  if (!avail) return;

  let eventAvail = avail.available; // null = uncapped
  const typeAvail = new Map<string, number | null>();
  for (const [id, v] of Object.entries(avail.perType)) typeAvail.set(id, v.available);

  // 3. Subtract seats already under a still-live offer (not yet reflected as DO holds),
  //    so promotion is idempotent across overlapping frees.
  const offered = await env.DB.prepare(
    `SELECT ticket_type_id, SUM(quantity) AS q FROM waitlist
      WHERE portal_id = ?1 AND event_id = ?2 AND status = 'offered'
      GROUP BY ticket_type_id`,
  )
    .bind(portalId, event.id)
    .all<{ ticket_type_id: string | null; q: number }>();
  for (const o of offered.results) {
    if (eventAvail !== null) eventAvail -= o.q;
    if (o.ticket_type_id !== null) {
      const t = typeAvail.get(o.ticket_type_id);
      if (t !== undefined && t !== null) typeAvail.set(o.ticket_type_id, t - o.q);
    }
  }

  if (eventAvail !== null && eventAvail <= 0) return; // capped event, nothing free.

  // 4. Walk the queue in position order; offer to the next-in-line whose quantity fits at
  //    BOTH the event level and (for typed waits) the per-type level. A wait that doesn't
  //    fit is skipped, not blocking — a smaller wait further back may still fit the gap.
  const waiting = await env.DB.prepare(
    `SELECT id, email, ticket_type_id, quantity, hubspot_contact_id FROM waitlist
      WHERE portal_id = ?1 AND event_id = ?2 AND status = 'waiting'
      ORDER BY position ASC, created_at ASC`,
  )
    .bind(portalId, event.id)
    .all<WaitingRow>();

  const offerExpiresAtMs = nowMs + OFFER_TTL_MS;
  const offerExpiresAt = new Date(offerExpiresAtMs).toISOString();
  const stmts: D1PreparedStatement[] = [];
  const signals: Array<{ kind: string; portalId: string; outboxId: string }> = [];

  for (const row of waiting.results) {
    const qty = row.quantity > 0 ? row.quantity : 1;
    const fitsEvent = eventAvail === null || qty <= eventAvail;
    const tAvail = row.ticket_type_id !== null ? typeAvail.get(row.ticket_type_id) : undefined;
    // Typed wait against a capped type must fit that type; uncapped/unknown type or an
    // "any type" wait is gated by the event level only.
    const fitsType =
      row.ticket_type_id === null || tAvail === undefined || tAvail === null || qty <= tAvail;
    if (!fitsEvent || !fitsType) continue;

    const token = await signOffer(secret, row.id, offerExpiresAtMs);
    stmts.push(
      env.DB.prepare(
        `UPDATE waitlist SET status = 'offered', offer_expires_at = ?1
          WHERE id = ?2 AND status = 'waiting'`,
      ).bind(offerExpiresAt, row.id),
    );

    const outboxId = crypto.randomUUID();
    stmts.push(
      env.DB.prepare(
        `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
         VALUES (?1, ?2, 'notify.waitlist_offer', ?3, ?4)`,
      ).bind(
        outboxId,
        portalId,
        JSON.stringify({
          waitlistId: row.id,
          email: row.email,
          hubspotContactId: row.hubspot_contact_id,
          eventId: event.id,
          hubspotEventId: event.hubspot_event_id,
          ticketTypeId: row.ticket_type_id,
          quantity: qty,
          offerToken: token,
          offerExpiresAt,
        }),
        nowIso,
      ),
    );
    signals.push({ kind: 'notify.waitlist_offer', portalId, outboxId });

    if (eventAvail !== null) eventAvail -= qty;
    if (row.ticket_type_id !== null && tAvail !== undefined && tAvail !== null) {
      typeAvail.set(row.ticket_type_id, tAvail - qty);
    }
    if (eventAvail !== null && eventAvail <= 0) break;
  }

  if (stmts.length === 0) return;
  await env.DB.batch(stmts);
  await sendSignals(env, signals);
}

// ---------------------------------------------------------------------------
// offerToWaitlisters — owner-selected promotion (Phase 18.3)
// ---------------------------------------------------------------------------

/**
 * Offer to a specific set of waitlisters chosen by the event owner (replaces the
 * automated next-in-line walk). Signs an offer token, marks each still-'waiting' row
 * 'offered' with a fresh TTL, and enqueues notify.waitlist_offer. The DO re-validates at
 * confirm time, so a chosen offer can never oversell. Returns the ids actually offered.
 */
export async function offerToWaitlisters(
  env: Env,
  args: { portalId: string; event: EventRef; waitlistIds: string[] },
): Promise<string[]> {
  const { portalId, event, waitlistIds } = args;
  if (waitlistIds.length === 0) return [];

  const secret = env.HUBSPOT_WEBHOOK_SECRET;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const offerExpiresAtMs = nowMs + OFFER_TTL_MS;
  const offerExpiresAt = new Date(offerExpiresAtMs).toISOString();

  const placeholders = waitlistIds.map((_, i) => `?${i + 3}`).join(', ');
  const waiting = await env.DB.prepare(
    `SELECT id, email, ticket_type_id, quantity, hubspot_contact_id FROM waitlist
      WHERE portal_id = ?1 AND event_id = ?2 AND status = 'waiting' AND id IN (${placeholders})`,
  )
    .bind(portalId, event.id, ...waitlistIds)
    .all<WaitingRow>();

  const stmts: D1PreparedStatement[] = [];
  const signals: Array<{ kind: string; portalId: string; outboxId: string }> = [];
  const offeredIds: string[] = [];

  for (const row of waiting.results) {
    const qty = row.quantity > 0 ? row.quantity : 1;
    const token = await signOffer(secret, row.id, offerExpiresAtMs);
    offeredIds.push(row.id);
    stmts.push(
      env.DB.prepare(
        `UPDATE waitlist SET status = 'offered', offer_expires_at = ?1
          WHERE id = ?2 AND status = 'waiting'`,
      ).bind(offerExpiresAt, row.id),
    );
    const outboxId = crypto.randomUUID();
    stmts.push(
      env.DB.prepare(
        `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
         VALUES (?1, ?2, 'notify.waitlist_offer', ?3, ?4)`,
      ).bind(
        outboxId,
        portalId,
        JSON.stringify({
          waitlistId: row.id,
          email: row.email,
          hubspotContactId: row.hubspot_contact_id,
          eventId: event.id,
          hubspotEventId: event.hubspot_event_id,
          ticketTypeId: row.ticket_type_id,
          quantity: qty,
          offerToken: token,
          offerExpiresAt,
        }),
        nowIso,
      ),
    );
    signals.push({ kind: 'notify.waitlist_offer', portalId, outboxId });
  }

  if (stmts.length === 0) return [];
  await env.DB.batch(stmts);
  await sendSignals(env, signals);
  return offeredIds;
}

/**
 * Snapshot the ordered waitlist for an event (front of queue first). Used as the context
 * an event owner sees when resolving a waitlist decision (Phase 18.3).
 */
export async function waitlistSnapshot(
  env: Env,
  portalId: string,
  eventId: string,
): Promise<
  Array<{
    id: string;
    email: string;
    ticketTypeId: string | null;
    quantity: number;
    position: number;
  }>
> {
  const rows = await env.DB.prepare(
    `SELECT id, email, ticket_type_id, quantity, position FROM waitlist
      WHERE portal_id = ?1 AND event_id = ?2 AND status = 'waiting'
      ORDER BY position ASC, created_at ASC`,
  )
    .bind(portalId, eventId)
    .all<{
      id: string;
      email: string;
      ticket_type_id: string | null;
      quantity: number;
      position: number;
    }>();
  return rows.results.map((r) => ({
    id: r.id,
    email: r.email,
    ticketTypeId: r.ticket_type_id,
    quantity: r.quantity,
    position: r.position,
  }));
}

// ---------------------------------------------------------------------------
// claimWaitlistOffer — validated at /reserve
// ---------------------------------------------------------------------------

export interface OfferClaim {
  waitlistId: string;
  ticketTypeId: string | null;
  quantity: number;
}

export type ClaimResult =
  | { ok: true; claim: OfferClaim }
  | { ok: false; error: 'offer_invalid' | 'offer_expired' | 'offer_not_open' };

/**
 * Validate a waitlist offer token + window before a reserve is allowed to consume the
 * freed seat. Does not mutate — the caller marks the entry promoted (markOfferPromoted)
 * inside the same batch that creates the reservation, so the status flips only if the
 * hold is actually granted.
 */
export async function claimWaitlistOffer(
  env: Env,
  params: { portalId: string; eventId: string; token: string },
): Promise<ClaimResult> {
  const verified = await verifyWaitlistOffer(env.HUBSPOT_WEBHOOK_SECRET, params.token);
  if (!verified) return { ok: false, error: 'offer_invalid' };

  const row = await env.DB.prepare(
    `SELECT id, ticket_type_id, quantity, status, offer_expires_at FROM waitlist
      WHERE id = ?1 AND portal_id = ?2 AND event_id = ?3`,
  )
    .bind(verified.waitlistId, params.portalId, params.eventId)
    .first<{
      id: string;
      ticket_type_id: string | null;
      quantity: number;
      status: string;
      offer_expires_at: string | null;
    }>();
  if (!row) return { ok: false, error: 'offer_invalid' };

  // The token must match the CURRENT offer instance: offer_expires_at is re-stamped on
  // every re-offer, so a token from a superseded round won't line up.
  if (!row.offer_expires_at || Date.parse(row.offer_expires_at) !== verified.expiresAtMs) {
    return { ok: false, error: 'offer_invalid' };
  }

  const claim: OfferClaim = {
    waitlistId: row.id,
    ticketTypeId: row.ticket_type_id,
    quantity: row.quantity,
  };

  // A 'promoted' offer has ALREADY been consumed by a granted hold. We must not treat it
  // as a re-claimable idempotent success: the claim isn't tied to the original reservation
  // or its Idempotency-Key, so a new request bearing a fresh key could reuse the still-live
  // token to create additional holds — letting one promotion swallow multiple seats.
  // Genuine same-key retries never reach here: handleReserve replays the stored response
  // from idempotency_keys (written in the same batch as the promotion) before doReserve
  // runs. So only 'offered' is claimable.
  if (row.status !== 'offered') return { ok: false, error: 'offer_not_open' };
  if (Date.now() > verified.expiresAtMs) return { ok: false, error: 'offer_expired' };

  return { ok: true, claim };
}

/**
 * Statement that flips a claimed offer to 'promoted'. Push it into the reserve batch so
 * the status only changes if the hold commits to D1 alongside it.
 */
export function markOfferPromoted(env: Env, waitlistId: string): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE waitlist SET status = 'promoted' WHERE id = ?1 AND status = 'offered'`,
  ).bind(waitlistId);
}
