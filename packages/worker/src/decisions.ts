/**
 * Human-in-the-loop decisions (Phase 18.3).
 *
 * The worker no longer auto-resolves oversell or waitlist promotion. Instead it records a
 * pending_decisions row, assigns it to the event owner, and notifies them (HubSpot task via
 * the notify.owner_task outbox). The owner resolves it from the App Card.
 */

import {
  type AttendeeContactValues,
  type ContactConflict,
  enqueueAttendeeContactSync,
} from './attendee-contact';
import type { EventRow } from './db';
import { loadEvent } from './db';
import { enqueueInvoiceVoid, executeRefund, honourOversell } from './payment';
import type { Env } from './types';
import { offerToWaitlisters } from './waitlist';

export interface PendingDecisionRow {
  id: string;
  portal_id: string;
  event_id: string;
  type: string;
  status: string;
  order_id: string | null;
  registration_id: string | null;
  context: string | null;
  assigned_owner_id: string | null;
  resolved_by: string | null;
  resolution: string | null;
  created_at: string;
  resolved_at: string | null;
}

type DecisionType =
  | 'oversell'
  | 'waitlist'
  | 'fast_sellout'
  | 'contact_conflict'
  | 'unpaid_invoice';

interface CreateDecisionArgs {
  portalId: string;
  event: Pick<EventRow, 'id' | 'hubspot_event_id' | 'hubspot_owner_id' | 'title'>;
  type: DecisionType;
  orderId: string | null;
  /** Set for contact_conflict, which is about one attendee rather than a whole order. */
  registrationId?: string | null;
  context: Record<string, unknown>;
}

const DECISION_TASKS: Record<DecisionType, { subject: (title: string) => string; body: string }> = {
  oversell: {
    subject: (title) => `Oversell decision needed: ${title}`,
    body: 'A late payment arrived after this event sold out. Open the event card to honour (issue a ticket) or refund the buyer.',
  },
  waitlist: {
    subject: (title) => `Waitlist decision needed: ${title}`,
    body: 'Seats freed up. Open the event card to choose which waitlisters to offer them to.',
  },
  fast_sellout: {
    subject: (title) => `Check capacity — sold out immediately: ${title}`,
    body: 'This event sold out within 30 minutes of going live, which usually means the capacity is still a setup placeholder. Check the seat count before the listing stays closed: raise the capacity if it is wrong, or acknowledge the decision if the event really is full.',
  },
  contact_conflict: {
    subject: (title) => `Contact details differ from HubSpot: ${title}`,
    body: 'A booking supplied contact details that do not match what HubSpot already holds for this attendee. Nothing has been overwritten. Open the event card to keep the HubSpot value or replace it with the one from the booking.',
  },
  unpaid_invoice: {
    subject: (title) => `Unpaid invoice needs a decision: ${title}`,
    body: 'A booking\u2019s seat hold has lapsed with its invoice still unpaid. Nothing has been voided \u2014 this portal is set to decide that by hand. Open the event card to void the invoice (which cannot be undone) or leave it payable and chase the customer.',
  },
};

/** Stored value that stops an owner notification becoming a HubSpot task. */
export const TASK_SYNC_OFF = 'off';

/**
 * Whether this tenant's owner notifications are mirrored to a HubSpot task (0042).
 *
 * Defaults to ON: an assigned task is how an owner finds out, and no installed portal
 * changes behaviour on deploy. A portal whose credential cannot write tasks sets
 * `task_sync_mode = 'off'` so it stops enqueuing a row that can only 403 and die --
 * `crm.objects.tasks.write` is unavailable to both 2026.03 project apps and account
 * service keys. The DECISION is unaffected either way; only the telling is.
 *
 * Reading optional config must never fail the caller (Ref 217): against a tenants table
 * that predates 0042 this query throws "no such column", which degrades to the default.
 * Erring towards enqueuing is right for the same reason the invoice-eligibility gate fails
 * open -- an unsent task is recoverable from the App Home list, and a decision silently
 * never raised is not.
 */
