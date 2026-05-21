/**
 * 24h request_logs → Redis aggregator that produces tier/score per
 * deployment for metric-driven routing.
 *
 * Status: ON ICE during the data-collection phase. start-server.ts does
 * NOT call .start() yet; virtualKeyValidator uses uniform random pick.
 * To enable: see the comment block in virtualKeyValidator/index.ts.
 */
import { getClickHouseClient } from '../db/clickhouse';
import { buildCacheKey, getRedisClient } from '../db/redis';

const GOOD_THRESHOLD = 0.95;
const DEGRADED_THRESHOLD = 0.8;
const MIN_SAMPLE = 100;

const W_UPTIME = 0.5;
const W_LATENCY = 0.3;
const W_TPS = 0.2;

const LATENCY_BEST_MS = 200;
const LATENCY_WORST_MS = 5000;
const TPS_TARGET = 100;

export type DeploymentTier =
  | 'GOOD'
  | 'DEGRADED'
  | 'FALLBACK_ONLY'
  | 'INSUFFICIENT_DATA';

export interface DeploymentMetrics {
  tier: DeploymentTier;
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
  p50ms: number,
  tps: number
): number {
  if (uptime == null) return 0;
  const lat = Math.max(
    0,
    1 - (p50ms - LATENCY_BEST_MS) / (LATENCY_WORST_MS - LATENCY_BEST_MS)
  );
  const t = Math.min(1, Math.max(0, tps / TPS_TARGET));
  return W_UPTIME * uptime + W_LATENCY * lat + W_TPS * t;
}

export function metricsKey(model: string): string {
  return buildCacheKey('metrics', '24h', model);
}

export class MetricsAggregator {
  private static instance: MetricsAggregator;
  private readonly LOCK_KEY = buildCacheKey('metrics', 'agg-lock');
  private readonly LOCK_TTL = 720; // seconds, > refresh interval
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
            quantile(0.5)(ttft_ms) AS p50_ttft_ms,
            avg(if(tokens_per_second > 0, tokens_per_second, NULL)) AS avg_tps
          FROM request_logs
          WHERE timestamp >= now() - INTERVAL 24 HOUR
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
        const tier = tierFromUptime(uptime, total);
        const score = computeScore(uptime, p50, avgTps);

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

  start(intervalMs = 10 * 60 * 1000): void {
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
