-- Corporate training voucher accounting.
--
-- Background: commit 85a0113 ("Unify corporate bulk checkout") routed corporate bulk
-- registrations through the standard reserve/payment flow and dropped the only writer of
-- the HubSpot company property `vouchers_used`. The bulk-register gate kept *reading* it,
-- so the balance never moved and a company could spend the same vouchers indefinitely.
--
-- D1 is now the source of truth for voucher consumption and HubSpot's `vouchers_used` is a
-- projection of it, recomputed and pushed via the outbox. Consumption is derived from order
-- state rather than incremented, so it is idempotent under queue retries and self-corrects
-- when an order is refunded, expires, or is cancelled.

-- Links an order back to the company whose vouchers it draws on. Set at reserve time from
-- the request's memberCompanyId (already used for member pricing, previously not persisted).
ALTER TABLE orders ADD COLUMN member_company_id TEXT;

CREATE INDEX idx_orders_member_company ON orders (portal_id, member_company_id)
  WHERE member_company_id IS NOT NULL;

-- Per-company voucher usage that predates this worker (or was entered by hand in HubSpot).
-- Captured once, the first time we touch a company, so recomputing `vouchers_used` from D1
-- never erases usage the worker was not responsible for.
CREATE TABLE corporate_voucher_accounts (
  portal_id     TEXT    NOT NULL REFERENCES tenants(portal_id),
  company_id    TEXT    NOT NULL,
  baseline_used INTEGER NOT NULL DEFAULT 0,
  captured_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (portal_id, company_id)
);
