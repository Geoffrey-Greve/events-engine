import { env } from 'cloudflare:test';
import { eventsTable, ticketTypesTable } from '@paddock/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { provisionHubDbTables } from '../src/provision';
import type { Env } from '../src/types';

// events.ticket_types → ticket_types and ticket_types.event → events reference
// each other, so neither table can be created with both sides resolved. These
// tests pin the deferral: create, then reconcile once both ids are known.

const E = env as unknown as Env;

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}

interface StubTable {
  id: string;
  name: string;
  useForPages: boolean;
  columns: Array<{ id: string; name: string }>;
  published: boolean;
  dynamicMetaTags?: Record<string, number>;
}

/**
 * Stubs the HubDB v3 API, recording every call.
 *
 * Modelled on the real surface, because the paths are the thing under test:
 * writes and lookups only exist under `/draft`, publish is `/draft/push-live`,
 * and anything else 401s the way HubSpot 401s an unmatched route. A table
 * created but not yet published is absent from the published list but present
 * on its draft path.
 */
function stubHubDb(existing: Array<Partial<StubTable> & { id: string; name: string }> = []) {
  const calls: Call[] = [];
  let nextId = 900;
  // HubSpot's column ids are opaque and not positional. Start well away from 1
  // so any code that assumes "first column == id 1" fails here.
  let nextColumnId = 5000;

  // A pre-existing table carries the plain columns it was created with; only
  // the cross-table references are missing until the reconcile pass.
  const plainColumns = (name: string) =>
    (name === 'events' ? eventsTable : ticketTypesTable).columns
      .filter((c) => c.type !== 'FOREIGN_ID')
      .map((c) => ({ id: String(nextColumnId++), name: c.name }));

  const tables = new Map<string, StubTable>(
    existing.map((t) => [
      t.id,
      {
        useForPages: false,
        published: true,
        columns: plainColumns(t.name),
        ...t,
      } as StubTable,
    ]),
  );
  const find = (nameOrId: string) =>
    tables.get(nameOrId) ?? [...tables.values()].find((t) => t.name === nameOrId);
  const unmatched = () =>
    Response.json(
      { status: 'error', message: 'Any of the listed authentication credentials are missing' },
      { status: 401 },
    );

  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const path = url.replace('https://api.hubapi.com/cms/v3/hubdb/tables', '');
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path, body });

    const draft = /^\/([^/]+)\/draft$/.exec(path);
    const pushLive = /^\/([^/]+)\/draft\/push-live$/.exec(path);

    if (method === 'GET' && path.startsWith('?')) {
      return Response.json({ results: [...tables.values()].filter((t) => t.published) });
    }
    if (method === 'GET' && draft) {
      const table = find(draft[1]);
      return table ? Response.json(table) : new Response('', { status: 404 });
    }
    if (method === 'PATCH' && draft) {
      const table = find(draft[1]);
      if (!table) return new Response('', { status: 404 });
      if (body?.columns) {
        // Reject a foreign reference to a column the target table doesn't have,
        // the way HubSpot does.
        for (const column of body.columns as Array<Record<string, unknown>>) {
          if (column.foreignTableId === undefined || column.foreignColumnId === undefined) continue;
          const foreign = tables.get(String(column.foreignTableId));
          if (!foreign?.columns.some((c) => Number(c.id) === Number(column.foreignColumnId))) {
            return Response.json(
              {
                status: 'error',
                message: `Column \`${column.foreignColumnId}\` not found in foreign table \`${foreign?.name}\``,
                category: 'OBJECT_NOT_FOUND',
              },
              { status: 404 },
            );
          }
        }
        table.columns = body.columns.map((c: { id?: string | number; name: string }) => ({
          id: String(c.id ?? nextColumnId++),
          name: c.name,
        }));
      }
      if (body?.useForPages !== undefined) table.useForPages = Boolean(body.useForPages);
      if (body?.dynamicMetaTags) table.dynamicMetaTags = body.dynamicMetaTags;
      return Response.json(table);
    }
    if (method === 'POST' && pushLive) {
      const table = find(pushLive[1]);
      if (!table) return new Response('', { status: 404 });
      table.published = true;
      return Response.json(table);
    }
    if (method === 'POST' && path === '') {
      const id = String(nextId++);
      tables.set(id, {
        id,
        name: String(body?.name),
        useForPages: Boolean(body?.useForPages),
        columns: (body?.columns ?? []).map((c: { name: string }) => ({
          id: String(nextColumnId++),
          name: c.name,
        })),
        published: false,
      });
      return Response.json({ id, name: body?.name });
    }
    // Every other path is not a real HubDB endpoint.
    return unmatched();
  });

  return calls;
}

