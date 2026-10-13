/**
 * Microsoft Graph low-level client.
 *
 * - Client-credentials token per tenant, cached in KV (CLAUDE.md: "KV = Graph
 *   token + subscription id cache"). One Azure AD app per HubSpot portal; secrets
 *   follow the {PREFIX}_{portalId} convention.
 * - graphFetch is a thin typed wrapper; callers cast the JSON to the shape they
 *   expect. Non-2xx throws GraphError so cron/queue callers can catch + retry.
 */

import { getSecret } from './config';
import {
  appendMicrosoftClientAssertion,
  buildMicrosoftClientAssertion,
  type MicrosoftCertificateCredential,
} from './microsoft-client-assertion';
import { decryptToken } from './token-crypto';
import type { Env } from './types';

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export class GraphError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
}

export interface GraphCredentials {
  aadTenantId: string;
  clientId: string;
  clientSecret?: string;
  certificate?: MicrosoftCertificateCredential;
}

interface WebinarCredsRow {
  webinar_provider: string | null;
  webinar_creds_enc: string | null;
}

interface StoredWebinarCreds {
  provider?: string;
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function optionalSecret(env: Env, name: string): string | null {
  try {
    const value = getSecret(env, name);
    return value.trim() ? value : null;
  } catch {
    return null;
  }
}

function normalizePemSecret(value: string): string {
  return value.replace(/\\n/g, '\n').trim();
}

function getGraphCertificateCredential(
  env: Env,
  portalId: string,
): MicrosoftCertificateCredential | null {
  const privateKeyPem =
    optionalSecret(env, `GRAPH_CLIENT_CERT_PRIVATE_KEY_${portalId}`) ??
    optionalSecret(env, `MICROSOFT_CLIENT_CERT_PRIVATE_KEY_${portalId}`) ??
    optionalSecret(env, 'GRAPH_CLIENT_CERT_PRIVATE_KEY') ??
    optionalSecret(env, 'MICROSOFT_CLIENT_CERT_PRIVATE_KEY');

  const thumbprint =
    optionalSecret(env, `GRAPH_CLIENT_CERT_THUMBPRINT_${portalId}`) ??
    optionalSecret(env, `MICROSOFT_CLIENT_CERT_THUMBPRINT_${portalId}`) ??
    optionalSecret(env, 'GRAPH_CLIENT_CERT_THUMBPRINT') ??
    optionalSecret(env, 'MICROSOFT_CLIENT_CERT_THUMBPRINT');

  if (!privateKeyPem && !thumbprint) return null;
  if (!privateKeyPem || !thumbprint) {
    throw new Error(
      `Microsoft certificate auth for portal ${portalId} requires both private key and thumbprint secrets`,
    );
  }

  return {
    privateKeyPem: normalizePemSecret(privateKeyPem),
    thumbprint,
  };
}

/**
 * Preferred credentials path: the HubSpot App Home onboarding flow saves Teams
 * credentials encrypted into D1 (`tenants.webinar_creds_enc`). This keeps the
 * customer-specific Azure app details out of Cloudflare secrets and is the path
 * Ryan wants long-term.
 *
 * If the tenant row/schema is not present, or no Teams creds have been saved,
 * return null so the temporary per-tenant Wrangler-secret path still works.
 */
async function getOnboardingGraphCredentials(
  env: Env,
  portalId: string,
): Promise<GraphCredentials | null> {
  let row: WebinarCredsRow | null;
  try {
    row = await env.DB.prepare(
      'SELECT webinar_provider, webinar_creds_enc FROM tenants WHERE portal_id = ?1',
    )
      .bind(portalId)
      .first<WebinarCredsRow>();
  } catch {
    return null;
  }

  if (row?.webinar_provider !== 'teams' || !row.webinar_creds_enc) return null;

  const encKey = getSecret(env, 'TOKEN_ENCRYPTION_KEY');
  const json = await decryptToken(encKey, row.webinar_creds_enc);
  const creds = JSON.parse(json) as StoredWebinarCreds;

  if (!nonEmpty(creds.tenantId) || !nonEmpty(creds.clientId)) {
    throw new Error(`Stored Teams credentials for portal ${portalId} are incomplete`);
  }

  return {
    aadTenantId: creds.tenantId.trim(),
    clientId: creds.clientId.trim(),
    clientSecret: nonEmpty(creds.clientSecret) ? creds.clientSecret.trim() : undefined,
    certificate: getGraphCertificateCredential(env, portalId) ?? undefined,
  };
}

export async function getGraphCredentials(env: Env, portalId: string): Promise<GraphCredentials> {
  const onboardingCreds = await getOnboardingGraphCredentials(env, portalId);
  if (onboardingCreds) return onboardingCreds;

  return {
    aadTenantId: getSecret(env, `GRAPH_TENANT_ID_${portalId}`),
    clientId: getSecret(env, `GRAPH_CLIENT_ID_${portalId}`),
    clientSecret: optionalSecret(env, `GRAPH_CLIENT_SECRET_${portalId}`) ?? undefined,
    certificate: getGraphCertificateCredential(env, portalId) ?? undefined,
  };
}

/**
 * Returns a valid app-only Graph access token for the tenant, minting + caching
 * one in KV when the cache is cold/expired. Cached just under its real lifetime
 * (expires_in minus a 5-minute safety margin).
 */
export async function getGraphToken(env: Env, portalId: string): Promise<string> {
  const cacheKey = `graph:token:${portalId}`;
  const cached = await env.KV.get(cacheKey);
  if (cached) return cached;

  const { aadTenantId, clientId, clientSecret, certificate } = await getGraphCredentials(
    env,
    portalId,
  );
  const endpoint = `https://login.microsoftonline.com/${encodeURIComponent(aadTenantId)}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: clientId,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });

  if (certificate) {
    const assertion = await buildMicrosoftClientAssertion({
      clientId,
      tokenEndpoint: endpoint,
      certificate,
    });
    appendMicrosoftClientAssertion(body, assertion);
  } else if (clientSecret) {
    body.set('client_secret', clientSecret);
  } else {
    throw new Error(
      `Microsoft Graph credentials for portal ${portalId} need client secret or certificate auth`,
    );
  }

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!resp.ok) {
    throw new GraphError(`Graph token request failed (${resp.status})`, resp.status);
  }

  const data = (await resp.json()) as TokenResponse;
  const ttl = Math.max(60, data.expires_in - 300);
  await env.KV.put(cacheKey, data.access_token, { expirationTtl: ttl });
  return data.access_token;
}

/**
 * Typed Graph fetch. `path` is appended to GRAPH_BASE unless it's already
 * absolute. Returns parsed JSON (or null for empty bodies). Throws GraphError
 * on non-2xx.
 */
export async function graphFetch(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  const url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`;
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const resp = await fetch(url, init);
  if (!resp.ok) {
    let detail = '';
    try {
      detail = await resp.text();
    } catch {
      // ignore
    }
    throw new GraphError(`Graph ${method} ${path} → ${resp.status}: ${detail}`, resp.status);
  }

  const text = await resp.text();
  if (!text) return null;
  return JSON.parse(text) as unknown;
}
