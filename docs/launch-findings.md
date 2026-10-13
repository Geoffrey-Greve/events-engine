# Launch findings

Bugs and verification results found while working launch-blocker packages. One entry per
finding, newest first. Severity: **blocker** / **high** / **medium** / **low**.

---

## WP1 — Is the HubSpot GST tax rate additive or inclusive?

**Date:** 2026-09-14
**Severity:** blocker (decides the direction of WP3 and WP5)
**Status:** PARTIALLY CONFIRMED — platform behaviour settled, the two portal rate IDs are not.

### The question

The ex-GST pricing convention (14 Sep 2026) assumes HubSpot tax rate `162672232` (live portal
441838610) adds 10% **on top** of the line item price. If HubSpot instead treated the line price
as GST-inclusive, migrating stored prices down by 1.1 would send every invoice 10% light, and the
correct migration would be the opposite one.

### What is confirmed

**HubSpot applies a tax-library rate additively. The line price is treated as ex-tax and the rate
is added on top.** This is platform behaviour, not a per-rate setting — HubSpot's tax library has
no inclusive/exclusive toggle.

Evidence, from live line items in Refuel Creative's own AU portal (4538263, AUD, GST 10% rate
`15270415`):

| Line item | `amount` | `hs_tax_amount` | `hs_post_tax_amount` |
|---|---|---|---|
| Induzy Theme - WordPress | 140.00 | 14.00 | 154.00 |
| Support pack - 10 hour pack | 2600.00 | 260.00 | 2860.00 |
| Google ad management | 968.00 | 96.80 | 1064.80 |

`hs_tax_amount` = `amount` × 0.10 and `hs_post_tax_amount` = `amount` × 1.1 in every case. Under
inclusive treatment `hs_post_tax_amount` would equal `amount`. HubSpot's own property definitions
say the same thing: `amount` is "Net price", `hs_post_tax_amount` is "**Net price after tax** —
amount of line item after applying tax", and `hs_tax_amount` is "amount of tax calculated based on
tax rate for this line item". There is no `hs_tax_inclusive` property on `line_items` or on
`invoices`.

This is the direction WP3 and WP5 assume. **Storing ex-GST prices is correct.**

### What is NOT confirmed

The two specific rate IDs have not been read, because this session has no credentials for either
portal — the HubSpot MCP connection is bound to Refuel Creative (4538263), and there is no Weld
Xero org connected either.

| Portal | Env | Tax rate ID | Confirmed? |
|---|---|---|---|
| 441838610 | staging = **LIVE** (weldaustralia.com.au) | `162672232` | ❌ not read |
| 443253065 | dev | `162970478` | ❌ not read |

Still to be confirmed by a human with portal access, per rate:

1. The rate exists and is selectable on invoice line items.
2. Its percentage is **10**, not 0.1 or 110.
3. It is the GST rate **imported from Xero** (per CLAUDE.md — a hand-made 10% rate will not
   reconcile against the synced Xero invoice), and is the one the worker's tenant row points at
   (`tenants.xero_gst_rate_id`).

### How to confirm — two ways, ten minutes

**A. The decisive test (no worker access needed).** In each portal, create a draft invoice with one
line item at $100.00, apply the rate, and read the total.

- Total **$110.00** → additive. Confirmed. Proceed with WP3/WP5 as planned.
- Total **$100.00** with $9.09 tax → inclusive. **Stop. Do not start WP5.** The migration direction
  flips and the convention needs re-writing.

Then delete the draft. Settings → Objects → Invoices → Tax rates shows the rate's label and
percentage, which covers points 2 and 3 above, but the draft invoice is what actually proves the
arithmetic.

**B. The worker already has a read-only diagnostic** that dumps the portal's whole tax library, the
selectable options on `hs_tax_rate_group_id`, and whether the tenant's configured
`xero_gst_rate_id` is among them:

```bash
# LIVE (portal 441838610)
curl -s https://event-engine-staging.refuel-creative.workers.dev/api/v1/manage/diagnostics/hubspot/tax-rates \
  -H "X-Portal-Id: 441838610" -H "X-Admin-Key: $ADMIN_API_KEY_441838610" | jq

# dev (portal 443253065)
curl -s https://event-engine-dev.refuel-creative.workers.dev/api/v1/manage/diagnostics/hubspot/tax-rates \
  -H "X-Portal-Id: 443253065" -H "X-Admin-Key: $ADMIN_API_KEY_443253065" | jq
```

Read `tenant.configuredRateFound` (must be `true`), `tenant.configuredRate` (the rate the worker is
actually sending), and `property.options` (what HubSpot will accept on a line item). This confirms
points 1–3 but not the arithmetic — the tax-rates API returns no inclusive/exclusive field, because
there isn't one.

### Recorded for the record

| Portal | Env | GST rate ID | GST-free rate ID |
|---|---|---|---|
| 441838610 | staging = LIVE | `162672232` | see `tenants.xero_gst_free_rate_id` |
| 443253065 | dev | `162970478` | see `tenants.xero_gst_free_rate_id` |
| 4538263 | Refuel Creative (reference only) | `15270415` ("GST 10%") | n/a |

**Owner:** Ryan / Olivier. **Blocks:** WP3, WP5.