const created = (calls: Call[], name: string) =>
  calls.find((c) => c.method === 'POST' && c.path === '' && c.body?.name === name);
const columnsOf = (call: Call | undefined) =>
  (call?.body?.columns ?? []) as Array<Record<string, unknown>>;

// Suites share one D1 (singleWorker, isolatedStorage off) and each declares the
// `tenants` columns it needs, so whichever runs first fixes the schema. Add the
// provisioning columns if that suite wasn't this one.

afterEach(() => vi.unstubAllGlobals());

describe('provisionHubDbTables', () => {
  it('creates both tables despite the circular reference', async () => {
    stubHubDb();
    const result = await provisionHubDbTables(E, 'p-provision', 'tok');

    expect(result.created).toBe(true);
    expect(result.ticketTypesTableId).toBeTruthy();
    expect(result.eventsTableId).toBeTruthy();
  });

  it('creates plain columns only, deferring every cross-table reference', async () => {
    const calls = stubHubDb();
    await provisionHubDbTables(E, 'p-defer', 'tok');

    // Neither table can name a column id in the other at create time.
    const ticketTypes = columnsOf(created(calls, 'ticket_types'));
    expect(ticketTypes.map((c) => c.name)).not.toContain('event');
    expect(ticketTypes.map((c) => c.name)).toContain('price_cents');

    const events = columnsOf(created(calls, 'events'));
    expect(events.map((c) => c.name)).not.toContain('ticket_types');
    expect(events.map((c) => c.name)).toContain('title');

    // dynamicMetaTags needs real column ids too, so it waits for the reconcile.
    expect(created(calls, 'events')?.body?.dynamicMetaTags).toBeUndefined();
  });

  it('resolves foreign and meta-tag column ids from the live table, not by position', async () => {
    const calls = stubHubDb();
    const result = await provisionHubDbTables(E, 'p-columnids', 'tok');

    const eventsPatch = calls.find(
      (c) => c.method === 'PATCH' && c.path === `/${result.eventsTableId}/draft` && c.body?.columns,
    );
    const eventsColumns = columnsOf(eventsPatch);

    // events.ticket_types displays ticket_types.name — whatever id HubSpot gave it.
    const ticketTypesPatch = calls.find(
      (c) =>
        c.method === 'PATCH' && c.path === `/${result.ticketTypesTableId}/draft` && c.body?.columns,
    );
    const nameColumnId = columnsOf(ticketTypesPatch).find((c) => c.name === 'name')?.id;
    const reference = eventsColumns.find((c) => c.name === 'ticket_types');
    expect(reference?.foreignColumnId).toBe(Number(nameColumnId));
    expect(reference?.foreignColumnId).not.toBe(1);

    // Meta tags point at the description and featured_image column ids.
    const tags = eventsPatch?.body?.dynamicMetaTags as Record<string, number>;
    expect(tags.DESCRIPTION).toBe(Number(eventsColumns.find((c) => c.name === 'description')?.id));
    expect(tags.FEATURED_IMAGE_URL).toBe(
      Number(eventsColumns.find((c) => c.name === 'featured_image')?.id),
    );
  });

  it('adds the deferred column in the reconcile pass', async () => {
    const calls = stubHubDb();
    const result = await provisionHubDbTables(E, 'p-reconcile', 'tok');

    const patch = calls.find(
      (c) =>
        c.method === 'PATCH' && c.path === `/${result.ticketTypesTableId}/draft` && c.body?.columns,
    );
    const reference = columnsOf(patch).find((c) => c.name === 'event');
    expect(reference?.foreignTableId).toBe(Number(result.eventsTableId));
  });

  it('repairs an existing table left incomplete by a failed run', async () => {
    const calls = stubHubDb([
      { id: '101', name: 'ticket_types' },
      { id: '102', name: 'events', useForPages: true },
    ]);
    const result = await provisionHubDbTables(E, 'p-repair', 'tok');

    expect(result.created).toBe(false);
    expect(result.ticketTypesTableId).toBe('101');
    // No table is recreated; the missing reference is patched in instead.
    expect(calls.filter((c) => c.method === 'POST' && c.path === '')).toHaveLength(0);
    const patch = calls.find((c) => c.method === 'PATCH' && c.path === '/101/draft');
    expect(columnsOf(patch).find((c) => c.name === 'event')?.foreignTableId).toBe(102);
  });

  it('publishes through the draft push-live path', async () => {
    const calls = stubHubDb();
    const result = await provisionHubDbTables(E, 'p-publish', 'tok');

    const published = calls
      .filter((c) => c.method === 'POST' && c.path.endsWith('/draft/push-live'))
      .map((c) => c.path);
    expect(published).toContain(`/${result.ticketTypesTableId}/draft/push-live`);
    expect(published).toContain(`/${result.eventsTableId}/draft/push-live`);
  });

  it('finds an unpublished table from a failed run instead of duplicating it', async () => {
    // The published list cannot see these; only the draft lookup can.
    const calls = stubHubDb([
      { id: '201', name: 'ticket_types', published: false },
      { id: '202', name: 'events', published: false, useForPages: true },
    ]);
    const result = await provisionHubDbTables(E, 'p-unpublished', 'tok');

    expect(result.ticketTypesTableId).toBe('201');
    expect(result.eventsTableId).toBe('202');
    expect(calls.filter((c) => c.method === 'POST' && c.path === '')).toHaveLength(0);
  });

  it('refuses to modify a table that shares our name but not our schema', async () => {
    // Weld's portal has its own hand-built `events` table with live rows.
    const calls = stubHubDb([
      { id: '301', name: 'ticket_types' },
      {
        id: '302',
        name: 'events',
        useForPages: true,
        columns: [
          { id: '41', name: 'event_type' },
          { id: '45', name: 'event_description' },
          { id: '61', name: 'worker_event_id' },
        ],
      },
    ]);

    await expect(provisionHubDbTables(E, 'p-foreign', 'tok')).rejects.toThrow(
      /already exists in this portal but is not the table this app provisions/,
    );

    // Nothing was written to it.
    expect(calls.filter((c) => c.method === 'PATCH' || c.method === 'POST')).toHaveLength(0);
  });

  it('persists both ids to the tenant row', async () => {
    stubHubDb();
    await E.DB.prepare(
      "INSERT OR IGNORE INTO tenants (portal_id, display_name) VALUES (?1, 'Test Tenant')",
    )
      .bind('p-persist')
      .run();
    const result = await provisionHubDbTables(E, 'p-persist', 'tok');

    const row = await E.DB.prepare(
      'SELECT hubdb_events_table_id, hubdb_ticket_types_table_id FROM tenants WHERE portal_id = ?1',
    )
      .bind('p-persist')
      .first<{ hubdb_events_table_id: string; hubdb_ticket_types_table_id: string }>();
    expect(row?.hubdb_events_table_id).toBe(result.eventsTableId);
    expect(row?.hubdb_ticket_types_table_id).toBe(result.ticketTypesTableId);
  });
});
