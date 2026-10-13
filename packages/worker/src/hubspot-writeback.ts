/**
 * HubSpot outbox queue consumer.
 *
 * Handles outbox message kinds:
 *   me.create, me.register, me.attend, me.cancel, me.complete
 *   contact.set_join_url, contact.sync_attendee_details, contact.sync_attendance
 *   contact.sync_answers
 *   deal.create
 *   invoice.create
 *   note.create
 *
 * Error model:
 *   429                → RetryableError (respects Retry-After)
 *   5xx                → RetryableError
 *   other 4xx          → PermanentError
 *   RetryableError     → msg.retry(backoff)
 *   PermanentError     → msg.ack + mark outbox row dead
 */

import type { OutboxKind } from '@paddock/shared';
import { isGstFreeTreatment } from '@paddock/shared';
import {
  ATTENDANCE_FIELDS,
  type AttendanceSyncPayload,
  attendancePropertyFor,
  hasAnyAttendanceMapping,
  loadAttendanceContactConfig,
} from './attendance-writeback';
import {
  ATTENDEE_CONTACT_FIELDS,
  type AttendeeContactSyncPayload,
  diffContactDetails,
  hasAnyMapping,
  loadAttendeeContactConfig,
  loadJoinUrlProperty,
  propertyFor,
} from './attendee-contact';
import { formatBookingLineItemName } from './commerce-lines';
import { loadEvent } from './db';
import { createContactConflictDecision } from './decisions';
import { getAccessToken } from './hubspot-oauth';
import { isNoteSyncEnabled, loadStaffNote, type StaffNoteRow } from './notes';
import { handleNotify } from './notify';
import { DEATH_MARK_KEYS } from './outbox-redrive';
// One import back from the module that owns property creation. `properties.ts` takes `hs`
// and `PermanentError` from here, so the two reference each other — both only at call time,
// never during module evaluation, which is what makes that safe.
import { handleQuestionPropertyEnsure, repairMissingProperty } from './properties';
import { type AnswerSyncPayload, sameAnswerValue } from './questions';
import {
  loadRegistrationConfirmationProperty,
  type RegistrationConfirmationPayload,
  shouldStampConfirmation,
} from './registration-confirmation';
import { cancelWebinarRegistration } from './teams';
import { localCalendarDate } from './timezone';
import type { Env } from './types';
import {
  captureVoucherBaseline,
  formatVoucherAmount,
  getVoucherBaseline,
  loadVoucherConfig,
  parseVoucherAmount,
  resolveVoucherUsage,
} from './vouchers';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class RetryableError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'RetryableError';
  }
}

/**
 * How long a `RetryableError` that names no delay waits.
 *
 * Not zero. `msg.retry()` with no delay re-runs the row immediately, so the four queue
 * attempts are spent in milliseconds on a condition that needs seconds — "the deal for this
 * order has not been created yet" being the one that matters, since the invoice cannot be
 * built without it.
 */
const DEFAULT_RETRY_MS = 30 * 1000;

export class PermanentError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    /**
     * HubSpot's raw response body, kept alongside the message rather than only inside it.
     * `missingPropertyNames` below reads the structured `errors[]` out of it: parsing the
     * property name back out of a formatted message string is how that repair would break
     * the first time the message gained a prefix.
     */
    public readonly body?: string,
  ) {
    super(message);
    this.name = 'PermanentError';
  }
}

// ---------------------------------------------------------------------------
// Typed HubSpot fetch helper
// ---------------------------------------------------------------------------

export async function hs(
  token: string,
  method: string,
  url: string,
  body?: unknown,
): Promise<unknown> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  const resp = await fetch(url, init);

  if (resp.ok) {
    const text = await resp.text();
    if (!text) return null;
    return JSON.parse(text) as unknown;
  }

  if (resp.status === 429) {
    const retryAfterHeader = resp.headers.get('Retry-After');
    const retryAfterMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : 60_000;
    throw new RetryableError(`HubSpot 429 rate limit`, retryAfterMs);
  }

  if (resp.status >= 500) {
    throw new RetryableError(`HubSpot ${resp.status} server error`);
  }

  // 4xx (not 429) — permanent
  let detail = '';
  try {
    detail = await resp.text();
  } catch {
    // ignore
  }
  throw new PermanentError(
    `HubSpot ${resp.status} ${method} ${url}: ${detail}`,
    resp.status,
    detail,
  );
}

// ---------------------------------------------------------------------------
// A property the portal does not have must not cost a booking its write-back
// ---------------------------------------------------------------------------

/**
 * The property names a HubSpot 400 says do not exist.
 *
 * HubSpot answers a write naming an unknown property with a VALIDATION_ERROR whose
 * `errors[]` carry `code: 'PROPERTY_DOESNT_EXIST'` and the name in
 * `context.propertyName`. Older shapes put the name on the error itself, so both are read.
 * Anything else — a bad value, a missing scope, a malformed body — returns nothing here and
 * the caller rethrows, because those are not something a retry can route around.
 */
export function missingPropertyNames(err: unknown): string[] {
  if (!(err instanceof PermanentError) || err.statusCode !== 400 || !err.body) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(err.body);
  } catch {
    return [];
  }
  const errors = (parsed as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return [];
  const names = new Set<string>();
  for (const entry of errors) {
    const detail = entry as {
      code?: unknown;
      name?: unknown;
      context?: { propertyName?: unknown };
    };
    if (detail.code !== 'PROPERTY_DOESNT_EXIST') continue;
    const fromContext = detail.context?.propertyName;
    if (Array.isArray(fromContext)) {
      for (const name of fromContext) if (typeof name === 'string') names.add(name);
    } else if (typeof fromContext === 'string') {
      names.add(fromContext);
    }
    if (typeof detail.name === 'string') names.add(detail.name);
  }
  return [...names];
}

/**
 * Write properties to a HubSpot object, surviving a property the portal does not have.
 *
 * A 400 is a PermanentError, so until now a single unknown property name killed the whole
 * outbox row — and on the money path that is a customer left on "preparing your invoice"
 * for two minutes with no invoice behind it, over a field that had nothing to do with the
 * money. Weld's live portal is the worked example: every booking's registration
 * confirmation died on `last_event_engine_registration_id does not exist`, because that
 * portal authorised before migration 0040 and nobody has run provisioning since.
 *
 * Two outcomes, in this order:
 *
 *  1. **It is ours → create it and write again.** Phase 6.1 already says the app provisions
 *     the properties its write-backs target; `repairMissingProperty` resolves the same
 *     managed list through the same tenant mapping and creates through the same call. This
 *     is what makes the confirmation actually go out rather than merely stop erroring.
 *  2. **It is not ours → drop it and write again.** A portal with no `abn` contact field
 *     gets a contact without an ABN and an invoice that exists, which is the right trade
 *     every time. Logged at error with the names, so it is fixable rather than silent.
 *
 * Exactly one retry. If the write is rejected again the error stands: a loop that keeps
 * dropping fields would eventually PATCH nothing and call it success.
 *
 * `provision` is optional because several callers hold only a token. Without it the repair
 * degrades to the drop — worse, but never worse than the dead row it replaces.
 */
export async function writeProperties(
  token: string,
  method: 'POST' | 'PATCH',
  url: string,
  properties: Record<string, string>,
  context: {
    /** What is being written, for the log line. */
    topic: string;
    portalId?: string;
    /** Supplied where the caller has an Env: lets a property the app owns be created. */
    provision?: (name: string) => Promise<boolean>;
  },
): Promise<unknown> {
  try {
    return await hs(token, method, url, { properties });
  } catch (err) {
    const missing = missingPropertyNames(err);
    if (missing.length === 0) throw err;

    const created: string[] = [];
    const dropped: string[] = [];
    for (const name of missing) {
      let repaired = false;
      if (context.provision) {
        try {
          repaired = await context.provision(name);
        } catch {
          repaired = false;
        }
      }
      (repaired ? created : dropped).push(name);
    }

    const remaining = Object.fromEntries(
      Object.entries(properties).filter(([name]) => !dropped.includes(name)),
    );

    console.log(
      JSON.stringify({
        level: dropped.length > 0 ? 'error' : 'warn',
        event: 'hubspot_property_missing',
        topic: context.topic,
        portalId: context.portalId,
        url,
        created,
        dropped,
        // Named so the remedy is in the log: POST /manage/onboarding/properties creates
        // every property this app writes, under the tenant's own mapping.
        remedy:
          dropped.length > 0
            ? 'Create these on the portal (or map them in tenants), then re-run the row.'
            : 'Created on demand. Run POST /manage/onboarding/properties to provision the rest.',
      }),
    );

    // Everything the write carried was dropped. There is nothing left to say to HubSpot,
    // and a call that writes nothing is not a write: the original error stands, so the row
    // dies with `outbox_dead` naming the property. That is the honest outcome for a row
    // whose whole purpose is the field the portal does not have — the registration
    // confirmation is one property, and reporting it delivered would mean an attendee who
    // never got an email and nothing anywhere saying why.
    if (Object.keys(remaining).length === 0) throw err;

    return await hs(token, method, url, { properties: remaining });
  }
}

/**
 * The `provision` hook for a handler that has an Env in hand. Returns whether the property
 * now exists, which is the only thing {@link writeProperties} needs to decide between
 * writing again and dropping the field.
 */
function propertyRepair(env: Env, portalId: string, token: string) {
  return async (name: string): Promise<boolean> => {
    const result = await repairMissingProperty(env, portalId, token, name);
    return result.status === 'created';
  };
}

// ---------------------------------------------------------------------------
// Association type lookup (v4 API — verified against portal, not hard-coded)
// ---------------------------------------------------------------------------

interface AssocTypeResult {
  results: Array<{
    typeId: number;
    label: string | null;
    category: string;
  }>;
}

const assocTypeCache = new Map<string, number>();

async function resolveAssocTypeId(
  token: string,
  fromObject: string,
  toObject: string,
  label: string,
): Promise<number> {
  const cacheKey = `${fromObject}→${toObject}:${label}`;
  const cached = assocTypeCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const url = `https://api.hubapi.com/crm/v4/associations/${fromObject}/${toObject}/labels`;
  const data = (await hs(token, 'GET', url)) as AssocTypeResult;
  for (const entry of data.results) {
    if (
      entry.label === label ||
      (label === 'PRIMARY' && entry.label === null && entry.category === 'HUBSPOT_DEFINED')
    ) {
      assocTypeCache.set(cacheKey, entry.typeId);
      return entry.typeId;
    }
  }
  // Fall back to first HUBSPOT_DEFINED entry
  const primary = data.results.find((r) => r.category === 'HUBSPOT_DEFINED');
  if (primary) {
    assocTypeCache.set(cacheKey, primary.typeId);
    return primary.typeId;
  }
  throw new PermanentError(`No association type found for ${fromObject}→${toObject} (${label})`);
}

// ---------------------------------------------------------------------------
// HubSpot token helper (per-tenant)
// ---------------------------------------------------------------------------

async function loadHubSpotToken(env: Env, portalId: string): Promise<string> {
  try {
    return await getAccessToken(env, portalId);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new RetryableError(
      `HubSpot OAuth token unavailable for portal ${portalId}: ${reason}`,
      5 * 60 * 1000,
    );
  }
}

// ---------------------------------------------------------------------------
// Outbox row type
// ---------------------------------------------------------------------------

interface OutboxRow {
  id: string;
  portal_id: string;
  topic: OutboxKind;
  payload: string;
  status: string;
  attempts: number;
  stable_interaction_datetime: string | null;
}

// ---------------------------------------------------------------------------
// Mark outbox row dead (permanent failure)
// ---------------------------------------------------------------------------

/**
 * How many times a row may fail before it stops being retried and starts being NOTICED.
 *
 * There was no ceiling: a `RetryableError` re-drove for ever, because `reconcileOutbox`
 * re-sends every `failed` row whose `next_attempt_at` has passed and nothing ever ages one
 * out. Weld's live portal carried `invoice.create` rows at 88 and 136 attempts — bookings
 * with no invoice, retrying every fifteen minutes since the day before, and nothing in the
 * error logs because the retry path logs at WARN. A row that has failed this many times is
 * not going to fix itself, and the useful thing left to do with it is say so where a person
 * looks. It can still be re-driven by hand once the cause is fixed.
 *
 * Generous on purpose: at four queue attempts per reconcile sweep this is roughly a day of
 * a HubSpot outage before anything gives up, and the token failure path (5 minute backoff)
 * is longer still.
 */
const MAX_OUTBOX_ATTEMPTS = 96;

/**
 * Deliver a row, and stop it carrying the reason it failed on the way.
 *
 * `recordFailureReason` writes `_last_error` onto the row so a retrying row can say what is
 * wrong with it, and nothing ever took it off again. A row that failed and then SUCCEEDED
 * kept it, and the diagnostic reports `reason: _dead_reason ?? _last_error` whatever the
 * status — so a delivered `deal.create` on Weld's portal read back a HubSpot 403
 * `MISSING_SCOPES` it had recovered from days earlier. Read during an incident, that is a
 * fault being reported against a row that does not have one, which is the same confusion
 * the heartbeat's newest-death age exists to end.
 *
 * `attempts` is what records that a row struggled, and it is the honest place for it: a
 * count nobody can mistake for a live failure. The narrative of a fault already fixed
 * belongs in the logs, not stamped on a delivered row.
 *
 * Same keys the re-drive strips, from the same list, so the two cannot drift. Wrapped in
 * `json_valid` like every other payload read: SQLite RAISES on `json_remove` of malformed
 * JSON, and a row that will not parse must still be able to reach a terminal status.
 */
const MARK_DELIVERED_SQL = `UPDATE outbox
      SET status = 'delivered',
          attempts = attempts + 1,
          payload = IIF(
            json_valid(payload),
            json_remove(payload, ${DEATH_MARK_KEYS.map((key) => `'$.${key}'`).join(', ')}),
            payload
          )
    WHERE id = ?1`;

/**
 * Record why a row failed THIS time, on the row.
 *
 * `_dead_reason` only ever existed for rows that died, so a `failed` row that had been
 * retrying for hours said nothing at all about what was wrong with it — the reason lived
 * only in a warn-level log line, which is exactly where nobody was looking. This is the
 * same field `markDead` writes, under a different key, so the outbox diagnostic can answer
 * "why is this stuck" for a live row as well as a dead one.
 *
 * Best-effort, and never allowed to fail the retry it is describing.
 */
async function recordFailureReason(
  db: D1Database,
  outboxId: string,
  reason: string,
): Promise<void> {
  try {
    await db
      .prepare(`UPDATE outbox SET payload = json_patch(payload, ?1) WHERE id = ?2`)
      .bind(
        JSON.stringify({ _last_error: reason, _last_error_at: new Date().toISOString() }),
        outboxId,
      )
      .run();
  } catch {
    // A payload json_patch cannot touch is handled by the dispatcher, not here.
  }
}

/**
 * Stop retrying a row, and record both WHY it stopped and WHEN.
 *
 * `_dead_at` is the timestamp the heartbeat counts a death by. `created_at` cannot do that
 * job: it is when the BOOKING happened, so a row that retried for a day and then died was
 * never counted as a recent death at all, and a row that died at hour 23 of its life left
 * the alert an hour later — an alert you miss by not looking for sixty minutes. It lives in
 * the payload beside `_dead_reason` and `_last_error_at` rather than in a column of its own
 * so that a portal whose outbox schema has drifted (Ref 217) still records it, and so this
 * cannot become one more way for `markDead` to fail on the row that most needs it.
 */
