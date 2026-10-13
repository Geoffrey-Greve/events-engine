/**
 * Row fixtures for the shared test D1.
 *
 * The schema is the real one (see `migrate.ts`), so D1's foreign keys and NOT NULL
 * constraints are live in the suite exactly as they are in production. Everything here
 * exists to make satisfying them a one-liner rather than a reason to hand-roll a laxer
 * table: `events.portal_id` REFERENCES `tenants`, and so does every other row that
 * carries a portal id, so a test that mints a fresh portal has to register it first.
 */

/** Values a test wants on a row beyond the ones these helpers always supply. */
export type Columns = Record<string, string | number | null>;

/**
 * Register a portal, so rows carrying its id satisfy their foreign key.
 *
 * Idempotent, because most files mint ids per test case and seed through one helper that
 * several cases call. `display_name` is NOT NULL with no default in 0001, and no test has
 * ever cared what it says.
 */
export async function seedTenant(
  db: D1Database,
  portalId: string,
  columns: Columns = {},
): Promise<string> {
  const names = ['portal_id', 'display_name', ...Object.keys(columns)];
  const values = [portalId, 'Test Tenant', ...Object.values(columns)];
  const placeholders = names.map((_, i) => `?${i + 1}`).join(', ');

  await db
    .prepare(`INSERT OR IGNORE INTO tenants (${names.join(', ')}) VALUES (${placeholders})`)
    .bind(...values)
    .run();

  return portalId;
}

async function insert(
  db: D1Database,
  table: string,
  columns: Columns,
  onConflict: 'fail' | 'ignore' = 'fail',
): Promise<void> {
  const names = Object.keys(columns);
  const placeholders = names.map((_, i) => `?${i + 1}`).join(', ');
  const verb = onConflict === 'ignore' ? 'INSERT OR IGNORE' : 'INSERT';
  await db
    .prepare(`${verb} INTO ${table} (${names.join(', ')}) VALUES (${placeholders})`)
    .bind(...Object.values(columns))
    .run();
}

/**
 * An event, with the six columns 0001 marks NOT NULL filled in.
 *
 * `title`, `ends_at` and `capacity` are the ones tests routinely left out, because the
 * hand-rolled `events` tables made every column nullable. Pass `extra` for whatever the
 * case is actually about — a provider, a category, an owner, a sales window.
 */
export async function seedEvent(
  db: D1Database,
  args: {
    portalId: string;
    eventId: string;
    hubspotEventId: string;
    startsAt?: string;
    endsAt?: string;
    capacity?: number;
    title?: string;
    extra?: Columns;
  },
): Promise<string> {
  const startsAt = args.startsAt ?? new Date(Date.now() + 86_400_000).toISOString();
  await seedTenant(db, args.portalId);
  await insert(db, 'events', {
    id: args.eventId,
    portal_id: args.portalId,
    hubspot_event_id: args.hubspotEventId,
    title: args.title ?? 'Welding Fundamentals',
    starts_at: startsAt,
    ends_at: args.endsAt ?? startsAt,
    capacity: args.capacity ?? 100,
    ...(args.extra ?? {}),
  });
  return args.eventId;
}

/**
 * A ticket type for an event. `registrations.ticket_type_id` and `tickets.ticket_type_id`
 * both REFERENCE this table, so a fixture that invents an id has to create the row.
 */
export async function seedTicketType(
  db: D1Database,
  args: {
    portalId: string;
    eventId: string;
    ticketTypeId: string;
    name?: string;
    priceCents?: number;
    capacity?: number;
    extra?: Columns;
  },
): Promise<string> {
  await insert(
    db,
    'ticket_types',
    {
      id: args.ticketTypeId,
      portal_id: args.portalId,
      event_id: args.eventId,
      name: args.name ?? 'Standard',
      price_cents: args.priceCents ?? 0,
      capacity: args.capacity ?? 100,
      ...(args.extra ?? {}),
    },
    'ignore',
  );
  return args.ticketTypeId;
}

/**
 * The membership source mapping 0046 backfilled onto every portal installed before it:
 * Weld Australia's company property families, contact mirror and Find a Member table.
 *
 * A tenant inserted after the migrations run gets none of it (a new portal reads no
 * company, mirror or directory source until it is configured), so a test proving how
 * those sources resolve says so by applying this, rather than relying on names the code
 * no longer carries.
 */
export const WELD_MEMBERSHIP_SOURCE_COLUMNS: Columns = {
  membership_company_sources: JSON.stringify([
    {
      category: 'corporate',
      statusProperty: 'corporate_membership_status',
      levelProperty: 'corporate_membership_level_2',
    },
    {
      category: 'industry_supplier',
      statusProperty: 'industry_supplier_membership_status',
      levelProperty: 'industry_supplier_membership_level_2',
    },
  ]),
  membership_mirror_status_property: 'wa_company_membership_status',
  membership_mirror_tier_property: 'wa_company_membership_tier',
  member_directory_config: JSON.stringify({
    table: 'members',
    emailColumn: 'contact_email',
    tierColumn: 'member_tier',
    activeColumn: 'is_active',
    companyIdColumn: 'hubspot_company_id',
  }),
};

/** Apply the Weld-shaped membership sources (and any other columns) to an existing tenant. */
export async function configureWeldMembership(
  db: D1Database,
  portalId: string,
  extra: Columns = {},
): Promise<void> {
  const columns = { ...WELD_MEMBERSHIP_SOURCE_COLUMNS, ...extra };
  const names = Object.keys(columns);
  await db
    .prepare(
      `UPDATE tenants SET ${names.map((n, i) => `${n} = ?${i + 1}`).join(', ')} WHERE portal_id = ?${names.length + 1}`,
    )
    .bind(...Object.values(columns), portalId)
    .run();
}
