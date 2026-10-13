/**
 * VimeoProvider — Vimeo implementation of WebinarProvider (live event / video).
 *
 * createWebinar provisions a Vimeo live event so the worker owns the id + link.
 * "Attendance" is view analytics (per-viewer watch data), normalized to
 * {@link VideoEngagement} plus a synthetic interval (see syntheticInterval) so the
 * shared attended/no-show + me.attend pipeline is unchanged.
 *
 * Attendance is PULL via the analytics API (no push channel). Vimeo has no
 * registration object, so matching falls back to the viewer email when present.
 *
 * Auth: Vimeo OAuth access token (per-tenant).
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

const VIMEO_API = 'https://api.vimeo.com';

interface VimeoLiveEvent {
  uri?: string;
  link?: string;
}

/** One viewer row from the analytics endpoint. */
interface VimeoViewerRow {
  email?: string | null;
  display_name?: string | null;
  percent?: number;
  seconds_watched?: number;
  started_at?: string;
}

interface VimeoAnalytics {
  data?: VimeoViewerRow[];
}

/** Vimeo uris look like `/live_events/12345678`; we persist the numeric id. */
function idFromUri(uri: string | undefined): string {
  if (!uri) return '';
  const m = uri.match(/\/(\d+)(?:$|[/?])/);
  return m ? m[1] : uri;
}

export class VimeoProvider implements WebinarProvider {
  readonly name = 'vimeo';

  constructor(
    private readonly env: Env,
    private readonly portalId: string,
  ) {}

  private async api(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = await getProviderAccessToken(this.env, this.portalId, 'vimeo');
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.vimeo.*+json;version=3.4',
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const resp = await fetch(`${VIMEO_API}${path}`, init);
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      throw new Error(`Vimeo ${method} ${path} → ${resp.status}: ${detail}`);
    }
    const text = await resp.text();
    return text ? (JSON.parse(text) as unknown) : null;
  }

  // -------------------------------------------------------------------------
  // createWebinar: provision a Vimeo live event
  // -------------------------------------------------------------------------

  async createWebinar(event: WebinarEventInput): Promise<CreateWebinarResult> {
    const live = (await this.api('POST', '/me/live_events', {
      title: event.title,
      automatically_title_stream: false,
    })) as VimeoLiveEvent;

    const id = idFromUri(live.uri);
    return {
      providerWebinarId: id,
      providerSessionId: id,
      joinUrl: live.link ?? null,
    };
  }

  async registerAttendee(
    _webinarId: string,
    _attendee: WebinarAttendeeInput,
  ): Promise<RegisterAttendeeResult> {
    return { providerRegistrationId: null, personalJoinUrl: null };
  }

  async ensureSubscription(_tenant: { portalId: string }): Promise<void> {
    // Analytics are polled by the attendance cron; no push channel.
  }

  async handleNotification(_payload: unknown): Promise<PullAttendanceJob[]> {
    return [];
  }

  // -------------------------------------------------------------------------
  // fetchAttendance: analytics viewers → engagement + synthetic span
  // -------------------------------------------------------------------------

  async fetchAttendance(webinarId: string, _sessionId: string): Promise<AttendanceRecord[]> {
    if (!webinarId) return [];
    const analytics = (await this.api(
      'GET',
      `/live_events/${encodeURIComponent(webinarId)}/analytics?dimension=viewer`,
    )) as VimeoAnalytics;

    return (analytics.data ?? []).map((v) => {
      const seconds = v.seconds_watched ?? 0;
      const anchor = v.started_at ?? new Date().toISOString();
      return {
        email: v.email ?? null,
        ourRegistrationId: null,
        providerRegistrationId: null,
        role: 'Attendee' as const,
        intervals: [syntheticInterval(anchor, seconds)],
        displayName: v.display_name ?? null,
        engagement: {
          percentWatched: v.percent,
          secondsWatched: seconds || undefined,
          viewSessions: 1,
        },
        raw: v,
      };
    });
  }
}
