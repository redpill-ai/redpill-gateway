-- Prompt-cache billing: persist cache token counts + per-token cache prices,
-- and rewrite input_cost / total_cost MATERIALIZED expressions so cache reads
-- and writes are billed at their own rate.
--
-- `input_tokens` keeps OpenAI semantics (total prompt tokens, including the
-- cached subset). Cache amounts are stored in their own columns and subtracted
-- from `input_tokens` only inside the cost formula.
--
-- Historical rows have cache_*_input_tokens = 0 by default, so the rewritten
-- formulas yield identical numbers to the originals — the MATERIALIZED
-- background mutation is a no-op value-wise. Watch system.mutations for progress.

-- 1. Cache token counts + per-token cache prices on spend_logs. Mirrors 001's
--    input/output_cost_per_token pattern: store the prices, let ClickHouse
--    materialize the cost from them. Cache prices are Nullable so "model has
--    no cache-tier pricing" is distinguishable from "explicit zero price" in
--    the audit trail; the SQL formula below coalesces NULL → inputRate.
ALTER TABLE spend_logs
    ADD COLUMN IF NOT EXISTS cache_read_input_tokens     UInt32 DEFAULT 0 CODEC(Delta, ZSTD),
    ADD COLUMN IF NOT EXISTS cache_creation_input_tokens UInt32 DEFAULT 0 CODEC(Delta, ZSTD),
    ADD COLUMN IF NOT EXISTS cache_read_cost_per_token     Nullable(Decimal128(18)) CODEC(ZSTD),
    ADD COLUMN IF NOT EXISTS cache_creation_cost_per_token Nullable(Decimal128(18)) CODEC(ZSTD);

-- 2. input_cost now prices only the non-cached portion of input_tokens.
--    greatest(...) guards against upstream usage anomalies where cache counts
--    exceed prompt_tokens. The cache portion lives in total_cost directly.
ALTER TABLE spend_logs
    MODIFY COLUMN input_cost Decimal128(18)
        MATERIALIZED greatest(
            toInt64(input_tokens) - toInt64(cache_read_input_tokens) - toInt64(cache_creation_input_tokens),
            0
        ) * input_cost_per_token;

-- 3. total_cost folds in cache buckets inline. coalesce(...) on the Nullable
--    cache prices means: NULL (= no cache pricing configured) bills cache
--    tokens at the regular input rate, matching computeCost()'s fallback.
ALTER TABLE spend_logs
    MODIFY COLUMN total_cost Decimal128(18)
        MATERIALIZED input_cost + output_cost
                   + cache_read_input_tokens     * coalesce(cache_read_cost_per_token,     input_cost_per_token)
                   + cache_creation_input_tokens * coalesce(cache_creation_cost_per_token, input_cost_per_token);

-- 4. request_logs surfaces cache token counts for observability (no cost cols).
ALTER TABLE request_logs
    ADD COLUMN IF NOT EXISTS cache_read_input_tokens     UInt32 DEFAULT 0 CODEC(Delta, ZSTD),
    ADD COLUMN IF NOT EXISTS cache_creation_input_tokens UInt32 DEFAULT 0 CODEC(Delta, ZSTD);
