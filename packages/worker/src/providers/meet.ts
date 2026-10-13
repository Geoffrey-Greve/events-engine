/**
 * MeetProvider — Google Meet implementation of WebinarProvider (poll-based).
 *
 * Google has no first-class "webinar" object, so a Meet event is a Google
 * Calendar event with a Meet conference attached (conferenceDataVersion=1). The
 * worker owns the calendar event id (providerWebinarId) and the Meet meeting
 * code (providerSessionId) so it can pull attendance later.
 *
 * Attendance is PULL (Meet Reports / conferenceRecords API): there is no native
 * registration, so we cannot stamp OUR registration id onto a participant — the
 * shared pipeline falls back to email matching. Participant emails are only
 * exposed for in-domain signed-in users; external attendees land in
 * attendance_unmatched (audited), which is an inherent Meet limitation.
 *
 * Auth: per-tenant OAuth token from the connect flow (./oauth.ts). Each customer
 * authorizes OUR Google app once; tokens (incl. refresh) are stored encrypted and
 * refreshed transparently. (TODO(provisioning): Workspace Events push
 * subscriptions can later replace polling for domains that grant the scope.)
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

const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';
const MEET_BASE = 'https://meet.googleapis.com/v2';
/** The authorizing user's primary calendar (OAuth token is scoped to them). */
const CALENDAR_ID = 'primary';

// ---------------------------------------------------------------------------
// Raw response shapes (only the fields we read)
// ---------------------------------------------------------------------------

interface CalendarEntryPoint {
  entryPointType?: string;
  uri?: string;
}

interface CalendarEvent {
  id: string;
  hangoutLink?: string;
  conferenceData?: {
    conferenceId?: string;
    entryPoints?: CalendarEntryPoint[];
  };
}

interface MeetParticipant {
  name?: string;
  earliestStartTime?: string;
  latestEndTime?: string;
  signedinUser?: { user?: string; displayName?: string };
  anonymousUser?: { displayName?: string };
  phoneUser?: { displayName?: string };
}

interface MeetParticipantList {
  participants?: MeetParticipant[];
}

interface MeetConferenceRecord {
  name?: string;
}

interface MeetConferenceRecordList {
  conferenceRecords?: MeetConferenceRecord[];
}

// ---------------------------------------------------------------------------

/** Parse the Meet meeting code (abc-defg-hij) out of a https://meet.google.com/… URL. */
function meetingCodeFromUrl(uri: string | undefined): string {
  if (!uri) return '';
  const m = uri.match(/meet\.google\.com\/([a-z0-9-]+)/i);
  return m ? m[1] : '';
}

function participantName(p: MeetParticipant): string | null {
  return (
    p.signedinUser?.displayName ?? p.anonymousUser?.displayName ?? p.phoneUser?.displayName ?? null
  );
}

export class MeetProvider implements WebinarProvider {
  readonly name = 'meet';

  constructor(
    private readonly env: Env,
    private readonly portalId: string,
  ) {}

  // -------------------------------------------------------------------------
  // Auth: per-tenant OAuth token from the connect flow (refreshed transparently)
  // -------------------------------------------------------------------------

