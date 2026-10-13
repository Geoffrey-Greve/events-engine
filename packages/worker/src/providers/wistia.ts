/**
 * WistiaProvider — Wistia implementation of WebinarProvider (recorded video).
 *
 * Wistia is on-demand video, not a live webinar: "attendance" is view analytics
 * (who watched, how much), not join/leave intervals. createWebinar provisions a
 * Wistia project to hold the event's recording; the per-event media hashed id is
 * what fetchAttendance reads (persisted as the provider webinar/session id once
 * the recording is uploaded).
 *
 * Attendance is PULL via the Stats API (one row per view session). Records carry
 * {@link VideoEngagement} plus a synthetic interval (see syntheticInterval) so the
 * shared attended/no-show + me.attend pipeline stays unchanged. Wistia has no
 * registration object, so matching falls back to the viewer email it captures.
 *
 * Auth: per-tenant OAuth token from the connect flow (./oauth.ts).
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
import { syntheticInterval } from './types';

const WISTIA_API = 'https://api.wistia.com/v1';

interface WistiaProject {
  hashedId?: string;
  hashed_id?: string;
}

/** One view session from GET /stats/events.json. */
interface WistiaEvent {
  email?: string | null;
  percent_viewed?: number;
  received_at?: string;
  visitor_key?: string;
}

export class WistiaProvider implements WebinarProvider {
  readonly name = 'wistia';

  constructor(
    private readonly env: Env,
    private readonly portalId: string,
  ) {}

  private async api(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = await getProviderAccessToken(this.env, this.portalId, 'wistia');
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const resp = await fetch(`${WISTIA_API}${path}`, init);
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`Wistia ${method} ${path} → ${resp.status}: ${detail}`);
    }
    const text = await resp.text();
    return text ? (JSON.parse(text) as unknown) : null;
  }

  // -------------------------------------------------------------------------
  // createWebinar: provision a project to hold the recording
  // -------------------------------------------------------------------------

  async createWebinar(event: WebinarEventInput): Promise<CreateWebinarResult> {
    const project = (await this.api('POST', '/projects.json', {
      name: event.title,
    })) as WistiaProject;
    const hashedId = project.hashedId ?? project.hashed_id ?? '';
    return {
      providerWebinarId: hashedId,
      providerSessionId: hashedId,
      joinUrl: hashedId ? `https://fast.wistia.net/embed/channel/${hashedId}` : null,
    };
  }

  // -------------------------------------------------------------------------
  // No registration object — matching is by the viewer email Wistia captures.
  // -------------------------------------------------------------------------

  async registerAttendee(
    _webinarId: string,
    _attendee: WebinarAttendeeInput,
  ): Promise<RegisterAttendeeResult> {
    return { providerRegistrationId: null, personalJoinUrl: null };
  }

  async ensureSubscription(_tenant: { portalId: string }): Promise<void> {
    // Stats are polled by the attendance cron; no push channel.
  }

  async handleNotification(_payload: unknown): Promise<PullAttendanceJob[]> {
    return [];
  }

  // -------------------------------------------------------------------------
  // fetchAttendance: Stats events → group by viewer → engagement + synthetic span
  // -------------------------------------------------------------------------

  async fetchAttendance(webinarId: string, _sessionId: string): Promise<AttendanceRecord[]> {
    if (!webinarId) return [];
    const events = (await this.api(
      'GET',
      `/stats/events.json?media_id=${encodeURIComponent(webinarId)}&per_page=100`,
    )) as WistiaEvent[];

    // One Wistia event = one view session; collapse to one record per viewer.
    const byViewer = new Map<string, { email: string | null; events: WistiaEvent[] }>();
    for (const ev of events ?? []) {
      const key = (ev.email ?? '').toLowerCase() || ev.visitor_key || crypto.randomUUID();
      const entry = byViewer.get(key);
      if (entry) entry.events.push(ev);
      else byViewer.set(key, { email: ev.email ?? null, events: [ev] });
    }

    const out: AttendanceRecord[] = [];
    for (const { email, events: evs } of byViewer.values()) {
      const percentWatched = Math.max(...evs.map((e) => e.percent_viewed ?? 0));
      const anchor =
        evs
          .map((e) => e.received_at)
          .filter(Boolean)
          .sort()[0] ?? new Date().toISOString();
      out.push({
        email,
        ourRegistrationId: null,
        providerRegistrationId: null,
        role: 'Attendee',
        // Zero-length span: a view counts as "attended" regardless of duration;
        // richer watch data lives in engagement.
        intervals: [syntheticInterval(anchor, 0)],
        displayName: null,
        engagement: { percentWatched, viewSessions: evs.length },
        raw: evs,
      });
    }
    return out;
  }
}
