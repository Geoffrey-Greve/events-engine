# Workflow — Registration confirmation + calendar invite (.ics)

Sends the confirmation email and attaches a calendar invite. For online events the invite's
location/URL is the attendee's **personal** join URL, read from the `teams_join_url` contact
property (which the worker guarantees is set before this workflow fires).

- **Type:** Contact-based workflow
- **Enrollment trigger:** Contact becomes **Registered** for the Marketing Event
  (`Marketing event` object → membership state `Registered`). Re-enrollment **on** so a
  contact registering for a second event is processed again.
- **Suppression:** none (transactional).

## Actions

1. **(Online only) Branch:** if `event_location` is `Online` / `is_online` true → path A, else path B.
2. **Send email — "Registration confirmed".** Attach the generated `.ics` (below). Body
   includes event title, start (in the attendee's display timezone), and — path A only — the
   `teams_join_url` as the join button.
3. **Set property (optional):** stamp a `confirmation_sent_at` timestamp for reporting.

## The `.ics` attachment

HubSpot can attach a calendar invite to a marketing/automation email; where the editor needs
the raw payload, use a **custom code action** that returns the `.ics` text and attaches it.
The personal join URL flows into both `LOCATION` and `URL`/`DESCRIPTION` for online events.

> Built from contact properties only — no tenant constants. `ORGANIZER`, `PRODID`, and the
> domain in `UID` are **portal configuration**; the tokens below are replaced per portal.

```ics
BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//{{ ORG_NAME }}//event-registration//EN
CALSCALE:GREGORIAN
METHOD:REQUEST
BEGIN:VEVENT
UID:{{ contact.event_registration_id }}@{{ ICS_DOMAIN }}
DTSTAMP:{{ now | datetimeformat("%Y%m%dT%H%M%SZ") }}
DTSTART:{{ contact.event_start_datetime | datetimeformat("%Y%m%dT%H%M%SZ") }}
DTEND:{{ contact.event_end_datetime | datetimeformat("%Y%m%dT%H%M%SZ") }}
SUMMARY:{{ contact.event_title }}
{% if contact.teams_join_url %}LOCATION:{{ contact.teams_join_url }}
URL:{{ contact.teams_join_url }}
DESCRIPTION:Join online: {{ contact.teams_join_url }}{% else %}LOCATION:{{ contact.event_location }}{% endif %}
ORGANIZER;CN={{ ORG_NAME }}:mailto:{{ ORG_EMAIL }}
STATUS:CONFIRMED
SEQUENCE:0
END:VEVENT
END:VCALENDAR
```

Reference custom-code action (Node) that emits the attachment — property names and the three
portal constants are the only things to set:

```js
// HubSpot custom code action. Inputs: event_title, event_start_datetime, event_end_datetime,
// event_location, teams_join_url, event_registration_id. Constants below are portal config.
const ORG_NAME = process.env.ORG_NAME;       // e.g. set in the action's secrets
const ORG_EMAIL = process.env.ORG_EMAIL;
const ICS_DOMAIN = process.env.ICS_DOMAIN;

exports.main = (event, callback) => {
  const p = event.inputFields;
  const toIcs = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const online = !!p.teams_join_url;
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    `PRODID:-//${ORG_NAME}//event-registration//EN`,
    'METHOD:REQUEST', 'BEGIN:VEVENT',
    `UID:${p.event_registration_id}@${ICS_DOMAIN}`,
    `DTSTAMP:${toIcs(new Date().toISOString())}`,
    `DTSTART:${toIcs(p.event_start_datetime)}`,
    `DTEND:${toIcs(p.event_end_datetime)}`,
    `SUMMARY:${p.event_title}`,
    online ? `LOCATION:${p.teams_join_url}` : `LOCATION:${p.event_location}`,
    online ? `URL:${p.teams_join_url}` : '',
    `ORGANIZER;CN=${ORG_NAME}:mailto:${ORG_EMAIL}`,
    'STATUS:CONFIRMED', 'SEQUENCE:0', 'END:VEVENT', 'END:VCALENDAR'
  ].filter(Boolean).join('\r\n');
  // Return base64 for the email action to attach as event.ics
  callback({ outputFields: { ics_base64: Buffer.from(ics).toString('base64') } });
};
```
