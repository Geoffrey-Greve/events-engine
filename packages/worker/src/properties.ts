/**
 * HubSpot property provisioning (Phase 6.1).
 *
 * Every write-back this worker performs PATCHes a *named* HubSpot property, and until now
 * nothing created any of them. In a portal where `event_attended` does not exist, the 2.1
 * attendance write fails with a 403 that surfaces as a dead outbox row — weeks later,
 * nowhere near the cause, and read as "the engine and HubSpot disagree" when the truth is
 * that the app never asked the portal for the field. This module asks.
 *
 * ## Three rules, and they are the whole design
 *
 * 1. **Respect the tenant's mapping.** Every write-back already resolves its property name
 *    through `tenants` (`contact_attended_property`, `voucher_total_property`, …). If a
 *    portal keys attendance somewhere of its own, provisioning creates nothing for that
 *    field — the property it would create is not the one that gets written. If the mapping
 *    is `'off'`, the tenant has said not to write the field at all.
 *
 * 2. **Never modify a property that already exists.** A portal may already hold
 *    `dietary_requirements` as a dropdown with its own options. That is adopted, left
 *    exactly as it is, and a type difference is REPORTED rather than resolved. Changing the
 *    type of a property that holds data is destructive, irreversible from here, and is not
 *    an installer's decision to make.
 *
 * 3. **Provision only what the worker WRITES.** The membership properties are read, and
 *    they are the portal's own data — creating an empty `membership_status` would not make
 *    a single member resolvable, it would just put our name on a field we do not own. They
 *    are reported as expected-to-exist and never created.
 *
 * ## Degrading
 *
 * The schema scopes are required as of Phase 6.1, but a granted scope can still be revoked
 * and a token issued before that decision does not carry them. Every failure path here ends
 * in a report saying which properties a human must create by hand — never in a failed
 * install. An installer that rolls back six working properties because the seventh needs a
 * scope is worse than one that reports six and a gap.
 *
 * ## Overlap to resolve
 *
 * `provision.ts` carries a `provisionContactProperties` that covers the Phase 2.1
 * attendance trio with the same rules. This module is the general case — attendance plus
 * the join URL, remapped 1.2 fields, every 2.3 question's mapped property, and the company
 * voucher fields — so that function is subsumed and should be deleted when the two land
 * together. Both are idempotent and both adopt rather than modify, so running both is
 * harmless in the meantime: whichever goes first creates, the other adopts.
 */

import {
  ATTENDANCE_FIELDS,
  ATTENDANCE_PROPERTY_DEFINITIONS,
  ATTENDANCE_PROPERTY_GROUP,
  type AttendanceContactConfig,
  attendancePropertyFor,
  DEFAULT_ATTENDANCE_PROPERTIES,
  loadAttendanceContactConfig,
} from './attendance-writeback';
import {
  ATTENDEE_CONTACT_FIELDS,
  type AttendeeContactField,
  DEFAULT_JOIN_URL_PROPERTY,
  loadAttendeeContactConfig,
  loadJoinUrlProperty,
  propertyFor,
  STANDARD_CONTACT_PROPERTIES,
} from './attendee-contact';
import { hs, PermanentError } from './hubspot-writeback';
import { loadMembershipConfig } from './membership';
import {
  listQuestions,
  loadQuestion,
  type QuestionFieldType,
  type RegistrationQuestion,
  toQuestion,
} from './questions';
import {
  DEFAULT_REGISTRATION_CONFIRMATION_PROPERTY,
  loadRegistrationConfirmationProperty,
  REGISTRATION_CONFIRMATION_PROPERTY_DEFINITION,
} from './registration-confirmation';
import type { Env } from './types';
import { loadVoucherConfig } from './vouchers';

const HS_API = 'https://api.hubapi.com';

/** The two objects the worker writes custom properties to. */
export type PropertyObject = 'contacts' | 'companies';

export const PROPERTY_OBJECTS: PropertyObject[] = ['contacts', 'companies'];

/**
 * The groups properties this app creates are filed under, so an admin opening their
 * property settings sees what the app added and what was already theirs.
 *
 * Two, not one: "attendance" does not describe a dietary requirement or a voucher balance,
 * and an admin hunting for the field that drives a certificate should not have to read past
 * them. The attendance group is imported rather than restated so it cannot drift from the
 * feature that owns it.
 */
/**
 * The names the app falls back to when a tenant has configured nothing. Compared against the
 * resolved name to tell a chosen name from an invented one — see {@link ManagedProperty.source}.
 * They mirror the defaults inside each feature's own loader; a test asserts they agree.
 */
export const DEFAULT_VOUCHER_PROPERTIES = { total: 'vouchers_total', used: 'vouchers_used' };
export const DEFAULT_MEMBERSHIP_STATUS_PROPERTY = 'membership_status';

