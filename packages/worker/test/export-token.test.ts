import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  authenticateExportToken,
  DEFAULT_EXPORT_TTL_SECONDS,
  type ExportClaims,
  issueExportToken,
  MAX_EXPORT_TTL_SECONDS,
  MIN_EXPORT_TTL_SECONDS,
} from '../src/exports';
import { exportRoutes } from '../src/routes/exports';
import { manageRoutes } from '../src/routes/manage';
import type { Env } from '../src/types';

/**
 * Phase 2.2 — the CSV download token.
 *
 * The export endpoint is admin-bearer-authed, which a browser download cannot satisfy: a
 * navigation carries no headers, and a HubSpot UI extension has no download primitive. So a
 * staff member gets a short-lived token in a query string, which is a weaker posture than a
 * header and has to earn it. These tests are the terms of that trade:
 *
 *   - one scope, one event, one tenant, and all three checked before a row is read;
 *   - it expires, and an expired one is refused;
 *   - a forged or re-signed token cannot pass;
 *   - it authorises a READ, and nothing else.
 *
 * This is a product, not a Weld deployment: every check here is per-portal, and the
 * cross-tenant cases below are the ones that matter once more than one portal is installed.
 */

const BASE_ENV = env as unknown as Env;

let counter = 0;
function freshIds() {
  const n = `${Date.now()}-${counter++}`;
  return {
    portalId: `exp-${n}`,
    adminKey: `admin-${n}`,
    eventId: `evt-exp-${n}`,
    hubspotEventId: `hs-exp-${n}`,
    ticketTypeId: `tt-exp-${n}`,
  };
}

type Ids = ReturnType<typeof freshIds>;

/**
 * Each portal gets its own signing secret, exactly as a real deployment does — this is what
 * makes the cross-tenant tests meaningful rather than a formality.
 */
function envFor(...all: Ids[]): Env {
  const overrides: Record<string, unknown> = {
    ...(BASE_ENV as unknown as Record<string, unknown>),
  };
  for (const ids of all) {
    overrides[`ADMIN_API_KEY_${ids.portalId}`] = ids.adminKey;
    overrides[`EXPORT_TOKEN_SECRET_${ids.portalId}`] = `export-secret-${ids.portalId}`;
  }
  return overrides as unknown as Env;
}

function adminHeaders(ids: Ids) {
  return { 'X-Portal-Id': ids.portalId, Authorization: `Bearer ${ids.adminKey}` };
}

const tryRun = async (sql: string): Promise<void> => {
  try {
    await BASE_ENV.DB.prepare(sql).run();
  } catch {
    // Already present — another test file created it first.
  }
};

