# Workflow — T-1 reminder

The day-before reminder. For online events this is where the **personal join URL** goes, so
attendees have it close to hand.

- **Type:** Contact-based workflow, **date-based** enrollment.
- **Enrollment trigger:** Contact is **Registered** for the Marketing Event **and**
  `event_start_datetime` is known.
- **Timing:** Execute **1 day before** `event_start_datetime` (date property offset −1 day,
  at the portal's chosen send hour).
- **Re-enrollment:** on.

## Actions

1. **If/then branch:** skip if **Cancelled** / **No-Show** / **Attended**.
2. **Branch online vs in-person** on `teams_join_url` (present = online).
3. **Send email — "Tomorrow".**
   - Online path: prominent **Join** button → `{{ contact.teams_join_url }}`, plus a
     "test your audio/video" nudge.
   - In-person path: venue, `event_location`, arrival/parking notes (portal copy).
4. *(optional)* **Set property** `reminder_t1_sent_at`.

> The personal join URL is already on the contact (worker writes it before confirmation), so
> no live lookup is needed here.
