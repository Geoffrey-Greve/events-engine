export interface Env {
  /** D1 database – orders, registrations, tickets, outbox */
  DB: D1Database;
  /** KV namespace – Graph token + subscription-id cache */
  KV: KVNamespace;
  /** Queue producer – event-engine-jobs outbox drain */
  QUEUE: Queue;
  /** Durable Object namespace – one EventCapacity instance per event */
  EVENT_CAPACITY: DurableObjectNamespace;
  /** Wrangler secret – HubSpot webhook HMAC key (per-tenant via {PREFIX}_{portalId}) */
  HUBSPOT_WEBHOOK_SECRET: string;
  /** Wrangler secret – 64 hex chars (32 bytes) AES-GCM key for OAuth token encryption */
  TOKEN_ENCRYPTION_KEY: string;
  /** Wrangler secret – HubSpot OAuth client id */
  HUBSPOT_CLIENT_ID: string;
  /** Wrangler secret – HubSpot OAuth client secret */
  HUBSPOT_CLIENT_SECRET: string;
  /** Wrangler secret – OAuth redirect URI registered in HubSpot app settings */
  HUBSPOT_REDIRECT_URI: string;
  /** Wrangler secret – bearer token for admin endpoints */
  ADMIN_SECRET: string;
  /**
   * Optional var – origins allowed to call /api/v1/corporate/* from a browser,
   * comma-separated. Per-portal override: `CORPORATE_ALLOWED_ORIGIN_{portalId}`,
   * read dynamically, so only the shared key is declared here. Unset = unrestricted,
   * which is every deployment's current behaviour. Not authentication: see the header
   * comment in routes/corporate-team.ts.
   */
  CORPORATE_ALLOWED_ORIGIN?: string;
  /**
   * Wrangler secret – HMAC key for webhooks sent by REFUEL's HubSpot portal.
   * Used to verify billing events on POST /webhooks/refuel.
   */
  REFUEL_WEBHOOK_SECRET: string;
  /**
   * Wrangler secret – HubSpot access token for REFUEL's own portal.
   * Used to resolve deal properties when a billing webhook fires.
   */
  REFUEL_HS_ACCESS_TOKEN: string;
  /**
   * Optional Wrangler secret – Slack incoming-webhook URL for REFUEL's own ops channel.
   * Unset = no alerts posted and nothing complains, which is what dev wants. See
   * ops-alert.ts for what may and may not go in a message.
   */
  REFUEL_OPS_SLACK_WEBHOOK_URL?: string;
  /**
   * Wrangler secret – URL for the post-install success page.
   * The OAuth callback redirects here after provisioning (e.g. HubSpot App Home URL).
   */
  OAUTH_SUCCESS_REDIRECT_URI: string;
  /** HubDB provisioning is disabled unless explicitly set to "true". */
  OAUTH_AUTO_PROVISION_HUBDB?: string;
  /**
   * Optional Cloudflare Turnstile secret for public zero-total reservations.
   * Prefer TURNSTILE_SECRET_KEY_{portalId} for tenant-specific widgets.
   */
  TURNSTILE_SECRET_KEY?: string;
  /**
   * Optional comma-separated hostname allow-list checked against Siteverify's
   * hostname response. Prefer TURNSTILE_ALLOWED_HOSTNAMES_{portalId} for
   * tenant-specific widgets.
   */
  TURNSTILE_ALLOWED_HOSTNAMES?: string;
  /** Optional explicit redirect URI for Microsoft organiser OAuth. */
  MICROSOFT_OAUTH_REDIRECT_URI?: string;
  /** Optional delegated scopes override for Microsoft organiser OAuth. */
  MICROSOFT_GRAPH_DELEGATED_SCOPES?: string;
  /**
   * Optional Microsoft certificate auth secrets.
   * Prefer per-portal variants for multi-tenant use:
   *   GRAPH_CLIENT_CERT_PRIVATE_KEY_{portalId}
   *   GRAPH_CLIENT_CERT_THUMBPRINT_{portalId}
   * The non-suffixed names are accepted for a single-tenant staging/prod Worker.
   */
  GRAPH_CLIENT_CERT_PRIVATE_KEY?: string;
  GRAPH_CLIENT_CERT_THUMBPRINT?: string;
  MICROSOFT_CLIENT_CERT_PRIVATE_KEY?: string;
  MICROSOFT_CLIENT_CERT_THUMBPRINT?: string;
}
