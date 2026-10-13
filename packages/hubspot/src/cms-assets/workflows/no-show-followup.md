# Workflow — No-show follow-up

Follows up with registrants who didn't attend, enrolling off HubSpot's **native No-Show
state** on the Marketing Event (the worker normalises attendance and writes the No-Show state
back; this workflow only reacts to it).

- **Type:** Contact-based workflow.
- **Enrollment trigger:** Contact's Marketing Event membership state becomes **No-Show**
  (`Marketing event` object → attendance/membership = `No-Show`). Re-enrollment **on**.
- **Timing:** small delay (e.g. a few hours to the next morning) so the No-Show state has
  settled after the attendance reconciliation sweep.

## Actions

1. **Delay** until the morning after `event_start_datetime` (or a fixed short delay).
2. **Send email — "Sorry we missed you".**
   - If a recording/resources property is set, link it.
   - Otherwise a light "catch the next one" with a link back to the events listing page.
3. *(optional)* **Set property** `no_show_followup_sent_at` for reporting / suppression.

## Why off the *native* state

Attendance is reconciled by the worker (pull-based for online providers; check-in scans for
in-person), then written back so HubSpot's Marketing Event holds the canonical
Registered / Attended / **No-Show** / Cancelled state. Triggering off that native state keeps
this workflow provider-agnostic — it never inspects Teams (or any provider) directly.

> Reads event properties only; no tenant constants.
