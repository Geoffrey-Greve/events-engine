/**
 * Notification channel (waitlist join + offer emails).
 *
 * Notifications are recorded transactionally in the `outbox` table — in the same D1
 * batch as the state change that triggered them — and drained off the queue like every
 * other write-back (CLAUDE.md). Handling them here keeps the outbox consistent and stops
 * `notify.*` rows from dead-lettering through the HubSpot dispatcher's unknown-kind path.
 *
 * Real delivery (HubSpot single-send transactional email, or an SMS/push provider) lands
 * in a later phase. For now we accept the message so the row is marked delivered; the
 * signed offer token travels untouched in `payload.offerToken` for whoever wires the send.
 */

export async function handleNotify(kind: string, _payload: Record<string, unknown>): Promise<void> {
  switch (kind) {
    case 'notify.waitlist_joined':
    case 'notify.waitlist_offer':
      // Accept and (for now) no-op. The outbox row carries everything a future email
      // provider needs; the queue consumer marks it delivered once we return.
      return;
    default:
      return;
  }
}
