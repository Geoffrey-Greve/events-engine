/**
 * Corporate training vouchers.
 *
 * A company holds prepaid training vouchers on its HubSpot record, issued there by staff.
 * At checkout they are redeemed as credit: a covered seat is priced at $0 and its cost never
 * reaches the invoice, because the money was taken when the voucher was sold.
 *
 * Two tenant-selectable models (`tenants.voucher_mode`):
 *
 *   'seat'   — one voucher covers one seat outright, whatever that seat costs.
 *   'credit' — a monetary balance drawn down by the price of the seats it covers.
 *   'off'    — not redeemable.
 *
 * In both models a voucher covers WHOLE seats only, most expensive first (worth the most to
 * the buyer). Under 'credit', leftover smaller than the cheapest remaining seat carries
 * forward to a later booking — so every invoice line is either full price or zero, with no
 * part-priced seats and no discount lines to reconcile in Xero.
 *
 * ACCOUNTING. D1 is the source of truth; the HubSpot property is a projection pushed through
 * the outbox. Usage is DERIVED by summing what each order redeemed, never incremented:
 *
 *     used = baseline + SUM(redemption on this company's paid/confirmed orders)
 *
 * That makes the projection safe to replay — it PATCHes an absolute value — and
 * self-correcting: a refunded or expired order drops out of the sum and its vouchers come
 * back with no compensating write. `baseline` preserves usage predating this worker.
 */

import { getSecret } from './config';
import { getAccessToken } from './hubspot-oauth';
import type { Env } from './types';

const HS_API = 'https://api.hubapi.com';

export type VoucherMode = 'seat' | 'credit' | 'off';

/**
 * A voucher is spent once the seat is actually committed — paid orders, and free/
 * complimentary orders which commit immediately at reserve time. Mirrors the two commit
 * points in the reservation flow.
 */
export const VOUCHER_COMMITTED_ORDER_STATUSES = ['paid', 'confirmed'] as const;

/**
 * Statuses that additionally tie up a voucher without having committed it yet: a live
 * checkout hold, and an oversell awaiting an owner decision that may still be honoured.
 * Counted by the booking gate so concurrent checkouts can't over-allocate the same balance
 * during the hold window; excluded from the HubSpot projection, which reports settled usage.
 */
export const VOUCHER_HELD_ORDER_STATUSES = ['pending', 'needs_review'] as const;

export interface VoucherConfig {
  mode: VoucherMode;
  totalProperty: string;
  usedProperty: string;
}

export interface VoucherUsage {
  /** Usage predating this worker, preserved across recomputes (seats / cents by mode). */
  baseline: number;
  /** Redeemed on committed orders (paid or free-confirmed). */
  committed: number;
  /** Redeemed on live holds and undecided oversells. */
  held: number;
  /** What the HubSpot used-property should read: baseline + committed. */
  used: number;
  /** What a booking should be charged against: baseline + committed + held. */
  encumbered: number;
}

export interface VoucherBalance {
  config: VoucherConfig;
  usage: VoucherUsage;
  /** Issued allowance read from the company record (seats, or cents under 'credit'). */
  total: number;
  /** total − encumbered, floored at zero. What this booking may actually redeem. */
  available: number;
  /** False when the tenant has vouchers off, or the company has no allowance set. */
  metered: boolean;
}

// ---------------------------------------------------------------------------
// Tenant configuration
// ---------------------------------------------------------------------------

export async function loadVoucherConfig(env: Env, portalId: string): Promise<VoucherConfig> {
  const row = await env.DB.prepare(
    'SELECT voucher_mode, voucher_total_property, voucher_used_property FROM tenants WHERE portal_id = ?1',
  )
    .bind(portalId)
    .first<{
      voucher_mode: string | null;
      voucher_total_property: string | null;
      voucher_used_property: string | null;
    }>()
    // Tenants provisioned before 0018 (and the hand-rolled schemas in tests) fall back to
    // the shipped defaults rather than disabling vouchers outright.
    .catch(() => null);

  const mode =
    row?.voucher_mode === 'credit' || row?.voucher_mode === 'off' ? row.voucher_mode : 'seat';
  return {
    mode,
    totalProperty: row?.voucher_total_property || 'vouchers_total',
    usedProperty: row?.voucher_used_property || 'vouchers_used',
  };
}

/**
 * Parse a HubSpot property into this mode's internal unit: a plain count under 'seat', and
 * integer cents under 'credit' (the property is keyed in dollars, per CLAUDE.md's
 * money-in-cents invariant applying to storage, not to what staff type into HubSpot).
 */
export function parseVoucherAmount(raw: unknown, mode: VoucherMode): number {
  const text = String(raw ?? '').replace(/[^\d.-]/g, '');
  if (!text) return 0;
  const value = Number.parseFloat(text);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return mode === 'credit' ? Math.round(value * 100) : Math.floor(value);
}