async function markDead(db: D1Database, outboxId: string, reason: string): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE outbox SET status = 'dead', payload = json_patch(payload, ?1)
         WHERE id = ?2`,
      )
      .bind(JSON.stringify({ _dead_reason: reason, _dead_at: new Date().toISOString() }), outboxId)
      .run();
  } catch {
    // `json_patch` needs both sides to be well-formed JSON, and the row this is most
    // urgently called for is one whose payload is not (see the dispatcher below). Losing
    // the reason is a shame; leaving the row alive to be re-driven by the reconcile sweep
    // every fifteen minutes, forever, is the fault. Record the status either way.
    await db.prepare(`UPDATE outbox SET status = 'dead' WHERE id = ?1`).bind(outboxId).run();
  }
  console.log(JSON.stringify({ level: 'error', event: 'outbox_dead', outboxId, reason }));
}

// ---------------------------------------------------------------------------
// Load a single outbox row by id
// ---------------------------------------------------------------------------

async function loadOutboxRow(db: D1Database, outboxId: string): Promise<OutboxRow | null> {
  return db
    .prepare(
      'SELECT id, portal_id, topic, payload, status, attempts, stable_interaction_datetime FROM outbox WHERE id = ?1',
    )
    .bind(outboxId)
    .first<OutboxRow>();
}

// ---------------------------------------------------------------------------
// Queue message body shapes
// ---------------------------------------------------------------------------

interface OutboxSignal {
  kind: string;
  portalId: string;
  outboxId?: string;
  // convenience carry-along fields (not required — outbox row is authoritative)
  registrationId?: string;
  orderId?: string;
}

// ---------------------------------------------------------------------------
// Marketing Events helpers
// ---------------------------------------------------------------------------

const HS_API = 'https://api.hubapi.com';

type BookingKind = 'event' | 'course';

interface DealRoutingConfig {
  eventsPipelineId: string;
  eventsRegisteredStageId: string | null;
  eventsRegisteredStageLabel: string;
  trainingPipelineId: string;
  trainingInvoiceSentStageId: string | null;
  trainingInvoiceSentStageLabel: string;
  dealTypePropertyName: string | null;
  eventDealTypeLabel: string;
  courseDealTypeLabel: string;
}

interface DealRouting {
  bookingKind: BookingKind;
  pipelineId: string;
  stageId: string;
  dealTypePropertyName: string | null;
  dealTypeLabel: string;
}

interface DealPropertyResult {
  type: string;
  fieldType: string;
  options?: Array<{ label: string; value: string; hidden?: boolean }>;
}

interface DealPipelineResult {
  id: string;
  stages: Array<{ id: string; label: string; archived?: boolean }>;
}

const DEFAULT_EVENTS_PIPELINE_ID = '1012448712';
const DEFAULT_EVENTS_REGISTERED_STAGE_LABEL = 'Registered';
const DEFAULT_TRAINING_PIPELINE_ID = '1874500055';
const DEFAULT_TRAINING_INVOICE_SENT_STAGE_ID = '3221463490';
const DEFAULT_TRAINING_INVOICE_SENT_STAGE_LABEL = 'Invoice Sent';
const DEFAULT_DEAL_TYPE_PROPERTY_NAME = 'dealtype';
const DEFAULT_EVENT_DEAL_TYPE_LABEL = 'Event Registration';
const DEFAULT_COURSE_DEAL_TYPE_LABEL = 'Training Course';

const pipelineStageCache = new Map<string, string>();
const dealTypeCache = new Map<string, string | null>();

function normalizeBookingKind(value: unknown): BookingKind {
  return String(value ?? '')
    .trim()
    .toLowerCase() === 'event'
    ? 'event'
    : 'course';
}

async function meAttendance(
  token: string,
  externalEventId: string,
  externalAccountId: string,
  state: 'register' | 'attend' | 'cancel' | 'noshow',
  email: string,
  interactionDateTime: string,
): Promise<void> {
  const url = `${HS_API}/marketing/v3/marketing-events/attendance/${encodeURIComponent(externalEventId)}/${state}/email-create?externalAccountId=${encodeURIComponent(externalAccountId)}`;
  await hs(token, 'POST', url, {
    inputs: [
      {
        email,
        interactionDateTime,
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Contact upsert (create-or-update by email)
// ---------------------------------------------------------------------------

interface ContactUpsertResult {
  id: string;
}

interface ContactSearchResult {
  results: Array<{ id: string }>;
}

function nameToContactProperties(
  email: string,
  name: string | null | undefined,
  extra: Record<string, string> = {},
): Record<string, string> {
  const trimmed = (name ?? '').trim();
  const parts = trimmed.split(/\s+/).filter(Boolean);
  return {
    email,
    ...(trimmed
      ? {
          firstname: parts[0] ?? trimmed,
          lastname: parts.slice(1).join(' ') || parts[0] || trimmed,
        }
      : {}),
    ...extra,
  };
}

async function findContactIdByEmail(token: string, email: string): Promise<string | null> {
  const data = (await hs(token, 'POST', `${HS_API}/crm/v3/objects/contacts/search`, {
    filterGroups: [
      {
        filters: [
          {
            propertyName: 'email',
            operator: 'EQ',
            value: email,
          },
        ],
      },
    ],
    properties: ['email'],
    limit: 1,
  })) as ContactSearchResult;

  return data.results[0]?.id ?? null;
}

export async function upsertContact(
  token: string,
  email: string,
  properties: Record<string, string>,
  /**
   * Optional repair context. A contact write carries whatever the booking supplied — an
   * ABN, a phone number, a mapped answer — and a portal missing one of those fields used
   * to take the whole write-back down with it, invoice included. See
   * {@link writeProperties}.
   */
  repair: { topic: string; portalId?: string; provision?: (name: string) => Promise<boolean> } = {
    topic: 'contact.upsert',
  },
): Promise<string> {
  const existingId = await findContactIdByEmail(token, email);
  if (existingId) {
    const data = (await writeProperties(
      token,
      'PATCH',
      `${HS_API}/crm/v3/objects/contacts/${existingId}`,
      properties,
      repair,
    )) as ContactUpsertResult;
    return data.id;
  }

  try {
    const data = (await writeProperties(
      token,
      'POST',
      `${HS_API}/crm/v3/objects/contacts`,
      properties,
      repair,
    )) as ContactUpsertResult;
    return data.id;
  } catch (err) {
    // A concurrent queue worker may have created the contact after our search.
    // In that case, resolve the id and continue idempotently.
    if (err instanceof PermanentError && err.statusCode === 409) {
      const id = await findContactIdByEmail(token, email);
      if (id) return id;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Resolve contacts for an order (buyer + all attendees), store contact ids
// ---------------------------------------------------------------------------

interface RegistrationRow {
  id: string;
  attendee_email: string;
  attendee_name: string;
  hubspot_contact_id: string | null;
}

interface OrderRow {
  id: string;
  buyer_email: string;
  buyer_name: string;
  buyer_abn: string | null;
  hubspot_contact_id?: string | null;
}

async function resolveContactsForOrder(
  token: string,
  db: D1Database,
  order: OrderRow,
  registrations: RegistrationRow[],
  repair: { topic: string; portalId?: string } = { topic: 'contact.upsert' },
): Promise<Map<string, string>> {
  // Returns email → hubspot_contact_id
  const emailToId = new Map<string, string>();

  // Upsert buyer
  const buyerProps = nameToContactProperties(
    order.buyer_email,
    order.buyer_name,
    order.buyer_abn ? { abn: order.buyer_abn } : {},
  );
  const buyerContactId = await upsertContact(token, order.buyer_email, buyerProps, repair);
  emailToId.set(order.buyer_email, buyerContactId);

  // Upsert each attendee, store hubspot_contact_id on registration
  for (const reg of registrations) {
    let contactId = emailToId.get(reg.attendee_email);
    if (!contactId) {
      const props = nameToContactProperties(reg.attendee_email, reg.attendee_name);
      contactId = await upsertContact(token, reg.attendee_email, props, repair);
      emailToId.set(reg.attendee_email, contactId);
    }
    if (reg.hubspot_contact_id !== contactId) {
      await db
        .prepare('UPDATE registrations SET hubspot_contact_id = ?1, updated_at = ?2 WHERE id = ?3')
        .bind(contactId, new Date().toISOString(), reg.id)
        .run();
    }
  }

  return emailToId;
}

// ---------------------------------------------------------------------------
// Handler: me.create
// ---------------------------------------------------------------------------

function extractObjectId(value: unknown, depth = 0): string | null {
  if (depth > 6) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const candidate = extractObjectId(item, depth + 1);
      if (candidate) return candidate;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  for (const key of ['objectId', 'marketingEventId', 'hubspotMarketingEventId', 'id']) {
    const candidate = obj[key];
    if (typeof candidate === 'string' && candidate) return candidate;
    if (typeof candidate === 'number') return String(candidate);
  }
  for (const nested of Object.values(obj)) {
    const candidate = extractObjectId(nested, depth + 1);
    if (candidate) return candidate;
  }
  return null;
}

async function handleMeCreate(
  token: string,
  payload: Record<string, unknown>,
  db?: D1Database,
): Promise<void> {
  const {
    externalEventId,
    externalAccountId,
    name,
    startDateTime,
    endDateTime,
    eventType,
    eventOrganizer,
    eventUrl,
    customProperties,
  } = payload as {
    externalEventId: string;
    externalAccountId: string;
    name: string;
    startDateTime: string;
    endDateTime: string;
    eventType?: string;
    eventOrganizer?: string;
    eventUrl?: string;
    customProperties?: Record<string, string>;
  };

  const input: Record<string, unknown> = {
    externalEventId,
    externalAccountId,
    eventName: name,
    startDateTime,
    endDateTime,
    eventType: eventType ?? 'CONFERENCE',
    eventOrganizer: (eventOrganizer ?? '').trim() || 'Weld Australia',
    eventCancelled: false,
    eventCompleted: false,
  };

  if (eventUrl) input.eventUrl = eventUrl;
  if (customProperties) {
    input.customProperties = Object.entries(customProperties).map(([name, value]) => ({
      name,
      value,
    }));
  }

  const result = await hs(token, 'POST', `${HS_API}/marketing/v3/marketing-events/events/upsert`, {
    inputs: [input],
  });

  const objectId = extractObjectId(result);
  if (db && objectId) {
    await db
      .prepare(
        `UPDATE events
         SET hubspot_marketing_event_object_id = ?1, updated_at = ?2
         WHERE portal_id = ?3 AND hubspot_event_id = ?4`,
      )
      .bind(objectId, new Date().toISOString(), externalAccountId, externalEventId)
      .run();

    try {
      await associateExistingDealsToMarketingEvent(token, db, externalAccountId, externalEventId);
    } catch (err) {
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'marketing_event_existing_deal_association_skipped',
          externalAccountId,
          externalEventId,
          reason: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Handler: me.complete
// ---------------------------------------------------------------------------

/**
 * Mark a Marketing Event complete once its webinar has ended.
 *
 * HubSpot's complete endpoint takes a BODY carrying the event's real start and end, and the
 * worker sent none: every row died on `request body expected, none found`, so no Weld event
 * has ever been completed in HubSpot. The two timestamps ride in the payload now; a row
 * enqueued before that (or one whose event has since been edited) falls back to reading the
 * event out of D1, which is where `finalizeEndedWebinars` got them from in the first place.
 */
async function handleMeComplete(
  token: string,
  db: D1Database,
  payload: Record<string, unknown>,
): Promise<void> {
  const { externalEventId, externalAccountId } = payload as {
    externalEventId: string;
    externalAccountId: string;
  };

  let startDateTime = typeof payload.startDateTime === 'string' ? payload.startDateTime : null;
  let endDateTime = typeof payload.endDateTime === 'string' ? payload.endDateTime : null;
  if (!startDateTime || !endDateTime) {
    const event = await db
      .prepare('SELECT starts_at, ends_at FROM events WHERE hubspot_event_id = ?1')
      .bind(externalEventId)
      .first<{ starts_at: string | null; ends_at: string | null }>();
    startDateTime = startDateTime ?? event?.starts_at ?? null;
    endDateTime = endDateTime ?? event?.ends_at ?? null;
  }
  // An event with no dates in D1 is not something a retry recovers, and completing it with
  // invented ones would write a wrong record onto the portal's own reporting.
  if (!startDateTime || !endDateTime) {
    throw new PermanentError(
      `me.complete needs the event's start and end, and ${externalEventId} has neither stored nor supplied`,
    );
  }

  await hs(
    token,
    'POST',
    `${HS_API}/marketing/v3/marketing-events/events/${encodeURIComponent(externalEventId)}/complete?externalAccountId=${encodeURIComponent(externalAccountId)}`,
    { startDateTime, endDateTime },
  );
}

// ---------------------------------------------------------------------------
// Deal routing helpers
// ---------------------------------------------------------------------------

async function loadDealRoutingConfig(db: D1Database, portalId: string): Promise<DealRoutingConfig> {
  const row = await db
    .prepare(
      `SELECT events_pipeline_id, events_registered_stage_id, events_registered_stage_label,
              training_pipeline_id, training_invoice_sent_stage_id, training_invoice_sent_stage_label,
              deal_type_property_name, event_deal_type_label, course_deal_type_label
       FROM tenants WHERE portal_id = ?1`,
    )
    .bind(portalId)
    .first<{
      events_pipeline_id: string | null;
      events_registered_stage_id: string | null;
      events_registered_stage_label: string | null;
      training_pipeline_id: string | null;
      training_invoice_sent_stage_id: string | null;
      training_invoice_sent_stage_label: string | null;
      deal_type_property_name: string | null;
      event_deal_type_label: string | null;
      course_deal_type_label: string | null;
    }>();

  return {
    eventsPipelineId: row?.events_pipeline_id || DEFAULT_EVENTS_PIPELINE_ID,
    eventsRegisteredStageId: row?.events_registered_stage_id || null,
    eventsRegisteredStageLabel:
      row?.events_registered_stage_label || DEFAULT_EVENTS_REGISTERED_STAGE_LABEL,
    trainingPipelineId: row?.training_pipeline_id || DEFAULT_TRAINING_PIPELINE_ID,
    trainingInvoiceSentStageId:
      row?.training_invoice_sent_stage_id || DEFAULT_TRAINING_INVOICE_SENT_STAGE_ID,
    trainingInvoiceSentStageLabel:
      row?.training_invoice_sent_stage_label || DEFAULT_TRAINING_INVOICE_SENT_STAGE_LABEL,
    dealTypePropertyName: row?.deal_type_property_name || DEFAULT_DEAL_TYPE_PROPERTY_NAME,
    eventDealTypeLabel: row?.event_deal_type_label || DEFAULT_EVENT_DEAL_TYPE_LABEL,
    courseDealTypeLabel: row?.course_deal_type_label || DEFAULT_COURSE_DEAL_TYPE_LABEL,
  };
}

async function resolveDealStageId(
  token: string,
  pipelineId: string,
  configuredStageId: string | null,
  stageLabel: string,
): Promise<string> {
  if (configuredStageId) return configuredStageId;

  const cacheKey = `${pipelineId}:${stageLabel.toLowerCase()}`;
  const cached = pipelineStageCache.get(cacheKey);
  if (cached) return cached;

  const pipeline = (await hs(
    token,
    'GET',
    `${HS_API}/crm/v3/pipelines/deals/${encodeURIComponent(pipelineId)}`,
  )) as DealPipelineResult;

  const stage = pipeline.stages.find(
    (candidate) =>
      !candidate.archived && candidate.label.toLowerCase() === stageLabel.toLowerCase(),
  );
  if (!stage) {
    throw new PermanentError(
      `Deal stage "${stageLabel}" not found in HubSpot deal pipeline ${pipelineId}`,
    );
  }

  pipelineStageCache.set(cacheKey, stage.id);
  return stage.id;
}

async function resolveDealRouting(
  token: string,
  db: D1Database,
  portalId: string,
  bookingKindValue: unknown,
): Promise<DealRouting> {
  const bookingKind = normalizeBookingKind(bookingKindValue);
  const config = await loadDealRoutingConfig(db, portalId);

  if (bookingKind === 'event') {
    return {
      bookingKind,
      pipelineId: config.eventsPipelineId,
      stageId: await resolveDealStageId(
        token,
        config.eventsPipelineId,
        config.eventsRegisteredStageId,
        config.eventsRegisteredStageLabel,
      ),
      dealTypePropertyName: config.dealTypePropertyName,
      dealTypeLabel: config.eventDealTypeLabel,
    };
  }

  return {
    bookingKind,
    pipelineId: config.trainingPipelineId,
    stageId: await resolveDealStageId(
      token,
      config.trainingPipelineId,
      config.trainingInvoiceSentStageId,
      config.trainingInvoiceSentStageLabel,
    ),
    dealTypePropertyName: config.dealTypePropertyName,
    dealTypeLabel: config.courseDealTypeLabel,
  };
}

