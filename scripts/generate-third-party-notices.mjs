#!/usr/bin/env node
/**
 * Generates THIRD-PARTY-NOTICES.md from the pnpm lockfile.
 *
 * This repo is proprietary (see LICENSE), so its third-party open-source
 * dependencies are the only components in it carrying obligations to anyone
 * outside Refuel. This file records them. It is generated rather than
 * hand-maintained so it cannot quietly drift from what is actually installed.
 *
 * Source of truth is `pnpm licenses list -r`, which resolves against
 * pnpm-lock.yaml and reads each package's own metadata — so it covers every
 * workspace package and every transitive dependency, not just direct ones.
 *
 * Two passes, because the obligations differ sharply:
 *   --prod  -> dependencies that ship inside a deployed artifact (the Worker
 *              bundle, the PWA bundle). Attribution obligations attach to
 *              these, so they get their full licence text embedded.
 *   default -> everything: the above plus build and dev tooling. Recorded for
 *              completeness; none of it is redistributed.
 *
 * Licences are CLASSIFIED by the policy table below, never asserted. A future
 * dependency that drags in copyleft therefore surfaces as a flagged obligation
 * instead of disappearing under a blanket "all permissive" claim.
 *
 * Output is deterministic — no timestamps — so `--check` can diff it.
 *
 * Requires an installed node_modules (`pnpm install`); pnpm reads licence
 * metadata from the store, not from the lockfile text alone.
 *
 * CAVEAT: optional platform-specific binaries (@img/sharp-*, @esbuild/*,
 * @rollup/rollup-*) install only for the host OS and CPU, so the build/dev
 * section reflects the machine that ran the generator. `--check` is a plain
 * diff and will therefore disagree across platforms — it is a local guard, not
 * a CI gate. Regenerate on the machine whose dependency set you mean to record.
 *
 * Run:   pnpm notices
 * Check: pnpm notices:check
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(ROOT, 'THIRD-PARTY-NOTICES.md');
const GENERATOR = 'scripts/generate-third-party-notices.mjs';

/**
 * Licence classes, ordered most-permissive-first. An OR expression resolves to
 * its most permissive branch, an AND to its most restrictive.
 */
const CLASSES = [
  'public-domain',
  'permissive',
  'attribution',
  'weak-copyleft',
  'strong-copyleft',
  'review',
];

const CLASS_NOTES = {
  'public-domain': 'No conditions. Nothing to reproduce, nothing to track.',
  permissive:
    'Reproduce the copyright notice and licence text wherever the component is redistributed. ' +
    'No obligation to disclose our own source. Safe in a proprietary product.',
  attribution:
    'Attribution required. These are Creative Commons content licences rather than software ' +
    'licences — confirm the component is data (a browser table, an SPDX list) and not code ' +
    'before relying on it.',
  'weak-copyleft':
    'Modifications to the COMPONENT ITSELF must be released under the same licence, and it must ' +
    'stay replaceable by the recipient. Calling it from proprietary code is fine. Do not vendor, ' +
    'fork or patch these in place — depend on them unmodified.',
  'strong-copyleft':
    'Distributing a work that includes this component obliges us to release that work under the ' +
    'same licence. Incompatible with a proprietary product: remove or replace it.',
  review:
    'Unrecognised licence. Needs a decision before it ships — then add it to LICENCE_CLASS in ' +
    GENERATOR +
    '.',
};

/**
 * Anything unlisted falls to `review`, which is the point: an unrecognised
 * licence needs a human decision, not a silent assumption.
 */
const LICENCE_CLASS = new Map(
  Object.entries({
    '0BSD': 'permissive',
    'Apache-2.0': 'permissive',
    'BSD-2-Clause': 'permissive',
    'BSD-3-Clause': 'permissive',
    'BlueOak-1.0.0': 'permissive',
    ISC: 'permissive',
    MIT: 'permissive',
    'MIT-0': 'permissive',
    'Python-2.0': 'permissive',
    Zlib: 'permissive',
    'CC0-1.0': 'public-domain',
    Unlicense: 'public-domain',
    'CC-BY-3.0': 'attribution',
    'CC-BY-4.0': 'attribution',
    'CDDL-1.0': 'weak-copyleft',
    'EPL-2.0': 'weak-copyleft',
    'LGPL-2.1': 'weak-copyleft',
    'LGPL-2.1-or-later': 'weak-copyleft',
    'LGPL-3.0': 'weak-copyleft',
    'LGPL-3.0-or-later': 'weak-copyleft',
    'MPL-2.0': 'weak-copyleft',
    'AGPL-3.0': 'strong-copyleft',
    'AGPL-3.0-or-later': 'strong-copyleft',
    'GPL-2.0': 'strong-copyleft',
    'GPL-3.0': 'strong-copyleft',
    'GPL-3.0-or-later': 'strong-copyleft',
  }),
);

