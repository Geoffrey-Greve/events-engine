# HubDB setup

Two tables back the front end: **`events`** (dynamic-page source) and **`ticket_types`**
(child content read per event). Neither table stores availability, remaining seats, or any
count — those come *live from the worker*. HubDB holds content + the worker ids to call.

## Reference columns & the chicken-and-egg

The two tables reference each other, so neither id exists until the other is created. The
JSON ships with **placeholder tokens** for the portal-specific table ids:

- `ticket_types.table.json` → `event` column → `"foreignTableId": "__EVENTS_TABLE_ID__"`
- `events.table.json` → `ticket_types` column → `"foreignTableId": "__TICKET_TYPES_TABLE_ID__"`

These ids are **configuration** — they differ in every portal. Two ways to wire them:

**Recommended — create, then patch the references**

1. Create `ticket_types` first **without** the `event` reference column (delete that one
   column block, or leave the token and add the column from the UI afterwards). Note its id.
2. Create `events`, substituting `__TICKET_TYPES_TABLE_ID__` with the id from step 1.
   Note the `events` table id.
3. Add the `event` FOREIGN_ID column to `ticket_types`, pointing `foreignTableId` at the
   `events` id from step 2.

```bash
# 1. tokens stay; create and capture the id
hs hubdb create ticket_types.table.json     # -> ticket_types id = 1234567
# 2. substitute and create events
sed 's/__TICKET_TYPES_TABLE_ID__/1234567/' events.table.json > /tmp/events.json
hs hubdb create /tmp/events.json            # -> events id = 7654321
# 3. add the back-reference column to ticket_types from the UI or API, foreignTableId=7654321
```

**Portable join (what the templates actually use)**

The native `FOREIGN_ID` columns are convenient in the HubDB editor, but the **templates do
not depend on them** — coupling a distributable template to a portal-specific table id is
exactly what we avoid. Detail/registration instead joins on the **`event_path` text
column**: each `ticket_types` row stores the `hs_path` of its parent event, and the
template filters `ticket_types` by `event_path == dynamic_page_hubdb_row.hs_path`. No ids,
no per-portal template edits.

> Keep `ticket_types.event_path` in sync with the event row's **HubDB page path**
> (`hs_path`). A tiny workflow or the publishing checklist should enforce this.

## Enabling dynamic pages (`events`)

`events.table.json` sets `"useForPages": true`. On create, HubSpot adds the dynamic-page
**auto-columns** to the table — you do **not** define these yourself:

| Auto-column | Purpose |
| --- | --- |
| `hs_path` | URL slug segment appended to the page's base path → the detail URL |
| `hs_name` | Page/internal title for the generated detail page |
| `hs_child_table_id` | Child table for nested dynamic pages (unused here) |
| `hs_meta_description` | Per-row meta description |
| `hs_featured_image` | Per-row OG/featured image |

`dynamicMetaTags` maps SEO meta tags to columns. The indices in the JSON
(`DESCRIPTION: 4`, `FEATURED_IMAGE_URL: 11`) are **column ids** — verify/adjust them after
creation with `hs hubdb fetch <id>`, since column ids are assigned by the portal. They can
equally point at the `hs_meta_description` / `hs_featured_image` auto-columns if you prefer.

To finish dynamic pages: create a **site page** built on `templates/events.html`, open
**Settings → Advanced**, set the **HubDB table** to `events`, and publish. HubSpot then
renders one detail page per row at `<page-path>/<hs_path>` and the bare page path as the
listing.

## Column reference

### `events`
`title`, `worker_event_id` (the `:slug` passed to the worker's reserve/availability
endpoints), `summary`, `description`, `starts_at`/`ends_at` (ISO-8601 UTC — display tz is
the `timezone` column), `timezone` (IANA, e.g. supplied per portal), `is_online`,
`location`, `status` (`draft`/`published`), `featured_image`, `ticket_types` (reference).

### `ticket_types`
`name`, `worker_ticket_type_id` (the id used as `attendees[].ticketTypeId` on reserve),
`event_path` (join key → parent event `hs_path`), `event` (reference), `price_cents`
(integer cents, matches the worker's money convention), `currency` (e.g. `AUD`),
`member_only`, `description`, `max_per_order`, `sort_order`.

> **Prices** live in HubDB as integer cents to match the worker (money is never floats).
> The template divides by 100 for display only. The worker remains the source of truth for
> what a buyer is actually charged.
