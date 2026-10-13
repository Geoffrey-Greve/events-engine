/**
 * Refund + transfer contract (Phase 18.2).
 *
 * Refunds are governed by a per-event policy that falls back to category/portal default
 * templates. Transfer reassigns a registration to a different attendee without refunding
 * (the seat is kept). Shared so the worker and the App Card agree on the shapes.
 */

/** A refund policy template (or a per-event policy). */
export interface RefundPolicy {
  id: string;
  portalId: string;
  name: string;
  isDefault: boolean;
  /** Optional event category this default applies to ("team"). Null = portal-wide default. */
  category: string | null;
  /** Full refund if the event is >= this many days away. Default 30. */
  fullRefundCutoffDays: number | null;
  /** Percent refunded after the cutoff (e.g. 50). Null = no refund after cutoff. */
  partialRefundPercent: number | null;
  allowTransfer: boolean;
  createdAt: string;
}

/** The outcome of applying a policy to an order at refund time. */
export type RefundKind = 'full' | 'partial' | 'none';

export interface RefundOutcome {
  kind: RefundKind;
  /** Amount to refund, in integer cents AUD. */
  amountCents: number;
}

/** Audit record of an attendee reassignment. */
export interface TransferRecord {
  id: string;
  portalId: string;
  registrationId: string;
  fromEmail: string;
  toEmail: string;
  reason: string | null;
  createdAt: string;
}
