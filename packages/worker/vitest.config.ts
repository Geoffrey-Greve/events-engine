import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// Real Workers runtime + real Durable Object instances (Miniflare), no mocks.
// Bindings (DB, KV, QUEUE, EVENT_CAPACITY) are read from wrangler.toml so the DO
// runs exactly as it would in production. `singleWorker` keeps every test in one
// isolate so concurrent fetches to a DO exercise its real single-threaded gating.
//
// isolatedStorage is OFF: the D1-backed tests trip a known vitest-pool-workers bug where
// the per-test storage snapshot chokes on D1's WAL -shm file. Tests use unique ids
// (fresh event/portal per case) so they don't rely on per-test rollback anyway.
export default defineWorkersConfig({
  test: {
    // The schema comes from packages/worker/migrations, applied once before the first
    // file runs. Test files declare no DDL of their own; see test/support/migrate.ts.
    setupFiles: ['./test/setup.ts'],
    poolOptions: {
      workers: {
        singleWorker: true,
        isolatedStorage: false,
        wrangler: { configPath: './wrangler.toml' },
        // Wrangler secrets in prod; fixed here so the crypto/token helpers run.
        miniflare: {
          bindings: {
            HUBSPOT_WEBHOOK_SECRET: 'test-signing-secret',
            HUBSPOT_CLIENT_ID: 'hubspot-app-id',
            HUBSPOT_CLIENT_SECRET: 'hubspot-app-secret',
            HUBSPOT_REDIRECT_URI: 'https://worker.test/oauth/callback',
            // 64 hex chars (32 bytes) for AES-GCM webinar/OAuth token encryption.
            TOKEN_ENCRYPTION_KEY: '0'.repeat(64),
            // Platform-level (OUR app) OAuth credentials, one pair per provider.
            ZOOM_OAUTH_CLIENT_ID: 'zoom-app-id',
            ZOOM_OAUTH_CLIENT_SECRET: 'zoom-app-secret',
            WEBINAR_OAUTH_REDIRECT_BASE: 'https://worker.test',
            OAUTH_SUCCESS_REDIRECT_URI: 'https://app.hubspot.com/success',
          },
        },
      },
    },
  },
});
