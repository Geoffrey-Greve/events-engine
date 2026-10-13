#!/usr/bin/env node
/**
 * Guards the HubSpot app manifest against the two ways it has silently drifted from the
 * code that depends on it.
 *
 * 1. **Undeclared OAuth scopes.** The worker's write-backs fail with a 403 that only shows
 *    up as a dead outbox row in production. `notify.owner_task` shipped without
 *    `crm.objects.tasks.write` and `company.sync_voucher_usage` without the companies
 *    scopes; both looked fine in tests, which stub fetch. Every CRM object the worker calls
 *    must be named by some declared scope.
 *
 * 2. **Components with no manifest.** HubSpot discovers UI by `*-hsmeta.json`, so a `.tsx`
 *    nothing points at is dead code that still looks live in an editor. Six feature commits
 *    were written into `src/app/extensions/` after the manifests moved to `src/app/cards/`,
 *    and the deployed card silently stayed months behind.
 *
 * 3. **The manifest and the authorize URL disagreeing.** There are two scope lists: this
 *    manifest, which HubSpot enforces, and `HUBSPOT_OAUTH_SCOPES` in the worker's
 *    `routes/oauth-install.ts`, which is what the install link actually asks a portal for.
 *    They drifted: the install URL omitted `crm.objects.companies.*` and
 *    `crm.objects.tasks.write`, so a portal installed through it could not read a company's
 *    voucher balance or raise an owner task — the same 403-as-a-dead-outbox-row failure as
 *    (1), from the opposite direction. It also requested no optional scopes at all, which
 *    made the Phase 1.3 note mirror unreachable for those portals.
 *
 * Run: pnpm check:hubspot-app
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = join(ROOT, 'packages/hubspot/src/app');
const WORKER_SRC = join(ROOT, 'packages/worker/src');
const OAUTH_INSTALL = join(WORKER_SRC, 'routes/oauth-install.ts');

/**
 * CRM objects the worker calls but whose scope name could not be confirmed against the
 * pinned tooling. Listed so the gap is reported every run rather than forgotten — resolve
 * the real scope name against current HubSpot docs and move it into the manifest.
 */
const UNRESOLVED_SCOPES = new Map([
  [
    'payments',
    'GET /crm/v4/objects/payments/{id}/associations/invoices in routes/webhooks-hubspot.ts ' +
      '(payment-succeeded webhook). HubSpot names this scope differently across docs ' +
      '(commercepayments); confirm before declaring it.',
  ],
  [
    'tasks',
    'notify.owner_task POSTs /crm/v3/objects/tasks. crm.objects.tasks.write is rejected on ' +
      '2026.03 project deploy for both Weld portals ("isn\'t available to this app"), ' +
      'required or optional, AND is absent from the scope picker on an account SERVICE ' +
      'KEY, so no credential this worker can hold is able to write a task. Portals in ' +
      'that position set tenants.task_sync_mode = \'off\' (migration 0042) so a decision ' +
      'stops enqueuing a notify.owner_task row that can only 403 and die, and read the ' +
      'App Home pending-decisions list instead. HubSpot support / the granular permission ' +
      'migration must grant it before it can go back in the manifest.',
  ],
  [
    'notes',
    'note.create POSTs /crm/v3/objects/notes. crm.objects.notes.write is rejected the ' +
      'same way as tasks.write, on 2026.03 project deploy AND on an account service key. ' +
      'Portals in that position set tenants.note_sync_mode = \'off\' (migration 0022). ' +
      'Staff notes stay in D1; the HubSpot timeline mirror cannot be requested until ' +
      'HubSpot grants the scope.',
  ],
]);

/**
 * HubDB must stay off the OAuth app until HubSpot authorize accepts the granular
 * names. 2026.03 upload rejects legacy `hubdb`; authorize then maps
 * hubdb.tables.* / hubdb.rows.* back to invalid [hubdb] and the install dies.
 * The worker keeps reading HubDB via HUBSPOT_API_KEY_{portalId}. Drop this
 * guard when support confirms authorize grants those scopes.
 */
function assertNoHubDbOauthScopes(scopes) {
  for (const scope of scopes) {
    if (scope === 'hubdb' || scope.startsWith('hubdb.')) {
      errors.push(
        `"${scope}" is declared on the OAuth app. HubSpot authorize currently ` +
          `rejects HubDB scopes as invalid [hubdb] (app 43687532). HubDB stays on ` +
          `HUBSPOT_API_KEY_{portalId}. Remove the scope, or remove this guard once ` +
          `HubSpot support confirms authorize accepts hubdb.tables.* / hubdb.rows.*.`,
      );
    }
  }
}

/** Entrypoints deliberately not deployed. Each needs a reason recorded here. */
const NOT_DEPLOYED = new Map([
  [
    'extensions/onboarding/index.tsx',
    'Tenant onboarding UI, deliberately deferred — marketplace-track work, and Weld is ' +
      'manually provisioned. Needs a settings extension when it flows. ' +
      'See packages/hubspot/src/app/extensions/README.md.',
  ],
]);

const errors = [];
const warnings = [];

