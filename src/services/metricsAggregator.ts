/**
 * 6h request_logs → Redis aggregator producing tier + UX score per deployment
 * for metric-driven routing. Refresh every 5 min. Margin is NOT computed here;
 * providerRanking blends it in at routing time using deployment.model_specs
 * and deployment.config (both available in-memory on every request).
 */
import { getClickHouseClient } from '../db/clickhouse';
import { buildCacheKey, getRedisClient } from '../db/redis';

const GOOD_THRESHOLD = 0.95;
const DEGRADED_THRESHOLD = 0.8;
const MIN_SAMPLE = 100;

// 4-dim UX score weights (sum = 1). Margin is added in providerRanking with
// W_MARGIN=0.20, so these UX dims effectively contribute 80% of final score.
const W_UPTIME = 0.3;
const W_TTFT = 0.25;
const W_LATENCY = 0.25;
const W_TPS = 0.2;

// Calibrated for thinking models (multi-provider models we route today are
// all thinking-class: GLM 5.1, deepseek-v3.2, etc., p50 latency 5-15s,
// p50 TTFT 0.5-3s, avg TPS 20-50). Sub-500ms TTFT and sub-5s latency saturate
// at 1.0 — chat/embedding deployments hit this ceiling and lose differentiation
// on these dims, but uptime + margin still rank them. Revisit when we add a
// multi-provider chat model.
const TTFT_BEST_MS = 500;
const TTFT_WORST_MS = 5000;
const LATENCY_BEST_MS = 5000;
const LATENCY_WORST_MS = 30000;
const TPS_TARGET = 50;

export type DeploymentTier =
  | 'GOOD'
  | 'DEGRADED'
  | 'FALLBACK_ONLY'
  | 'INSUFFICIENT_DATA';

export interface DeploymentMetrics {
  tier: DeploymentTier;
  // UX-only score (4-dim weighted: uptime/ttft/latency/tps). Margin is
  // combined at routing time in providerRanking — not stored here.
  score: number;
  uptime: number | null;
  p50_latency_ms: number;
  p95_latency_ms: number;
  p50_ttft_ms: number;
  avg_tps: number;
  sample: number;
  provider: string;
  computed_at: number;
}

interface AggRow {
  model: string;
  deployment_id: number | string;
  provider: string;
  total: number | string;
  success_count: number | string;
  uptime_den: number | string;
  rate_limited: number | string;
  server_errors: number | string;
  p50_latency_ms: number | string;
  p95_latency_ms: number | string;
  p50_ttft_ms: number | string;
  avg_tps: number | string;
}

export function tierFromUptime(
  uptime: number | null,
  sample: number
): DeploymentTier {
  if (sample < MIN_SAMPLE || uptime == null) return 'INSUFFICIENT_DATA';
  if (uptime >= GOOD_THRESHOLD) return 'GOOD';
  if (uptime >= DEGRADED_THRESHOLD) return 'DEGRADED';
  return 'FALLBACK_ONLY';
}

export function computeScore(
  uptime: number | null,
  p50LatencyMs: number,
  p50TtftMs: number,
  tps: number
): number {
  if (uptime == null) return 0;
  const ttft = Math.max(
    0,
    Math.min(1, 1 - (p50TtftMs - TTFT_BEST_MS) / (TTFT_WORST_MS - TTFT_BEST_MS))
  );
  const lat = Math.max(
    0,
    Math.min(
      1,
      1 -
        (p50LatencyMs - LATENCY_BEST_MS) / (LATENCY_WORST_MS - LATENCY_BEST_MS)
    )
  );
  const t = Math.min(1, Math.max(0, tps / TPS_TARGET));
  return W_UPTIME * uptime + W_TTFT * ttft + W_LATENCY * lat + W_TPS * t;
}

export function metricsKey(model: string): string {
  return buildCacheKey('metrics', '6h', model);
}

export class MetricsAggregator {
  private static instance: MetricsAggregator;
  private readonly LOCK_KEY = buildCacheKey('metrics', 'lock');
  private readonly LOCK_TTL = 360; // seconds, > 5min refresh interval
  private readonly RESULT_TTL = 7200; // 2h safety net
  private interval: NodeJS.Timeout | null = null;

  private constructor() {}

