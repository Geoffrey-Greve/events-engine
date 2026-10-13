-- Voucher redemption: vouchers become spendable credit at checkout, not just a booking quota.
--
-- Two tenant-selectable models (this is a product, not a Weld-only feature — CLAUDE.md):
--
--   'seat'   — one voucher covers one seat outright, whatever that seat costs.
--              `voucher_total_property` / `voucher_used_property` hold COUNTS.
--   'credit' — the company holds a monetary balance drawn down by the seats it covers.
--              The same two properties hold DOLLAR AMOUNTS (AUD), stored here as cents.
--   'off'    — vouchers are not redeemable for this tenant.
--
-- In both models a voucher covers WHOLE seats only. Under 'credit' any leftover smaller
-- than the cheapest remaining seat stays on the balance for a later booking, which keeps
-- every invoice line either full price or zero — no part-priced seats, no discount lines.

ALTER TABLE tenants ADD COLUMN voucher_mode TEXT NOT NULL DEFAULT 'seat';

-- HubSpot company property names, per tenant, following the same configurable-property
-- convention as membership_level_property / deal_type_property_name.
ALTER TABLE tenants ADD COLUMN voucher_total_property TEXT NOT NULL DEFAULT 'vouchers_total';
ALTER TABLE tenants ADD COLUMN voucher_used_property  TEXT NOT NULL DEFAULT 'vouchers_used';

-- What this order actually redeemed, recorded at reserve time.
--
-- Consumption is summed from these columns rather than counted from registrations: once a
-- booking can be PARTLY covered (5 seats, 3 vouchers left), the seat count on an order no
-- longer equals the vouchers it spent. Storing the redemption keeps usage derived — summing
-- committed orders stays idempotent and refund-safe — while staying correct under partial
-- coverage and later price changes.
ALTER TABLE orders ADD COLUMN voucher_seats_redeemed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN voucher_credit_cents   INTEGER NOT NULL DEFAULT 0;

-- Credit-mode counterpart to baseline_used: usage predating this worker, in cents.
ALTER TABLE corporate_voucher_accounts ADD COLUMN baseline_used_cents INTEGER NOT NULL DEFAULT 0;