export async function isTaskSyncEnabled(env: Env, portalId: string): Promise<boolean> {
  try {
    const row = await env.DB.prepare('SELECT task_sync_mode FROM tenants WHERE portal_id = ?1')
      .bind(portalId)
      .first<{ task_sync_mode: string | null }>();
    return (row?.task_sync_mode ?? '').trim().toLowerCase() !== TASK_SYNC_OFF;
  } catch {
    return true;
  }
}

/**
 * Insert a pending decision, and the owner-task notification alongside it when the tenant
 * takes tasks. The decision row is written either way and in the same batch as the task,
 * so the record never depends on the notification succeeding.
 */
async function createDecision(env: Env, args: CreateDecisionArgs): Promise<string> {
  const { portalId, event, type, orderId, registrationId = null, context } = args;
  const decisionId = crypto.randomUUID();
  const taskOutboxId = crypto.randomUUID();
  const now = new Date().toISOString();

  const task = DECISION_TASKS[type];
  const subject = task.subject(event.title);
  const body = task.body;

  const taskSync = await isTaskSyncEnabled(env, portalId);

  const statements = [
    env.DB.prepare(
      `INSERT INTO pending_decisions
         (id, portal_id, event_id, type, status, order_id, registration_id, context,
          assigned_owner_id, created_at)
       VALUES (?1, ?2, ?3, ?4, 'open', ?5, ?6, ?7, ?8, ?9)`,
    ).bind(
      decisionId,
      portalId,
      event.id,
      type,
      orderId,
      registrationId,
      JSON.stringify(context),
      event.hubspot_owner_id ?? null,
      now,
    ),
  ];

  if (taskSync) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
         VALUES (?1, ?2, 'notify.owner_task', ?3, ?4)`,
      ).bind(
        taskOutboxId,
        portalId,
        JSON.stringify({
          decisionId,
          eventId: event.id,
          hubspotEventId: event.hubspot_event_id,
          type,
          registrationId,
          assignedOwnerId: event.hubspot_owner_id ?? null,
          subject,
          body,
        }),
        now,
      ),
    );
  }

  await env.DB.batch(statements);

  // Best-effort drain (cron is the backstop).
  if (taskSync) {
    try {
      await env.QUEUE.send({ kind: 'notify.owner_task', portalId, outboxId: taskOutboxId });
    } catch {
      // swallow
    }
  }

  return decisionId;
}

export function createOversellDecision(
  env: Env,
  args: { portalId: string; event: EventRow; orderId: string; context: Record<string, unknown> },
): Promise<string> {
  return createDecision(env, {
    portalId: args.portalId,
    event: args.event,
    type: 'oversell',
    orderId: args.orderId,
    context: args.context,
  });
}

export function createWaitlistDecision(
  env: Env,
  args: { portalId: string; event: EventRow; context: Record<string, unknown> },
): Promise<string> {
  return createDecision(env, {
    portalId: args.portalId,
    event: args.event,
    type: 'waitlist',
    orderId: null,
    context: args.context,
  });
}

/**
 * An event sold out suspiciously soon after going live (Phase 1.1). Nothing is blocked —
 * the seats really are gone — but the owner is asked to confirm the capacity is real
 * before the listing stays closed.
 *
 * Raising this is deliberately once-per-event: the partial unique index added in 0020
 * rejects a second row, so a concurrent booking racing to raise it throws here rather
 * than assigning the owner a duplicate task.
 */
export function createFastSelloutDecision(
  env: Env,
  args: { portalId: string; event: EventRow; context: Record<string, unknown> },
): Promise<string> {
  return createDecision(env, {
    portalId: args.portalId,
    event: args.event,
    type: 'fast_sellout',
    orderId: null,
    context: args.context,
  });
}

/**
 * A booking captured contact details that disagree with what HubSpot already holds
 * (Phase 1.2). Nothing has been written for the conflicting fields — the owner decides
 * whether the member's stored value or the booker's stays.
 *
 * Once per registration while open: the partial unique index added in 0021 rejects a
 * second row, so an outbox retry that re-runs the whole handler cannot hand the owner a
 * duplicate task. The caller treats that collision as "already asked".
 */
export function createContactConflictDecision(
  env: Env,
  args: {
    portalId: string;
    event: EventRow;
    registrationId: string;
    context: ContactConflictContext;
  },
): Promise<string> {
  return createDecision(env, {
    portalId: args.portalId,
    event: args.event,
    type: 'contact_conflict',
    orderId: null,
    registrationId: args.registrationId,
    context: args.context as unknown as Record<string, unknown>,
  });
}

/**
 * A hold lapsed with its invoice unpaid, and this portal voids by hand (migration 0039).
 *
 * The seat has already gone back on sale — that is what a lapsed hold means, under either
 * mode. What is open is the INVOICE, which is terminal once voided (Phase 4.2) and is the
 * commercial record of a company block. Nobody but the tenant can say whether a customer
 * who has not paid in 60 days is still coming.
 */
export function createUnpaidInvoiceDecision(
  env: Env,
  args: {
    portalId: string;
    event: EventRow;
    orderId: string;
    context: Record<string, unknown>;
  },
): Promise<string> {
  return createDecision(env, {
    portalId: args.portalId,
    event: args.event,
    type: 'unpaid_invoice',
    orderId: args.orderId,
    context: args.context,
  });
}

/** What the App Card needs to render a contact conflict and what resolving it replays. */
export interface ContactConflictContext extends Record<string, unknown> {
  attendeeEmail: string;
  attendeeName: string | null;
  hubspotContactId: string | null;
  /** Every field that differs — one decision per registration, not one per field. */
  conflicts: ContactConflict[];
  /** Fields written straight away because HubSpot held nothing (for the audit trail). */
  written: string[];
  /** The full captured set, so an 'overwrite' resolution replays exactly what was booked. */
  captured: AttendeeContactValues;
}

export async function listPendingDecisions(
  env: Env,
  portalId: string,
  eventId: string,
): Promise<PendingDecisionRow[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM pending_decisions
      WHERE portal_id = ?1 AND event_id = ?2 AND status = 'open'
      ORDER BY created_at ASC`,
  )
    .bind(portalId, eventId)
    .all<PendingDecisionRow>();
  return rows.results;
}

