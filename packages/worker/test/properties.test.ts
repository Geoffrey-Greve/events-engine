import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectManagedProperties,
  DEFAULT_MEMBERSHIP_STATUS_PROPERTY,
  DEFAULT_VOUCHER_PROPERTIES,
  propertyShapeForQuestion,
  provisionProperties,
} from '../src/properties';
import { manageRoutes } from '../src/routes/manage';
import { encryptToken } from '../src/token-crypto';
import type { Env } from '../src/types';
import { loadVoucherConfig } from '../src/vouchers';
import { seedEvent } from './support/fixtures';

/**
 * Phase 6.1 — provisioning the HubSpot properties every write-back targets.
 *
 * The behaviours that matter are the three rules, because each one is a way this could
 * quietly do damage rather than a feature:
 *
 *   1. It follows the tenant's MAPPING, not the defaults. A portal that keys attendance
 *      somewhere of its own must not get a second, unwritten property; a field set 'off'
 *      must not be created at all.
 *   2. It never modifies a property that already exists. A portal's own dropdown is
 *      adopted and reported, never retyped — retyping a property that holds data is data
 *      loss with a progress bar.
 *   3. It never creates a property the worker only READS. An empty `membership_status` we
 *      made resolves exactly as many members as an absent one, while implying we own it.
 *
 * Plus the two properties an installer must have: it degrades to a manual list rather than
 * failing, and re-running it changes nothing.
 */

const BASE_ENV = env as unknown as Env;
const TOKEN_KEY = '0'.repeat(64);

let counter = 0;
function freshIds() {
  const n = `${Date.now()}-${counter++}`;
  return { portalId: `p61-${n}`, adminKey: `admin-${n}`, eventId: `evt61-${n}` };
}
type Ids = ReturnType<typeof freshIds>;

function envFor(ids: Ids): Env {
  return {
    ...(BASE_ENV as unknown as Record<string, unknown>),
    [`ADMIN_API_KEY_${ids.portalId}`]: ids.adminKey,
  } as unknown as Env;
}

/** Tenant row, with whatever property mapping the case is about. */
async function seedTenant(ids: Ids, mapping: Record<string, string | null> = {}): Promise<void> {
  await BASE_ENV.DB.prepare(
    `INSERT INTO tenants (portal_id, hs_access_token, hs_refresh_token, hs_token_expires_at, display_name)
     VALUES (?1, ?2, ?3, ?4, 'Test Tenant')`,
  )
    .bind(
      ids.portalId,
      await encryptToken(TOKEN_KEY, 'hs-access-token'),
      await encryptToken(TOKEN_KEY, 'hs-refresh-token'),
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    )
    .run();

  for (const [column, value] of Object.entries(mapping)) {
    await BASE_ENV.DB.prepare(`UPDATE tenants SET ${column} = ?1 WHERE portal_id = ?2`)
      .bind(value, ids.portalId)
      .run();
  }
}

interface HubSpotState {
  /** Property names the portal already has, per object, with their type. */
  existing: Record<string, { name: string; type: string; fieldType?: string }[]>;
  /** Status to answer a property-schema read with. 403 = the scope was not granted. */
  listStatus?: number;
  /** Status to answer a property CREATE with. */
  createStatus?: number;
}

/** Records every call so a test can assert what was — and was not — written. */
function stubHubSpot(state: HubSpotState) {
  const calls: Array<{ method: string; url: string; body: Record<string, unknown> | null }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String((input as Request).url ?? input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      calls.push({ method, url, body });
      const json = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { 'content-type': 'application/json' },
        });

      const objectMatch = /\/crm\/v3\/properties\/(contacts|companies)/.exec(url);
      const object = objectMatch?.[1] ?? '';

      // Property group read/create.
      if (url.includes('/groups')) {
        if (method === 'GET') return json({ message: 'not found' }, 404);
        return json({ name: 'created' });
      }
      // Single-property read (the 2.3 question hook).
      if (method === 'GET' && /\/properties\/(contacts|companies)\/[^/?]+$/.test(url)) {
        const name = decodeURIComponent(url.split('/').pop() as string);
        const found = (state.existing[object] ?? []).find((p) => p.name === name);
        return found ? json(found) : json({ message: 'not found' }, 404);
      }
      // Property list.
      if (method === 'GET') {
        if (state.listStatus) return json({ message: 'no scope' }, state.listStatus);
        return json({ results: state.existing[object] ?? [] });
      }
      // Property create.
      if (method === 'POST') {
        if (state.createStatus) return json({ message: 'refused' }, state.createStatus);
        return json({ name: body?.name });
      }
      return json({});
    }),
  );
  return calls;
}

