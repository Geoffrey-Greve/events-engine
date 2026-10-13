# Paddock Event Engine — Operations Runbook

## 1. Per-Tenant Onboarding Checklist

### Prerequisites (Refuel side)
- [ ] HubSpot app installed by the tenant (OAuth flow completed, tokens stored)
- [ ] Tenant row exists in D1 `tenants` table with `status = 'installed'`
- [ ] Refuel billing invoice paid → webhook fires → `refuel_billing_status = 'active'`

### Step-by-step

**1. OAuth install**
- Tenant clicks "Install Paddock" from the HubSpot marketplace listing
- HubSpot redirects to `GET /oauth/callback?code=…&portalId=…`
- Worker exchanges the code via `POST https://api.hubapi.com/oauth/2026-03/token` (date-versioned v3)
- Tokens stored encrypted (AES-GCM) in `tenants.hs_access_token/hs_refresh_token`
- Worker auto-runs `provisionHubDbTables` — idempotent; creates `events` and `ticket_types` HubDB tables
- Redirect to `OAUTH_SUCCESS_REDIRECT_URI` (App Home)

**Required secrets for every new tenant** (set via `wrangler secret put <NAME>`):
```
HUBSPOT_CLIENT_ID         # global, not per-tenant
HUBSPOT_CLIENT_SECRET     # global, not per-tenant
HUBSPOT_REDIRECT_URI      # global, not per-tenant
TOKEN_ENCRYPTION_KEY      # global AES-GCM key (32 bytes hex)
ADMIN_SECRET              # global admin bearer token
HUBSPOT_WEBHOOK_SECRET    # global — HubSpot app signing secret
GRAPH_SUBSCRIPTION_CLIENT_STATE_<portalId>  # per-tenant UUID for Graph notification validation
GRAPH_NOTIFICATION_URL_<portalId>           # must be `https://<worker-host>/webhooks/graph`
```

**2. HubSpot private-app / app config**
- Ensure the installed app has these scopes. The manifest at
  `packages/hubspot/src/app/app-hsmeta.json` is the source of truth, and
  `pnpm check:hubspot-app` fails CI if the worker calls a CRM object no scope names —
  an undeclared scope surfaces only as a 403 on a dead outbox row in production:
  - `crm.objects.marketing_events.read`
  - `crm.objects.marketing_events.write`
  - `cms.hubdb.tables.read`
  - `cms.hubdb.tables.write`
  - `crm.objects.contacts.read`
  - `crm.objects.contacts.write`
  - `crm.objects.deals.read`
  - `crm.objects.deals.write`
  - `crm.objects.line_items.read`
  - `crm.objects.line_items.write`
  - `crm.objects.invoices.read`
  - `crm.objects.invoices.write`
  - `crm.objects.companies.read`
  - `crm.objects.companies.write` (membership status + tier on the buyer's company, and the
    training-voucher usage projection written back by `company.sync_voucher_usage`)
  - `crm.objects.tasks.write` (the owner task raised with every oversell / waitlist /
    fast-sell-out / contact-conflict decision — without it the human-in-the-loop flow
    records the decision but nobody is told)
  - `crm.objects.products.read`
  - `tax_rates.read` (required to resolve / validate the HubSpot Tax Rates library id used on invoice lines)
- Optional scopes — granting them is what turns the feature on; the worker degrades quietly
  without them rather than failing:
  - `crm.objects.notes.write` (mirrors staff notes onto the contact/deal timeline)
  - `crm.objects.owners.read` (attributes a mirrored note to the staff member who wrote it)

> **Adding a required scope means every existing install must re-authorise.** A portal
> installed before the scope was added keeps a token without it, and the affected write-back
> 403s until an admin reconnects the app. After changing `requiredScopes`, walk each live
> tenant through the OAuth install link again and confirm `outbox` has no rows going `dead`
> with a 403.

- Subscribe to webhooks: Invoice property change (`hs_invoice_status`), Payment object change
- Set webhook endpoint: `https://<worker-host>/webhooks/hubspot`

**3. Stripe connect**
- In HubSpot portal: Settings → Payments → Connect Stripe → authorise in AUD
- In Paddock App Home: confirm "Connected" via the Mark as Connected button
- Worker PATCH `/api/v1/manage/onboarding/stripe` sets `stripe_processor_connected = 1`