/** A pending decision plus the event it belongs to, for the cross-event App Home list. */
export interface PortalPendingDecisionRow extends PendingDecisionRow {
  event_title: string;
  event_starts_at: string;
  hubspot_event_id: string;
}

/**
 * Every open decision in the portal, newest event first.
 *
 * The per-event list above answers "what does THIS event need", which is the right question
 * once you are already looking at the event. Nothing answered "what needs me anywhere",
 * and the HubSpot task was the only thing that ever pushed a decision at an owner. On a
 * portal whose credential cannot write tasks (`task_sync_mode = 'off'`) this list IS the
 * notification, so it joins the event in: a decision the reader cannot place is one they
 * cannot act on.
 */
export async function listOpenDecisionsForPortal(
  env: Env,
  portalId: string,
  limit = 100,
): Promise<PortalPendingDecisionRow[]> {
  const rows = await env.DB.prepare(
    `SELECT d.*, e.title AS event_title, e.starts_at AS event_starts_at,
            e.hubspot_event_id AS hubspot_event_id
       FROM pending_decisions d
       JOIN events e ON e.id = d.event_id AND e.portal_id = d.portal_id
      WHERE d.portal_id = ?1 AND d.status = 'open'
      ORDER BY d.created_at ASC
      LIMIT ?2`,
  )
    .bind(portalId, limit)
    .all<PortalPendingDecisionRow>();
  return rows.results;
}

export interface ResolveDecisionInput {
  /**
   * Oversell: 'honour' | 'refund'. Fast sell-out: 'acknowledge'.
   * Contact conflict: 'keep' (HubSpot wins) | 'overwrite' (the booking's value wins).
   * Unpaid invoice: 'void' (irreversible) | 'keep' (leave it payable).
   */
  action?: string;
  /** Waitlist: the waitlist row ids the owner chose to offer to. */
  waitlistIds?: string[];
  resolvedBy?: string;
}

