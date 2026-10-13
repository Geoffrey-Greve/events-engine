/**
 * HubDB table schema definitions (single source of truth).
 *
 * The `events` and `ticket_types` HubDB tables back the public-facing event pages and are
 * also the join target the worker's reserve/availability contract maps onto. These typed
 * objects are the canonical schema: the worker's provisioning routine and the HubSpot
 * Project tooling both import them so the deployed table shape and the worker's
 * expectations can never drift. Cross-table references use the foreign table's `name`
 * (`foreignTable`), resolved to a concrete HubDB table id at deploy time.
 */

export type HubDbColumnType =
  | 'TEXT'
  | 'RICHTEXT'
  | 'NUMBER'
  | 'BOOLEAN'
  | 'DATETIME'
  | 'IMAGE'
  | 'SELECT'
  | 'FOREIGN_ID';

export interface HubDbSelectOption {
  name: string;
  label: string;
}

export interface HubDbColumn {
  name: string;
  label: string;
  type: HubDbColumnType;
  /** Present for SELECT columns. */
  options?: HubDbSelectOption[];
  /** For FOREIGN_ID columns: the referenced table's `name` (resolved to an id at deploy). */
  foreignTable?: string;
  /**
   * For FOREIGN_ID columns: the `name` of the column in the foreign table to
   * display. HubSpot assigns column ids itself and they are not positional, so
   * this is resolved against the live table at deploy rather than hard-coded.
   */
  foreignColumnName?: string;
}

export interface HubDbTableSchema {
  name: string;
  label: string;
  useForPages: boolean;
  allowPublicApiAccess: boolean;
  allowChildTables: boolean;
  enableChildTablePages: boolean;
  /**
   * `name` of the column supplying each dynamic-page meta tag, resolved to a
   * HubSpot column id at deploy for the same reason as `foreignColumnName`.
   */
  dynamicMetaTags?: Record<string, string>;
  columns: HubDbColumn[];
}

export const eventsTable: HubDbTableSchema = {
  name: 'events',
  label: 'Events',
  useForPages: true,
  allowPublicApiAccess: true,
  allowChildTables: false,
  enableChildTablePages: false,
  dynamicMetaTags: {
    DESCRIPTION: 'description',
    FEATURED_IMAGE_URL: 'featured_image',
  },
  columns: [
    { name: 'title', label: 'Title', type: 'TEXT' },
    { name: 'worker_event_id', label: 'Worker event id (reserve :slug)', type: 'TEXT' },
    { name: 'summary', label: 'Summary', type: 'TEXT' },
    { name: 'description', label: 'Description', type: 'RICHTEXT' },
    { name: 'starts_at', label: 'Starts at (UTC)', type: 'DATETIME' },
    { name: 'ends_at', label: 'Ends at (UTC)', type: 'DATETIME' },
    { name: 'timezone', label: 'Display timezone (IANA)', type: 'TEXT' },
    { name: 'is_online', label: 'Online event', type: 'BOOLEAN' },
    { name: 'location', label: 'Location', type: 'TEXT' },
    {
      name: 'status',
      label: 'Status',
      type: 'SELECT',
      options: [
        { name: 'draft', label: 'Draft' },
        { name: 'published', label: 'Published' },
      ],
    },
    { name: 'featured_image', label: 'Featured image', type: 'IMAGE' },
    {
      name: 'ticket_types',
      label: 'Ticket types (reference)',
      type: 'FOREIGN_ID',
      foreignTable: 'ticket_types',
      foreignColumnName: 'name',
    },
  ],
};

export const ticketTypesTable: HubDbTableSchema = {
  name: 'ticket_types',
  label: 'Ticket Types',
  useForPages: false,
  allowPublicApiAccess: true,
  allowChildTables: false,
  enableChildTablePages: false,
  columns: [
    { name: 'name', label: 'Name', type: 'TEXT' },
    { name: 'worker_ticket_type_id', label: 'Worker ticket type id', type: 'TEXT' },
    { name: 'event_path', label: 'Event path (join key)', type: 'TEXT' },
    {
      name: 'event',
      label: 'Event (reference)',
      type: 'FOREIGN_ID',
      foreignTable: 'events',
      foreignColumnName: 'title',
    },
    { name: 'price_cents', label: 'Price (integer cents)', type: 'NUMBER' },
    { name: 'currency', label: 'Currency', type: 'TEXT' },
    { name: 'member_only', label: 'Member only', type: 'BOOLEAN' },
    { name: 'description', label: 'Description', type: 'TEXT' },
    { name: 'max_per_order', label: 'Max per order', type: 'NUMBER' },
    { name: 'sort_order', label: 'Sort order', type: 'NUMBER' },
  ],
};

/** Every HubDB table the platform provisions, keyed by table `name`. */
export const hubDbTables = {
  events: eventsTable,
  ticket_types: ticketTypesTable,
} as const;