/** Property-create calls only — what actually changed in the portal. */
const creates = (calls: ReturnType<typeof stubHubSpot>) =>
  calls.filter((c) => c.method === 'POST' && /\/properties\/(contacts|companies)$/.test(c.url));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// What a tenant's config implies
// ---------------------------------------------------------------------------

describe('collectManagedProperties', () => {
  it('asks for the attendance trio, the join URL and the voucher fields by default', async () => {
    const ids = freshIds();
    await seedTenant(ids);
    const properties = await collectManagedProperties(BASE_ENV, ids.portalId);
    const names = properties.filter((p) => p.managed).map((p) => p.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'event_attended',
        'event_last_attended_date',
        'event_last_attended_name',
        'teams_join_url',
        'vouchers_total',
        'vouchers_used',
      ]),
    );
  });

  it("does not duplicate HubSpot's standard phone, city and state", async () => {
    const ids = freshIds();
    await seedTenant(ids);
    const properties = await collectManagedProperties(BASE_ENV, ids.portalId);
    // 1.2 defaults to HubSpot's own properties. Creating custom twins would strand the
    // data outside HubSpot's address block, which is the mistake 1.2 exists to avoid.
    expect(properties.map((p) => p.name)).not.toContain('phone');
    expect(properties.map((p) => p.name)).not.toContain('city');
  });

  it("follows a tenant's remapping instead of the default name", async () => {
    const ids = freshIds();
    await seedTenant(ids, {
      contact_attended_property: 'weld_has_attended',
      contact_phone_property: 'mobilephone',
    });
    const names = (await collectManagedProperties(BASE_ENV, ids.portalId)).map((p) => p.name);
    expect(names).toContain('weld_has_attended');
    expect(names).not.toContain('event_attended');
    // A remapped 1.2 field is no longer a standard property, so it does need creating.
    expect(names).toContain('mobilephone');
  });

  it('provisions the join URL under whichever property the tenant keys it in', async () => {
    const ids = freshIds();
    await seedTenant(ids, { contact_join_url_property: 'webinar_link' });
    const names = (await collectManagedProperties(BASE_ENV, ids.portalId)).map((p) => p.name);
    expect(names).toContain('webinar_link');
    expect(names).not.toContain('teams_join_url');
  });

  it("asks for nothing a tenant has switched 'off'", async () => {
    const ids = freshIds();
    await seedTenant(ids, {
      contact_attended_property: 'off',
      contact_attended_date_property: 'off',
      contact_attended_event_property: 'off',
      voucher_mode: 'off',
      contact_join_url_property: 'off',
    });
    const names = (await collectManagedProperties(BASE_ENV, ids.portalId)).map((p) => p.name);
    expect(names).not.toContain('event_attended');
    expect(names).not.toContain('vouchers_total');
    expect(names).not.toContain('teams_join_url');
  });

  it('marks the membership properties as read-only, never ours to create', async () => {
    const ids = freshIds();
    await seedTenant(ids, { membership_level_property: 'weld_member_level' });
    const properties = await collectManagedProperties(BASE_ENV, ids.portalId);
    const level = properties.find((p) => p.name === 'weld_member_level');
    expect(level?.managed).toBe(false);
    expect(properties.find((p) => p.name === 'membership_status')?.managed).toBe(false);
  });

  it("includes each 2.3 question's mapped property, typed from the question", async () => {
    const ids = freshIds();
    await seedTenant(ids);
    await BASE_ENV.DB.prepare(
      `INSERT INTO registration_questions
         (id, portal_id, event_id, key, label, field_type, options_json, required, scope,
          hs_property, prefill, sort_order)
       VALUES (?1, ?2, NULL, 'coffee', 'Coffee order', 'select', ?3, 0, 'attendee',
               'coffee_order', 1, 0)`,
    )
      .bind(
        `q-${ids.portalId}`,
        ids.portalId,
        JSON.stringify([{ value: 'flat_white', label: 'Flat white' }]),
      )
      .run();

    const property = (await collectManagedProperties(BASE_ENV, ids.portalId)).find(
      (p) => p.name === 'coffee_order',
    );
    // A select question provisioned as free text would lose its options, and no later run
    // could recover them — which is why the question editor is where this belongs.
    expect(property).toMatchObject({ type: 'enumeration', fieldType: 'select' });
    expect(property?.options?.[0]).toMatchObject({ value: 'flat_white' });
  });

  it('names one property once, however many questions point at it', async () => {
    const ids = freshIds();
    await seedTenant(ids);
    // `registration_questions.event_id` REFERENCES `events`, so the event-scoped row
    // needs a real one.
    await seedEvent(BASE_ENV.DB, {
      portalId: ids.portalId,
      eventId: ids.eventId,
      hubspotEventId: `hs-${ids.eventId}`,
    });
    for (const [suffix, eventId] of [
      ['tenant', null],
      ['event', ids.eventId],
    ] as const) {
      await BASE_ENV.DB.prepare(
        `INSERT INTO registration_questions
           (id, portal_id, event_id, key, label, field_type, required, scope, hs_property,
            prefill, sort_order)
         VALUES (?1, ?2, ?3, 'dietary_requirements', 'Dietary', 'textarea', 0, 'attendee',
                 'dietary_requirements', 1, 0)`,
      )
        .bind(`q-${suffix}-${ids.portalId}`, ids.portalId, eventId)
        .run();
    }
    const properties = await collectManagedProperties(BASE_ENV, ids.portalId);
    expect(properties.filter((p) => p.name === 'dietary_requirements')).toHaveLength(1);
  });
});

