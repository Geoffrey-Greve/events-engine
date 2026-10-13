/**
 * Outbox kind union.
 *
 * Every HubSpot side effect goes through the `outbox` table in the same D1 transaction
 * as the state change, then drains via the queue (CLAUDE.md invariant). `OutboxKind` is
 * the closed set of `outbox.topic` values — the single source of truth shared by the
 * worker's producers (reserve / attendance / payment) and the queue consumer that
 * dispatches them.
 *
 * Note: queue-only job kinds that never produce an outbox row — `expire_hold`,
 * `confirm_payment`, `refund_payment`, `graph.pull_attendance` — are deliberately NOT
 * part of this union; they are routed before the outbox dispatcher.
 */
export type OutboxKind =
  // Marketing Events attendance lifecycle
  | 'me.create'
  | 'me.register'
  | 'me.attend'
  | 'me.cancel'
  | 'me.complete'
  // Contact property write-back (online events)
  | 'contact.set_join_url'
  // Attendee phone/suburb/state onto the contact — writes only where HubSpot is empty,
  // and raises a contact_conflict decision rather than overwriting a differing value
  | 'contact.sync_attendee_details'
  // Attendance (check-in, or a provider-pulled webinar record) projected onto the
  // attendee's contact as an attended flag + date, which is what drives Ollie's Data Hub
  // certificate flow. Never moves the date backwards.
  | 'contact.sync_attendance'
  // Custom registration answers (Phase 2.3) projected onto the attendee's contact, for
  // the questions whose `hs_property` names one — so the answer can be offered back as the
  // default next time instead of being asked again
  | 'contact.sync_answers'
  // The booking's ORDER id stamped onto the attendee's contact, which is what a HubSpot
  // workflow watches to send the registration confirmation email (Ref 61). Its own topic
  // rather than a second call inside me.register: that one is enqueued at RESERVE time, so
  // riding it confirmed unpaid holds, and its failures killed the Marketing Event row
  | 'contact.sync_registration_confirmation'
  // Contact upsert (standalone create-or-update by email — used by transfer)
  | 'contact.upsert'
  // Money objects
  | 'deal.create'
  | 'invoice.create'
  // Refund money side effect (full → void invoice; partial → refund the amount)
  | 'payment.refund'
  // Waitlist notifications (no HubSpot call — handled before token resolution)
  | 'notify.waitlist_joined'
  | 'notify.waitlist_offer'
  // Event-owner task for a pending oversell/waitlist decision (HubSpot engagements API)
  | 'notify.owner_task'
  // Corporate training voucher usage projected onto the company record
  | 'company.sync_voucher_usage'
  // Internal staff note mirrored onto the HubSpot record as a native Note engagement
  | 'note.create'
  // The contact property a registration question maps to, created in the portal. The
  // question editor is the only place that knows the field's TYPE, but creating it inside
  // the request that stores the question left a timeout looking like a failed save on a
  // question that had actually been written (Ref 74)
  | 'question.ensure_property';
