/**
 * Tenant provisioning: creates (or reconciles) the HubDB tables a portal's front end
 * renders from.
 *
 * The CONTACT PROPERTIES the write-backs target were provisioned here too for a while, for
 * the attendance three only. That moved to `properties.ts`, which does the general case —
 * attendance plus the join URL, remapped 1.2 fields, every 2.3 question's mapped property
 * and the company voucher fields — resolved through the same tenant mappings the writes
 * read. Two routines creating overlapping sets of properties was one more thing that could
 * disagree, which is the failure this whole area exists to remove.
 *
 * The two tables reference each other: `events.ticket_types` → ticket_types and
 * `ticket_types.event` → events. Neither can be created with both FOREIGN_ID
 * columns resolved, so creation defers any column whose target does not exist
 * yet and a reconcile pass adds it once both ids are known.
 *
 * All writes target the table's DRAFT (`/draft`, `/draft/push-live`); the
 * published paths reject them. Lookups use the draft endpoint too, so a table
 * created by a run that died before publishing is still found on retry.
 *
 * HubSpot assigns column ids itself and they are NOT positional, so a foreign
 * reference and a dynamic-page meta tag can only name their column and have the
 * id resolved against the live table.
 *
 * Sequence:
 *   1. Look each table up by name, draft included, to detect prior runs.
 *   2. Create both tables with their plain columns only.
 *   3. Read both back for their live column ids.
 *   4. Reconcile: add the cross-table references and point each meta tag at a
 *      real column id.
 *   5. Enable useForPages on the events table if not already set.
 *   6. Publish both tables.
 *   7. Persist table ids to the tenants row in D1.
 *
 * Idempotent: an existing table's id is reused rather than duplicated, and the
 * reconcile pass repairs a table left incomplete by an earlier failed run.
 * Columns not in our schema are preserved, so a portal that added its own
 * column does not lose it.
 */

import { eventsTable, type HubDbColumn, ticketTypesTable } from '@paddock/shared';
import type { Env } from './types';

const HUBDB_BASE = 'https://api.hubapi.com/cms/v3/hubdb/tables';

interface HubDbCreateResponse {
  id: string;
  name: string;
}

interface HubDbColumnDetail {
  id?: string | number;
  name: string;
}

/** A created table plus its live column ids, keyed by column name. */
interface ResolvedTable {
  id: string;
  columnIdByName: Map<string, number>;
}

type ResolvedTables = Record<string, ResolvedTable>;

function columnIdByName(detail: HubDbTableDetail | null): Map<string, number> {
  const entries = (detail?.columns ?? [])
    .filter((col) => col.id !== undefined)
    .map((col) => [col.name, Number(col.id)] as const);
  return new Map(entries);
}

interface HubDbTableDetail {
  id: string;
  name: string;
  useForPages?: boolean;
  columns?: HubDbColumnDetail[];
}