export const ATTENDANCE_GROUP = ATTENDANCE_PROPERTY_GROUP;
export const REGISTRATION_GROUP = { name: 'event_registration', label: 'Event Registration' };

/** A HubSpot property's shape, as the create call wants it. */
export interface PropertyShape {
  type: string;
  fieldType: string;
  options?: { label: string; value: string; displayOrder?: number }[];
}

export interface ManagedProperty extends PropertyShape {
  /** Stable identifier for reporting — survives a rename of the property itself. */
  key: string;
  object: PropertyObject;
  /** The resolved property name, AFTER the tenant's mapping is applied. */
  name: string;
  label: string;
  description: string;
  /** What writes it — shown in the report so an admin can see why it is wanted. */
  writtenBy: string;
  /**
   * false = the worker only READS this property. Reported, never created: it holds the
   * portal's own data and an empty one we made would be worse than an absent one.
   */
  managed: boolean;
  group: { name: string; label: string };
  /**
   * Where the NAME came from.
   *
   * `default` means the app invented it because the tenant expressed no preference — and
   * that is the distinction that matters most in a report. Weld's vouchers live in
   * `vouchers_allowance` / `vouchers_used__training`; provisioning an unconfigured portal
   * would have created `vouchers_total` / `vouchers_used`, reported "created" in green, and
   * left every corporate booking resolving a zero balance against two empty fields while
   * the real allowance sat untouched beside them. A default name that the portal has never
   * used is a question, not a success.
   */
  source: 'default' | 'mapped';
}

/**
 * What happened to one property.
 *
 * `adopted` and `created` are deliberately distinct. 6.6's install manifest needs to know
 * which properties are ours to reason about on upgrade and which merely happened to already
 * be there — and nothing the app adopted should ever be treated as the app's to change.
 */
export type PropertyOutcome = 'created' | 'adopted' | 'skipped' | 'manual' | 'failed' | 'missing';

export interface PropertyReportEntry {
  key: string;
  object: PropertyObject;
  name: string;
  label: string;
  writtenBy: string;
  managed: boolean;
  outcome: PropertyOutcome;
  /** Why it was skipped, what failed, or what a human has to do. */
  detail: string | null;
  /**
   * The property exists but is not the shape the worker expects. Surfaced, never resolved:
   * a portal's existing dropdown is its own, and retyping a property destroys its data.
   */
  mismatch: { expected: string; actual: string } | null;
  /** Where the name came from — see {@link ManagedProperty.source}. */
  source: 'default' | 'mapped';
  /**
   * What to create, for an entry a human has to act on.
   *
   * The ops runbook's instruction is "create the properties by hand from the definitions it
   * returns" — a report that named a missing property without saying what type it needs
   * would send someone to guess, and guessing the DATE one wrong is the failure that only
   * shows up on a printed certificate.
   */
  definition: PropertyShape;
}

export interface PropertyProvisionReport {
  portalId: string;
  generatedAt: string;
  /** true when nothing was written — the inspect endpoint's mode. */
  dryRun: boolean;
  properties: PropertyReportEntry[];
  summary: {
    created: number;
    adopted: number;
    skipped: number;
    /** Needs a human: no scope, a failure, or a read-only property that is absent. */
    needsAttention: number;
    mismatches: number;
    /**
     * Missing properties about to be created under a name the app chose, not one the portal
     * did. Worth a look before pressing provision: if that data already lives under another
     * name, map it first or the app creates an empty twin and reads zero from it forever.
     */
    defaultsToCreate: number;
  };
  /**
   * Set when the portal's token cannot read or write property schemas. Everything on the
   * affected object reports `manual` and the admin gets a list rather than an error.
   */
  scopeProblem: string | null;
}

// ---------------------------------------------------------------------------
// What a 2.3 question's answer needs on the contact
// ---------------------------------------------------------------------------

/**
 * The HubSpot property shape that can hold this question's answers.
 *
 * The question editor is the only place that knows what the field MEANS, which is why the
 * brief puts property creation there as well as in the installer: a `select` provisioned as
 * free text loses the options, and no later step can recover them.
 *
 * `checkbox` maps to HubSpot's `booleancheckbox`, whose values are the strings 'true' and
 * 'false' — exactly what 2.3 stores, so the write-back stays a copy.
 */
export function propertyShapeForQuestion(question: {
  fieldType: QuestionFieldType;
  options?: RegistrationQuestion['options'];
}): PropertyShape {
  const options = (question.options ?? []).map((option, index) => ({
    label: option.label,
    value: option.value,
    displayOrder: index,
  }));

  switch (question.fieldType) {
    case 'textarea':
      return { type: 'string', fieldType: 'textarea' };
    case 'select':
      return { type: 'enumeration', fieldType: 'select', options };
    case 'multiselect':
      return { type: 'enumeration', fieldType: 'checkbox', options };
    case 'checkbox':
      return {
        type: 'enumeration',
        fieldType: 'booleancheckbox',
        options: [
          { label: 'Yes', value: 'true', displayOrder: 0 },
          { label: 'No', value: 'false', displayOrder: 1 },
        ],
      };
    case 'phone':
      return { type: 'string', fieldType: 'phonenumber' };
    default:
      return { type: 'string', fieldType: 'text' };
  }
}

