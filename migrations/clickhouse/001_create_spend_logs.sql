-- AI Gateway spend tracking table
CREATE TABLE IF NOT EXISTS spend_logs (
    timestamp DateTime64(3) CODEC(ZSTD),
    endpoint String CODEC(ZSTD),
    duration_ms UInt32 CODEC(ZSTD),
    user_id UInt64 CODEC(Delta, ZSTD),
    virtual_key_id UInt64 CODEC(Delta, ZSTD),
    provider String CODEC(ZSTD),
    model String CODEC(ZSTD),
    model_deployment_id UInt64 CODEC(Delta, ZSTD),
    input_tokens UInt32 DEFAULT 0 CODEC(Delta, ZSTD),
    output_tokens UInt32 DEFAULT 0 CODEC(Delta, ZSTD),
    input_cost_per_token Decimal128(18) CODEC(ZSTD),
    output_cost_per_token Decimal128(18) CODEC(ZSTD),
    input_cost Decimal128(18) MATERIALIZED input_tokens * input_cost_per_token,
    output_cost Decimal128(18) MATERIALIZED output_tokens * output_cost_per_token,
    total_cost Decimal128(18) MATERIALIZED input_cost + output_cost
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (user_id, virtual_key_id, timestamp)
TTL timestamp + INTERVAL 1 YEAR
SETTINGS index_granularity = 8192;