async function resolveDealTypePropertyValue(
  token: string,
  propertyName: string | null,
  desiredLabel: string,
): Promise<string | null> {
  if (!propertyName || !desiredLabel) return null;

  const cacheKey = `${propertyName}:${desiredLabel.toLowerCase()}`;
  if (dealTypeCache.has(cacheKey)) return dealTypeCache.get(cacheKey) ?? null;

  try {
    const property = (await hs(
      token,
      'GET',
      `${HS_API}/crm/v3/properties/deals/${encodeURIComponent(propertyName)}`,
    )) as DealPropertyResult;

    const options = property.options ?? [];
    if (options.length > 0) {
      const option = options.find(
        (candidate) =>
          !candidate.hidden &&
          (candidate.value.toLowerCase() === desiredLabel.toLowerCase() ||
            candidate.label.toLowerCase() === desiredLabel.toLowerCase()),
      );
      const value = option?.value ?? null;
      dealTypeCache.set(cacheKey, value);
      return value;
    }

    if (property.type === 'string' || property.fieldType === 'text') {
      dealTypeCache.set(cacheKey, desiredLabel);
      return desiredLabel;
    }
  } catch (err) {
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'deal_type_property_unavailable',
        propertyName,
        desiredLabel,
        reason: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  dealTypeCache.set(cacheKey, null);
  return null;
}

// ---------------------------------------------------------------------------
// Handler: me.register / me.attend / me.cancel
// ---------------------------------------------------------------------------

async function handleMeAttendance(
  token: string,
  db: D1Database,
  row: OutboxRow,
  state: 'register' | 'attend' | 'cancel',
): Promise<void> {
  const payload = JSON.parse(row.payload) as {
    registrationId: string;
    attendeeEmail: string;
    hubspotContactId: string | null;
    hubspotEventId: string;
    externalAccountId: string;
  };

  const reg = await db
    .prepare(
      'SELECT attendee_email, attendee_name, hubspot_contact_id FROM registrations WHERE id = ?1',
    )
    .bind(payload.registrationId)
    .first<{
      attendee_email: string;
      attendee_name: string;
      hubspot_contact_id: string | null;
    }>();

  if (reg) {
    const contactId =
      reg.hubspot_contact_id ??
      payload.hubspotContactId ??
      (await upsertContact(
        token,
        reg.attendee_email,
        nameToContactProperties(reg.attendee_email, reg.attendee_name),
      ));

    if (reg.hubspot_contact_id !== contactId) {
      await db
        .prepare('UPDATE registrations SET hubspot_contact_id = ?1, updated_at = ?2 WHERE id = ?3')
        .bind(contactId, new Date().toISOString(), payload.registrationId)
        .run();
    }
  }

  const event = await db
    .prepare(
      `SELECT title, starts_at, ends_at FROM events
       WHERE portal_id = ?1 AND hubspot_event_id = ?2`,
    )
    .bind(payload.externalAccountId, payload.hubspotEventId)
    .first<{ title: string; starts_at: string; ends_at: string }>();

  if (event) {
    await handleMeCreate(
      token,
      {
        externalEventId: payload.hubspotEventId,
        externalAccountId: payload.externalAccountId,
        name: event.title,
        startDateTime: event.starts_at,
        endDateTime: event.ends_at,
        eventType: 'CONFERENCE',
      },
      db,
    );
  }

  const interactionDateTime = row.stable_interaction_datetime ?? new Date().toISOString();

  await meAttendance(
    token,
    payload.hubspotEventId,
    payload.externalAccountId,
    state,
    payload.attendeeEmail,
    interactionDateTime,
  );

  // Mirror state to registration for drift detection
  const meState = state === 'register' ? 1 : state === 'attend' ? 2 : 0;
  await db
    .prepare(
      `UPDATE registrations SET marketing_event_state_synced = ?1, updated_at = ?2 WHERE id = ?3`,
    )
    .bind(meState, new Date().toISOString(), payload.registrationId)
    .run();
}

// ---------------------------------------------------------------------------
// Handler: contact.upsert (standalone create-or-update by email — used by transfer)
// ---------------------------------------------------------------------------

async function handleContactUpsert(
  token: string,
  db: D1Database,
  payload: Record<string, unknown>,
): Promise<void> {
  const { email, name, registrationId } = payload as {
    email: string;
    name: string;
    registrationId?: string;
  };
  const contactId = await upsertContact(token, email, {
    email,
    firstname: name.split(' ')[0] ?? name,
    lastname: name.split(' ').slice(1).join(' ') || name,
  });
  // Stamp the resolved contact id back onto the registration (transfer leaves it null).
  if (registrationId) {
    await db
      .prepare('UPDATE registrations SET hubspot_contact_id = ?1, updated_at = ?2 WHERE id = ?3')
      .bind(contactId, new Date().toISOString(), registrationId)
      .run();
  }
}

// ---------------------------------------------------------------------------
// Handler: payment.refund (full → void the invoice; partial → refund the amount, grossed
// up to the tax HubSpot put on the invoice — see grossUpRefundToInvoiceTax below)
//
// Full refunds void the HubSpot invoice (hs_invoice_status = voided), which drives the
// Stripe refund and the Xero credit note via Data Sync — the same path the void webhook
// reconciles against (idempotent: the resulting webhook finds the order already refunded).
// Partial refunds issue a refund of the computed amount against the invoice's payment.
//
// A HubSpot invoice has no "cancelled" status — voided is the only terminal state — so an
// expired hold's unpaid invoice is closed the same way a real refund is. That is fine while
// the order is genuinely dead, and wrong the moment it is not: voiding is IRREVERSIBLE in
// HubSpot (a voided invoice cannot be reopened, and the buyer's payment link is gone for
// good), and `expireHold` enqueues this row at expiry while it drains later. In the gap the
// booking can come back to life — a payment lands and the order goes needs_review for an
// owner to honour, or staff reissue the invoice — and voiding then kills a live invoice
// belonging to an order that is no longer cancelled. So an expired-hold void re-reads the
// order at DRAIN time and stands down if the booking recovered. Every other reason voids as
// asked: they name an invoice that a decision already settled.
// ---------------------------------------------------------------------------

async function handlePaymentRefund(
  token: string,
  db: D1Database,
  payload: Record<string, unknown>,
): Promise<void> {
  const { hsInvoiceId, amountCents, kind, reason, orderId, registrationId } = payload as {
    hsInvoiceId: string | null;
    amountCents: number;
    kind: string;
    reason?: string;
    orderId?: string;
    // Present on the per-seat cancel path, which is what lets the gross-up below use the
    // refunded seat's own tax treatment rather than the invoice's blended one.
    registrationId?: string;
  };
  if (!hsInvoiceId) return; // free order or no invoice — nothing to refund in HubSpot

  if (reason === 'expired_hold' && orderId) {
    const order = await db
      .prepare('SELECT status FROM orders WHERE id = ?1')
      .bind(orderId)
      .first<{ status: string }>();
    // Gone entirely is not a reason to void a stranger's invoice either.
    if (order?.status !== 'cancelled') return;
  }

  if (kind === 'full') {
    await hs(token, 'PATCH', `${HS_API}/crm/v3/objects/invoices/${hsInvoiceId}`, {
      properties: { hs_invoice_status: 'voided' },
    });
    return;
  }

  if (kind === 'partial') {
    // Resolve the payment associated with the invoice, then refund the computed amount.
    const assoc = (await hs(
      token,
      'GET',
      `${HS_API}/crm/v4/objects/invoices/${hsInvoiceId}/associations/payments`,
    )) as { results?: Array<{ toObjectId: string }> };
    const paymentId = assoc.results?.[0]?.toObjectId;
    if (!paymentId) {
      // No captured payment to refund against (e.g. invoice never paid). Nothing to do.
      return;
    }
    const refundCents = await grossUpRefundToInvoiceTax(
      token,
      db,
      hsInvoiceId,
      amountCents,
      orderId,
      registrationId,
    );
    await hs(token, 'POST', `${HS_API}/commerce/v3/payments/${paymentId}/refunds`, {
      amount: (refundCents / 100).toFixed(2),
      reason: 'REQUESTED_BY_CUSTOMER',
    });
  }
}

/**
 * The tax treatment of the seat a refund is FOR, not of the invoice it sits on.
 *
 * `registrationId` is on the per-seat cancel payload, so the usual case resolves exactly.
 * Without one (a whole-order refund) the order's seats are read instead, and they only
 * answer when they agree — a mixed order cannot say what one unidentified refund was for.
 */
async function resolveRefundTaxTreatment(
  db: D1Database,
  orderId: string | undefined,
  registrationId: string | undefined,
): Promise<'gst_free' | 'taxable' | 'unknown'> {
  try {
    if (registrationId) {
      const row = await db
        .prepare(
          `SELECT tt.tax_treatment AS treatment
             FROM registrations r
             JOIN ticket_types tt ON tt.id = r.ticket_type_id
            WHERE r.id = ?1`,
        )
        .bind(registrationId)
        .first<{ treatment: string | null }>();
      if (!row) return 'unknown';
      return isGstFreeTreatment(row.treatment) ? 'gst_free' : 'taxable';
    }
    if (!orderId) return 'unknown';
    const rows = await db
      .prepare(
        `SELECT DISTINCT tt.tax_treatment AS treatment
           FROM registrations r
           JOIN ticket_types tt ON tt.id = r.ticket_type_id
          WHERE r.order_id = ?1`,
      )
      .bind(orderId)
      .all<{ treatment: string | null }>();
    const treatments = rows.results ?? [];
    if (treatments.length === 0) return 'unknown';
    const gstFree = treatments.map((row) => isGstFreeTreatment(row.treatment));
    if (gstFree.every(Boolean)) return 'gst_free';
    if (gstFree.every((value) => !value)) return 'taxable';
    return 'unknown'; // mixed, and nothing here says which one this refund is for
  } catch (err) {
    console.warn('refund_tax_treatment_unreadable', { orderId, registrationId, err: String(err) });
    return 'unknown';
  }
}

/**
 * Scale a tax-EXCLUSIVE refund up to what the buyer was actually charged.
 *
 * D1 records what a seat cost ex tax, because that is the price the line item was sent at
 * and the price the tenant quoted. HubSpot then added the portal's tax rate on top, so the
 * money captured against the invoice is larger than the figure `refundSeats` computed. A
 * refund posted at the D1 amount hands back the price and keeps the tax — under-refunding
 * every cancelled seat, by a percentage nobody in this codebase knows.
 *
 * So the ratio comes from the invoice itself: total ÷ subtotal, HubSpot's own arithmetic at
 * HubSpot's own rate, which is the same reasoning that took the rate out of the line builder.
 *
 * **But total ÷ subtotal is an invoice-wide BLEND, and the refund is for one seat.** On an
 * invoice carrying both taxable and gst_free ticket types — equal $100 lines, say — the blend
 * is 1.05, where the taxable seat is owed 1.10 and the gst_free seat 1.00. Applying the blend
 * to both under-refunds the taxable seat by $5 and **over-refunds the gst_free seat by $5**,
 * and over-refunding is the direction this function exists to avoid. So the seat's own
 * treatment decides first: a gst_free seat had no tax added and is never scaled, whatever the
 * invoice around it looks like. A taxable seat on a mixed invoice keeps the blend, which
 * under-states its true ratio and therefore errs recoverably; making it exact needs the
 * gst_free lines' net total, which D1 cannot supply reliably once vouchers and comps have
 * zeroed seats the invoice still carries.
 *
 * It degrades to the unscaled amount when the seat's treatment cannot be established, when
 * HubSpot cannot be read, or when the two figures do not make sense together (a zero
 * subtotal, a total below it). That under-refunds rather than over-refunds, which is the
 * recoverable direction — a staff member can top it up, where money already returned cannot
 * be taken back — and it is logged rather than silent.
 */
async function grossUpRefundToInvoiceTax(
  token: string,
  db: D1Database,
  hsInvoiceId: string,
  amountCents: number,
  orderId: string | undefined,
  registrationId: string | undefined,
): Promise<number> {
  const treatment = await resolveRefundTaxTreatment(db, orderId, registrationId);
  if (treatment === 'gst_free') {
    // No tax was ever added to this seat, so the amount charged IS the stored amount.
    return amountCents;
  }
  if (treatment === 'unknown') {
    console.warn('refund_tax_treatment_unknown', { hsInvoiceId, orderId, registrationId });
    return amountCents;
  }
  // Portals differ on which of these an invoice exposes, so ask for the lot and take the
  // first pair that parses. Guessing one name and trusting it is how a money path goes
  // quietly wrong.
  const TOTAL_PROPS = ['hs_amount_billed', 'hs_amount', 'hs_total'];
  const SUBTOTAL_PROPS = ['hs_subtotal', 'hs_subtotal_amount'];
  try {
    const props = [...TOTAL_PROPS, ...SUBTOTAL_PROPS].join(',');
    const invoice = (await hs(
      token,
      'GET',
      `${HS_API}/crm/v3/objects/invoices/${hsInvoiceId}?properties=${props}`,
    )) as { properties?: Record<string, string | null> };
    const read = (names: string[]): number | null => {
      for (const name of names) {
        const raw = invoice.properties?.[name];
        if (raw === undefined || raw === null || raw === '') continue;
        const value = Number(raw);
        if (Number.isFinite(value) && value > 0) return value;
      }
      return null;
    };
    const total = read(TOTAL_PROPS);
    const subtotal = read(SUBTOTAL_PROPS);
    if (total === null || subtotal === null || total < subtotal) {
      console.warn('refund_tax_ratio_unavailable', { hsInvoiceId, total, subtotal });
      return amountCents;
    }
    return Math.round(amountCents * (total / subtotal));
  } catch (err) {
    console.warn('refund_tax_ratio_read_failed', { hsInvoiceId, err: String(err) });
    return amountCents;
  }
}

// ---------------------------------------------------------------------------
// Handler: notify.owner_task — assign a HubSpot task to the event owner (engagements API)
//
// Used for pending oversell/waitlist decisions (Phase 18.3). The task carries the subject
// + body and is assigned to the event owner when known; the owner actions it from the
// App Card's "Pending decisions" surface.
// ---------------------------------------------------------------------------

async function handleOwnerTask(token: string, payload: Record<string, unknown>): Promise<void> {
  const { subject, body, assignedOwnerId } = payload as {
    subject: string;
    body: string;
    assignedOwnerId: string | null;
  };

  const properties: Record<string, string> = {
    hs_task_subject: subject,
    hs_task_body: body,
    hs_task_status: 'NOT_STARTED',
    hs_task_priority: 'HIGH',
    hs_timestamp: new Date().toISOString(),
  };
  if (assignedOwnerId) {
    properties.hubspot_owner_id = assignedOwnerId;
  }

  await hs(token, 'POST', `${HS_API}/crm/v3/objects/tasks`, { properties });
}

// ---------------------------------------------------------------------------
// Handler: note.create
//
// Mirror an internal staff note onto the HubSpot record as a NATIVE Note engagement —
// HubSpot's own object with its own properties (hs_note_body, hs_timestamp,
// hubspot_owner_id), not a custom property. That puts the note on the same timeline as the
// calls and emails about the booking, which is where staff already look for internal
// commentary, and it stays CRM-internal: a note is never rendered on an invoice, a quote,
// or anything the attendee is sent.
//
// D1 is the record and this is the projection. The row is re-read at delivery rather than
// trusted from the payload, and `registration_notes.hubspot_note_id` is stamped on success
// so a retry after a mid-handler failure can't post the note twice.
// ---------------------------------------------------------------------------

/** Cache of HubSpot user id → owner id for the life of the isolate. */
const noteOwnerCache = new Map<string, string | null>();

/**
 * HubSpot's `hubspot_owner_id` takes an OWNER id, while the App Card knows the signed-in
 * user by their USER id — different numbering. The owners API converts between them;
 * anything else (a non-numeric author, 'system', a user with no owner record) leaves the
 * note unassigned rather than mis-attributed.
 */
async function resolveNoteOwnerId(token: string, author: string): Promise<string | null> {
  if (!/^\d+$/.test(author)) return null;
  const cached = noteOwnerCache.get(author);
  if (cached !== undefined) return cached;

  let ownerId: string | null = null;
  try {
    const owner = (await hs(
      token,
      'GET',
      `${HS_API}/crm/v3/owners/${encodeURIComponent(author)}?idProperty=userId`,
    )) as { id?: string | number } | null;
    ownerId = owner?.id != null ? String(owner.id) : null;
  } catch {
    // Best-effort attribution: the note body is what matters, not the avatar beside it.
    ownerId = null;
  }
  noteOwnerCache.set(author, ownerId);
  return ownerId;
}

type NoteAssociation = { objectType: 'contacts' | 'deals'; objectId: string };

/**
 * Which HubSpot record a note hangs off.
 *
 * A registration note goes on the ATTENDEE's contact — the person the note is about, who
 * on a bulk booking is not the buyer. An order note goes on the booking's deal, falling
 * back to the buyer's contact when there is no deal (a public free booking never creates
 * one).
 */
async function resolveNoteAssociation(
  token: string,
  env: Env,
  note: StaffNoteRow,
): Promise<NoteAssociation | null> {
  if (note.registration_id) {
    const reg = await env.DB.prepare(
      `SELECT hubspot_contact_id, attendee_email FROM registrations
        WHERE portal_id = ?1 AND id = ?2`,
    )
      .bind(note.portal_id, note.registration_id)
      .first<{ hubspot_contact_id: string | null; attendee_email: string }>();
    if (!reg) return null;
    if (reg.hubspot_contact_id) return { objectType: 'contacts', objectId: reg.hubspot_contact_id };
    if (!reg.attendee_email) return null;
    const contactId = await findContactIdByEmail(token, reg.attendee_email);
    return contactId ? { objectType: 'contacts', objectId: contactId } : null;
  }

  if (!note.order_id) return null;

  const order = await env.DB.prepare(
    `SELECT hubspot_deal_id, buyer_email FROM orders WHERE portal_id = ?1 AND id = ?2`,
  )
    .bind(note.portal_id, note.order_id)
    .first<{ hubspot_deal_id: string | null; buyer_email: string }>();
  if (!order) return null;
  if (order.hubspot_deal_id) return { objectType: 'deals', objectId: order.hubspot_deal_id };

  // A staff note is written in the same batch as the booking, so it can reach the queue
  // ahead of the deal it belongs on. Wait for the deal while its own outbox row is still
  // live; once that row is gone or dead the deal is never coming, so fall back to the
  // buyer's contact rather than retrying forever.
  const pendingDeal = await env.DB.prepare(
    `SELECT 1 FROM outbox
      WHERE portal_id = ?1 AND topic = 'deal.create' AND status NOT IN ('delivered', 'dead')
        AND json_extract(IIF(json_valid(payload), payload, '{}'), '$.orderId') = ?2
      LIMIT 1`,
  )
    .bind(note.portal_id, note.order_id)
    .first();
  if (pendingDeal) {
    throw new RetryableError(`Deal for order ${note.order_id} not created yet`, 60 * 1000);
  }

  if (!order.buyer_email) return null;
  const contactId = await findContactIdByEmail(token, order.buyer_email);
  return contactId ? { objectType: 'contacts', objectId: contactId } : null;
}

async function handleStaffNoteCreate(
  token: string,
  env: Env,
  portalId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const noteId = typeof payload.noteId === 'string' ? payload.noteId : null;
  if (!noteId) throw new PermanentError('note.create requires noteId');

  const note = await loadStaffNote(env, portalId, noteId);
  // The note is the D1 row; a row that is gone has nothing to project. Returning marks the
  // outbox row delivered rather than retrying a payload that can never succeed.
  if (!note) return;

  if (!(await isNoteSyncEnabled(env, portalId))) return;

  // An id already stored means the note was created and the association is what did not
  // finish — the id is persisted BEFORE the association precisely so a retry does not mint
  // a second note. Returning here instead would mark the row delivered with the note
  // sitting in HubSpot attached to nothing, which is the one place it is never read.
  // So skip the creation, not the rest.
  if (note.hubspot_note_id) {
    await associateStaffNote(token, env, note, note.hubspot_note_id, portalId, noteId);
    return;
  }

  const properties: Record<string, string> = {
    hs_note_body: note.body,
    // The note's own creation time, not now(): a retry writes the same timestamp, so the
    // timeline reads correctly and a duplicate would be visibly identical rather than drift.
    hs_timestamp: note.created_at,
  };
  const ownerId = await resolveNoteOwnerId(token, note.author);
  if (ownerId) properties.hubspot_owner_id = ownerId;

  let created: { id?: string | number } | null;
  try {
    created = (await hs(token, 'POST', `${HS_API}/crm/v3/objects/notes`, { properties })) as {
      id?: string | number;
    } | null;
  } catch (err) {
    // Notes write access is an OPTIONAL scope: a portal that has not granted it should keep
    // taking notes, not collect a dead outbox row per note. Skip quietly and let the next
    // install/re-auth turn the mirror on.
    if (err instanceof PermanentError && (err.statusCode === 403 || err.statusCode === 401)) {
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'staff_note_sync_not_permitted',
          portalId,
          noteId,
          message: err.message,
        }),
      );
      return;
    }
    throw err;
  }

  const hubspotNoteId = created?.id != null ? String(created.id) : null;
  if (!hubspotNoteId) throw new RetryableError('HubSpot note create returned no id');

  // Persist the id BEFORE the association, for the same reason deal.create does: if the
  // association call 429s, the retry must find the note already mirrored instead of
  // creating a second one.
  await env.DB.prepare(
    `UPDATE registration_notes SET hubspot_note_id = ?1
      WHERE id = ?2 AND portal_id = ?3 AND hubspot_note_id IS NULL`,
  )
    .bind(hubspotNoteId, note.id, portalId)
    .run();

  await associateStaffNote(token, env, note, hubspotNoteId, portalId, noteId);
}