/** Render an internal amount back into the unit the HubSpot property is keyed in. */
export function formatVoucherAmount(amount: number, mode: VoucherMode): string {
  return mode === 'credit' ? (amount / 100).toFixed(2) : String(amount);
}

// ---------------------------------------------------------------------------
// Usage (derived from order state)
// ---------------------------------------------------------------------------

/**
 * Sum what a company's orders redeemed, across orders in the given statuses. Reads the
 * per-order redemption columns rather than counting seats: under partial coverage an order's
 * seat count is not what it spent.
 */
async function sumRedeemed(
  db: D1Database,
  portalId: string,
  companyId: string,
  mode: VoucherMode,
  statuses: readonly string[],
): Promise<number> {
  const column = mode === 'credit' ? 'voucher_credit_cents' : 'voucher_seats_redeemed';
  const placeholders = statuses.map((_, i) => `?${i + 3}`).join(', ');
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(${column}), 0) AS redeemed
         FROM orders
        WHERE portal_id = ?1
          AND member_company_id = ?2
          AND status IN (${placeholders})`,
    )
    .bind(portalId, companyId, ...statuses)
    .first<{ redeemed: number }>();
  return row?.redeemed ?? 0;
}

/** Read the stored baseline, or null when we have never touched this company. */
export async function getVoucherBaseline(
  db: D1Database,
  portalId: string,
  companyId: string,
  mode: VoucherMode = 'seat',
): Promise<number | null> {
  const row = await db
    .prepare(
      'SELECT baseline_used, baseline_used_cents FROM corporate_voucher_accounts WHERE portal_id = ?1 AND company_id = ?2',
    )
    .bind(portalId, companyId)
    .first<{ baseline_used: number; baseline_used_cents: number }>();
  if (!row) return null;
  return mode === 'credit' ? row.baseline_used_cents : row.baseline_used;
}

/**
 * Record pre-existing HubSpot usage as this company's baseline, once. Must be called with a
 * value read from HubSpot BEFORE the worker has ever written the used-property — INSERT OR
 * IGNORE guarantees the first capture wins, so a value we later wrote ourselves can never be
 * mistaken for pre-existing usage.
 */
export async function captureVoucherBaseline(
  db: D1Database,
  portalId: string,
  companyId: string,
  used: number,
  mode: VoucherMode = 'seat',
): Promise<void> {
  const seats = mode === 'credit' ? 0 : Math.max(0, used);
  const cents = mode === 'credit' ? Math.max(0, used) : 0;
  await db
    .prepare(
      `INSERT OR IGNORE INTO corporate_voucher_accounts
         (portal_id, company_id, baseline_used, baseline_used_cents, captured_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
    .bind(portalId, companyId, seats, cents, new Date().toISOString())
    .run();
}

/** Compute a company's voucher position from D1. */
export async function resolveVoucherUsage(
  db: D1Database,
  portalId: string,
  companyId: string,
  mode: VoucherMode = 'seat',
): Promise<VoucherUsage> {
  const [baselineRaw, committed, held] = await Promise.all([
    getVoucherBaseline(db, portalId, companyId, mode),
    sumRedeemed(db, portalId, companyId, mode, VOUCHER_COMMITTED_ORDER_STATUSES),
    sumRedeemed(db, portalId, companyId, mode, VOUCHER_HELD_ORDER_STATUSES),
  ]);

  const baseline = baselineRaw ?? 0;
  return {
    baseline,
    committed,
    held,
    used: baseline + committed,
    encumbered: baseline + committed + held,
  };
}

// ---------------------------------------------------------------------------
// Balance (HubSpot allowance + D1 usage)
// ---------------------------------------------------------------------------

async function resolveReadToken(env: Env, portalId: string): Promise<string | null> {
  try {
    return getSecret(env, `HUBSPOT_API_KEY_${portalId}`);
  } catch {
    // Legacy per-portal private-app token is optional; prefer the tenant OAuth token.
  }
  try {
    return await getAccessToken(env, portalId);
  } catch {
    return null;
  }
}

/**
 * Resolve what a company may spend right now: its issued allowance from HubSpot, less usage
 * derived from D1. Captures the baseline on first contact.
 *
 * `companyProperties` lets a caller that has already read the company (the corporate team
 * gate) pass them in rather than paying for a second HubSpot round-trip.
 */
