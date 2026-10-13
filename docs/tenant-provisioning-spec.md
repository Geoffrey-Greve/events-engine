# Paddock — Per-Tenant Provisioning Architecture
**Part of:** event-engine / Paddock · **Owner:** Refuel Creative
**Resolves:** how CMS assets get into a customer's HubSpot portal as an installable app, without per-portal scripting in a theme repo.

---

## The core distinction: data vs code

Two kinds of asset, provisioned two different ways. Conflating them is the trap.

| Asset | Kind | How it gets into the customer portal | Lives in |
|---|---|---|---|
| `events` HubDB table | **Per-tenant data container** | **Created via HubDB API on install**, using the customer's OAuth token | Provisioning routine in **`event-engine`** (worker) |
| `ticket_types` HubDB table | Per-tenant data container | Created via HubDB API on install | Worker provisioning routine |
| Dynamic-page template (`events.html`) | **Shared app code** | **Ships WITH the app** — referenced, not copied per portal | **`paddock-hubspot`** Project repo |
| Registration custom module | Shared app code | Ships with the app | `paddock-hubspot` Project repo |
| App Cards (event mgmt UI) | Shared app code | Ships with the app | `paddock-hubspot` Project repo |
| The `/events` dynamic page | Per-tenant binding | Created via Pages API on install, OR wizard-guided (recommended v1) | Worker provisioning OR onboarding step |

**The rule:** *data* is per-tenant and cloned into the portal via API; *code* (templates, modules, cards) is shared app code that ships with the app and is referenced by every connected portal. **Never copy template/module code into individual portals** — that creates N divergent copies you can't maintain or update centrally. This is the whole reason it's an app and not a theme.

**Weld is not special.** Weld becomes the first connected portal, provisioned by the exact same routine every future customer will use. Nothing goes in the Weld theme repo. (The earlier "run a script in the Weld theme" approach is superseded — discard it.)

---

## What runs on `app.install`

The worker's install handler (fired by HubSpot's install webhook + OAuth token exchange):

```
1. Exchange OAuth code → store access + refresh tokens for the portal (per-tenant secret).
2. Create the tenant row (portal_id, status="installed").
3. Provision HubDB tables in the customer portal via the customer's token:
   POST /cms/v3/hubdb/tables  (events schema)
   POST /cms/v3/hubdb/tables  (ticket_types schema)
   → enable "use for dynamic pages" on events; publish the tables.
   → store the returned table IDs on the tenant row (the app references these).
4. (Optional v1) Create the /events dynamic page via the Pages API bound to the events
   table + the app's template. OR defer to the onboarding wizard (recommended — see below).
5. Seed nothing else; the customer adds events via App Cards (or the raw HubDB editor for MVP).
```

Required OAuth scopes include `hubdb`, CMS pages, plus the CRM/marketing-events/commerce scopes from the main spec. Confirm the exact scope strings against current docs at build.

---

## The dynamic page: provision vs wizard

The one asset that's genuinely portal-specific *and* fiddly to automate is the dynamic page, because it binds three things — the portal's domain, a route (`/events`), the app's template, and the portal's HubDB table.

- **Recommended v1 — wizard-guided.** The App Home onboarding step instructs the admin: "Create a page, choose the Paddock Events template, select your Events table as the data source." This is a ~30-second click in HubSpot's UI and sidesteps every Pages-API edge case (domain selection, route collisions, template binding, publish state). One manual step, fully reliable.
- **v2 — fully automated** via the Pages API once the edge cases are mapped (which domain if the portal has several? what if `/events` is taken?). Automate only after the wizard path is proven, because a botched auto-created page is a worse onboarding experience than one guided click.

Don't burn time fully automating page creation in the first build — it's the highest-effort, lowest-reliability part of provisioning. Wizard it.

---

## Impact on the Phase 9 work already done

The Phase 9 prompt produced the HubDB tables + template + module as Project assets deployed once. Correct that split:

- **Template + module + App Cards:** stay as `paddock-hubspot` Project assets. ✅ No change.
- **HubDB table definitions:** move from "static schema deployed once" to a **provisioning routine in the worker** that creates them per-portal via the HubDB API on install. The table *shape* is still defined in code (one source of truth), but it's instantiated per tenant at install, not deployed as a single shared table.
- **Page creation:** becomes an onboarding wizard step (v1), not a build artifact.

For Weld specifically (already mid-build): you can provision Weld's tables by running the install routine against Weld's portal manually (same code path, triggered by hand), so Weld doesn't wait on the full marketplace install flow. Weld is "tenant zero," provisioned by the real routine, not a hand-built special case.

---

## Why this scales

- One template/module/card codebase serves every portal → fix once, all customers get it.
- Per-tenant data tables are created by one routine → consistent across customers, no drift.
- Adding customer N is: install → OAuth → tables auto-provisioned → one wizard click for the page → subscribe. No per-customer repo, no per-customer script, no theme edits.
- This is the difference between "we built Weld an events system" and "we built a product Weld installed." The provisioning routine IS the product's installability.