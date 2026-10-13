import {
  Alert,
  Box,
  Button,
  Divider,
  Flex,
  Form,
  hubspot,
  Input,
  Link,
  LoadingSpinner,
  NumberInput,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tag,
  Text,
  ToggleGroup,
} from '@hubspot/ui-extensions';
import { useEffect, useState } from 'react';
import { getExtensionProps } from './shared/use-extension-props';

// ---------------------------------------------------------------------------
// Types matching EventRow / TicketTypeRow from the worker
// ---------------------------------------------------------------------------

interface WorkerEvent {
  id: string;
  hubspot_event_id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  capacity: number;
  capacity_unlimited?: number;
  location: string | null;
  provider: string | null;
  allow_oversell: number;
  category: string | null;
  refund_policy_id: string | null;
  hubspot_owner_id: string | null;
  invoice_due_days: number | null;
  /** Migration 0038. NULL = closes when the event starts. */
  registration_closes_at?: string | null;
  sales_paused?: number;
}

interface TicketType {
  id: string;
  name: string;
  price_cents: number;
  currency: string;
  capacity: number;
  capacity_unlimited?: number;
  tax_treatment: string;
  member_only: number;
  /** Migration 0038. This type alone off sale; the event keeps selling the others. */
  sales_paused?: number;
  sort_order: number;
}

interface PricingRule {
  id: string;
  scope: string;
  scope_id: string | null;
  member_level: string;
  member_category: string;
  discount_percent: number | null;
  fixed_price_cents: number | null;
}

/**
 * One resolved registration question (Phase 2.3), as `GET /events/:id/questions` returns
 * it: the event's own plus the tenant-wide defaults it does not override. `eventId` is
 * what tells the two apart, and is the difference between retiring a question here and
 * retiring it on every event in the portal.
 */
interface RegistrationQuestion {
  id: string;
  key: string;
  label: string;
  fieldType: string;
  options: Array<{ value: string; label: string }> | null;
  required: boolean;
  scope: string;
  helpText: string | null;
  sortOrder: number;
  eventId: string | null;
  hsProperty: string | null;
  prefill: boolean;
}

/**
 * One row of the Phase 2.2 attendee list. The endpoint returns a great deal more per
 * attendee (phone/suburb/state, invoice, vouchers, attendance) — these are the fields this
 * card renders; the CSV export is where the full record goes.
 */
interface Registration {
  id: string;
  order_id: string;
  attendee_email: string;
  attendee_name: string;
  order_status: string;
  /** Order-level total, repeated across the attendees on a bulk booking. */
  order_total_cents: number;
  order_refunded_cents: number;
  status: 'attended' | 'registered' | 'cancelled';
  attended: boolean;
  /** A seat held for a company with nobody on it yet (Ref 74b). */
  seat_unnamed?: boolean;
}

/** The Phase 2.2 envelope around the attendee list: a page of rows plus whole-event counts. */
interface RegistrationsPage {
  registrations: Registration[];
  summary: {
    total: number;
    confirmed: number;
    awaitingPayment: number;
    needsReview: number;
    cancelled: number;
    attended: number;
    registered: number;
    notYetArrived: number;
    /** Seats sold to a company that are still waiting on a name (Ref 74b). */
    unnamedSeats?: number;
  };
  page: { total: number; returned: number; hasMore: boolean };
}

/**
 * An internal staff note (Phase 1.3). Append-only: editing one means writing another, so
 * the card shows the whole thread rather than a single editable field. Never shown to an
 * attendee — this data has no public endpoint.
 */
interface StaffNote {
  id: string;
  registration_id: string | null;
  order_id: string | null;
  author: string;
  body: string;
  created_at: string;
}

interface RefundPolicy {
  id: string;
  name: string;
  is_default: number;
  category: string | null;
  full_refund_cutoff_days: number | null;
  partial_refund_percent: number | null;
  allow_transfer: number;
}

interface WaitlistEntry {
  id: string;
  email: string;
  ticketTypeId: string | null;
  quantity: number;
  position: number;
}

/** One HubSpot contact property whose stored value differs from what a booking captured. */
interface ContactConflictField {
  field: string;
  property: string;
  existing: string;
  captured: string;
}

interface PendingDecision {
  id: string;
  type: string;
  order_id: string | null;
  registration_id: string | null;
  assigned_owner_id: string | null;
  context: {
    totalCents?: number;
    currency?: string;
    buyerEmail?: string;
    freedSeats?: number;
    waitlist?: WaitlistEntry[];
    /** Fast sell-out (Phase 1.1). */
    capacity?: number;
    minutesToSellOut?: number;
    /** Contact conflict (Phase 1.2). */
    attendeeEmail?: string;
    attendeeName?: string | null;
    conflicts?: ContactConflictField[];
  } | null;
}

interface ManualRegistrationResult {
  ok?: boolean;
  mode?: string;
  status?: string;
  message?: string;
  orderId?: string;
  registrationIds?: string[];
  ticketIds?: string[];
  pollUrl?: string;
  paymentUrl?: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function centsToDisplay(cents: number): string {
  return (cents / 100).toFixed(2);
}

function displayToCents(display: string): number {
  return Math.round(parseFloat(display) * 100);
}

function defaultInvoiceDueDate(): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + 30);
  return date.toISOString().slice(0, 10);
}

const PROVIDER_OPTIONS = [
  { label: 'None (in-person)', value: 'none' },
  { label: 'Microsoft Teams', value: 'teams' },
  { label: 'Zoom', value: 'zoom' },
];

// ---------------------------------------------------------------------------
// Card root
// ---------------------------------------------------------------------------

