# Online events and webinar providers

Online events sit behind one interface, `WebinarProvider`. Nothing provider-specific leaks
past it. `events.provider` selects the implementation, and every provider normalises its
attendance data to `AttendanceRecord` before the shared pipeline touches it.

Teams is the MVP implementation. Google Meet and Zoom are phase 2; Wistia, ON24 and Vimeo
are phase 3.

## The interface

`packages/worker/src/providers/types.ts`:

```ts
interface WebinarProvider {
  readonly name: string;                                    // matches events.provider

  createWebinar(event: WebinarEventInput): Promise<CreateWebinarResult>;

  registerAttendee(
    webinarId: string,
    attendee: WebinarAttendeeInput,                          // carries ourRegistrationId
  ): Promise<RegisterAttendeeResult>;                        // returns personalJoinUrl

  cancelRegistration?(webinarId: string, providerRegistrationId: string): Promise<void>;

  ensureSubscription(tenant: { portalId: string }): Promise<void>;   // idempotent
  handleNotification(payload: unknown): Promise<PullAttendanceJob[]>;
  fetchAttendance(webinarId: string, sessionId: string): Promise<AttendanceRecord[]>;
}
```

`cancelRegistration` is optional. Callers treat its absence as a no-op, which is why
transfer works against providers that cannot cancel a registration.

Selection is a single switch in `providers/index.ts`:

```ts
getWebinarProvider(env, portalId, providerName)   // 'teams' | 'meet' | 'zoom'
                                                  // | 'on24' | 'wistia' | 'vimeo' | null
```

`null` means in person. `events.provider !== null` is the test for "this is an online
event" throughout the reserve flow.

## Where the interface is called

| Caller | Method | Notes |
| --- | --- | --- |
| `routes/reserve.ts` via `teams.ts` | `createWebinar`, `registerAttendee` | lazily provisions the webinar on the first reservation, then registers each attendee |
| `transfer.ts` via `teams.ts` | `registerAttendee`, `cancelRegistration` | re-registers with the **same** `registrations.id` |
| `attendance.ts renewSubscriptions` (cron `0 */12`) | `ensureSubscription` | once per portal that has online events |
| `routes/webhooks-graph.ts`, `routes/webhooks-zoom.ts` | `handleNotification` | returns pull jobs |
| `attendance.ts pullAttendanceForEvent` | `fetchAttendance` | from a pull job or the `*/5` poll |

`teams.ts` is the bridge between the reserve flow and the interface, and it is deliberately
**non-throwing**. If the provider is unconfigured or a call fails, the reservation still
completes: the registration row is written, `me.register` is still queued, and the join URL
is simply left null. The renewal and finalise crons reconcile attendance independently. A
webinar outage must never cost a booking.

## Two provider shapes

**Live webinars** (Teams, Meet, Zoom, ON24) have real join and leave spans. They fill
`AttendanceRecord.intervals` directly.

**Recorded and on-demand video** (Wistia, Vimeo) have no join window, only how much of the
media was watched. They populate `VideoEngagement`:

```ts
{ percentWatched?: number; secondsWatched?: number; viewSessions?: number }
```

and also synthesise an interval with `syntheticInterval(start, secondsWatched)`, so the
shared attended-versus-no-show and duration logic stays provider agnostic. A non-positive
duration yields a zero-length span, which counts as "showed up" with no watched time,
mirroring how `collapseIntervals` treats a zero-length live span.

Notification style also differs. Teams is webhook driven. Meet, ON24, Wistia and Vimeo are
polled by the `*/5` cron, and Zoom is polled as well, as a missed-webhook backstop. The
interface allows both: a poll-based provider's `ensureSubscription` and `handleNotification`
are no-ops.

## Credentials

One resolution layer, `providers/oauth.ts`, which every provider calls instead of reading
Wrangler secrets itself.

**OAuth providers** (Zoom, Google/Meet, Vimeo, Wistia). Each customer authorises **our**
single published app once, through `GET /connect/:provider/start`. Their access and refresh
tokens are stored AES-GCM encrypted in `webinar_connections`.
`getProviderAccessToken()` returns a valid token, refreshing transparently when fewer than
5 minutes remain, exactly like the HubSpot flow.

**Key-only providers** (ON24, which has no OAuth). The customer pastes their token key and
secret via `PUT /api/v1/manage/onboarding/connections/on24`; they are stored as an
encrypted JSON blob and returned by `getProviderApiCreds()`.

The important split: our app's client id and secret are **platform-level** Wrangler secrets,
one pair per provider, shared across all tenants:

```
ZOOM_OAUTH_CLIENT_ID / ZOOM_OAUTH_CLIENT_SECRET
MEET_OAUTH_CLIENT_ID / MEET_OAUTH_CLIENT_SECRET
VIMEO_OAUTH_CLIENT_ID / VIMEO_OAUTH_CLIENT_SECRET
WISTIA_OAUTH_CLIENT_ID / WISTIA_OAUTH_CLIENT_SECRET
WEBINAR_OAUTH_REDIRECT_BASE          → /connect/<provider>/callback
TOKEN_ENCRYPTION_KEY                 → 64 hex chars, encrypts stored tokens
```