/**
 * Hang a mirrored note off the record it is about — the attendee's contact for a
 * registration note, the booking's deal for an order note.
 *
 * Split out because it is reached twice: once straight after the note is created, and
 * again on a retry that finds the note already minted and only the association missing.
 * The PUT is idempotent, so re-running it on an already-associated note is a no-op.
 */
async function associateStaffNote(
  token: string,
  env: Env,
  note: StaffNoteRow,
  hubspotNoteId: string,
  portalId: string,
  noteId: string,
): Promise<void> {
  const association = await resolveNoteAssociation(token, env, note);
  if (!association) {
    // Nothing in HubSpot to hang it off yet (no contact for this attendee). The note stands
    // in D1 and shows in the manage card; a timeline entry is the bonus, not the feature.
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'staff_note_no_hubspot_target',
        portalId,
        noteId,
      }),
    );
    return;
  }

  const assocTypeId = await resolveAssocTypeId(token, 'notes', association.objectType, 'PRIMARY');
  await hs(
    token,
    'PUT',
    `${HS_API}/crm/v4/objects/notes/${hubspotNoteId}/associations/` +
      `${association.objectType}/${association.objectId}`,
    [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: assocTypeId }],
  );
}

// ---------------------------------------------------------------------------
// Handler: company.sync_voucher_usage
// ---------------------------------------------------------------------------

/**
 * Project a company's training voucher usage onto its HubSpot record.
 *
 * D1 is authoritative: usage is recomputed here at delivery time rather than taken from the
 * payload, so a retried or delayed row writes the current value instead of a stale one, and
 * the absolute PATCH means replaying it can never double-count.
 *
 * On the first sync for a company we capture whatever HubSpot already had as the baseline,
 * so usage recorded before this worker (or keyed in by hand) survives the recompute.
 */
async function handleCompanyVoucherUsage(
  token: string,
  env: Env,
  payload: Record<string, unknown>,
): Promise<void> {
  const db = env.DB;
  const { portalId, companyId } = payload as { portalId: string; companyId: string };
  if (!portalId || !companyId) {
    throw new PermanentError('company.sync_voucher_usage requires portalId and companyId');
  }

  const config = await loadVoucherConfig(env, portalId);
  if (config.mode === 'off') return;

  // Capture the baseline before the first write, reading HubSpot's current value. Later
  // calls are no-ops (INSERT OR IGNORE), so a value we have already influenced can't be
  // mistaken for pre-existing usage.
  if ((await getVoucherBaseline(db, portalId, companyId, config.mode)) === null) {
    const company = (await hs(
      token,
      'GET',
      `${HS_API}/crm/v3/objects/companies/${encodeURIComponent(companyId)}` +
        `?properties=${encodeURIComponent(config.usedProperty)}`,
    )) as { properties?: Record<string, string | undefined> };
    await captureVoucherBaseline(
      db,
      portalId,
      companyId,
      parseVoucherAmount(company.properties?.[config.usedProperty], config.mode),
      config.mode,
    );
  }

  const usage = await resolveVoucherUsage(db, portalId, companyId, config.mode);

  // Through `writeProperties` for the structured error and the named log line, but with NO
  // `provision` hook, deliberately. Every other managed property is the app's to create on
  // demand; this family is the one CLAUDE.md says a human must map FIRST, because Weld's
  // allowance lives in `vouchers_allowance` / `vouchers_used__training` and an unmapped
  // portal would have us create an empty `vouchers_used` beside it and report success. So a
  // missing property here still fails the row - loudly, naming the property and the remedy,
  // instead of as a bare HubSpot 400 - and the fix is to map it and run provisioning.
  await writeProperties(
    token,
    'PATCH',
    `${HS_API}/crm/v3/objects/companies/${encodeURIComponent(companyId)}`,
    { [config.usedProperty]: formatVoucherAmount(usage.used, config.mode) },
    { topic: 'company.sync_voucher_usage', portalId },
  );
}

// ---------------------------------------------------------------------------
// Handler: contact.set_join_url
// ---------------------------------------------------------------------------

async function handleContactSetJoinUrl(
  token: string,
  env: Env,
  portalId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const { attendeeEmail, teamsJoinUrl } = payload as {
    attendeeEmail: string;
    teamsJoinUrl: string | null;
  };

  if (!teamsJoinUrl) return; // no-op for in-person events

  // Tenant-mappable since 0026, like every other contact write-back. NULL resolves to
  // `teams_join_url` — the name this has always written and the one the shipped workflow
  // specs read — so an unconfigured portal is unaffected.
  const property = await loadJoinUrlProperty(env, portalId);
  if (property === null) {
    // The tenant switched it off. A no-op, not a failure: retrying a row that can never be
    // written would only block the queue behind it.
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'join_url_write_back_disabled',
        portalId,
        attendeeEmail,
      }),
    );
    return;
  }

  // Overwritten rather than filled-if-empty, unlike the 1.2 capture in the same module: this
  // URL was minted by the worker for THIS registration, and HubSpot's copy is a stale link
  // to whatever event the contact registered for last. Preserving it would send someone to a
  // webinar that finished last month.
  // Through `writeProperties`, like every other property write (Ref 78). This one was
  // missed, and it is the same failure in the same shape: three of Weld's rows died on
  // `teams_join_url does not exist`, on a portal that has never run provisioning, and the
  // repair that exists for exactly this could not see them. Safe to create: the worker
  // MINTS this value for this registration, so there is no pre-existing portal data for a
  // created property to collide with, and the default name is the one the shipped workflow
  // specs already read.
  await writeProperties(
    token,
    'PATCH',
    `${HS_API}/crm/v3/objects/contacts/${encodeURIComponent(attendeeEmail)}?idProperty=email`,
    { [property]: teamsJoinUrl },
    {
      topic: 'contact.set_join_url',
      portalId,
      provision: propertyRepair(env, portalId, token),
    },
  );
}

// ---------------------------------------------------------------------------
// Handler: contact.sync_attendee_details (Phase 1.2)
//
// The non-destructive half of attendee contact capture. Per mapped field:
//   HubSpot empty     → write it
//   HubSpot matches   → nothing to do (formatting differences are not conflicts)
//   HubSpot differs   → leave it alone and open a contact_conflict decision
//
// Overwriting silently is the one outcome that is never acceptable: the stored value is
// usually the member's own, while the captured one came off a booking form a colleague may
// have filled in for them. Losing the former to the latter is worse than not capturing.
//
// Retry-safe by construction: the writes are idempotent (a second run finds the property
// filled and equal, so it writes nothing) and the decision is deduped by the partial
// unique index from 0021.
// ---------------------------------------------------------------------------

async function handleContactSyncAttendeeDetails(
  token: string,
  env: Env,
  portalId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const {
    registrationId,
    eventId,
    attendeeEmail,
    attendeeName,
    details,
    force = false,
  } = payload as unknown as AttendeeContactSyncPayload;

  // A row with nothing to write is a no-op, not a failure: retrying it forever would only
  // block the queue behind a payload that can never succeed.
  if (!attendeeEmail || !registrationId || !details) return;

  const config = await loadAttendeeContactConfig(env, portalId);
  if (!hasAnyMapping(config)) {
    // Every field switched off for this tenant. Capture still persisted in D1; there is
    // nothing HubSpot has agreed to receive.
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'attendee_contact_write_back_disabled',
        portalId,
        registrationId,
      }),
    );
    return;
  }

  const mapped = ATTENDEE_CONTACT_FIELDS.map((field) => propertyFor(config, field)).filter(
    (property): property is string => property !== null,
  );

  // The ATTENDEE's contact, never the buyer's — a colleague booking a seat for someone
  // else must not have that person's phone number land on their own record. A missing
  // contact means every property is empty, which is what the diff wants. Anything else is
  // a real HubSpot failure and must surface rather than reading as "empty, safe to write".
  let existing: Record<string, string | null | undefined> = {};
  let contactExists = true;
  if (!force) {
    const contact = await readContactProperties(token, attendeeEmail, mapped);
    contactExists = contact !== null;
    existing = contact ?? {};
  }

  const diff = diffContactDetails({ config, captured: details, existing, force });

  const writeCount = Object.keys(diff.writes).length;
  if (writeCount > 0) {
    // Creating the attendee's contact (no contact for this email yet — this row beat
    // me.register to it) carries their name too, so the write-back can never leave a bare
    // record holding a phone number and nothing to identify it. On an EXISTING contact the
    // name is deliberately omitted: overwriting someone's name with what a booker typed is
    // the same mistake as overwriting their phone number.
    const properties = contactExists
      ? diff.writes
      : { ...nameToContactProperties(attendeeEmail, attendeeName), ...diff.writes };

    const result = (await writeProperties(
      token,
      'PATCH',
      `${HS_API}/crm/v3/objects/contacts/${encodeURIComponent(attendeeEmail)}?idProperty=email`,
      properties,
      {
        topic: 'contact.sync_attendee_details',
        portalId,
        provision: propertyRepair(env, portalId, token),
      },
    )) as ContactUpsertResult | null;

    // Stamp the attendee's contact id onto the registration when nothing has yet — the
    // same linkage me.register makes, done here because either handler may run first.
    if (result?.id) {
      await env.DB.prepare(
        `UPDATE registrations SET hubspot_contact_id = ?1, updated_at = ?2
          WHERE id = ?3 AND hubspot_contact_id IS NULL`,
      )
        .bind(result.id, new Date().toISOString(), registrationId)
        .run();
    }
  }

  if (diff.conflicts.length === 0) return;

  // One decision per registration listing every conflicting field — an owner should get a
  // single task for a booking, not one per property.
  const event = await loadEvent(env.DB, portalId, eventId);
  if (!event) return;

  const open = await env.DB.prepare(
    `SELECT id FROM pending_decisions
      WHERE portal_id = ?1 AND registration_id = ?2
        AND type = 'contact_conflict' AND status = 'open'`,
  )
    .bind(portalId, registrationId)
    .first<{ id: string }>();
  if (open) return;

  try {
    await createContactConflictDecision(env, {
      portalId,
      event,
      registrationId,
      context: {
        attendeeEmail,
        attendeeName: attendeeName ?? null,
        hubspotContactId: (payload.hubspotContactId as string | null) ?? null,
        conflicts: diff.conflicts,
        written: Object.keys(diff.writes),
        captured: details,
      },
    });
  } catch (err) {
    // The unique index rejected a concurrent duplicate — the owner has already been asked.
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'contact_conflict_already_open',
        portalId,
        registrationId,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/** Current values of `properties` on the contact, or null when no such contact exists. */
async function readContactProperties(
  token: string,
  email: string,
  properties: string[],
): Promise<Record<string, string | null | undefined> | null> {
  const url =
    `${HS_API}/crm/v3/objects/contacts/${encodeURIComponent(email)}?idProperty=email` +
    `&properties=${properties.map(encodeURIComponent).join(',')}`;
  try {
    const contact = (await hs(token, 'GET', url)) as {
      properties?: Record<string, string | null | undefined>;
    };
    return contact?.properties ?? {};
  } catch (err) {
    if (err instanceof PermanentError && err.statusCode === 404) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Handler: contact.sync_answers (Phase 2.3)
//
// Projects a registration's answers onto the ATTENDEE's contact, for the questions whose
// `hs_property` names one. This is the half of custom questions that makes them worth
// answering once: dietary requirements and a coffee order are facts about the PERSON, so
// HubSpot holds the current value and the next registration form offers it back rather
// than asking again.
//
// ## Who is allowed to overwrite what
//
// Phase 1.2 never overwrites a stored phone number, because the captured one usually came
// off a form a colleague filled in. The same doubt applies here — but not equally, and the
// difference decides the rule:
//
//   self-declared (the attendee IS the buyer) → the newest answer wins. They just told us,
//     about themselves, today. Refusing to update would mean a member who went vegan two
//     years ago can never correct it through a booking form, and would strand the prefill
//     on a value they have already replaced.
//
//   booked by someone else → fill only what HubSpot leaves empty, and leave a differing
//     value alone. A colleague ticking "no dietary requirements" through a bulk form must
//     not be able to erase a coeliac's record — a wrong meal is a real harm, and the
//     unwritten answer costs nothing, because THIS event reads the answer from D1.
//
// That last clause is what makes the conservative branch safe rather than merely cautious:
// the attendee list, the CSV and therefore the caterer read `registration_answers`. The
// contact property is the prefill source for NEXT time, never the source for this event.
// So no decision is opened either — unlike a mismatched phone number, an answer that
// legitimately changes between courses would generate an owner task per booking, and
// tasks nobody can act on are how a review queue stops being read.
//
// Retry-safe by construction: every write is an absolute PATCH of a value carried in the
// payload, so a second run computes the same properties and, having already written them,
// sends nothing.
// ---------------------------------------------------------------------------

async function handleContactSyncAnswers(
  token: string,
  env: Env,
  portalId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const { registrationId, attendeeEmail, attendeeName, selfDeclared, answers } =
    payload as unknown as AnswerSyncPayload;

  // Nothing to write is a no-op, not a failure: retrying a payload that can never succeed
  // would only block the queue behind it.
  if (!attendeeEmail || !registrationId || !Array.isArray(answers) || answers.length === 0) return;

  // One property per question. A definition edited between the booking and the drain could
  // in principle repoint two questions at one property; last entry wins, deterministically,
  // rather than sending a payload whose shape depends on object-key iteration luck.
  const byProperty = new Map(answers.map((answer) => [answer.property, answer]));
  const properties: Record<string, string> = {};
  let contactExists = true;

  if (selfDeclared) {
    for (const answer of byProperty.values()) properties[answer.property] = answer.value;
    // A create still has to carry a name (see below), so ask whether the contact exists
    // even on the path that writes unconditionally.
    contactExists =
      (await readContactProperties(token, attendeeEmail, [...byProperty.keys()])) !== null;
  } else {
    const existing = await readContactProperties(token, attendeeEmail, [...byProperty.keys()]);
    contactExists = existing !== null;
    for (const answer of byProperty.values()) {
      const current = (existing?.[answer.property] ?? '').trim();
      if (current === '') {
        properties[answer.property] = answer.value;
        continue;
      }
      if (sameAnswerValue(answer.fieldType, current, answer.value)) continue;
      // Deliberately not written and deliberately not a decision — see the note above.
      // Logged so a portal reconciling its contact data can see that the two disagree.
      console.log(
        JSON.stringify({
          level: 'info',
          event: 'answer_writeback_skipped',
          portalId,
          registrationId,
          questionKey: answer.key,
          property: answer.property,
        }),
      );
    }
  }

  if (Object.keys(properties).length === 0) return;

  // Creating the attendee's contact (this row beat me.register to it) carries their name,
  // so the write-back can never leave a bare record holding a dietary note and nothing to
  // identify it. On an EXISTING contact the name is omitted, for the same reason Phase 1.2
  // omits it: overwriting someone's name with what a booker typed is its own mistake.
  const body = contactExists
    ? properties
    : { ...nameToContactProperties(attendeeEmail, attendeeName), ...properties };

  const result = (await writeProperties(
    token,
    'PATCH',
    `${HS_API}/crm/v3/objects/contacts/${encodeURIComponent(attendeeEmail)}?idProperty=email`,
    body,
    {
      topic: 'contact.sync_answers',
      portalId,
      provision: propertyRepair(env, portalId, token),
    },
  )) as ContactUpsertResult | null;

  // Same linkage me.register and contact.sync_attendee_details make; any of the three may
  // run first, so each stamps the id when nothing has yet.
  if (result?.id) {
    await env.DB.prepare(
      `UPDATE registrations SET hubspot_contact_id = ?1, updated_at = ?2
        WHERE id = ?3 AND hubspot_contact_id IS NULL`,
    )
      .bind(result.id, new Date().toISOString(), registrationId)
      .run();
  }
}

// ---------------------------------------------------------------------------
// Handler: contact.sync_attendance (Phase 2.1)
//
// Project attendance onto the ATTENDEE's contact so Ollie's Data Hub certificate flow can
// read it. The worker renders no certificate of its own — duplicating a working mechanism
// would hand members two differently-shaped documents for the same year.
//
// Three mapped properties: a sticky attended flag, the attendance DATE, and the event name
// (a certificate that cannot name the course is not a certificate). Each is skippable per
// tenant via 'off'.
//
// The one rule that is not a nicety: the date NEVER moves backwards. Outbox rows drain out
// of order — a retried row for last month's course can arrive after this morning's — and a
// certificate driven off a property that regressed names the wrong course on the wrong day.
// So an existing date later than this one wins, and the event name only moves with the date
// it belongs to.
//
// Retry-safe by construction: every write is an absolute PATCH of a value derived from the
// payload's stable attendedAt, so a second run computes the same properties and, having
// already written them, sends nothing.
// ---------------------------------------------------------------------------

/** HubSpot property metadata, cached for the life of the isolate (as dealTypeCache is). */
const contactPropertyTypeCache = new Map<string, string | null>();

/**
 * A contact property's HubSpot `type`, or null when it cannot be read.
 *
 * Needed because HubSpot's date handling differs by type: a `date` property takes a
 * midnight-UTC calendar date and REJECTS a timestamp, while a `datetime` takes either.
 * Portals key attendance dates as either, so ask — but the schema scope is optional, and
 * `formatAttendanceDate` picks the shape that works for both when the answer is null.
 */
async function resolveContactPropertyType(
  token: string,
  portalId: string,
  propertyName: string,
): Promise<string | null> {
  const cacheKey = `${portalId}:${propertyName}`;
  const cached = contactPropertyTypeCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let type: string | null = null;
  try {
    const property = (await hs(
      token,
      'GET',
      `${HS_API}/crm/v3/properties/contacts/${encodeURIComponent(propertyName)}`,
    )) as { type?: string } | null;
    type = property?.type ?? null;
  } catch {
    // A property the portal has not created yet, or no schema scope (it is optional). The
    // PATCH below surfaces any real failure; formatting falls back to the calendar date,
    // which both HubSpot date types accept.
    type = null;
  }
  contactPropertyTypeCache.set(cacheKey, type);
  return type;
}

/**
 * The calendar date `iso` fell on, in the tenant's display timezone — what a HubSpot `date`
 * property should hold, and what a certificate prints.
 *
 * This used to be `iso.slice(0, 10)`, the UTC date. Adelaide is UTC+9:30 (+10:30 over
 * daylight saving), so every check-in before 9:30am local recorded the PREVIOUS day — and a
 * 9am start with people scanning in from 8:30 is the ordinary shape of a training course,
 * not an edge case.
 */
function toLocalDateOnly(iso: string, timeZone: string): string {
  return localCalendarDate(iso, timeZone);
}

/**
 * The calendar date is the DEFAULT, and a full timestamp is sent only for a property known
 * to be `datetime`. Both HubSpot types accept 'YYYY-MM-DD', while a `date` property rejects
 * a timestamp outright — so guessing the other way would turn an unreadable property schema
 * (the schema scope is optional) into a dead outbox row instead of a lost time-of-day that
 * no certificate prints anyway.
 */
function formatAttendanceDate(iso: string, propertyType: string | null, timeZone: string): string {
  // A `datetime` property keeps the instant, which is unambiguous and needs no conversion.
  // Only the day-resolution case has to be told where "the day" is.
  return propertyType === 'datetime' ? iso : toLocalDateOnly(iso, timeZone);
}

/**
 * Parse whatever HubSpot hands back for a date property: epoch millis (what the API
 * returns for date/datetime), 'YYYY-MM-DD', or a full ISO timestamp. NaN → treated as
 * "nothing usable stored", which lets the write proceed.
 */
function parseHubSpotDate(value: string | null | undefined): number {
  const raw = (value ?? '').trim();
  if (raw === '') return Number.NaN;
  if (/^\d+$/.test(raw)) return Number(raw);
  return Date.parse(raw);
}

/** Values HubSpot uses for a true boolean, across checkbox and enumeration properties. */
const TRUTHY_FLAG_VALUES = new Set(['true', 'yes', 'y', '1']);

function isFlagSet(value: string | null | undefined): boolean {
  return TRUTHY_FLAG_VALUES.has((value ?? '').trim().toLowerCase());
}

async function handleContactSyncAttendance(
  token: string,
  env: Env,
  portalId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const { registrationId, attendeeEmail, attendeeName, attendedAt, eventTitle } =
    payload as unknown as AttendanceSyncPayload;

  // A row that can never succeed is a no-op, not a permanent retry: returning marks it
  // delivered instead of blocking the queue behind it.
  if (!registrationId || !attendeeEmail || !attendedAt) return;

  const config = await loadAttendanceContactConfig(env, portalId);
  if (!hasAnyAttendanceMapping(config)) {
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'attendance_write_back_disabled',
        portalId,
        registrationId,
      }),
    );
    return;
  }

  const mapped = ATTENDANCE_FIELDS.map((field) => attendancePropertyFor(config, field)).filter(
    (property): property is string => property !== null,
  );

  // The ATTENDEE's contact, never the buyer's — a colleague books the seat, the attendee
  // earns the certificate. A missing contact means every property is empty, which is what
  // the comparison below wants; any other failure must surface rather than read as empty.
  const contact = await readContactProperties(token, attendeeEmail, mapped);
  const contactExists = contact !== null;
  const existing = contact ?? {};

  const properties: Record<string, string> = {};

  if (config.attendedProperty && !isFlagSet(existing[config.attendedProperty])) {
    properties[config.attendedProperty] = 'true';
  }

  // The date decides whether this attendance is the newest one on the contact; the event
  // name rides with it so the pair can never describe two different courses.
  let isNewest = true;
  if (config.attendedDateProperty) {
    const propertyType = await resolveContactPropertyType(
      token,
      portalId,
      config.attendedDateProperty,
    );
    const incoming = Date.parse(attendedAt);
    const current = parseHubSpotDate(existing[config.attendedDateProperty]);
    const formatted = formatAttendanceDate(attendedAt, propertyType, config.displayTimeZone);

    if (!Number.isNaN(current) && !Number.isNaN(incoming) && current > incoming) {
      // A later attendance already landed; this row is a straggler for an earlier event.
      // Caveat: against a HubSpot `date` property the stored value is midnight, so two
      // events on the SAME day cannot be ordered against each other — the stored property
      // has a day's resolution and nothing here can recover more. Between days, which is
      // what a certificate cares about, the comparison holds.
      isNewest = false;
    } else if ((existing[config.attendedDateProperty] ?? '') !== formatted) {
      properties[config.attendedDateProperty] = formatted;
    }
  }

  if (config.eventNameProperty && isNewest && eventTitle) {
    if ((existing[config.eventNameProperty] ?? '') !== eventTitle) {
      properties[config.eventNameProperty] = eventTitle;
    }
  }

  if (Object.keys(properties).length === 0) return;

  // A contact that does not exist yet is created carrying the attendee's name — the same
  // choice contact.sync_attendee_details makes, and for the same reason: a record holding
  // an attendance date and nothing to identify it is worse than no record. An EXISTING
  // contact's name is never rewritten.
  const body = contactExists
    ? properties
    : { ...nameToContactProperties(attendeeEmail, attendeeName), ...properties };

  const result = (await writeProperties(
    token,
    'PATCH',
    `${HS_API}/crm/v3/objects/contacts/${encodeURIComponent(attendeeEmail)}?idProperty=email`,
    body,
    {
      topic: 'contact.sync_attendance',
      portalId,
      provision: propertyRepair(env, portalId, token),
    },
  )) as ContactUpsertResult | null;

  // Stamp the contact id where nothing has yet — the same linkage me.register makes, done
  // here too because either handler may run first.
  if (result?.id) {
    await env.DB.prepare(
      `UPDATE registrations SET hubspot_contact_id = ?1, updated_at = ?2
        WHERE id = ?3 AND hubspot_contact_id IS NULL`,
    )
      .bind(result.id, new Date().toISOString(), registrationId)
      .run();
  }
}