// ---------------------------------------------------------------------------
// Collecting what this tenant needs
// ---------------------------------------------------------------------------

const CONTACT_FIELD_LABELS: Record<AttendeeContactField, { label: string; shape: PropertyShape }> =
  {
    phone: { label: 'Phone', shape: { type: 'string', fieldType: 'phonenumber' } },
    suburb: { label: 'Suburb', shape: { type: 'string', fieldType: 'text' } },
    state: { label: 'State', shape: { type: 'string', fieldType: 'text' } },
  };

/**
 * Every property this tenant's configuration implies, resolved through its mappings.
 *
 * Read entirely from the same loaders the write-backs use, so this list cannot describe a
 * different portal from the one the writes target. That is the point: a hand-maintained
 * list would drift from the code the first time a mapping was added.
 */
export async function collectManagedProperties(
  env: Env,
  portalId: string,
): Promise<ManagedProperty[]> {
  const [
    attendance,
    contactConfig,
    joinUrlProperty,
    confirmationProperty,
    vouchers,
    membership,
    questions,
  ] = await Promise.all([
    loadAttendanceContactConfig(env, portalId),
    loadAttendeeContactConfig(env, portalId),
    loadJoinUrlProperty(env, portalId),
    loadRegistrationConfirmationProperty(env, portalId),
    loadVoucherConfig(env, portalId),
    loadMembershipConfig(env, portalId),
    listQuestions(env, portalId, { includeArchived: false }).catch(() => []),
  ]);

  const properties: ManagedProperty[] = [];

  // ---- Phase 2.1 attendance ------------------------------------------------
  for (const field of ATTENDANCE_FIELDS) {
    const name = attendancePropertyFor(attendance as AttendanceContactConfig, field);
    // null = the tenant set this field to 'off'. Nothing is written, so nothing is needed.
    if (name === null) continue;
    // Definitions come from the feature that owns them, not a copy here. The DATE one's
    // type is the whole reason the worker creates these rather than a person: a date keyed
    // as a string is the mistake that only surfaces on a printed certificate.
    const definition = ATTENDANCE_PROPERTY_DEFINITIONS[field];
    properties.push({
      key: `attendance.${field}`,
      object: 'contacts',
      name,
      label: definition.label,
      description: definition.description,
      writtenBy: 'Attendance write-back (contact.sync_attendance)',
      managed: true,
      group: ATTENDANCE_GROUP,
      source: name === DEFAULT_ATTENDANCE_PROPERTIES[field] ? 'default' : 'mapped',
      type: definition.type,
      fieldType: definition.fieldType,
      ...(definition.options ? { options: definition.options } : {}),
    });
  }

  // ---- Online events: the personal join URL --------------------------------
  // Mapped like everything else since 0026; NULL resolves to `teams_join_url`, which is what
  // the worker has always written and what the shipped workflow specs read.
  if (joinUrlProperty !== null) {
    properties.push({
      key: 'webinar.joinUrl',
      object: 'contacts',
      name: joinUrlProperty,
      label: 'Event join URL',
      description:
        "The attendee's personal join link for an online event. Written before the confirmation workflow fires, so HubSpot's calendar invite carries it.",
      writtenBy: 'Webinar registration (contact.set_join_url)',
      managed: true,
      group: REGISTRATION_GROUP,
      source: joinUrlProperty === DEFAULT_JOIN_URL_PROPERTY ? 'default' : 'mapped',
      type: 'string',
      fieldType: 'text',
    });
  }

  // ---- Ref 61: the registration-confirmation trigger ----------------------
  // The one property a portal notices immediately if it is missing: no property, no
  // workflow enrolment, no confirmation email — and, before this was provisioned, a 400 on
  // every booking that killed the Marketing Event write-back row along with it.
  if (confirmationProperty !== null) {
    properties.push({
      key: 'registration.confirmation',
      object: 'contacts',
      name: confirmationProperty,
      label: REGISTRATION_CONFIRMATION_PROPERTY_DEFINITION.label,
      description: REGISTRATION_CONFIRMATION_PROPERTY_DEFINITION.description,
      writtenBy: 'Registration confirmation (contact.sync_registration_confirmation)',
      managed: true,
      group: REGISTRATION_GROUP,
      source:
        confirmationProperty === DEFAULT_REGISTRATION_CONFIRMATION_PROPERTY ? 'default' : 'mapped',
      type: REGISTRATION_CONFIRMATION_PROPERTY_DEFINITION.type,
      fieldType: REGISTRATION_CONFIRMATION_PROPERTY_DEFINITION.fieldType,
    });
  }

  // ---- Phase 1.2 contact capture ------------------------------------------
  // Only where a tenant has mapped a field somewhere NON-STANDARD. The defaults are
  // HubSpot's own `phone` / `city` / `state`, which every portal already has — creating a
  // custom duplicate would strand the data outside HubSpot's address block, which is the
  // exact mistake 1.2 was written to avoid.
  for (const field of ATTENDEE_CONTACT_FIELDS) {
    const name = propertyFor(contactConfig, field);
    if (name === null) continue; // 'off'
    if (name === STANDARD_CONTACT_PROPERTIES[field]) continue; // HubSpot's own
    const meta = CONTACT_FIELD_LABELS[field];
    properties.push({
      key: `contact.${field}`,
      object: 'contacts',
      name,
      label: meta.label,
      description: `Captured at registration. Written only where HubSpot is empty; a differing value opens a decision instead of being overwritten.`,
      writtenBy: 'Attendee contact capture (contact.sync_attendee_details)',
      managed: true,
      group: REGISTRATION_GROUP,
      // Only reached when the tenant moved this off HubSpot's standard property.
      source: 'mapped',
      ...meta.shape,
    });
  }

  // ---- Phase 2.3 custom questions -----------------------------------------
  // One property per distinct mapped question. Two questions can legitimately point at the
  // same property — an event-level override of a tenant-wide default usually does — so the
  // dedupe below keeps the first and the report names it once.
  for (const question of questions) {
    if (!question.hsProperty) continue;
    properties.push({
      key: `question.${question.key}`,
      object: 'contacts',
      name: question.hsProperty,
      label: question.label,
      description: `Answer to the registration question "${question.label}". Reused to prefill the field the next time this person registers.`,
      writtenBy: 'Registration questions (contact.sync_answers)',
      managed: true,
      group: REGISTRATION_GROUP,
      // A question's hs_property is always something a person typed.
      source: 'mapped',
      ...propertyShapeForQuestion(question),
    });
  }

  // ---- Corporate training vouchers ----------------------------------------
  if (vouchers.mode !== 'off') {
    const unit = vouchers.mode === 'credit' ? 'dollar balance' : 'number of seats';
    properties.push(
      {
        key: 'voucher.total',
        object: 'companies',
        name: vouchers.totalProperty,
        label: 'Training vouchers purchased',
        description: `The ${unit} this company has bought. Staff set this; the worker only reads it.`,
        // Read by the worker, set by staff — but it must EXIST for a balance to resolve at
        // all, so it is provisioned. Distinct from the membership properties below, which
        // carry data the portal already holds.
        writtenBy: 'Voucher balance (read by the worker, set by staff)',
        managed: true,
        group: REGISTRATION_GROUP,
        source: vouchers.totalProperty === DEFAULT_VOUCHER_PROPERTIES.total ? 'default' : 'mapped',
        type: 'number',
        fieldType: 'number',
      },
      {
        key: 'voucher.used',
        object: 'companies',
        name: vouchers.usedProperty,
        label: 'Training vouchers used',
        description: `The ${unit} consumed so far. Derived in D1 and projected here — treat this as a read-only mirror.`,
        writtenBy: 'Voucher usage projection (company.sync_voucher_usage)',
        managed: true,
        group: REGISTRATION_GROUP,
        source: vouchers.usedProperty === DEFAULT_VOUCHER_PROPERTIES.used ? 'default' : 'mapped',
        type: 'number',
        fieldType: 'number',
      },
    );
  }

  // ---- Membership: reported, never created --------------------------------
  // These hold the portal's OWN member data. An empty one created by us resolves exactly as
  // many members as an absent one — none — while implying the app owns the field. Their
  // absence is still worth reporting: it is the difference between "no members" and
  // "membership was never configured", and only one of those is a setup problem.
  // The company families and the contact's mirror of its employer (0046) are mapped per
  // tenant with no default, so each is reported only once a tenant has named it.
  const membershipProperties: [string, PropertyObject, string | null][] = [
    ['membership.status', 'contacts', membership.statusProperty || 'membership_status'],
    ['membership.level', 'contacts', membership.levelProperty],
    ['membership.category', 'contacts', membership.categoryProperty],
    ['membership.mirrorStatus', 'contacts', membership.mirrorStatusProperty],
    ['membership.mirrorTier', 'contacts', membership.mirrorTierProperty],
  ];
  for (const source of membership.companySources) {
    membershipProperties.push(
      [`membership.company.${source.category}.status`, 'companies', source.statusProperty],
      [`membership.company.${source.category}.level`, 'companies', source.levelProperty],
    );
  }
  for (const [key, object, name] of membershipProperties) {
    if (!name) continue;
    properties.push({
      key,
      object,
      name,
      label: name,
      description:
        'Read to resolve membership and member pricing. This is the portal’s own data — the app never creates or writes it.',
      writtenBy: 'Membership resolution (read only)',
      managed: false,
      group: REGISTRATION_GROUP,
      source: name === DEFAULT_MEMBERSHIP_STATUS_PROPERTY ? 'default' : 'mapped',
      type: 'string',
      fieldType: 'text',
    });
  }

  return dedupe(properties);
}

