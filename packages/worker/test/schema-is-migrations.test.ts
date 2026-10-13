import { describe, expect, it } from 'vitest';
import { MIGRATION_FILES, splitStatements } from './support/migrate';

/**
 * The suite's schema is `packages/worker/migrations`, and nothing else.
 *
 * Before this, all 66 files hand-rolled their own `CREATE TABLE IF NOT EXISTS`. The suite
 * runs every file in ONE worker against ONE D1 (`singleWorker`, `isolatedStorage: false`,
 * both for reasons `vitest.config.ts` sets out), so whichever file created a table first
 * decided its columns and every later CREATE was a silent no-op. Each file's DDL was a
 * different subset of the real thing, so the schema the suite ran against depended on the
 * order vitest happened to pick — and adding one test to one file was enough to move
 * another to the front of the run and fail 145 tests in four suites that had not changed.
 *
 * The fix is not a wider hand-rolled copy: the trap is having a copy at all. The
 * migrations are applied once, before the first file (`test/setup.ts`), so there is no
 * race to win, and no test can assert against a column the worker does not actually ship.
 *
 * These are the guards that keep it that way.
 */

const TEST_SOURCES = import.meta.glob('../test/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** Files allowed to say DDL out loud, and why. */
const DDL_ALLOWED = new Map([
  ['support/migrate.ts', 'it is what applies the migrations'],
  [
    'schema-drift.test.ts',
    'it proves a booking survives a database provisioned before a migration ran, ' +
      'and rebuilds the schema from the migrations on the way out',
  ],
  ['schema-is-migrations.test.ts', 'this file names the patterns it forbids'],
]);

const relative = (path: string) => path.replace(/^.*?test\//, '').replace(/^\.\//, '');

/** `CREATE TABLE`, `ALTER TABLE … ADD COLUMN` and `DROP TABLE`, in that order. */
const DDL = /\b(CREATE\s+TABLE|ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN|DROP\s+TABLE)\b/i;

/**
 * Comments are not DDL.
 *
 * Quoting the statement you are reasoning about is what a good comment here does — the
 * voucher-config finding in `hubdb-pricing.test.ts` quotes migration 0018's two `ALTER
 * TABLE`s to say why a guard is unreachable — and a check a comment can trip is one the
 * next person works around by not writing the comment.
 *
 * Rough by design: `//` inside a string literal (a URL) takes the rest of that line with
 * it. That can only ever hide DDL from this check, and DDL does not live in a URL.
 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

describe('the test schema is the shipped schema', () => {
  it('has migrations to apply', () => {
    expect(MIGRATION_FILES.length).toBeGreaterThan(40);
    expect(MIGRATION_FILES[0].name).toBe('0001_init.sql');
    // Filename order is apply order, which is what `check:migrations` guards.
    const names = MIGRATION_FILES.map((m) => m.name);
    expect([...names].sort((a, b) => a.localeCompare(b))).toEqual(names);
  });

  it('declares no table of its own in any test file', () => {
    const offenders = Object.entries(TEST_SOURCES)
      .map(([path, source]) => [relative(path), source] as const)
      .filter(([name]) => !DDL_ALLOWED.has(name))
      .filter(([, source]) => DDL.test(stripComments(source)))
      .map(([name]) => name);

    // A file that creates its own table is back to racing every other file for the
    // definition, and to asserting against columns the migrations may not carry.
    // Add the column in `migrations/`, or the row in `test/support/fixtures.ts`.
    expect(offenders).toEqual([]);
  });

  it('can split every migration on `;`', () => {
    // `splitStatements` strips `--` comments and cuts on semicolons, which is only safe
    // while no migration holds one inside a string literal or a `BEGIN … END` trigger
    // body. Neither has ever appeared; this is what says so on the day one does.
    for (const migration of MIGRATION_FILES) {
      const withoutComments = migration.sql.replace(/--[^\n]*/g, '');
      const quoted = withoutComments.match(/'(?:[^']|'')*'/g) ?? [];
      expect({ migration: migration.name, quoted: quoted.filter((q) => q.includes(';')) }).toEqual({
        migration: migration.name,
        quoted: [],
      });
      expect({
        migration: migration.name,
        hasTrigger: /\bCREATE\s+TRIGGER\b/i.test(migration.sql),
      }).toEqual({ migration: migration.name, hasTrigger: false });
      expect(splitStatements(migration.sql).length).toBeGreaterThan(0);
    }
  });
});
