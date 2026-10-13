-- migrations/0029_invoice_eligibility.sql
-- Phase 4.2: WHO qualifies to pay on invoice terms.
--
-- Phase 4.1 fixed the fault — a paid booking's seat is held to the invoice due date
-- rather than for 15 minutes (0019), so a buyer paying by bank transfer keeps both the
-- seat and a live payment link. It fixed it for EVERYONE: today every paid booking gets
-- the long hold, whether or not the payer was ever going to be invoiced.
--
-- Eligibility is modelled as a RULE, not a flag on a contact, for the same reasons
-- `pricing_rules` is: it is auditable (the row says who decided what, and when), it is
-- per-tenant configuration rather than code, and it resolves most-specific-first so a
-- portal-wide default and a named exception can coexist. A flag on a contact would be
-- editable by anyone in the CRM with no record of why, and would have to be set on every
-- contact rather than described once.
--
-- IMPORTANT — an EMPTY rule set is not "nobody qualifies".
-- A portal with no active rows has not configured this feature, and must keep behaving
-- exactly as it did before this migration: every paid booking invoice-eligible. Reading an
-- empty table as "everyone pays at checkout" would silently reinstate the 15-minute hold
-- for every existing tenant on deploy — which is the AWS D1.1 fault 4.1 exists to fix.
-- A tenant OPTS IN to the gate by writing at least one active rule; from then on a payer
-- matching none of them pays at checkout. `match_kind = 'always'` is how a tenant writes
-- "everyone qualifies" explicitly, and is what a narrowing rule set omits.

CREATE TABLE invoice_eligibility_rules (
  id           TEXT    PRIMARY KEY,
  portal_id    TEXT    NOT NULL REFERENCES tenants(portal_id),

  -- What the rule matches on, in specificity order:
  --   'contact_property'  — a property on the BUYER's contact          (most specific)
  --   'company_property'  — a property on the buyer's company
  --   'membership_level'  — the resolved canonical membership tier
  --   'always'            — every buyer                                 (least specific)
  match_kind   TEXT    NOT NULL,

  -- The property name to read ('contact_property' / 'company_property'), or which half of
  -- the membership tier to compare — 'level' (default when NULL) or 'category'. Unused by
  -- 'always'.
  match_key    TEXT,

  -- The value that qualifies, compared case-insensitively after trimming. NULL or empty
  -- against a property rule means "any non-empty value" — the property's PRESENCE is the
  -- qualification, which is how a plain HubSpot checkbox is expressed.
  match_value  TEXT,

  -- Payment terms in days for a payer this rule qualifies. Sits between the per-event
  -- override and the portal default in the resolution chain (see below), so a
  -- capacity-tight event keeps its short window whoever is paying.
  terms_days   INTEGER NOT NULL DEFAULT 30,

  -- Reservation hold for a payer this rule qualifies, in milliseconds. NULL = hold the
  -- seat to the END of the invoice due date, which is 4.1's behaviour and the default.
  -- Setting it SHORTER than the terms is deliberate and supported: the seat comes back
  -- into sale while the invoice stays payable, and a payment that lands afterwards takes
  -- the existing late-payment route (order → needs_review, owner honours or refunds).
  hold_ms      INTEGER,

  -- Optional floor on the booking total, e.g. "invoice only above $1,000". A rule whose
  -- floor the booking does not meet simply does not match, and resolution continues to the
  -- next rule — so "gold members may invoice anything, everyone else only above $1,000" is
  -- two rows rather than a special case.
  min_cents    INTEGER,

  -- Operator tie-break WITHIN a match_kind; higher wins. Specificity across kinds is not
  -- negotiable through this column — a 'contact_property' rule is about one person and
  -- always beats an 'always' rule, whatever priorities are set.
  priority     INTEGER NOT NULL DEFAULT 0,

  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- The resolver's only query shape: this portal's active rules, ordered.
CREATE INDEX idx_invoice_eligibility_lookup
  ON invoice_eligibility_rules (portal_id, active, match_kind);

-- ---------------------------------------------------------------------------
-- What the ORDER recorded about how it was to be paid
-- ---------------------------------------------------------------------------
-- Eligibility is resolved once, at reserve, because that is the call that has to pass the
-- correct hold to the DO. Recording the outcome on the order is what makes it auditable
-- afterwards: a booking whose seat was held for 30 days says so, and says why.
--
-- 'invoice' — qualified for terms; the seat is held to the due date.
-- 'card'    — pays at checkout; the seat takes the DO's default 15-minute hold and the
--             invoice is raised due on receipt.
-- NULL      — no payment applies (a free or comped booking, which holds no seat).
ALTER TABLE orders ADD COLUMN payment_method TEXT;

-- The terms actually granted, in days. NULL alongside 'card' and on free bookings.
ALTER TABLE orders ADD COLUMN payment_terms_days INTEGER;