**4. Xero Data Sync + GST rate import**
- Enable HubSpot–Xero Data Sync in the tenant's HubSpot portal
- In Xero: confirm GST 10% tax rate exists
- In HubSpot: Settings → Accounting → Tax rates; the Xero-imported 10% GST rate should appear with a HubSpot numeric ID
- In Paddock App Home (Step 2): paste that rate ID, click Save
- Worker stores it in `tenants.xero_gst_rate_id` — used on all invoice line items

**5. Webinar provider (Teams) — skip for in-person-only tenants**
- Create an Azure AD app registration in the tenant's Azure directory:
  - API permissions: `VirtualEvent.Read.All`, `VirtualEvent.ReadWrite.All`, `OnlineMeetings.ReadWrite.All` (Application)
  - Generate a client secret
- Enable app-access policy in Teams admin: allow the client ID to access meetings
- In Paddock App Home (Step 6): enter Tenant ID, Client ID, Client Secret → Save
- Worker stores credentials encrypted in D1 and creates the first Graph subscription

**6. Dynamic-page wizard step**
- In HubSpot CMS: create a dynamic page template using the `events` HubDB table (template: `events.html`)
- Publish the page on the tenant's domain
- In Paddock App Home (Step 5): enter the domain (e.g. `events.yourdomain.com.au`) → Save

**7. Member pricing source (HubDB) — required for any tenant selling member-priced tickets**

The tenant adds their sessions in HubDB and the CMS quotes the buyer from that row, so
the Worker must price from the same row. Without this the Worker falls back to
`pricing_rules` in D1 — a second, hand-maintained copy of the same numbers — and every
drift between the two surfaces to the buyer as *"The course price changed before
checkout"* at reserve.

