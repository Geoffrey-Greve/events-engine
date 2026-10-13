/**
 * Corporate team-management endpoints for Weld private member portal.
 *
 * Authorisation model:
 * - The browser never receives a HubSpot write token.
 * - Every write is checked against HubSpot immediately before mutation.
 * - The actor contact must be associated to the submitted company with an
 *   Admin/Primary Admin-style label.
 * - The target contact must already be linked to that same company.
 * - We do not delete contacts. Removal archives only the contact↔company
 *   association labels for this company.
 * - Self-removal and admin-removal are blocked for safety.
 *
 * AUTHENTICATION IS MISSING, and everything above is authorisation of a claim the
 * caller makes about themselves. `actorContactId` arrives in the request body and
 * nothing proves the caller is that contact: we check that the NAMED actor is a
 * company admin, never that the person calling is the named actor. Anyone holding a
 * company id and one of its admins' contact ids can add or remove that company's
 * employees, and `bulk-register` will raise it an invoice.
 *
 * It reads that way because the design had two paths and only the fallback shipped.
 * The intended path was HubSpot serverless functions at `/_hcms/api/corporate/*`,
 * which derive the actor from the membership session (`context.contact`) and cannot be
 * spoofed; the alternate was a Worker-verifiable `corporate_action_token`. Weld's
 * portal turned out to have no serverless entitlement, so the same-origin call 404s on
 * every write and the CMS client (`corporateApi.ts`) falls back to sending
 * `actorContactId` with no credential at all. The token was never built on this side:
 * the CMS already sends `Authorization: Bearer <token>` when it has one, and nothing
 * here reads it.
 *
 * The fix is to verify that token against a per-contact HubSpot property, which only a
 * member who rendered the gated portal page can have seen. Until then the middleware at
 * the bottom of this file bounds the damage (origin allowlist, rate limits) without
 * pretending to close it.
 */

import type { QuestionAnswers } from '@paddock/shared';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { getAccessToken } from '../hubspot-oauth';
import { hs, PermanentError } from '../hubspot-writeback';
import { loadMembershipConfig } from '../membership';
import { checkRateLimit } from '../middleware/rate-limit';
import type { Env } from '../types';
import { loadVoucherConfig, resolveVoucherBalance } from '../vouchers';
import { reserveEventWithBody } from './reserve';

const HS_API = 'https://api.hubapi.com';
const VALID_ID = /^\d+$/;
const ADMIN_LABELS = new Set(['admin', 'primary admin']);

type CorporateBindings = { Bindings: Env };

interface AssociationType {
  category?: string;
  typeId?: number;
  label?: string | null;
}

interface AssociationEdge {
  toObjectId?: number | string;
  id?: number | string;
  types?: AssociationType[];
  associationTypes?: AssociationType[];
}

interface AssociationsResponse {
  results?: AssociationEdge[];
}

interface ContactRecord {
  id: string;
  properties?: {
    email?: string;
    firstname?: string;
    lastname?: string;
    jobtitle?: string;
    /** The tenant's membership level property, whatever it is called (membership-config). */
    [property: string]: string | undefined;
  };
}

interface AssociationLabelResult {
  results?: Array<{
    typeId: number;
    label: string | null;
    category: string;
  }>;
}

interface CompanyRecord {
  id: string;
  /** Keyed by property name — the voucher fields are per-tenant configurable. */
  properties?: Record<string, string | undefined>;
}

interface RemoveEmployeeBody {
  portalId?: string;
  companyId?: string;
  actorContactId?: string;
  employeeId?: string;
  reason?: string;
}

interface AddEmployeeBody {
  portalId?: string;
  companyId?: string;
  actorContactId?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  jobTitle?: string;
}

interface BulkRegisterBody {
  portalId?: string;
  companyId?: string;
  actorContactId?: string;
  sessionId?: string;
  eventId?: string;
  workerEventId?: string;
  ticketTypeId?: string;
  expectedUnitCents?: number;
  employeeIds?: unknown;
  /**
   * Phase 2.3 answers, keyed by employee contact id then by question `key` — the portal
   * asks each selected employee's questions on the same screen it picks them on. An
   * employee with no entry sends no answers, which reserve rejects if the event asks a
   * required question.
   */
  answers?: Record<string, QuestionAnswers>;
  /** Order-scoped answers: asked once for the whole booking (a purchase order number). */
  orderAnswers?: QuestionAnswers;
  dryRun?: boolean;
  session?: {
    courseName?: string;
    city?: string;
    startDate?: string;
  };
}