  private async api(method: string, url: string, body?: unknown): Promise<unknown> {
    const token = await getProviderAccessToken(this.env, this.portalId, 'meet');
    const init: RequestInit = {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const resp = await fetch(url, init);
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`Meet ${method} ${url} → ${resp.status}: ${detail}`);
    }
    const text = await resp.text();
    return text ? (JSON.parse(text) as unknown) : null;
  }

  // -------------------------------------------------------------------------
  // createWebinar: Calendar event + attached Meet conference
  // -------------------------------------------------------------------------

  async createWebinar(event: WebinarEventInput): Promise<CreateWebinarResult> {
    const created = (await this.api(
      'POST',
      `${CALENDAR_BASE}/calendars/${encodeURIComponent(CALENDAR_ID)}/events?conferenceDataVersion=1`,
      {
        summary: event.title,
        start: { dateTime: event.startsAt, timeZone: 'UTC' },
        end: { dateTime: event.endsAt, timeZone: 'UTC' },
        // Stamp our internal event id so the calendar event is traceable back to us.
        extendedProperties: { private: { paddockEventId: event.eventId } },
        conferenceData: {
          createRequest: {
            requestId: `paddock-${event.eventId}`,
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        },
      },
    )) as CalendarEvent;

    const video = created.conferenceData?.entryPoints?.find((e) => e.entryPointType === 'video');
    const joinUrl = video?.uri ?? created.hangoutLink ?? null;

    return {
      providerWebinarId: created.id,
      // We pull attendance by meeting code, so persist it as the session id.
      providerSessionId: meetingCodeFromUrl(joinUrl ?? undefined),
      joinUrl,
    };
  }

  // -------------------------------------------------------------------------
  // registerAttendee: add the attendee to the calendar event (best effort).
  // Meet has no registration object, so there is no provider registration id and
  // the join URL is the (shared) meeting link already stored on the event.
  // -------------------------------------------------------------------------

  async registerAttendee(
    webinarId: string,
    attendee: WebinarAttendeeInput,
  ): Promise<RegisterAttendeeResult> {
    try {
      const current = (await this.api(
        'GET',
        `${CALENDAR_BASE}/calendars/${encodeURIComponent(CALENDAR_ID)}/events/${encodeURIComponent(
          webinarId,
        )}`,
      )) as { attendees?: Array<{ email: string }> };
      const attendees = current.attendees ?? [];
      if (!attendees.some((a) => a.email.toLowerCase() === attendee.email.toLowerCase())) {
        attendees.push({ email: attendee.email });
        await this.api(
          'PATCH',
          `${CALENDAR_BASE}/calendars/${encodeURIComponent(
            CALENDAR_ID,
          )}/events/${encodeURIComponent(webinarId)}?sendUpdates=none`,
          { attendees },
        );
      }
    } catch {
      // Non-fatal — HubSpot still owns the invite; attendance falls back to email.
    }
    return { providerRegistrationId: null, personalJoinUrl: null };
  }

  // -------------------------------------------------------------------------
  // ensureSubscription / handleNotification: poll-based — no push subscription.
  // -------------------------------------------------------------------------

  async ensureSubscription(_tenant: { portalId: string }): Promise<void> {
    // Meet is polled by the attendance cron; no change-notification subscription.
    // TODO(provisioning): Workspace Events push subscriptions can replace polling.
  }

  async handleNotification(_payload: unknown): Promise<PullAttendanceJob[]> {
    return [];
  }

  // -------------------------------------------------------------------------
  // fetchAttendance: conferenceRecords for the meeting code → participants → normalize
  // -------------------------------------------------------------------------

  async fetchAttendance(_webinarId: string, sessionId: string): Promise<AttendanceRecord[]> {
    if (!sessionId) return [];

    const recordList = (await this.api(
      'GET',
      `${MEET_BASE}/conferenceRecords?filter=${encodeURIComponent(
        `space.meeting_code="${sessionId}"`,
      )}`,
    )) as MeetConferenceRecordList;

    const out: AttendanceRecord[] = [];
    for (const record of recordList.conferenceRecords ?? []) {
      if (!record.name) continue;
      const list = (await this.api(
        'GET',
        `${MEET_BASE}/${record.name}/participants`,
      )) as MeetParticipantList;

      for (const p of list.participants ?? []) {
        out.push({
          // Meet exposes a person resource id, not an email, for signed-in users;
          // email matching only works when the resource id is itself an email.
          email: p.signedinUser?.user ?? null,
          ourRegistrationId: null,
          providerRegistrationId: null,
          role: 'Attendee',
          intervals: [{ join: p.earliestStartTime ?? null, leave: p.latestEndTime ?? null }],
          displayName: participantName(p),
          raw: p,
        });
      }
    }
    return out;
  }
}
