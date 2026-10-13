/**
 * Worker API client. All calls include the device token as a Bearer token.
 * Throws on non-2xx responses.
 */

import {
  type BatchResponse,
  type ManifestResponse,
  normaliseManifestTickets,
  type StatsResponse,
} from '@paddock/shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function apiFetch<T>(
  serverUrl: string,
  path: string,
  token: string,
  opts?: RequestInit,
): Promise<T> {
  const url = `${serverUrl.replace(/\/$/, '')}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...opts?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export async function fetchManifest(
  serverUrl: string,
  token: string,
  eventId: string,
): Promise<ManifestResponse> {
  const manifest = await apiFetch<ManifestResponse>(
    serverUrl,
    `/api/v1/checkin/manifest/${eventId}`,
    token,
  );
  // The worker and this app deploy on separate commands to separate Cloudflare products,
  // so a scanner on the current build can be pointed at a worker that predates Ref 74d and
  // answers without `answers`. Normalised here for the same reason loadManifest does it:
  // every construction of a StoredManifest is fed from one of these two doors.
  return { ...manifest, tickets: normaliseManifestTickets(manifest.tickets) };
}

// ---------------------------------------------------------------------------
// Batch flush
// ---------------------------------------------------------------------------

export function flushBatch(
  serverUrl: string,
  token: string,
  scans: Array<{ code: string; scannedAt: string }>,
): Promise<BatchResponse> {
  return apiFetch<BatchResponse>(serverUrl, '/api/v1/checkin/batch', token, {
    method: 'POST',
    body: JSON.stringify({ scans }),
  });
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export function fetchStats(
  serverUrl: string,
  token: string,
  eventId: string,
): Promise<StatsResponse> {
  return apiFetch<StatsResponse>(serverUrl, `/api/v1/checkin/stats/${eventId}`, token);
}
