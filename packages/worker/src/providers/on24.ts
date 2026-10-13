/**
 * On24Provider — ON24 Elite implementation of WebinarProvider (poll-based).
 *
 * The worker creates the ON24 event (so it owns the event id + console URL) and
 * registers each attendee, stamping OUR registration id into the ON24 registrant
 * (partnerref) and persisting ON24's registrant key as the provider registration
 * id — so matching is exact.
 *
 * Attendance is PULL via the ON24 Analytics API: there is no push channel, so the
 * finalize/poll crons drive fetchAttendance. ON24 reports engagement as
 * first/last activity timestamps (mapped to a live interval) plus total minutes
 * (surfaced as engagement + a synthetic span when timestamps are absent).
 *
 * Auth: ON24 token-key/token-secret headers, scoped by client id (per-tenant).
 */

import type { Env } from '../types';
import { getProviderApiCreds } from './oauth';
import type {
  AttendanceRecord,
  CreateWebinarResult,
  PullAttendanceJob,
  RegisterAttendeeResult,
  WebinarAttendeeInput,
  WebinarEventInput,
  WebinarProvider,
} from './types';
import { syntheticInterval } from './types';

const ON24_API = 'https://api.on24.com/v2';

// ---------------------------------------------------------------------------
// Raw response shapes (only the fields we read)
// ---------------------------------------------------------------------------

interface On24Event {
  eventid?: number | string;
  audienceurl?: string;
}

interface On24Registrant {
  registrantid?: number | string;
  audienceurl?: string;
}

interface On24Attendee {
  email?: string;
  firstname?: string;
  lastname?: string;
  partnerref?: string;
  registrantid?: number | string;
  /** ISO 8601 timestamps when present. */
  firstactivity?: string;
  lastactivity?: string;
  /** Total minutes of live attendance (fallback when timestamps are absent). */
  attendanceminutes?: number;
}

interface On24AttendeeList {
  attendees?: On24Attendee[];
}

export class On24Provider implements WebinarProvider {
  readonly name = 'on24';

  constructor(
    private readonly env: Env,
    private readonly portalId: string,
  ) {}

  private async api(method: string, path: string, body?: unknown): Promise<unknown> {
    // ON24 has no OAuth — per-tenant token-key/secret from the encrypted store.
    const creds = await getProviderApiCreds(this.env, this.portalId, 'on24');
    const init: RequestInit = {
      method,
      headers: {
        accessTokenKey: creds.tokenKey,
        accessTokenSecret: creds.tokenSecret,
        'Content-Type': 'application/json',
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const resp = await fetch(
      `${ON24_API}/client/${encodeURIComponent(creds.clientId)}${path}`,
      init,
    );
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`ON24 ${method} ${path} → ${resp.status}: ${detail}`);
    }
    const text = await resp.text();
    return text ? (JSON.parse(text) as unknown) : null;
  }

  // -------------------------------------------------------------------------
  // createWebinar
  // -------------------------------------------------------------------------

  async createWebinar(event: WebinarEventInput): Promise<CreateWebinarResult> {
    const created = (await this.api('POST', '/event', {
      description: event.title,
      eventprofile: 'webcast_elite',
      livestart: event.startsAt,
      liveend: event.endsAt,
    })) as On24Event;

    const eventId = String(created.eventid ?? '');
    return {
      providerWebinarId: eventId,
      providerSessionId: eventId,
      joinUrl: created.audienceurl ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // registerAttendee: stamp OUR id (partnerref); ON24 registrant key is the
  // provider registration id; audienceurl is the personal console link.
  // -------------------------------------------------------------------------

  async registerAttendee(
    webinarId: string,
    attendee: WebinarAttendeeInput,
  ): Promise<RegisterAttendeeResult> {
    const parts = attendee.name.trim().split(/\s+/);
    const reg = (await this.api('POST', `/event/${encodeURIComponent(webinarId)}/registrant`, {
      email: attendee.email,
      firstname: parts[0] || attendee.name,
      lastname: parts.slice(1).join(' ') || attendee.name,
      partnerref: attendee.ourRegistrationId,
    })) as On24Registrant;

    return {
      providerRegistrationId: reg.registrantid != null ? String(reg.registrantid) : null,
      personalJoinUrl: reg.audienceurl ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // Poll-based — no push subscription.
  // -------------------------------------------------------------------------

  async ensureSubscription(_tenant: { portalId: string }): Promise<void> {
    // ON24 has no change-notification channel; the attendance cron polls.
  }

  async handleNotification(_payload: unknown): Promise<PullAttendanceJob[]> {
    return [];
  }

  // -------------------------------------------------------------------------
  // fetchAttendance: Analytics attendee report → normalize
  // -------------------------------------------------------------------------

  async fetchAttendance(webinarId: string, _sessionId: string): Promise<AttendanceRecord[]> {
    const data = (await this.api(
      'GET',
      `/analytics/event/${encodeURIComponent(webinarId)}/attendees`,
    )) as On24AttendeeList;

    return (data.attendees ?? []).map((a) => {
      const minutes = a.attendanceminutes ?? 0;
      // Prefer real activity timestamps; otherwise synthesize a span from minutes
      // anchored at first activity so duration math still works.
      const interval =
        a.firstactivity || a.lastactivity
          ? { join: a.firstactivity ?? null, leave: a.lastactivity ?? null }
          : syntheticInterval(a.firstactivity ?? new Date(0).toISOString(), minutes * 60);

      const name = [a.firstname, a.lastname].filter(Boolean).join(' ');
      return {
        email: a.email ?? null,
        ourRegistrationId: a.partnerref ?? null,
        providerRegistrationId: a.registrantid != null ? String(a.registrantid) : null,
        role: 'Attendee' as const,
        intervals: [interval],
        displayName: name || null,
        engagement: minutes ? { secondsWatched: minutes * 60 } : undefined,
        raw: a,
      };
    });
  }
}
