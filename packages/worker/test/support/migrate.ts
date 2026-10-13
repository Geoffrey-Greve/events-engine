/**
 * Applies the REAL migrations to the test D1, once per run.
 *
 * `packages/worker/migrations/*.sql` is the schema this worker actually ships. The suite
 * runs against the same statements rather than a hand-copied subset, so a column added in
 * a migration is present in the tests without anybody remembering to add it twice, and a
 * test asserting on a column that no migration creates fails here instead of in production.
 *
 * Read through Vite's `import.meta.glob(..., { query: '?raw' })`: workerd has no
 * filesystem, so the SQL is inlined into the bundle at transform time. `eager` keeps it
 * synchronous, which is what lets `MIGRATION_FILES` be read by the lint-style guards in
 * `schema-is-migrations.test.ts` without awaiting anything.
 */

const RAW = import.meta.glob('../../migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

export interface MigrationFile {
  /** Bare filename, e.g. `0007_order_invoice_url.sql`. */
  readonly name: string;
  readonly sql: string;
}

/** Every migration, in the order `wrangler d1 migrations apply` would run them. */
export const MIGRATION_FILES: readonly MigrationFile[] = Object.entries(RAW)
  .map(([path, sql]) => ({ name: path.slice(path.lastIndexOf('/') + 1), sql }))
  .sort((a, b) => a.name.localeCompare(b.name));

/**
 * Split a migration into executable statements.
 *
 * `--` comments are stripped first, then the file is cut on `;`. That is only safe while
 * no migration contains a semicolon inside a string literal or a `BEGIN … END` trigger
 * body. No migration has one today, and `schema-is-migrations.test.ts` fails the build on
 * the day one does, rather than leaving the suite running half a statement.
 */
export function splitStatements(sql: string): string[] {
  return sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * The bookkeeping table wrangler itself keeps, so re-entering this is cheap and a
 * migration added later still runs against a database that already has the earlier ones.
 */
const LEDGER = 'd1_migrations';

let applied: Promise<void> | undefined;

async function run(db: D1Database): Promise<void> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS ${LEDGER} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP))`,
  );

  const done = new Set(
    (await db.prepare(`SELECT name FROM ${LEDGER}`).all<{ name: string }>()).results.map(
      (r) => r.name,
    ),
  );

  for (const migration of MIGRATION_FILES) {
    if (done.has(migration.name)) continue;

    for (const statement of splitStatements(migration.sql)) {
      try {
        await db.prepare(statement).run();
      } catch (err) {
        throw new Error(
          `${migration.name}: ${(err as Error).message}\n--- statement ---\n${statement}`,
        );
      }
    }

    await db.prepare(`INSERT INTO ${LEDGER} (name) VALUES (?1)`).bind(migration.name).run();
  }
}

/**
 * Bring the shared D1 up to the head of the migration sequence.
 *
 * Memoised per isolate: `singleWorker` puts every test file in one isolate against one
 * database, so the first caller pays for it and the rest await the same promise.
 */
export function applyMigrations(db: D1Database): Promise<void> {
  if (!applied) applied = run(db);
  return applied;
}

/**
 * Drop everything and re-apply, for the one suite that deliberately breaks the schema.
 *
 * `schema-drift.test.ts` removes tables to prove a booking survives a database
 * provisioned before a migration ran. The database is shared by every other file in the
 * run, so it has to put them back — and a partial re-apply cannot, because the migrations
 * say `CREATE TABLE` and `ADD COLUMN`, not `IF NOT EXISTS`. So the reset is a full
 * rebuild: drop every table the migrations own, then run them again from 0001.
 */
export async function resetSchema(db: D1Database): Promise<void> {
  await dropAllTables(db);
  applied = run(db);
  return applied;
}

/**
 * Drop every table, children before parents.
 *
 * Exported for `schema-drift.test.ts`, which proves a booking survives a database
 * provisioned before a migration ran: with foreign keys live, `tenants` cannot be dropped
 * on its own while `events`, `orders` and the rest still point at it.
 */
export async function dropAllTables(db: D1Database): Promise<void> {
  const names = async (): Promise<string[]> =>
    (
      await db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY rowid DESC`,
        )
        .all<{ name: string }>()
    ).results.map((r) => r.name);

  // D1 enforces foreign keys and gives no reliable way to switch them off for a teardown,
  // so drop children before parents. `sqlite_master` is in creation order and a child is
  // created after its parent, so reverse order is nearly right; the passes are for the
  // pairs where it is not, and stopping when a pass frees nothing keeps a genuinely
  // undroppable table from spinning.
  let remaining = await names();
  while (remaining.length > 0) {
    const before = remaining.length;
    for (const table of remaining) {
      try {
        await db.exec(`DROP TABLE IF EXISTS "${table}"`);
      } catch {
        // Still referenced; a later pass gets it.
      }
    }
    remaining = await names();
    if (remaining.length === before) {
      throw new Error(`could not drop: ${remaining.join(', ')}`);
    }
  }
}
