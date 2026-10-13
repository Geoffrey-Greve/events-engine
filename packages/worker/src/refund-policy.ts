/**
 * Refund policy resolution + outcome computation (Phase 18.2).
 *
 * An event resolves its policy most-specific first:
 *   1. events.refund_policy_id  (an explicit per-event policy)
 *   2. the category-matched default template (is_default = 1 AND category = event.category)
 *   3. the portal default template            (is_default = 1 AND category IS NULL)
 *   4. the built-in fallback (full refund up to 30 days, transfers allowed)
 *
 * "A different default per team" is modelled as the category-matched template (step 2),
 * the confirmed reading of "team" = event category.
 */

import type { RefundOutcome } from '@paddock/shared';
import type { Env } from './types';

export interface RefundPolicyRow {
  id: string;
  portal_id: string;
  name: string;
  is_default: number;
  category: string | null;
  full_refund_cutoff_days: number | null;
  partial_refund_percent: number | null;
  allow_transfer: number;
  created_at: string;
}

/** Effective policy values, always populated (built-in fallback fills the gaps). */
export interface EffectiveRefundPolicy {
  /** The resolved policy id, or null when only the built-in fallback applied. */
  id: string | null;
  fullRefundCutoffDays: number;
  partialRefundPercent: number | null;
  allowTransfer: boolean;
}

const FALLBACK: EffectiveRefundPolicy = {
  id: null,
  fullRefundCutoffDays: 30,
  partialRefundPercent: null,
  allowTransfer: true,
};

export async function resolveRefundPolicy(
  env: Env,
  event: { portal_id: string; refund_policy_id: string | null; category: string | null },
): Promise<EffectiveRefundPolicy> {
  const { portal_id: portalId, refund_policy_id: policyId, category } = event;

  // 1. Explicit per-event policy.
  if (policyId) {
    const row = await env.DB.prepare(
      'SELECT * FROM refund_policies WHERE id = ?1 AND portal_id = ?2',
    )
      .bind(policyId, portalId)
      .first<RefundPolicyRow>();
    if (row) return toEffective(row);
  }

  // 2. Category-matched default template.
  if (category) {
    const row = await env.DB.prepare(
      `SELECT * FROM refund_policies
        WHERE portal_id = ?1 AND is_default = 1 AND category = ?2
        ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(portalId, category)
      .first<RefundPolicyRow>();
    if (row) return toEffective(row);
  }

  // 3. Portal default template (no category).
  const portalDefault = await env.DB.prepare(
    `SELECT * FROM refund_policies
      WHERE portal_id = ?1 AND is_default = 1 AND category IS NULL
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(portalId)
    .first<RefundPolicyRow>();
  if (portalDefault) return toEffective(portalDefault);

  // 4. Built-in fallback.
  return FALLBACK;
}

function toEffective(row: RefundPolicyRow): EffectiveRefundPolicy {
  return {
    id: row.id,
    fullRefundCutoffDays: row.full_refund_cutoff_days ?? FALLBACK.fullRefundCutoffDays,
    partialRefundPercent: row.partial_refund_percent ?? null,
    allowTransfer: row.allow_transfer !== 0,
  };
}

/**
 * Compute the refund outcome for an order under a policy.
 *   - >= cutoff days before the event → full refund.
 *   - otherwise, partial_refund_percent of the paid amount (or none if null).
 */
export function computeRefund(
  policy: EffectiveRefundPolicy,
  opts: { totalCents: number; eventStartsAt: string; nowMs: number },
): RefundOutcome {
  const startMs = Date.parse(opts.eventStartsAt);
  const daysUntil = (startMs - opts.nowMs) / (24 * 60 * 60 * 1000);

  if (daysUntil >= policy.fullRefundCutoffDays) {
    return { kind: 'full', amountCents: opts.totalCents };
  }
  if (policy.partialRefundPercent != null) {
    const amount = Math.max(0, Math.round((opts.totalCents * policy.partialRefundPercent) / 100));
    return { kind: 'partial', amountCents: amount };
  }
  return { kind: 'none', amountCents: 0 };
}