// ---------------------------------------------------------------------------
// Handler: contact.sync_registration_confirmation (Ref 61)
//
// Stamps the booking's ORDER id onto the ATTENDEE's contact. A HubSpot workflow watches the
// property and sends the confirmation email — the worker sends nothing itself, exactly as
// Phase 2.1 renders no certificate.
//
// Three things this handler is careful about, each of which was a real failure:
//
//  1. **The property is the tenant's, not ours.** Resolved through the same mapping every
//     other contact write-back uses (migration 0040). 'off' is a no-op ack, not a retry: a
//     portal that drives its confirmation some other way should not collect a dead outbox
//     row per booking.
//
//  2. **It never moves backwards.** Outbox rows drain out of order and a reconcile sweep
//     can re-drive an old one. A contact who booked course A and then course B must not end
//     up stamped with A again — that is a real value change, so the workflow enrols and
//     sends a confirmation naming a booking they made last month. An existing value that
//     belongs to a NEWER order wins, on the same principle as the attendance date.
//
//  3. **A card checkout that has not paid gets nothing.** See shouldStampConfirmation: the
//     rule lives with the feature so no enqueue point has to remember it.
//
// Retry-safe by construction: the write is an absolute PATCH of a value derived from D1,
// and an unchanged value sends nothing at all — so a retry cannot re-enrol the workflow.
// ---------------------------------------------------------------------------

async function handleRegistrationConfirmation(
  token: string,
  env: Env,
  portalId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const { registrationId, orderId, attendeeEmail, hubspotContactId } =
    payload as unknown as RegistrationConfirmationPayload;

  // A row that can never succeed is a no-op, not a permanent retry: returning marks it
  // delivered instead of blocking the queue behind it.
  if (!registrationId || !orderId || !attendeeEmail) return;

  const property = await loadRegistrationConfirmationProperty(env, portalId);
  if (property === null) {
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'registration_confirmation_disabled',
        portalId,
        registrationId,
      }),
    );
    return;
  }

  // Re-read at DRAIN time rather than trusting what the enqueue point knew. A card order
  // that was pending when this row was written may have been paid since (stamp it), and a
  // seat may have been cancelled out from under it since (do not).
  const row = await env.DB.prepare(
    `SELECT o.status, o.payment_method, o.created_at AS order_created_at,
            r.cancelled_at, r.seat_unnamed
       FROM orders o
       JOIN registrations r ON r.order_id = o.id
      WHERE o.id = ?1 AND r.id = ?2 AND o.portal_id = ?3`,
  )
    .bind(orderId, registrationId, portalId)
    .first<{
      status: string;
      payment_method: string | null;
      order_created_at: string;
      cancelled_at: string | null;
      seat_unnamed: number;
    }>();

  if (!row) return;
  // Nobody on the seat is nobody to confirm to; a cancelled seat has nothing to confirm.
  if (row.seat_unnamed === 1 || row.cancelled_at) return;
  if (!shouldStampConfirmation(row)) {
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'registration_confirmation_deferred',
        portalId,
        registrationId,
        orderId,
        reason: 'card_checkout_unpaid',
      }),
    );
    return;
  }

  const existing = await readContactProperties(token, attendeeEmail, [property]);
  const current = (existing?.[property] ?? '').trim();

  // Already says what we are about to say. Writing the same value again is not just
  // wasteful: some workflow enrolment shapes re-trigger on any property write.
  if (current === orderId) return;

  if (current !== '') {
    // The stored value is another booking's id. Ours wins only if it is the newer booking.
    // An id we cannot find in D1 (another portal's, or hand-typed) is treated as unknown
    // rather than newer — the stamp proceeds, because refusing to write on an unreadable
    // value would leave the confirmation unsent for good.
    const currentOrder = await env.DB.prepare(
      'SELECT created_at FROM orders WHERE id = ?1 AND portal_id = ?2',
    )
      .bind(current, portalId)
      .first<{ created_at: string }>();
    if (currentOrder) {
      const stored = Date.parse(currentOrder.created_at);
      const incoming = Date.parse(row.order_created_at);
      if (!Number.isNaN(stored) && !Number.isNaN(incoming) && stored > incoming) {
        console.log(
          JSON.stringify({
            level: 'info',
            event: 'registration_confirmation_stale',
            portalId,
            registrationId,
            orderId,
            heldBy: current,
          }),
        );
        return;
      }
    }
  }

  const repair = { topic: 'contact.sync_registration_confirmation', portalId };
  const contactId =
    hubspotContactId ??
    (await upsertContact(
      token,
      attendeeEmail,
      // A contact that does not exist yet is created carrying the attendee's name. An
      // EXISTING contact's name is never rewritten from booking data (Phase 1.2).
      { email: attendeeEmail },
      repair,
    ));

  // The property this write names is the app's own (migration 0040), so a portal that has
  // never run provisioning gets it created here rather than losing the confirmation. Weld's
  // live portal died on exactly this, once per booking.
  await writeProperties(
    token,
    'PATCH',
    `${HS_API}/crm/v3/objects/contacts/${contactId}`,
    { [property]: orderId },
    { ...repair, provision: propertyRepair(env, portalId, token) },
  );

  await env.DB.prepare(
    `UPDATE registrations SET hubspot_contact_id = ?1, updated_at = ?2
      WHERE id = ?3 AND hubspot_contact_id IS NULL`,
  )
    .bind(contactId, new Date().toISOString(), registrationId)
    .run();
}

// ---------------------------------------------------------------------------
// Idempotent line-item create
//
// Once the parent deal/invoice id is persisted, a transient failure mid-handler
// causes a retry that re-runs the line-item loop. Search-by-hs_external_id 400s
// on some portals (Weld included), so retries must reuse lines already associated
// to the parent instead of POSTing another copy.
// ---------------------------------------------------------------------------

/**
 * Commerce line pricing for HubSpot Revenue Hub tax compliance.
 *
 * Stored ticket prices are TAX-EXCLUSIVE in D1, so a line goes to HubSpot at the amount
 * we hold and HubSpot's tax library (`hs_tax_rate_group_id`) adds the portal's own rate
 * on top — landing under the subtotal rather than as a product/service line. The worker
 * computes no tax of its own: the rate is the tenant's, and only HubSpot's arithmetic
 * reconciles through Data Sync into Xero. gst_free lines carry the imported Xero
 * GST-free rate id instead, and are likewise sent at face value.
 *
 * This previously divided every taxable line by 1.1 first, on the reading that stored
 * prices already contained GST. They do not — the tenant enters them ex GST — so each
 * invoice came out a tax fraction below the price the buyer was quoted. See
 * `PRICES_ARE_TAX_EXCLUSIVE` in @paddock/shared for why no rate lives in this codebase.
 */
type CommerceLineInput = {
  ticketTypeId: string;
  name: string;
  quantity: number;
  unitCents: number;
  totalCents: number;
  taxTreatment?: string;
  hsProductId: string | null;
};

function formatCommerceLinesForBooking<T extends { name: string }>(
  bookingTitle: unknown,
  lineItems: T[],
): T[] {
  return lineItems.map((li) => ({
    ...li,
    name: formatBookingLineItemName(bookingTitle, li.name),
  }));
}

function buildCommerceLineProps(
  orderId: string,
  li: CommerceLineInput,
  externalIdPrefix: '' | 'inv:',
  taxRateId: string | null,
): Record<string, string | number> {
  // Sent at face value whether or not a rate is attached: the stored price IS the
  // tax-exclusive amount, and HubSpot computes the tax from the rate id below.
  const lineTotalCents = li.totalCents;
  const props: Record<string, string | number> = {
    name: li.name,
    quantity: li.quantity,
    price: (lineTotalCents / li.quantity / 100).toFixed(2),
    amount: (lineTotalCents / 100).toFixed(2),
    hs_external_id: `${externalIdPrefix}${orderId}:${li.ticketTypeId}`,
  };
  if (li.hsProductId) props.hs_product_id = li.hsProductId;
  if (taxRateId) props.hs_tax_rate_group_id = taxRateId;
  return props;
}

async function createLineItem(
  token: string,
  props: Record<string, string | number>,
): Promise<string> {
  const externalId = String(props.hs_external_id ?? '');
  if (externalId) {
    // Idempotent lookup by hs_external_id. Some portals reject this property on the
    // search API (vague 400) even when create accepts it — fall through to POST.
    try {
      const search = (await hs(token, 'POST', `${HS_API}/crm/v3/objects/line_items/search`, {
        filterGroups: [
          { filters: [{ propertyName: 'hs_external_id', operator: 'EQ', value: externalId }] },
        ],
        properties: [
          'hs_external_id',
          'price',
          'amount',
          'quantity',
          'hs_tax_rate_group_id',
          'hs_product_id',
          'name',
        ],
        limit: 1,
      })) as {
        results?: Array<{ id: string; properties?: Record<string, string | null> }>;
      };
      if (search.results && search.results.length > 0) {
        const existing = search.results[0];
        const current = existing.properties ?? {};
        // Retries used to short-circuit here, which permanently froze untaxed / wrong-priced
        // lines created by older write-back builds. Patch when the desired tax/price differs.
        const needsUpdate = Object.entries(props).some(([key, value]) => {
          if (key === 'hs_external_id') return false;
          const desired = String(value);
          const actual = current[key];
          if (actual == null || actual === '') return desired !== '';
          return String(actual) !== desired;
        });
        if (needsUpdate) {
          await hs(token, 'PATCH', `${HS_API}/crm/v3/objects/line_items/${existing.id}`, {
            properties: props,
          });
        }
        return existing.id;
      }
    } catch (err) {
      if (!(err instanceof PermanentError) || err.statusCode !== 400) throw err;
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'line_item_search_skipped',
          externalId,
          reason: err.message,
        }),
      );
    }
  }
  let createProps = props;
  let created: { id: string };
  try {
    created = (await hs(token, 'POST', `${HS_API}/crm/v3/objects/line_items`, {
      properties: createProps,
    })) as { id: string };
  } catch (err) {
    if (
      err instanceof PermanentError &&
      err.statusCode === 400 &&
      Object.hasOwn(props, 'hs_external_id')
    ) {
      const { hs_external_id: externalId, ...propsWithoutExternalId } = props;
      createProps = propsWithoutExternalId;
      console.log(
        JSON.stringify({
          level: 'warn',
          event: 'line_item_external_id_create_skipped',
          externalId,
          reason: err.message,
        }),
      );
      created = (await hs(token, 'POST', `${HS_API}/crm/v3/objects/line_items`, {
        properties: createProps,
      })) as { id: string };
    } else {
      throw err;
    }
  }
  return created.id;
}

interface AssociatedLineItem {
  id: string;
  properties: Record<string, string | null>;
}

function lineItemNeedsUpdate(
  current: Record<string, string | null>,
  props: Record<string, string | number>,
): boolean {
  return Object.entries(props).some(([key, value]) => {
    if (key === 'hs_external_id') return false;
    const desired = String(value);
    const actual = current[key];
    if (actual == null || actual === '') return desired !== '';
    return String(actual) !== desired;
  });
}

const LINE_ITEM_READ_PROPERTIES = [
  'price',
  'amount',
  'quantity',
  'hs_tax_rate_group_id',
  'hs_product_id',
  'name',
];

