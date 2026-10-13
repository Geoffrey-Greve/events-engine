/**
 * TeamsProvider — Microsoft Graph implementation of WebinarProvider.
 *
 * Teams specifics encoded here (CLAUDE.md "Microsoft Teams"):
 *  - The worker creates the webinar via Graph so it owns the IDs; the webinar is
 *    created in DRAFT and must be published.
 *  - Teams' own attendee emails are disabled — HubSpot owns the invite/confirmation.
 *  - Attendance is PULL: a tenant-wide change-notification subscription on
 *    solutions/virtualEvents/events signals "report ready"; we then pull
 *    attendanceReports → attendanceRecords ($expand) and normalize.
 *  - Our registration id is stamped at register time via
 *    externalRegistrationInformation.registrationId so matching is exact.
 */

import { getSecret } from '../config';
import { getGraphToken, graphFetch } from '../graph';
import { getMicrosoftDelegatedGraphToken } from '../microsoft-graph';
import type { Env } from '../types';
import type {
  AttendanceRecord,
  CreateWebinarResult,
  PullAttendanceJob,
  RegisterAttendeeResult,
  WebinarAttendeeInput,
  WebinarEventInput,
  WebinarProvider,
} from './types';

const VE = '/solutions/virtualEvents';
/** Tenant-wide subscriptions on this resource have a ~1-day max lifetime. */
const SUBSCRIPTION_TTL_MS = 23 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Raw Graph response shapes (only the fields we read)
// ---------------------------------------------------------------------------

interface GraphWebinar {
  id: string;
}

interface GraphSession {
  id: string;
  joinWebUrl?: string;
}

interface GraphSessionList {
  value?: GraphSession[];
}

interface GraphRegistration {
  id?: string;
  joinWebUrl?: string;
  registrant?: { joinWebUrl?: string };
}

interface GraphSubscription {
  id: string;
  expirationDateTime: string;
}

interface CachedSubscription {
  id: string;
  expirationDateTime: string;
}

interface GraphAttendanceInterval {
  joinDateTime?: string;
  leaveDateTime?: string;
}

interface GraphAttendanceRecord {
  emailAddress?: string;
  role?: string;
  registrantId?: string;
  totalAttendanceInSeconds?: number;
  attendanceIntervals?: GraphAttendanceInterval[];
  identity?: { displayName?: string };
  externalRegistrationInformation?: { registrationId?: string };
}

interface GraphAttendanceReport {
  attendanceRecords?: GraphAttendanceRecord[];
}

interface GraphAttendanceReportList {
  value?: GraphAttendanceReport[];
}

interface GraphNotification {
  subscriptionId?: string;
  clientState?: string;
  changeType?: string;
  resource?: string;
  resourceData?: { id?: string };
  lifecycleEvent?: string;
}

// ---------------------------------------------------------------------------
// Timing-safe string comparison (avoids early-exit leaks on secret comparisons)
// ---------------------------------------------------------------------------