interface TeamEmployeeResponse {
  id: string;
  name: string;
  email: string;
  membership_tier: string;
}

const assocTypeCache = new Map<
  string,
  { associationCategory: string; associationTypeId: number }
>();

function jsonError(c: Context<CorporateBindings>, status: number, code: string, message: string) {
  return c.json({ ok: false, status: code, message }, status as 400 | 401 | 403 | 404 | 409 | 500);
}

function cleanId(value: unknown): string {
  return String(value ?? '').trim();
}

function normaliseLabel(label: unknown): string {
  return String(label ?? '')
    .trim()
    .toLowerCase();
}

function cleanText(value: unknown, max = 120): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanEmail(value: unknown): string {
  return cleanText(value, 254).toLowerCase();
}

function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function edgeObjectId(edge: AssociationEdge): string {
  return cleanId(edge.toObjectId ?? edge.id);
}

function edgeTypes(edge: AssociationEdge): AssociationType[] {
  return edge.associationTypes ?? edge.types ?? [];
}

function edgeHasAdminLabel(edge: AssociationEdge): boolean {
  return edgeTypes(edge).some((type) => ADMIN_LABELS.has(normaliseLabel(type.label)));
}

function hubspotToken(env: Env, portalId: string): Promise<string> {
  return getAccessToken(env, portalId);
}

/**
 * `membership_tier` is DISPLAY only here (the Manage My Team list); it decides no price and
 * no membership. It still reads the tenant's own level property rather than a Weld name,
 * the same `membership_level_property` the membership resolver reads.
 */
function employeeFromContact(
  contact: ContactRecord,
  levelProperty: string | null,
): TeamEmployeeResponse {
  const props = contact.properties ?? {};
  const firstName = cleanText(props.firstname);
  const lastName = cleanText(props.lastname);
  const email = cleanEmail(props.email);
  return {
    id: cleanId(contact.id),
    name: `${firstName} ${lastName}`.trim(),
    email,
    membership_tier: levelProperty ? cleanText(props[levelProperty]) : '',
  };
}

async function readContactCompanies(token: string, contactId: string): Promise<AssociationEdge[]> {
  const data = (await hs(
    token,
    'GET',
    `${HS_API}/crm/v4/objects/contacts/${encodeURIComponent(contactId)}/associations/companies`,
  )) as AssociationsResponse;
  return data.results ?? [];
}

async function readCompanyContacts(token: string, companyId: string): Promise<AssociationEdge[]> {
  const data = (await hs(
    token,
    'GET',
    `${HS_API}/crm/v4/objects/companies/${encodeURIComponent(companyId)}/associations/contacts`,
  )) as AssociationsResponse;
  return data.results ?? [];
}

async function resolveAssocTypeId(
  token: string,
  fromObject: 'companies' | 'contacts' | 'deals',
  toObject: 'companies' | 'contacts',
): Promise<{ associationCategory: string; associationTypeId: number }> {
  // HubSpot-defined deal association type IDs are global and stable:
  // deals -> contacts = 3, deals -> companies = 5. Using them directly avoids
  // requiring deal schema/read scopes just to associate the deal after create.
  if (fromObject === 'deals' && toObject === 'contacts') {
    return { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 3 };
  }
  if (fromObject === 'deals' && toObject === 'companies') {
    return { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 5 };
  }

  const cacheKey = `${fromObject}:${toObject}:primary`;
  const cached = assocTypeCache.get(cacheKey);
  if (cached) return cached;

  const data = (await hs(
    token,
    'GET',
    `${HS_API}/crm/v4/associations/${fromObject}/${toObject}/labels`,
  )) as AssociationLabelResult;

  const primary =
    data.results?.find((entry) => entry.category === 'HUBSPOT_DEFINED' && entry.label === null) ??
    data.results?.find((entry) => entry.category === 'HUBSPOT_DEFINED');

  if (!primary) {
    throw new PermanentError(
      `No default HubSpot association type found for ${fromObject}->${toObject}`,
    );
  }

  const resolved = {
    associationCategory: primary.category,
    associationTypeId: primary.typeId,
  };
  assocTypeCache.set(cacheKey, resolved);
  return resolved;
}

function contactProperties(levelProperty: string | null): string {
  const props = ['email', 'firstname', 'lastname', 'jobtitle'];
  if (levelProperty) props.push(levelProperty);
  return props.map((p) => encodeURIComponent(p)).join(',');
}