export async function resolveVoucherBalance(
  env: Env,
  portalId: string,
  companyId: string,
  companyProperties?: Record<string, string | undefined>,
): Promise<VoucherBalance> {
  const config = await loadVoucherConfig(env, portalId);

  if (config.mode === 'off') {
    const usage = { baseline: 0, committed: 0, held: 0, used: 0, encumbered: 0 };
    return { config, usage, total: 0, available: 0, metered: false };
  }

  let properties = companyProperties;
  if (!properties) {
    const token = await resolveReadToken(env, portalId);
    if (!token) {
      // No token: report an unmetered balance rather than silently redeeming nothing
      // against an allowance we could not read.
      const usage = await resolveVoucherUsage(env.DB, portalId, companyId, config.mode);
      return { config, usage, total: 0, available: 0, metered: false };
    }
    const props = [config.totalProperty, config.usedProperty].map(encodeURIComponent).join(',');
    const resp = await fetch(
      `${HS_API}/crm/v3/objects/companies/${encodeURIComponent(companyId)}?properties=${props}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!resp.ok) {
      const usage = await resolveVoucherUsage(env.DB, portalId, companyId, config.mode);
      return { config, usage, total: 0, available: 0, metered: false };
    }
    const body = (await resp.json()) as { properties?: Record<string, string | undefined> };
    properties = body.properties ?? {};
  }

  // Bank pre-existing usage before we ever write the property back.
  await captureVoucherBaseline(
    env.DB,
    portalId,
    companyId,
    parseVoucherAmount(properties[config.usedProperty], config.mode),
    config.mode,
  );

  const total = parseVoucherAmount(properties[config.totalProperty], config.mode);
  const usage = await resolveVoucherUsage(env.DB, portalId, companyId, config.mode);

  return {
    config,
    usage,
    total,
    available: Math.max(0, total - usage.encumbered),
    metered: total > 0,
  };
}

// ---------------------------------------------------------------------------
// Redemption
// ---------------------------------------------------------------------------

export interface RedeemableSeat {
  /** Index into the caller's seat list, so it can zero exactly the seats we covered. */
  index: number;
  unitCents: number;
}

export interface VoucherRedemption {
  /** Indices of the seats a voucher covers; those lines are priced at $0. */
  coveredSeatIndexes: number[];
  /** Vouchers consumed under 'seat' mode. */
  seatsRedeemed: number;
  /** Credit consumed under 'credit' mode, in cents. */
  creditCents: number;
}

export const NO_REDEMPTION: VoucherRedemption = {
  coveredSeatIndexes: [],
  seatsRedeemed: 0,
  creditCents: 0,
};

/**
 * Decide which seats a company's vouchers cover.
 *
 * Most expensive first, whole seats only. Under 'credit' a seat is covered only if the
 * remaining balance meets its full price; anything left over stays on the balance rather
 * than part-paying a seat, which is what keeps every invoice line full price or zero.
 */
export function planVoucherRedemption(
  seats: RedeemableSeat[],
  balance: { mode: VoucherMode; available: number },
): VoucherRedemption {
  if (balance.mode === 'off' || balance.available <= 0 || seats.length === 0) {
    return NO_REDEMPTION;
  }

  const byValue = [...seats].sort((a, b) => b.unitCents - a.unitCents);
  const covered: number[] = [];
  let remaining = balance.available;
  let creditCents = 0;

  for (const seat of byValue) {
    if (balance.mode === 'seat') {
      if (remaining < 1) break;
      remaining -= 1;
      creditCents += seat.unitCents;
    } else {
      // A free seat consumes no credit, so cover it without touching the balance.
      if (seat.unitCents > 0) {
        if (remaining < seat.unitCents) continue;
        remaining -= seat.unitCents;
        creditCents += seat.unitCents;
      }
    }
    covered.push(seat.index);
  }

  return {
    coveredSeatIndexes: covered.sort((a, b) => a - b),
    seatsRedeemed: balance.mode === 'seat' ? covered.length : 0,
    creditCents: balance.mode === 'credit' ? creditCents : 0,
  };
}

// ---------------------------------------------------------------------------
// Projection to HubSpot
// ---------------------------------------------------------------------------

/**
 * Build the outbox row that pushes a company's recomputed usage to HubSpot. Returned as a
 * statement so callers can include it in the same D1 batch as the state change that moved
 * the balance (CLAUDE.md: every HubSpot side effect goes through the outbox in the same
 * transaction as the state change).
 *
 * The payload carries only identifiers — the handler recomputes at delivery time, so a
 * delayed or retried row writes the current value rather than a stale one.
 */
export function voucherUsageSyncStatement(
  env: Env,
  portalId: string,
  companyId: string,
  outboxId: string,
  now: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
     VALUES (?1, ?2, 'company.sync_voucher_usage', ?3, ?4)`,
  ).bind(outboxId, portalId, JSON.stringify({ portalId, companyId }), now);
}

/**
 * Queue signal for a voucher sync outbox row. Best-effort, like every other signal in the
 * flow — the outbox drain cron is the backstop.
 */
export async function signalVoucherUsageSync(
  env: Env,
  portalId: string,
  companyId: string,
  outboxId: string,
): Promise<void> {
  try {
    await env.QUEUE.send({
      kind: 'company.sync_voucher_usage',
      portalId,
      companyId,
      outboxId,
    });
  } catch {
    // swallow — the cron drains pending outbox rows
  }
}
