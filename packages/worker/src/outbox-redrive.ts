/**
 * Re-driving a DEAD outbox row.
 *
 * Nothing un-deads a row. That is deliberate everywhere else in this file's neighbourhood —
 * `reportOutboxHealth` counts dead rows over a window precisely because the count never
 * goes down — but it leaves one gap that reached a customer, and it is the gap the
 * 2026-09-19 alert on Weld's portal was made of.
 *
 * Two of the three side effects that die have a way back, because the state they failed to
 * write is DERIVABLE from D1 and `reconcileOutbox` re-derives it:
 *
 *   me.register   — `registrations.marketing_event_state_synced = 0` on a paid order says
 *                   HubSpot has never heard of this attendee, so step 2 mints a fresh row.
 *   deal.create /
 *   invoice.create — `orders.hubspot_deal_id` / `_invoice_id` being NULL says the same
 *                   thing about the money, so step 3 mints one.
 *
 * `contact.sync_registration_confirmation` has no such marker. Nothing in D1 records
 * whether the stamp landed — the value lives on the HubSpot contact and nowhere else — so
 * once that row dies, no sweep can tell it needs doing and nobody is ever told. The
 * attendee simply never receives the confirmation email, for good. Four of Weld's bookings
 * are in exactly that state, from the window before the missing-property repair shipped.
 *
 * ## Why this is an operator action and not a sweep
 *
 * Same argument `reportOutboxHealth` makes for reporting and changing nothing: what to do
 * about a dead row depends on WHY it died. A sweep that re-drove dead rows automatically
 * would, against a cause nobody has fixed yet, re-kill each one — and since nothing purges
 * the outbox and nothing un-deads a row, the cost of that is a fresh dead row every
 * fifteen minutes, for ever, burying the real ones. A person reads the diagnostic, fixes
 * the cause, and then re-drives; that ordering is the whole point.
 *
 * ## What makes it safe to re-drive at all
 *
 * Every handler is idempotent by construction — the confirmation handler re-reads the
 * contact and writes nothing when the value already matches, the attendance handlers reuse
 * the row's frozen `stable_interaction_datetime`, the deal and invoice handlers return
 * early once their object exists. So the worst a re-drive can do is repeat work that has
 * already happened.
 *
 * Two things it deliberately does NOT do:
 *
 *  - **It never touches `stable_interaction_datetime`.** Marketing Event attendance writes
 *    are idempotent only because that timestamp is frozen at first attempt; regenerating it
 *    on a retry is the one thing the invariant forbids.
 *  - **It never re-drives a row whose payload will not parse.** That row is permanent by
 *    definition: the dispatcher can do nothing with it but record it, so re-driving is a
 *    guaranteed second death. It is reported as skipped, naming itself, which is more use
 *    than another dead row.
 */

/**
 * The payload keys a failure leaves behind, cleared so the next one speaks for itself.
 *
 * `_dead_at` is one of them: the heartbeat windows its dead count on it, so leaving a stale
 * one on a row that has been sent round again would have the diagnostic report a delivered
 * row as having died, at a time it no longer did.
 */
export const DEATH_MARK_KEYS = [
  '_dead_reason',
  '_dead_at',
  '_last_error',
  '_last_error_at',
] as const;

export interface RedriveScope {
  ids?: string[];
  topic?: string;
  orderId?: string;
  limit: number;
}

export type RedriveScopeResult = { ok: true; scope: RedriveScope } | { ok: false; error: string };

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * How many ids one request may name.
 *
 * The rows returned are already bounded by `limit`, so this bounds the REQUEST rather than
 * the work: the list is interpolated into a `json_each` and echoed back in the response, and
 * neither wants to be unbounded because a caller pasted a file in. Comfortably above any
 * hand-assembled list, and `topic` or `orderId` is the right tool past it.
 */
const MAX_IDS = 500;

function cleanStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed) out.push(trimmed);
  }
  return [...new Set(out)];
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Read a re-drive request, refusing an unscoped one.
 *
 * "Re-drive every dead row on this portal" is a thing an operator may well want, but it has
 * to be something they TYPED. An empty body defaulting to it would make a mis-fired request
 * replay every failure a portal has ever had, which on a portal carrying months of dead
 * rows is a very long afternoon in HubSpot's rate limiter. `ids: []` is likewise a refusal
 * rather than "all": an empty selection is a caller that resolved nothing, not one that
 * meant everything.
 */
export function parseRedriveScope(body: unknown): RedriveScopeResult {
  const input = (body ?? {}) as Record<string, unknown>;

  const ids = cleanStrings(input.ids);
  const topic = cleanString(input.topic);
  const orderId = cleanString(input.orderId);

  if (input.ids !== undefined && ids.length === 0) {
    return { ok: false, error: 'ids was supplied but named no row' };
  }
  if (ids.length > MAX_IDS) {
    return { ok: false, error: `ids named ${ids.length} rows; at most ${MAX_IDS} per request` };
  }
  if (ids.length === 0 && !topic && !orderId) {
    return {
      ok: false,
      error: 'name what to re-drive: at least one of ids, topic or orderId',
    };
  }

  const rawLimit = Number(input.limit ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  return {
    ok: true,
    scope: {
      ...(ids.length ? { ids } : {}),
      ...(topic ? { topic } : {}),
      ...(orderId ? { orderId } : {}),
      limit,
    },
  };
}

/**
 * The payload to store on a row being sent round again: the same one, with the marks of how
 * it died removed.
 *
 * Returns null for a payload that will not parse, which is how the caller tells the one
 * kind of row that must not be re-driven from the rest.
 */
export function clearDeathMarks(payload: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const next = { ...(parsed as Record<string, unknown>) };
  for (const key of DEATH_MARK_KEYS) delete next[key];
  return JSON.stringify(next);
}
