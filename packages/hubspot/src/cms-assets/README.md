# `cms-assets` — Event registration front end (project component)

The CMS half of event-engine, packaged as a **HubSpot project component** so it deploys
with `hs project upload` (platformVersion `2026.03`, see `../../hsproject.json`) rather than
a separate `hs upload`. The capacity/seat/payment brain is the Cloudflare Worker; HubSpot is
the system of record and renders the front end.

> **Portal-agnostic by contract.** Worker base URL, HubDB table ids, brand, GST rate and
> contact-property internal names are all *configuration*, supplied per portal at install
> time. No tenant data, copy, colour, or id is committed here. Brand lives in the consuming
> **theme** — these assets ship structure and semantic `.evt-*` hooks only.

## What's in the component

```
cms-assets-hsmeta.json                  Component manifest hs project upload reads (uid + type: cms-assets)
cms-assets.json                         Asset inventory for this component (template + module + css)
templates/events.html                   Dynamic page template — listing + detail/registration
modules/event-registration.module/      Registration widget (live availability + reserve)
  module.html  module.js  module.css  fields.json  meta.json
css/events.css                          Minimal, unopinionated structural CSS
workflows/                              Documented specs for the lifecycle workflows the
                                        customer builds (markdown — reference, not uploaded)
```

`cms-assets-hsmeta.json` is the component manifest the CLI reads (`uid`, `type: cms-assets`,
and `config.themePath` pointing at the folder that holds `cms-assets.json`); `cms-assets.json`
enumerates the deployed assets
(`templates/events.html`, the `event-registration` module, `css/events.css`). The
`workflows/` markdown is reference documentation only.

> Field names track HubSpot's `cms-assets` project-component schema for platformVersion
> `2026.03`; confirm against the installed CLI (`hs project upload`) for the target portal.

## `events.html` — dynamic template

One template, two render modes, branched on the HubDB dynamic-page context variables:

- **`dynamic_page_hubdb_row` present** → a single event was requested → **DETAIL + REGISTRATION**.
  Pulls ticket types for *this* event by joining `ticket_types` on `event_path == hs_path`
  (portable — no per-portal table ids), then renders the `event-registration` module.
- **`dynamic_page_hubdb_table_id` present (no row)** → the bare path → **LISTING** of published
  events ordered by `starts_at`.

Styling is deliberately minimal; the consuming theme owns brand.

## `event-registration` module

- Reads **live availability from the WORKER**, never from HubDB counts
  (`GET {worker}/api/v1/events/:slug/availability`).
- `POST /api/v1/events/:slug/reserve` with a stable **`Idempotency-Key`** (reused across
  retries of one submission, cleared on a terminal outcome) and `X-Portal-Id`.
- Branches the reserve response: **`waitlisted`** / **`confirmed`** (free) / **`reserved`**
  (paid). For `reserved` it polls `GET /api/v1/orders/:id` until a `paymentUrl` appears, then
  redirects to the **HubSpot-hosted invoice**.
- Captures optional buyer **ABN** and per-attendee fields for **group registration**.
- Worker base URL + portal id are **module fields** (`fields.json`) with a theme-setting
  fallback — never hard-coded. The host portal must allow the worker origin in the app's
  `permittedUrls` so the browser fetches succeed.

The worker stays authoritative at reserve time, so the widget **degrades gracefully** if the
availability read is missing or fails — it just hides per-ticket counts and still lets the
buyer reserve.

## Workflows the customer builds

These are **documented specs** (`workflows/`), not committed workflow JSON, because HubSpot
workflow exports embed portal-scoped ids. See [`workflows/README.md`](workflows/README.md):

| Spec | Trigger | Reads |
| --- | --- | --- |
| `confirmation-with-ics.md` | Marketing Event membership → **Registered** | `teams_join_url` (online join URL) + event props, attaches `.ics` |
| `reminder-t7.md` | 7 days before `event_start_datetime` | event props (no join link this far out) |
| `reminder-t1.md` | 1 day before `event_start_datetime` | event props + `teams_join_url` (join button) |
| `no-show-followup.md` | native Marketing Event **No-Show** state | event props |

The worker writes `teams_join_url` to the contact **before** the confirmation workflow fires,
because HubSpot generates the calendar invite + emails and the personal join URL must already
be present.

## Deploy

From `packages/hubspot/`:

```
hs project upload          # deploys hsproject.json → this cms-assets component (templates, module, css)
```

HubDB tables (`../hubdb/`) and the workflows are created/built separately per portal — see
`../hubdb/README.md` and `workflows/README.md`. Then create a HubDB-backed site page on
`events.html`, bound to the `events` table with dynamic pages enabled.