async function readContactByEmail(
  token: string,
  email: string,
  levelProperty: string | null,
): Promise<ContactRecord | null> {
  try {
    return (await hs(
      token,
      'GET',
      `${HS_API}/crm/v3/objects/contacts/${encodeURIComponent(email)}` +
        `?idProperty=email&properties=${contactProperties(levelProperty)}`,
    )) as ContactRecord;
  } catch (error) {
    if (error instanceof PermanentError && error.statusCode === 404) {
      return null;
    }
    throw error;
  }
}

async function readContactById(
  token: string,
  contactId: string,
  levelProperty: string | null,
): Promise<ContactRecord> {
  return (await hs(
    token,
    'GET',
    `${HS_API}/crm/v3/objects/contacts/${encodeURIComponent(contactId)}` +
      `?properties=${contactProperties(levelProperty)}`,
  )) as ContactRecord;
}

async function createContact(
  token: string,
  values: { email: string; firstName: string; lastName: string; jobTitle: string },
): Promise<ContactRecord> {
  const properties: Record<string, string> = {
    email: values.email,
    firstname: values.firstName,
    lastname: values.lastName,
  };
  if (values.jobTitle) {
    properties.jobtitle = values.jobTitle;
  }

  return (await hs(token, 'POST', `${HS_API}/crm/v3/objects/contacts`, {
    properties,
  })) as ContactRecord;
}

async function associateCompanyContact(
  token: string,
  companyId: string,
  contactId: string,
): Promise<void> {
  const assocType = await resolveAssocTypeId(token, 'companies', 'contacts');
  await hs(
    token,
    'PUT',
    `${HS_API}/crm/v4/objects/companies/${encodeURIComponent(companyId)}` +
      `/associations/contacts/${encodeURIComponent(contactId)}`,
    [assocType],
  );
}

function cleanIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const raw of value) {
    const id = cleanId(raw);
    if (!VALID_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids.slice(0, 50);
}

async function readCompany(
  token: string,
  companyId: string,
  voucherProperties: string[] = [],
): Promise<CompanyRecord> {
  // Voucher property names are per-tenant, so the caller supplies them rather than this
  // hard-coding Weld's — a tenant using different field names would otherwise read blanks.
  const properties = ['name', ...voucherProperties].map(encodeURIComponent).join(',');
  return (await hs(
    token,
    'GET',
    `${HS_API}/crm/v3/objects/companies/${encodeURIComponent(companyId)}?properties=${properties}`,
  )) as CompanyRecord;
}

async function audit(
  env: Env,
  values: {
    portalId: string;
    companyId: string;
    actorContactId: string;
    employeeId: string;
    action: string;
    outcome: string;
    message?: string;
  },
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO corporate_team_audit
        (id, portal_id, company_id, actor_contact_id, target_contact_id, action, outcome, message, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
      .bind(
        crypto.randomUUID(),
        values.portalId,
        values.companyId,
        values.actorContactId,
        values.employeeId,
        values.action,
        values.outcome,
        values.message ?? null,
        new Date().toISOString(),
      )
      .run();
  } catch (error) {
    // The audit table is a safety layer, not a reason to leave the user hanging.
    console.log(
      JSON.stringify({ level: 'warn', event: 'corporate_team_audit_failed', error: String(error) }),
    );
  }
}

async function verifyActorCanManageCompany(
  c: Context<CorporateBindings>,
  token: string,
  values: {
    portalId: string;
    companyId: string;
    actorContactId: string;
    employeeId: string;
    action: string;
  },
): Promise<Response | null> {
  const actorCompanies = await readContactCompanies(token, values.actorContactId);
  const actorCompanyEdge = actorCompanies.find((edge) => edgeObjectId(edge) === values.companyId);
  if (!actorCompanyEdge || !edgeHasAdminLabel(actorCompanyEdge)) {
    await audit(c.env, {
      portalId: values.portalId,
      companyId: values.companyId,
      actorContactId: values.actorContactId,
      employeeId: values.employeeId,
      action: values.action,
      outcome: 'blocked_not_admin',
    });
    return jsonError(c, 403, 'not_company_admin', 'Only company admins can manage this team.');
  }
  return null;
}

async function handleRemoveEmployee(c: Context<CorporateBindings>) {
  let body: RemoveEmployeeBody;
  try {
    body = await c.req.json<RemoveEmployeeBody>();
  } catch {
    return jsonError(c, 400, 'invalid_json', 'Invalid request body.');
  }

  const headerPortalId = cleanId(c.req.header('X-Portal-Id'));
  const portalId = cleanId(body.portalId || headerPortalId);
  const companyId = cleanId(body.companyId);
  const actorContactId = cleanId(body.actorContactId);
  const employeeId = cleanId(body.employeeId);

  if (![portalId, companyId, actorContactId, employeeId].every((id) => VALID_ID.test(id))) {
    return jsonError(
      c,
      400,
      'invalid_ids',
      'Missing or invalid portal, company, actor, or employee id.',
    );
  }

  if (portalId !== headerPortalId) {
    return jsonError(c, 400, 'portal_mismatch', 'Portal header and body do not match.');
  }

  if (actorContactId === employeeId) {
    await audit(c.env, {
      portalId,
      companyId,
      actorContactId,
      employeeId,
      action: 'remove_employee',
      outcome: 'blocked_self',
    });
    return jsonError(c, 403, 'self_removal_blocked', 'Admins cannot remove their own team access.');
  }

  let token: string;
  try {
    token = await hubspotToken(c.env, portalId);
  } catch {
    return jsonError(
      c,
      500,
      'hubspot_token_missing',
      'HubSpot team-management token is not configured.',
    );
  }

  try {
    const actorBlock = await verifyActorCanManageCompany(c, token, {
      portalId,
      companyId,
      actorContactId,
      employeeId,
      action: 'remove_employee',
    });
    if (actorBlock) {
      return actorBlock;
    }

    const companyContacts = await readCompanyContacts(token, companyId);
    const targetEdge = companyContacts.find((edge) => edgeObjectId(edge) === employeeId);
    if (!targetEdge) {
      await audit(c.env, {
        portalId,
        companyId,
        actorContactId,
        employeeId,
        action: 'remove_employee',
        outcome: 'not_linked',
      });
      return jsonError(
        c,
        404,
        'employee_not_linked',
        'That contact is not linked to this company.',
      );
    }

    const targetCompanies = await readContactCompanies(token, employeeId);
    const targetCompanyEdge = targetCompanies.find((edge) => edgeObjectId(edge) === companyId);
    if (
      edgeHasAdminLabel(targetEdge) ||
      (targetCompanyEdge && edgeHasAdminLabel(targetCompanyEdge))
    ) {
      await audit(c.env, {
        portalId,
        companyId,
        actorContactId,
        employeeId,
        action: 'remove_employee',
        outcome: 'blocked_target_admin',
      });
      return jsonError(
        c,
        403,
        'admin_removal_blocked',
        'Admin contacts must be changed by Weld Australia staff.',
      );
    }

    await hs(
      token,
      'DELETE',
      `${HS_API}/crm/v4/objects/companies/${encodeURIComponent(companyId)}` +
        `/associations/contacts/${encodeURIComponent(employeeId)}`,
    );

    await audit(c.env, {
      portalId,
      companyId,
      actorContactId,
      employeeId,
      action: 'remove_employee',
      outcome: 'removed',
    });
    return c.json({ ok: true, status: 'removed', employeeId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await audit(c.env, {
      portalId,
      companyId,
      actorContactId,
      employeeId,
      action: 'remove_employee',
      outcome: 'error',
      message,
    });
    if (error instanceof PermanentError && error.statusCode === 404) {
      return jsonError(
        c,
        404,
        'hubspot_not_found',
        'HubSpot could not find one of the requested records.',
      );
    }
    console.log(
      JSON.stringify({
        level: 'error',
        event: 'corporate_team_remove_failed',
        portalId,
        companyId,
        actorContactId,
        employeeId,
        error: message,
      }),
    );
    return jsonError(c, 500, 'remove_failed', 'Unable to remove this team member right now.');
  }
}

async function handleAddEmployee(c: Context<CorporateBindings>) {
  let body: AddEmployeeBody;
  try {
    body = await c.req.json<AddEmployeeBody>();
  } catch {
    return jsonError(c, 400, 'invalid_json', 'Invalid request body.');
  }

  const headerPortalId = cleanId(c.req.header('X-Portal-Id'));
  const portalId = cleanId(body.portalId || headerPortalId);
  const companyId = cleanId(body.companyId);
  const actorContactId = cleanId(body.actorContactId);
  const email = cleanEmail(body.email);
  const firstName = cleanText(body.firstName, 80);
  const lastName = cleanText(body.lastName, 80);
  const jobTitle = cleanText(body.jobTitle, 120);

  if (![portalId, companyId, actorContactId].every((id) => VALID_ID.test(id))) {
    return jsonError(c, 400, 'invalid_ids', 'Missing or invalid portal, company, or actor id.');
  }

  if (portalId !== headerPortalId) {
    return jsonError(c, 400, 'portal_mismatch', 'Portal header and body do not match.');
  }

  if (!isValidEmail(email)) {
    return jsonError(c, 400, 'invalid_email', 'Please enter a valid email address.');
  }

  if (!firstName || !lastName) {
    return jsonError(c, 400, 'missing_name', 'Please enter the employee first and last name.');
  }

  let token: string;
  try {
    token = await hubspotToken(c.env, portalId);
  } catch {
    return jsonError(
      c,
      500,
      'hubspot_token_missing',
      'HubSpot team-management token is not configured.',
    );
  }

  let contactId = 'unresolved';

  try {
    const actorBlock = await verifyActorCanManageCompany(c, token, {
      portalId,
      companyId,
      actorContactId,
      employeeId: contactId,
      action: 'add_employee',
    });
    if (actorBlock) {
      return actorBlock;
    }

    const { levelProperty } = await loadMembershipConfig(c.env, portalId);
    let contact = await readContactByEmail(token, email, levelProperty);
    let created = false;

    if (!contact) {
      contact = await createContact(token, { email, firstName, lastName, jobTitle });
      created = true;
    }

    contactId = cleanId(contact.id);
    if (!VALID_ID.test(contactId)) {
      throw new PermanentError('HubSpot returned an invalid contact id.');
    }

    const companyContacts = await readCompanyContacts(token, companyId);
    const alreadyLinked = companyContacts.some((edge) => edgeObjectId(edge) === contactId);

    if (!alreadyLinked) {
      await associateCompanyContact(token, companyId, contactId);
    }

    const employee = employeeFromContact(
      {
        ...contact,
        properties: {
          ...contact.properties,
          email: contact.properties?.email ?? email,
          firstname: contact.properties?.firstname ?? firstName,
          lastname: contact.properties?.lastname ?? lastName,
        },
      },
      levelProperty,
    );

    await audit(c.env, {
      portalId,
      companyId,
      actorContactId,
      employeeId: contactId,
      action: 'add_employee',
      outcome: alreadyLinked ? 'already_linked' : created ? 'created_linked' : 'linked_existing',
    });

    return c.json({
      ok: true,
      status: alreadyLinked ? 'already_linked' : created ? 'created_linked' : 'linked_existing',
      employee,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await audit(c.env, {
      portalId,
      companyId,
      actorContactId,
      employeeId: contactId,
      action: 'add_employee',
      outcome: 'error',
      message,
    });
    if (error instanceof PermanentError && error.statusCode === 409) {
      return jsonError(
        c,
        409,
        'contact_conflict',
        'A contact with that email may already exist. Please refresh and try again.',
      );
    }
    if (error instanceof PermanentError && error.statusCode === 404) {
      return jsonError(
        c,
        404,
        'hubspot_not_found',
        'HubSpot could not find one of the requested records.',
      );
    }
    console.log(
      JSON.stringify({
        level: 'error',
        event: 'corporate_team_add_failed',
        portalId,
        companyId,
        actorContactId,
        contactId,
        email,
        error: message,
      }),
    );
    return jsonError(c, 500, 'add_failed', 'Unable to add this team member right now.');
  }
}

async function handleBulkRegister(c: Context<CorporateBindings>) {
  let body: BulkRegisterBody;
  try {
    body = await c.req.json<BulkRegisterBody>();
  } catch {
    return jsonError(c, 400, 'invalid_json', 'Invalid request body.');
  }

  const headerPortalId = cleanId(c.req.header('X-Portal-Id'));
  const portalId = cleanId(body.portalId || headerPortalId);
  const companyId = cleanId(body.companyId);
  const actorContactId = cleanId(body.actorContactId);
  const sessionId = cleanId(body.sessionId);
  const eventId = cleanText(body.workerEventId || body.eventId, 120);
  const ticketTypeId = cleanText(body.ticketTypeId, 120);
  const idempotencyKey = cleanText(c.req.header('Idempotency-Key'), 160);
  const employeeIds = cleanIdList(body.employeeIds);
  const dryRun = body.dryRun === true || normaliseLabel(c.req.header('X-Dry-Run')) === 'true';
  const courseName = cleanText(body.session?.courseName, 180);
  const city = cleanText(body.session?.city, 80);
  const startDate = cleanText(body.session?.startDate, 80);

  if (![portalId, companyId, actorContactId].every((id) => VALID_ID.test(id))) {
    return jsonError(c, 400, 'invalid_ids', 'Missing or invalid portal, company, or actor id.');
  }

  if (portalId !== headerPortalId) {
    return jsonError(c, 400, 'portal_mismatch', 'Portal header and body do not match.');
  }

  if (!sessionId) {
    return jsonError(c, 400, 'missing_session', 'Please select a course session.');
  }

  if (!eventId || !ticketTypeId) {
    return jsonError(
      c,
      400,
      'missing_event_engine_config',
      'This session is not configured for online bulk registration.',
    );
  }

  if (employeeIds.length === 0) {
    return jsonError(c, 400, 'missing_employees', 'Please select at least one employee.');
  }

  if (!dryRun && !idempotencyKey) {
    return jsonError(c, 400, 'missing_idempotency_key', 'Idempotency-Key header required.');
  }

  let token: string;
  try {
    token = await hubspotToken(c.env, portalId);
  } catch {
    return jsonError(
      c,
      500,
      'hubspot_token_missing',
      'HubSpot team-management token is not configured.',
    );
  }

  try {
    const actorBlock = await verifyActorCanManageCompany(c, token, {
      portalId,
      companyId,
      actorContactId,
      employeeId: employeeIds[0],
      action: 'bulk_register',
    });
    if (actorBlock) {
      return actorBlock;
    }

    const companyContacts = await readCompanyContacts(token, companyId);
    const contactsById = new Map(companyContacts.map((edge) => [edgeObjectId(edge), edge]));
    const notLinked = employeeIds.filter((id) => !contactsById.has(id));
    if (notLinked.length > 0) {
      await audit(c.env, {
        portalId,
        companyId,
        actorContactId,
        employeeId: notLinked[0],
        action: 'bulk_register',
        outcome: 'blocked_not_linked',
        message: `Contacts not linked to company: ${notLinked.join(',')}`,
      });
      return jsonError(
        c,
        404,
        'employee_not_linked',
        'One or more selected contacts are not linked to this company.',
      );
    }

    // Vouchers are credit, not a quota: a company short of balance is no longer blocked —
    // its vouchers cover what they can and the remaining seats are invoiced as normal.
    // `resolveVoucherBalance` banks the pre-worker baseline on first contact and charges
    // against D1 (including live holds), so concurrent bulk bookings can't both spend the
    // same balance while the async projection to HubSpot is still in flight. The already
    // fetched company properties are handed over to save a second round-trip.
    const voucherConfig = await loadVoucherConfig(c.env, portalId);
    const company = await readCompany(token, companyId, [
      voucherConfig.totalProperty,
      voucherConfig.usedProperty,
    ]);
    const balance = await resolveVoucherBalance(
      c.env,
      portalId,
      companyId,
      company.properties as Record<string, string | undefined>,
    );
    const vouchersTotal = balance.total;
    const vouchersUsed = balance.usage.encumbered;
    const vouchersRemaining = balance.available;

    const { levelProperty } = await loadMembershipConfig(c.env, portalId);
    const employeeDetails = new Map<string, TeamEmployeeResponse>();
    for (const employeeId of employeeIds) {
      try {
        const contact = await readContactById(token, employeeId, levelProperty);
        employeeDetails.set(employeeId, employeeFromContact(contact, levelProperty));
      } catch {
        employeeDetails.set(employeeId, {
          id: employeeId,
          name: '',
          email: '',
          membership_tier: '',
        });
      }
    }

    const missingEmail = employeeIds.filter(
      (employeeId) => !isValidEmail(employeeDetails.get(employeeId)?.email ?? ''),
    );
    if (missingEmail.length > 0) {
      await audit(c.env, {
        portalId,
        companyId,
        actorContactId,
        employeeId: missingEmail[0],
        action: 'bulk_register',
        outcome: 'blocked_missing_email',
        message: `Contacts missing email: ${missingEmail.join(',')}`,
      });
      return jsonError(
        c,
        400,
        'missing_employee_email',
        'One or more selected contacts do not have an email address.',
      );
    }

    const actor = employeeFromContact(
      await readContactById(token, actorContactId, levelProperty),
      levelProperty,
    );
    if (!isValidEmail(actor.email)) {
      return jsonError(
        c,
        400,
        'missing_actor_email',
        'Your account needs an email address before bulk registration can be completed.',
      );
    }

    if (dryRun) {
      return c.json({
        ok: true,
        status: 'dry_run',
        dryRun: true,
        sessionId,
        eventId,
        ticketTypeId,
        wouldRegister: employeeIds.map((employeeId) => {
          const employee = employeeDetails.get(employeeId);
          return {
            employeeId,
            name: employee?.name ?? '',
            email: employee?.email ?? '',
          };
        }),
        registered: [],
        failed: [],
        vouchers: {
          mode: balance.config.mode,
          total: vouchersTotal,
          used: vouchersUsed,
          remaining: balance.metered ? vouchersRemaining : null,
          metered: balance.metered,
          // Seat mode can predict coverage without pricing; credit mode depends on the
          // resolved per-seat price, which only the reserve path knows.
          wouldCoverSeats:
            balance.config.mode === 'seat' ? Math.min(employeeIds.length, vouchersRemaining) : null,
        },
      });
    }

    // Keyed by contact id, so an employee list that changed between screens cannot silently
    // attach one person's answers to another. Reserve validates whatever arrives.
    const answersByEmployee: Record<string, QuestionAnswers> =
      body.answers && typeof body.answers === 'object' ? body.answers : {};

    const reserveResponse = await reserveEventWithBody(c as Context<{ Bindings: Env }>, portalId, {
      eventId,
      idempotencyKey,
      body: {
        buyer: {
          name: actor.name || actor.email,
          email: actor.email,
        },
        attendees: employeeIds.map((employeeId) => {
          const employee = employeeDetails.get(employeeId);
          return {
            name: employee?.name || employee?.email || `Contact ${employeeId}`,
            email: employee?.email ?? '',
            ticketTypeId,
            hubspotContactId: employeeId,
            ...(answersByEmployee[employeeId] ? { answers: answersByEmployee[employeeId] } : {}),
          };
        }),
        ...(body.orderAnswers ? { answers: body.orderAnswers } : {}),
        memberCompanyId: companyId,
        // Corporate bulk register is the deliberate redemption path — an employee's own
        // checkout carries memberCompanyId for pricing only and never spends the balance.
        redeemVouchers: true,
        expectedUnitCents: Number.isFinite(body.expectedUnitCents)
          ? body.expectedUnitCents
          : undefined,
      },
    });

    const reserveBody = (await reserveResponse
      .clone()
      .json()
      .catch(() => ({}))) as { status?: string; message?: string; orderId?: string };
    const reserveStatus = cleanText(reserveBody.status || `http_${reserveResponse.status}`, 80);

    // What the booking actually redeemed, read back from the order the reserve path wrote —
    // reserve owns the decision, so reporting anything else here could drift from the truth.
    const redeemed = reserveBody.orderId
      ? await c.env.DB.prepare(
          'SELECT voucher_seats_redeemed, voucher_credit_cents FROM orders WHERE id = ?1',
        )
          .bind(reserveBody.orderId)
          .first<{ voucher_seats_redeemed: number; voucher_credit_cents: number }>()
      : null;
    const seatsCovered = redeemed?.voucher_seats_redeemed ?? 0;
    const creditUsedCents = redeemed?.voucher_credit_cents ?? 0;

    for (const employeeId of employeeIds) {
      await audit(c.env, {
        portalId,
        companyId,
        actorContactId,
        employeeId,
        action: 'bulk_register',
        outcome: reserveResponse.ok
          ? reserveStatus || 'reserved'
          : `blocked_${reserveStatus || 'reserve_failed'}`,
        message:
          `session=${sessionId}; event=${eventId}; course=${courseName}; city=${city}; start=${startDate}; ` +
          `voucherSeats=${seatsCovered}; voucherCreditCents=${creditUsedCents}`,
      });
    }

    if (!reserveResponse.ok) return reserveResponse;

    // Surface the voucher outcome so the portal can show what was covered and what is
    // still to pay, without the caller having to re-derive it.
    return c.json(
      {
        ...(reserveBody as Record<string, unknown>),
        vouchers: {
          mode: balance.config.mode,
          metered: balance.metered,
          seatsCovered,
          creditUsedCents,
          seatsInvoiced: employeeIds.length - seatsCovered,
        },
      },
      reserveResponse.status as 200,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await audit(c.env, {
      portalId,
      companyId,
      actorContactId,
      employeeId: employeeIds[0] ?? '0',
      action: 'bulk_register',
      outcome: 'error',
      message,
    });
    if (error instanceof PermanentError && error.statusCode === 404) {
      return jsonError(
        c,
        404,
        'hubspot_not_found',
        'HubSpot could not find one of the requested records.',
      );
    }
    console.log(
      JSON.stringify({
        level: 'error',
        event: 'corporate_team_bulk_register_failed',
        portalId,
        companyId,
        actorContactId,
        sessionId,
        employeeCount: employeeIds.length,
        error: message,
      }),
    );
    return jsonError(
      c,
      500,
      'bulk_register_failed',
      'Unable to bulk register these team members right now.',
    );
  }
}

/**
 * Origins allowed to call the corporate routes from a browser, per portal.
 *
 * `CORPORATE_ALLOWED_ORIGIN_{portalId}`, then `CORPORATE_ALLOWED_ORIGIN`, comma-separated.
 * UNSET means unrestricted, which is what every deployment does today, so shipping this
 * changes nothing until a portal configures it.
 *
 * This is NOT authentication and must never be mistaken for it. Origin is set by the
 * browser and any non-browser caller simply omits it. What it does stop is the drive-by
 * case that CORS is actually for: a page on another site running script in a logged-in
 * member's browser. The real control is the per-contact action token
 * (`corporate_action_token`, verified against the contact's own HubSpot property), which
 * these routes do not check yet — see the security model note at the top of this file.
 */
function allowedOrigins(env: Env, portalId: string): string[] | null {
  const bag = env as unknown as Record<string, string | undefined>;
  const raw = bag[`CORPORATE_ALLOWED_ORIGIN_${portalId}`] ?? bag.CORPORATE_ALLOWED_ORIGIN;
  if (!raw) return null;
  const list = raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

/**
 * Reject a browser request from an origin this portal has not listed.
 *
 * A request with NO Origin header is allowed through: that is a server-to-server or
 * same-origin call, and refusing it would break non-browser callers without stopping
 * the attack this guards against (which, being browser-driven, always carries one).
 */
function checkCorporateOrigin(c: Context<CorporateBindings>, portalId: string): Response | null {
  const allowed = allowedOrigins(c.env, portalId);
  if (!allowed) return null;

  const origin = c.req.header('Origin');
  if (!origin) return null;
  if (allowed.includes(origin)) return null;

  console.log(
    JSON.stringify({
      level: 'warn',
      event: 'corporate_origin_rejected',
      portalId,
      origin,
      path: new URL(c.req.url).pathname,
    }),
  );
  return jsonError(c, 403, 'origin_not_allowed', 'This request did not come from the portal.');
}

/**
 * Rate limits for the corporate writes.
 *
 * Sized so a real corporate admin never meets them: onboarding a dozen staff one at a
 * time is well inside 30/min. `bulk-register` is lower because it is the one route here
 * that creates Deals and a HubSpot invoice, so the cost of abusing it is financial
 * rather than CRM hygiene.
 *
 * IP-keyed, like every other rate limit in the worker, so this bounds a single caller
 * and not a distributed one. Again: a bound, not a gate.
 */
const CORPORATE_RATE_LIMITS: Record<string, { limit: number; windowSeconds: number }> = {
  'add-employee': { limit: 30, windowSeconds: 60 },
  'remove-employee': { limit: 30, windowSeconds: 60 },
  'bulk-register': { limit: 10, windowSeconds: 60 },
};

const corporateTeam = new Hono<CorporateBindings>();

// Runs before every corporate handler. Deliberately cheap and deliberately not an
// identity check: these routes still trust a caller-supplied `actorContactId`, which is
// the open defect the action token closes.
corporateTeam.use('/*', async (c, next) => {
  const action = new URL(c.req.url).pathname.split('/').filter(Boolean).pop() ?? '';
  const portalId = c.req.header('X-Portal-Id')?.trim() || '';

  const blockedOrigin = checkCorporateOrigin(c, portalId);
  if (blockedOrigin) return blockedOrigin;

  const budget = CORPORATE_RATE_LIMITS[action];
  if (budget) {
    const limited = await checkRateLimit(c as unknown as Context<{ Bindings: Env }>, {
      prefix: `rl:corporate:${action}`,
      ...budget,
    });
    if (limited) return limited;
  }

  return next();
});

corporateTeam.post('/add-employee', handleAddEmployee);
corporateTeam.post('/remove-employee', handleRemoveEmployee);
corporateTeam.post('/bulk-register', handleBulkRegister);

export const corporateTeamRoutes = corporateTeam;
