-- migrations/0007_order_invoice_url.sql
-- Persist the HubSpot-hosted invoice payment link on the order.
--
-- The invoice.create write-back opens the invoice and reads hs_invoice_link; storing it
-- here lets the buyer's order poll (GET /api/v1/orders/:id → paymentUrl) hand off to the
-- HubSpot-hosted checkout. Without it the poll never sees a paymentUrl and the buyer never
-- reaches payment before their hold can expire.

ALTER TABLE orders ADD COLUMN hubspot_invoice_url TEXT;
