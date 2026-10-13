/**
 * HubSpot v3 request signature verification.
 *
 * HubSpot UI extension `hubspot.fetch()` requests are signed with the app client
 * secret and include the full request URL in the signature base string.
 */

const HUBSPOT_SIGNATURE_QUERY_DECODE_MAP: Record<string, string> = {
  '%3A': ':',
  '%2F': '/',
  '%3F': '?',
  '%40': '@',
  '%21': '!',
  '%24': '$',
  '%27': "'",
  '%28': '(',
  '%29': ')',
  '%2A': '*',
  '%2C': ',',
  '%3B': ';',
};

const HUBSPOT_SIGNATURE_QUERY_PATTERN = /%3A|%2F|%3F|%40|%21|%24|%27|%28|%29|%2A|%2C|%3B/g;

export function normalizeHubSpotSignatureUrl(url: string): string {
  const withoutFragment = url.split('#')[0] ?? url;
  const queryIndex = withoutFragment.indexOf('?');
  if (queryIndex === -1) return withoutFragment;

  const path = withoutFragment.slice(0, queryIndex + 1);
  const query = withoutFragment
    .slice(queryIndex + 1)
    .replace(
      HUBSPOT_SIGNATURE_QUERY_PATTERN,
      (match) => HUBSPOT_SIGNATURE_QUERY_DECODE_MAP[match] ?? match,
    );
  return `${path}${query}`;
}

export async function verifyHubSpotV3Signature(
  method: string,
  url: string,
  rawBody: string,
  timestamp: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) return false;

  // Replay protection: HubSpot recommends rejecting stale signed requests.
  if (Math.abs(Date.now() - ts) > 5 * 60 * 1000) return false;

  const source = `${method}${normalizeHubSpotSignatureUrl(url)}${rawBody}${timestamp}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );

  let signatureBytes: Uint8Array;
  try {
    signatureBytes = Uint8Array.from(atob(signature), (char) => char.charCodeAt(0));
  } catch {
    return false;
  }

  return crypto.subtle.verify('HMAC', key, signatureBytes, encoder.encode(source));
}
