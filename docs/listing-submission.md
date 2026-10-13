# Paddock — HubSpot Marketplace Listing Submission Package

## 1. App Identity

| Field | Value |
|---|---|
| App name | Paddock |
| App UID | `paddock_event_engine` |
| Developer | Refuel Creative (ryan@refuelcreative.com.au) |
| Category | Events / Event Management |
| Platform version | 2026.03 |

## 2. Short Description (≤ 160 chars)

> Atomic seat capacity, ticket types, waitlist, and QR check-in for HubSpot Marketing Events — built for member organisations.

## 3. Long Description

Paddock adds the event-management capabilities HubSpot Professional doesn't include out of the box: atomic seat capacity (never oversells, even under concurrent load), tiered member pricing with member-only gating, reservation holds with 15-minute TTL, an owner-curated waitlist, per-event refund policies with attendee transfer, QR-code ticket generation, and on-site check-in via a Progressive Web App.

All registration, payment, and attendance data stays in HubSpot — Paddock uses native Marketing Events for attendance tracking, CRM contacts for buyer records, Deals and Invoices for revenue, and HubDB for the public event listing pages. Stripe (in AUD) handles payments via HubSpot's invoicing flow. Xero reconciliation happens automatically via HubSpot Data Sync.

For online events, Paddock creates and manages Microsoft Teams webinars via the Graph API and matches post-event attendance reports back to HubSpot Marketing Event attendance records — automatically.

**Key capabilities:**
- Atomic seat math via Cloudflare Durable Objects — zero oversell guarantee
- Ticket types: open vs members-only, tiered member pricing by level + category, per-ticket GST toggle (Xero rate)
- Reservation hold (15 min) → payment → confirmation pipeline; per-event refund policy + attendee transfer
- Waitlist: owner-curated offers (the event owner picks who to offer freed seats to) with 30-min TTL
- QR ticket generation and offline-capable PWA check-in app
- Microsoft Teams webinar create/register/attendance pull (Graph API)
- Full HubSpot write-back via outbox queue: contacts, deals, invoices, Marketing Events

## 4. OAuth Scopes and Justifications

| Scope | Why it's needed |
|---|---|
| `crm.objects.marketing_events.read` | Read existing Marketing Events to link capacity records |
| `crm.objects.marketing_events.write` | Write registration/attendance/completion states to Marketing Events |
| `cms.hubdb.tables.read` | Read the events and ticket_types HubDB tables for dynamic pages |
| `cms.hubdb.tables.write` | Create and update the events / ticket_types HubDB tables on provisioning |
| `crm.objects.contacts.read` | Read contacts to resolve buyer/attendee records |
| `crm.objects.contacts.write` | Create/update contacts (buyer upsert, Teams join URL write) |
| `crm.objects.deals.read` | Read deals (idempotency — avoid duplicate deal creation on retry) |
| `crm.objects.deals.write` | Create deals for paid event orders |
| `crm.objects.line_items.read` | Read line items (idempotency check) |
| `crm.objects.line_items.write` | Create line items on deals and invoices |
| `crm.objects.invoices.read` | Read invoice status and payment link |
| `crm.objects.invoices.write` | Create and update invoices (draft → open) |

## 5. Demo Video Walkthrough Script

### Video 1 — OAuth Install & Onboarding (~4 min)
1. Open HubSpot marketplace listing → click Install
2. OAuth consent screen — show scopes, click Allow
3. Redirect to Paddock App Home — show onboarding checklist
4. Step 1: mark Stripe as connected
5. Step 2: enter Xero GST rate ID, save
6. Step 3: show billing status (explain plan activation)
7. Step 4: click "Create HubDB tables" — show tables created
8. Step 5: enter CMS domain, save
9. Step 6: enter Teams credentials, save
10. Show completed checklist
11. Show Connected Apps in HubSpot settings (proving the app is installed)

### Video 2 — Core Registration + Payment (~5 min)
1. Open a published event listing page (HubDB dynamic page)
2. Select ticket type, fill in buyer details, click Register
3. Show 15-minute reservation hold in the CMS module
4. Open the HubSpot Invoice email → pay via Stripe test card
5. Return to event page — show "Confirmed" status
6. Open HubSpot CRM: contact record, deal record, invoice record — all populated
7. Open Marketing Events: attendee shows as Registered

### Video 3 — App Card Event Management Flow (~4 min)
This video must show **complete App Card functionality** for the App Card Review Program.
1. Open a HubSpot Marketing Event record
2. Show "Event Capacity & Tickets" App Card tab — empty (no worker event yet)
3. Fill in create-event form (title, dates, capacity, provider)
4. Click Create — event appears with capacity stats
5. Add a ticket type (name, price, capacity, member-only toggle)
6. Edit event capacity — save changes
7. Open "Registrations & Attendance" App Card tab
8. Show registrations list and attendance sync status
9. Show waitlist entries if any

### Video 4 — Check-in PWA (~3 min)
1. Open checkin-pwa URL on a mobile device / tablet
2. Authenticate with admin key
3. Show event list, select event
4. Scan a valid QR code — show "Checked in" confirmation
5. Scan same QR again — show "Already checked in"
6. Scan an invalid QR — show error state
7. Show offline mode (turn off network, scan still works from local DB)

### Video 5 — Uninstall Flow (~2 min)
1. Go to HubSpot Settings → Integrations → Connected Apps
2. Find Paddock, click Remove
3. HubSpot calls `POST /webhooks/app-uninstall`
4. Worker sets `tenants.status = 'uninstalled'` — show in admin API
5. Show app is no longer listed in Connected Apps

## 6. Listing Assets Checklist

- [ ] App icon (512×512 px, PNG, no rounded corners — HubSpot crops)
- [ ] Screenshots: App Home (onboarding), Event Capacity App Card, Attendance App Card, Check-in PWA (min 3, max 8)
- [ ] App name: Paddock
- [ ] Tagline: Atomic seat management and check-in for HubSpot Marketing Events
- [ ] Support URL: `https://refuelcreative.com.au/paddock/support`
- [ ] Privacy policy URL: `https://refuelcreative.com.au/paddock/privacy`
- [ ] Pricing model: Subscription (per portal/month); include trial period description
- [ ] App ID / Build ID: retrieve from HubSpot Developer portal after first `hs project upload`

## 7. Platform Compliance Checklist

- [x] `platformVersion = "2026.03"` in `hsproject.json`
- [x] All UI is React-based App Cards (`crm-card` type with `.tsx` module) and App Home — no legacy CRM cards
- [x] No legacy `crm.record.sidebar` or iframe-based cards
- [x] Shared extension utilities in `extensions/shared/` — no copy-paste between cards
- [x] OAuth uses date-versioned endpoint: `POST /oauth/2026-03/token`
- [x] Uninstall webhook (`/webhooks/app-uninstall`) calls HubSpot's Uninstall App endpoint and marks tenant uninstalled
- [x] All HubSpot API calls use versioned CRM v3/v4 endpoints

## 8. Install-Count Gate (Go-to-Market Dependency)

HubSpot requires **≥ 3 unaffiliated active installs** (API activity in last 30 days) for initial listing, and **≥ 60** for certification. Weld Australia (install #1) is likely affiliated. This is a **business/GTM task**, not a code task.

Action items before submission:
1. Confirm affiliated-install rules with HubSpot Partner team
2. Recruit ≥ 2 independent pilot portals
3. Ensure each pilot has API activity (at least one event registration) within 30 days of submission
