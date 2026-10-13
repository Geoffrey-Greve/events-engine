/**
 * Runs before every test file, and brings the shared D1 to the head of the migrations.
 *
 * `singleWorker` + `isolatedStorage: false` means one database for the whole run (see
 * `vitest.config.ts` for why), so the schema has to be settled before the first file
 * inserts a row. Doing it here rather than in each file is what removes the ordering
 * hazard: there is no CREATE race to win, because nothing races.
 *
 * `cloudflare:test` is imported INSIDE the hook, not at the top of the file. A static
 * import of it from a setup file initialises the pool's runner before vitest installs the
 * mock registry, and every `vi.mock()` in every test file silently stops taking effect —
 * `providers.test.ts` mocks the OAuth credential layer and went looking for a real D1 on
 * an env that deliberately has none. A dynamic import inside the hook runs late enough.
 */
import { beforeAll, vi } from 'vitest';
import { applyMigrations } from './support/migrate';

// Before the test file is imported, not inside a hook: every file in this run shares one
// worker isolate (`singleWorker`), so without this the module registry carries over and a
// `vi.mock()` for a module some earlier file already imported for real silently does not
// apply. That is what made `providers.test.ts` reach for a D1 on an env with none, in
// about one run in three, in a suite where nothing had changed.
vi.resetModules();

beforeAll(async () => {
  const { env } = await import('cloudflare:test');
  await applyMigrations((env as unknown as { DB: D1Database }).DB);
});