const LICENCE_FILE = /^(licen[cs]e|copying|notice)(\.|$)/i;

/** Resolves an SPDX expression to a single class. */
function classify(expression) {
  const rank = (id) => CLASSES.indexOf(LICENCE_CLASS.get(id.trim()) ?? 'review');
  const terms = expression.replace(/[()]/g, ' ').split(/\s+AND\s+/i);
  return CLASSES[Math.max(...terms.map((t) => Math.min(...t.split(/\s+OR\s+/i).map(rank))))];
}

function pnpmLicenses(extraArgs) {
  const raw = execFileSync('pnpm', ['licenses', 'list', '--json', '-r', ...extraArgs], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });

  // pnpm keys its output by SPDX expression, each holding per-package records.
  const byLicence = JSON.parse(raw);
  const packages = [];
  for (const [licence, entries] of Object.entries(byLicence)) {
    for (const entry of entries) {
      packages.push({
        name: entry.name,
        versions: [...entry.versions].sort(),
        licence,
        author: typeof entry.author === 'string' ? entry.author : undefined,
        homepage: typeof entry.homepage === 'string' ? entry.homepage : undefined,
        // Machine-local store paths: used to read licence text, never emitted.
        paths: entry.paths ?? [],
      });
    }
  }
  packages.sort((a, b) => a.name.localeCompare(b.name) || a.licence.localeCompare(b.licence));
  return packages;
}

function readLicenceText(pkg) {
  for (const dir of pkg.paths) {
    if (!existsSync(dir)) continue;
    const file = readdirSync(dir).find((f) => LICENCE_FILE.test(f));
    if (!file) continue;
    const text = readFileSync(join(dir, file), 'utf8').trim();
    if (text) return text;
  }
  return null;
}

function workspacePackages() {
  const dir = join(ROOT, 'packages');
  return readdirSync(dir)
    .filter((name) => existsSync(join(dir, name, 'package.json')))
    .map((name) => JSON.parse(readFileSync(join(dir, name, 'package.json'), 'utf8')).name)
    .sort();
}

/** Counts components (not versions) per SPDX expression across the two buckets. */
function rollup(distributed, buildOnly) {
  const rows = new Map();
  const bump = (pkg, key) => {
    const row = rows.get(pkg.licence) ?? { licence: pkg.licence, distributed: 0, buildOnly: 0 };
    row[key] += 1;
    rows.set(pkg.licence, row);
  };
  for (const pkg of distributed) bump(pkg, 'distributed');
  for (const pkg of buildOnly) bump(pkg, 'buildOnly');
  return [...rows.values()].sort(
    (a, b) =>
      CLASSES.indexOf(classify(a.licence)) - CLASSES.indexOf(classify(b.licence)) ||
      b.distributed + b.buildOnly - (a.distributed + a.buildOnly) ||
      a.licence.localeCompare(b.licence),
  );
}

