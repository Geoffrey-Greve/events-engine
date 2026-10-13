import {
  Alert,
  Box,
  Button,
  Divider,
  Flex,
  Form,
  Heading,
  hubspot,
  Input,
  LoadingSpinner,
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
import { HeaderActions, PrimaryHeaderActionButton } from '@hubspot/ui-extensions/pages/home';
import { useEffect, useMemo, useState } from 'react';

type ManualRegistrationMode = 'paid' | 'complimentary';

interface WorkerEvent {
  id: string;
  hubspot_event_id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  capacity: number;
  location: string | null;
  provider: string | null;
  booking_kind?: 'event' | 'course' | null;
}

interface TicketType {
  id: string;
  name: string;
  price_cents: number;
  currency: string;
  capacity: number;
  member_only: number;
  sort_order: number;
}

interface PendingDecision {
  id: string;
  type: string;
  event_id: string;
  event_title: string;
  event_starts_at: string;
  created_at: string;
}

/**
 * What each decision type is asking of the reader. The worker's own task subjects are
 * written for an assigned HubSpot task; these are written for a list of many, so they name
 * the ask rather than repeat the event title the row already carries.
 */
const DECISION_LABELS: Record<string, { label: string; ask: string }> = {
  oversell: {
    label: 'Payment taken, no seat',
    ask: 'Honour the booking or refund it.',
  },
  waitlist: {
    label: 'Seat freed',
    ask: 'Choose who to offer it to.',
  },
  fast_sellout: {
    label: 'Sold out immediately',
    ask: 'Check the capacity is not still a placeholder.',
  },
  contact_conflict: {
    label: 'Contact details differ',
    ask: 'Keep the HubSpot value or take the booking’s.',
  },
  unpaid_invoice: {
    label: 'Unpaid invoice',
    ask: 'Void the invoice or leave it payable.',
  },
};

interface Registration {
  id: string;
  attendee_email: string;
  attendee_name: string;
  order_status: string;
  total_cents: number;
}

interface StatsResponse {
  capacity: number;
  registered: number;
  availableSeats: number;
}

interface ManualRegistrationResult {
  ok?: boolean;
  mode?: string;
  status?: string;
  message?: string;
  orderId?: string;
  registrationIds?: string[];
  ticketIds?: string[];
  paymentUrl?: string | null;
}

interface ExtensionProps {
  workerBaseUrl: string;
}

const DEFAULT_WORKER_BASE_URL = 'https://event-engine.refuel-creative.workers.dev';

function cleanBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function getExtensionProps(context: {
  extension?: unknown;
  variables?: Record<string, unknown>;
}): ExtensionProps {
  const extensionProps =
    (context.extension as Record<string, Record<string, unknown>> | undefined)?.properties ?? {};
  const variables = context.variables ?? {};

  const workerBaseUrl = cleanBaseUrl(
    String(extensionProps.workerBaseUrl ?? variables.WORKER_BASE_URL ?? DEFAULT_WORKER_BASE_URL),
  );

  return { workerBaseUrl };
}

function centsToDisplay(cents: number): string {
  return (cents / 100).toLocaleString('en-AU', {
    style: 'currency',
    currency: 'AUD',
  });
}

function formatDateRange(start: string, end: string): string {
  const fmt = new Intl.DateTimeFormat('en-AU', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Australia/Sydney',
  });
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime())) return 'Date not set';
  if (Number.isNaN(endDate.getTime())) return fmt.format(startDate);
  return `${fmt.format(startDate)} – ${fmt.format(endDate)}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat('en-AU', {
    dateStyle: 'medium',
    timeZone: 'Australia/Sydney',
  }).format(date);
}

function sortEvents(events: WorkerEvent[]): WorkerEvent[] {
  const now = Date.now();
  return [...events].sort((a, b) => {
    const aTime = new Date(a.starts_at).getTime();
    const bTime = new Date(b.starts_at).getTime();
    const aFuture = aTime >= now;
    const bFuture = bTime >= now;
    if (aFuture !== bFuture) return aFuture ? -1 : 1;
    return aFuture ? aTime - bTime : bTime - aTime;
  });
}

function defaultTicketType(ticketTypes: TicketType[]): string {
  return ticketTypes[0]?.id ?? '';
}

type AppHomeContext = Parameters<Parameters<typeof hubspot.extend<'home'>>[0]>[0]['context'];

hubspot.extend<'home'>(({ context }) => <ManualRegistrationHome context={context} />);

function ManualRegistrationHome({ context }: { context: AppHomeContext }) {
  const { workerBaseUrl } = getExtensionProps(context);

  const [events, setEvents] = useState<WorkerEvent[]>([]);
  const [selectedEventId, setSelectedEventId] = useState('');
  const [ticketTypes, setTicketTypes] = useState<TicketType[]>([]);
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [eventLoading, setEventLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingDecisions, setPendingDecisions] = useState<PendingDecision[]>([]);

  const [manualMode, setManualMode] = useState<ManualRegistrationMode>('paid');
  const [manualTicketTypeId, setManualTicketTypeId] = useState('');
  const [manualAttendeeName, setManualAttendeeName] = useState('');
  const [manualAttendeeEmail, setManualAttendeeEmail] = useState('');
  const [manualContactId, setManualContactId] = useState('');
  const [manualMemberCompanyId, setManualMemberCompanyId] = useState('');
  const [manualBuyerName, setManualBuyerName] = useState('');
  const [manualBuyerEmail, setManualBuyerEmail] = useState('');
  const [manualInvoiceDueDate, setManualInvoiceDueDate] = useState('');
  const [manualStaffNote, setManualStaffNote] = useState('');
  const [manualSaving, setManualSaving] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const [manualResult, setManualResult] = useState<ManualRegistrationResult | null>(null);

  const sortedEvents = useMemo(() => sortEvents(events), [events]);
  const selectedEvent = events.find((event) => event.id === selectedEventId) ?? null;
  const selectedTicket = ticketTypes.find((ticket) => ticket.id === manualTicketTypeId) ?? null;
  const configMissing = !workerBaseUrl;

  async function fetchJson<T>(
    path: string,
    options?: {
      method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
      body?: Record<string, unknown>;
      timeout?: number;
    },
  ): Promise<T> {
    const res = await hubspot.fetch(`${workerBaseUrl}${path}`, {
      method: options?.method ?? 'GET',
      body: options?.body,
      timeout: options?.timeout ?? 30_000,
    });

    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (!res.ok) {
      const message =
        typeof data === 'object' && data && 'message' in data
          ? String((data as { message: unknown }).message)
          : text || String(res.status);
      throw new Error(message);
    }

    return data as T;
  }

  async function loadEvents() {
    if (configMissing) return;
    setLoading(true);
    setLoadError(null);
    try {
      const data = await fetchJson<WorkerEvent[]>('/api/v1/app-home/events');
      const nextEvents = sortEvents(data);
      setEvents(nextEvents);
      if (!selectedEventId && nextEvents.length > 0) {
        setSelectedEventId(nextEvents[0].id);
      }
    } catch (error) {
      setLoadError(String(error));
    } finally {
      setLoading(false);
    }
  }

  /**
   * Decisions are loaded separately from the sessions list and never set `loadError`: this
   * is a secondary surface, and a portal that cannot read it should still be able to book
   * someone in. A failure here leaves the list empty rather than blocking the page.
   */
  async function loadPendingDecisions() {
    if (configMissing) return;
    try {
      setPendingDecisions(await fetchJson<PendingDecision[]>('/api/v1/app-home/pending-decisions'));
    } catch {
      setPendingDecisions([]);
    }
  }

  async function loadEventDetails(eventId: string) {
    if (configMissing || !eventId) return;
    setEventLoading(true);
    setLoadError(null);
    try {
      const [tickets, eventStats, eventRegistrations] = await Promise.all([
        fetchJson<TicketType[]>(
          `/api/v1/app-home/events/${encodeURIComponent(eventId)}/ticket-types`,
        ),
        fetchJson<StatsResponse>(`/api/v1/app-home/events/${encodeURIComponent(eventId)}/stats`),
        fetchJson<Registration[]>(
          `/api/v1/app-home/events/${encodeURIComponent(eventId)}/registrations`,
        ),
      ]);
      setTicketTypes(tickets);
      setStats(eventStats);
      setRegistrations(eventRegistrations);
      setManualTicketTypeId(defaultTicketType(tickets));
      setManualResult(null);
      setManualError(null);
    } catch (error) {
      setLoadError(String(error));
    } finally {
      setEventLoading(false);
    }
  }

  async function handleManualRegistration() {
    if (!selectedEvent) return;
    setManualSaving(true);
    setManualError(null);
    setManualResult(null);
    try {
      const idempotencyKey = `staff-home-${selectedEvent.id}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}`;
      const result = await fetchJson<ManualRegistrationResult>(
        `/api/v1/app-home/events/${encodeURIComponent(selectedEvent.id)}/registrations`,
        {
          method: 'POST',
          timeout: 120_000,
          body: {
            mode: manualMode,
            ticketTypeId: manualTicketTypeId,
            attendeeName: manualAttendeeName,
            attendeeEmail: manualAttendeeEmail,
            hubspotContactId: manualContactId || null,
            memberCompanyId: manualMemberCompanyId || null,
            buyerName: manualBuyerName || manualAttendeeName,
            buyerEmail: manualBuyerEmail || manualAttendeeEmail,
            invoiceDueDate: manualMode === 'paid' ? manualInvoiceDueDate || null : null,
            staffNote: manualStaffNote || null,
            idempotencyKey,
          },
        },
      );

      if (result.ok === false) {
        setManualError(result.message ?? result.status ?? 'Add attendee failed');
        return;
      }

      setManualResult(result);
      setManualAttendeeName('');
      setManualAttendeeEmail('');
      setManualContactId('');
      setManualMemberCompanyId('');
      setManualBuyerName('');
      setManualBuyerEmail('');
      setManualInvoiceDueDate('');
      setManualStaffNote('');
      await loadEventDetails(selectedEvent.id);
    } catch (error) {
      setManualError(String(error));
    } finally {
      setManualSaving(false);
    }
  }

  async function refreshPaymentLink(orderId: string) {
    if (!orderId) return;
    setManualError(null);
    try {
      const data = await fetchJson<{ paymentUrl?: string | null; status?: string }>(
        `/api/v1/app-home/orders/${encodeURIComponent(orderId)}`,
      );
      setManualResult((prev) =>
        prev
          ? {
              ...prev,
              status: data.status ?? prev.status,
              paymentUrl: data.paymentUrl ?? null,
            }
          : prev,
      );
    } catch (error) {
      setManualError(String(error));
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-only configuration load
  useEffect(() => {
    loadEvents();
    loadPendingDecisions();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload details when staff changes session
  useEffect(() => {
    if (selectedEventId) {
      loadEventDetails(selectedEventId);
    }
  }, [selectedEventId]);

  const eventOptions = sortedEvents.map((event) => ({
    label: `${event.title} — ${formatDateRange(event.starts_at, event.ends_at)}`,
    value: event.id,
  }));

  return (
    <Box>
      <HeaderActions>
        <PrimaryHeaderActionButton
          onClick={() => {
            loadEvents();
            loadPendingDecisions();
          }}
          disabled={loading || configMissing}
        >
          {loading ? 'Refreshing…' : 'Refresh sessions'}
        </PrimaryHeaderActionButton>
      </HeaderActions>

      <Flex direction="column" gap="medium">
        <Box>
          <Heading>Staff manual registration</Heading>
          <Text>
            Add a person to an Event Engine-backed course or event. Paid bookings create the normal
            reserved order and invoice/payment flow. Complimentary bookings create a $0 registration
            without an invoice.
          </Text>
        </Box>

        {configMissing && (
          <Alert title="App configuration needed" variant="warning">
            The app home page is deployed, but it cannot connect to Event Engine until workerBaseUrl
            is available in the HubSpot app extension context.
          </Alert>
        )}

        {loadError && (
          <Alert title="Could not load Event Engine data" variant="error">
            {loadError}
          </Alert>
        )}

        {pendingDecisions.length > 0 && (
          <Box>
            <Alert title={`${pendingDecisions.length} decision(s) need someone`} variant="warning">
              Open the Event Engine card on the session’s Marketing Event record to resolve one.
              Nothing here is resolved automatically.
            </Alert>
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell>Session</TableCell>
                  <TableCell>Needs</TableCell>
                  <TableCell>What to do</TableCell>
                  <TableCell>Waiting since</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {pendingDecisions.map((decision) => {
                  const meta = DECISION_LABELS[decision.type];
                  return (
                    <TableRow key={decision.id}>
                      <TableCell>
                        <Text>{decision.event_title}</Text>
                        <Text variant="microcopy">{formatDate(decision.event_starts_at)}</Text>
                      </TableCell>
                      <TableCell>
                        <Tag variant="warning">{meta?.label ?? decision.type}</Tag>
                      </TableCell>
                      <TableCell>{meta?.ask ?? 'Open the event card.'}</TableCell>
                      <TableCell>{formatDate(decision.created_at)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Box>
        )}

        {loading && <LoadingSpinner label="Loading sessions…" />}

        {!configMissing && eventOptions.length > 0 && (
          <>
            <Form>
              <Select
                label="Course or event session"
                name="eventId"
                value={selectedEventId}
                onChange={(value) => setSelectedEventId(String(value ?? ''))}
                options={eventOptions}
              />
            </Form>

            {eventLoading && <LoadingSpinner label="Loading selected session…" />}

            {selectedEvent && !eventLoading && (
              <Flex direction="column" gap="medium">
                <Box>
                  <Flex direction="row" gap="small">
                    <Tag variant={selectedEvent.booking_kind === 'event' ? 'info' : 'default'}>
                      {selectedEvent.booking_kind === 'event' ? 'Event' : 'Course'}
                    </Tag>
                    {selectedEvent.provider && (
                      <Tag variant="success">{selectedEvent.provider}</Tag>
                    )}
                  </Flex>
                  <Heading>{selectedEvent.title}</Heading>
                  <Text>{formatDateRange(selectedEvent.starts_at, selectedEvent.ends_at)}</Text>
                  <Text>
                    {selectedEvent.location || 'Location not set'} · Capacity{' '}
                    {stats?.capacity ?? selectedEvent.capacity} · Registered{' '}
                    {stats?.registered ?? 0} · Available {stats?.availableSeats ?? '—'}
                  </Text>
                </Box>

                <Divider />

                <Box>
                  <Heading>Ticket types</Heading>
                  {ticketTypes.length > 0 ? (
                    <Table>
                      <TableHead>
                        <TableRow>
                          <TableCell>Name</TableCell>
                          <TableCell>Price</TableCell>
                          <TableCell>Capacity</TableCell>
                          <TableCell>Availability</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {ticketTypes.map((ticket) => (
                          <TableRow key={ticket.id}>
                            <TableCell>{ticket.name}</TableCell>
                            <TableCell>{centsToDisplay(ticket.price_cents)}</TableCell>
                            <TableCell>{ticket.capacity}</TableCell>
                            <TableCell>
                              {ticket.member_only ? (
                                <Tag variant="warning">Members only</Tag>
                              ) : (
                                <Tag>Open</Tag>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  ) : (
                    <Alert title="No ticket types found" variant="warning">
                      This session needs at least one Event Engine ticket type before staff can add
                      an attendee.
                    </Alert>
                  )}
                </Box>

                <Divider />

                <Box>
                  <Heading>Add attendee</Heading>
                  <Text>
                    Use paid for phone bookings that still need an invoice/payment link. Use
                    complimentary only for approved free/comp seats.
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
                      onChange={(value: string) =>
                        setManualMode(value === 'complimentary' ? 'complimentary' : 'paid')
                      }
                    />
                    <Select
                      label="Ticket type"
                      name="manualTicketType"
                      value={manualTicketTypeId}
                      onChange={(value) => setManualTicketTypeId(String(value ?? ''))}
                      options={ticketTypes.map((ticket) => ({
                        label: `${ticket.name} — ${centsToDisplay(ticket.price_cents)}`,
                        value: ticket.id,
                      }))}
                    />
                    {selectedTicket && (
                      <Text variant="microcopy">
                        Selected ticket: {selectedTicket.name},{' '}
                        {centsToDisplay(selectedTicket.price_cents)} before any server-side member
                        pricing adjustment.
                      </Text>
                    )}
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
                      <>
                        <Input
                          label="Invoice due date (optional, YYYY-MM-DD)"
                          name="manualInvoiceDueDate"
                          value={manualInvoiceDueDate}
                          onChange={setManualInvoiceDueDate}
                        />
                        <Text variant="microcopy">
                          Leave blank to use the 30-day default. A selected date keeps the seat
                          reserved until that invoice deadline.
                        </Text>
                      </>
                    )}
                    <Input
                      label="Internal note / approval reason"
                      name="manualStaffNote"
                      value={manualStaffNote}
                      onChange={setManualStaffNote}
                    />
                  </Form>

                  {manualError && (
                    <Alert title="Add attendee failed" variant="error">
                      {manualError}
                    </Alert>
                  )}

                  {manualResult && (
                    <Alert
                      title={
                        manualResult.status === 'confirmed'
                          ? 'Attendee confirmed'
                          : 'Attendee reserved'
                      }
                      variant={manualResult.status === 'confirmed' ? 'success' : 'warning'}
                    >
                      {manualResult.status === 'confirmed'
                        ? `Registration ${manualResult.registrationIds?.join(', ') ?? ''} confirmed. Ticket ${manualResult.ticketIds?.join(', ') ?? ''} issued.`
                        : `Order ${manualResult.orderId ?? ''} reserved. Refresh once HubSpot has created the payment link.`}
                      {manualResult.paymentUrl ? ` Payment URL: ${manualResult.paymentUrl}` : ''}
                    </Alert>
                  )}

                  <Flex direction="row" gap="small">
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
                      <Button onClick={() => refreshPaymentLink(manualResult.orderId ?? '')}>
                        Refresh payment link
                      </Button>
                    )}
                  </Flex>
                </Box>

                <Divider />

                <Box>
                  <Heading>Recent registrations</Heading>
                  {registrations.length > 0 ? (
                    <Table>
                      <TableHead>
                        <TableRow>
                          <TableCell>Attendee</TableCell>
                          <TableCell>Status</TableCell>
                          <TableCell>Total</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {registrations.slice(0, 10).map((registration) => (
                          <TableRow key={registration.id}>
                            <TableCell>
                              {registration.attendee_name} ({registration.attendee_email})
                            </TableCell>
                            <TableCell>{registration.order_status}</TableCell>
                            <TableCell>{centsToDisplay(registration.total_cents)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  ) : (
                    <Text variant="microcopy">No registrations found for this session yet.</Text>
                  )}
                </Box>
              </Flex>
            )}
          </>
        )}

        {!configMissing && !loading && eventOptions.length === 0 && (
          <Alert title="No Event Engine sessions found" variant="warning">
            No course or event sessions are currently available in the Event Engine staging
            database.
          </Alert>
        )}
      </Flex>
    </Box>
  );
}
