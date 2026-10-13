/**
 * ZoomProvider — Zoom Webinars implementation of WebinarProvider (push-based).
 *
 * The worker creates the webinar via the Zoom API so it owns the id + join URL,
 * and registers each attendee so Zoom mints a per-attendee join URL and a
 * registrant id (persisted as the provider registration id → exact matching).
 *
 * Attendance is PUSH: Zoom event notifications hit POST /webhooks/zoom (signature
 * verified + deduped there) and enqueue a graph.pull_attendance job; the worker
 * then reconciles via the Reports API (authoritative join/leave times). The
 * finalize/poll crons are the backstop if a webhook is missed.
 *
 * Auth: Server-to-Server OAuth (account_credentials grant), token cached in KV.
 */

import type { Env } from '../types';
import { getProviderAccessToken } from './oauth';
import type {
  AttendanceRecord,
  CreateWebinarResult,
  PullAttendanceJob,
  RegisterAttendeeResult,
  WebinarAttendeeInput,
  WebinarEventInput,
  WebinarProvider,
} from './types';

const ZOOM_API = 'https://api.zoom.us/v2';

// ---------------------------------------------------------------------------
// Raw response shapes (only the fields we read)
// ---------------------------------------------------------------------------

interface ZoomWebinar {
  id: number | string;
  join_url?: string;
}

interface ZoomRegistrant {
  registrant_id?: string;
  join_url?: string;
}

interface ZoomReportParticipant {
  id?: string;
  registrant_id?: string;
  name?: string;
  user_email?: string;
  join_time?: string;
  leave_time?: string;
}

interface ZoomReport {
  participants?: ZoomReportParticipant[];
}

/** Inbound Zoom event envelope (the bits we act on). */
interface ZoomEventEnvelope {
  event?: string;
  payload?: { account_id?: string; object?: { id?: number | string } };
}

function splitName(name: string): { first: string; last: string } {
  const parts = name.trim().split(/\s+/);
  return { first: parts[0] || name, last: parts.slice(1).join(' ') || name };
}

export class ZoomProvider implements WebinarProvider {
  readonly name = 'zoom';

  constructor(
    private readonly env: Env,
    private readonly portalId: string,
  ) {}

  // -------------------------------------------------------------------------
  // Auth: per-tenant OAuth token from the connect flow (refreshed transparently)
  // -------------------------------------------------------------------------

  private async api(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = await getProviderAccessToken(this.env, this.portalId, 'zoom');
    const init: RequestInit = {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const resp = await fetch(`${ZOOM_API}${path}`, init);
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`Zoom ${method} ${path} → ${resp.status}: ${detail}`);
    }
    const text = await resp.text();
    return text ? (JSON.parse(text) as unknown) : null;
  }

  // -------------------------------------------------------------------------
  // createWebinar
  // -------------------------------------------------------------------------

  async createWebinar(event: WebinarEventInput): Promise<CreateWebinarResult> {
    // OAuth token is scoped to the authorizing user; 'me' is that account.
    const webinar = (await this.api('POST', `/users/me/webinars`, {
      topic: event.title,
      type: 5, // scheduled webinar
      start_time: event.startsAt,
      timezone: 'UTC',
      settings: {
        // Registration required so Zoom mints a registrant id we can match on.
        approval_type: 0,
        registrants_email_notification: false,
      },
    })) as ZoomWebinar;

    return {
      providerWebinarId: String(webinar.id),
      providerSessionId: String(webinar.id),
      joinUrl: webinar.join_url ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // registerAttendee: Zoom registrant id is the provider registration id
  // -------------------------------------------------------------------------

  async registerAttendee(
    webinarId: string,
    attendee: WebinarAttendeeInput,
  ): Promise<RegisterAttendeeResult> {
    const { first, last } = splitName(attendee.name);
    const reg = (await this.api('POST', `/webinars/${encodeURIComponent(webinarId)}/registrants`, {
      email: attendee.email,
      first_name: first,
      last_name: last,
      // Carry OUR id in a tracking field so it survives into reports if enabled.
      custom_questions: [{ title: 'paddockRegistrationId', value: attendee.ourRegistrationId }],
    })) as ZoomRegistrant;

    return {
      providerRegistrationId: reg.registrant_id ?? null,
      personalJoinUrl: reg.join_url ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // ensureSubscription / handleNotification: push — subscription is configured in
  // the Zoom app; handleNotification maps a verified event to a pull job.
  // -------------------------------------------------------------------------

  async ensureSubscription(_tenant: { portalId: string }): Promise<void> {
    // Zoom event subscriptions are configured in the Zoom Marketplace app, not via
    // API; nothing to renew. The webhook route resolves the tenant + secret.
  }

  async handleNotification(payload: unknown): Promise<PullAttendanceJob[]> {
    const envelope = payload as ZoomEventEnvelope;
    const webinarId = envelope.payload?.object?.id;
    if (webinarId === undefined || webinarId === null) return [];
    // Any participant/lifecycle event is a signal to (re-)pull the report; the
    // pull is idempotent so we don't need to distinguish join vs leave vs ended.
    return [
      { kind: 'graph.pull_attendance', portalId: this.portalId, webinarId: String(webinarId) },
    ];
  }

  // -------------------------------------------------------------------------
  // fetchAttendance: Reports API participants → normalize join/leave
  // -------------------------------------------------------------------------

  async fetchAttendance(webinarId: string, _sessionId: string): Promise<AttendanceRecord[]> {
    const report = (await this.api(
      'GET',
      `/report/webinars/${encodeURIComponent(webinarId)}/participants?page_size=300`,
    )) as ZoomReport;

    return (report.participants ?? []).map((p) => ({
      email: p.user_email ?? null,
      ourRegistrationId: null,
      providerRegistrationId: p.registrant_id ?? null,
      role: 'Attendee' as const,
      intervals: [{ join: p.join_time ?? null, leave: p.leave_time ?? null }],
      displayName: p.name ?? null,
      raw: p,
    }));
  }
}
