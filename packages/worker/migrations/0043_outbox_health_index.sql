-- ---------------------------------------------------------------------------
-- 0043 — an index for the outbox health heartbeat.
--
-- `idx_outbox_drain` is partial on `status IN ('pending','failed')`, so the sweep and the
-- "stuck" half of the heartbeat are already served. Dead rows are served by nothing, and
-- the outbox is never purged (rows are the record of what this worker did, and absence has
-- to stay a real finding — see Phase 2.2's `notSyncedToMarketingEvent`). Counting them
-- every fifteen minutes would therefore be a full scan of a table that only grows.
--
-- Partial on `dead` and keyed by `created_at` because the heartbeat asks "what died
-- recently", not "how many have ever died": an all-time count never goes down, so it would
-- alert forever after the first one, which is how a real dead row stops being noticed.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_outbox_dead_recent
  ON outbox (created_at, portal_id)
  WHERE status = 'dead';