async function readLineItems(token: string, ids: string[]): Promise<AssociatedLineItem[]> {
  const inputs = ids.map((id) => ({ id }));
  // `hs_external_id` is the property `createLineItem` already has two fallbacks for:
  // some portals reject it on search, some on create. A batch read is the third place
  // it can be rejected, and until Ref 40 it was the one with no fallback — a 400 here
  // took down the whole write-back before a single line was attached.
  let batch: { results?: Array<{ id: string; properties?: Record<string, string | null> }> } | null;
  try {
    batch = (await hs(token, 'POST', `${HS_API}/crm/v3/objects/line_items/batch/read`, {
      properties: ['hs_external_id', ...LINE_ITEM_READ_PROPERTIES],
      inputs,
    })) as typeof batch;
  } catch (err) {
    if (!(err instanceof PermanentError) || err.statusCode !== 400) throw err;
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'line_item_external_id_read_skipped',
        reason: err.message,
      }),
    );
    batch = (await hs(token, 'POST', `${HS_API}/crm/v3/objects/line_items/batch/read`, {
      properties: LINE_ITEM_READ_PROPERTIES,
      inputs,
    })) as typeof batch;
  }

  return (batch?.results ?? []).map((row) => ({
    id: row.id,
    properties: row.properties ?? {},
  }));
}

async function loadAssociatedLineItems(
  token: string,
  parentObjectType: 'invoices' | 'deals',
  parentId: string,
): Promise<AssociatedLineItem[]> {
  const assoc = (await hs(
    token,
    'GET',
    `${HS_API}/crm/v4/objects/${parentObjectType}/${parentId}/associations/line_items`,
  )) as { results?: Array<{ toObjectId?: string | number; id?: string | number }> } | null;

  const ids = (assoc?.results ?? [])
    .map((row) => String(row.toObjectId ?? row.id ?? ''))
    .filter(Boolean);
  if (ids.length === 0) return [];

  return await readLineItems(token, ids);
}

interface LineItemOwner {
  db: D1Database;
  portalId: string;
  orderId: string;
}

/**
 * The registry is a memory, not a gate. A D1 provisioned before migration 0041 has no
 * `hubspot_line_items` table, and the same reasoning as `loadPortalInvoiceDueDays` applies
 * (Ref 217 schema drift): reading config never fails a booking. Without it the write-back
 * falls back to matching on what HubSpot can see, which is what it did before Ref 40 —
 * worse, but not a booking nobody can pay for.
 */
function logLineItemRegistryUnavailable(err: unknown, operation: string): void {
  console.log(
    JSON.stringify({
      level: 'warn',
      event: 'line_item_registry_unavailable',
      operation,
      reason: err instanceof Error ? err.message : String(err),
    }),
  );
}

/**
 * Line items this worker has already created for one invoice/deal, by the
 * `hs_external_id` it stamped on them.
 *
 * Reading them back out of HubSpot is not a substitute (Ref 40 item 2). The association
 * index is eventually consistent and the batch read can be refused outright, so an empty
 * answer means "we cannot see it", never "it is not there" — and treating the two the
 * same is what put four identical $18,786.36 lines on one guest invoice, one per delivery
 * attempt.
 *
 * It needs a table rather than a column because a booking has several lines, and it needs
 * one at all because a line item is the one HubSpot object here with no natural key
 * HubSpot itself dedupes on: a contact upserts by email, and the invoice and deal are one
 * each, persisted to `orders` the moment they are created for exactly this reason.
 */
async function loadOwnedLineItemIds(
  owner: LineItemOwner,
  parentObjectType: 'invoices' | 'deals',
  parentId: string,
): Promise<Map<string, string>> {
  try {
    const rows = await owner.db
      .prepare(
        `SELECT external_id, line_item_id FROM hubspot_line_items
         WHERE portal_id = ?1 AND parent_object_type = ?2 AND parent_id = ?3`,
      )
      .bind(owner.portalId, parentObjectType, parentId)
      .all<{ external_id: string; line_item_id: string }>();
    return new Map((rows.results ?? []).map((row) => [row.external_id, row.line_item_id]));
  } catch (err) {
    logLineItemRegistryUnavailable(err, 'read');
    return new Map();
  }
}

