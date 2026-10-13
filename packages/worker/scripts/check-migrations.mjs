#!/usr/bin/env node
/**
 * Guards the D1 migration sequence in packages/worker/migrations.
 *
 * `wrangler d1 migrations apply` runs files in filename order, so two files
 * sharing a numeric prefix have an apply order decided by the rest of the name
 * rather than by intent. That is silent until a later migration depends on an
 * earlier one and the tie-break happens to put them the wrong way round.
 *
 * Fails on:
 *   - duplicate numeric prefixes
 *   - any filename that is not `NNNN_snake_case.sql`, because wrangler applies
 *     every .sql file in migrations_dir as a migration (seeds belong in ../seeds)
 * Warns (non-fatal) on gaps in the sequence: harmless to apply, but usually a
 * sign a migration was deleted rather than reverted.
 *
 * Run: pnpm --filter @paddock/worker check:migrations
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

// Nothing but numbered migrations may live in migrations/. `wrangler d1 migrations apply`
// applies EVERY .sql file in migrations_dir, not just the NNNN_-prefixed ones, so an
// unnumbered helper file here is applied as a migration — which is how the dev seed used
// to reach any database the command was pointed at, production included. Seeds and other
// one-off scripts live in packages/worker/seeds/ and are run explicitly with `d1 execute`.
const FILENAME = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

const errors = [];
const warnings = [];

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

const byNumber = new Map();

for (const file of files) {
  const match = FILENAME.exec(file);
  if (!match) {
    errors.push(
      `${file}: not a valid migration name. Expected NNNN_snake_case.sql ` +
        `(four digits, then lowercase words separated by underscores).`,
    );
    continue;
  }

  const number = match[1];
  if (!byNumber.has(number)) byNumber.set(number, []);
  byNumber.get(number).push(file);
}

for (const [number, group] of [...byNumber].sort(([a], [b]) => a.localeCompare(b))) {
  if (group.length > 1) {
    errors.push(
      `duplicate migration number ${number}: ${group.join(', ')}. ` +
        `Apply order is decided by the rest of the filename, not by intent — ` +
        `renumber all but one to the end of the sequence.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Backfill statements mirrored into the test suite
//
// A backfill runs ONCE, against live data, and is the part of a migration most worth
// testing. The suite runs in workerd, which cannot read files, and TypeScript cannot type a
// `?raw` import of a relative path — so the statement is mirrored into a constant the tests
// execute, and this check is what stops the mirror drifting from the original. Compared on
// collapsed whitespace: formatting is not the thing that has to match.
// ---------------------------------------------------------------------------
const MIRRORED_BACKFILLS = [
  {
    migration: '0028_registration_seat_price.sql',
    mirror: 'test/support/migration-0028-backfill.ts',
    export: 'BACKFILL_0028',
    startsWith: 'WITH slots AS',
  },
  {
    migration: '0046_membership_source_config.sql',
    mirror: 'test/support/migration-0046-backfill.ts',
    export: 'BACKFILL_0046',
    startsWith: 'UPDATE tenants',
  },
];

const collapse = (sql) => sql.replace(/\s+/g, ' ').trim();

for (const entry of MIRRORED_BACKFILLS) {
  const migrationPath = join(MIGRATIONS_DIR, entry.migration);
  const mirrorPath = join(MIGRATIONS_DIR, '..', entry.mirror);

  let migrationSql;
  let mirrorSource;
  try {
    migrationSql = readFileSync(migrationPath, 'utf8');
    mirrorSource = readFileSync(mirrorPath, 'utf8');
  } catch (err) {
    errors.push(`cannot read ${entry.migration} or its mirror ${entry.mirror}: ${err.message}`);
    continue;
  }

  const start = migrationSql.indexOf(entry.startsWith);
  if (start < 0) {
    errors.push(
      `${entry.migration} no longer contains a statement starting "${entry.startsWith}", ` +
        `but ${entry.mirror} still mirrors one. Update or remove the mirror.`,
    );
    continue;
  }
  const expected = collapse(migrationSql.slice(start));

  const match = mirrorSource.match(
    new RegExp(`${entry.export}\\s*=\\s*\`([\\s\\S]*?)\`;`),
  );
  if (!match) {
    errors.push(`${entry.mirror} does not export a template-literal \`${entry.export}\``);
    continue;
  }
  const actual = collapse(match[1].replace(/\\`/g, '`').replace(/\\\$\{/g, '${'));

  if (actual !== expected) {
    errors.push(
      `${entry.mirror} has drifted from ${entry.migration}. The tests would be exercising ` +
        `SQL that is not the SQL that will run. Re-copy the statement.`,
    );
  }
}

const numbers = [...byNumber.keys()].map(Number).sort((a, b) => a - b);
for (let i = 1; i < numbers.length; i++) {
  const gap = numbers[i] - numbers[i - 1];
  if (gap > 1) {
    const missing = Array.from({ length: gap - 1 }, (_, k) =>
      String(numbers[i - 1] + k + 1).padStart(4, '0'),
    );
    warnings.push(`gap in sequence: no migration numbered ${missing.join(', ')}`);
  }
}

for (const warning of warnings) console.warn(`warning: ${warning}`);

if (errors.length > 0) {
  console.error(`\n${errors.length} migration problem(s) in packages/worker/migrations:\n`);
  for (const error of errors) console.error(`  - ${error}`);
  console.error('');
  process.exit(1);
}

console.log(`migrations OK: ${byNumber.size} numbered migration(s), no duplicate prefixes.`);