async function seedEvent(ids: Ids, title = 'Welding Fundamentals'): Promise<void> {
  await tryRun(
    `INSERT OR IGNORE INTO tenants (portal_id, display_name) VALUES ('${ids.portalId}', 'Test Tenant')`,
  );
  await BASE_ENV.DB.prepare(
    `INSERT INTO events
       (id, portal_id, hubspot_event_id, title, starts_at, ends_at, capacity, booking_kind,
        category, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, '2026-05-14T00:30:00Z', '2026-05-14T08:30:00Z', 50, 'course',
             'welding', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  )
    .bind(ids.eventId, ids.portalId, ids.hubspotEventId, title)
    .run();
  await BASE_ENV.DB.prepare(
    `INSERT INTO ticket_types
       (id, portal_id, event_id, name, price_cents, currency, capacity, tax_treatment,
        member_only, sort_order, created_at)
     VALUES (?1, ?2, ?3, 'Standard', 83500, 'AUD', 50, 'gst', 0, 0, '2026-01-01T00:00:00Z')`,
  )
    .bind(ids.ticketTypeId, ids.portalId, ids.eventId)
    .run();
  await BASE_ENV.DB.prepare(
    `INSERT INTO orders (id, portal_id, event_id, status, buyer_email, buyer_name,
       total_cents, refunded_cents, currency, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'paid', 'buyer@weld.test', 'Bree Buyer', 83500, 0, 'AUD',
             '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z')`,
  )
    .bind(`${ids.eventId}-ord`, ids.portalId, ids.eventId)
    .run();
  await BASE_ENV.DB.prepare(
    `INSERT INTO registrations
       (id, portal_id, order_id, event_id, ticket_type_id, attendee_email, attendee_name,
        marketing_event_state_synced, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'ada@weld.test', 'Ada Nguyen', 0,
             '2026-04-01T00:00:00Z', '2026-04-01T00:00:00Z')`,
  )
    .bind(`${ids.eventId}-reg`, ids.portalId, `${ids.eventId}-ord`, ids.eventId, ids.ticketTypeId)
    .run();
}

/** Mint through the real HTTP route, the way the card does. */
async function mintViaCard(ids: Ids, e: Env): Promise<{ url: string; expiresAt: string }> {
  const res = await manageRoutes.request(
    `/events/${ids.eventId}/export-token`,
    { method: 'POST', headers: adminHeaders(ids) },
    e,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { url: string; expiresAt: string };
}

/** The path+query of a minted URL, for replaying against the exports sub-app. */
function pathOf(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname.replace('/api/v1/exports', '')}${parsed.search}`;
}

describe('minting a download link', () => {
  it('hands back a self-authorising URL that downloads the CSV', async () => {
    const ids = freshIds();
    const e = envFor(ids);
    await seedEvent(ids);

    const minted = await mintViaCard(ids, e);
    expect(minted.url).toContain('/api/v1/exports/events/');
    expect(minted.url).toContain('token=');
    expect(Date.parse(minted.expiresAt)).toBeGreaterThan(Date.now());

    // No Authorization header — this is a browser following a link.
    const download = await exportRoutes.request(pathOf(minted.url), {}, e);
    expect(download.status).toBe(200);
    expect(download.headers.get('Content-Type')).toContain('text/csv');
    expect(download.headers.get('Content-Disposition')).toContain('attachment');
    expect(await download.text()).toContain('ada@weld.test');
  });

  it('sets headers that keep attendee PII out of caches and referers', async () => {
    const ids = freshIds();
    const e = envFor(ids);
    await seedEvent(ids);

    const minted = await mintViaCard(ids, e);
    const download = await exportRoutes.request(pathOf(minted.url), {}, e);

    // The URL is shareable while the token lives; a cached copy would outlive it.
    expect(download.headers.get('Cache-Control')).toBe('no-store');
    // The token is in the URL — keep it out of anything downstream.
    expect(download.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(download.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('requires admin auth to mint', async () => {
    const ids = freshIds();
    await seedEvent(ids);

    const res = await manageRoutes.request(
      `/events/${ids.eventId}/export-token`,
      { method: 'POST', headers: { 'X-Portal-Id': ids.portalId } },
      envFor(ids),
    );
    expect(res.status).toBe(401);
  });

  it('will not mint for an event belonging to another portal', async () => {
    const owner = freshIds();
    const other = freshIds();
    const e = envFor(owner, other);
    await seedEvent(owner);

    const res = await manageRoutes.request(
      `/events/${owner.eventId}/export-token`,
      { method: 'POST', headers: adminHeaders(other) },
      e,
    );
    expect(res.status).toBe(404);
  });
});

describe('what a leaked token is worth', () => {
  it('is refused without a token at all', async () => {
    const ids = freshIds();
    const e = envFor(ids);
    await seedEvent(ids);

    const res = await exportRoutes.request(`/events/${ids.eventId}/registrations.csv`, {}, e);
    expect(res.status).toBe(401);
  });

  it('is refused once expired', async () => {
    const ids = freshIds();
    const e = envFor(ids);
    await seedEvent(ids);

    // A freshly minted one works.
    const { token } = await issueExportToken(
      e,
      ids.portalId,
      ids.eventId,
      'registrations.csv',
      MIN_EXPORT_TTL_SECONDS,
    );
    expect(
      await authenticateExportToken(e, token, {
        scope: 'registrations.csv',
        eventId: ids.eventId,
      }),
    ).not.toBeNull();

    // The same token a few minutes later — correctly signed with the tenant's own key, and
    // refused. This is what a leaked URL becomes, and how short its usefulness is.
    const stale = await forgeExpired(e, ids.portalId, ids.eventId);
    expect(
      await authenticateExportToken(e, stale, {
        scope: 'registrations.csv',
        eventId: ids.eventId,
      }),
    ).toBeNull();

    const res = await exportRoutes.request(
      `/events/${ids.eventId}/registrations.csv?token=${encodeURIComponent(stale)}`,
      {},
      e,
    );
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('ada@weld.test');
  });

  it('cannot be walked onto another event in the same portal', async () => {
    const ids = freshIds();
    const e = envFor(ids);
    await seedEvent(ids);

    const second = {
      ...ids,
      eventId: `${ids.eventId}-b`,
      hubspotEventId: `${ids.hubspotEventId}-b`,
      ticketTypeId: `${ids.ticketTypeId}-b`,
    };
    await seedEvent(second, 'Welding Inspection');

    const minted = await mintViaCard(ids, e);
    const token = new URL(minted.url).searchParams.get('token') as string;

    // Same tenant, same scope, valid signature — and still refused, because the token
    // names one event. Without that check a staff member with access to one course could
    // download the attendee list of every course in the portal.
    const res = await exportRoutes.request(
      `/events/${second.eventId}/registrations.csv?token=${encodeURIComponent(token)}`,
      {},
      e,
    );
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('ada@weld.test');
  });

  it('cannot cross tenants, even against an event id that exists there', async () => {
    const a = freshIds();
    const b = freshIds();
    const e = envFor(a, b);
    await seedEvent(a);
    await seedEvent(b);

    const minted = await mintViaCard(a, e);
    const token = new URL(minted.url).searchParams.get('token') as string;

    // Portal B's event, portal A's token. The token names its portal and is signed with
    // that portal's key, so it verifies only against A — and A does not own this event.
    const res = await exportRoutes.request(
      `/events/${b.eventId}/registrations.csv?token=${encodeURIComponent(token)}`,
      {},
      e,
    );
    expect(res.status).toBe(401);
  });

  it('cannot be forged by rewriting the claims', async () => {
    const a = freshIds();
    const b = freshIds();
    const e = envFor(a, b);
    await seedEvent(a);
    await seedEvent(b);

    const minted = await mintViaCard(a, e);
    const token = new URL(minted.url).searchParams.get('token') as string;
    const [claimsPart, sig] = token.split('.');
    const claims = JSON.parse(
      atob(claimsPart.replace(/-/g, '+').replace(/_/g, '/')),
    ) as ExportClaims;

    // Point the claims at portal B and keep A's signature. The claims are read before
    // verification (to pick the tenant key), so this is exactly the attack that pattern
    // invites — and the signature no longer matches B's key.
    const forgedClaims = { ...claims, portalId: b.portalId, eid: b.eventId };
    const forged = `${btoa(JSON.stringify(forgedClaims))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')}.${sig}`;

    expect(
      await authenticateExportToken(e, forged, {
        scope: 'registrations.csv',
        eventId: b.eventId,
      }),
    ).toBeNull();
  });

  it('cannot be replayed against a different export scope', async () => {
    const ids = freshIds();
    const e = envFor(ids);
    await seedEvent(ids);

    const { token } = await issueExportToken(e, ids.portalId, ids.eventId, 'registrations.csv');
    // The scope field exists so that adding a second export later cannot be reached by a
    // token minted for this one.
    const wrongScope = await authenticateExportToken(e, token, {
      scope: 'other.csv' as never,
      eventId: ids.eventId,
    });
    expect(wrongScope).toBeNull();
  });

  it('is garbage-rejected rather than throwing', async () => {
    const ids = freshIds();
    const e = envFor(ids);
    await seedEvent(ids);

    for (const bad of ['', 'not-a-token', 'a.b', '....', 'eyJhIjoxfQ.zzzz']) {
      const res = await exportRoutes.request(
        `/events/${ids.eventId}/registrations.csv?token=${encodeURIComponent(bad)}`,
        {},
        e,
      );
      expect(res.status).toBe(401);
    }
  });
});

describe('token lifetime', () => {
  it('clamps a caller-supplied TTL to the allowed window', async () => {
    const ids = freshIds();
    const e = envFor(ids);

    const tooLong = await issueExportToken(
      e,
      ids.portalId,
      ids.eventId,
      'registrations.csv',
      999_999,
    );
    const tooShort = await issueExportToken(e, ids.portalId, ids.eventId, 'registrations.csv', 1);
    const now = Date.now();

    expect(Date.parse(tooLong.expiresAt) - now).toBeLessThanOrEqual(
      MAX_EXPORT_TTL_SECONDS * 1000 + 2000,
    );
    expect(Date.parse(tooShort.expiresAt) - now).toBeGreaterThanOrEqual(
      MIN_EXPORT_TTL_SECONDS * 1000 - 2000,
    );
  });

  it('defaults to minutes, not hours', () => {
    // A link minted on click and spent seconds later. Anything longer is exposure bought
    // for nobody's benefit.
    expect(DEFAULT_EXPORT_TTL_SECONDS).toBeLessThanOrEqual(15 * 60);
  });
});

/**
 * A correctly-signed token whose expiry has already passed — the thing a leaked URL becomes
 * a few minutes after it leaks. Built by signing with the same tenant key rather than by
 * waiting, so the test stays fast and deterministic.
 */
async function forgeExpired(e: Env, portalId: string, eventId: string): Promise<string> {
  const { mintSignedToken } = await import('../src/checkin');
  const past = Math.floor(Date.now() / 1000) - 10;
  const claims: ExportClaims = {
    v: 1,
    portalId,
    scope: 'registrations.csv',
    eid: eventId,
    iat: past - 60,
    exp: past,
  };
  const secret = (e as unknown as Record<string, string>)[`EXPORT_TOKEN_SECRET_${portalId}`];
  return mintSignedToken(secret, claims);
}
