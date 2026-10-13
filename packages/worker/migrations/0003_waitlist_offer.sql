-- migrations/0002_waitlist_offer.sql
-- Waitlist promotion support.
--
-- 1. quantity: a waitlist entry is one row per buyer (a group waits together), so we
--    must know how many seats the entry wants to decide whether a freed batch "fits".
-- 2. status gains 'promoted': set when the offer holder claims it at /reserve. Full set
--    is now: waiting | offered | promoted | expired | converted | cancelled.

ALTER TABLE waitlist ADD COLUMN quantity INTEGER NOT NULL DEFAULT 1;