/**
 * Weld's vouchers live in `vouchers_allowance` / `vouchers_used__training`. An unconfigured
 * provision would have created `vouchers_total` / `vouchers_used`, reported "created", and
 * left every corporate booking reading a zero balance off two empty fields beside the real
 * allowance. Nothing in the report distinguished that from a good outcome, so `source` does.
 */
describe('a name the app invented is distinguishable from one a portal chose', () => {
  it('agrees with the loaders about what the defaults actually are', async () => {
    const ids = freshIds();
    await seedTenant(ids);
    const vouchers = await loadVoucherConfig(BASE_ENV, ids.portalId);
    // A drifted constant here would silently relabel every default as "mapped", which is
    // exactly the warning this is for.
    expect(vouchers.totalProperty).toBe(DEFAULT_VOUCHER_PROPERTIES.total);
    expect(vouchers.usedProperty).toBe(DEFAULT_VOUCHER_PROPERTIES.used);
    expect(DEFAULT_MEMBERSHIP_STATUS_PROPERTY).toBe('membership_status');
  });

  it("marks an unconfigured tenant's properties as the app's own defaults", async () => {
    const ids = freshIds();
    await seedTenant(ids);
    const properties = await collectManagedProperties(BASE_ENV, ids.portalId);
    for (const name of ['event_attended', 'teams_join_url', 'vouchers_total']) {
      expect(properties.find((p) => p.name === name)?.source).toBe('default');
    }
  });

  it('marks a remapped property as chosen', async () => {
    const ids = freshIds();
    await seedTenant(ids, {
      voucher_total_property: 'vouchers_allowance',
      voucher_used_property: 'vouchers_used__training',
      contact_attended_property: 'weld_has_attended',
    });
    const properties = await collectManagedProperties(BASE_ENV, ids.portalId);
    for (const name of ['vouchers_allowance', 'vouchers_used__training', 'weld_has_attended']) {
      expect(properties.find((p) => p.name === name)?.source).toBe('mapped');
    }
  });

  it('counts the invented names it is about to create, so a human can check them', async () => {
    const ids = freshIds();
    await seedTenant(ids);
    stubHubSpot({ existing: {} });
    const report = await provisionProperties(BASE_ENV, ids.portalId, 'token', { dryRun: true });

    // Every managed property is missing here, and every one of them is an invented name.
    expect(report.summary.defaultsToCreate).toBeGreaterThan(0);
    expect(report.properties.find((p) => p.name === 'vouchers_total')).toMatchObject({
      source: 'default',
      outcome: 'missing',
    });
  });

  it('stops counting one that the tenant has since mapped', async () => {
    const ids = freshIds();
    await seedTenant(ids, {
      voucher_total_property: 'vouchers_allowance',
      voucher_used_property: 'vouchers_used__training',
    });
    stubHubSpot({ existing: {} });
    const report = await provisionProperties(BASE_ENV, ids.portalId, 'token', { dryRun: true });
    const voucherEntries = report.properties.filter((p) => p.object === 'companies');
    expect(voucherEntries.map((p) => p.name).sort()).toEqual([
      'vouchers_allowance',
      'vouchers_used__training',
    ]);
    expect(voucherEntries.every((p) => p.source === 'mapped')).toBe(true);
  });
});