export type ResolveResult =
  | { ok: true; detail: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Resolve an open decision.
 *   oversell → HONOUR (force-confirm + issue ticket) or REFUND (per policy).
 *   waitlist → offer to the chosen waitlisters (signed token + TTL); the DO re-validates
 *              at confirm so a chosen offer can't oversell.
 *   contact_conflict → KEEP what HubSpot holds, or OVERWRITE it with the booking's value.
 */
export async function resolveDecision(
  env: Env,
  portalId: string,
  decisionId: string,
  input: ResolveDecisionInput,
): Promise<ResolveResult> {
  const decision = await env.DB.prepare(
    'SELECT * FROM pending_decisions WHERE id = ?1 AND portal_id = ?2',
  )
    .bind(decisionId, portalId)
    .first<PendingDecisionRow>();
  if (!decision) return { ok: false, error: 'decision_not_found' };
  if (decision.status !== 'open') return { ok: false, error: 'decision_not_open' };

  let detail: Record<string, unknown> = {};

  if (decision.type === 'oversell') {
    if (!decision.order_id) return { ok: false, error: 'missing_order' };
    if (input.action === 'honour') {
      await honourOversell(env, portalId, decision.order_id);
      detail = { action: 'honour' };
    } else if (input.action === 'refund') {
      const result = await executeRefund(env, portalId, decision.order_id);
      detail = { action: 'refund', refund: result };
    } else {
      return { ok: false, error: 'invalid_action' };
    }
  } else if (decision.type === 'fast_sellout') {
    // Advisory only: the owner has looked. Fixing a placeholder capacity is a separate
    // PATCH /events/:id, so there is nothing to execute here beyond closing the decision.
    if (input.action !== 'acknowledge') return { ok: false, error: 'invalid_action' };
    detail = { action: 'acknowledge' };
  } else if (decision.type === 'contact_conflict') {
    // 'keep' is the do-nothing outcome and the reason this decision exists: HubSpot's
    // value stands, and the captured one stays on the registration for staff to see.
    // 'overwrite' goes back through the outbox like every other HubSpot side effect.
    if (input.action === 'keep') {
      detail = { action: 'keep' };
    } else if (input.action === 'overwrite') {
      if (!decision.registration_id) return { ok: false, error: 'missing_registration' };
      const context = decision.context
        ? (JSON.parse(decision.context) as ContactConflictContext)
        : null;
      if (!context) return { ok: false, error: 'missing_context' };
      const outboxId = await enqueueAttendeeContactSync(env, portalId, {
        registrationId: decision.registration_id,
        eventId: decision.event_id,
        attendeeEmail: context.attendeeEmail,
        attendeeName: context.attendeeName,
        hubspotContactId: context.hubspotContactId,
        details: context.captured,
        force: true,
      });
      detail = { action: 'overwrite', outboxId };
    } else {
      return { ok: false, error: 'invalid_action' };
    }
  } else if (decision.type === 'unpaid_invoice') {
    // VOID is the irreversible one, so it is never the default and never implicit. KEEP
    // closes the decision and leaves the invoice exactly as it is — payable, chaseable, and
    // still the thing a late payment lands against.
    if (!decision.order_id) return { ok: false, error: 'missing_order' };
    if (input.action === 'void') {
      const outboxId = await enqueueInvoiceVoid(env, portalId, decision.order_id);
      if (!outboxId) return { ok: false, error: 'no_invoice_to_void' };
      detail = { action: 'void', outboxId };
    } else if (input.action === 'keep') {
      detail = { action: 'keep' };
    } else {
      return { ok: false, error: 'invalid_action' };
    }
  } else if (decision.type === 'waitlist') {
    const ids = input.waitlistIds ?? [];
    if (ids.length === 0) return { ok: false, error: 'no_waitlisters_selected' };
    const event = await loadEvent(env.DB, portalId, decision.event_id);
    if (!event) return { ok: false, error: 'event_not_found' };
    const offered = await offerToWaitlisters(env, { portalId, event, waitlistIds: ids });
    detail = { action: 'offer', offered };
  } else {
    return { ok: false, error: 'unknown_decision_type' };
  }

  await env.DB.prepare(
    `UPDATE pending_decisions
       SET status = 'resolved', resolved_by = ?1, resolution = ?2, resolved_at = ?3
     WHERE id = ?4`,
  )
    .bind(
      input.resolvedBy ?? null,
      JSON.stringify({ ...input, ...detail }),
      new Date().toISOString(),
      decisionId,
    )
    .run();

  return { ok: true, detail };
}
