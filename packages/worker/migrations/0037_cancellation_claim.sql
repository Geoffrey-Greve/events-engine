-- migrations/0037_cancellation_claim.sql
--
-- A short lease that decides WHICH request owns a cancellation, without the
-- cancellation itself having to happen before its outbox rows.
--
-- Two concurrent cancels of one seat both used to reach the Durable Object and the
-- outbox, and only afterwards discover which of them had flipped `cancelled_at` —
-- freeing a second seat and issuing the refund twice. Flipping `cancelled_at` first
-- fixed that and bought a worse failure: a worker that stopped between the flip and the
-- batch left a registration that reads cancelled forever with no refund, no `me.cancel`
-- and a live ticket. Nothing retries it, because a retry reads it as already cancelled.
--
-- So the lease is what races, and `cancelled_at` goes back into the same D1 batch as the
-- outbox rows it belongs with. The two failure directions are not symmetric: an abandoned
-- lease expires and the seat is cancellable again, which is recoverable, where a
-- cancelled-but-unrefunded seat needs a human who does not know to look.
--
-- Both columns are cleared when the cancellation commits: the lease is about the moments
-- around the write, and nothing reads it afterwards.

ALTER TABLE registrations ADD COLUMN cancellation_claim TEXT;
ALTER TABLE registrations ADD COLUMN cancellation_claimed_at TEXT;