hubspot.extend<'crm.record.tab'>(({ context }) => {
  const { workerBaseUrl, userId, authHeaders } = getExtensionProps(context);
  const hubspotEventId = String(context.crm.objectId);

  const [event, setEvent] = useState<WorkerEvent | null | undefined>(undefined);
  const [ticketTypes, setTicketTypes] = useState<TicketType[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Create form state
  const [createTitle, setCreateTitle] = useState('');
  const [createStartsAt, setCreateStartsAt] = useState('');
  const [createEndsAt, setCreateEndsAt] = useState('');
  const [createCapacity, setCreateCapacity] = useState(0);
  // "Uncapped" has to be said out loud — the worker rejects a 0/blank capacity otherwise,
  // which is what stops a setup placeholder reaching buyers (Phase 1.1).
  const [createUnlimited, setCreateUnlimited] = useState(false);
  const [createLocation, setCreateLocation] = useState('');
  const [createProvider, setCreateProvider] = useState('none');

  // Edit form state
  const [editCapacity, setEditCapacity] = useState(0);
  const [editUnlimited, setEditUnlimited] = useState(false);
  const [editProvider, setEditProvider] = useState('none');
  const [editCategory, setEditCategory] = useState('');
  const [editRefundPolicyId, setEditRefundPolicyId] = useState('');
  const [editOwnerId, setEditOwnerId] = useState('');
  // Blank = use the portal default payment terms for paid bookings on this event.
  const [editInvoiceDueDays, setEditInvoiceDueDays] = useState('');

  // Sales window (migration 0038). Blank closes registrations when the event starts.
  const [editClosesAt, setEditClosesAt] = useState('');
  const [editSalesPaused, setEditSalesPaused] = useState(false);
  // Pausing is the one-click stop, so it saves on its own rather than waiting for the
  // rest of the form: needing to press "Save changes" to stop selling a mispriced course
  // is the reason someone zeroes the capacity instead.
  const [pauseSaving, setPauseSaving] = useState(false);
  const [ttPauseSaving, setTtPauseSaving] = useState<string | null>(null);
  // Per-row capacity drafts, keyed by ticket type id. Absent = untouched, so a reload or
  // a save on another row cannot clobber an edit someone is part way through.
  const [ttCapacityEdits, setTtCapacityEdits] = useState<
    Record<string, { capacity: number; unlimited: boolean }>
  >({});
  const [ttCapacitySaving, setTtCapacitySaving] = useState<string | null>(null);

  // Pending decisions (oversell + waitlist — human-in-the-loop)
  const [pendingDecisions, setPendingDecisions] = useState<PendingDecision[]>([]);
  const [decisionSelections, setDecisionSelections] = useState<Record<string, string[]>>({});

  // Refunds & transfers (Phase 18.2)
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const [registrationSummary, setRegistrationSummary] = useState<
    RegistrationsPage['summary'] | null
  >(null);
  /**
   * A minted CSV download link. Held in state rather than rendered eagerly because the
   * token behind it lives about five minutes — a link put on screen when the card loaded
   * would be dead by the time anyone clicked it, and would read as a broken export.
   */
  const [exportLink, setExportLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportBusy, setExportBusy] = useState(false);
  const [refundPolicies, setRefundPolicies] = useState<RefundPolicy[]>([]);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [transferRegId, setTransferRegId] = useState<string | null>(null);
  const [transferEmail, setTransferEmail] = useState('');
  const [transferName, setTransferName] = useState('');
  // Staff notes (Phase 1.3) — every note on the event, filtered per attendee below.
  const [staffNotes, setStaffNotes] = useState<StaffNote[]>([]);
  const [notesRegId, setNotesRegId] = useState<string | null>(null);
  // Company seat blocks (Ref 74b): holding seats now, naming them later.
  const [blockSeats, setBlockSeats] = useState(0);
  const [blockBuyerName, setBlockBuyerName] = useState('');
  const [blockBuyerEmail, setBlockBuyerEmail] = useState('');
  const [blockCompanyId, setBlockCompanyId] = useState('');
  const [blockTicketTypeId, setBlockTicketTypeId] = useState('');
  const [blockSaving, setBlockSaving] = useState(false);
  // Assigning one held seat to a person.
  const [assignRegId, setAssignRegId] = useState<string | null>(null);
  const [assignName, setAssignName] = useState('');
  const [assignEmail, setAssignEmail] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  // Staff manual add-attendee form
  const [manualMode, setManualMode] = useState('paid');
  const [manualTicketTypeId, setManualTicketTypeId] = useState('');
  const [manualAttendeeName, setManualAttendeeName] = useState('');
  const [manualAttendeeEmail, setManualAttendeeEmail] = useState('');
  const [manualContactId, setManualContactId] = useState('');
  const [manualMemberCompanyId, setManualMemberCompanyId] = useState('');
  const [manualBuyerName, setManualBuyerName] = useState('');
  const [manualBuyerEmail, setManualBuyerEmail] = useState('');
  const [manualInvoiceDueDate, setManualInvoiceDueDate] = useState(defaultInvoiceDueDate);
  const [manualStaffNote, setManualStaffNote] = useState('');
  const [manualSaving, setManualSaving] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const [manualResult, setManualResult] = useState<ManualRegistrationResult | null>(null);
  // Refund policy template form
  const [rpName, setRpName] = useState('');
  const [rpCutoff, setRpCutoff] = useState(30);
  const [rpPartial, setRpPartial] = useState(0);
  const [rpCategory, setRpCategory] = useState('');
  const [rpAllowTransfer, setRpAllowTransfer] = useState(true);
  const [rpIsDefault, setRpIsDefault] = useState(false);

  // Add ticket type form
  const [ttName, setTtName] = useState('');
  const [ttPriceDisplay, setTtPriceDisplay] = useState('0.00');
  const [ttCapacity, setTtCapacity] = useState(0);
  const [ttUnlimited, setTtUnlimited] = useState(false);
  const [ttTaxTreatment, setTtTaxTreatment] = useState('gst');
  const [ttMemberOnly, setTtMemberOnly] = useState(false);
  const [ttSortOrder, setTtSortOrder] = useState(0);
  const [ttError, setTtError] = useState<string | null>(null);
  const [ttSaving, setTtSaving] = useState(false);

  // Custom registration questions (Phase 2.3). Dietary requirements is a seeded row here,
  // not a hard-coded field, so the next thing the tenant needs to ask — a coffee order, a
  // shirt size, a PO number — is a row somebody adds in this card rather than a code change.
  const [questions, setQuestions] = useState<RegistrationQuestion[]>([]);
  const [qLabel, setQLabel] = useState('');
  const [qKey, setQKey] = useState('');
  const [qFieldType, setQFieldType] = useState('text');
  const [qScope, setQScope] = useState('attendee');
  const [qRequired, setQRequired] = useState(false);
  const [qOptions, setQOptions] = useState('');
  const [qHelpText, setQHelpText] = useState('');
  const [qHsProperty, setQHsProperty] = useState('');
  const [qCreateProperty, setQCreateProperty] = useState(true);
  const [qSortOrder, setQSortOrder] = useState(0);
  // Every event, or this one. A tenant-wide row is asked on everything; an event row with
  // the same key replaces it for this event only.
  const [qLevel, setQLevel] = useState('event');
  const [qError, setQError] = useState<string | null>(null);
  const [qNotice, setQNotice] = useState<string | null>(null);
  const [qSaving, setQSaving] = useState(false);

  // Pricing rules (tiered member discounts by level + category)
  const [pricingRules, setPricingRules] = useState<PricingRule[]>([]);
  const [prLevel, setPrLevel] = useState('');
  const [prCategory, setPrCategory] = useState('corporate');
  const [prMode, setPrMode] = useState('percent');
  const [prPercent, setPrPercent] = useState(0);
  const [prFixedDisplay, setPrFixedDisplay] = useState('0.00');
  const [prError, setPrError] = useState<string | null>(null);
  const [prSaving, setPrSaving] = useState(false);

  async function loadEvent() {
    if (!workerBaseUrl) {
      setLoadError('workerBaseUrl card property is not configured.');
      setEvent(null);
      return;
    }
    try {
      const res = await hubspot.fetch(
        `${workerBaseUrl}/api/v1/manage/events?hubspotEventId=${encodeURIComponent(hubspotEventId)}`,
        { headers: authHeaders },
      );
      if (res.status === 404) {
        setEvent(null);
        return;
      }
      if (!res.ok) {
        const body = await res.text();
        setLoadError(`Failed to load event (${res.status}): ${body}`);
        setEvent(null);
        return;
      }
      const data = (await res.json()) as WorkerEvent;
      setEvent(data);
      setEditCapacity(data.capacity);
      setEditUnlimited(!!data.capacity_unlimited);
      setEditProvider(data.provider ?? 'none');
      setEditCategory(data.category ?? '');
      setEditRefundPolicyId(data.refund_policy_id ?? '');
      setEditOwnerId(data.hubspot_owner_id ?? '');
      setEditInvoiceDueDays(data.invoice_due_days == null ? '' : String(data.invoice_due_days));
      setEditClosesAt(data.registration_closes_at ?? '');
      setEditSalesPaused(!!data.sales_paused);
      await loadTicketTypes(data.id);
      await loadRegistrations(data.id);
      await loadStaffNotes(data.id);
      await loadRefundPolicies();
      await loadPendingDecisions(data.id);
      await loadQuestions(data.id);
    } catch (err) {
      setLoadError(String(err));
      setEvent(null);
    }
  }

  async function loadTicketTypes(eventId: string) {
    try {
      const res = await hubspot.fetch(
        `${workerBaseUrl}/api/v1/manage/events/${eventId}/ticket-types`,
        { headers: authHeaders },
      );
      if (res.ok) {
        const data = (await res.json()) as TicketType[];
        setTicketTypes(data);
        if (!manualTicketTypeId && data.length > 0) {
          setManualTicketTypeId(data[0].id);
        }
      }
    } catch {
      // ticket types are secondary; don't surface separately
    }
    await loadPricingRules(eventId);
  }

  async function loadPricingRules(eventId: string) {
    try {
      const res = await hubspot.fetch(
        `${workerBaseUrl}/api/v1/manage/events/${eventId}/pricing-rules`,
        { headers: authHeaders },
      );
      if (res.ok) {
        setPricingRules((await res.json()) as PricingRule[]);
      }
    } catch {
      // pricing rules are secondary; don't surface separately
    }
  }

  async function handleAddPricingRule() {
    if (!event) return;
    setPrSaving(true);
    setPrError(null);
    try {
      const res = await hubspot.fetch(
        `${workerBaseUrl}/api/v1/manage/events/${event.id}/pricing-rules`,
        {
          method: 'POST',
          headers: authHeaders,
          body: {
            scope: 'event',
            memberLevel: prLevel,
            memberCategory: prCategory,
            discountPercent: prMode === 'percent' ? prPercent : undefined,
            fixedPriceCents: prMode === 'fixed' ? displayToCents(prFixedDisplay) : undefined,
          },
        },
      );
      if (!res.ok) {
        const body = await res.text();
        setPrError(`Add failed (${res.status}): ${body}`);
      } else {
        setPrLevel('');
        setPrPercent(0);
        setPrFixedDisplay('0.00');
        await loadPricingRules(event.id);
      }
    } catch (err) {
      setPrError(String(err));
    } finally {
      setPrSaving(false);
    }
  }

  async function handleDeletePricingRule(ruleId: string) {
    if (!event) return;
    try {
      const res = await hubspot.fetch(
        `${workerBaseUrl}/api/v1/manage/events/${event.id}/pricing-rules/${ruleId}`,
        { method: 'DELETE', headers: authHeaders },
      );
      if (res.ok) await loadPricingRules(event.id);
    } catch {
      // ignore — list reload will reflect actual state
    }
  }

  // -------------------------------------------------------------------------
  // Custom registration questions (Phase 2.3)
  // -------------------------------------------------------------------------

  /**
   * The RESOLVED set — what a registration form for this event actually asks — rather
   * than this event's own rows. That is the list staff came here to check, and it is the
   * list the CMS module renders.
   */
  async function loadQuestions(eventId: string) {
    try {
      const res = await hubspot.fetch(
        `${workerBaseUrl}/api/v1/manage/events/${eventId}/questions`,
        { headers: authHeaders },
      );
      if (res.ok) setQuestions((await res.json()) as RegistrationQuestion[]);
    } catch {
      // Questions are secondary to the event itself; the section renders empty.
    }
  }

  async function handleAddQuestion() {
    if (!event) return;
    setQSaving(true);
    setQError(null);
    setQNotice(null);
    const needsOptions = qFieldType === 'select' || qFieldType === 'multiselect';
    const options = qOptions
      .split(',')
      .map((option) => option.trim())
      .filter(Boolean);
    if (needsOptions && options.length === 0) {
      setQError(`A ${qFieldType} question needs at least one option.`);
      setQSaving(false);
      return;
    }
    try {
      // The portal-wide route for a default asked on everything, the event route for one
      // that only applies here. Same body either way.
      const url =
        qLevel === 'portal'
          ? `${workerBaseUrl}/api/v1/manage/questions`
          : `${workerBaseUrl}/api/v1/manage/events/${event.id}/questions`;
      const res = await hubspot.fetch(url, {
        method: 'POST',
        headers: authHeaders,
        body: {
          key: qKey.trim().toLowerCase(),
          label: qLabel.trim(),
          fieldType: qFieldType,
          scope: qScope,
          required: qRequired,
          ...(needsOptions ? { options } : {}),
          ...(qHelpText.trim() ? { helpText: qHelpText.trim() } : {}),
          // Order-scoped questions cannot map to a contact property: the answer is about
          // the booking, and the buyer is not the person it describes. The worker rejects
          // the pair, so don't send it.
          ...(qScope === 'attendee' && qHsProperty.trim()
            ? { hsProperty: qHsProperty.trim(), createHsProperty: qCreateProperty }
            : {}),
          sortOrder: qSortOrder,
        },
      });
      if (!res.ok) {
        const body = await res.text();
        setQError(`Add failed (${res.status}): ${body}`);
        return;
      }
      // The response reports whether the property EXISTS. Creating it is queued, not done
      // here, so "missing" with `queued` is work in progress rather than something to act
      // on — and either way the question itself is saved.
      const created = (await res.json()) as {
        hsProperty?: {
          property: string;
          status: string;
          detail: string | null;
          queued: boolean;
        } | null;
      };
      const property = created.hsProperty;
      if (property && property.status !== 'exists') {
        setQNotice(
          property.queued
            ? `Question saved. The contact property "${property.property}" is being created in HubSpot; answers stay in the Event Engine until it exists.`
            : `Question saved. The contact property "${property.property}" does not exist (${property.status}${
                property.detail ? `: ${property.detail}` : ''
              }), so answers stay in the Event Engine until someone creates it.`,
        );
      }
      setQLabel('');
      setQKey('');
      setQOptions('');
      setQHelpText('');
      setQHsProperty('');
      setQRequired(false);
      setQSortOrder(0);
      await loadQuestions(event.id);
    } catch (err) {
      setQError(String(err));
    } finally {
      setQSaving(false);
    }
  }

  /**
   * Archives, never deletes — the worker has no delete route by design. Every answer the
   * question collected stays readable, which is what lets last year's attendee list still
   * show what people replied to a question nobody asks any more.
   */
  async function handleArchiveQuestion(questionId: string) {
    if (!event) return;
    setQError(null);
    setQNotice(null);
    try {
      const res = await hubspot.fetch(`${workerBaseUrl}/api/v1/manage/questions/${questionId}`, {
        method: 'DELETE',
        headers: authHeaders,
      });
      if (!res.ok) {
        const body = await res.text();
        setQError(`Archive failed (${res.status}): ${body}`);
        return;
      }
      await loadQuestions(event.id);
    } catch (err) {
      setQError(String(err));
    }
  }

  async function loadRegistrations(eventId: string) {
    try {
      const res = await hubspot.fetch(
        `${workerBaseUrl}/api/v1/manage/events/${eventId}/registrations`,
        { headers: authHeaders },
      );
      if (!res.ok) return;
      const body = (await res.json()) as RegistrationsPage;
      setRegistrations(body.registrations ?? []);
      setRegistrationSummary(body.summary ?? null);
      // A link minted for the previously selected event would download the wrong list.
      setExportLink(null);
      setExportError(null);
    } catch {
      // secondary — don't surface separately
    }
  }

  /**
   * Mint a short-lived CSV download link.
   *
   * The export endpoint is admin-authed and a browser download is a plain navigation that
   * carries no headers, so the card asks the worker for a URL that authorises itself and
   * hands that to the browser. Minted on click so the token is fresh when it is used.
   */
  async function prepareCsvExport(eventId: string) {
    setExportError(null);
    setExportLink(null);
    setExportBusy(true);
    try {
      const res = await hubspot.fetch(
        `${workerBaseUrl}/api/v1/manage/events/${eventId}/export-token`,
        { method: 'POST', headers: authHeaders },
      );
      const data = (await res.json()) as { url?: string; expiresAt?: string; message?: string };
      if (!res.ok || !data.url) {
        setExportError(data.message ?? `Could not prepare the export (${res.status}).`);
        return;
      }
      setExportLink({ url: data.url, expiresAt: data.expiresAt ?? '' });
    } catch (err) {
      setExportError(String(err));
    } finally {
      setExportBusy(false);
    }
  }

  /**
   * Every note on the event in one call. Fetching per attendee would be a request per row
   * for data that is almost always a handful of rows in total.
   */
  async function loadStaffNotes(eventId: string) {
    try {
      const res = await hubspot.fetch(`${workerBaseUrl}/api/v1/manage/events/${eventId}/notes`, {
        headers: authHeaders,
      });
      if (res.ok) setStaffNotes((await res.json()) as StaffNote[]);
    } catch {
      // secondary — don't surface separately
    }
  }

  /**
   * The thread for one attendee: notes written against the registration, plus notes on the
   * order behind it. A note typed on the manual-booking form is order-scoped, and it would
   * be invisible here if the two were not shown together.
   */
  function notesForRegistration(reg: Registration): StaffNote[] {
    return staffNotes.filter(
      (n) => n.registration_id === reg.id || (n.order_id !== null && n.order_id === reg.order_id),
    );
  }

  async function submitStaffNote(eventId: string, registrationId: string) {
    setNoteError(null);
    setNoteSaving(true);
    try {
      const res = await hubspot.fetch(
        `${workerBaseUrl}/api/v1/manage/events/${eventId}/registrations/${registrationId}/notes`,
        {
          method: 'POST',
          headers: authHeaders,
          body: { body: noteDraft, ...(userId ? { author: userId } : {}) },
        },
      );
      if (!res.ok) {
        setNoteError(`Could not save the note (${res.status}): ${await res.text()}`);
        return;
      }
      setNoteDraft('');
      await loadStaffNotes(eventId);
    } catch (err) {
      setNoteError(String(err));
    } finally {
      setNoteSaving(false);
    }
  }

  async function handleManualRegistration() {
    if (!event) return;
    setManualSaving(true);
    setManualError(null);
    setManualResult(null);
    try {
      const idempotencyKey = `staff-add-${event.id}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`;
      const res = await hubspot.fetch(
        `${workerBaseUrl}/api/v1/manage/events/${event.id}/registrations`,
        {
          method: 'POST',
          headers: { ...authHeaders, 'Idempotency-Key': idempotencyKey },
          body: {
            mode: manualMode,
            ticketTypeId: manualTicketTypeId,
            attendeeName: manualAttendeeName,
            attendeeEmail: manualAttendeeEmail,
            hubspotContactId: manualContactId || null,
            memberCompanyId: manualMemberCompanyId || null,
            buyerName: manualBuyerName || manualAttendeeName,
            buyerEmail: manualBuyerEmail || manualAttendeeEmail,
            invoiceDueDate: manualMode === 'paid' ? manualInvoiceDueDate : null,
            staffNote: manualStaffNote || null,
          },
        },
      );
      const data = (await res.json()) as ManualRegistrationResult;
      if (!res.ok || data.ok === false) {
        setManualError(`Add attendee failed: ${data.message ?? data.status ?? res.status}`);
      } else {
        setManualResult(data);
        setManualAttendeeName('');
        setManualAttendeeEmail('');
        setManualContactId('');
        setManualMemberCompanyId('');
        setManualBuyerName('');
        setManualBuyerEmail('');
        setManualStaffNote('');
        await loadRegistrations(event.id);
        await loadPendingDecisions(event.id);
      }
    } catch (err) {
      setManualError(String(err));
    } finally {
      setManualSaving(false);
    }
  }

  async function refreshManualPaymentLink(orderId: string) {
    if (!orderId) return;
    setManualError(null);
    try {
      const res = await hubspot.fetch(`${workerBaseUrl}/api/v1/orders/${orderId}`, {
        headers: authHeaders,
      });
      const data = (await res.json()) as { paymentUrl?: string | null; status?: string };
      if (!res.ok) {
        setManualError(`Payment link refresh failed: ${data.status ?? res.status}`);
        return;
      }
      setManualResult((prev) =>
        prev
          ? {
              ...prev,
              status: data.status ?? prev.status,
              paymentUrl: data.paymentUrl ?? null,
            }
          : prev,
      );
    } catch (err) {
      setManualError(String(err));
    }
  }

  async function loadRefundPolicies() {
    try {
      const res = await hubspot.fetch(`${workerBaseUrl}/api/v1/manage/refund-policies`, {
        headers: authHeaders,
      });
      if (res.ok) setRefundPolicies((await res.json()) as RefundPolicy[]);
    } catch {
      // secondary
    }
  }

  async function handleRefund(regId: string) {
    if (!event) return;
    setActionError(null);
    setActionMsg(null);
    try {
      const res = await hubspot.fetch(
        `${workerBaseUrl}/api/v1/manage/events/${event.id}/registrations/${regId}/refund`,
        { method: 'POST', headers: authHeaders, body: {} },
      );
      const data = (await res.json()) as {
        ok: boolean;
        reason?: string;
        outcome?: { kind: string; amountCents: number };
      };
      if (!res.ok || !data.ok || !data.outcome) {
        setActionError(`Refund failed: ${data.reason ?? res.status}`);
      } else {
        const o = data.outcome;
        setActionMsg(`Refund ${o.kind}: $${centsToDisplay(o.amountCents)}`);
        await loadRegistrations(event.id);
      }
    } catch (err) {
      setActionError(String(err));
    }
  }

  async function handleTransfer() {
    if (!event || !transferRegId) return;
    setActionError(null);
    setActionMsg(null);
    try {
      const res = await hubspot.fetch(
        `${workerBaseUrl}/api/v1/manage/events/${event.id}/registrations/${transferRegId}/transfer`,
        {
          method: 'POST',
          headers: authHeaders,
          body: { toEmail: transferEmail, toName: transferName },
        },
      );
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setActionError(`Transfer failed: ${data.error ?? res.status}`);
      } else {
        setActionMsg(`Transferred to ${transferEmail}`);
        setTransferRegId(null);
        setTransferEmail('');
        setTransferName('');
        await loadRegistrations(event.id);
      }
    } catch (err) {
      setActionError(String(err));
    }
  }

  function openAssignSeat(registrationId: string) {
    setActionError(null);
    setActionMsg(null);
    setAssignName('');
    setAssignEmail('');
    setAssignRegId(assignRegId === registrationId ? null : registrationId);
  }

  /**
   * Hold and invoice N seats for a company before the names are known.
   *
   * Not a reservation of a different kind: the worker prices, holds and invoices it exactly
   * as any other booking, so the seats leave public availability immediately and the company
   * is invoiced now. What is deferred is only who sits in them.
   */
  async function handleCreateSeatBlock() {
    if (!event) return;
    setBlockSaving(true);
    setActionError(null);
    setActionMsg(null);
    try {
      const res = await hubspot.fetch(
        `${workerBaseUrl}/api/v1/manage/events/${event.id}/seat-blocks`,
        {
          method: 'POST',
          headers: { ...authHeaders, 'Idempotency-Key': `block-${event.id}-${Date.now()}` },
          body: {
            ticketTypeId: blockTicketTypeId,
            seats: blockSeats,
            buyerName: blockBuyerName,
            buyerEmail: blockBuyerEmail,
            ...(blockCompanyId ? { memberCompanyId: blockCompanyId } : {}),
          },
        },
      );
      const data = (await res.json()) as { ok?: boolean; status?: string; message?: string };
      if (!res.ok || data.status === undefined || data.ok === false) {
        setActionError(`Could not hold the seats: ${data.message ?? data.status ?? res.status}`);
      } else {
        setActionMsg(`Held ${blockSeats} seat(s) for ${blockBuyerName} and raised the invoice.`);
        setBlockSeats(0);
        setBlockBuyerName('');
        setBlockBuyerEmail('');
        setBlockCompanyId('');
        await loadRegistrations(event.id);
      }
    } catch (err) {
      setActionError(String(err));
    } finally {
      setBlockSaving(false);
    }
  }

  /** Put a person on a held seat. The ordinary amend — same seat, same price, same order. */
  async function handleAssignSeat() {
    if (!event || !assignRegId) return;
    setActionError(null);
    setActionMsg(null);
    try {
      const res = await hubspot.fetch(
        `${workerBaseUrl}/api/v1/manage/events/${event.id}/registrations/${assignRegId}`,
        { method: 'PATCH', headers: authHeaders, body: { name: assignName, email: assignEmail } },
      );
      const data = (await res.json()) as { ok?: boolean; error?: string; message?: string };
      if (!res.ok || data.ok === false) {
        setActionError(`Could not assign the seat: ${data.message ?? data.error ?? res.status}`);
      } else {
        setActionMsg(`Seat assigned to ${assignEmail}`);
        setAssignRegId(null);
        setAssignName('');
        setAssignEmail('');
        await loadRegistrations(event.id);
      }
    } catch (err) {
      setActionError(String(err));
    }
  }

  async function handleAddRefundPolicy() {
    setActionError(null);
    try {
      const res = await hubspot.fetch(`${workerBaseUrl}/api/v1/manage/refund-policies`, {
        method: 'POST',
        headers: authHeaders,
        body: {
          name: rpName,
          isDefault: rpIsDefault,
          category: rpCategory || null,
          fullRefundCutoffDays: rpCutoff,
          partialRefundPercent: rpPartial > 0 ? rpPartial : null,
          allowTransfer: rpAllowTransfer,
        },
      });
      if (res.ok) {
        setRpName('');
        setRpCategory('');
        setRpPartial(0);
        await loadRefundPolicies();
      } else {
        setActionError(`Add policy failed: ${res.status}`);
      }
    } catch (err) {
      setActionError(String(err));
    }
  }

  async function loadPendingDecisions(eventId: string) {
    try {
      const res = await hubspot.fetch(
        `${workerBaseUrl}/api/v1/manage/events/${eventId}/pending-decisions`,
        { headers: authHeaders },
      );
      if (res.ok) setPendingDecisions((await res.json()) as PendingDecision[]);
    } catch {
      // secondary
    }
  }

  function toggleWaitlistPick(decisionId: string, waitlistId: string) {
    setDecisionSelections((prev) => {
      const cur = prev[decisionId] ?? [];
      const next = cur.includes(waitlistId)
        ? cur.filter((x) => x !== waitlistId)
        : [...cur, waitlistId];
      return { ...prev, [decisionId]: next };
    });
  }

  async function resolveDecisionAction(
    decisionId: string,
    payload: { action?: string; waitlistIds?: string[] },
  ) {
    if (!event) return;
    setActionError(null);
    setActionMsg(null);
    try {
      const res = await hubspot.fetch(
        `${workerBaseUrl}/api/v1/manage/decisions/${decisionId}/resolve`,
        { method: 'POST', headers: authHeaders, body: payload },
      );
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setActionError(`Resolve failed: ${data.error ?? res.status}`);
      } else {
        setActionMsg('Decision resolved');
        await loadPendingDecisions(event.id);
        await loadRegistrations(event.id);
      }
    } catch (err) {
      setActionError(String(err));
    }
  }

  // Mount-only: loadEvent closes over stable card props for this record tab.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional mount-only load
  useEffect(() => {
    loadEvent();
  }, []);

  // Loading state
  if (event === undefined) {
    return <LoadingSpinner label="Loading event…" />;
  }

  async function handleCreate() {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await hubspot.fetch(`${workerBaseUrl}/api/v1/manage/events`, {
        method: 'POST',
        headers: authHeaders,
        body: {
          hubspotEventId,
          title: createTitle,
          startsAt: createStartsAt,
          endsAt: createEndsAt,
          capacity: createCapacity,
          capacityUnlimited: createUnlimited,
          location: createLocation || undefined,
          provider: createProvider === 'none' ? undefined : createProvider,
        },
      });
      if (!res.ok) {
        const body = await res.text();
        setSaveError(`Create failed (${res.status}): ${body}`);
      } else {
        await loadEvent();
      }
    } catch (err) {
      setSaveError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleSave() {
    if (!event) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await hubspot.fetch(`${workerBaseUrl}/api/v1/manage/events/${event.id}`, {
        method: 'PATCH',
        headers: authHeaders,
        body: {
          capacity: editCapacity,
          capacityUnlimited: editUnlimited,
          provider: editProvider === 'none' ? null : editProvider,
          category: editCategory || null,
          refundPolicyId: editRefundPolicyId || null,
          hubspotOwnerId: editOwnerId || null,
          invoiceDueDays: editInvoiceDueDays.trim() === '' ? null : Number(editInvoiceDueDays),
          // Blank clears it back to "closes when the event starts". A bare date is read as
          // the end of that day in the portal's timezone, which is what "close on the
          // 20th" means to the person typing it.
          registrationClosesAt: editClosesAt.trim() === '' ? null : editClosesAt.trim(),
        },
      });
      if (!res.ok) {
        const body = await res.text();
        setSaveError(`Save failed (${res.status}): ${body}`);
      } else {
        const updated = (await res.json()) as WorkerEvent;
        setEvent(updated);
      }
    } catch (err) {
      setSaveError(String(err));
    } finally {
      setSaving(false);
    }
  }

  /**
   * Stop or resume selling, on its own, without the rest of the edit form.
   *
   * Capacity is deliberately untouched: zeroing it is what Phase 1.1 refuses, and what
   * would make every already-confirmed seat read as oversold against a total of zero.
   * Nothing here cancels a booking either — holds run to their own expiry and confirmed
   * seats stay confirmed.
   */
  async function handleTogglePause(next: boolean) {
    if (!event) return;
    setPauseSaving(true);
    setSaveError(null);
    try {
      const res = await hubspot.fetch(`${workerBaseUrl}/api/v1/manage/events/${event.id}`, {
        method: 'PATCH',
        headers: authHeaders,
        body: { salesPaused: next },
      });
      if (!res.ok) {
        setSaveError(
          `Could not ${next ? 'pause' : 'resume'} sales (${res.status}): ${await res.text()}`,
        );
        return;
      }
      setEvent((await res.json()) as WorkerEvent);
      setEditSalesPaused(next);
    } catch (err) {
      setSaveError(String(err));
    } finally {
      setPauseSaving(false);
    }
  }

  /** The same stop, for one ticket type — "early bird is over" without closing the event. */
  async function handleToggleTicketTypePause(ticketType: TicketType, next: boolean) {
    if (!event) return;
    setTtPauseSaving(ticketType.id);
    setTtError(null);
    try {
      const res = await hubspot.fetch(
        `${workerBaseUrl}/api/v1/manage/events/${event.id}/ticket-types/${ticketType.id}`,
        { method: 'PATCH', headers: authHeaders, body: { salesPaused: next } },
      );
      if (!res.ok) {
        setTtError(`Could not update "${ticketType.name}" (${res.status}): ${await res.text()}`);
        return;
      }
      await loadTicketTypes(event.id);
    } catch (err) {
      setTtError(String(err));
    } finally {
      setTtPauseSaving(null);
    }
  }

  /**
   * Per-ticket-type capacity, the other half of the event-level edit above.
   *
   * capacity and capacityUnlimited go together on purpose: parseCapacity validates the
   * RESULTING state, so a PATCH carrying only `capacity` resolves unlimited to false and
   * would quietly cap a type that was deliberately uncapped.
   *
   * The DO picks the new inventory up through syncCapacityFromD1 on the next reserve or
   * availability read, so there is nothing to push from here.
   */
  async function handleSaveTicketTypeCapacity(ticketType: TicketType) {
    if (!event) return;
    const draft = ttCapacityEdits[ticketType.id];
    if (!draft) return;
    setTtCapacitySaving(ticketType.id);
    setTtError(null);
    try {
      const res = await hubspot.fetch(
        `${workerBaseUrl}/api/v1/manage/events/${event.id}/ticket-types/${ticketType.id}`,
        {
          method: 'PATCH',
          headers: authHeaders,
          body: { capacity: draft.capacity, capacityUnlimited: draft.unlimited },
        },
      );
      if (!res.ok) {
        // Surfaced as the worker wrote it rather than pre-judged here: the capacity rule
        // lives in parseCapacity, and a copy of it in this card would drift from it.
        setTtError(`Could not update "${ticketType.name}" (${res.status}): ${await res.text()}`);
        return;
      }
      setTtCapacityEdits((prev) => {
        const next = { ...prev };
        delete next[ticketType.id];
        return next;
      });
      await loadTicketTypes(event.id);
    } catch (err) {
      setTtError(String(err));
    } finally {
      setTtCapacitySaving(null);
    }
  }

  async function handleAddTicketType() {
    if (!event) return;
    setTtSaving(true);
    setTtError(null);
    try {
      const res = await hubspot.fetch(
        `${workerBaseUrl}/api/v1/manage/events/${event.id}/ticket-types`,
        {
          method: 'POST',
          headers: authHeaders,
          body: {
            name: ttName,
            priceCents: displayToCents(ttPriceDisplay),
            capacity: ttCapacity,
            capacityUnlimited: ttUnlimited,
            taxTreatment: ttTaxTreatment,
            memberOnly: ttMemberOnly,
            sortOrder: ttSortOrder,
          },
        },
      );
      if (!res.ok) {
        const body = await res.text();
        setTtError(`Add failed (${res.status}): ${body}`);
      } else {
        setTtName('');
        setTtPriceDisplay('0.00');
        setTtCapacity(0);
        setTtTaxTreatment('gst');
        setTtMemberOnly(false);
        setTtSortOrder(0);
        await loadTicketTypes(event.id);
      }
    } catch (err) {
      setTtError(String(err));
    } finally {
      setTtSaving(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Create form — shown when no worker event exists yet
  // ---------------------------------------------------------------------------

  if (!event) {
    return (
      <Box>
        {loadError && (
          <Alert title="Load error" variant="error">
            {loadError}
          </Alert>
        )}
        <Text format={{ fontWeight: 'bold' }}>Register this event in the worker</Text>
        <Text variant="microcopy">Creates the capacity record. Fill in the details below.</Text>
        <Form>
          <Input label="Title" name="title" value={createTitle} onChange={setCreateTitle} />
          <Input
            label="Starts at (ISO 8601 UTC)"
            name="startsAt"
            placeholder="2025-09-15T09:00:00Z"
            value={createStartsAt}
            onChange={setCreateStartsAt}
          />
          <Input
            label="Ends at (ISO 8601 UTC)"
            name="endsAt"
            placeholder="2025-09-15T17:00:00Z"
            value={createEndsAt}
            onChange={setCreateEndsAt}
          />
          <NumberInput
            label="Total capacity (seats)"
            name="capacity"
            value={createCapacity}
            onChange={setCreateCapacity}
          />
          <ToggleGroup
            label="Seat limit"
            name="createUnlimited"
            toggleType="radioButtonList"
            options={[
              { label: 'Limited to the capacity above', value: 'false' },
              { label: 'No seat limit', value: 'true' },
            ]}
            value={createUnlimited ? 'true' : 'false'}
            onChange={(v: string) => setCreateUnlimited(v === 'true')}
          />
          <Input
            label="Location (optional)"
            name="location"
            value={createLocation}
            onChange={setCreateLocation}
          />
          <Select
            label="Webinar provider"
            name="provider"
            value={createProvider}
            onChange={(v) => setCreateProvider(String(v))}
            options={PROVIDER_OPTIONS}
          />
        </Form>
        {saveError && (
          <Alert title="Error" variant="error">
            {saveError}
          </Alert>
        )}
        <Button onClick={handleCreate} disabled={saving} variant="primary">
          {saving ? 'Creating…' : 'Create event in worker'}
        </Button>
      </Box>
    );
  }

  // ---------------------------------------------------------------------------
  // Edit form — worker event exists
  // ---------------------------------------------------------------------------

  return (
    <Box>
      <Flex direction="column" gap="small">
        <Text format={{ fontWeight: 'bold' }}>{event.title}</Text>
        <Text variant="microcopy">Worker ID: {event.id}</Text>

        {pendingDecisions.length > 0 && (
          <Box>
            <Divider />
            <Alert title="Pending decisions" variant="warning">
              {pendingDecisions.length} item(s) need your decision.
            </Alert>
            {pendingDecisions.map((d) => (
              <Box key={d.id}>
                {d.type === 'fast_sellout' ? (
                  <Flex direction="column" gap="extra-small">
                    <Text format={{ fontWeight: 'bold' }}>
                      Check capacity — sold out in {d.context?.minutesToSellOut ?? 0} minute(s)
                    </Text>
                    <Text variant="microcopy">
                      This event sold out almost immediately on a capacity of{' '}
                      {d.context?.capacity ?? 0} seat(s), which usually means the number is still a
                      setup placeholder. Raise the capacity below if it is wrong, or acknowledge
                      this if the event really is full.
                    </Text>
                    <Button
                      variant="primary"
                      onClick={() => resolveDecisionAction(d.id, { action: 'acknowledge' })}
                    >
                      Capacity is correct
                    </Button>
                  </Flex>
                ) : d.type === 'contact_conflict' ? (
                  <Flex direction="column" gap="extra-small">
                    <Text format={{ fontWeight: 'bold' }}>
                      Contact details differ — {d.context?.attendeeEmail ?? 'attendee'}
                    </Text>
                    <Text variant="microcopy">
                      Nothing has been overwritten. HubSpot still holds its own value for each field
                      below.
                    </Text>
                    {(d.context?.conflicts ?? []).map((conflict) => (
                      <Text key={conflict.property} variant="microcopy">
                        {conflict.field}: HubSpot has "{conflict.existing}", the booking said "
                        {conflict.captured}"
                      </Text>
                    ))}
                    <Flex gap="small">
                      <Button
                        variant="primary"
                        onClick={() => resolveDecisionAction(d.id, { action: 'keep' })}
                      >
                        Keep HubSpot value
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => resolveDecisionAction(d.id, { action: 'overwrite' })}
                      >
                        Use the booking's value
                      </Button>
                    </Flex>
                  </Flex>
                ) : d.type === 'unpaid_invoice' ? (
                  <Flex direction="column" gap="extra-small">
                    <Text format={{ fontWeight: 'bold' }}>
                      Unpaid invoice — the seat hold has lapsed
                    </Text>
                    <Text variant="microcopy">
                      ${centsToDisplay(d.context?.totalCents ?? 0)} is still outstanding and the
                      seats have gone back on sale. Nothing has been voided: this portal decides
                      that by hand. Voiding cannot be undone in HubSpot, so leave it payable if you
                      are still chasing the customer.
                    </Text>
                    <Flex gap="small">
                      <Button onClick={() => resolveDecisionAction(d.id, { action: 'keep' })}>
                        Leave it payable
                      </Button>
                      <Button
                        variant="destructive"
                        onClick={() => resolveDecisionAction(d.id, { action: 'void' })}
                      >
                        Void the invoice
                      </Button>
                    </Flex>
                  </Flex>
                ) : d.type === 'oversell' ? (
                  <Flex direction="column" gap="extra-small">
                    <Text format={{ fontWeight: 'bold' }}>
                      Oversell — late payment after sell-out
                    </Text>
                    <Text variant="microcopy">
                      {d.context?.buyerEmail ?? 'Buyer'} paid $
                      {centsToDisplay(d.context?.totalCents ?? 0)}. Honour (issue a ticket anyway)
                      or refund per policy?
                    </Text>
                    <Flex gap="small">
                      <Button
                        variant="primary"
                        onClick={() => resolveDecisionAction(d.id, { action: 'honour' })}
                      >
                        Honour
                      </Button>
                      <Button
                        variant="destructive"
                        onClick={() => resolveDecisionAction(d.id, { action: 'refund' })}
                      >
                        Refund
                      </Button>
                    </Flex>
                  </Flex>
                ) : (
                  <Flex direction="column" gap="extra-small">
                    <Text format={{ fontWeight: 'bold' }}>
                      Waitlist — {d.context?.freedSeats ?? 0} seat(s) freed
                    </Text>
                    <Text variant="microcopy">Pick who to offer the freed seat(s) to:</Text>
                    {(d.context?.waitlist ?? []).map((w) => {
                      const picked = (decisionSelections[d.id] ?? []).includes(w.id);
                      return (
                        <Button
                          key={w.id}
                          variant={picked ? 'primary' : 'secondary'}
                          onClick={() => toggleWaitlistPick(d.id, w.id)}
                        >
                          {picked ? '✓ ' : ''}#{w.position} {w.email} (x{w.quantity})
                        </Button>
                      );
                    })}
                    <Button
                      variant="primary"
                      disabled={(decisionSelections[d.id] ?? []).length === 0}
                      onClick={() =>
                        resolveDecisionAction(d.id, {
                          waitlistIds: decisionSelections[d.id] ?? [],
                        })
                      }
                    >
                      Offer to selected
                    </Button>
                  </Flex>
                )}
              </Box>
            ))}
          </Box>
        )}

        <Divider />

        <Text format={{ fontWeight: 'bold' }}>Selling</Text>
        <Flex direction="row" gap="small" align="center" wrap="wrap">
          {editSalesPaused ? (
            <Tag variant="error">Sales paused</Tag>
          ) : (
            <Tag variant="success">On sale</Tag>
          )}
          <Button
            variant={editSalesPaused ? 'primary' : 'destructive'}
            disabled={pauseSaving}
            onClick={() => handleTogglePause(!editSalesPaused)}
          >
            {pauseSaving ? 'Saving…' : editSalesPaused ? 'Resume sales' : 'Stop selling now'}
          </Button>
        </Flex>
        <Text variant="microcopy">
          Stopping sales takes the event off the website immediately. It does not change the
          capacity, cancel anything, or shorten a hold: seats already booked stay booked and an
          unpaid invoice stays payable. Staff can still book someone in from this card while sales
          are paused.
        </Text>

        <Form>
          <Input
            label="Registrations close (blank = when the event starts)"
            name="registrationClosesAt"
            value={editClosesAt}
            onChange={setEditClosesAt}
          />
          <Text variant="microcopy">
            A date (2026-09-20) closes at the end of that day in your portal's timezone. A full
            timestamp (2026-09-20T09:00:00Z) closes at that moment. Leave it blank and the website
            stops taking bookings when the event starts — set a date to close earlier for catering
            numbers, or a time after the start to keep a walk-up window open.
          </Text>
        </Form>

        <Divider />

        <Form>
          <NumberInput
            label="Total capacity (seats)"
            name="capacity"
            value={editCapacity}
            onChange={setEditCapacity}
          />
          <ToggleGroup
            label="Seat limit"
            name="editUnlimited"
            toggleType="radioButtonList"
            options={[
              { label: 'Limited to the capacity above', value: 'false' },
              { label: 'No seat limit', value: 'true' },
            ]}
            value={editUnlimited ? 'true' : 'false'}
            onChange={(v: string) => setEditUnlimited(v === 'true')}
          />
          <Select
            label="Webinar provider"
            name="provider"
            value={editProvider}
            onChange={(v) => setEditProvider(String(v))}
            options={PROVIDER_OPTIONS}
          />
          <Input
            label="Event category (for refund default templates)"
            name="category"
            value={editCategory}
            onChange={setEditCategory}
          />
          <Input
            label="Event owner (HubSpot owner id — gets oversell/waitlist tasks)"
            name="hubspotOwnerId"
            value={editOwnerId}
            onChange={setEditOwnerId}
          />
          <Input
            label="Payment terms (days) — blank uses the portal default"
            name="invoiceDueDays"
            value={editInvoiceDueDays}
            onChange={setEditInvoiceDueDays}
          />
          <Text variant="microcopy">
            How long a paid booking keeps its seat and its payment link, and the due date on the
            HubSpot invoice. Applies to public website, corporate portal and staff paid bookings on
            this event. Blank uses the portal default (30 days); maximum 90.
          </Text>
          <Select
            label="Refund policy"
            name="refundPolicyId"
            value={editRefundPolicyId}
            onChange={(v) => setEditRefundPolicyId(String(v ?? ''))}
            options={[
              { label: 'Use default (category / portal)', value: '' },
              ...refundPolicies.map((rp) => ({ label: rp.name, value: rp.id })),
            ]}
          />
        </Form>

        {saveError && (
          <Alert title="Save error" variant="error">
            {saveError}
          </Alert>
        )}

        <Button onClick={handleSave} disabled={saving} variant="primary">
          {saving ? 'Saving…' : 'Save changes'}
        </Button>

        <Divider />

        <Text format={{ fontWeight: 'bold' }}>Ticket types</Text>

        {ticketTypes.length > 0 && (
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Price (AUD)</TableCell>
                <TableCell>Capacity</TableCell>
                <TableCell>GST</TableCell>
                <TableCell>Members only</TableCell>
                <TableCell>Selling</TableCell>
                <TableCell>Capacity update</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {ticketTypes.map((tt) => (
                <TableRow key={tt.id}>
                  <TableCell>{tt.name}</TableCell>
                  <TableCell>${centsToDisplay(tt.price_cents)}</TableCell>
                  <TableCell>
                    <NumberInput
                      label=""
                      name={`ttCapacity-${tt.id}`}
                      value={ttCapacityEdits[tt.id]?.capacity ?? tt.capacity}
                      onChange={(v: number) =>
                        setTtCapacityEdits((prev) => ({
                          ...prev,
                          [tt.id]: {
                            capacity: v ?? 0,
                            unlimited: prev[tt.id]?.unlimited ?? !!tt.capacity_unlimited,
                          },
                        }))
                      }
                    />
                    <ToggleGroup
                      label="Seat limit"
                      name={`ttUnlimited-${tt.id}`}
                      toggleType="radioButtonList"
                      options={[
                        { label: 'Limited to the seats above', value: 'false' },
                        { label: 'No seat limit', value: 'true' },
                      ]}
                      value={
                        (ttCapacityEdits[tt.id]?.unlimited ?? !!tt.capacity_unlimited)
                          ? 'true'
                          : 'false'
                      }
                      onChange={(v: string) =>
                        setTtCapacityEdits((prev) => ({
                          ...prev,
                          [tt.id]: {
                            capacity: prev[tt.id]?.capacity ?? tt.capacity,
                            unlimited: v === 'true',
                          },
                        }))
                      }
                    />
                  </TableCell>
                  <TableCell>
                    {tt.tax_treatment === 'gst_free' ? (
                      <Tag variant="default">GST-free</Tag>
                    ) : (
                      <Tag variant="success">GST incl.</Tag>
                    )}
                  </TableCell>
                  <TableCell>
                    {tt.member_only ? <Tag variant="warning">Members only</Tag> : <Tag>Open</Tag>}
                  </TableCell>
                  <TableCell>
                    <Button
                      disabled={ttPauseSaving === tt.id}
                      onClick={() => handleToggleTicketTypePause(tt, !tt.sales_paused)}
                    >
                      {ttPauseSaving === tt.id
                        ? 'Saving…'
                        : tt.sales_paused
                          ? 'Paused — resume'
                          : 'On sale — pause'}
                    </Button>
                  </TableCell>
                  <TableCell>
                    <Button
                      disabled={
                        ttCapacitySaving === tt.id ||
                        !ttCapacityEdits[tt.id] ||
                        (ttCapacityEdits[tt.id].capacity === tt.capacity &&
                          ttCapacityEdits[tt.id].unlimited === !!tt.capacity_unlimited)
                      }
                      onClick={() => handleSaveTicketTypeCapacity(tt)}
                    >
                      {ttCapacitySaving === tt.id ? 'Saving…' : 'Save capacity'}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        <Text format={{ fontWeight: 'bold' }} variant="microcopy">
          Add ticket type
        </Text>
        <Form>
          <Input label="Name" name="ttName" value={ttName} onChange={setTtName} />
          <Input
            label="Price (AUD, e.g. 49.00)"
            name="ttPrice"
            value={ttPriceDisplay}
            onChange={setTtPriceDisplay}
          />
          <NumberInput
            label="Capacity"
            name="ttCapacity"
            value={ttCapacity}
            onChange={setTtCapacity}
          />
          <ToggleGroup
            label="Seat limit"
            name="ttUnlimited"
            toggleType="radioButtonList"
            options={[
              { label: 'Limited to the capacity above', value: 'false' },
              { label: 'No seat limit', value: 'true' },
            ]}
            value={ttUnlimited ? 'true' : 'false'}
            onChange={(v: string) => setTtUnlimited(v === 'true')}
          />
          <ToggleGroup
            label="GST treatment"
            name="ttTaxTreatment"
            toggleType="radioButtonList"
            options={[
              { label: 'GST included (10%)', value: 'gst' },
              { label: 'GST-free', value: 'gst_free' },
            ]}
            value={ttTaxTreatment}
            onChange={(v: string) => setTtTaxTreatment(v ?? 'gst')}
          />
          <ToggleGroup
            label="Availability"
            name="ttMemberOnly"
            toggleType="radioButtonList"
            options={[
              { label: 'Open', value: 'false' },
              { label: 'Members only', value: 'true' },
            ]}
            value={ttMemberOnly ? 'true' : 'false'}
            onChange={(v: string) => setTtMemberOnly(v === 'true')}
          />
          <NumberInput
            label="Sort order"
            name="ttSortOrder"
            value={ttSortOrder}
            onChange={setTtSortOrder}
          />
        </Form>
        {ttError && (
          <Alert title="Error" variant="error">
            {ttError}
          </Alert>
        )}
        <Button onClick={handleAddTicketType} disabled={ttSaving}>
          {ttSaving ? 'Adding…' : 'Add ticket type'}
        </Button>

        <Divider />

        <Text format={{ fontWeight: 'bold' }}>Member discount rules</Text>
        <Text variant="microcopy">
          Tiered discounts by membership level + category. Most-specific wins (ticket type &gt;
          event &gt; portal). Non-members always pay the standard price.
        </Text>

        {pricingRules.length > 0 && (
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Scope</TableCell>
                <TableCell>Level</TableCell>
                <TableCell>Category</TableCell>
                <TableCell>Discount</TableCell>
                <TableCell>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {pricingRules.map((pr) => (
                <TableRow key={pr.id}>
                  <TableCell>{pr.scope}</TableCell>
                  <TableCell>{pr.member_level}</TableCell>
                  <TableCell>{pr.member_category}</TableCell>
                  <TableCell>
                    {pr.fixed_price_cents != null
                      ? `$${centsToDisplay(pr.fixed_price_cents)} fixed`
                      : `${pr.discount_percent}% off`}
                  </TableCell>
                  <TableCell>
                    <Button variant="destructive" onClick={() => handleDeletePricingRule(pr.id)}>
                      Remove
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        <Text format={{ fontWeight: 'bold' }} variant="microcopy">
          Add discount rule
        </Text>
        <Form>
          <Input
            label="Membership level (e.g. standard, premium, fellow)"
            name="prLevel"
            value={prLevel}
            onChange={setPrLevel}
          />
          <Select
            label="Membership category"
            name="prCategory"
            value={prCategory}
            onChange={(v) => setPrCategory(String(v))}
            options={[
              { label: 'Corporate', value: 'corporate' },
              { label: 'Industry supplier', value: 'industry_supplier' },
              { label: 'Individual', value: 'individual' },
            ]}
          />
          <ToggleGroup
            label="Discount type"
            name="prMode"
            toggleType="radioButtonList"
            options={[
              { label: 'Percent off', value: 'percent' },
              { label: 'Fixed price', value: 'fixed' },
            ]}
            value={prMode}
            onChange={(v: string) => setPrMode(v ?? 'percent')}
          />
          {prMode === 'percent' ? (
            <NumberInput
              label="Discount percent (0–100)"
              name="prPercent"
              value={prPercent}
              onChange={setPrPercent}
            />
          ) : (
            <Input
              label="Fixed member price (AUD, e.g. 39.00)"
              name="prFixed"
              value={prFixedDisplay}
              onChange={setPrFixedDisplay}
            />
          )}
        </Form>
        {prError && (
          <Alert title="Error" variant="error">
            {prError}
          </Alert>
        )}
        <Button onClick={handleAddPricingRule} disabled={prSaving || !prLevel}>
          {prSaving ? 'Adding…' : 'Add discount rule'}
        </Button>

        <Divider />

        <Text format={{ fontWeight: 'bold' }}>Registration questions</Text>
        <Text variant="microcopy">
          What the booking form asks, beyond name and email. Dietary requirements is one of these
          rows, not a built-in field, so a coffee order or a PO number is a question you add here.
          Answers appear on the attendee list and in the CSV export. A question asked on every event
          can be replaced for this one by adding another with the same key.
        </Text>

        {questions.length > 0 && (
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Question</TableCell>
                <TableCell>Key</TableCell>
                <TableCell>Type</TableCell>
                <TableCell>Asked</TableCell>
                <TableCell>Applies to</TableCell>
                <TableCell>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {questions.map((question) => (
                <TableRow key={question.id}>
                  <TableCell>
                    {question.label}
                    {question.required ? <Tag variant="warning">Required</Tag> : null}
                  </TableCell>
                  <TableCell>{question.key}</TableCell>
                  <TableCell>{question.fieldType}</TableCell>
                  <TableCell>
                    {question.scope === 'order' ? 'Once per booking' : 'Per attendee'}
                  </TableCell>
                  <TableCell>
                    {question.eventId ? 'This event' : 'Every event'}
                    {question.hsProperty ? ` · ${question.hsProperty}` : ''}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="destructive"
                      onClick={() => handleArchiveQuestion(question.id)}
                    >
                      {question.eventId ? 'Stop asking' : 'Stop asking everywhere'}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        <Text variant="microcopy">
          Retiring a question archives it: it stops being asked, and every answer already given
          stays on the attendee list and in past exports. A question marked "Every event" belongs to
          the whole portal, so retiring it here stops it being asked on every event.
        </Text>

        <Text format={{ fontWeight: 'bold' }} variant="microcopy">
          Add a question
        </Text>
        <Form>
          <Input
            label="Question (shown to the buyer)"
            name="qLabel"
            value={qLabel}
            onChange={setQLabel}
          />
          <Input
            label="Key (lowercase, e.g. dietary_requirements)"
            description="Names the answer in exports and cannot be changed later."
            name="qKey"
            value={qKey}
            onChange={setQKey}
          />
          <Select
            label="Answer type"
            name="qFieldType"
            value={qFieldType}
            onChange={(v) => setQFieldType(String(v ?? 'text'))}
            options={[
              { label: 'Short text', value: 'text' },
              { label: 'Long text', value: 'textarea' },
              { label: 'Choose one', value: 'select' },
              { label: 'Choose any', value: 'multiselect' },
              { label: 'Yes / no', value: 'checkbox' },
              { label: 'Phone number', value: 'phone' },
            ]}
          />
          {(qFieldType === 'select' || qFieldType === 'multiselect') && (
            <Input
              label="Options, separated by commas"
              name="qOptions"
              value={qOptions}
              onChange={setQOptions}
            />
          )}
          <ToggleGroup
            label="Asked"
            name="qScope"
            toggleType="radioButtonList"
            options={[
              { label: 'Of each attendee (dietary requirements)', value: 'attendee' },
              { label: 'Once per booking (a PO number)', value: 'order' },
            ]}
            value={qScope}
            onChange={(v: string) => setQScope(v ?? 'attendee')}
          />
          <ToggleGroup
            label="Answer required"
            name="qRequired"
            toggleType="radioButtonList"
            options={[
              { label: 'Optional', value: 'false' },
              { label: 'Required', value: 'true' },
            ]}
            value={qRequired ? 'true' : 'false'}
            onChange={(v: string) => setQRequired(v === 'true')}
          />
          <ToggleGroup
            label="Applies to"
            name="qLevel"
            toggleType="radioButtonList"
            options={[
              { label: 'This event only', value: 'event' },
              { label: 'Every event', value: 'portal' },
            ]}
            value={qLevel}
            onChange={(v: string) => setQLevel(v ?? 'event')}
          />
          <Input
            label="Help text (optional)"
            name="qHelpText"
            value={qHelpText}
            onChange={setQHelpText}
          />
          {qScope === 'attendee' && (
            <Input
              label="Contact property (optional)"
              description="Saves the answer on the attendee's contact so they are not asked again next time. Attendee questions only."
              name="qHsProperty"
              value={qHsProperty}
              onChange={setQHsProperty}
            />
          )}
          {qScope === 'attendee' && qHsProperty.trim() !== '' && (
            <ToggleGroup
              label="If that property does not exist"
              name="qCreateProperty"
              toggleType="radioButtonList"
              options={[
                { label: 'Create it in HubSpot', value: 'true' },
                { label: 'Leave it to me', value: 'false' },
              ]}
              value={qCreateProperty ? 'true' : 'false'}
              onChange={(v: string) => setQCreateProperty(v === 'true')}
            />
          )}
          <NumberInput
            label="Sort order"
            name="qSortOrder"
            value={qSortOrder}
            onChange={setQSortOrder}
          />
        </Form>
        {qError && (
          <Alert title="Error" variant="error">
            {qError}
          </Alert>
        )}
        {qNotice && (
          <Alert title="Saved with a warning" variant="warning">
            {qNotice}
          </Alert>
        )}
        <Button onClick={handleAddQuestion} disabled={qSaving || !qLabel.trim() || !qKey.trim()}>
          {qSaving ? 'Adding…' : 'Add question'}
        </Button>

        <Divider />

        <Text format={{ fontWeight: 'bold' }}>Add attendee</Text>
        <Text variant="microcopy">
          Staff-only manual registration. Paid bookings create a reserved order for the normal
          invoice/payment flow; complimentary bookings reserve the seat and issue the ticket without
          an invoice.
        </Text>
        <Form>
          <ToggleGroup
            label="Booking type"
            name="manualMode"
            toggleType="radioButtonList"
            options={[
              { label: 'Paid — create invoice/payment link', value: 'paid' },
              { label: 'Complimentary/free seat', value: 'complimentary' },
            ]}
            value={manualMode}
            onChange={(v: string) => setManualMode(v ?? 'paid')}
          />
          <Select
            label="Ticket type"
            name="manualTicketType"
            value={manualTicketTypeId}
            onChange={(v) => setManualTicketTypeId(String(v ?? ''))}
            options={ticketTypes.map((tt) => ({
              label: `${tt.name} — $${centsToDisplay(tt.price_cents)}`,
              value: tt.id,
            }))}
          />
          <Input
            label="Attendee name"
            name="manualAttendeeName"
            value={manualAttendeeName}
            onChange={setManualAttendeeName}
          />
          <Input
            label="Attendee email"
            name="manualAttendeeEmail"
            value={manualAttendeeEmail}
            onChange={setManualAttendeeEmail}
          />
          <Input
            label="HubSpot contact ID (optional)"
            name="manualContactId"
            value={manualContactId}
            onChange={setManualContactId}
          />
          <Input
            label="Member company ID (optional, applies member pricing)"
            name="manualMemberCompanyId"
            value={manualMemberCompanyId}
            onChange={setManualMemberCompanyId}
          />
          <Input
            label="Buyer name (optional, defaults to attendee)"
            name="manualBuyerName"
            value={manualBuyerName}
            onChange={setManualBuyerName}
          />
          <Input
            label="Buyer email (optional, defaults to attendee)"
            name="manualBuyerEmail"
            value={manualBuyerEmail}
            onChange={setManualBuyerEmail}
          />
          {manualMode === 'paid' && (
            <Input
              label="Invoice due date (YYYY-MM-DD)"
              name="manualInvoiceDueDate"
              value={manualInvoiceDueDate}
              onChange={setManualInvoiceDueDate}
            />
          )}
          <Input
            label="Internal note / approval reason"
            name="manualStaffNote"
            value={manualStaffNote}
            onChange={setManualStaffNote}
          />
        </Form>
        {manualError && (
          <Alert title="Add attendee error" variant="error">
            {manualError}
          </Alert>
        )}
        {manualResult && (
          <Alert
            title={manualResult.status === 'confirmed' ? 'Attendee confirmed' : 'Attendee reserved'}
            variant={manualResult.status === 'confirmed' ? 'success' : 'warning'}
          >
            {manualResult.status === 'confirmed'
              ? `Registration ${manualResult.registrationIds?.join(', ') ?? ''} confirmed. Ticket ${manualResult.ticketIds?.join(', ') ?? ''} issued.`
              : `Order ${manualResult.orderId ?? ''} reserved. Refresh once invoice write-back has created the HubSpot payment link.`}
            {manualResult.paymentUrl ? ` Payment URL: ${manualResult.paymentUrl}` : ''}
          </Alert>
        )}
        <Flex gap="small">
          <Button
            variant="primary"
            onClick={handleManualRegistration}
            disabled={
              manualSaving ||
              !manualTicketTypeId ||
              !manualAttendeeName ||
              !manualAttendeeEmail ||
              ticketTypes.length === 0
            }
          >
            {manualSaving ? 'Adding…' : 'Add attendee'}
          </Button>
          {manualResult?.orderId && manualResult.status === 'reserved' && (
            <Button onClick={() => refreshManualPaymentLink(manualResult.orderId ?? '')}>
              Refresh payment link
            </Button>
          )}
        </Flex>

        <Divider />

        <Text format={{ fontWeight: 'bold' }}>Registrations — refund &amp; transfer</Text>
        {actionError && (
          <Alert title="Error" variant="error">
            {actionError}
          </Alert>
        )}
        {actionMsg && (
          <Alert title="Done" variant="success">
            {actionMsg}
          </Alert>
        )}

        {/*
          Phase 2.2 — the whole-event counts, split by what state each seat's order is in.
          A single "registered" figure is what let the engine and the training dashboard
          disagree without anyone being able to say where; these four sum to the total, so
          a gap against another system can be pointed at.
        */}
        {registrationSummary && (
          <Text variant="microcopy">
            {registrationSummary.total} registered · {registrationSummary.confirmed} confirmed
            {registrationSummary.awaitingPayment > 0 &&
              ` · ${registrationSummary.awaitingPayment} awaiting payment`}
            {registrationSummary.needsReview > 0 &&
              ` · ${registrationSummary.needsReview} needs review`}
            {registrationSummary.cancelled > 0 && ` · ${registrationSummary.cancelled} cancelled`}
            {' · '}
            {registrationSummary.attended} attended
          </Text>
        )}

        {/*
          Seats a company has bought and not yet named (Ref 74b). Surfaced next to the
          counts rather than buried in the list: these are sold seats with a person still
          to chase, and nothing else on this card would tell you they exist.
        */}
        {registrationSummary && (registrationSummary.unnamedSeats ?? 0) > 0 && (
          <Alert title="Seats awaiting names" variant="warning">
            {registrationSummary.unnamedSeats} seat(s) are held and invoiced with no attendee on
            them. Assign each one from the list below as the company sends the names.
          </Alert>
        )}

        {assignRegId && (
          <Box>
            <Text format={{ fontWeight: 'bold' }}>Assign this seat</Text>
            <Text variant="microcopy">
              The seat, its price and its invoice do not change — this only says who is in it. The
              attendee is registered with HubSpot and issued a ticket once the booking is paid.
            </Text>
            <Form>
              <Input
                label="Attendee name"
                name="assignName"
                value={assignName}
                onChange={setAssignName}
              />
              <Input
                label="Attendee email"
                name="assignEmail"
                value={assignEmail}
                onChange={setAssignEmail}
              />
            </Form>
            <Flex gap="small">
              <Button
                variant="primary"
                disabled={!assignName.trim() || !assignEmail.trim()}
                onClick={handleAssignSeat}
              >
                Assign seat
              </Button>
              <Button onClick={() => setAssignRegId(null)}>Cancel</Button>
            </Flex>
          </Box>
        )}

        <Divider />

        <Text format={{ fontWeight: 'bold' }}>Hold seats for a company</Text>
        <Text variant="microcopy">
          Books and invoices the seats now, with the names to follow. The seats leave public
          availability immediately and the company is invoiced for them straight away, exactly as
          any other booking — the only difference is that nobody is on them yet. Add each attendee
          from the list above whenever the company sends them through.
        </Text>
        <Form>
          <Select
            label="Ticket type"
            name="blockTicketTypeId"
            value={blockTicketTypeId}
            onChange={(v) => setBlockTicketTypeId(String(v ?? ''))}
            options={ticketTypes.map((tt) => ({ label: tt.name, value: tt.id }))}
          />
          <NumberInput
            label="Seats to hold"
            name="blockSeats"
            value={blockSeats}
            onChange={setBlockSeats}
          />
          <Input
            label="Company / buyer name (goes on the invoice)"
            name="blockBuyerName"
            value={blockBuyerName}
            onChange={setBlockBuyerName}
          />
          <Input
            label="Billing email"
            name="blockBuyerEmail"
            value={blockBuyerEmail}
            onChange={setBlockBuyerEmail}
          />
          <Input
            label="HubSpot company id (optional — unlocks member pricing)"
            name="blockCompanyId"
            value={blockCompanyId}
            onChange={setBlockCompanyId}
          />
        </Form>
        <Button
          variant="primary"
          disabled={
            blockSaving ||
            blockSeats < 1 ||
            !blockTicketTypeId ||
            !blockBuyerName.trim() ||
            !blockBuyerEmail.trim()
          }
          onClick={handleCreateSeatBlock}
        >
          {blockSaving ? 'Holding…' : `Hold ${blockSeats || 0} seat(s) and invoice`}
        </Button>

        <Divider />

        {/*
          The CSV export. Two steps on purpose: the worker mints a short-lived token, then
          the link opens with it. A UI extension has no download primitive, so opening a
          self-authorising URL in a new tab is the only route a staff member has to the file.
        */}
        <Flex gap="small" align="center">
          <Button
            disabled={exportBusy || !event}
            onClick={() => event && prepareCsvExport(event.id)}
          >
            {exportBusy ? 'Preparing…' : 'Export attendees (CSV)'}
          </Button>
          {exportLink && <Link href={{ url: exportLink.url, external: true }}>Download CSV</Link>}
        </Flex>
        {exportLink && (
          <Text variant="microcopy">
            The link expires at {new Date(exportLink.expiresAt).toLocaleTimeString()}. Prepare a new
            one if it stops working.
          </Text>
        )}
        {exportError && (
          <Alert title="Export failed" variant="error">
            {exportError}
          </Alert>
        )}

        {registrations.length > 0 ? (
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Attendee</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Paid</TableCell>
                <TableCell>Notes</TableCell>
                <TableCell>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {registrations.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    {r.seat_unnamed ? (
                      <Flex direction="column" gap="extra-small">
                        <Tag variant="warning">Awaiting name</Tag>
                        <Button onClick={() => openAssignSeat(r.id)}>Assign this seat</Button>
                      </Flex>
                    ) : (
                      `${r.attendee_name} (${r.attendee_email})`
                    )}
                  </TableCell>
                  <TableCell>
                    <Tag
                      variant={
                        r.order_status === 'refunded' || r.order_status === 'cancelled'
                          ? 'error'
                          : r.order_status === 'partially_refunded'
                            ? 'warning'
                            : 'success'
                      }
                    >
                      {r.order_status}
                    </Tag>
                  </TableCell>
                  <TableCell>${centsToDisplay(r.order_total_cents)}</TableCell>
                  <TableCell>
                    <Button
                      onClick={() => {
                        setNoteError(null);
                        setNoteDraft('');
                        setNotesRegId(notesRegId === r.id ? null : r.id);
                      }}
                    >
                      Notes ({notesForRegistration(r).length})
                    </Button>
                  </TableCell>
                  <TableCell>
                    <Flex gap="small">
                      <Button variant="destructive" onClick={() => handleRefund(r.id)}>
                        Refund (per policy)
                      </Button>
                      <Button onClick={() => setTransferRegId(r.id)}>Transfer</Button>
                    </Flex>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Text variant="microcopy">No registrations yet.</Text>
        )}

        {registrationSummary && registrations.length < registrationSummary.total && (
          <Text variant="microcopy">
            Showing the first {registrations.length} of {registrationSummary.total}. The CSV export
            above has every attendee.
          </Text>
        )}

        {transferRegId && (
          <Box>
            <Text format={{ fontWeight: 'bold' }} variant="microcopy">
              Transfer registration to a new attendee
            </Text>
            <Form>
              <Input
                label="New attendee email"
                name="transferEmail"
                value={transferEmail}
                onChange={setTransferEmail}
              />
              <Input
                label="New attendee name"
                name="transferName"
                value={transferName}
                onChange={setTransferName}
              />
            </Form>
            <Flex gap="small">
              <Button
                variant="primary"
                onClick={handleTransfer}
                disabled={!transferEmail || !transferName}
              >
                Confirm transfer
              </Button>
              <Button onClick={() => setTransferRegId(null)}>Cancel</Button>
            </Flex>
          </Box>
        )}

        {notesRegId && (
          <Box>
            <Text format={{ fontWeight: 'bold' }} variant="microcopy">
              Staff notes —{' '}
              {registrations.find((r) => r.id === notesRegId)?.attendee_name ?? 'attendee'}
            </Text>
            <Text variant="microcopy">
              Internal only. Notes are never shown on a ticket, an invoice, or anything the attendee
              is sent. Notes cannot be edited or deleted — correcting one means adding another.
            </Text>
            {(() => {
              const reg = registrations.find((r) => r.id === notesRegId);
              const thread = reg ? notesForRegistration(reg) : [];
              return thread.length > 0 ? (
                <Table>
                  <TableHead>
                    <TableRow>
                      <TableCell>When</TableCell>
                      <TableCell>Author</TableCell>
                      <TableCell>Note</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {thread.map((n) => (
                      <TableRow key={n.id}>
                        <TableCell>{n.created_at.replace('T', ' ').slice(0, 16)}</TableCell>
                        <TableCell>{n.author}</TableCell>
                        <TableCell>
                          {n.body}
                          {n.order_id && !n.registration_id ? ' (booking)' : ''}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <Text variant="microcopy">No notes yet.</Text>
              );
            })()}
            {noteError && (
              <Alert title="Note error" variant="error">
                {noteError}
              </Alert>
            )}
            <Form>
              <Input
                label="Add a note"
                name="noteDraft"
                value={noteDraft}
                onChange={setNoteDraft}
              />
            </Form>
            <Flex gap="small">
              <Button
                variant="primary"
                disabled={!noteDraft.trim() || noteSaving || !event}
                onClick={() => event && submitStaffNote(event.id, notesRegId)}
              >
                {noteSaving ? 'Saving…' : 'Add note'}
              </Button>
              <Button onClick={() => setNotesRegId(null)}>Close</Button>
            </Flex>
          </Box>
        )}

        <Divider />

        <Text format={{ fontWeight: 'bold' }}>Refund policy templates</Text>
        <Text variant="microcopy">
          Templates resolve per event: the event&apos;s policy &gt; a category default &gt; the
          portal default &gt; full-refund-to-30-days.
        </Text>
        {refundPolicies.length > 0 && (
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Name</TableCell>
                <TableCell>Default</TableCell>
                <TableCell>Category</TableCell>
                <TableCell>Cutoff (days)</TableCell>
                <TableCell>Partial %</TableCell>
                <TableCell>Transfer</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {refundPolicies.map((rp) => (
                <TableRow key={rp.id}>
                  <TableCell>{rp.name}</TableCell>
                  <TableCell>{rp.is_default ? 'Yes' : ''}</TableCell>
                  <TableCell>{rp.category ?? '—'}</TableCell>
                  <TableCell>{rp.full_refund_cutoff_days ?? 30}</TableCell>
                  <TableCell>{rp.partial_refund_percent ?? '—'}</TableCell>
                  <TableCell>{rp.allow_transfer ? 'Allowed' : 'Blocked'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <Text format={{ fontWeight: 'bold' }} variant="microcopy">
          Add refund policy template
        </Text>
        <Form>
          <Input
            label="Name (e.g. Events default)"
            name="rpName"
            value={rpName}
            onChange={setRpName}
          />
          <NumberInput
            label="Full-refund cutoff (days before event)"
            name="rpCutoff"
            value={rpCutoff}
            onChange={setRpCutoff}
          />
          <NumberInput
            label="Partial refund % after cutoff (0 = none)"
            name="rpPartial"
            value={rpPartial}
            onChange={setRpPartial}
          />
          <Input
            label="Event category (blank = portal default)"
            name="rpCategory"
            value={rpCategory}
            onChange={setRpCategory}
          />
          <ToggleGroup
            label="Allow transfer"
            name="rpAllowTransfer"
            toggleType="radioButtonList"
            options={[
              { label: 'Yes', value: 'true' },
              { label: 'No', value: 'false' },
            ]}
            value={rpAllowTransfer ? 'true' : 'false'}
            onChange={(v: string) => setRpAllowTransfer(v === 'true')}
          />
          <ToggleGroup
            label="Default template"
            name="rpIsDefault"
            toggleType="radioButtonList"
            options={[
              { label: 'No', value: 'false' },
              { label: 'Yes', value: 'true' },
            ]}
            value={rpIsDefault ? 'true' : 'false'}
            onChange={(v: string) => setRpIsDefault(v === 'true')}
          />
        </Form>
        <Button onClick={handleAddRefundPolicy} disabled={!rpName}>
          Add policy template
        </Button>
      </Flex>
    </Box>
  );
});