describe('propertyShapeForQuestion', () => {
  it('maps each question type to a property that can hold its answers', () => {
    expect(propertyShapeForQuestion({ fieldType: 'textarea' })).toMatchObject({
      type: 'string',
      fieldType: 'textarea',
    });
    expect(propertyShapeForQuestion({ fieldType: 'multiselect', options: [] })).toMatchObject({
      type: 'enumeration',
      fieldType: 'checkbox',
    });
    // 2.3 stores a checkbox as the strings 'true'/'false', so the write-back is a copy.
    const checkbox = propertyShapeForQuestion({ fieldType: 'checkbox' });
    expect(checkbox.fieldType).toBe('booleancheckbox');
    expect(checkbox.options?.map((o) => o.value)).toEqual(['true', 'false']);
  });
});

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

describe('provisionProperties', () => {
  it('creates what is missing and files it under a named group', async () => {
    const ids = freshIds();
    await seedTenant(ids);
    const calls = stubHubSpot({ existing: {} });

    const report = await provisionProperties(BASE_ENV, ids.portalId, 'token');
    expect(report.summary.created).toBeGreaterThan(0);
    expect(report.scopeProblem).toBeNull();

    const created = creates(calls).map((c) => c.body?.name);
    expect(created).toContain('event_attended');
    expect(created).toContain('vouchers_total');
    // Never the read-only ones.
    expect(created).not.toContain('membership_status');

    const attended = creates(calls).find((c) => c.body?.name === 'event_attended');
    expect(attended?.body?.groupName).toBe('event_attendance');
  });

  it('types the attendance date as a HubSpot date, not a string', async () => {
    const ids = freshIds();
    await seedTenant(ids);
    const calls = stubHubSpot({ existing: {} });
    await provisionProperties(BASE_ENV, ids.portalId, 'token');

    const byName = new Map(creates(calls).map((c) => [c.body?.name, c.body]));
    // The type is the whole reason the worker creates these rather than a person: a date
    // keyed as a string is the mistake that only surfaces on a printed certificate.
    expect(byName.get('event_last_attended_date')).toMatchObject({
      type: 'date',
      fieldType: 'date',
    });
    expect(byName.get('event_attended')).toMatchObject({
      type: 'enumeration',
      fieldType: 'booleancheckbox',
    });
    expect(byName.get('event_last_attended_name')).toMatchObject({ type: 'string' });
  });

  /**
   * The bug this exists for: a definition once carried `fieldType: 'booleanCheckbox'`, which
   * HubSpot rejects with a 400 that reads as a generic validation failure. Nothing else here
   * would have caught it — every stub happily accepts any string.
   */
  it('only ever sends field types HubSpot actually accepts', async () => {
    const HUBSPOT_TYPES = new Set([
      'string',
      'number',
      'date',
      'datetime',
      'enumeration',
      'bool',
      'phone_number',
    ]);
    const HUBSPOT_FIELD_TYPES = new Set([
      'textarea',
      'text',
      'date',
      'file',
      'number',
      'select',
      'radio',
      'checkbox',
      'booleancheckbox',
      'calculation_equation',
      'phonenumber',
      'html',
    ]);

    const ids = freshIds();
    await seedTenant(ids);
    // One question of every field type, so each mapped shape is exercised.
    const types = ['text', 'textarea', 'select', 'multiselect', 'checkbox', 'phone'];
    for (const fieldType of types) {
      await BASE_ENV.DB.prepare(
        `INSERT INTO registration_questions
           (id, portal_id, event_id, key, label, field_type, options_json, required, scope,
            hs_property, prefill, sort_order)
         VALUES (?1, ?2, NULL, ?3, ?3, ?4, ?5, 0, 'attendee', ?6, 1, 0)`,
      )
        .bind(
          `q-${fieldType}-${ids.portalId}`,
          ids.portalId,
          `q_${fieldType}`,
          fieldType,
          JSON.stringify([{ value: 'a', label: 'A' }]),
          `prop_${fieldType}`,
        )
        .run();
    }

    const calls = stubHubSpot({ existing: {} });
    const report = await provisionProperties(BASE_ENV, ids.portalId, 'token');

    for (const body of creates(calls).map((c) => c.body)) {
      expect(HUBSPOT_TYPES).toContain(body?.type);
      expect(HUBSPOT_FIELD_TYPES).toContain(body?.fieldType);
    }
    // And the same shapes are what the report hands a human to create by hand.
    for (const entry of report.properties) {
      expect(HUBSPOT_TYPES).toContain(entry.definition.type);
      expect(HUBSPOT_FIELD_TYPES).toContain(entry.definition.fieldType);
    }
  });

  it('adopts an existing property and does not touch it', async () => {
    const ids = freshIds();
    await seedTenant(ids);
    const calls = stubHubSpot({
      existing: {
        contacts: [{ name: 'event_attended', type: 'enumeration', fieldType: 'booleancheckbox' }],
      },
    });

    const report = await provisionProperties(BASE_ENV, ids.portalId, 'token');
    const entry = report.properties.find((p) => p.name === 'event_attended');
    expect(entry?.outcome).toBe('adopted');
    expect(entry?.mismatch).toBeNull();
    expect(creates(calls).map((c) => c.body?.name)).not.toContain('event_attended');
  });

  it("reports a portal's differently-typed property instead of retyping it", async () => {
    const ids = freshIds();
    await seedTenant(ids);
    await BASE_ENV.DB.prepare(
      `INSERT INTO registration_questions
         (id, portal_id, event_id, key, label, field_type, required, scope, hs_property,
          prefill, sort_order)
       VALUES (?1, ?2, NULL, 'dietary_requirements', 'Dietary', 'textarea', 0, 'attendee',
               'dietary_requirements', 1, 0)`,
    )
      .bind(`q-${ids.portalId}`, ids.portalId)
      .run();

    // The portal already keeps dietary requirements as a dropdown of its own.
    const calls = stubHubSpot({
      existing: {
        contacts: [{ name: 'dietary_requirements', type: 'enumeration', fieldType: 'select' }],
      },
    });

    const report = await provisionProperties(BASE_ENV, ids.portalId, 'token');
    const entry = report.properties.find((p) => p.name === 'dietary_requirements');
    expect(entry?.outcome).toBe('adopted');
    expect(entry?.mismatch).toEqual({ expected: 'string/textarea', actual: 'enumeration/select' });
    expect(report.summary.mismatches).toBe(1);
    // Reported, and NOT resolved. Re-typing a property that holds data is data loss.
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(creates(calls).map((c) => c.body?.name)).not.toContain('dietary_requirements');
  });

  it('treats a date property keyed as datetime as compatible, not a mismatch', async () => {
    const ids = freshIds();
    await seedTenant(ids);
    stubHubSpot({
      existing: {
        contacts: [{ name: 'event_last_attended_date', type: 'datetime', fieldType: 'date' }],
      },
    });
    const report = await provisionProperties(BASE_ENV, ids.portalId, 'token');
    // The attendance write-back reads the real type and formats to match, so both work.
    expect(
      report.properties.find((p) => p.name === 'event_last_attended_date')?.mismatch,
    ).toBeNull();
  });

  it('reports a missing read-only property without creating it', async () => {
    const ids = freshIds();
    await seedTenant(ids);
    const calls = stubHubSpot({ existing: {} });
    const report = await provisionProperties(BASE_ENV, ids.portalId, 'token');

    const membership = report.properties.find((p) => p.name === 'membership_status');
    expect(membership).toMatchObject({ outcome: 'missing', managed: false });
    expect(report.summary.needsAttention).toBeGreaterThan(0);
    expect(creates(calls).map((c) => c.body?.name)).not.toContain('membership_status');
  });

  it('changes nothing on a second run', async () => {
    const ids = freshIds();
    await seedTenant(ids);
    const first = stubHubSpot({ existing: {} });
    const firstReport = await provisionProperties(BASE_ENV, ids.portalId, 'token');
    const madeNames = creates(first).map((c) => String(c.body?.name));
    expect(madeNames.length).toBe(firstReport.summary.created);

    vi.unstubAllGlobals();
    const second = stubHubSpot({
      existing: {
        contacts: madeNames.map((name) => ({ name, type: 'string' })),
        companies: madeNames.map((name) => ({ name, type: 'number' })),
      },
    });
    const secondReport = await provisionProperties(BASE_ENV, ids.portalId, 'token');
    expect(secondReport.summary.created).toBe(0);
    expect(creates(second)).toHaveLength(0);
  });

  it('degrades to a manual list when the schema scope was not granted', async () => {
    const ids = freshIds();
    await seedTenant(ids);
    const calls = stubHubSpot({ existing: {}, listStatus: 403 });

    const report = await provisionProperties(BASE_ENV, ids.portalId, 'token');
    expect(report.scopeProblem).toContain('re-authorise');
    expect(report.properties.every((p) => p.outcome === 'manual')).toBe(true);
    // Actionable, not just a name: the runbook tells an operator to create these by hand
    // from the definitions, and guessing the DATE one wrong is the failure that only shows
    // up on a printed certificate.
    expect(
      report.properties.find((p) => p.name === 'event_last_attended_date')?.definition,
    ).toMatchObject({ type: 'date', fieldType: 'date' });
    // "Cannot see" is never treated as "not there" — creating blind would duplicate
    // whatever the portal already has.
    expect(creates(calls)).toHaveLength(0);
  });

  it('finishes the rest when one property is rejected', async () => {
    const ids = freshIds();
    await seedTenant(ids);
    stubHubSpot({ existing: {}, createStatus: 400 });
    const report = await provisionProperties(BASE_ENV, ids.portalId, 'token');
    // Every one failed here, but each failure is named rather than aborting the run.
    expect(report.properties.filter((p) => p.outcome === 'failed').length).toBeGreaterThan(1);
    expect(report.summary.needsAttention).toBeGreaterThan(1);
  });

  it('writes nothing in dry-run mode', async () => {
    const ids = freshIds();
    await seedTenant(ids);
    const calls = stubHubSpot({ existing: {} });
    const report = await provisionProperties(BASE_ENV, ids.portalId, 'token', { dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.summary.created).toBe(0);
    expect(report.properties.some((p) => p.outcome === 'missing')).toBe(true);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

describe('onboarding property routes', () => {
  it('requires admin authentication', async () => {
    const ids = freshIds();
    await seedTenant(ids);
    const res = await manageRoutes.request(
      '/onboarding/properties',
      { headers: { 'X-Portal-Id': ids.portalId } },
      envFor(ids),
    );
    expect(res.status).toBe(401);
  });

  it('inspects without writing, then provisions', async () => {
    const ids = freshIds();
    await seedTenant(ids);
    const headers = {
      'X-Portal-Id': ids.portalId,
      Authorization: `Bearer ${ids.adminKey}`,
      'Content-Type': 'application/json',
    };

    const inspectCalls = stubHubSpot({ existing: {} });
    const inspect = await manageRoutes.request('/onboarding/properties', { headers }, envFor(ids));
    expect(inspect.status).toBe(200);
    expect(((await inspect.json()) as { dryRun: boolean }).dryRun).toBe(true);
    expect(creates(inspectCalls)).toHaveLength(0);

    vi.unstubAllGlobals();
    const provisionCalls = stubHubSpot({ existing: {} });
    const provision = await manageRoutes.request(
      '/onboarding/properties',
      { method: 'POST', headers },
      envFor(ids),
    );
    expect(provision.status).toBe(200);
    expect(
      ((await provision.json()) as { summary: { created: number } }).summary.created,
    ).toBeGreaterThan(0);
    expect(creates(provisionCalls).length).toBeGreaterThan(0);
  });
});