function walk(dir, predicate, found = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules') walk(full, predicate, found);
    } else if (predicate(entry)) {
      found.push(full);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// 1. Every CRM object the worker calls is covered by a declared scope
// ---------------------------------------------------------------------------

const manifestPath = join(APP_DIR, 'app-hsmeta.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const auth = manifest.config?.auth ?? {};
const declared = [
  ...(auth.requiredScopes ?? []),
  ...(auth.optionalScopes ?? []),
  ...(auth.conditionallyRequiredScopes ?? []),
];
assertNoHubDbOauthScopes(declared);

const objectsCalled = new Set();
for (const file of walk(WORKER_SRC, (f) => f.endsWith('.ts'))) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/crm\/v[34]\/objects\/([a-z_]+)/g)) {
    objectsCalled.add(match[1]);
  }
}

for (const object of [...objectsCalled].sort()) {
  if (declared.some((scope) => scope.includes(`.${object}.`))) continue;

  const unresolved = UNRESOLVED_SCOPES.get(object);
  if (unresolved) {
    warnings.push(`no scope declared for CRM object "${object}" — ${unresolved}`);
    continue;
  }
  errors.push(
    `the worker calls /crm/*/objects/${object} but no scope in app-hsmeta.json names it. ` +
      `Add crm.objects.${object}.read / .write, or record why it is unresolved in ` +
      `scripts/check-hubspot-app.mjs.`,
  );
}

// ---------------------------------------------------------------------------
// 2. Every UI entrypoint is referenced by a manifest
// ---------------------------------------------------------------------------

const entrypoints = new Set();
for (const file of walk(APP_DIR, (f) => f.endsWith('-hsmeta.json'))) {
  const entrypoint = JSON.parse(readFileSync(file, 'utf8')).config?.entrypoint;
  // Manifest entrypoints are app-root-absolute, e.g. "/app/cards/EventManagement.tsx".
  if (entrypoint) entrypoints.add(entrypoint.replace(/^\/app\//, ''));
}

for (const file of walk(APP_DIR, (f) => f.endsWith('.tsx'))) {
  const rel = relative(APP_DIR, file).split(sep).join('/');
  if (entrypoints.has(rel)) continue;

  const reason = NOT_DEPLOYED.get(rel);
  if (reason) {
    warnings.push(`${rel} is not deployed — ${reason}`);
    continue;
  }
  errors.push(
    `${rel} has no *-hsmeta.json pointing at it, so it does not ship. Add a manifest, ` +
      `delete it, or record it in NOT_DEPLOYED in scripts/check-hubspot-app.mjs.`,
  );
}

// ---------------------------------------------------------------------------
// 3. The manifest and the authorize URL ask for the same scopes
// ---------------------------------------------------------------------------

/**
 * Extract a `const NAME = [ 'a', 'b' ] as const;` array from TypeScript source.
 *
 * A textual parse rather than an import: the manifest is JSON read by HubSpot's Projects
 * CLI and the worker list is TypeScript bundled by wrangler, so neither can import the
 * other. It fails loudly when the array cannot be found, so a refactor that moves them
 * breaks this check instead of silently passing it.
 */
function readScopeArray(source, name) {
  const match = new RegExp(`${name}\\s*=\\s*\\[(.*?)\\]\\s*as const`, 's').exec(source);
  if (!match) {
    errors.push(
      `could not find ${name} in packages/worker/src/routes/oauth-install.ts. If it was ` +
        `renamed or restructured, update scripts/check-hubspot-app.mjs — do not delete the check.`,
    );
    return null;
  }
  // Strip comments before pulling string literals, so a scope named in an explanatory
  // comment is not mistaken for a requested one.
  const body = match[1].replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

const installSource = readFileSync(OAUTH_INSTALL, 'utf8');
const scopeLists = [
  ['required', auth.requiredScopes ?? [], readScopeArray(installSource, 'HUBSPOT_OAUTH_SCOPES')],
  [
    'optional',
    auth.optionalScopes ?? [],
    readScopeArray(installSource, 'HUBSPOT_OAUTH_OPTIONAL_SCOPES'),
  ],
];

for (const [label, manifestScopes, urlScopes] of scopeLists) {
  if (urlScopes === null) continue;
  const inUrl = new Set(urlScopes);
  const inManifest = new Set(manifestScopes);

  for (const scope of manifestScopes) {
    if (inUrl.has(scope)) continue;
    errors.push(
      `${label} scope "${scope}" is declared in app-hsmeta.json but the install URL never ` +
        `asks for it. Add it to oauth-install.ts.`,
    );
  }
  for (const scope of urlScopes) {
    if (inManifest.has(scope)) continue;
    errors.push(
      `the install URL asks for ${label} scope "${scope}" but app-hsmeta.json does not ` +
        `declare it. HubSpot will reject the authorize request.`,
    );
  }
}

// A scope in both lists is ambiguous to a reader and undefined in behaviour.
for (const scope of auth.optionalScopes ?? []) {
  if ((auth.requiredScopes ?? []).includes(scope)) {
    errors.push(`"${scope}" is listed as both required and optional in app-hsmeta.json.`);
  }
}

// ---------------------------------------------------------------------------

for (const warning of warnings) console.warn(`warning: ${warning}`);
if (errors.length > 0) {
  for (const error of errors) console.error(`error: ${error}`);
  process.exit(1);
}
console.log(
  `hubspot app OK: ${objectsCalled.size} CRM object(s) scoped, ` +
    `${entrypoints.size} entrypoint(s) manifested, ` +
    `${(auth.requiredScopes ?? []).length} required + ${(auth.optionalScopes ?? []).length} ` +
    `optional scope(s) in sync with the install URL, ${warnings.length} warning(s).`,
);