function timingSafeEqualStr(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  const maxLen = Math.max(aBytes.length, bBytes.length);
  // XOR length difference in so a shorter/longer string never returns true.
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < maxLen; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------

function splitName(name: string): { firstName: string; lastName: string } {
  const parts = name.trim().split(/\s+/);
  const firstName = parts[0] || name;
  const lastName = parts.slice(1).join(' ') || name;
  return { firstName, lastName };
}

/** Graph dateTimeTimeZone wants the local datetime + a separate zone. */
function toGraphDateTime(iso: string): { dateTime: string; timeZone: string } {
  return { dateTime: iso.replace(/Z$/, ''), timeZone: 'UTC' };
}

/**
 * Extract the virtualEvent (webinar) id from a notification resource/resourceData.
 * Handles both `solutions/virtualEvents/events/{id}` and `…events('{id}')` forms.
 */
function parseWebinarId(notification: GraphNotification): string | null {
  const fromData = notification.resourceData?.id;
  if (fromData) return fromData;
  const resource = notification.resource;
  if (!resource) return null;
  const m = resource.match(/events(?:\/|\(['"]?)([^/'")]+)/i);
  return m ? m[1] : null;
}

export class TeamsProvider implements WebinarProvider {
  readonly name = 'teams';

  constructor(
    private readonly env: Env,
    private readonly portalId: string,
  ) {}

  // -------------------------------------------------------------------------
  // createWebinar: draft → publish → capture webinar/session/join
  // -------------------------------------------------------------------------

  async createWebinar(event: WebinarEventInput): Promise<CreateWebinarResult> {
    const token = await getMicrosoftDelegatedGraphToken(this.env, this.portalId);

    // 1. Create in DRAFT. Disable Teams' own attendee email notifications so
    //    HubSpot remains the sole source of invites/confirmations.
    const webinar = (await graphFetch(token, 'POST', `${VE}/webinars`, {
      displayName: event.title,
      startDateTime: toGraphDateTime(event.startsAt),
      endDateTime: toGraphDateTime(event.endsAt),
      audience: 'everyone',
      isManualApprovalEnabled: false,
      settings: { isAttendeeEmailNotificationEnabled: false },
    })) as GraphWebinar;

    // 2. Publish (a draft webinar accepts no registrations until published).
    await graphFetch(token, 'POST', `${VE}/webinars/${encodeURIComponent(webinar.id)}/publish`);

    // 3. Capture the (auto-created) session id + generic join URL.
    const sessions = (await graphFetch(
      token,
      'GET',
      `${VE}/webinars/${encodeURIComponent(webinar.id)}/sessions`,
    )) as GraphSessionList;
    const session = sessions.value?.[0];

    return {
      providerWebinarId: webinar.id,
      providerSessionId: session?.id ?? '',
      joinUrl: session?.joinWebUrl ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // registerAttendee: stamp our id; return personal join URL
  // -------------------------------------------------------------------------

  async registerAttendee(
    webinarId: string,
    attendee: WebinarAttendeeInput,
  ): Promise<RegisterAttendeeResult> {
    // Keep attendee registration on app-only auth: Graph's delegated webinar
    // registration shape is for registering the signed-in user, while our public
    // checkout needs to register arbitrary external attendees by name/email.
    const token = await getGraphToken(this.env, this.portalId);
    const { firstName, lastName } = splitName(attendee.name);

    const reg = (await graphFetch(
      token,
      'POST',
      `${VE}/webinars/${encodeURIComponent(webinarId)}/registrations`,
      {
        firstName,
        lastName,
        email: attendee.email,
        preferredTimezone: 'AUS Eastern Standard Time',
        preferredLanguage: 'en-us',
        // CLAUDE.md: stamp OUR registration id so attendance matching is exact.
        externalRegistrationInformation: { registrationId: attendee.ourRegistrationId },
      },
    )) as GraphRegistration | null;

    return {
      providerRegistrationId: reg?.id ?? null,
      personalJoinUrl: reg?.joinWebUrl ?? reg?.registrant?.joinWebUrl ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // cancelRegistration: remove an attendee's webinar registration (transfer)
  // -------------------------------------------------------------------------

  async cancelRegistration(webinarId: string, providerRegistrationId: string): Promise<void> {
    const token = await getGraphToken(this.env, this.portalId);
    await graphFetch(
      token,
      'DELETE',
      `${VE}/webinars/${encodeURIComponent(webinarId)}/registrations/${encodeURIComponent(providerRegistrationId)}`,
    );
  }

  // -------------------------------------------------------------------------
  // ensureSubscription: ONE tenant-wide sub, ~23h expiry, renew-or-create
  // -------------------------------------------------------------------------

  async ensureSubscription(_tenant: { portalId: string }): Promise<void> {
    const token = await getGraphToken(this.env, this.portalId);
    const subKey = `graph:sub:${this.portalId}`;
    const newExpiry = new Date(Date.now() + SUBSCRIPTION_TTL_MS).toISOString();

    const raw = await this.env.KV.get(subKey);
    if (raw) {
      const sub = JSON.parse(raw) as CachedSubscription;
      try {
        // Renew in place (also satisfies a reauthorizationRequired lifecycle event).
        const renewed = (await graphFetch(token, 'PATCH', `/subscriptions/${sub.id}`, {
          expirationDateTime: newExpiry,
        })) as GraphSubscription;
        await this.cacheSubscription(subKey, renewed.id, renewed.expirationDateTime);
        return;
      } catch {
        // Subscription gone (404) or otherwise unrenewable — fall through to recreate.
      }
    }

    const clientState = getSecret(this.env, `GRAPH_SUBSCRIPTION_CLIENT_STATE_${this.portalId}`);
    const notificationUrl = getSecret(this.env, `GRAPH_NOTIFICATION_URL_${this.portalId}`);

    const created = (await graphFetch(token, 'POST', '/subscriptions', {
      changeType: 'created,updated',
      notificationUrl,
      lifecycleNotificationUrl: notificationUrl,
      resource: 'solutions/virtualEvents/events',
      expirationDateTime: newExpiry,
      clientState,
    })) as GraphSubscription;

    await this.cacheSubscription(subKey, created.id, created.expirationDateTime);
  }

  private async cacheSubscription(
    subKey: string,
    id: string,
    expirationDateTime: string,
  ): Promise<void> {
    await this.env.KV.put(subKey, JSON.stringify({ id, expirationDateTime }));
    // Reverse map so the webhook route can resolve subscriptionId → portalId.
    await this.env.KV.put(`graph:sub-portal:${id}`, this.portalId);
  }

  // -------------------------------------------------------------------------
  // handleNotification: verify clientState, lifecycle handling, emit pull jobs
  // -------------------------------------------------------------------------

  async handleNotification(payload: unknown): Promise<PullAttendanceJob[]> {
    const body = payload as { value?: GraphNotification[] };
    const notifications = body.value ?? [];
    const expectedClientState = getSecret(
      this.env,
      `GRAPH_SUBSCRIPTION_CLIENT_STATE_${this.portalId}`,
    );

    const jobs: PullAttendanceJob[] = [];
    const seen = new Set<string>();

    for (const n of notifications) {
      // Reject anything whose clientState doesn't match what we set (timing-safe).
      if (!timingSafeEqualStr(n.clientState ?? '', expectedClientState)) continue;

      if (n.lifecycleEvent) {
        if (
          n.lifecycleEvent === 'reauthorizationRequired' ||
          n.lifecycleEvent === 'subscriptionRemoved'
        ) {
          // Renew (or recreate) the subscription so we keep receiving notifications.
          await this.ensureSubscription({ portalId: this.portalId });
        } else if (n.lifecycleEvent === 'missed') {
          // We may have missed report-ready signals — catch up on all live webinars.
          for (const job of await this.catchUpJobs()) {
            if (!seen.has(job.webinarId)) {
              seen.add(job.webinarId);
              jobs.push(job);
            }
          }
        }
        continue;
      }

      const webinarId = parseWebinarId(n);
      if (webinarId && !seen.has(webinarId)) {
        seen.add(webinarId);
        // The pull is idempotent and gates on report availability, so enqueuing
        // on any change is safe (missed-webhook cron is the backstop).
        jobs.push({ kind: 'graph.pull_attendance', portalId: this.portalId, webinarId });
      }
    }

    return jobs;
  }

  /** All not-yet-completed Teams webinars for this tenant (missed-notification catch-up). */
  private async catchUpJobs(): Promise<PullAttendanceJob[]> {
    const rows = await this.env.DB.prepare(
      `SELECT teams_webinar_id FROM events
       WHERE portal_id = ?1 AND provider = 'teams'
         AND teams_webinar_id IS NOT NULL AND marketing_event_completed = 0`,
    )
      .bind(this.portalId)
      .all<{ teams_webinar_id: string }>();

    return rows.results.map((r) => ({
      kind: 'graph.pull_attendance' as const,
      portalId: this.portalId,
      webinarId: r.teams_webinar_id,
    }));
  }

  // -------------------------------------------------------------------------
  // fetchAttendance: list reports for the session, $expand records, normalize
  // -------------------------------------------------------------------------

  async fetchAttendance(webinarId: string, sessionId: string): Promise<AttendanceRecord[]> {
    if (!sessionId) return [];
    const token = await getGraphToken(this.env, this.portalId);

    const data = (await graphFetch(
      token,
      'GET',
      `${VE}/webinars/${encodeURIComponent(webinarId)}/sessions/${encodeURIComponent(
        sessionId,
      )}/attendanceReports?$expand=attendanceRecords`,
    )) as GraphAttendanceReportList;

    const out: AttendanceRecord[] = [];
    for (const report of data.value ?? []) {
      for (const rec of report.attendanceRecords ?? []) {
        // Only registered attendees count — drop presenters/organizers.
        if (rec.role !== 'Attendee') continue;
        out.push({
          email: rec.emailAddress ?? null,
          ourRegistrationId: rec.externalRegistrationInformation?.registrationId ?? null,
          providerRegistrationId: rec.registrantId ?? null,
          role: rec.role,
          intervals: (rec.attendanceIntervals ?? []).map((iv) => ({
            join: iv.joinDateTime ?? null,
            leave: iv.leaveDateTime ?? null,
          })),
          displayName: rec.identity?.displayName ?? null,
          raw: rec,
        });
      }
    }
    return out;
  }
}
