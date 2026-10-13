-- migrations/0002_checkin.sql
-- Check-in support: persist the signed QR code minted at ticket issuance.
-- The code is base64url(JSON{tid,rid,eid}) "." base64url(HMAC-SHA256), signed
-- with the per-event verify key derived from the tenant master secret. It is
-- the artifact handed to attendees and listed in the offline check-in manifest.

ALTER TABLE tickets ADD COLUMN qr_code TEXT;
