-- Add request_model column to capture the raw client-supplied model string.
--
-- After this migration, the `model` column becomes the gateway-resolved
-- `models.model_id` (canonical/served identity) and `request_model` holds the
-- original alias or string the client typed in the HTTP body. Both columns are
-- always populated post-deploy; for fail-fast traffic (no deployment selected),
-- `model = ''` and `request_model = <raw>`.
--
-- This is a metadata-only ALTER (MergeTree). No data rewrite, no downtime.
-- Historical rows get the column default (empty string).
ALTER TABLE request_logs
    ADD COLUMN IF NOT EXISTS request_model String DEFAULT '' CODEC(ZSTD);

ALTER TABLE spend_logs
    ADD COLUMN IF NOT EXISTS request_model String DEFAULT '' CODEC(ZSTD);