Point the Worker at the table (Weld's live values shown):

```bash
curl -X PATCH "$WORKER/manage/onboarding/hubdb-pricing" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{
        "coursesTable": "courses",
        "eventIdColumn": "worker_event_id",
        "priceColumns": {
          "gold":       "price_gold_aud_ex_gst",
          "silver":     "price_silver_aud_ex_gst",
          "bronze":     "price_bronze_aud_ex_gst",
          "student":    "price_student_aud_ex_gst",
          "individual": "price_individual",
          "member":     "price_member",
          "nonMember":  "price_non_member"
        }
      }'
```

`priceColumns` is **required** and has no defaults — the names above are Weld's schema,
not the product's. A table named without a mapping is refused (`price_columns_required`),
and a portal that somehow holds one anyway stays on `pricing_rules` and logs
`hubdb_pricing_columns_unmapped`: reading column names we guessed would find nothing in
another tenant's table and silently price every member from the stale D1 copy. Map only
the levels the table actually prices; unmapped levels are simply not read.
`eventIdColumn` defaults to `worker_event_id` — that one is our own id, not the tenant's
schema.

Then mirror HubDB into `pricing_rules` so the fallback path is correct too. **Dry-run
first and read the output**: it names every event whose HubDB row could not be found.

```bash
curl -X POST "$WORKER/manage/onboarding/hubdb-pricing/sync?dryRun=true" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# review, then:
curl -X POST "$WORKER/manage/onboarding/hubdb-pricing/sync" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

The sync is idempotent and only replaces the event-scoped rules it owns
(`member_category = 'member'`). Hand-written `ticket_type`-scoped rules are left alone,
but they shadow event rules in the fallback — the response reports a
`shadowedByTicketTypeRules` count per event so you can spot a stale override.

Re-run the sync after a bulk HubDB price change. Day-to-day edits need no re-run: the
Worker reads HubDB live at reserve time.

---

## 2. Incident & Reconciliation Playbook

### 2.1 Outbox failures (`outbox_dead` / `outbox_retry` log events)

**Detect, pushed:** both of the log lines below are posted to Slack (`#weld-errors`) when
`REFUEL_OPS_SLACK_WEBHOOK_URL` is set. A standing problem is posted ONCE and then suppressed
until its shape changes (a new portal or a new topic) or six hours pass, and a recovery is
posted once when it clears. Messages carry portal ids, topics and counts only; the reason,
the order id and everything else stays behind the admin API.

**Detect, passively:** the `*/15` cron logs one `outbox_health` line every run, at `level`
`error` when any portal has a row dead in the last 24 hours or undelivered for more than an
hour, and `info` when it does not. That is the line to alert on — it names the portal, the
topics and the oldest wait. It logs on clean runs too, on purpose: silence from this is
indistinguishable from a cron that has stopped. `cron_job_failed` is the other one worth an
alert; a cron has no user in front of it to report that it died.

**Detect, actively:** `GET /api/v1/manage/diagnostics/outbox` (admin-authed, read-only) — counts by
topic and status, plus every row that is not `delivered`, each with its order id and the
reason it died. Start here rather than in Cloudflare's log search: a log line shows what
failed at the moment it failed and says nothing about what is still failing, and a dead row
is days of silence by design — the booking succeeded, the seat is held, and only the HubSpot
half is missing.

Tracing one booking ("this person paid and has no invoice"):

```
GET /api/v1/manage/diagnostics/outbox?orderId=<orderId>
```

`malformedPayload: true` on a row means its payload will not parse. Such a row is marked
dead on sight now; one written before that is what `IIF(json_valid(payload), …)` in every
outbox query exists to survive.

Log search still works for the moment of failure: `event: "outbox_dead"`,
`event: "outbox_retry"`, or `event: "hubspot_property_missing"` (a property the portal does
not have — the write went out without it, and the log names what to create).

**Triage in SQL, if you have D1 console access:**
```sql
SELECT id, portal_id, topic, status, attempts,
       json_extract(IIF(json_valid(payload), payload, '{}'), '$._dead_reason') AS reason
FROM outbox WHERE status = 'dead' ORDER BY created_at DESC LIMIT 50;
```

**Common causes and fixes:**

| Topic | Dead reason | Fix |
|---|---|---|
| `me.register` | `HubSpot 401` | Access token expired / revoked. Re-OAuth the tenant. Manually re-drive: `UPDATE outbox SET status='pending' WHERE id='…'`. |
| `deal.create` | `HubSpot 404: contact not found` | Contact was deleted. Restore or re-upsert. |
| `invoice.create` | `Deal not yet created for order …` (retryable) | Wait for `deal.create` to complete; will auto-retry. If stuck, check `deal.create` row for the same order. |
| `me.attend` | `HubSpot 400: invalid eventId` | HubSpot event ID mismatch. Check `events.hubspot_event_id` for the event. |
| `contact.sync_attendance` | `HubSpot 400: … was not a valid date` | The tenant's attendance date property is a HubSpot `date` and the worker sent a timestamp — only possible if the property type read succeeded and returned `datetime` wrongly. Confirm the property type, then re-drive. |
| `invoice.create` | *(status `failed`, attempts climbing, no reason)* | Read `reason` on the diagnostic row — every failure now records `_last_error`. A row stuck on `Deal not yet created for order …` means the order has no `hubspot_deal_id`; the `*/15` sweep recreates it, or force one with `reconcileOutbox(env, { portalId })`. |
| `invoice.create` | `hs_amount_billed 0.00 must be greater than zero` | The order's lines carry no money. The worker no longer attempts these (it logs `invoice_skipped_zero_value`); an existing dead row is an order to check by hand, not to re-drive. |
| `me.complete` | `request body expected, none found` | Fixed — the handler sends the event's start and end. Re-drive; a row enqueued before the fix falls back to reading them off the event. |
| `me.register`, `me.attend`, `me.complete` | `missing scope crm.objects.marketing_events.write` | The portal's token predates the scope. Re-authorise at `/oauth/install`, then re-drive. |
| any topic | `Gave up after N attempts: …` | The row hit `MAX_OUTBOX_ATTEMPTS`. Fix what the reason names, then re-drive it as below. |
| any topic | `Malformed outbox payload (…)` | The payload is not JSON, so no retry can ever deliver it. Nothing to re-drive: read what the row was for from `created_at` + `topic`, and if it still matters, re-enqueue the work from the order. |
| `contact.sync_registration_confirmation` | `HubSpot 400: property "last_event_engine_registration_id" does not exist` | The portal predates migration 0040. The write-back now creates it on demand, so this should only appear when the token cannot create properties either — re-authorise at `/oauth/install`, then `POST /api/v1/manage/onboarding/properties`. |
| `contact.sync_attendance`, `contact.sync_answers`, `contact.set_join_url` | `HubSpot 400: property … does not exist` | The portal's properties were never provisioned. `GET /api/v1/manage/onboarding/properties` says which are missing without changing anything; `POST` the same path creates them, and is safe to re-run. Then re-drive. If entries come back `manual`, the schema scope is missing — the portal must re-authorise at `/oauth/install`, or create the properties by hand from the `definition` each entry carries. |

**Re-drive a dead row manually:**
```sql
UPDATE outbox SET status = 'pending', next_attempt_at = datetime('now') WHERE id = '<outboxId>';
```
The next `*/15 * * * *` reconcile cron will pick it up within 15 minutes.

### 2.1b Attendance did not reach the contact (no certificate)

Certificates are rendered by Ollie's HubSpot Data Hub flow off a **contact property**, not by
the worker. So "no certificate" is almost always "the attendance write-back did not land".

**Check what the worker thinks, and where it writes:**
```
GET /api/v1/manage/events/<eventId>/attendance
```
`summary` gives the door count, `propertyMapping` names the three contact properties this
portal writes to, and each attendee's `writeback` is the state of their
`contact.sync_attendance` outbox row (`null` = never enqueued).

**Triage, in order:**
1. `attended: false` — they were never scanned, and no webinar record matched them. Not a
   write-back problem; see §2.2 for online events.
2. `writeback: null` — the check-in predates Phase 2.1, or the row was pruned. Re-drive by
   inserting a `contact.sync_attendance` row (payload:
   `{registrationId, eventId, attendeeEmail, attendeeName, attendedAt, eventTitle}`) with
   `attendedAt` set to the recorded arrival, NOT to now.
3. `writeback.status = 'dead'` — see the topic table above.
4. `writeback.status = 'dead'` with `property … does not exist` — the properties were not
   provisioned; see the topic table above.
5. `writeback.status = 'delivered'` but the property is empty — the worker had nothing to
   write. Either the field is `'off'` in `propertyMapping`, or HubSpot already held a LATER
   attendance date (the date never moves backwards, by design) so this event was correctly
   treated as a straggler. The contact property only ever holds the most recent attendance;
   the per-event history is the endpoint above.

### 2.2 Unmatched attendance (`attendance_unmatched` log events)

**Detect:** search logs for `event: "attendance_unmatched"`.

**Triage:**
```sql
SELECT * FROM attendance_unmatched
WHERE event_id = '<eventId>'
ORDER BY created_at DESC;
```

**Common causes:**
- Attendee registered directly in Teams (outside Paddock) — no matching `registrations` row
- `externalRegistrationInformation.registrationId` not stamped (old version or provider bug)
- Email mismatch (typo in registration vs Teams profile)

**Fix:**
1. If the person should count as attended: manually insert a `me.attend` outbox row using their `registrationId`:
```sql
INSERT INTO outbox (id, portal_id, topic, payload, stable_interaction_datetime, created_at)
VALUES (
  lower(hex(randomblob(16))),
  '<portalId>',
  'me.attend',
  json('{"registrationId":"<regId>","attendeeEmail":"<email>","hubspotContactId":null,"hubspotEventId":"<hsEventId>","externalAccountId":"<portalId>"}'),
  '<joinDateTime>',
  datetime('now')
);
```
2. Then trigger the queue: `wrangler d1 execute event-engine-db --command "SELECT id FROM outbox WHERE status='pending' LIMIT 1"` or wait for next cron.

### 2.3 Drifted registrations (paid but not synced)

**Detect:** reconcile cron logs a `me.register` outbox row; also visible via:
```sql
SELECT r.id, r.attendee_email, o.status, r.marketing_event_state_synced
FROM registrations r JOIN orders o ON o.id = r.order_id
WHERE o.status IN ('paid','confirmed') AND r.marketing_event_state_synced = 0;
```

**Fix:** the reconcile cron (`*/15 * * * *`) re-enqueues automatically. If stuck after 2+ cycles, check the outbox for permanent errors as in §2.1.

### 2.4 Reservation holds not released (EventCapacity DO desync)

**Detect:** `reservations.status = 'pending'` rows with `expires_at < now` that have no corresponding DO release.

**Fix:** the `expire_hold` queue message is sent at reserve time; if it was lost, manually update:
```sql
UPDATE reservations SET status = 'expired' WHERE status = 'pending' AND expires_at < datetime('now');
```
Seats will be reclaimed on the next DO reconcile or when the DO is next accessed.

### 2.5 Missing HubSpot deal or invoice (paid order)

**Detect:**
```sql
SELECT id, portal_id, hubspot_deal_id, hubspot_invoice_id
FROM orders WHERE status = 'paid' AND (hubspot_deal_id IS NULL OR hubspot_invoice_id IS NULL);
```

**Fix:** the reconcile cron re-enqueues `deal.create` / `invoice.create` automatically. To force immediately:
```sql
UPDATE outbox SET status = 'pending', next_attempt_at = datetime('now')
WHERE topic IN ('deal.create','invoice.create')
AND payload LIKE '%"orderId":"<orderId>"%'
AND status NOT IN ('delivered','dead');
```

### 2.6 Graph subscription expired (Teams attendance notifications stopped)

**Detect:** no `graph.pull_attendance` jobs in queue for > 24h; or a `subscriptionRemoved` lifecycle event in logs.

**Fix:** the `0 */12 * * *` cron renews subscriptions automatically. To force:
```bash
wrangler cron trigger event-engine --cron "0 */12 * * *"
```

---

### 2.7 Members refused at checkout (`price_mismatch` / `membership_unverified`)

Both are thrown by `reserve` and both mean the CMS and the Worker disagreed about the
buyer. Search the Worker logs for the `price_drift` event (it carries the quoted and
resolved cents, the tier, and the resolved membership) or for the reserve response
status.

*"The course price changed before checkout"* (`price_mismatch`) — the Worker resolved a
price **higher** than the checkout displayed. Anything lower is now honoured, so this
means a genuine overcharge was prevented. Check, in order:
1. Is the portal configured for HubDB pricing (§1 step 7)? If not, the Worker is pricing
   from `pricing_rules` and any gap there resolves to the standard price.
2. Does the event's HubDB row exist and carry the buyer's tier column? Run the sync in
   dry-run and look for `no_hubdb_row` / `no_prices` against that event.
3. Is a stale `ticket_type`-scoped `pricing_rules` row shadowing the event? The sync
   response's `shadowedByTicketTypeRules` count flags it; delete it via
   `DELETE /manage/events/:id/pricing-rules/:ruleId`.

*"We couldn't verify your membership"* (`membership_unverified`) — nothing in HubSpot said
anything about this buyer at all: no status, no tier, no active Find a Member row, on
either the contact or their associated company. A confirmed non-member gets
`members_only` instead, so this really is a data gap. Check the contact exists under the
email they typed, that `tenants.membership_status_property` names the property the portal
actually populates (Weld: `individual_membership_status`), and that their membership
company is their **primary** associated company — the Worker reads
`associatedcompanyid`, which is the primary association only.

---

## 3. Staging Environment

Deploy to staging: `pnpm deploy:staging`

Staging resources:
- D1: `event-engine-db-staging` (ID: `00000000-0000-0000-0000-000000000002`)
- KV: separate namespace
- Queue: `event-engine-jobs-staging`
- HubSpot: sandbox/test portal (account alias `staging` in `~/.hubspot.config.yml`)
- Stripe: test mode secret key
- Teams: test tenant (optional — omit for in-person staging tests)

---

## 4. Go-to-Market Dependency: Install-Count Gate

The HubSpot marketplace requires **≥ 3 active, unaffiliated production installs** with API activity in the last 30 days for initial listing approval, and **≥ 60 installs** for certification.

Weld Australia is install #1 and is likely considered **affiliated** (Refuel built Paddock for Weld). This is a **go-to-market dependency, not a code task** — it cannot be resolved by development work. Mitigation options:
- Recruit 2+ independent pilot customers before submission
- Engage HubSpot partner team to understand affiliated-install counting rules
- Consider applying for a sandbox/test install waiver via the HubSpot Partner Program

Track this gate as a pre-submission milestone separate from code certification.
