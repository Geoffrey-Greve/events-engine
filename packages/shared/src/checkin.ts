/**
 * Check-in API types — shared between the worker and the scanner PWA.
 * The PWA imports these rather than redefining them.
 */

/** The decoded contents of a ticket QR code. */
export interface TicketCodePayload {
  /** ticket id */
  tid: string;
  /** registration id */
  rid: string;
  /** event id */
  eid: string;
}

/**
 * One attendee answer, as the door sees it (Ref 74d).
 *
 * Carries the question's LABEL rather than only its key, because the scanner renders this
 * with no question definitions of its own — it has the manifest and nothing else once it is
 * offline. Keyed by `key` so a caller can still find a specific question without matching
 * on display text.
 */
export interface ManifestAnswer {
  /** Stable question slug, e.g. "dietary_requirements". */
  key: string;
  /** The question as worded to the attendee. */
  label: string;
  /** The answer as stored. A multiselect arrives ";"-joined, HubSpot's own encoding. */
  value: string;
}

/** One entry in the offline check-in manifest. */
export interface ManifestEntry {
  /** Signed QR code: base64url(JSON{tid,rid,eid}) "." base64url(HMAC-SHA256) */
  code: string;
  name: string;
  status: string;
  checkedInAt: string | null;
  /**
   * This attendee's answers, in the questions' display order. Attendee-scoped only: an
   * order-scoped answer (a purchase order number) is not door information and would repeat
   * identically on every seat of a block. Empty when the attendee answered nothing.
   */
  answers: ManifestAnswer[];
}

/**
 * A manifest entry as it may actually arrive, rather than as the type promises.
 *
 * `answers` landed with Ref 74d, and two sources predate it: a manifest cached in the
 * scanner's IndexedDB before the device took the new build, and a worker that has not been
 * deployed yet — the PWA ships to Cloudflare Pages and the worker to Workers, on separate
 * commands, so either can be the older of the two in both directions. The stored record is
 * deserialised straight into `ManifestEntry`, so TypeScript believes a field that is simply
 * absent, and `ticket.answers.length` in the manual search threw a TypeError mid-render:
 * the results list had already been cleared, so door staff got an empty list and no error.
 * That is the one path that matters, because manual search is what they fall back to when
 * a code will not scan, offline, which is the whole reason the scanner holds a manifest.
 *
 * Normalised on the way IN rather than guarded at each read, so there is one place this can
 * be got wrong instead of one per call site, and the type stops lying about the record.
 */
export function normaliseManifestTickets(tickets: readonly ManifestEntry[]): ManifestEntry[] {
  // The entry itself is returned untouched in the ordinary case: app.ts mutates the ticket
  // it finds in this array to mark a local check-in, so a copy per scan would silently
  // detach that write from the manifest it is meant to update.
  return tickets.map((ticket) =>
    Array.isArray(ticket.answers) ? ticket : { ...ticket, answers: [] },
  );
}

/** Response from GET /api/v1/checkin/manifest/:eventId */
export interface ManifestResponse {
  eventId: string;
  algorithm: 'HMAC-SHA256';
  /** Base64url-encoded raw bytes of the per-event HMAC-SHA256 verify key. */
  verifyKey: string;
  generatedAt: string;
  count: number;
  tickets: ManifestEntry[];
}

export type ScanOutcome =
  | 'checked_in'
  | 'already_checked_in'
  | 'cancelled'
  | 'invalid_signature'
  | 'wrong_event'
  | 'not_found';

/** Single scan result (from POST /checkin or one entry in POST /checkin/batch). */
export interface ScanResult {
  code: string;
  status: ScanOutcome;
  ok: boolean;
  checkedInAt?: string;
  attendeeName?: string;
}

/** Response from POST /api/v1/checkin/batch */
export interface BatchResponse {
  status: 'processed';
  total: number;
  accepted: number;
  results: ScanResult[];
}

/** Response from GET /api/v1/checkin/stats/:eventId */
export interface StatsResponse {
  eventId: string;
  registered: number;
  attended: number;
  notYetArrived: number;
}

/** Response from POST /api/v1/checkin/device-token */
export interface DeviceTokenResponse {
  token: string;
  eventId: string;
  deviceId: string;
  expiresAt: string;
}