Only the customer's resulting tokens are per tenant, and they live in D1, not in secrets.
Zoom mints tokens with HTTP Basic auth; the others put the client credentials in the body.
That difference is captured in `OAUTH_PROVIDERS[provider].authStyle` and nowhere else.

The connect flow's `state` is HMAC signed with a 10-minute TTL, and the callback takes the
portal id from the verified state, never from a query parameter.

## Microsoft Teams specifics

Teams is the one provider with two auth modes, and the split is deliberate.

| Call | Token | Why |
| --- | --- | --- |
| `createWebinar` | delegated (`getMicrosoftDelegatedGraphToken`) | webinar creation is an organiser action |
| `registerAttendee`, `cancelRegistration`, subscriptions, attendance | app-only (`getGraphToken`) | Graph's delegated registration shape registers the *signed-in* user; public checkout has to register arbitrary external attendees by name and email |

Delegated organiser consent runs through `GET /oauth/microsoft/start`, `/callback` and
`/status`. Default scopes are `offline_access VirtualEvent.ReadWrite`, overridable with
`MICROSOFT_GRAPH_DELEGATED_SCOPES`. App-only auth supports either a client secret or
certificate credentials (`microsoft-client-assertion.ts`), with per-portal secret names
preferred over the unsuffixed ones.

### Creating a webinar

```
1  POST /solutions/virtualEvents/webinars              → DRAFT
      settings.isAttendeeEmailNotificationEnabled = false
      isManualApprovalEnabled = false
2  POST /solutions/virtualEvents/webinars/{id}/publish  ← a draft accepts no registrations
3  GET  .../sessions                                    → session id + generic joinWebUrl
```

Three things to keep:

- **The worker creates the webinar**, never an organiser making one ad hoc, so the worker
  owns the ids.
- **A draft must be published**, or registrations fail.
- **Teams' own attendee emails are disabled.** HubSpot is the sole source of invitations and
  confirmations, and two competing invites is a support ticket.

### Registration and matching

`registerAttendee` stamps our `registrations.id` into
`externalRegistrationInformation.registrationId` on the provider registration. That is what
makes attendance matching exact rather than email-based guessing.

Matching order in `processAttendance`: `ourRegistrationId`, then `providerRegistrationId`,
then `email`. Anything unmatched goes to `attendance_unmatched` with the raw record kept for
re-matching.

The personal join URL is written to the HubSpot contact through the
`contact.set_join_url` outbox row **before** HubSpot's confirmation workflow fires, because
HubSpot generates the calendar invite and emails and the URL has to already be there.

### Subscriptions

`ensureSubscription` is idempotent and safe to call from the cron:

```
KV graph:sub:{portalId} holds { id, expirationDateTime }
  present → PATCH /subscriptions/{id} with a new expiry   (also satisfies
            a reauthorizationRequired lifecycle event)
  absent, or renewal 404s → POST /subscriptions
            changeType: created,updated
            resource:   solutions/virtualEvents/events     ← tenant-wide, not per event
            notificationUrl + lifecycleNotificationUrl = GRAPH_NOTIFICATION_URL_{portalId}
            clientState = GRAPH_SUBSCRIPTION_CLIENT_STATE_{portalId}
then cache KV graph:sub:{portalId} and the reverse map graph:sub-portal:{subscriptionId}
```

Graph subscriptions on this resource last at most one day, hence the 12-hour renewal cron.
The reverse map is what lets `POST /webhooks/graph` resolve an inbound notification to a
portal before any provider code runs.

`handleNotification` verifies `clientState` with a timing-safe compare and drops anything
that does not match, handles the lifecycle events (`reauthorizationRequired`,
`subscriptionRemoved`, `missed`), and returns deduplicated pull jobs.

**Attendance is pull, not push.** The notification only signals that a report is ready. The
worker then pulls attendance reports and attendance records with `$expand`.

## Adding a provider

1. Implement `WebinarProvider` in `providers/<name>.ts`. Copy the closest existing shape:
   `zoom.ts` for a live OAuth provider, `on24.ts` for key-only auth, `wistia.ts` for
   recorded media.
2. Resolve credentials through `providers/oauth.ts`. Do not read Wrangler secrets in a
   provider. If it is an OAuth provider, add it to `OAUTH_PROVIDERS` with its authorise
   URL, token URL, scopes and `authStyle`, and add the platform client id and secret to
   `Env`.
3. Add the `case` to `getWebinarProvider`.
4. Normalise attendance to `AttendanceRecord`. Set `ourRegistrationId` wherever the
   provider can carry it. For recorded media, fill `engagement` and synthesise an interval.
5. Decide push or poll. Webhook driven means a route plus real `ensureSubscription` and
   `handleNotification`. Poll based means both are no-ops and `pollLiveAttendance` picks the
   event up, which needs no change as long as the provider name is not `teams`.
6. Add tests to `packages/worker/test/providers.test.ts`. That file mocks only the
   credential layer and `fetch`, so what you are testing is request shaping and response
   normalisation.

Do not add a provider-specific branch to `attendance.ts`, `routes/reserve.ts` or
`hubspot-writeback.ts`. If you feel the need to, the interface is missing something: change
the interface.

## Known gap

Hybrid events (in-person plus online attendance for the same event, with attendance
deduplicated across both) are **not decided and not implemented**. `events.provider` is
either set or null; there is no third mode. Raise it rather than improvising.
