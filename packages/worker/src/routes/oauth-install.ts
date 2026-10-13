import type { Context } from 'hono';
import { getSecret, missingSecrets } from '../config';
import { createOAuthState } from '../hubspot-oauth-state';
import type { Env } from '../types';

/**
 * The scopes this worker's OAuth install link asks a portal for.
 *
 * **This list must equal `requiredScopes` in `packages/hubspot/src/app/app-hsmeta.json`.**
 * The manifest is what HubSpot enforces; this is what the authorize URL requests, and the
 * two silently drifted once already — the install link was omitting company access and
 * task creation, so a portal installed through it could not read a company's voucher
 * balance or raise an owner task, in a way that only surfaced as a dead outbox row much
 * later. `pnpm --filter @paddock/worker check:scopes` now fails on any divergence.
 */
export const HUBSPOT_OAUTH_SCOPES = [
  'oauth',
  'crm.objects.marketing_events.read',
  'crm.objects.marketing_events.write',
  // HubDB is not an OAuth scope on this app. platformVersion 2026.03 rejects the
  // legacy `hubdb` name on upload, and /oauth/authorize rejects the documented
  // replacements (hubdb.tables.* / hubdb.rows.*) as invalid [hubdb]. The worker
  // reads HubDB through HUBSPOT_API_KEY_{portalId}. Do not add these back until
  // HubSpot authorize accepts the granular names.
  'crm.objects.contacts.read',
  'crm.objects.contacts.write',
  'crm.objects.deals.read',
  'crm.objects.deals.write',
  'crm.objects.line_items.read',
  'crm.objects.line_items.write',
  'crm.objects.invoices.read',
  'crm.objects.invoices.write',
  'crm.objects.products.read',
  'crm.objects.companies.read',
  'crm.objects.companies.write',
  'tax_rates.read',
  // Phase 6.1 — reading and creating the custom properties every write-back targets
  // (event_attended, the attendance date and name, teams_join_url, a 2.3 question's
  // mapped property, the company voucher fields). Required rather than optional, decided
  // while the installed base is one portal: promoting a scope from optional to required
  // later forces every customer to re-consent, and there is no cheaper moment than now.
  //
  // The degrade path stays built regardless — a granted scope can be revoked, and the
  // provisioning routine has to report "cannot create, here is the manual list" rather
  // than fail an install.
  'crm.schemas.contacts.read',
  'crm.schemas.contacts.write',
  'crm.schemas.companies.read',
  'crm.schemas.companies.write',
] as const;

/**
 * Scopes the app works without.
 *
 * `crm.objects.owners.read` attributes a mirrored note to the staff member who wrote it.
 * `crm.objects.notes.write` and `crm.objects.tasks.write` are not listed: HubSpot's 2026.03
 * project deploy rejects both as "isn't available to this app" on the Weld portals, required
 * or optional. Staff notes stay in D1; owner tasks stay in `pending_decisions`. Recorded in
 * `scripts/check-hubspot-app.mjs` UNRESOLVED_SCOPES until HubSpot grants them.
 */
export const HUBSPOT_OAUTH_OPTIONAL_SCOPES = ['crm.objects.owners.read'] as const;

/**
 * Secrets the install flow needs end to end. The authorize redirect itself only
 * reads the first three, but it exists solely to reach the callback, which
 * cannot store the tokens without the encryption key. Checking all four up front
 * means a half-configured deployment fails before an administrator is sent
 * through HubSpot authorization, rather than after granting access.
 */
export const HUBSPOT_OAUTH_SECRETS = [
  'HUBSPOT_CLIENT_ID',
  'HUBSPOT_CLIENT_SECRET',
  'HUBSPOT_REDIRECT_URI',
  'TOKEN_ENCRYPTION_KEY',
] as const;

/**
 * A deployment with no HubSpot app credentials is a misconfiguration, not a
 * request error: `getSecret` would throw into the generic 500 handler and leave
 * the installer with an unattributable "unexpected error". Answer 503 with a
 * message that names the remedy, and log which secrets are actually unset.
 */
export function oauthNotConfigured(
  c: Context<{ Bindings: Env }>,
  required: readonly string[],
): Response | null {
  const missing = missingSecrets(c.env, required);
  if (missing.length === 0) return null;
  console.error(
    JSON.stringify({
      level: 'error',
      event: 'oauth_not_configured',
      path: new URL(c.req.url).pathname,
      missing,
    }),
  );
  return c.json(
    {
      status: 'not_configured',
      message:
        'HubSpot OAuth is not configured on this deployment. Set the HubSpot app ' +
        'credentials as Worker secrets and redeploy.',
    },
    503,
  );
}

export async function handleOAuthInstall(c: Context<{ Bindings: Env }>): Promise<Response> {
  const notConfigured = oauthNotConfigured(c, HUBSPOT_OAUTH_SECRETS);
  if (notConfigured) return notConfigured;

  const portalId = new URL(c.req.url).searchParams.get('portalId') ?? undefined;
  const state = await createOAuthState(c.env, portalId);
  const url = new URL('https://app.hubspot.com/oauth/authorize');
  url.searchParams.set('client_id', getSecret(c.env, 'HUBSPOT_CLIENT_ID'));
  url.searchParams.set('redirect_uri', getSecret(c.env, 'HUBSPOT_REDIRECT_URI'));
  url.searchParams.set('scope', HUBSPOT_OAUTH_SCOPES.join(' '));
  url.searchParams.set('optional_scope', HUBSPOT_OAUTH_OPTIONAL_SCOPES.join(' '));
  url.searchParams.set('state', state);
  if (portalId) url.searchParams.set('portalId', portalId);
  return Response.redirect(url.toString(), 302);
}
