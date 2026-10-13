/**
 * Attendee contact capture — phone, suburb, state (Phase 1.2).
 *
 * Two halves:
 *   loadAttendeeContactConfig — which HubSpot CONTACT property each field maps to. Defaults
 *                               to HubSpot's STANDARD contact properties (phone / city /
 *                               state), which is where these values belong and where every
 *                               HubSpot list, workflow and export already looks for them.
 *                               A tenant whose portal keys them elsewhere overrides per
 *                               field (0021), same convention as membership_status_property
 *                               and the voucher property names — so nothing is hardcoded,
 *                               it just has a sensible standard default.
 *   diffContactDetails        — what the write-back is allowed to do. Fills only what
 *                               HubSpot leaves empty; anything that differs is reported as
 *                               a conflict for a human, never overwritten.
 *
 * The non-destructive rule is the point of the feature, not a nicety. The captured value
 * comes off a booking form — often typed by a colleague booking on someone else's behalf —
 * while the stored value is the member's own. Losing the latter to the former is worse
 * than capturing nothing, so a difference costs the event owner one decision.
 */

import type { ReserveContactDetails } from '@paddock/shared';
import type { Env } from './types';

export type AttendeeContactField = 'phone' | 'suburb' | 'state';

export const ATTENDEE_CONTACT_FIELDS: AttendeeContactField[] = ['phone', 'suburb', 'state'];

export interface AttendeeContactConfig {
  phoneProperty: string | null;
  suburbProperty: string | null;
  stateProperty: string | null;
}

/**
 * HubSpot's own contact properties for these three values. `city` is deliberate: an
 * Australian street address's suburb line IS HubSpot's City field — inventing a custom
 * `suburb` property would strand the data outside HubSpot's address block.
 */
export const STANDARD_CONTACT_PROPERTIES: Record<AttendeeContactField, string> = {
  phone: 'phone',
  suburb: 'city',
  state: 'state',
};

/**
 * Stored value that turns a field OFF rather than overriding it. NULL means "use the
 * standard property", so a tenant that does not want the worker touching, say, `phone`
 * needs a way to say so explicitly.
 */
export const CONTACT_PROPERTY_OFF = 'off';

export const NO_CONTACT_MAPPING: AttendeeContactConfig = {
  phoneProperty: null,
  suburbProperty: null,
  stateProperty: null,
};

/** The captured values, normalised for storage: trimmed, or null when not supplied. */
export interface AttendeeContactValues {
  phone: string | null;
  suburb: string | null;
  state: string | null;
}

export const NO_CONTACT_VALUES: AttendeeContactValues = { phone: null, suburb: null, state: null };

type ContactConfigRow = {
  contact_phone_property: string | null;
  contact_suburb_property: string | null;
  contact_state_property: string | null;
};

/**
 * NULL → HubSpot's standard property; 'off' → the tenant opted this field out; anything
 * else → their own property name.
 */
function resolveProperty(configured: unknown, field: AttendeeContactField): string | null {
  const value = emptyToNull(configured);
  if (value === null) return STANDARD_CONTACT_PROPERTIES[field];
  if (value.toLowerCase() === CONTACT_PROPERTY_OFF) return null;
  return value;
}

/**
 * Resolve the tenant's contact property mapping.
 *
 * Reading optional config must never fail a booking (Ref 217): against a tenants table
 * that predates 0021 this query throws "no such column". That degrades to the standard
 * HubSpot properties rather than to nothing — those are the correct target for a portal
 * that has expressed no preference, and an un-migrated tenant has expressed none.
 */