function render({ distributed, buildOnly, workspaces }) {
  const out = [];
  const summary = rollup(distributed, buildOnly);
  const names = workspaces.map((w) => '`' + w + '`').join(', ');

  out.push('# Third-party notices');
  out.push('');
  out.push('<!-- Generated by ' + GENERATOR + ' — do not edit by hand.');
  out.push('     Regenerate with `pnpm notices` after any dependency change. -->');
  out.push('');
  out.push(
    'event-engine (Paddock) is proprietary software — see [LICENSE](LICENSE). It incorporates',
    'the third-party open-source components below, which remain under their own licences. Those',
    'licences apply to those components only and grant no rights in event-engine itself.',
  );
  out.push('');
  out.push(
    'Generated from `pnpm-lock.yaml` by `' + GENERATOR + '`, covering every transitive',
    'dependency of all ' + workspaces.length + ' workspace packages: ' + names + '.',
  );
  out.push('');

  out.push('## Summary');
  out.push('');
  out.push(
    '**' + distributed.length + '** components ship inside a deployed artifact. **' +
      buildOnly.length + '** more are build or development tooling and are never redistributed.',
  );
  out.push('');
  out.push('| Licence | Class | Distributed | Build / dev |');
  out.push('| --- | --- | ---: | ---: |');
  for (const row of summary) {
    out.push(
      '| ' + row.licence + ' | ' + classify(row.licence) + ' | ' + (row.distributed || '—') +
        ' | ' + (row.buildOnly || '—') + ' |',
    );
  }
  out.push('');

  out.push('### What each class obliges');
  out.push('');
  for (const cls of CLASSES.filter((c) => summary.some((r) => classify(r.licence) === c))) {
    out.push('- **' + cls + '** — ' + CLASS_NOTES[cls]);
  }
  out.push('');

  const flagged = summary.filter((r) =>
    ['weak-copyleft', 'strong-copyleft', 'review'].includes(classify(r.licence)),
  );
  if (flagged.length === 0) {
    out.push(
      'No copyleft and no unrecognised licences are present, in either bucket. Every component is',
      'permissive or public-domain and all are sublicensable — nothing here constrains how',
      'event-engine itself is licensed or distributed.',
    );
  } else {
    out.push('### Components needing attention');
    out.push('');
    for (const row of flagged) {
      const where = row.distributed > 0 ? '**DISTRIBUTED**' : 'build/dev only';
      const members = [...distributed, ...buildOnly]
        .filter((p) => p.licence === row.licence)
        .map((p) => '`' + p.name + '`')
        .join(', ');
      out.push('- **' + row.licence + '** (' + classify(row.licence) + ', ' + where + '): ' +
        members);
    }
    out.push('');
    out.push(
      'Nothing above is strong copyleft, so none of it constrains how event-engine itself is',
      'licensed. Anything marked DISTRIBUTED needs a deliberate decision. Anything build/dev only',
      'is never redistributed and carries no obligation while it stays unmodified.',
    );
  }
  out.push('');

  out.push('## Distributed components');
  out.push('');
  out.push(
    'Bundled into a deployed artifact (the Cloudflare Worker, the check-in PWA), so their',
    'attribution requirements are live. Full licence text is reproduced for each.',
  );
  out.push('');
  for (const pkg of distributed) {
    out.push('### ' + pkg.name + ' — ' + pkg.licence);
    out.push('');
    out.push('- Version' + (pkg.versions.length > 1 ? 's' : '') + ': ' + pkg.versions.join(', '));
    if (pkg.author) out.push('- Author: ' + pkg.author);
    if (pkg.homepage) out.push('- Homepage: ' + pkg.homepage);
    out.push('');
    const text = readLicenceText(pkg);
    if (text) {
      out.push('<details>', '<summary>Licence text</summary>', '', '```text', text, '```', '');
      out.push('</details>');
    } else {
      out.push(
        '> No licence file is shipped in the `' + pkg.name + '` package. The licence is declared',
        '> as `' + pkg.licence + '` in its `package.json`; canonical text at',
        '> https://spdx.org/licenses/' + pkg.licence + '.html',
      );
    }
    out.push('');
  }

  out.push('## Build and development components');
  out.push('');
  out.push(
    'Compilers, bundlers, test runners, CLIs and their transitive dependencies. None of these are',
    'redistributed — they exist only on developer machines and CI runners — so the',
    'reproduce-the-notice obligations of their licences are not triggered. Listed for',
    'completeness and for audit.',
  );
  out.push('');
  out.push(
    'Optional platform-specific binaries install only for the host OS and CPU, so this section',
    'reflects the machine that last ran the generator.',
  );
  out.push('');
  out.push('| Component | Version(s) | Licence |');
  out.push('| --- | --- | --- |');
  for (const pkg of buildOnly) {
    out.push('| `' + pkg.name + '` | ' + pkg.versions.join(', ') + ' | ' + pkg.licence + ' |');
  }
  out.push('');

  return out.join('\n');
}

const check = process.argv.includes('--check');

const all = pnpmLicenses([]);
const prod = pnpmLicenses(['--prod']);

// pnpm reports a package once per licence expression, so name+licence is the
// identity that survives a package being relicensed between the two passes.
const prodKeys = new Set(prod.map((p) => p.name + ' ' + p.licence));
const distributed = all.filter((p) => prodKeys.has(p.name + ' ' + p.licence));
const buildOnly = all.filter((p) => !prodKeys.has(p.name + ' ' + p.licence));

const rendered = render({ distributed, buildOnly, workspaces: workspacePackages() });

if (check) {
  const existing = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : null;
  if (existing === rendered) {
    console.log('THIRD-PARTY-NOTICES.md is up to date (' + all.length + ' components).');
    process.exit(0);
  }
  console.error(
    existing === null
      ? 'THIRD-PARTY-NOTICES.md is missing.'
      : 'THIRD-PARTY-NOTICES.md is stale — dependencies have changed since it was generated.',
  );
  console.error('Run `pnpm notices` and commit the result.');
  process.exit(1);
}

writeFileSync(OUTPUT, rendered);
console.log(
  'Wrote THIRD-PARTY-NOTICES.md: ' + distributed.length + ' distributed, ' + buildOnly.length +
    ' build/dev, ' + all.length + ' total.',
);