async function recordOwnedLineItem(
  owner: LineItemOwner,
  parentObjectType: 'invoices' | 'deals',
  parentId: string,
  externalId: string,
  lineItemId: string,
): Promise<void> {
  if (!externalId) return;
  try {
    await owner.db
      .prepare(
        `INSERT OR REPLACE INTO hubspot_line_items
           (portal_id, parent_object_type, parent_id, external_id, line_item_id, order_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(
        owner.portalId,
        parentObjectType,
        parentId,
        externalId,
        lineItemId,
        owner.orderId,
        new Date().toISOString(),
      )
      .run();
  } catch (err) {
    logLineItemRegistryUnavailable(err, 'write');
  }
}

/**
 * Archive a line item we created and forget it. Best-effort by design: the surplus this
 * removes is already-wrong data, and failing a booking's write-back over a tidy-up would
 * trade a cosmetic fault for a real one.
 */
async function discardOwnedLineItem(
  token: string,
  owner: LineItemOwner,
  parentObjectType: 'invoices' | 'deals',
  parentId: string,
  externalId: string,
  lineItemId: string,
  reason: string,
): Promise<void> {
  try {
    await hs(token, 'DELETE', `${HS_API}/crm/v3/objects/line_items/${lineItemId}`);
  } catch (err) {
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'line_item_discard_failed',
        parentObjectType,
        parentId,
        lineItemId,
        reason: err instanceof Error ? err.message : String(err),
      }),
    );
    return;
  }
  if (externalId) {
    try {
      await owner.db
        .prepare(
          `DELETE FROM hubspot_line_items
           WHERE portal_id = ?1 AND parent_object_type = ?2 AND parent_id = ?3 AND external_id = ?4`,
        )
        .bind(owner.portalId, parentObjectType, parentId, externalId)
        .run();
    } catch (err) {
      logLineItemRegistryUnavailable(err, 'delete');
    }
  }
  console.log(
    JSON.stringify({
      level: 'info',
      event: 'line_item_discarded',
      parentObjectType,
      parentId,
      lineItemId,
      externalId,
      reason,
    }),
  );
}

async function attachExclusiveLineItems(
  token: string,
  owner: LineItemOwner,
  parentObjectType: 'invoices' | 'deals',
  parentId: string,
  lineToParentAssocTypeId: number,
  lines: Array<Record<string, string | number>>,
): Promise<void> {
  const owned = await loadOwnedLineItemIds(owner, parentObjectType, parentId);
  const existing = await loadAssociatedLineItems(token, parentObjectType, parentId);
  const byId = new Map(existing.map((row) => [row.id, row]));
  const used = new Set<string>();
  const wanted = new Set<string>();

  for (const props of lines) {
    const externalId = String(props.hs_external_id ?? '');
    if (externalId) wanted.add(externalId);

    // D1 first, and only then what HubSpot can see. The reverse order is the bug: a line
    // we created a retry ago that the association index has not caught up with would be
    // created again.
    const ownedId = externalId ? owned.get(externalId) : undefined;
    const match =
      (ownedId && !used.has(ownedId)
        ? (byId.get(ownedId) ?? { id: ownedId, properties: {} })
        : undefined) ??
      (externalId
        ? existing.find((row) => !used.has(row.id) && row.properties.hs_external_id === externalId)
        : undefined) ??
      existing.find((row) => !used.has(row.id));

    let lineItemId: string;
    if (match) {
      used.add(match.id);
      lineItemId = match.id;
      if (lineItemNeedsUpdate(match.properties, props)) {
        await hs(token, 'PATCH', `${HS_API}/crm/v3/objects/line_items/${lineItemId}`, {
          properties: props,
        });
      }
      await recordOwnedLineItem(owner, parentObjectType, parentId, externalId, lineItemId);
    } else {
      lineItemId = await createLineItem(token, props);
      used.add(lineItemId);
      // Persisted BEFORE the association PUT below, which is retryable: a 5xx there must
      // not leave the next attempt believing it never made this line.
      await recordOwnedLineItem(owner, parentObjectType, parentId, externalId, lineItemId);
    }

    await hs(
      token,
      'PUT',
      `${HS_API}/crm/v4/objects/line_items/${lineItemId}/associations/${parentObjectType}/${parentId}`,
      [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: lineToParentAssocTypeId }],
    );
  }

  // Surplus cleanup, restricted to lines we created for THIS booking: a duplicate left by
  // an earlier attempt (the four-line invoice of Ref 40) or a line whose ticket type has
  // since gone from the booking. Anything else associated with the invoice is somebody
  // else's — a line a human added, or one the portal put there — and is left alone.
  for (const [externalId, lineItemId] of owned) {
    if (used.has(lineItemId)) continue;
    if (wanted.has(externalId)) continue;
    await discardOwnedLineItem(
      token,
      owner,
      parentObjectType,
      parentId,
      externalId,
      lineItemId,
      'no longer part of the booking',
    );
  }
  for (const row of existing) {
    if (used.has(row.id)) continue;
    const externalId = row.properties.hs_external_id ?? '';
    // Same external id as a line we just attached => a duplicate of it, and ours.
    if (!externalId || !wanted.has(externalId)) continue;
    await discardOwnedLineItem(
      token,
      owner,
      parentObjectType,
      parentId,
      '',
      row.id,
      'duplicate of an attached line',
    );
  }
}

// ---------------------------------------------------------------------------
// Best-effort deal → marketing event association
//
// HubSpot's Marketing Events API is external-id based, while CRM associations
// require a CRM object id. When HubSpot returns/stores that object id from
// me.create, we associate it here. If the portal/API does not expose a usable
// marketing-event CRM object type, Deal creation must still succeed; reporting
// association can be fixed by configuration/retry once HubSpot exposes the id.
// ---------------------------------------------------------------------------

async function associateDealToMarketingEvent(
  token: string,
  db: D1Database,
  portalId: string,
  dealId: string,
  hubspotEventId: string,
): Promise<void> {
  const event = await db
    .prepare(
      `SELECT hubspot_marketing_event_object_id FROM events
       WHERE portal_id = ?1 AND hubspot_event_id = ?2`,
    )
    .bind(portalId, hubspotEventId)
    .first<{ hubspot_marketing_event_object_id: string | null }>();

  const marketingEventObjectId = event?.hubspot_marketing_event_object_id;
  if (!marketingEventObjectId) return;

  for (const marketingEventObjectType of ['marketing_events', 'marketing_event', '0-54']) {
    try {
      const assocTypeId = await resolveAssocTypeId(
        token,
        'deals',
        marketingEventObjectType,
        'PRIMARY',
      );
      await hs(
        token,
        'PUT',
        `${HS_API}/crm/v4/objects/deals/${dealId}/associations/${marketingEventObjectType}/${marketingEventObjectId}`,
        [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: assocTypeId }],
      );
      return;
    } catch (err) {
      if (err instanceof RetryableError) throw err;
      // Try the next plausible object type. If all fail, log below.
    }
  }

  console.log(
    JSON.stringify({
      level: 'warn',
      event: 'deal_marketing_event_association_skipped',
      portalId,
      dealId,
      hubspotEventId,
      marketingEventObjectId,
      reason: 'No supported Marketing Event association object type was accepted by HubSpot',
    }),
  );
}

async function associateExistingDealsToMarketingEvent(
  token: string,
  db: D1Database,
  portalId: string,
  hubspotEventId: string,
): Promise<void> {
  const rows = await db
    .prepare(
      `SELECT DISTINCT o.hubspot_deal_id
       FROM orders o
       JOIN events e ON e.id = o.event_id
       WHERE e.portal_id = ?1
         AND e.hubspot_event_id = ?2
         AND o.hubspot_deal_id IS NOT NULL
       LIMIT 50`,
    )
    .bind(portalId, hubspotEventId)
    .all<{ hubspot_deal_id: string }>();

  for (const row of rows.results) {
    await associateDealToMarketingEvent(token, db, portalId, row.hubspot_deal_id, hubspotEventId);
  }
}

// ---------------------------------------------------------------------------
// Handler: deal.create
// ---------------------------------------------------------------------------

async function handleDealCreate(
  token: string,
  db: D1Database,
  payload: Record<string, unknown>,
): Promise<void> {
  const {
    orderId,
    eventId,
    hubspotEventId,
    bookingKind,
    buyerEmail,
    buyerName,
    buyerAbn,
    totalCents,
    lineItems,
  } = payload as {
    orderId: string;
    eventId: string;
    hubspotEventId: string;
    bookingKind?: BookingKind;
    buyerEmail: string;
    buyerName: string;
    buyerAbn: string | null;
    totalCents: number;
    lineItems: Array<{
      ticketTypeId: string;
      name: string;
      quantity: number;
      unitCents: number;
      totalCents: number;
      taxTreatment?: string;
      hsTaxRateId: string | null;
      hsProductId: string | null;
    }>;
  };

  // Load order + registrations
  const orderRow = await db
    .prepare(
      `SELECT o.*, e.title as event_title
       FROM orders o
       LEFT JOIN events e ON e.id = o.event_id
       WHERE o.id = ?1`,
    )
    .bind(orderId)
    .first<{
      id: string;
      event_id: string;
      event_title: string | null;
      buyer_email: string;
      buyer_name: string;
      buyer_abn: string | null;
      portal_id: string;
      hubspot_deal_id: string | null;
      status: string;
    }>();

  if (!orderRow) throw new PermanentError(`Order not found: ${orderId}`);
  if (
    orderRow.status === 'cancelled' ||
    orderRow.status === 'refunded' ||
    orderRow.status === 'partially_refunded'
  ) {
    return;
  }

  const commerceLineItems = formatCommerceLinesForBooking(orderRow.event_title, lineItems);
  // Reuse an already-created deal rather than returning: a prior attempt may have
  // created (and persisted) the deal but failed on a follow-up association/line-item
  // call, leaving the deal incomplete. We resume those idempotent follow-ups below.
  let dealId = orderRow.hubspot_deal_id;
  const routing = await resolveDealRouting(token, db, orderRow.portal_id, bookingKind);
  const dealTypeValue = await resolveDealTypePropertyValue(
    token,
    routing.dealTypePropertyName,
    routing.dealTypeLabel,
  );

  const regsResult = await db
    .prepare(
      'SELECT id, attendee_email, attendee_name, hubspot_contact_id FROM registrations WHERE order_id = ?1',
    )
    .bind(orderId)
    .all<RegistrationRow>();
  const registrations = regsResult.results;

  // 1. Upsert contacts first
  const emailToContactId = await resolveContactsForOrder(
    token,
    db,
    { id: orderId, buyer_email: buyerEmail, buyer_name: buyerName, buyer_abn: buyerAbn ?? null },
    registrations,
    { topic: 'deal.create', portalId: orderRow.portal_id },
  );

  const buyerContactId = emailToContactId.get(buyerEmail);
  if (!buyerContactId) throw new PermanentError('Failed to resolve buyer contact');

  // 2. Resolve company id from buyer contact
  let companyId: string | undefined;
  try {
    const assocTypeId = await resolveAssocTypeId(token, 'contacts', 'companies', 'PRIMARY');
    const assocUrl = `${HS_API}/crm/v4/objects/contacts/${buyerContactId}/associations/companies`;
    const assocData = (await hs(token, 'GET', assocUrl)) as {
      results: Array<{ toObjectId: string; associationTypes: Array<{ typeId: number }> }>;
    };
    const primary = assocData.results.find((r) =>
      r.associationTypes.some((t) => t.typeId === assocTypeId),
    );
    companyId = primary?.toObjectId;
  } catch {
    // no company — deal will just not have a company association
  }

  // 3. Create deal — then persist its id IMMEDIATELY, before any of the retryable
  //    follow-up calls below. If we deferred the write and an association/line-item
  //    call hit a 429/5xx, the retry would see hubspot_deal_id still NULL and create
  //    a second deal, duplicating the revenue object.
  if (!dealId) {
    const dealProperties: Record<string, string> = {
      dealname: `${hubspotEventId} — ${buyerName}`,
      dealstage: routing.stageId,
      pipeline: routing.pipelineId,
      amount: (totalCents / 100).toFixed(2),
      closedate: new Date().toISOString().split('T')[0],
    };
    if (dealTypeValue && routing.dealTypePropertyName) {
      dealProperties[routing.dealTypePropertyName] = dealTypeValue;
    }

    // Drop-only: a deal property is never one the app manages (provisioning covers
    // contacts and companies), so a portal missing one loses that field and keeps its
    // deal. A booking with no revenue object is a worse answer than a deal with no type.
    const dealData = (await writeProperties(
      token,
      'POST',
      `${HS_API}/crm/v3/objects/deals`,
      dealProperties,
      { topic: 'deal.create', portalId: orderRow.portal_id },
    )) as { id: string };
    dealId = dealData.id;
    await db
      .prepare('UPDATE orders SET hubspot_deal_id = ?1, updated_at = ?2 WHERE id = ?3')
      .bind(dealId, new Date().toISOString(), orderId)
      .run();
  }

  // 4. Associate deal → contact
  const dealContactTypeId = await resolveAssocTypeId(token, 'deals', 'contacts', 'PRIMARY');
  await hs(
    token,
    'PUT',
    `${HS_API}/crm/v4/objects/deals/${dealId}/associations/contacts/${buyerContactId}`,
    [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: dealContactTypeId }],
  );

  // 5. Associate deal → company (if found)
  if (companyId) {
    const dealCompanyTypeId = await resolveAssocTypeId(token, 'deals', 'companies', 'PRIMARY');
    await hs(
      token,
      'PUT',
      `${HS_API}/crm/v4/objects/deals/${dealId}/associations/companies/${companyId}`,
      [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: dealCompanyTypeId }],
    );
  }

  // 6. Associate deal → marketing event when the Marketing Event CRM object id
  //    is known. Best-effort for reporting/automation; Deal creation must not
  //    fail only because the Marketing Event association object type is absent.
  await associateDealToMarketingEvent(token, db, orderRow.portal_id, dealId, hubspotEventId);

  // 7. Tax-exclusive product lines + the portal's tax library rate (tax under subtotal).
  const liDealTypeId = await resolveAssocTypeId(token, 'line_items', 'deals', 'PRIMARY');
  await attachExclusiveLineItems(
    token,
    { db, portalId: orderRow.portal_id, orderId },
    'deals',
    dealId,
    liDealTypeId,
    commerceLineItems.map((li) => {
      const taxRateId = isGstFreeTreatment(li.taxTreatment) ? null : (li.hsTaxRateId ?? null);
      return buildCommerceLineProps(orderId, li, '', taxRateId);
    }),
  );

  void eventId; // used in payload shape, not needed beyond above
  void buyerAbn; // stored on contact, not deal
}

// ---------------------------------------------------------------------------
// Handler: invoice.create
// ---------------------------------------------------------------------------

async function handleInvoiceCreate(
  token: string,
  db: D1Database,
  payload: Record<string, unknown>,
): Promise<void> {
  const {
    orderId,
    buyerEmail,
    buyerName,
    buyerAbn,
    totalCents,
    currency,
    invoiceDueDate,
    lineItems,
  } = payload as {
    orderId: string;
    eventId: string;
    hubspotEventId: string;
    buyerEmail: string;
    buyerName: string;
    buyerAbn: string | null;
    totalCents: number;
    currency: string;
    invoiceDueDate?: string;
    lineItems: Array<{
      ticketTypeId: string;
      name: string;
      quantity: number;
      unitCents: number;
      totalCents: number;
      taxTreatment?: string;
      hsTaxRateId: string | null;
      hsProductId: string | null;
    }>;
  };

  // Idempotency check + resolve tenant tax rates. Never trust the outbox payload alone for
  // hsTaxRateId — older reserve builds (and pre-migration ticket rows) left it null even
  // when tenants.xero_gst_rate_id was configured, which produced HubSpot invoices with no
  // tax under the subtotal at the inclusive price (see TEST-1056 / ticket 214 follow-ups).
  const orderRow = await db
    .prepare(
      `SELECT o.portal_id, o.hubspot_deal_id, o.hubspot_invoice_id, o.event_id, o.status,
              o.total_cents, o.payment_method,
              e.title as event_title,
              t.xero_gst_rate_id, t.xero_gst_free_rate_id
       FROM orders o
       JOIN tenants t ON t.portal_id = o.portal_id
       LEFT JOIN events e ON e.id = o.event_id
       WHERE o.id = ?1`,
    )
    .bind(orderId)
    .first<{
      portal_id: string;
      hubspot_deal_id: string | null;
      hubspot_invoice_id: string | null;
      event_id: string;
      status: string;
      total_cents: number | null;
      payment_method: string | null;
      event_title: string | null;
      xero_gst_rate_id: string | null;
      xero_gst_free_rate_id: string | null;
    }>();

  if (!orderRow) throw new PermanentError(`Order not found: ${orderId}`);
  if (orderRow.status === 'cancelled') {
    if (orderRow.hubspot_invoice_id) {
      await hs(token, 'PATCH', `${HS_API}/crm/v3/objects/invoices/${orderRow.hubspot_invoice_id}`, {
        properties: { hs_invoice_status: 'voided' },
      });
    }
    return;
  }
  if (orderRow.status === 'refunded' || orderRow.status === 'partially_refunded') {
    return;
  }

  const tenantGstRateId = orderRow.xero_gst_rate_id;
  const gstFreeRateId = orderRow.xero_gst_free_rate_id;
  const commerceLineItems = formatCommerceLinesForBooking(orderRow.event_title, lineItems);

  // Nothing to bill. HubSpot refuses to open an invoice whose `hs_amount_billed` is 0.00,
  // so this used to create a DRAFT, fail the PATCH to `open`, and die — leaving a junk
  // draft on the portal per attempt. Weld's imported CAMS orders are all of these.
  //
  // A FREE booking is not that fault. Some of Weld's courses and events cost nothing, and
  // reserve already declines to raise `invoice.create` for one: there is no money to
  // collect, so there is nothing for HubSpot to invoice and nothing to fix. Reaching here
  // means some other path enqueued it (the repair sweep did, once per cron tick, until it
  // learned to skip an order with nothing to bill), and the only useful thing to do is
  // decline quietly — saying it at `warn` with a "check the prices" remedy sends whoever
  // reads the logs after a fault that is not there.
  //
  // An order that DOES owe money and whose lines still come to zero is the real fault, and
  // keeps the warning: its value did not survive into its lines.
  //
  // Summed over `totalCents`, which is the figure `buildCommerceLineProps` actually bills,
  // so the guard and the invoice cannot disagree about whether there is anything to send.
  const billableCents = commerceLineItems.reduce(
    (sum, li) => sum + (li.totalCents ?? li.unitCents * li.quantity),
    0,
  );
  if (billableCents <= 0) {
    const owesMoney = (orderRow.total_cents ?? 0) > 0 || orderRow.payment_method !== null;
    console.log(
      JSON.stringify({
        level: owesMoney ? 'warn' : 'info',
        event: owesMoney ? 'invoice_skipped_zero_value' : 'invoice_not_required_free_booking',
        portalId: orderRow.portal_id,
        orderId,
        lineItems: commerceLineItems.length,
        orderTotalCents: orderRow.total_cents ?? 0,
        reason: owesMoney
          ? 'Nothing to bill: HubSpot cannot open an invoice for 0.00, but this order owes ' +
            'money. Check the order total and its ticket prices.'
          : 'Free booking: nothing to bill, so no invoice is raised.',
      }),
    );
    return;
  }

  // Ensure deal exists (invoice.create may run before deal.create completes)
  if (!orderRow.hubspot_deal_id) {
    throw new RetryableError(`Deal not yet created for order ${orderId}`);
  }

  const dealId = orderRow.hubspot_deal_id;
  // Reuse an already-created invoice rather than returning: a prior attempt may have
  // created (and persisted) the invoice but failed on a follow-up call, leaving it
  // incomplete. We resume those idempotent follow-ups below.
  let invoiceId = orderRow.hubspot_invoice_id;

  // Resolve buyer contact id
  // `abn` is a contact property this app does not own and Weld's portal may not have.
  // Dropping it costs the contact a field; failing here costs the booking its invoice.
  const buyerContactId = await upsertContact(
    token,
    buyerEmail,
    nameToContactProperties(buyerEmail, buyerName, buyerAbn ? { abn: buyerAbn } : {}),
    { topic: 'invoice.create', portalId: orderRow.portal_id },
  );

  // 1. Draft invoice. HubSpot's invoice date fields are datetimes, not date-only
  // strings. A bare YYYY-MM-DD is rejected with a 400 before the draft is created.
  // Keep each configured calendar day by pinning it to UTC midnight: HubSpot renders
  // these in the portal's timezone, and an end-of-day instant would show as the NEXT
  // day in Adelaide (+9:30).
  //
  // BOTH dates get that treatment, which is the Ref 40 fix. The issue date used to be
  // `new Date().toISOString()` — the current instant — while the due date was midnight
  // of its day, so a buyer paying at checkout (no invoice terms, so due on receipt, i.e.
  // due TODAY) got an invoice due some hours before it was issued. HubSpot lets that
  // through on a DRAFT and refuses it at the PATCH to `open`, which is the whole visible
  // failure: the invoice never opened, so no invoice email went out, no hosted payment
  // link was ever written to the order, the buyer's poll sat on "we'll email you shortly",
  // and the draft left behind is the one HubSpot's own UI throws "There was a problem with
  // the invoice" on. Due on receipt means due date == issue date, not due date < issue date.
  //
  // `dateOnly(0)` in routes/reserve.ts derives the due date from the UTC day, so the issue
  // date is floored in the same frame. Deriving one of them in the tenant's display
  // timezone and the other in UTC is how they would come apart again.
  const dueDate = invoiceDueDate ? `${invoiceDueDate}T00:00:00.000Z` : undefined;
  const todayUtc = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
  // A due date already in the past (a reissue of a booking made months ago) cannot be
  // moved — it is what the customer was told — so the issue date gives way to it instead.
  const issueDate = dueDate && dueDate < todayUtc ? dueDate : todayUtc;
  const invoiceProps: Record<string, string> = {
    hs_invoice_status: 'draft',
    hs_currency: currency,
    hs_invoice_date: issueDate,
    ...(dueDate ? { hs_due_date: dueDate } : {}),
  };
  if (buyerAbn) {
    invoiceProps.hs_buyer_company_abn = buyerAbn;
  }

  // Create the draft invoice — then persist its id IMMEDIATELY, before any of the
  // retryable follow-up calls below (associations, line items, status patch, payment
  // link read). If we deferred the write and a later call hit a 429/5xx, the retry
  // would see hubspot_invoice_id still NULL and create a second payable invoice.
  if (!invoiceId) {
    // Drop-only, as for the deal: `hs_buyer_company_abn` is the portal's field, not ours,
    // and an invoice without an ABN on it is recoverable where no invoice at all is not.
    const invoiceData = (await writeProperties(
      token,
      'POST',
      `${HS_API}/crm/v3/objects/invoices`,
      invoiceProps,
      { topic: 'invoice.create', portalId: orderRow.portal_id },
    )) as { id: string };
    invoiceId = invoiceData.id;
    await db
      .prepare('UPDATE orders SET hubspot_invoice_id = ?1, updated_at = ?2 WHERE id = ?3')
      .bind(invoiceId, new Date().toISOString(), orderId)
      .run();
  }

  // 2. Associate invoice → contact
  const invoiceContactTypeId = await resolveAssocTypeId(token, 'invoices', 'contacts', 'PRIMARY');
  await hs(
    token,
    'PUT',
    `${HS_API}/crm/v4/objects/invoices/${invoiceId}/associations/contacts/${buyerContactId}`,
    [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: invoiceContactTypeId }],
  );

  // 3. Tax-exclusive product lines + the portal's tax library rate so tax lands under
  //    the subtotal (Revenue Hub tax compliance). The stored price is already the
  //    exclusive amount; HubSpot applies the rate on top at whatever percentage the
  //    tenant's library holds (see gst.test.ts).
  //    Reuse lines already on this invoice when a later step (open PATCH) 5xxs —
  //    search-by-hs_external_id 400s here, so a naive retry POSTs duplicates.
  const liInvoiceTypeId = await resolveAssocTypeId(token, 'line_items', 'invoices', 'PRIMARY');
  await attachExclusiveLineItems(
    token,
    { db, portalId: orderRow.portal_id, orderId },
    'invoices',
    invoiceId,
    liInvoiceTypeId,
    commerceLineItems.map((li) => {
      const taxRateId = isGstFreeTreatment(li.taxTreatment)
        ? gstFreeRateId
        : (li.hsTaxRateId ?? tenantGstRateId);
      return buildCommerceLineProps(orderId, li, 'inv:', taxRateId);
    }),
  );

  // 4. Associate invoice → deal
  const invoiceDealTypeId = await resolveAssocTypeId(token, 'invoices', 'deals', 'PRIMARY');
  await hs(
    token,
    'PUT',
    `${HS_API}/crm/v4/objects/invoices/${invoiceId}/associations/deals/${dealId}`,
    [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: invoiceDealTypeId }],
  );

  const currentOrder = await db
    .prepare('SELECT status FROM orders WHERE id = ?1')
    .bind(orderId)
    .first<{ status: string }>();
  if (currentOrder?.status === 'cancelled') {
    await hs(token, 'PATCH', `${HS_API}/crm/v3/objects/invoices/${invoiceId}`, {
      properties: { hs_invoice_status: 'voided' },
    });
    await db
      .prepare('UPDATE orders SET hubspot_invoice_url = NULL, updated_at = ?1 WHERE id = ?2')
      .bind(new Date().toISOString(), orderId)
      .run();
    return;
  }
  if (currentOrder?.status === 'refunded' || currentOrder?.status === 'partially_refunded') {
    return;
  }

  // 5. PATCH status to open
  await hs(token, 'PATCH', `${HS_API}/crm/v3/objects/invoices/${invoiceId}`, {
    properties: { hs_invoice_status: 'open' },
  });

  // 6. Read the hosted payment link and persist it on the order so the buyer's poll
  //    (GET /api/v1/orders/:id → paymentUrl) can hand off to the HubSpot-hosted invoice.
  //    Without this the poll never sees a paymentUrl and the buyer never reaches checkout.
  //    Idempotent: re-running this handler simply re-reads and re-writes the same link.
  const invoiceFull = (await hs(
    token,
    'GET',
    `${HS_API}/crm/v3/objects/invoices/${invoiceId}?properties=hs_invoice_link`,
  )) as { properties: { hs_invoice_link?: string } };
  const invoiceLink = invoiceFull.properties.hs_invoice_link;
  if (invoiceLink) {
    await db
      .prepare('UPDATE orders SET hubspot_invoice_url = ?1, updated_at = ?2 WHERE id = ?3')
      .bind(invoiceLink, new Date().toISOString(), orderId)
      .run();
  }

  void totalCents; // already captured in line items
}

// ---------------------------------------------------------------------------
// Main queue message dispatcher
// ---------------------------------------------------------------------------

/**
 * Retire a webinar registration the worker has replaced.
 *
 * Written by an amendment that changed who a seat names: the replacement registration is
 * created first and the old one retired here, carrying its id in the payload because the
 * amendment has already overwritten the stored copy. Until this lands, the previous
 * attendee's personal join URL still opens the webinar.
 *
 * Throws so the queue retries. A provider with nothing to cancel — unconfigured, or no
 * `cancelRegistration` — is not a failure and returns quietly; there is nothing a retry
 * would do differently.
 */
async function handleWebinarCancelRegistration(
  env: Env,
  portalId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const webinarId = typeof payload.webinarId === 'string' ? payload.webinarId : null;
  const providerRegistrationId =
    typeof payload.providerRegistrationId === 'string' ? payload.providerRegistrationId : null;
  if (!webinarId || !providerRegistrationId) return;
  const provider = typeof payload.provider === 'string' ? payload.provider : null;
  await cancelWebinarRegistration(env, portalId, provider, webinarId, providerRegistrationId);
}

export async function handleOutboxMessage(msg: Message<OutboxSignal>, env: Env): Promise<void> {
  const signal = msg.body;
  const { kind, portalId } = signal;

  // For outbox-driven messages, load the row.
  // For non-outbox messages (e.g. expire_hold) the caller handles them.
  const outboxId = signal.outboxId;
  if (!outboxId) {
    // No outbox row — nothing to do for unknown kinds.
    msg.ack();
    return;
  }

  const row = await loadOutboxRow(env.DB, outboxId);
  if (!row) {
    // Row gone — already delivered or dead.
    msg.ack();
    return;
  }

  if (row.status === 'delivered' || row.status === 'dead') {
    msg.ack();
    return;
  }

  // Parse ONCE, before anything branches on the payload, and treat a payload that will not
  // parse as permanent.
  //
  // This used to sit bare between the branches below, outside every try: a row whose
  // payload was not JSON threw straight out of this function, so it was never marked dead,
  // never logged as `outbox_dead`, and stayed `pending` for the reconcile sweep to re-drive
  // every fifteen minutes — burning its four queue attempts and dead-lettering again each
  // time, for good. A row nobody can parse is a row no retry will ever deliver, which is
  // the definition of permanent; the only useful thing left to do with it is record why.
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>;
  } catch (err) {
    await markDead(
      env.DB,
      outboxId,
      `Malformed outbox payload (${kind}): ${err instanceof Error ? err.message : String(err)}`,
    );
    msg.ack();
    return;
  }

  // Rows that don't touch HubSpot — handled before resolving a HubSpot token, which would
  // otherwise throw for them. `webinar.cancel_registration` talks to the webinar provider
  // (Teams, and whatever else is behind the interface), on the provider's own credentials.
  if (
    kind === 'notify.waitlist_joined' ||
    kind === 'notify.waitlist_offer' ||
    kind === 'webinar.cancel_registration'
  ) {
    try {
      if (kind === 'webinar.cancel_registration') {
        await handleWebinarCancelRegistration(env, portalId, payload);
      } else {
        await handleNotify(kind, payload);
      }
      await env.DB.prepare(MARK_DELIVERED_SQL).bind(outboxId).run();
      msg.ack();
    } catch {
      await env.DB.prepare(
        `UPDATE outbox SET status = 'failed', attempts = attempts + 1 WHERE id = ?1`,
      )
        .bind(outboxId)
        .run();
      msg.retry();
    }
    return;
  }

  try {
    const token = await loadHubSpotToken(env, portalId);

    switch (kind) {
      case 'me.create':
        await handleMeCreate(token, payload, env.DB);
        break;

      case 'me.register':
        await handleMeAttendance(token, env.DB, row, 'register');
        break;

      case 'me.attend':
        await handleMeAttendance(token, env.DB, row, 'attend');
        break;

      case 'me.cancel':
        await handleMeAttendance(token, env.DB, row, 'cancel');
        break;

      case 'me.complete':
        await handleMeComplete(token, env.DB, payload);
        break;

      case 'contact.set_join_url':
        await handleContactSetJoinUrl(token, env, portalId, payload);
        break;

      case 'contact.sync_attendee_details':
        await handleContactSyncAttendeeDetails(token, env, portalId, payload);
        break;

      case 'contact.sync_registration_confirmation':
        await handleRegistrationConfirmation(token, env, portalId, payload);
        break;

      case 'contact.sync_attendance':
        await handleContactSyncAttendance(token, env, portalId, payload);
        break;

      case 'contact.sync_answers':
        await handleContactSyncAnswers(token, env, portalId, payload);
        break;

      case 'contact.upsert':
        await handleContactUpsert(token, env.DB, payload);
        break;

      case 'deal.create':
        await handleDealCreate(token, env.DB, payload);
        break;

      case 'invoice.create':
        await handleInvoiceCreate(token, env.DB, payload);
        break;

      case 'payment.refund':
        await handlePaymentRefund(token, env.DB, payload);
        break;

      case 'notify.owner_task':
        await handleOwnerTask(token, payload);
        break;

      case 'company.sync_voucher_usage':
        await handleCompanyVoucherUsage(token, env, payload);
        break;

      case 'note.create':
        await handleStaffNoteCreate(token, env, portalId, payload);
        break;

      case 'question.ensure_property':
        await handleQuestionPropertyEnsure(token, env, portalId, payload);
        break;

      default:
        // Unknown kind — ack and mark dead to avoid looping.
        await markDead(env.DB, outboxId, `Unknown kind: ${kind}`);
        msg.ack();
        return;
    }

    // Success: mark delivered, and drop the reason it failed on the way there.
    await env.DB.prepare(MARK_DELIVERED_SQL).bind(outboxId).run();
    msg.ack();
  } catch (err) {
    if (err instanceof PermanentError) {
      await markDead(env.DB, outboxId, err.message);
      msg.ack();
      return;
    }

    // Everything else is retryable: a RetryableError says how long to wait, and an unknown
    // error (a D1 fault, a bug) is given a minute.
    //
    // DEFAULT_RETRY_MS rather than no delay at all. `msg.retry()` with no delay re-runs the
    // row within milliseconds, so a race like "deal.create has not finished yet" burned all
    // four queue attempts before the thing it was waiting for could possibly have happened,
    // and then waited fifteen minutes for the reconcile sweep to do it again. The wait is
    // the point of the retry.
    const retryAfterMs =
      err instanceof RetryableError ? (err.retryAfterMs ?? DEFAULT_RETRY_MS) : 60 * 1000;
    const reason = err instanceof RetryableError ? err.message : String(err);

    // A row that has failed this many times is not going to fix itself. Dying puts it in
    // `outbox_dead` and in the outbox diagnostic, where a person looks; retrying for ever
    // put it nowhere, which is how two bookings reached 88 and 136 attempts with nobody
    // knowing they had no invoice.
    if (row.attempts + 1 >= MAX_OUTBOX_ATTEMPTS) {
      await markDead(env.DB, outboxId, `Gave up after ${row.attempts + 1} attempts: ${reason}`);
      msg.ack();
      return;
    }

    await env.DB.prepare(
      `UPDATE outbox SET status = 'failed', attempts = attempts + 1,
       next_attempt_at = ?1 WHERE id = ?2`,
    )
      .bind(new Date(Date.now() + retryAfterMs).toISOString(), outboxId)
      .run();
    // On the row, not only in a log line: the retry path logs at warn, and an error-level
    // search for "why has this booking no invoice" finds nothing at all.
    await recordFailureReason(env.DB, outboxId, reason);
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'outbox_retry',
        outboxId,
        kind,
        portalId,
        attempts: row.attempts + 1,
        retryAfterMs,
        reason,
      }),
    );
    msg.retry({ delaySeconds: Math.ceil(retryAfterMs / 1000) });
  }
}

// ---------------------------------------------------------------------------
// reconcileOutbox: cron-driven sweep
// ---------------------------------------------------------------------------

/**
 * The cron sweep, optionally narrowed to one portal.
 *
 * Every step here takes the first 50 rows it finds, across every tenant, in no particular
 * order. That is fine while one portal is installed and stops being fine immediately after:
 * a tenant with a few hundred stuck rows would take every sweep and the others would never
 * be reached. Scoping is the first half of fixing that, and it is also how an operator
 * re-drives ONE portal after fixing what was wrong with it, rather than waiting for a
 * global sweep to happen to pick its rows.
 *
 * The cron still calls it unscoped.
 */
export async function reconcileOutbox(
  env: Env,
  options: { portalId?: string } = {},
): Promise<void> {
  const now = new Date().toISOString();
  // A no-op filter when unscoped: SQLite compares the column to itself, which is true for
  // every row, and keeps one statement rather than two spellings of each query.
  const portalFilter = options.portalId ?? null;

  // 1. Re-drive due failed rows
  const dueRows = await env.DB.prepare(
    `SELECT id, portal_id, topic FROM outbox
     WHERE status IN ('pending', 'failed') AND next_attempt_at <= ?1
       AND (?2 IS NULL OR portal_id = ?2)
     LIMIT 50`,
  )
    .bind(now, portalFilter)
    .all<{ id: string; portal_id: string; topic: string }>();

  for (const row of dueRows.results) {
    await env.QUEUE.send({
      kind: row.topic,
      portalId: row.portal_id,
      outboxId: row.id,
    });
  }

  // 2. Re-enqueue drifted registrations (synced state ≠ actual state)
  //    Detect registrations with a confirmed order but marketing_event_state_synced = 0
  //
  //    The "does a row for this already exist" checks in steps 2 and 3 matched the payload
  //    with a LIKE. **D1 caps a LIKE pattern at 50 bytes** (SQLITE_MAX_LIKE_PATTERN_LENGTH;
  //    a longer one is not a non-match, it is the ERROR "LIKE or GLOB pattern too
  //    complex"), and `%"registrationId":"` plus a UUID and its closing quote is 57. So on
  //    any portal whose registration ids are UUIDs — every portal — step 2 THREW, and
  //    because it throws, step 3 never ran at all: no drifted Marketing Event registration
  //    re-enqueued, and no missing deal or invoice ever recreated. That is why two live
  //    bookings sat on `invoice.create` rows waiting for a `deal.create` nothing was going
  //    to raise. `ctx.waitUntil` swallowed the rejection, so the only trace was an
  //    unhandled error on a cron nobody reads.
  //
  //    Step 3's own pattern came to exactly 50 and squeaked through, which is the other
  //    half of the argument: a guard one byte from failing, silently, on the length of an
  //    id nobody chose with this in mind.
  //
  //    `json_extract` has no such ceiling, is exact rather than a substring match (a LIKE
  //    on `"orderId":"x"` also matches a payload that merely quotes that id somewhere
  //    else), and reads through the same `json_valid` guard as every other outbox query.
  //
  // Three things this SELECT has to say beyond "the mirror is 0", because 0 is also what a
  // seat reads when it SHOULD have no Marketing Event participation:
  //
  //  - **An UNNAMED seat is not a person** (Ref 74b). Reserve deliberately raises no
  //    `me.register` for one, so its mirror stays 0 for ever — and this sweep, reading 0 as
  //    drift, would raise the row reserve refused to, upserting a contact from an empty
  //    email and putting somebody HubSpot invented onto the event. Migration 0039 names
  //    "the Marketing Event write-back" as a path that must read the flag; this is that
  //    path, and it was the one that did not.
  //  - **A CANCELLED seat is not a seat to register.** `me.cancel` sets the mirror back to
  //    0, which is the same 0, so a seat cancelled out of a booking whose colleagues are
  //    still coming looked exactly like one HubSpot had never heard of.
  //  - **A booking on INVOICE TERMS stays `pending`** until the money lands, up to 90 days,
  //    which is the ordinary shape of a Weld booking. Ref 78 fixed precisely this narrowness
  //    in step 3 below and left step 2 on `('paid','confirmed')`, so the repair never looked
  //    at most of the bookings it exists for. The condition is now step 3's, verbatim.
  const driftedRegs = await env.DB.prepare(
    `SELECT r.id, r.portal_id, r.attendee_email, r.hubspot_contact_id,
            e.hubspot_event_id, r.ticket_type_id
     FROM registrations r
     JOIN orders o ON o.id = r.order_id
     JOIN events e ON e.id = r.event_id
     WHERE (o.status IN ('paid', 'confirmed', 'needs_review')
            OR (o.status = 'pending' AND o.payment_method IS NOT NULL))
       AND r.marketing_event_state_synced = 0
       AND r.seat_unnamed = 0
       AND r.cancelled_at IS NULL
       AND (?1 IS NULL OR r.portal_id = ?1)
     LIMIT 50`,
  )
    .bind(portalFilter)
    .all<{
      id: string;
      portal_id: string;
      attendee_email: string;
      hubspot_contact_id: string | null;
      hubspot_event_id: string;
      ticket_type_id: string;
    }>();

  for (const reg of driftedRegs.results) {
    // Check if an outbox entry already exists for this registration
    // **A DEAD row blocks this, and that is the point.** It used to be excluded, so a
    // registration whose `me.register` had died was handed a fresh one every fifteen
    // minutes — which, against a cause nobody had fixed (a missing scope, a 403), dies
    // again, for ever: 96 dead rows a day for one seat, in a table that is never purged,
    // burying every real finding in the heartbeat that is supposed to surface them.
    //
    // Nor is much lost. A row dies after `MAX_OUTBOX_ATTEMPTS` failures or on a 4xx, and
    // neither of those is a transient blip this sweep could ride out. Re-driving a death
    // is a decision about a cause someone has to have fixed first, which is exactly what
    // `POST /manage/diagnostics/outbox/redrive` is for and why it is a person's call.
    // `delivered` still blocks too, unchanged: that seat is synced.
    const existing = await env.DB.prepare(
      `SELECT id FROM outbox WHERE topic = 'me.register'
          AND json_extract(IIF(json_valid(payload), payload, '{}'), '$.registrationId') = ?1`,
    )
      .bind(reg.id)
      .first<{ id: string }>();

    if (existing) continue; // already queued, already delivered, or dead and a human's

    // Resolve externalAccountId from tenant config (portal_id serves as account id)
    const outboxId = crypto.randomUUID();
    const interactionDateTime = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO outbox (id, portal_id, topic, payload, stable_interaction_datetime, created_at)
       VALUES (?1, ?2, 'me.register', ?3, ?4, ?5)`,
    )
      .bind(
        outboxId,
        reg.portal_id,
        JSON.stringify({
          registrationId: reg.id,
          attendeeEmail: reg.attendee_email,
          hubspotContactId: reg.hubspot_contact_id,
          hubspotEventId: reg.hubspot_event_id,
          externalAccountId: reg.portal_id,
          ticketTypeId: reg.ticket_type_id,
        }),
        interactionDateTime,
        interactionDateTime,
      )
      .run();

    await env.QUEUE.send({ kind: 'me.register', portalId: reg.portal_id, outboxId });
  }

  // 3. Flag paid orders missing their HubSpot deal AND/OR invoice. The deal and the
  //    invoice are re-enqueued independently: an order can have a deal but still be
  //    missing its invoice. Re-enqueuing only deal.create in that case is a no-op (the
  //    deal handler returns early once the deal exists), so the invoice would never be
  //    recreated and the cron would keep adding delivered no-op deal rows forever.
  //
  // `status = 'paid'` alone was the bug. A booking on INVOICE TERMS stays `pending` until
  // the money lands, which is up to 90 days, and that is the ordinary shape of a Weld
  // booking — so the one sweep that repairs a missing deal or invoice never looked at the
  // bookings most likely to need it. An order missing its deal stalls its own
  // `invoice.create` for ever (that handler waits on `hubspot_deal_id`), and nothing came
  // to fix it: two live bookings sat at 88 and 136 attempts with no invoice.
  //
  // `payment_method IS NOT NULL` is what makes a `pending` row a booking that owes money
  // rather than a free one (NULL = free, per migration 0029), and a card hold that expires
  // unpaid is cancelled, which both handlers return early on. The `reenqueue` guard below
  // skips an order that already has a live row, so a hold still in flight is not doubled.
  //
  // **An order with nothing to bill is not missing its invoice; it has none to raise.**
  // `handleInvoiceCreate` returns early when the billable total is 0 (Ref 78: HubSpot
  // cannot open an invoice for 0.00), and returning early is what stops the junk drafts —
  // but it also leaves `hubspot_invoice_id` NULL for ever, which this sweep read as "still
  // missing". So every $0 order was handed a fresh `invoice.create` every fifteen minutes,
  // each one delivering as a no-op: not a dead row, but an outbox row per order per sweep
  // in a table that is never purged, and, because the scan is `LIMIT 50`, a budget the
  // orders that DO need repair have to share with orders that can never be repaired.
  // Weld's imported CAMS bookings are all $0, so they were most of that budget.
  //
  // The deal half is unaffected: a $0 booking is still a real booking and still gets its
  // deal, which is why that topic has never had a dead row here. `total_cents` is the
  // order-level half of the same figure the handler sums off the lines
  // (`SUM(unit_cents) = total_cents`, Phase 3.3); an order whose total survives but whose
  // LINES do not still reaches the handler's own guard, and no-ops once more rather than
  // for ever, because its invoice id stays NULL only until someone fixes the lines.
  const missingObjects = await env.DB.prepare(
    `SELECT id, portal_id, hubspot_deal_id, hubspot_invoice_id, total_cents FROM orders
     WHERE (hubspot_deal_id IS NULL OR (hubspot_invoice_id IS NULL AND total_cents > 0))
       AND (status IN ('paid', 'confirmed', 'needs_review')
            OR (status = 'pending' AND payment_method IS NOT NULL))
       AND (?1 IS NULL OR portal_id = ?1)
     LIMIT 50`,
  )
    .bind(portalFilter)
    .all<{
      id: string;
      portal_id: string;
      hubspot_deal_id: string | null;
      hubspot_invoice_id: string | null;
      total_cents: number;
    }>();

  for (const order of missingObjects.results) {
    if (!order.portal_id) continue;

    // Build the write-back payload at most once per order, lazily, and only when we
    // actually have something to enqueue. `null` = order/event missing → skip.
    let payload: Record<string, unknown> | null | undefined;
    const buildPayload = async (): Promise<Record<string, unknown> | null> => {
      if (payload !== undefined) return payload;
      const fullOrder = await env.DB.prepare('SELECT * FROM orders WHERE id = ?1')
        .bind(order.id)
        .first<{
          id: string;
          event_id: string;
          buyer_email: string;
          buyer_name: string;
          buyer_abn: string | null;
          total_cents: number;
          currency: string;
        }>();
      if (!fullOrder) {
        payload = null;
        return payload;
      }

      const event = await env.DB.prepare(
        'SELECT hubspot_event_id, booking_kind, title FROM events WHERE id = ?1',
      )
        .bind(fullOrder.event_id)
        .first<{
          hubspot_event_id: string;
          booking_kind: BookingKind | null;
          title: string | null;
        }>();
      if (!event) {
        payload = null;
        return payload;
      }

      const tenant = await env.DB.prepare(
        'SELECT xero_gst_rate_id FROM tenants WHERE portal_id = ?1',
      )
        .bind(order.portal_id)
        .first<{ xero_gst_rate_id: string | null }>();

      const lineItems = await env.DB.prepare(
        `SELECT tt.id as ticketTypeId, tt.name,
                COALESCE(ri.unit_cents, tt.price_cents) as unitCents,
                tt.hs_tax_rate_id as hsTaxRateId, tt.hs_product_id as hsProductId,
                tt.tax_treatment as taxTreatment,
                ri.quantity
         FROM reservation_items ri
         JOIN reservations res ON res.id = (SELECT reservation_id FROM orders WHERE id = ?1)
         JOIN ticket_types tt ON tt.id = ri.ticket_type_id
         WHERE ri.reservation_id = res.id AND ri.portal_id = ?2`,
      )
        .bind(order.id, order.portal_id)
        .all<{
          ticketTypeId: string;
          name: string;
          unitCents: number;
          hsTaxRateId: string | null;
          hsProductId: string | null;
          taxTreatment: string;
          quantity: number;
        }>();

      // Carries `currency` for invoice.create; deal.create ignores the extra field.
      payload = {
        orderId: fullOrder.id,
        eventId: fullOrder.event_id,
        hubspotEventId: event.hubspot_event_id,
        bookingKind: event.booking_kind ?? 'course',
        buyerEmail: fullOrder.buyer_email,
        buyerName: fullOrder.buyer_name,
        buyerAbn: fullOrder.buyer_abn,
        totalCents: fullOrder.total_cents,
        currency: fullOrder.currency,
        lineItems: lineItems.results.map((li) => ({
          ...li,
          name: formatBookingLineItemName(event.title, li.name),
          hsTaxRateId:
            li.hsTaxRateId ??
            (!isGstFreeTreatment(li.taxTreatment) ? (tenant?.xero_gst_rate_id ?? null) : null),
          totalCents: li.unitCents * li.quantity,
        })),
      };
      return payload;
    };

    const reenqueue = async (topic: 'deal.create' | 'invoice.create'): Promise<void> => {
      // `dead` blocks, for the reason step 2 gives: re-minting over a death is an
      // unbounded row-per-sweep loop against a cause nobody has fixed, and re-driving a
      // death is the re-drive endpoint's job.
      //
      // `delivered` deliberately does NOT block, and that asymmetry is load-bearing: an
      // order can have a delivered `deal.create` and still be missing its invoice, and the
      // deal handler returns early once the deal exists, so a no-op deal row is the price
      // of the invoice being recreated at all. What made that price unbounded was the $0
      // order, which is excluded from the scan above now.
      const existing = await env.DB.prepare(
        `SELECT id FROM outbox WHERE topic = ?1
            AND json_extract(IIF(json_valid(payload), payload, '{}'), '$.orderId') = ?2
            AND status != 'delivered'`,
      )
        .bind(topic, order.id)
        .first<{ id: string }>();
      if (existing) return; // already queued, or dead and a human's

      const body = await buildPayload();
      if (!body) return;

      const outboxId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
        .bind(outboxId, order.portal_id, topic, JSON.stringify(body), now)
        .run();
      await env.QUEUE.send({ kind: topic, portalId: order.portal_id, outboxId });
    };

    if (!order.hubspot_deal_id) await reenqueue('deal.create');
    // Guarded again per order, not only in the scan above: an order selected for its
    // MISSING DEAL can still have nothing to bill, and enqueuing an invoice for it would
    // reintroduce the forever-loop one row at a time.
    if (!order.hubspot_invoice_id && order.total_cents > 0) await reenqueue('invoice.create');
  }
}