  static getInstance(): MetricsAggregator {
    if (!MetricsAggregator.instance) {
      MetricsAggregator.instance = new MetricsAggregator();
    }
    return MetricsAggregator.instance;
  }

  async refresh(): Promise<void> {
    const client = await getRedisClient();
    const lockAcquired = await client.set(this.LOCK_KEY, 'locked', {
      PX: this.LOCK_TTL * 1000,
      NX: true,
    });
    if (!lockAcquired) return;

    try {
      const ch = await getClickHouseClient();
      const result = await ch.query({
        query: `
          SELECT
            model,
            toUInt64(model_deployment_id) AS deployment_id,
            provider,
            count() AS total,
            countIf(is_success = 1) AS success_count,
            countIf(NOT (status_code >= 400 AND status_code < 500
                         AND status_code NOT IN (408, 425, 429))) AS uptime_den,
            countIf(error_type = 'rate_limit') AS rate_limited,
            countIf(error_type IN ('upstream_5xx','timeout')) AS server_errors,
            quantile(0.5)(duration_ms) AS p50_latency_ms,
            quantile(0.95)(duration_ms) AS p95_latency_ms,
            quantileIf(0.5)(ttft_ms, is_streaming = 1 AND is_success = 1 AND ttft_ms > 0) AS p50_ttft_ms,
            avg(if(tokens_per_second > 0, tokens_per_second, NULL)) AS avg_tps
          FROM request_logs
          WHERE timestamp >= now() - INTERVAL 6 HOUR
          GROUP BY model, model_deployment_id, provider
        `,
        format: 'JSONEachRow',
      });

      const rows = await result.json<AggRow>();

      const byModel = new Map<string, Record<string, string>>();
      const now = Math.floor(Date.now() / 1000);
      for (const raw of rows) {
        const total = Number(raw.total);
        const successCount = Number(raw.success_count);
        const uptimeDen = Number(raw.uptime_den);
        const p50 = Number(raw.p50_latency_ms) || 0;
        const p95 = Number(raw.p95_latency_ms) || 0;
        const p50Ttft = Number(raw.p50_ttft_ms) || 0;
        const avgTps = Number(raw.avg_tps) || 0;

        const uptime =
          uptimeDen >= MIN_SAMPLE ? successCount / uptimeDen : null;
        // Pass uptimeDen (excludes 4xx user errors) as sample — matches the
        // uptime formula's denominator. Functionally equivalent to `total`
        // today because the uptime==null guard in tierFromUptime already
        // gates INSUFFICIENT_DATA when uptimeDen<MIN_SAMPLE, but stating
        // intent clearly prevents regression if that guard changes.
        const tier = tierFromUptime(uptime, uptimeDen);
        const score = computeScore(uptime, p50, p50Ttft, avgTps);

        const metrics: DeploymentMetrics = {
          tier,
          score,
          uptime,
          p50_latency_ms: p50,
          p95_latency_ms: p95,
          p50_ttft_ms: p50Ttft,
          avg_tps: avgTps,
          sample: total,
          provider: String(raw.provider ?? ''),
          computed_at: now,
        };

        const fields = byModel.get(raw.model) ?? {};
        fields[String(raw.deployment_id)] = JSON.stringify(metrics);
        byModel.set(raw.model, fields);
      }

      if (byModel.size === 0) return;

      const pipe = client.multi();
      for (const [model, fields] of byModel) {
        const key = metricsKey(model);
        pipe.del(key);
        pipe.hSet(key, fields);
        pipe.expire(key, this.RESULT_TTL);
      }
      await pipe.exec();
    } catch (err) {
      console.error('[METRICS_AGG] refresh failed:', err);
    } finally {
      try {
        await client.del(this.LOCK_KEY);
      } catch (err) {
        console.error('[METRICS_AGG] lock release failed:', err);
      }
    }
  }

  start(intervalMs = 5 * 60 * 1000): void {
    if (this.interval) {
      console.log('[METRICS_AGG] already started');
      return;
    }
    // First refresh runs at intervalMs; until then, readers fall back to data
    // left by the previous deploy (Redis TTL = 2h) or to config.weight if
    // there's none. No need for an arbitrary boot-time kick.
    this.interval = setInterval(async () => {
      await this.refresh();
    }, intervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}
