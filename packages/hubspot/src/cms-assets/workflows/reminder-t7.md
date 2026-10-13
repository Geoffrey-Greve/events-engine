# Workflow — T-7 reminder

A gentle reminder one week out. Date-based, anchored to the event start.

- **Type:** Contact-based workflow, **date-based** enrollment.
- **Enrollment trigger:** Contact is **Registered** for the Marketing Event
  (membership state `Registered`) **and** `event_start_datetime` is known.
- **Timing:** Execute **7 days before** `event_start_datetime`.
  (Workflow setting → "Execute actions based on a date property" → property
  `event_start_datetime`, offset −7 days, at the portal's chosen send hour.)
- **Re-enrollment:** on (handles re-scheduled events / new registrations).

## Actions

1. **If/then branch:** skip if the contact has already **Cancelled** or moved to
   **No-Show**/**Attended** (guards against late state changes).
2. **Send email — "See you in a week".** Title, date/time in the attendee's display timezone,
   venue or "Online" (do **not** include the join link this far out — send it at T-1).
3. *(optional)* **Set property** `reminder_t7_sent_at`.

> Reads event properties only. No tenant constants; the email design is the portal's.
