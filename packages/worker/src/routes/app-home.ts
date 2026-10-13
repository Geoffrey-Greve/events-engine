import type { Context } from 'hono';
import { Hono } from 'hono';
import { effectiveCapacity } from '../db';
import { listOpenDecisionsForPortal } from '../decisions';
import { verifyHubSpotV3Signature } from '../hubspot-signature';
import { summariseEventRegistrations } from '../reporting';
import type { Env } from '../types';
import { reserveEventWithBody } from './reserve';

type AppHomeBindings = {
  Bindings: Env;
};

type ManualRegistrationMode = 'paid' | 'complimentary';

const VALID_HUBSPOT_ID = /^\d+$/;

function cleanText(value: unknown, max = 240): string {
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

function normalizeManualRegistrationMode(value: unknown): ManualRegistrationMode | null {
  const normalized = cleanText(value, 40).toLowerCase();
  if (normalized === 'paid') return 'paid';
  if (normalized === 'complimentary' || normalized === 'comp' || normalized === 'free') {
    return 'complimentary';
  }
  return null;
}

interface SignedAppHomeContext {
  portalId: string;
  staffActor: string | null;
}

async function requireSignedAppHomeRequest(
  c: Context<AppHomeBindings>,
  rawBody = '',
): Promise<SignedAppHomeContext | Response> {
  const timestamp = c.req.header('X-HubSpot-Request-Timestamp');
  const signature = c.req.header('X-HubSpot-Signature-v3');
  if (!timestamp || !signature) {
    return c.json({ status: 'unauthorized', message: 'HubSpot signature required' }, 401);
  }

  const clientSecret = c.env.HUBSPOT_CLIENT_SECRET;
  if (!clientSecret) {
    return c.json(
      { status: 'not_configured', message: 'HubSpot app client secret is not configured' },
      503,
    );
  }

  const valid = await verifyHubSpotV3Signature(
    c.req.method,
    c.req.url,
    rawBody,
    timestamp,
    signature,
    clientSecret,
  );
  if (!valid) {
    return c.json({ status: 'unauthorized', message: 'Invalid HubSpot signature' }, 401);
  }

  const url = new URL(c.req.url);
  const portalId = cleanText(url.searchParams.get('portalId'), 40);
  if (!portalId || !VALID_HUBSPOT_ID.test(portalId)) {
    return c.json(
      { status: 'missing_portal_id', message: 'Signed HubSpot portalId metadata is required' },
      400,
    );
  }

  const userEmail = cleanEmail(url.searchParams.get('userEmail'));
  const userId = cleanText(url.searchParams.get('userId'), 80);
  return {
    portalId,
    staffActor: userEmail || (userId ? `hubspot-user:${userId}` : null),
  };
}

function isResponse(value: SignedAppHomeContext | Response): value is Response {
  return value instanceof Response;
}

function parseJsonBody<T>(rawBody: string): T | null {
  try {
    return (rawBody ? JSON.parse(rawBody) : {}) as T;
  } catch {
    return null;
  }
}

async function handleListEvents(c: Context<AppHomeBindings>): Promise<Response> {
  const signed = await requireSignedAppHomeRequest(c);
  if (isResponse(signed)) return signed;

  const hubspotEventId = c.req.query('hubspotEventId');
  if (hubspotEventId) {
    const row = await c.env.DB.prepare(
      'SELECT * FROM events WHERE portal_id = ?1 AND hubspot_event_id = ?2',
    )
      .bind(signed.portalId, hubspotEventId)
      .first();
    if (!row) return c.json({ status: 'not_found', message: 'Event not found' }, 404);
    return c.json(row);
  }

  const rows = await c.env.DB.prepare(
    'SELECT * FROM events WHERE portal_id = ?1 ORDER BY starts_at DESC',
  )
    .bind(signed.portalId)
    .all();
  return c.json(rows.results);
}

/**
 * Every open decision in the portal, across all events.
 *
 * Phase 18.3 decisions are recorded in D1 and resolved from the event's own App Card, and
 * the assigned HubSpot task was the only thing that ever told an owner one was waiting.
 * `crm.objects.tasks.write` is unavailable to both 2026.03 project apps and account service
 * keys, so for such a portal nothing pushes a decision at anybody and the per-event card is
 * only found by someone already looking at that event. This list is the standing surface
 * that makes them discoverable without one.
 *
 * Read-only on purpose: resolving an oversell or picking who to offer a freed seat to needs
 * the order, the refund policy and the waitlist beside it, which is what the event card
 * already puts on screen. Answering "what needs me, and where" is a different job from
 * answering it.
 */
async function handleListPendingDecisions(c: Context<AppHomeBindings>): Promise<Response> {
  const signed = await requireSignedAppHomeRequest(c);
  if (isResponse(signed)) return signed;

  const decisions = await listOpenDecisionsForPortal(c.env, signed.portalId);
  // Parse the context JSON here so the card does not have to, exactly as the per-event
  // manage route does. A row whose context is unparseable is still worth showing: the
  // decision is the fact, and the context is only the detail behind it.
  return c.json(
    decisions.map((d) => {
      let context: unknown = null;
      try {
        context = d.context ? JSON.parse(d.context) : null;
      } catch {
        context = null;
      }
      return { ...d, context };
    }),
  );
}

async function ensureEventForPortal(
  c: Context<AppHomeBindings>,
  portalId: string,
  eventId: string,
): Promise<{ id: string; capacity?: number; capacity_unlimited?: number | null } | null> {
  return c.env.DB.prepare(
    'SELECT id, capacity, capacity_unlimited FROM events WHERE portal_id = ?1 AND id = ?2',
  )
    .bind(portalId, eventId)
    .first<{ id: string; capacity?: number; capacity_unlimited?: number | null }>();
}

async function handleListTicketTypes(c: Context<AppHomeBindings>): Promise<Response> {
  const signed = await requireSignedAppHomeRequest(c);
  if (isResponse(signed)) return signed;

  const id = c.req.param('id') ?? '';
  const event = await ensureEventForPortal(c, signed.portalId, id);
  if (!event) return c.json({ status: 'not_found', message: 'Event not found' }, 404);

  const rows = await c.env.DB.prepare(
    'SELECT * FROM ticket_types WHERE event_id = ?1 ORDER BY sort_order ASC, created_at ASC',
  )
    .bind(id)
    .all();
  return c.json(rows.results);
}

async function handleListRegistrations(c: Context<AppHomeBindings>): Promise<Response> {
  const signed = await requireSignedAppHomeRequest(c);
  if (isResponse(signed)) return signed;

  const id = c.req.param('id') ?? '';
  const event = await ensureEventForPortal(c, signed.portalId, id);
  if (!event) return c.json({ status: 'not_found', message: 'Event not found' }, 404);

  const rows = await c.env.DB.prepare(
    `SELECT r.id, r.order_id, r.ticket_type_id, r.attendee_email, r.attendee_name,
            r.ticket_id, o.status AS order_status, o.total_cents, o.refunded_cents
     FROM registrations r
     JOIN orders o ON o.id = r.order_id
     WHERE r.portal_id = ?1 AND r.event_id = ?2
     ORDER BY r.created_at ASC`,
  )
    .bind(signed.portalId, id)
    .all();
  return c.json(rows.results);
}

async function handleEventStats(c: Context<AppHomeBindings>): Promise<Response> {
  const signed = await requireSignedAppHomeRequest(c);
  if (isResponse(signed)) return signed;

  const id = c.req.param('id') ?? '';
  const event = await ensureEventForPortal(c, signed.portalId, id);
  if (!event) return c.json({ status: 'not_found', message: 'Event not found' }, 404);

  // The same shared count the manage card and the door scanner use (Phase 2.2).
  const summary = await summariseEventRegistrations(c.env, signed.portalId, id);

  // An uncapped event reports null rather than 0 — 0 would read as "sold out" on the card.
  const capacity = effectiveCapacity({
    capacity: Number(event.capacity ?? 0),
    capacity_unlimited: event.capacity_unlimited,
  });
  const availableSeats = capacity === null ? null : Math.max(0, capacity - summary.seatsHeld);

  return c.json({
    eventId: id,
    capacity,
    registered: summary.registered,
    attended: summary.attended,
    notYetArrived: summary.notYetArrived,
    availableSeats,
    summary,
  });
}

async function handleCreateManualRegistration(c: Context<AppHomeBindings>): Promise<Response> {
  const rawBody = await c.req.text();
  const signed = await requireSignedAppHomeRequest(c, rawBody);
  if (isResponse(signed)) return signed;

  const id = c.req.param('id') ?? '';
  const event = await ensureEventForPortal(c, signed.portalId, id);
  if (!event) return c.json({ status: 'not_found', message: 'Event not found' }, 404);

  const body = parseJsonBody<{
    mode?: string;
    ticketTypeId?: string;
    attendeeEmail?: string;
    attendeeName?: string;
    hubspotContactId?: string | null;
    memberCompanyId?: string | null;
    companyId?: string | null;
    buyerEmail?: string | null;
    buyerName?: string | null;
    invoiceDueDate?: string | null;
    staffNote?: string | null;
    idempotencyKey?: string | null;
  }>(rawBody);
  if (!body) {
    return c.json({ status: 'invalid_body', message: 'Request body must be valid JSON' }, 400);
  }

  const mode = normalizeManualRegistrationMode(body.mode ?? 'paid');
  if (!mode) {
    return c.json(
      { status: 'invalid_mode', message: 'mode must be "paid" or "complimentary"' },
      400,
    );
  }

  const ticketTypeId = cleanText(body.ticketTypeId, 120);
  const attendeeEmail = cleanEmail(body.attendeeEmail);
  const attendeeName = cleanText(body.attendeeName, 160);
  const buyerEmail = cleanEmail(body.buyerEmail || attendeeEmail);
  const buyerName = cleanText(body.buyerName || attendeeName, 160);
  const hubspotContactId = cleanText(body.hubspotContactId, 80);
  const memberCompanyId = cleanText(body.memberCompanyId || body.companyId, 80);
  const idempotencyKey =
    cleanText(body.idempotencyKey, 180) ||
    `app-home-${signed.portalId}-${id}-${crypto.randomUUID()}`;

  if (!ticketTypeId) {
    return c.json({ status: 'missing_ticket_type', message: 'ticketTypeId is required' }, 400);
  }
  if (!attendeeName || !isValidEmail(attendeeEmail)) {
    return c.json(
      {
        status: 'invalid_attendee',
        message: 'attendeeName and a valid attendeeEmail are required',
      },
      400,
    );
  }
  if (!buyerName || !isValidEmail(buyerEmail)) {
    return c.json(
      { status: 'invalid_buyer', message: 'buyerName and a valid buyerEmail are required' },
      400,
    );
  }
  if (hubspotContactId && !VALID_HUBSPOT_ID.test(hubspotContactId)) {
    return c.json(
      { status: 'invalid_contact_id', message: 'hubspotContactId must be a numeric HubSpot ID' },
      400,
    );
  }
  if (memberCompanyId && !VALID_HUBSPOT_ID.test(memberCompanyId)) {
    return c.json(
      {
        status: 'invalid_company_id',
        message: 'memberCompanyId must be a numeric HubSpot Company ID',
      },
      400,
    );
  }

  const reserveResponse = await reserveEventWithBody(
    c as unknown as Context<{ Bindings: Env }>,
    signed.portalId,
    {
      eventId: id,
      idempotencyKey,
      body: {
        buyer: {
          email: buyerEmail,
          name: buyerName,
          ...(hubspotContactId ? { hubspotContactId } : {}),
        },
        attendees: [
          {
            email: attendeeEmail,
            name: attendeeName,
            ticketTypeId,
            ...(hubspotContactId ? { hubspotContactId } : {}),
          },
        ],
        ...(memberCompanyId ? { memberCompanyId } : {}),
      },
      options: {
        forceFree: mode === 'complimentary',
        source: 'staff_manual',
        invoiceDueDate: body.invoiceDueDate ?? null,
        staffActor: signed.staffActor,
        staffNote: cleanText(body.staffNote, 500) || null,
      },
    },
  );

  const responseBody = (await reserveResponse
    .clone()
    .json()
    .catch(() => ({}))) as Record<string, unknown>;
  return c.json(
    {
      ok: reserveResponse.ok,
      mode,
      manual: true,
      ...responseBody,
    },
    reserveResponse.status as 200 | 400 | 403 | 404 | 409 | 500,
  );
}

async function handleGetOrder(c: Context<AppHomeBindings>): Promise<Response> {
  const signed = await requireSignedAppHomeRequest(c);
  if (isResponse(signed)) return signed;

  const orderId = c.req.param('id') ?? '';
  const row = await c.env.DB.prepare(
    'SELECT id, status, hubspot_invoice_id, hubspot_invoice_url FROM orders WHERE id = ?1 AND portal_id = ?2',
  )
    .bind(orderId, signed.portalId)
    .first<{
      id: string;
      status: string;
      hubspot_invoice_id: string | null;
      hubspot_invoice_url: string | null;
    }>();

  if (!row) return c.json({ error: 'order_not_found', message: 'Order not found' }, 404);

  if (row.status === 'cancelled') {
    return c.json({
      status: row.status,
      paymentUrl: null,
      message:
        'This reservation has expired. Please create a new manual booking if payment is still required.',
    });
  }

  if (row.status === 'refunded' || row.status === 'partially_refunded') {
    return c.json({
      status: row.status,
      paymentUrl: null,
      message: 'This order is no longer payable.',
    });
  }

  return c.json({
    status: row.status,
    paymentUrl: row.hubspot_invoice_url,
  });
}

const appHome = new Hono<AppHomeBindings>();

appHome.get('/events', handleListEvents);
appHome.get('/pending-decisions', handleListPendingDecisions);
appHome.get('/events/:id/ticket-types', handleListTicketTypes);
appHome.get('/events/:id/registrations', handleListRegistrations);
appHome.get('/events/:id/stats', handleEventStats);
appHome.post('/events/:id/registrations', handleCreateManualRegistration);
appHome.get('/orders/:id', handleGetOrder);

export const appHomeRoutes = appHome;
