import { type EventRow, effectiveCapacity, type TicketTypeRow } from './db';

/**
 * Refreshes a single EventCapacity Durable Object from D1 before a hold.
 * The sync is intentionally best-effort: the Durable Object remains the
 * authority for live capacity if a transient refresh fails.
 */
export async function syncCapacityFromD1(
  doStub: DurableObjectStub,
  event: EventRow,
  ticketTypes: TicketTypeRow[],
): Promise<void> {
  await syncCapacityFromD1Strict(doStub, event, ticketTypes);
}

/**
 * The same sync, reporting whether the Durable Object ACKNOWLEDGED the new numbers.
 *
 * Best effort is right while D1 and the DO agree, because the DO's own number is the one
 * that sells. It is wrong the moment D1 has just been LOWERED (a HubDB capacity edit,
 * migration 0045): an initialised DO that missed the sync keeps its old, higher limit, and
 * a reserve straight after it would sell a seat the new capacity does not have. So the
 * callers that have just lowered D1 ask this one, and refuse the hold on false.
 */
export async function syncCapacityFromD1Strict(
  doStub: DurableObjectStub,
  event: EventRow,
  ticketTypes: TicketTypeRow[],
): Promise<boolean> {
  const perType = Object.fromEntries(
    ticketTypes.map((tt) => [tt.id, { inventory: effectiveCapacity(tt) }]),
  );

  try {
    const resp = await doStub.fetch('https://do/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventCapacity: effectiveCapacity(event), perType }),
    });
    if (!resp.ok) return false;
    const body = (await resp.json().catch(() => null)) as { ok?: boolean } | null;
    return body?.ok === true;
  } catch {
    return false;
  }
}