async function hubdbGet(token: string, path: string): Promise<Response> {
  return fetch(`${HUBDB_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function hubdbPost(token: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${HUBDB_BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

async function hubdbPatch(token: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${HUBDB_BASE}${path}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

/**
 * Looks a table up by name, draft included. `GET /cms/v3/hubdb/tables` returns
 * only published tables, so a run that created tables but died before
 * publishing would leave them invisible and the retry would create duplicates.
 * The draft endpoint takes a name as well as an id and sees both states.
 */
async function findTable(token: string, nameOrId: string): Promise<HubDbTableDetail | null> {
  const res = await hubdbGet(token, `/${nameOrId}/draft`);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`HubDB get table "${nameOrId}" failed ${res.status}: ${await res.text()}`);
  }
  return res.json<HubDbTableDetail>();
}

/**
 * Builds one column payload, or null when the column points at a table that is
 * not resolved yet. A null is the caller's cue to defer the column to the
 * reconcile pass rather than fail: the events/ticket_types pair reference each
 * other, so whichever is created first cannot resolve the other, and neither
 * has live column ids until it exists.
 */
function buildColumnPayload(
  col: HubDbColumn,
  resolved: ResolvedTables,
): Record<string, unknown> | null {
  const base: Record<string, unknown> = { name: col.name, label: col.label, type: col.type };
  if (col.options) base.options = col.options;
  if (col.type === 'FOREIGN_ID' && col.foreignTable) {
    const target = resolved[col.foreignTable];
    if (!target) return null;
    base.foreignTableId = parseInt(target.id, 10);
    if (col.foreignColumnName) {
      const foreignColumnId = target.columnIdByName.get(col.foreignColumnName);
      if (foreignColumnId === undefined) {
        throw new Error(
          `Foreign table "${col.foreignTable}" has no column "${col.foreignColumnName}" ` +
            `to display for ${col.name}`,
        );
      }
      base.foreignColumnId = foreignColumnId;
    }
  }
  return base;
}

/**
 * Creates a table with only the columns that can be built without knowing any
 * other table's live column ids. Cross-table references and dynamicMetaTags are
 * left to the reconcile pass, which runs once every table and column id exists.
 */
async function createTable(
  token: string,
  schema: typeof eventsTable | typeof ticketTypesTable,
): Promise<string> {
  const columns = schema.columns
    .map((col) => buildColumnPayload(col, {}))
    .filter((col): col is Record<string, unknown> => col !== null);
  const body: Record<string, unknown> = {
    name: schema.name,
    label: schema.label,
    useForPages: schema.useForPages,
    allowPublicApiAccess: schema.allowPublicApiAccess,
    allowChildTables: schema.allowChildTables,
    enableChildTablePages: schema.enableChildTablePages,
    columns,
  };
  const res = await hubdbPost(token, '', body);
  if (!res.ok) {
    throw new Error(
      `HubDB create table "${schema.name}" failed ${res.status}: ${await res.text()}`,
    );
  }
  const data = await res.json<HubDbCreateResponse>();
  return data.id;
}

/**
 * Brings a table up to the declared schema now that every table and column id is
 * known: adds the deferred cross-table references and points each dynamic-page
 * meta tag at a real column id.
 *
 * Existing columns are matched by name and carry their id so HubSpot updates
 * them in place instead of dropping and recreating them, and any column the
 * portal added itself is passed through untouched. Safe to run every time.
 */
async function reconcileTable(
  token: string,
  target: ResolvedTable,
  schema: typeof eventsTable | typeof ticketTypesTable,
  current: HubDbTableDetail | null,
  resolved: ResolvedTables,
): Promise<void> {
  const currentColumns = current?.columns ?? [];

  const desired = schema.columns.map((col) => {
    const payload = buildColumnPayload(col, resolved);
    if (!payload) {
      throw new Error(
        `Cannot resolve foreignTable "${col.foreignTable}" for ${schema.name}.${col.name}`,
      );
    }
    const existingId = target.columnIdByName.get(col.name);
    if (existingId !== undefined) payload.id = existingId;
    return payload;
  });

  const declared = new Set(schema.columns.map((col) => col.name));
  const preserved = currentColumns
    .filter((col) => !declared.has(col.name))
    .map((col) => ({ id: col.id, name: col.name }));

  const body: Record<string, unknown> = { columns: [...desired, ...preserved] };

  if (schema.dynamicMetaTags) {
    const tags: Record<string, number> = {};
    for (const [tag, columnName] of Object.entries(schema.dynamicMetaTags)) {
      const columnId = target.columnIdByName.get(columnName);
      if (columnId === undefined) {
        throw new Error(`${schema.name} has no column "${columnName}" to supply meta tag ${tag}`);
      }
      tags[tag] = columnId;
    }
    body.dynamicMetaTags = tags;
  }

  const res = await hubdbPatch(token, `/${target.id}/draft`, body);
  if (!res.ok) {
    throw new Error(
      `HubDB reconcile ${schema.name} (${target.id}) failed ${res.status}: ${await res.text()}`,
    );
  }
}

async function ensureUseForPages(token: string, tableId: string): Promise<void> {
  const res = await hubdbPatch(token, `/${tableId}/draft`, { useForPages: true });
  if (!res.ok) {
    throw new Error(
      `HubDB patch useForPages on ${tableId} failed ${res.status}: ${await res.text()}`,
    );
  }
}

async function publishTable(token: string, tableId: string): Promise<void> {
  const res = await hubdbPost(token, `/${tableId}/draft/push-live`, {});
  if (!res.ok) {
    throw new Error(`HubDB publish table ${tableId} failed ${res.status}: ${await res.text()}`);
  }
}

function schemaFor(name: string): typeof eventsTable | typeof ticketTypesTable {
  return name === eventsTable.name ? eventsTable : ticketTypesTable;
}

/**
 * Column names our schema declares (references aside) that a table lacks.
 * Empty means the table is ours to manage.
 */
function missingSchemaColumns(
  schema: typeof eventsTable | typeof ticketTypesTable,
  table: HubDbTableDetail,
): string[] {
  const present = new Set((table.columns ?? []).map((col) => col.name));
  return schema.columns
    .filter((col) => col.type !== 'FOREIGN_ID' && !present.has(col.name))
    .map((col) => col.name);
}

/**
 * Read-only summary of what HubSpot actually returns for our two tables, for
 * diagnosing a provisioning failure against a live portal. Never mutates.
 */
export async function describeHubDbTables(token: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};

  const list = await hubdbGet(token, '?archived=false');
  if (list.ok) {
    const data = await list.json<{ results?: Array<HubDbTableDetail & { rowCount?: number }> }>();
    // Names and ids only: the full list is every table in the portal at full
    // detail, which is thousands of lines.
    out.publishedTables = (data.results ?? []).map(
      (t) => `${t.id}:${t.name} (${t.rowCount ?? 0} rows)`,
    );
  } else {
    out.publishedTables = { status: list.status, body: await list.text() };
  }

  for (const name of [ticketTypesTable.name, eventsTable.name]) {
    const res = await hubdbGet(token, `/${name}/draft`);
    if (!res.ok) {
      out[name] = { status: res.status, body: await res.text() };
      continue;
    }
    const table = await res.json<HubDbTableDetail & { rowCount?: number }>();
    // Summary only: a real table's full detail is thousands of lines of audit
    // metadata, which is what made the first dump unreadable.
    out[name] = {
      status: res.status,
      id: table.id,
      name: table.name,
      useForPages: table.useForPages,
      rowCount: table.rowCount,
      columns: (table.columns ?? []).map((col) => `${col.id}:${col.name}`).join(', '),
      matchesOurSchema: missingSchemaColumns(schemaFor(name), table).length === 0,
      missingFromOurSchema: missingSchemaColumns(schemaFor(name), table),
    };
  }

  return out;
}

/**
 * Refuses to touch a table that shares our name but not our schema.
 *
 * A portal can already have its own `events` table — Weld's is hand-built,
 * carries live rows, and drives their public pages. Reconciling it would add
 * our columns to it and repoint its dynamic-page meta tags at columns it does
 * not have. Provisioning only manages tables it created.
 */
function assertOurTable(
  schema: typeof eventsTable | typeof ticketTypesTable,
  table: HubDbTableDetail,
): void {
  const missing = missingSchemaColumns(schema, table);
  if (missing.length === 0) return;
  throw new Error(
    `HubDB table "${schema.name}" (${table.id}) already exists in this portal but is ` +
      `not the table this app provisions: it has no ${missing.join(', ')}. ` +
      'Refusing to modify a table this app did not create. Record the existing ' +
      'table ids against the tenant instead of provisioning.',
  );
}

export interface ProvisionResult {
  eventsTableId: string;
  ticketTypesTableId: string;
  /** true if tables were newly created, false if existing tables were reused */
  created: boolean;
}

/**
 * Provisions HubDB tables for a portal.
 *
 * @param accessToken - a valid HubSpot OAuth access token for the portal
 */
export async function provisionHubDbTables(
  env: Env,
  portalId: string,
  accessToken: string,
): Promise<ProvisionResult> {
  // --- create (or find) both tables; every cross-table reference is deferred ---
  let created = false;

  let ticketTypesTableId: string;
  const existingTicketTypes = await findTable(accessToken, ticketTypesTable.name);
  if (existingTicketTypes) {
    assertOurTable(ticketTypesTable, existingTicketTypes);
    ticketTypesTableId = existingTicketTypes.id;
  } else {
    ticketTypesTableId = await createTable(accessToken, ticketTypesTable);
    created = true;
  }

  let eventsTableId: string;
  const existingEvents = await findTable(accessToken, eventsTable.name);
  if (existingEvents) {
    assertOurTable(eventsTable, existingEvents);
    eventsTableId = existingEvents.id;
    // Ensure useForPages is enabled even on existing tables.
    if (!existingEvents.useForPages) {
      await ensureUseForPages(accessToken, eventsTableId);
    }
  } else {
    eventsTableId = await createTable(accessToken, eventsTable);
    created = true;
  }

  // --- read both back for their live column ids ---
  // HubSpot assigns column ids and they are not positional, so a foreign
  // reference and a dynamic-page meta tag can only be pointed at a real column
  // once the table exists. This also repairs a table left half-built earlier.
  const ticketTypesDetail = await findTable(accessToken, ticketTypesTableId);
  const eventsDetail = await findTable(accessToken, eventsTableId);
  const resolved: ResolvedTables = {
    [ticketTypesTable.name]: {
      id: ticketTypesTableId,
      columnIdByName: columnIdByName(ticketTypesDetail),
    },
    [eventsTable.name]: { id: eventsTableId, columnIdByName: columnIdByName(eventsDetail) },
  };

  // --- fill in the deferred references and meta tags ---
  await reconcileTable(
    accessToken,
    resolved[ticketTypesTable.name],
    ticketTypesTable,
    ticketTypesDetail,
    resolved,
  );
  await reconcileTable(
    accessToken,
    resolved[eventsTable.name],
    eventsTable,
    eventsDetail,
    resolved,
  );

  // Publish both (idempotent — publishing a published table is a no-op on HubSpot's side).
  await publishTable(accessToken, ticketTypesTableId);
  await publishTable(accessToken, eventsTableId);

  // Persist to D1.
  await env.DB.prepare(
    `UPDATE tenants
     SET hubdb_events_table_id = ?1,
         hubdb_ticket_types_table_id = ?2,
         installed_at = COALESCE(installed_at, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
     WHERE portal_id = ?3`,
  )
    .bind(eventsTableId, ticketTypesTableId, portalId)
    .run();

  return { eventsTableId, ticketTypesTableId, created };
}