export async function loadAttendeeContactConfig(
  env: Env,
  portalId: string,
): Promise<AttendeeContactConfig> {
  let row: ContactConfigRow | null = null;
  try {
    row = await env.DB.prepare(
      `SELECT contact_phone_property, contact_suburb_property, contact_state_property
         FROM tenants WHERE portal_id = ?1`,
    )
      .bind(portalId)
      .first<ContactConfigRow>();
  } catch (err) {
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'attendee_contact_config_unreadable',
        portalId,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  return {
    phoneProperty: resolveProperty(row?.contact_phone_property, 'phone'),
    suburbProperty: resolveProperty(row?.contact_suburb_property, 'suburb'),
    stateProperty: resolveProperty(row?.contact_state_property, 'state'),
  };
}

export function propertyFor(
  config: AttendeeContactConfig,
  field: AttendeeContactField,
): string | null {
  if (field === 'phone') return config.phoneProperty;
  if (field === 'suburb') return config.suburbProperty;
  return config.stateProperty;
}

export function hasAnyMapping(config: AttendeeContactConfig): boolean {
  return ATTENDEE_CONTACT_FIELDS.some((field) => propertyFor(config, field) !== null);
}

// ---------------------------------------------------------------------------
// The online-event join URL
//
// Mapped the same way as the three fields above, and written on completely different terms.
// Worth stating why, because the diff logic in this module is the module's whole point and
// this deliberately does not use it:
//
//   phone / suburb / state — the value came off a booking form, possibly typed by a
//     colleague, while HubSpot's copy is usually the member's own. A difference is a
//     question for a human, so the write only fills a gap.
//
//   the join URL — the value was MINTED BY THIS WORKER for this registration, seconds ago.
//     HubSpot's copy is a stale artefact of whatever event the contact registered for last.
//     There is no sense in which the stored value is more trustworthy, and preserving it
//     would send an attendee to a webinar that finished last month. It is overwritten.
//
// Hence a separate resolver rather than a fourth AttendeeContactField: the mapping
// convention is shared, the write semantics are not, and folding it into `diffContactDetails`
// would put a value that must always be written behind a rule designed to hold values back.
// ---------------------------------------------------------------------------

/**
 * The property the worker has always written, and the one the shipped workflow specs read
 * for the calendar invite. Provider-neutral in use — Meet, Zoom, Wistia, ON24 and Vimeo all
 * land here too — and named for Teams only because Teams was first. Renaming it would strand
 * every portal's existing data, so tenants that mind remap instead.
 */
export const DEFAULT_JOIN_URL_PROPERTY = 'teams_join_url';

/**
 * Which contact property this tenant keeps the personal join URL in.
 *
 * NULL → the default above; 'off' → the tenant does not want it written; else their own name.
 * Reading optional config must never fail a write-back (Ref 217): against a tenants table
 * that predates 0026 this throws "no such column", which degrades to the default — the
 * behaviour every portal had before the column existed.
 */
export async function loadJoinUrlProperty(env: Env, portalId: string): Promise<string | null> {
  let row: { contact_join_url_property: string | null } | null = null;
  try {
    row = await env.DB.prepare('SELECT contact_join_url_property FROM tenants WHERE portal_id = ?1')
      .bind(portalId)
      .first<{ contact_join_url_property: string | null }>();
  } catch (err) {
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'join_url_property_unreadable',
        portalId,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  const value = emptyToNull(row?.contact_join_url_property);
  if (value === null) return DEFAULT_JOIN_URL_PROPERTY;
  if (value.toLowerCase() === CONTACT_PROPERTY_OFF) return null;
  return value;
}

// ---------------------------------------------------------------------------
// Capture-side normalisation (what gets stored on the registration)
// ---------------------------------------------------------------------------

function emptyToNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Normalise what a reserve request supplied. Values are stored AS TYPED (trimmed only) —
 * the canonicalisation below is for comparison, never for storage, so staff reviewing a
 * conflict see exactly what the booker entered.
 */
export function normaliseContactDetails(input: ReserveContactDetails | undefined | null): {
  values: AttendeeContactValues;
  any: boolean;
} {
  const values: AttendeeContactValues = {
    phone: emptyToNull(input?.phone),
    suburb: emptyToNull(input?.suburb),
    state: emptyToNull(input?.state),
  };
  return { values, any: ATTENDEE_CONTACT_FIELDS.some((field) => values[field] !== null) };
}

// ---------------------------------------------------------------------------
// Comparison canonicalisation
//
// A conflict has to mean "a human should look", so formatting differences must not
// count. '+61 412 345 678' and '0412 345 678' are one number; 'SA' and 'South Australia'
// are one state. Getting this wrong in the lenient direction silently drops a real
// conflict, so the rules stay narrow and predictable.
// ---------------------------------------------------------------------------

const AU_STATES: Record<string, string> = {
  nsw: 'NSW',
  'new south wales': 'NSW',
  vic: 'VIC',
  victoria: 'VIC',
  qld: 'QLD',
  queensland: 'QLD',
  sa: 'SA',
  'south australia': 'SA',
  wa: 'WA',
  'western australia': 'WA',
  tas: 'TAS',
  tasmania: 'TAS',
  nt: 'NT',
  'northern territory': 'NT',
  act: 'ACT',
  'australian capital territory': 'ACT',
};

/** Lowercased, punctuation-stripped, whitespace-collapsed. */
function canonicalText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Digits only, with the Australian country code folded onto the leading 0 it replaces.
 * A number that carries some other country code keeps it (prefixed '+'), so an overseas
 * attendee's number is still compared against itself rather than mangled.
 */
export function canonicalPhone(value: string): string {
  const compact = value.replace(/[^\d+]/g, '');
  if (compact === '') return '';
  if (compact.startsWith('+61')) return `0${compact.slice(3)}`;
  if (compact.startsWith('0061')) return `0${compact.slice(4)}`;
  if (compact.startsWith('+')) return compact;
  return compact;
}

export function canonicalState(value: string): string {
  const text = canonicalText(value);
  return AU_STATES[text] ?? text;
}

export function canonicalValue(field: AttendeeContactField, value: string): string {
  if (field === 'phone') return canonicalPhone(value);
  if (field === 'state') return canonicalState(value);
  return canonicalText(value);
}

// ---------------------------------------------------------------------------
// The diff: what may be written, and what a human has to settle
// ---------------------------------------------------------------------------

export interface ContactConflict {
  field: AttendeeContactField;
  property: string;
  /** What HubSpot holds today (verbatim). */
  existing: string;
  /** What the booking supplied (verbatim). */
  captured: string;
}

export interface ContactDetailsDiff {
  /** HubSpot property → value, for properties that are currently empty. */
  writes: Record<string, string>;
  /** Non-empty HubSpot values that differ from what was captured. Never overwritten. */
  conflicts: ContactConflict[];
  /** Fields the booking captured but the tenant has switched off ('off' in its mapping). */
  unmapped: AttendeeContactField[];
}

/**
 * Decide, per field, between write / conflict / no-op.
 *
 *   HubSpot empty            → write
 *   HubSpot equal (canonical)→ no-op (a reformat is not a conflict, and writing one back
 *                              would churn the contact's timeline for nothing)
 *   HubSpot different        → conflict
 *
 * `force` collapses the middle: the event owner has resolved a conflict in favour of the
 * captured value, so every captured field is written outright.
 */
export function diffContactDetails(args: {
  config: AttendeeContactConfig;
  captured: AttendeeContactValues;
  /** Contact properties as HubSpot currently holds them. */
  existing: Record<string, string | null | undefined>;
  force?: boolean;
}): ContactDetailsDiff {
  const { config, captured, existing, force = false } = args;
  const diff: ContactDetailsDiff = { writes: {}, conflicts: [], unmapped: [] };

  for (const field of ATTENDEE_CONTACT_FIELDS) {
    const value = captured[field];
    if (value === null) continue;

    const property = propertyFor(config, field);
    if (property === null) {
      diff.unmapped.push(field);
      continue;
    }

    if (force) {
      diff.writes[property] = value;
      continue;
    }

    const current = emptyToNull(existing[property]);
    if (current === null) {
      diff.writes[property] = value;
      continue;
    }
    if (canonicalValue(field, current) === canonicalValue(field, value)) continue;

    diff.conflicts.push({ field, property, existing: current, captured: value });
  }

  return diff;
}

// ---------------------------------------------------------------------------
// Write-back payload
// ---------------------------------------------------------------------------

export interface AttendeeContactSyncPayload {
  registrationId: string;
  eventId: string;
  attendeeEmail: string;
  attendeeName?: string | null;
  hubspotContactId?: string | null;
  details: AttendeeContactValues;
  /**
   * Set only by a resolved contact_conflict: the event owner chose the captured value, so
   * the handler writes it over what HubSpot holds instead of standing down.
   */
  force?: boolean;
}

/**
 * Queue a contact write-back outside the reserve batch — used when an owner resolves a
 * conflict in favour of the booking. Reserve itself inserts its outbox row inside the same
 * D1 batch as the registration (CLAUDE.md: outbox in the same transaction as the state
 * change); here the state change IS the decision resolution, which writes its own row.
 */
export async function enqueueAttendeeContactSync(
  env: Env,
  portalId: string,
  payload: AttendeeContactSyncPayload,
): Promise<string> {
  const outboxId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
     VALUES (?1, ?2, 'contact.sync_attendee_details', ?3, ?4)`,
  )
    .bind(outboxId, portalId, JSON.stringify(payload), new Date().toISOString())
    .run();

  try {
    await env.QUEUE.send({
      kind: 'contact.sync_attendee_details',
      portalId,
      outboxId,
      registrationId: payload.registrationId,
    });
  } catch {
    // Best-effort drain; the cron sweep is the backstop.
  }
  return outboxId;
}
