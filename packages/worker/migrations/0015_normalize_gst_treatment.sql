-- Legacy ticket_types rows defaulted to tax_treatment = 'gst_inclusive' before
-- Phase 18.1 normalised the toggle to 'gst' | 'gst_free'. Staging still has every
-- Weld ticket on 'gst_inclusive'. The write-back already treats non-gst_free as
-- taxable, but normalise the stored value so admin UI + validators stay consistent.
UPDATE ticket_types
SET tax_treatment = 'gst'
WHERE tax_treatment = 'gst_inclusive';