/**
 * One entry per (object, name). Two questions sharing a property is the ordinary case, and
 * a report that listed it twice would read as a conflict.
 */
function dedupe(properties: ManagedProperty[]): ManagedProperty[] {
  const seen = new Set<string>();
  const out: ManagedProperty[] = [];
  for (const property of properties) {
    const id = `${property.object}:${property.name}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(property);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading what the portal already has
// ---------------------------------------------------------------------------

interface ExistingProperty {
  name: string;
  type?: string;
  fieldType?: string;
}

/**
 * Every property on one object, as one request.
 *
 * A GET per property would be tidier to read and would spend one subrequest per field
 * against a Worker's budget; a portal with a dozen custom questions would be a dozen round
 * trips before a single write. One list read is bounded regardless of how many questions a
 * tenant defines.
 *
 * Returns null when the token cannot read the schema — the caller reports `manual` for that
 * object rather than treating "cannot see" as "not there" and creating duplicates.
 */
async function listExistingProperties(
  token: string,
  object: PropertyObject,
): Promise<Map<string, ExistingProperty> | null> {
  try {
    const response = (await hs(token, 'GET', `${HS_API}/crm/v3/properties/${object}`)) as {
      results?: ExistingProperty[];
    } | null;
    return new Map((response?.results ?? []).map((property) => [property.name, property]));
  } catch (err) {
    if (err instanceof PermanentError && (err.statusCode === 403 || err.statusCode === 401)) {
      return null;
    }
    throw err;
  }
}

/**
 * Ensure the app's property group exists.
 *
 * Best-effort: a portal that already has the group answers 409, and a group that cannot be
 * created is a cosmetic loss (properties land in the object's default group) rather than a
 * reason to stop. Never let it fail provisioning.
 */
async function ensurePropertyGroup(
  token: string,
  object: PropertyObject,
  group: { name: string; label: string },
): Promise<boolean> {
  try {
    await hs(token, 'GET', `${HS_API}/crm/v3/properties/${object}/groups/${group.name}`);
    return true;
  } catch (err) {
    if (!(err instanceof PermanentError) || err.statusCode !== 404) return false;
  }
  try {
    await hs(token, 'POST', `${HS_API}/crm/v3/properties/${object}/groups`, {
      name: group.name,
      label: group.label,
    });
    return true;
  } catch (err) {
    // A concurrent provision run may have created it between the two calls; HubSpot
    // answers 409, which is the outcome we wanted either way.
    return err instanceof PermanentError && err.statusCode === 409;
  }
}

/**
 * Whether an existing property can hold what the worker writes.
 *
 * Deliberately narrow. `string` and `enumeration` are reported as different because a
 * free-text answer written into a dropdown is rejected by HubSpot, and that is worth an
 * admin's attention. A `date` where `datetime` was expected is NOT a mismatch — the
 * attendance write-back reads the property's real type and formats to match, so both work.
 */
function compatible(expected: PropertyShape, actual: ExistingProperty): boolean {
  const actualType = actual.type ?? '';
  if (actualType === expected.type) return true;
  if (
    (expected.type === 'date' || expected.type === 'datetime') &&
    (actualType === 'date' || actualType === 'datetime')
  ) {
    return true;
  }
  // A boolean flag stored as a string still reads correctly — the write-back compares
  // 'true'/'yes'/'1' case-insensitively rather than trusting a type.
  if (
    expected.fieldType === 'booleancheckbox' &&
    (actualType === 'bool' || actualType === 'string')
  ) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

/**
 * Create one managed property, exactly as provisioning creates it.
 *
 * Factored out so the installer and the on-demand path below cannot drift: Phase 6.1's
 * "one routine, and the definitions live with the feature" applies to the create as much
 * as to the definitions, and a second copy of this call is how the DATE property ends up
 * provisioned as text on one path and correctly on the other.
 */
async function createManagedProperty(
  token: string,
  property: ManagedProperty,
  groupOk: boolean,
): Promise<void> {
  await hs(token, 'POST', `${HS_API}/crm/v3/properties/${property.object}`, {
    name: property.name,
    label: property.label,
    description: property.description,
    type: property.type,
    fieldType: property.fieldType,
    // A group that could not be created costs the properties their tidy home, not
    // their existence — fall back to HubSpot's own default group.
    groupName: groupOk
      ? property.group.name
      : property.object === 'contacts'
        ? 'contactinformation'
        : 'companyinformation',
    ...(property.options ? { options: property.options } : {}),
  });
}

export interface ProvisionPropertiesOptions {
  /** Report what WOULD happen and write nothing. Backs the inspect endpoint. */
  dryRun?: boolean;
}

/**
 * Create or adopt every property this tenant's configuration implies.
 *
 * Idempotent by construction: the only write is a create, and a create only happens for a
 * name the portal's own property list did not contain. Re-running finds everything present
 * and writes nothing.
 */
export async function provisionProperties(
  env: Env,
  portalId: string,
  token: string,
  options: ProvisionPropertiesOptions = {},
): Promise<PropertyProvisionReport> {
  const dryRun = options.dryRun === true;
  const managed = await collectManagedProperties(env, portalId);

  const existingByObject = new Map<PropertyObject, Map<string, ExistingProperty> | null>();
  const objectsInUse = new Set(managed.map((property) => property.object));
  for (const object of PROPERTY_OBJECTS) {
    if (!objectsInUse.has(object)) continue;
    existingByObject.set(object, await listExistingProperties(token, object));
  }

  let scopeProblem: string | null = null;
  const unreadable = [...existingByObject.entries()]
    .filter(([, value]) => value === null)
    .map(([object]) => object);
  if (unreadable.length > 0) {
    scopeProblem =
      `Cannot read the property schema for ${unreadable.join(' and ')}. ` +
      'This portal authorised before the schema scopes became required — re-authorise at ' +
      '/oauth/install, or create the properties below by hand.';
  }

  // Only touched where something is actually going to be created, and keyed by group as
  // well as object because the two groups are created independently.
  const groupReady = new Map<string, boolean>();
  const entries: PropertyReportEntry[] = [];

  for (const property of managed) {
    const existing = existingByObject.get(property.object);
    const base = {
      key: property.key,
      object: property.object,
      name: property.name,
      label: property.label,
      writtenBy: property.writtenBy,
      managed: property.managed,
      source: property.source,
      definition: {
        type: property.type,
        fieldType: property.fieldType,
        ...(property.options ? { options: property.options } : {}),
      },
    };

    if (existing === null || existing === undefined) {
      entries.push({
        ...base,
        outcome: 'manual',
        detail: scopeProblem ?? 'The property schema could not be read.',
        mismatch: null,
      });
      continue;
    }

    const found = existing.get(property.name);

    if (found) {
      const ok = compatible(property, found);
      entries.push({
        ...base,
        outcome: 'adopted',
        detail: property.managed
          ? 'Already present. Left exactly as it is — the app never modifies an existing property.'
          : 'Already present. Read only; the app never writes this.',
        mismatch: ok
          ? null
          : {
              expected: `${property.type}/${property.fieldType}`,
              actual: `${found.type ?? 'unknown'}/${found.fieldType ?? 'unknown'}`,
            },
      });
      continue;
    }

    // Absent, and not ours to create.
    if (!property.managed) {
      entries.push({
        ...base,
        outcome: 'missing',
        detail:
          'Expected to exist and does not. The app will not create it — this holds the ' +
          'portal’s own data, and an empty one would resolve no members while implying ' +
          'the app owns the field. Create it, or point the tenant mapping at the property ' +
          'that already holds this.',
        mismatch: null,
      });
      continue;
    }

    if (dryRun) {
      entries.push({
        ...base,
        outcome: 'missing',
        detail: 'Not present. Provisioning will create it.',
        mismatch: null,
      });
      continue;
    }

    const groupKey = `${property.object}:${property.group.name}`;
    if (!groupReady.has(groupKey)) {
      groupReady.set(groupKey, await ensurePropertyGroup(token, property.object, property.group));
    }

    try {
      await createManagedProperty(token, property, groupReady.get(groupKey) === true);
      // Record it locally so a second property with the same name in one run adopts rather
      // than colliding — the dedupe above makes that impossible today, and this keeps it
      // impossible if a future caller passes its own list.
      existing.set(property.name, { name: property.name, type: property.type });
      entries.push({ ...base, outcome: 'created', detail: null, mismatch: null });
    } catch (err) {
      const permanent = err instanceof PermanentError;
      const status = permanent ? err.statusCode : undefined;
      if (status === 403 || status === 401) {
        scopeProblem =
          scopeProblem ??
          'This portal’s token cannot create properties. Re-authorise at /oauth/install ' +
            'to grant the schema scopes, or create the properties below by hand.';
        entries.push({ ...base, outcome: 'manual', detail: scopeProblem, mismatch: null });
        continue;
      }
      // One failure does not stop the rest: six created properties and a named gap is a
      // better outcome than an install that rolled back because the seventh was rejected.
      entries.push({
        ...base,
        outcome: 'failed',
        detail: err instanceof Error ? err.message : String(err),
        mismatch: null,
      });
    }
  }

  return {
    portalId,
    generatedAt: new Date().toISOString(),
    dryRun,
    properties: entries,
    summary: summarise(entries),
    scopeProblem,
  };
}

function summarise(entries: PropertyReportEntry[]): PropertyProvisionReport['summary'] {
  const count = (outcome: PropertyOutcome) =>
    entries.filter((entry) => entry.outcome === outcome).length;
  return {
    created: count('created'),
    adopted: count('adopted'),
    skipped: count('skipped'),
    // What a person has to act on. A dry run's `missing` is not in here — it is the answer
    // to "what would provisioning do", not a problem.
    needsAttention: entries.filter(
      (entry) =>
        entry.outcome === 'manual' ||
        entry.outcome === 'failed' ||
        (entry.outcome === 'missing' && !entry.managed),
    ).length,
    mismatches: entries.filter((entry) => entry.mismatch !== null).length,
    defaultsToCreate: entries.filter(
      (entry) => entry.managed && entry.source === 'default' && entry.outcome === 'missing',
    ).length,
  };
}

// ---------------------------------------------------------------------------
// One property, on demand — a write-back that just found it missing
// ---------------------------------------------------------------------------

export type MissingPropertyRepair =
  | { status: 'created'; object: PropertyObject; detail: null }
  | { status: 'not_ours'; object: null; detail: string }
  | { status: 'unavailable'; object: PropertyObject | null; detail: string };

/**
 * Create a property a HubSpot write-back has just been told does not exist.
 *
 * Phase 6.1 says the app provisions the properties its write-backs target, and it provides
 * the endpoint that does it — but only an installer ever presses that, and a portal that
 * authorised before 0040 (or before any other write-back landed) has never been asked for
 * the property the write now names. Weld's live portal is exactly that portal: every
 * booking's `contact.sync_registration_confirmation` row died on
 * `last_event_engine_registration_id does not exist`, which is the Phase 6.1 failure
 * arriving one booking at a time instead of once at install.
 *
 * So the write-back closes the loop itself. This is not a second provisioning routine: it
 * resolves the SAME managed list, through the same tenant mapping, and creates through the
 * same call — it simply starts from a name HubSpot rejected rather than from the whole set.
 *
 * Two rules carried over verbatim, because they are the ones that make provisioning safe:
 *
 *  - **Only what the worker WRITES.** A `managed: false` property holds the portal's own
 *    data (membership status, the voucher allowance). An empty one we invented would
 *    resolve exactly as many members as an absent one while putting our name on their
 *    field. Reported `not_ours`, never created.
 *  - **Never a name the app does not own.** A property the tenant's mapping does not point
 *    at is not ours to create under any circumstances; the caller drops it from the write
 *    instead, which is the honest outcome for, say, a portal with no `abn` contact field.
 *
 * Never throws: the caller is a queue handler mid-booking, and a failure here means the
 * write proceeds without that property, not that the booking loses its invoice.
 */
export async function repairMissingProperty(
  env: Env,
  portalId: string,
  token: string,
  name: string,
): Promise<MissingPropertyRepair> {
  let managed: ManagedProperty[];
  try {
    managed = await collectManagedProperties(env, portalId);
  } catch (err) {
    return {
      status: 'unavailable',
      object: null,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  const property = managed.find((candidate) => candidate.name === name);
  if (!property) {
    return {
      status: 'not_ours',
      object: null,
      detail: `"${name}" is not a property this app manages for portal ${portalId}.`,
    };
  }
  if (!property.managed) {
    return {
      status: 'not_ours',
      object: null,
      detail:
        `"${name}" holds the portal's own data and is only ever read. Create it, or point ` +
        'the tenant mapping at the property that already holds this.',
    };
  }

  try {
    const groupOk = await ensurePropertyGroup(token, property.object, property.group);
    await createManagedProperty(token, property, groupOk);
    return { status: 'created', object: property.object, detail: null };
  } catch (err) {
    // A concurrent handler creating the same property answers 409, which is the outcome
    // this call wanted: the property exists and the write can be retried.
    if (err instanceof PermanentError && err.statusCode === 409) {
      return { status: 'created', object: property.object, detail: null };
    }
    return {
      status: 'unavailable',
      object: property.object,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// One property, on demand — the Phase 2.3 question editor's hook
// ---------------------------------------------------------------------------

export type SinglePropertyStatus = 'exists' | 'created' | 'missing' | 'unavailable';

/**
 * Check — and, on the OUTBOX path only, create — the contact property one question maps to.
 *
 * The question editor is where an admin knows what the field means, and the only point at
 * which the app can name its type correctly: a `select` question created as free text loses
 * its options, and no later provisioning run can recover them. That knowledge is why the
 * shape is built here rather than left to a later provisioning run; it is NOT a reason to
 * create the property inside the request that stores the question. `create` is passed by
 * `handleQuestionPropertyEnsure` below and by nothing else — see that function.
 *
 * Idempotent by construction: the GET runs first and a create only happens on a 404, so a
 * retried outbox row writes nothing the second time.
 *
 * Best-effort by contract. A question is stored in D1 whatever HubSpot says, so every
 * failure here reports `unavailable` rather than throwing — losing a question because a
 * property could not be checked would be a much worse trade. The outbox handler turns that
 * report back into a throw, because there a failure is something to retry.
 */
export async function ensureQuestionProperty(
  token: string,
  question: {
    key: string;
    label: string;
    fieldType: QuestionFieldType;
    options: RegistrationQuestion['options'];
    hsProperty: string;
  },
  options: { create?: boolean } = {},
): Promise<{ status: SinglePropertyStatus; detail: string | null }> {
  const url = `${HS_API}/crm/v3/properties/contacts/${encodeURIComponent(question.hsProperty)}`;
  try {
    await hs(token, 'GET', url);
    return { status: 'exists', detail: null };
  } catch (err) {
    if (!(err instanceof PermanentError) || err.statusCode !== 404) {
      return {
        status: 'unavailable',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (!options.create) {
    return {
      status: 'missing',
      detail:
        `The contact property "${question.hsProperty}" does not exist yet, so answers to this ` +
        'question have nowhere to be written back. Re-send with createHsProperty to create it.',
    };
  }

  try {
    const grouped = await ensurePropertyGroup(token, 'contacts', REGISTRATION_GROUP);
    await hs(token, 'POST', `${HS_API}/crm/v3/properties/contacts`, {
      name: question.hsProperty,
      label: question.label,
      description: `Answer to the registration question "${question.label}". Reused to prefill the field the next time this person registers.`,
      groupName: grouped ? REGISTRATION_GROUP.name : 'contactinformation',
      ...propertyShapeForQuestion(question),
    });
    return { status: 'created', detail: null };
  } catch (err) {
    return { status: 'unavailable', detail: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// The create, as an outbox row (Ref 74)
// ---------------------------------------------------------------------------

/**
 * Creating the contact property a question maps to is a HubSpot side effect, and every
 * HubSpot side effect in this worker goes through the outbox in the same D1 transaction as
 * the state change that earns it (CLAUDE.md, non-negotiable invariants). This one used to
 * be a direct POST inside the request that stored the question: a timeout left the question
 * saved and the editor told it had failed, and the retry could only earn `duplicate_key`.
 *
 * The READ stays in the request. "Does this property exist?" is not a side effect, and an
 * admin typing a property name is owed the answer while they are still looking at the form.
 */
export const QUESTION_PROPERTY_TOPIC = 'question.ensure_property';

export interface QuestionPropertyPayload {
  questionId: string;
  /** Carried for the dead-letter row to be readable without joining back to the question. */
  hsProperty: string;
}

/** The outbox row, to go in the SAME D1 batch as the question it belongs to. */
export function questionPropertyStatement(
  env: Env,
  portalId: string,
  payload: QuestionPropertyPayload,
  outboxId: string,
  now: string,
) {
  return env.DB.prepare(
    `INSERT INTO outbox (id, portal_id, topic, payload, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).bind(outboxId, portalId, QUESTION_PROPERTY_TOPIC, JSON.stringify(payload), now);
}

/** Wake the queue for a row just committed. Best-effort; the reconcile sweep is the backstop. */
export async function signalQuestionProperty(
  env: Env,
  portalId: string,
  outboxId: string,
): Promise<void> {
  await env.QUEUE.send({ kind: QUESTION_PROPERTY_TOPIC, portalId, outboxId });
}

/**
 * Drain one `question.ensure_property` row.
 *
 * Re-reads the question rather than trusting the payload, for the reason the registration
 * confirmation handler re-reads its order: a PATCH between the enqueue and the drain can
 * change the label and the options, and the property should be created with what the
 * question says NOW. An archived or deleted question is a no-op — there is nothing left to
 * write answers to, and retrying would never change that.
 *
 * Throws on a failure the queue could retry (`unavailable`), returns quietly on `exists`
 * and `created`. `missing` cannot occur here: this path always asks to create.
 */
export async function handleQuestionPropertyEnsure(
  token: string,
  env: Env,
  portalId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const questionId = typeof payload.questionId === 'string' ? payload.questionId : null;
  if (!questionId) return;

  const row = await loadQuestion(env, portalId, questionId);
  if (!row || row.archived_at !== null || !row.hs_property) return;

  const question = toQuestion(row);
  const result = await ensureQuestionProperty(
    token,
    { ...question, hsProperty: row.hs_property },
    { create: true },
  );
  if (result.status === 'unavailable') {
    throw new Error(
      `Could not create contact property "${row.hs_property}" for question "${row.key}": ${
        result.detail ?? 'unknown error'
      }`,
    );
  }
}
