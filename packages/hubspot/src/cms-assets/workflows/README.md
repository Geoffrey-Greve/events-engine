# Lifecycle workflows

These are the buyer/attendee lifecycle automations. They're delivered as **documented,
exportable specs** rather than committed workflow JSON, because HubSpot workflow exports are
portal-scoped: every export embeds owner ids, branch ids, email-asset ids, and property
internal-name resolutions that don't transfer between portals. Build each from its spec, or
clone from a reference portal and re-map the ids below.

> **Portal-agnostic by contract.** Nothing here names a tenant. Brand (email design, sender,
> logo, tone) is the consuming theme/portal's email templates. These specs define *triggers,
> timing, and the data each step reads* — not copy or colour.

## Required contact properties (configuration)

Map these to the portal's actual internal names at install time. The worker / writeback layer
populates them; the workflows only read them.

| Purpose | Suggested internal name | Written by | Read by |
| --- | --- | --- | --- |
| Personal Teams/online join URL | `teams_join_url` | worker `contact.set_join_url` outbox → writeback | confirmation email + `.ics` |
| Event start (UTC) | `event_start_datetime` | worker / sync | T-7, T-1 reminders, `.ics` |
| Event title | `event_title` | worker / sync | all emails, `.ics` |
| Event location / "Online" | `event_location` | worker / sync | confirmation, `.ics` |
| Registration state | native **Marketing Event** membership | HubSpot + worker `me.register` | enrollment triggers |

> The worker writes `teams_join_url` to the contact **before** the confirmation workflow
> fires (a hard ordering requirement — see `claude.md`: HubSpot generates the calendar invite
> and emails, so the personal join URL must already be on the contact).

## The four workflows

| Spec | Type | Trigger | Reads |
| --- | --- | --- | --- |
| [`confirmation-with-ics.md`](confirmation-with-ics.md) | Contact-based | Registration confirmed (attendance = Registered) | `teams_join_url`, event props |
| [`reminder-t7.md`](reminder-t7.md) | Date-based | 7 days before `event_start_datetime` | event props |
| [`reminder-t1.md`](reminder-t1.md) | Date-based | 1 day before `event_start_datetime` | event props, `teams_join_url` |
| [`no-show-followup.md`](no-show-followup.md) | Contact-based | Native Marketing Event **No-Show** state | event props |

## Re-mapping an exported workflow

If you clone from a reference portal instead of rebuilding:

1. Re-select the **enrollment trigger** (Marketing Event membership is portal-specific).
2. Re-point every **email action** at the destination portal's email assets.
3. Re-resolve **property references** (`{{ contact.teams_join_url }}` etc.) to the portal's
   internal names if they differ from the table above.
4. Re-select the **sender** / from-address and any **suppression lists**.
