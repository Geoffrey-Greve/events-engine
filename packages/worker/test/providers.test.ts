import { syntheticInterval } from '@paddock/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collapseIntervals } from '../src/attendance';
import { getWebinarProvider } from '../src/providers';
import type { Env } from '../src/types';

// Provider unit tests. Two things are mocked:
//   1. The credential layer (../src/providers/oauth) — these tests verify request
//      shaping + response normalization, not token storage/refresh (that has its
//      own test, oauth.test.ts). getProviderAccessToken/getProviderApiCreds are
//      stubbed to return a fixed token / ON24 creds.
//   2. Outbound HTTP via vi.stubGlobal('fetch', …), asserted per request.

vi.mock('../src/providers/oauth', () => ({
  getProviderAccessToken: vi.fn(async () => 'oauth-access-token'),
  getProviderApiCreds: vi.fn(async () => ({
    clientId: 'oc',
    tokenKey: 'otk',
    tokenSecret: 'ots',
  })),
}));

const PORTAL = '99';

function makeEnv(): Env {
  return { KV: { get: async () => null, put: async () => undefined } } as unknown as Env;
}

/** Mock global fetch with a URL→response router; returns the spy for assertions. */
function mockFetch(routes: Array<{ match: string; body: unknown; status?: number }>) {
  const spy = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error(`unexpected fetch: ${url}`);
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

/** Resolve a provider or fail the test — avoids non-null assertions. */
function requireProvider(env: Env, portalId: string, name: string) {
  const provider = getWebinarProvider(env, portalId, name);
  expect(provider).not.toBeNull();
  if (!provider) throw new Error(`expected ${name} provider`);
  return provider;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

describe('getWebinarProvider', () => {
  const env = makeEnv();

  it.each([
    ['teams'],
    ['meet'],
    ['zoom'],
    ['on24'],
    ['wistia'],
    ['vimeo'],
  ])('resolves %s to a provider whose name matches', (name) => {
    const provider = getWebinarProvider(env, PORTAL, name);
    expect(provider).not.toBeNull();
    expect(provider?.name).toBe(name);
  });

  it('returns null for unknown / null providers', () => {
    expect(getWebinarProvider(env, PORTAL, 'webex')).toBeNull();
    expect(getWebinarProvider(env, PORTAL, null)).toBeNull();
    expect(getWebinarProvider(env, PORTAL, undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Shared video helper
// ---------------------------------------------------------------------------

describe('syntheticInterval', () => {
  it('builds a span of secondsWatched anchored at start', () => {
    const iv = syntheticInterval('2026-01-01T00:00:00.000Z', 600);
    expect(iv.join).toBe('2026-01-01T00:00:00.000Z');
    expect(iv.leave).toBe('2026-01-01T00:10:00.000Z');
    // Flows through the live-pipeline duration math unchanged.
    expect(collapseIntervals([iv]).durationSeconds).toBe(600);
  });

  it('is a zero-length (attended, no watched time) span for <= 0 seconds', () => {
    const iv = syntheticInterval('2026-01-01T00:00:00.000Z', 0);
    expect(iv.join).toBe(iv.leave);
    expect(collapseIntervals([iv]).durationSeconds).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Meet
// ---------------------------------------------------------------------------

describe('MeetProvider', () => {
  it('createWebinar mints a Meet link and captures the meeting code', async () => {
    const spy = mockFetch([
      {
        match: '/calendar/v3/calendars/',
        body: {
          id: 'evt123',
          hangoutLink: 'https://meet.google.com/abc-defg-hij',
          conferenceData: {
            conferenceId: 'conf1',
            entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' }],
          },
        },
      },
    ]);
    const provider = requireProvider(makeEnv(), PORTAL, 'meet');
    const result = await provider.createWebinar({
      portalId: PORTAL,
      eventId: 'e1',
      hubspotEventId: 'he1',
      title: 'Webinar',
      startsAt: '2026-02-01T01:00:00Z',
      endsAt: '2026-02-01T02:00:00Z',
    });
    expect(result.providerWebinarId).toBe('evt123');
    expect(result.providerSessionId).toBe('abc-defg-hij');
    expect(result.joinUrl).toBe('https://meet.google.com/abc-defg-hij');
    // conferenceDataVersion=1 is required for Meet link creation.
    expect(spy.mock.calls[0][0]).toContain('conferenceDataVersion=1');
  });

  it('fetchAttendance normalizes participant sessions to intervals', async () => {
    mockFetch([
      {
        match: '/conferenceRecords?filter',
        body: { conferenceRecords: [{ name: 'conferenceRecords/r1' }] },
      },
      {
        match: 'conferenceRecords/r1/participants',
        body: {
          participants: [
            {
              earliestStartTime: '2026-02-01T01:00:00Z',
              latestEndTime: '2026-02-01T01:45:00Z',
              signedinUser: { user: 'attendee@weld.org', displayName: 'Pat Attendee' },
            },
          ],
        },
      },
    ]);
    const provider = requireProvider(makeEnv(), PORTAL, 'meet');
    const recs = await provider.fetchAttendance('evt123', 'abc-defg-hij');
    expect(recs).toHaveLength(1);
    expect(recs[0].email).toBe('attendee@weld.org');
    expect(recs[0].intervals[0]).toEqual({
      join: '2026-02-01T01:00:00Z',
      leave: '2026-02-01T01:45:00Z',
    });
  });
});

// ---------------------------------------------------------------------------
// Zoom
// ---------------------------------------------------------------------------

describe('ZoomProvider', () => {
  it('createWebinar posts to the webinars endpoint and captures join_url', async () => {
    const spy = mockFetch([
      { match: '/users/me/webinars', body: { id: 987654321, join_url: 'https://zoom.us/j/987' } },
    ]);
    const provider = requireProvider(makeEnv(), PORTAL, 'zoom');
    const result = await provider.createWebinar({
      portalId: PORTAL,
      eventId: 'e1',
      hubspotEventId: 'he1',
      title: 'Z',
      startsAt: '2026-02-01T01:00:00Z',
      endsAt: '2026-02-01T02:00:00Z',
    });
    expect(result.providerWebinarId).toBe('987654321');
    expect(result.joinUrl).toBe('https://zoom.us/j/987');
    expect(spy.mock.calls.some((c) => String(c[0]).includes('/users/me/webinars'))).toBe(true);
  });

  it('registerAttendee returns the registrant id as the provider registration id', async () => {
    mockFetch([
      {
        match: '/webinars/987/registrants',
        body: { registrant_id: 'reg-abc', join_url: 'https://zoom.us/w/personal' },
      },
    ]);
    const provider = requireProvider(makeEnv(), PORTAL, 'zoom');
    const r = await provider.registerAttendee('987', {
      email: 'a@b.com',
      name: 'Sam Smith',
      ourRegistrationId: 'our-1',
    });
    expect(r.providerRegistrationId).toBe('reg-abc');
    expect(r.personalJoinUrl).toBe('https://zoom.us/w/personal');
  });

  it('handleNotification maps a participant event to a pull job; ignores empty', async () => {
    const provider = requireProvider(makeEnv(), PORTAL, 'zoom');
    const jobs = await provider.handleNotification({
      event: 'webinar.participant_joined',
      payload: { object: { id: 987654321 } },
    });
    expect(jobs).toEqual([
      { kind: 'graph.pull_attendance', portalId: PORTAL, webinarId: '987654321' },
    ]);
    expect(await provider.handleNotification({ event: 'x', payload: {} })).toEqual([]);
  });

  it('fetchAttendance normalizes report participants', async () => {
    mockFetch([
      {
        match: '/report/webinars/987/participants',
        body: {
          participants: [
            {
              user_email: 'a@b.com',
              registrant_id: 'reg-abc',
              name: 'Sam',
              join_time: '2026-02-01T01:00:00Z',
              leave_time: '2026-02-01T01:30:00Z',
            },
          ],
        },
      },
    ]);
    const provider = requireProvider(makeEnv(), PORTAL, 'zoom');
    const recs = await provider.fetchAttendance('987', '987');
    expect(recs[0].providerRegistrationId).toBe('reg-abc');
    expect(collapseIntervals(recs[0].intervals).durationSeconds).toBe(30 * 60);
  });
});

// ---------------------------------------------------------------------------
// ON24
// ---------------------------------------------------------------------------

describe('On24Provider', () => {
  it('registerAttendee stamps our id (partnerref) and returns the registrant key', async () => {
    const spy = mockFetch([
      {
        match: '/event/55/registrant',
        body: { registrantid: 42, audienceurl: 'https://on24/console' },
      },
    ]);
    const provider = requireProvider(makeEnv(), PORTAL, 'on24');
    const r = await provider.registerAttendee('55', {
      email: 'a@b.com',
      name: 'Jo Lee',
      ourRegistrationId: 'our-9',
    });
    expect(r.providerRegistrationId).toBe('42');
    expect(r.personalJoinUrl).toBe('https://on24/console');
    expect(JSON.parse(String(spy.mock.calls[0][1]?.body))).toMatchObject({ partnerref: 'our-9' });
  });

  it('fetchAttendance uses real timestamps when present and surfaces our id', async () => {
    mockFetch([
      {
        match: '/analytics/event/55/attendees',
        body: {
          attendees: [
            {
              email: 'a@b.com',
              firstname: 'Jo',
              lastname: 'Lee',
              partnerref: 'our-9',
              registrantid: 42,
              firstactivity: '2026-02-01T01:00:00Z',
              lastactivity: '2026-02-01T01:50:00Z',
              attendanceminutes: 50,
            },
          ],
        },
      },
    ]);
    const provider = requireProvider(makeEnv(), PORTAL, 'on24');
    const recs = await provider.fetchAttendance('55', '55');
    expect(recs[0].ourRegistrationId).toBe('our-9');
    expect(recs[0].intervals[0]).toEqual({
      join: '2026-02-01T01:00:00Z',
      leave: '2026-02-01T01:50:00Z',
    });
    expect(recs[0].engagement?.secondsWatched).toBe(50 * 60);
  });

  it('fetchAttendance synthesizes a span from minutes when timestamps are absent', async () => {
    mockFetch([
      {
        match: '/analytics/event/55/attendees',
        body: { attendees: [{ email: 'c@d.com', attendanceminutes: 20 }] },
      },
    ]);
    const provider = requireProvider(makeEnv(), PORTAL, 'on24');
    const recs = await provider.fetchAttendance('55', '55');
    expect(collapseIntervals(recs[0].intervals).durationSeconds).toBe(20 * 60);
  });
});

// ---------------------------------------------------------------------------
// Wistia (recorded video)
// ---------------------------------------------------------------------------

describe('WistiaProvider', () => {
  it('fetchAttendance groups view sessions per viewer with engagement', async () => {
    mockFetch([
      {
        match: '/stats/events.json',
        body: [
          { email: 'a@b.com', percent_viewed: 0.4, received_at: '2026-02-01T01:00:00Z' },
          { email: 'a@b.com', percent_viewed: 0.9, received_at: '2026-02-01T02:00:00Z' },
        ],
      },
    ]);
    const provider = requireProvider(makeEnv(), PORTAL, 'wistia');
    const recs = await provider.fetchAttendance('media123', 'media123');
    expect(recs).toHaveLength(1);
    expect(recs[0].email).toBe('a@b.com');
    expect(recs[0].engagement?.viewSessions).toBe(2);
    expect(recs[0].engagement?.percentWatched).toBe(0.9);
    // Recorded video counts as attended (zero-length span) regardless of duration.
    expect(recs[0].role).toBe('Attendee');
  });
});

// ---------------------------------------------------------------------------
// Vimeo (live event / video analytics)
// ---------------------------------------------------------------------------

describe('VimeoProvider', () => {
  it('createWebinar extracts the numeric id from the live_events uri', async () => {
    mockFetch([
      {
        match: '/me/live_events',
        body: { uri: '/live_events/12345678', link: 'https://vimeo.com/event/12345678' },
      },
    ]);
    const provider = requireProvider(makeEnv(), PORTAL, 'vimeo');
    const result = await provider.createWebinar({
      portalId: PORTAL,
      eventId: 'e1',
      hubspotEventId: 'he1',
      title: 'V',
      startsAt: '2026-02-01T01:00:00Z',
      endsAt: '2026-02-01T02:00:00Z',
    });
    expect(result.providerWebinarId).toBe('12345678');
    expect(result.joinUrl).toBe('https://vimeo.com/event/12345678');
  });

  it('fetchAttendance maps viewers to engagement + a synthetic span', async () => {
    mockFetch([
      {
        match: '/live_events/12345678/analytics',
        body: {
          data: [
            {
              email: 'a@b.com',
              display_name: 'Al',
              percent: 75,
              seconds_watched: 1200,
              started_at: '2026-02-01T01:00:00Z',
            },
          ],
        },
      },
    ]);
    const provider = requireProvider(makeEnv(), PORTAL, 'vimeo');
    const recs = await provider.fetchAttendance('12345678', '12345678');
    expect(recs[0].engagement?.secondsWatched).toBe(1200);
    expect(collapseIntervals(recs[0].intervals).durationSeconds).toBe(1200);
  });
});
