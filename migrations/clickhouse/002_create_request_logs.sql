-- AI Gateway per-request observability table.
-- Logs every attempt (success + failure + retry) for routing and uptime analytics.
-- Independent of spend_logs (which only records billable successful requests).
CREATE TABLE IF NOT EXISTS request_logs (
    request_id           String CODEC(ZSTD),
    timestamp            DateTime64(3) CODEC(ZSTD),
    endpoint             LowCardinality(String) CODEC(ZSTD),

    -- Routing
    model                String CODEC(ZSTD),
    provider             LowCardinality(String) CODEC(ZSTD),
    model_deployment_id  UInt64 CODEC(Delta, ZSTD),
    deployment_name      String CODEC(ZSTD),
    attempt_index        UInt8 DEFAULT 0 CODEC(ZSTD),
    is_fallback          UInt8 MATERIALIZED attempt_index > 0,

    -- Outcome
    status_code          UInt16 DEFAULT 0 CODEC(ZSTD),
    is_success           UInt8 MATERIALIZED status_code >= 200 AND status_code < 300,
    error_type           LowCardinality(String) DEFAULT '' CODEC(ZSTD),
    error_message        String DEFAULT '' CODEC(ZSTD),

    -- Latency (milliseconds)
    duration_ms          UInt32 DEFAULT 0 CODEC(Delta, ZSTD),
    ttft_ms              UInt32 DEFAULT 0 CODEC(Delta, ZSTD),

    -- Throughput
    input_tokens         UInt32 DEFAULT 0 CODEC(Delta, ZSTD),
    output_tokens        UInt32 DEFAULT 0 CODEC(Delta, ZSTD),
    tokens_per_second    Float32 MATERIALIZED
        if(output_tokens > 0 AND duration_ms > ttft_ms,
           output_tokens * 1000.0 / (duration_ms - ttft_ms), 0),

    -- Attribution
    user_id              UInt64 CODEC(Delta, ZSTD),
    virtual_key_id       UInt64 CODEC(Delta, ZSTD),

    -- Flags
    is_streaming         UInt8 DEFAULT 0 CODEC(ZSTD),
    cache_hit            UInt8 DEFAULT 0 CODEC(ZSTD)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(timestamp)
ORDER BY (model, model_deployment_id, timestamp)
TTL timestamp + INTERVAL 1 YEAR
SETTINGS index_granularity = 8192;
