# Paddock — UI Surfaces, App Cards, and Marketplace Onboarding/Billing
**Part of:** event-engine / Paddock · **Owner:** Refuel Creative
**Fills three spec gaps:** (1) the full UI inventory, (2) App Cards tier confirmation, (3) the marketplace install → signup → billing flow.

---

## 1. UI surfaces — the complete inventory

The principle holds: **attendee and organiser UI is all inside HubSpot.** The only non-HubSpot surface is the staff check-in scanner (offline requirement forces it out), plus optionally a one-page ticket view. No separate public website.

| # | Surface | Who sees it | Where it lives | Built with |
|---|---|---|---|---|
| 1 | Event listing page | Attendees (public) | HubSpot CMS (`weldaustralia.com.au/events`) | HubDB dynamic page (Project repo template + Weld theme glue) |
| 2 | Event detail + registration | Attendees (public) | HubSpot CMS page | HubDB dynamic page + the registration **custom module** |
| 3 | Payment / checkout | Attendees (public) | **HubSpot-hosted invoice/payment page** | HubSpot Commerce (Stripe underneath, AUD) |
| 4 | Confirmation, reminders, tickets, `.ics` | Attendees | HubSpot **emails + workflows** | HubSpot (worker writes join URL/QR data to contact properties) |
| 5 | QR ticket | Attendees | QR rendered **in the HubSpot confirmation email** (image), or a one-page worker-hosted ticket view | HubSpot email (preferred) — avoids any standalone page |
| 6 | Event management (create/edit event, set capacity, ticket types, view registrations) | Weld staff (organisers) | **Inside HubSpot** via **App Cards / App Home** (the Paddock app's UI extensions) | `paddock-hubspot` Project — App Cards (React UI extensions) calling the worker |
| 7 | Live registration/attendance dashboard | Weld staff | Inside HubSpot via App Card, or native HubSpot reports on the Marketing Event | App Card + native reports |
| 8 | **Check-in scanner (door app)** | Weld staff (at venue) | **Standalone PWA** (NOT HubSpot — needs offline) | Thin PWA calling the worker's `/api/v1/checkin` |
| 9 | App onboarding / activation / billing | Buyer admin (any portal) | Inside HubSpot via **App Settings / App Home**, + a HubSpot-hosted checkout for the Paddock subscription | `paddock-hubspot` Project (App Settings page) + HubSpot Commerce in Refuel's portal |

**MVP simplification for Weld:** surface 6 (event management) can, for Weld's first pass, ride on the **raw HubDB table editor** instead of polished App Cards — Weld staff create/edit event rows directly. App Cards are a *product* requirement (every marketplace customer needs them) more than a *Weld* one. Decide per timeline: ship Weld on the HubDB editor, build App Cards as part of the marketplace track.

**The only genuinely non-HubSpot UI is #8, the check-in scanner** — and it's staff-only, venue-only, and forced out solely by the offline requirement. Everything an attendee or admin touches is HubSpot.

---

## 2. App Cards on Professional — confirmed

- **Public marketplace app cards render on ALL tiers, including Professional.** The tier restriction that exists is for *private* app cards (historically Enterprise); public marketplace apps are explicitly exempt and available to all customers across tiers. Weld's Customer Platform Pro runs Paddock's App Cards fine.
- **Build App Cards, never classic CRM cards** — classic cards are deprecated (sunset 31 Oct 2026).
- **Caveat that does NOT affect us:** HubSpot-hosted *serverless App Functions* (in the Project) require Enterprise or a developer test account. Paddock's logic lives in the **Cloudflare Worker**, and App Cards call the worker via `hubspot.fetch` / external requests — so we never depend on HubSpot serverless functions, and the Enterprise gate is irrelevant. (Set `permittedUrls` in the app config to allow the worker's domain.)
- Platform: Projects framework, `platformVersion 2026.03`, App Cards via React UI extensions.

---

## 3. Marketplace install → signup → billing flow

**Key structural fact:** a HubSpot marketplace **install is free at the click** — there's no paid gate on install itself. HubSpot's marketplace doesn't bill installs the way an app store does; **billing is the developer's responsibility, handled after install.** So "install and pay" is two motions, not one. The flow gates *activation* (not install) behind a Paddock subscription billed from Refuel's HubSpot portal.

### The flow

