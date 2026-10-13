-- migrations/0041_hubspot_line_items.sql
--
-- Which HubSpot line item this worker created for which booking line. (Ref 40 item 2.)
--
-- `attachExclusiveLineItems` was idempotent only in the sense that it re-read the parent's
-- associated line items from HubSpot and reused whatever came back. That makes HubSpot's
-- own association index the memory of what we did, and a read that comes back empty is
-- indistinguishable from "we have not created this yet" — so every retry POSTed the line
-- again. Ref 40 found a guest booking invoiced at four times its price: one $18,786.36 line
-- per delivery attempt, `max_retries = 3` plus the original, on an invoice that then never
-- opened.
--
-- The invoice and deal ids next to it already avoid this by persisting IMMEDIATELY after
-- the create, before any retryable follow-up call, precisely so a retry cannot mint a
-- second one. This is that same rule for line items, which are the only HubSpot object the
-- write-back creates more than one of per booking and so are the only one that needed a
-- table rather than a column.
--
-- Keyed on (parent object, parent id, external id) rather than on the order alone: a
-- booking has a line per ticket type, and the same booking carries one set on its deal and
-- another on its invoice. `hs_external_id` is what the write-back already uses to name a
-- line ('<order>:<ticketType>' on the deal, 'inv:<order>:<ticketType>' on the invoice), so
-- the key here is the name we were already giving them.
--
-- Rows are DELETED when a line they name is archived (a booking whose lines changed), and
-- otherwise kept: they are the only record that a given HubSpot line item is ours to touch.
CREATE TABLE IF NOT EXISTS hubspot_line_items (
  portal_id          TEXT NOT NULL,
  parent_object_type TEXT NOT NULL,          -- 'invoices' | 'deals'
  parent_id          TEXT NOT NULL,          -- the HubSpot invoice/deal id
  external_id        TEXT NOT NULL,          -- hs_external_id we stamped on the line
  line_item_id       TEXT NOT NULL,          -- the HubSpot line item id
  order_id           TEXT,
  created_at         TEXT NOT NULL,
  PRIMARY KEY (portal_id, parent_object_type, parent_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_hubspot_line_items_order
  ON hubspot_line_items (portal_id, order_id);