```
1. DISCOVER   Customer finds Paddock in the HubSpot App Marketplace.
                  │
2. INSTALL    Clicks Install → OAuth consent (scopes: CRM objects, marketing events,
   (free)         commerce/invoices, HubDB, contacts). App connects to their portal.
                  │  HubSpot fires app.install webhook → worker provisions a tenant
                  │  row (portal_id, OAuth tokens stored), status = "installed, inactive".
                  │
3. ONBOARD    App Home / App Settings page (UI extension) greets the admin:
                  │  - connect/confirm Stripe-in-HubSpot (their processor, their AUD)
                  │  - import Xero GST tax rate (or skip if not AU)
                  │  - choose a Paddock plan (per-portal tier)
                  │
4. SUBSCRIBE  Admin subscribes to Paddock. Billing runs through HUBSPOT PAYMENTS IN
   (paid)         REFUEL'S PORTAL: a HubSpot subscription (payment link / quote with
                  │  auto-charge) charges the customer; Stripe is the processor underneath.
                  │  HubSpot owns the subscription object (renewals, tiered pricing,
                  │  next-invoice generation, workflow triggers).
                  │
5. ACTIVATE   Refuel-portal subscription → paid webhook → worker flips the tenant to
                  │  status = "active". Until active, the app is installed but event
                  │  publishing is gated (read-only / trial).
                  │
6. CONFIGURE  Admin sets up: HubDB tables (auto-provisioned by the app or via the
                  │  setup wizard), the events page, the webinar provider + its creds
                  │  (Teams Graph app-access policy, etc.), branding.
                  │
7. LIVE       Customer publishes events. Paddock runs.
                  │
   UNINSTALL  app.uninstall webhook → worker deactivates the tenant, stops billing
                  (cancel the HubSpot subscription), retains/exports data per policy.
                  Certification requires honouring the Uninstall App API endpoint.
```

### Billing model (decided)

- **Paddock charges customers via HubSpot payments in Refuel's portal, Stripe underneath, per-portal flat tier.** This mirrors how Paddock lets *its* customers charge attendees — same mechanism, one less system to learn.
- **HubSpot owns the subscription** (auto-charge via payment links/quotes; tiered pricing supported since Nov 2025; renewals + next-invoice + workflows handled by HubSpot). Trade-off: Stripe sees only the charge, no subscription object — fine because HubSpot is the billing source of truth and the model is flat per-portal, not usage-metered.
- **Not Stripe Billing direct.** Only revisit Stripe Billing if Paddock later needs usage-metered billing, advanced dunning, or Stripe-side subscription analytics — none required for flat per-portal licensing.
- **Trial/freemium option:** the "installed, inactive" state is a natural free trial — let them configure and preview, gate *publishing* (or cap to one event / N registrations) until subscribed.

### Two-portal mental model (don't conflate)

- **Refuel's portal:** where Paddock's OWN billing lives — the subscriptions that charge Paddock's customers. Refuel is the merchant.
- **Customer's portal (e.g. Weld):** where the customer's EVENT billing lives — the invoices that charge *their* attendees, via *their* Stripe. The customer is the merchant for their events.
- Paddock the app provisions and operates in the customer's portal; Paddock the business bills from Refuel's portal. Same tooling (HubSpot payments + Stripe), two separate merchant relationships. Keep these straight in the data model: tenant billing status (Refuel-side) is distinct from the tenant's event-payment config (customer-side).

### Provisioning specifics (worker)

- `app.install` webhook → create tenant, store OAuth tokens (refreshable), status `installed`.
- `app.uninstall` webhook → deactivate, call HubSpot's Uninstall endpoint flow, stop Refuel-side billing.
- Tenant status machine: `installed → active (subscribed) → past_due → cancelled`. Gate event publishing on `active`.
- OAuth token refresh handled per tenant; store refresh tokens as secrets.
- Required OAuth scopes (confirm against current docs at build): CRM objects read/write (contacts, deals, line items, invoices, products), marketing events, commerce/payments, HubDB, and the App Card/UI-extension scopes.

---

## 4. Build-brief impact

- **Phase 9** already splits product Project assets from Weld theme glue. Add: the **App Settings/App Home onboarding+billing UI** and the **App Cards event-management UI** are Project-repo work, and are largely a *marketplace-track* concern — for Weld MVP, event management can ride the raw HubDB editor.
- **New phase (marketplace track, post-Weld-MVP):** "App scaffolding + onboarding + billing" — OAuth, install/uninstall webhooks, tenant provisioning, App Home onboarding, Refuel-portal subscription wiring, activation gating. This is the productisation lift; it's not needed to get Weld live (Weld can be a manually-provisioned tenant).
- **Check-in PWA (Phase 7)** is confirmed as the one standalone front end — a thin offline-capable scanner, staff-only.