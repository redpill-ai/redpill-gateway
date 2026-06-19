/**
 * request_logs → Redis aggregator producing tier + UX score per deployment for
 * metric-driven routing. Scans 24h, prefers a responsive 6h sub-window and
 * falls back to 24h for low-traffic deployments (see DeploymentMetrics.window).
 * Refresh every 5 min. Margin is NOT computed here;
 * providerRanking blends it in at routing time using deployment.model_specs
 * and deployment.config (both available in-memory on every request).
 */
import { getClickHouseClient } from '../db/clickhouse';
import { buildCacheKey, getRedisClient } from '../db/redis';
import { queryPostgres } from '../db/postgres/connection';

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

// Profit-first per-key availability (written by MetricsAggregator, read in
// providerRanking).
const PROFIT_AVAIL_WINDOW_HOURS = 1;
const PROFIT_AVAIL_MIN_SAMPLE = 50; // below this, leave unknown (don't 429)
const PROFIT_AVAIL_TTL = 900; // 15 min (> 5 min refresh)

export type DeploymentTier =
  | 'GOOD'
  | 'DEGRADED'
  | 'UNHEALTHY'
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
  // Window these metrics were computed over. Normally '6h' (responsive); a
  // low-traffic deployment that can't reach MIN_SAMPLE in 6h falls back to the
  // 24h window so it gets a real tier instead of being stuck INSUFFICIENT_DATA
  // forever. High-traffic deployments always use 6h, so outage detection stays
  // fast for the backends that carry real volume.
  window: '6h' | '24h';
  provider: string;
  computed_at: number;
}

// One GROUP BY row: the same aggregates over the recent 6h sub-window and over
// the full 24h scan window. buildDeploymentMetrics picks which set to use.
interface AggRow {
  model: string;
  deployment_id: number | string;
  provider: string;
  total_6h: number | string;
  success_6h: number | string;
  uptime_den_6h: number | string;
  p50_latency_6h: number | string;
  p95_latency_6h: number | string;
  p50_ttft_6h: number | string;
  avg_tps_6h: number | string;
  total_24h: number | string;
  success_24h: number | string;
  uptime_den_24h: number | string;
  p50_latency_24h: number | string;
  p95_latency_24h: number | string;
  p50_ttft_24h: number | string;
  avg_tps_24h: number | string;
}

/**
 * Adaptive window: use the responsive 6h metrics when 6h has enough samples
 * (uptime_den_6h >= MIN_SAMPLE), else fall back to 24h so low-traffic
 * deployments still get classified. Pure — unit-tested directly.
 */
export function buildDeploymentMetrics(
  raw: AggRow,
  computedAt: number
): DeploymentMetrics {
  const uptimeDen6 = Number(raw.uptime_den_6h);
  const use6 = uptimeDen6 >= MIN_SAMPLE;
  const window: '6h' | '24h' = use6 ? '6h' : '24h';

  const total = Number(use6 ? raw.total_6h : raw.total_24h);
  const successCount = Number(use6 ? raw.success_6h : raw.success_24h);
  const uptimeDen = use6 ? uptimeDen6 : Number(raw.uptime_den_24h);
  const p50 = Number(use6 ? raw.p50_latency_6h : raw.p50_latency_24h) || 0;
  const p95 = Number(use6 ? raw.p95_latency_6h : raw.p95_latency_24h) || 0;
  const p50Ttft = Number(use6 ? raw.p50_ttft_6h : raw.p50_ttft_24h) || 0;
  const avgTps = Number(use6 ? raw.avg_tps_6h : raw.avg_tps_24h) || 0;

  const uptime = uptimeDen >= MIN_SAMPLE ? successCount / uptimeDen : null;
  const tier = tierFromUptime(uptime, uptimeDen);
  const score = computeScore(uptime, p50, p50Ttft, avgTps);

  return {
    tier,
    score,
    uptime,
    p50_latency_ms: p50,
    p95_latency_ms: p95,
    p50_ttft_ms: p50Ttft,
    avg_tps: avgTps,
    sample: total,
    window,
    provider: String(raw.provider ?? ''),
    computed_at: computedAt,
  };
}

export function tierFromUptime(
  uptime: number | null,
  sample: number
): DeploymentTier {
  if (sample < MIN_SAMPLE || uptime == null) return 'INSUFFICIENT_DATA';
  if (uptime >= GOOD_THRESHOLD) return 'GOOD';
  if (uptime >= DEGRADED_THRESHOLD) return 'DEGRADED';
  return 'UNHEALTHY';
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

// Namespace is window-agnostic: the metrics under this key may be computed over
// the 6h or 24h window per deployment (see DeploymentMetrics.window). Renamed
// off the old '6h' literal so the name no longer implies a fixed window.
export function metricsKey(model: string): string {
  return buildCacheKey('metrics', 'routing', model);
}

// Per-(key, model) profit availability, under the same `metrics` namespace as
// metricsKey (both written by MetricsAggregator, read in providerRanking). The
// floor is per-model: we protect each model's availability for the key, not a
// cross-model blend.
export function keyAvailabilityKey(vkId: number, model: string): string {
  return buildCacheKey('metrics', 'profit_availability', String(vkId), model);
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
      // `model` is the resolved canonical models.model_id (post-PR1) so this
      // GROUP BY collapses requests across all aliases of the same model into
      // one metric set per (model, deployment, provider). Skip rows where
      // model is empty — those are fail-fast traffic with no resolved
      // deployment; they shouldn't drive routing decisions.
      // Scan 24h once; compute aggregates over both the recent 6h sub-window
      // (responsive) and the full 24h window (cold-start fallback for
      // low-traffic deployments). buildDeploymentMetrics picks per deployment.
      const result = await ch.query({
        query: `
          SELECT
            model,
            toUInt64(model_deployment_id) AS deployment_id,
            provider,
            countIf(timestamp >= now() - INTERVAL 6 HOUR) AS total_6h,
            countIf(is_success = 1 AND timestamp >= now() - INTERVAL 6 HOUR) AS success_6h,
            -- 429 is excluded from the denominator: a rate-limited node is at
            -- capacity, not unhealthy. Counting it would penalize the cheapest
            -- (highest-margin) node for winning the most traffic. Capacity is
            -- handled by per-request failover, not by the uptime score. 408/425
            -- stay counted as genuine availability failures.
            countIf(timestamp >= now() - INTERVAL 6 HOUR
                    AND NOT (status_code >= 400 AND status_code < 500
                             AND status_code NOT IN (408, 425))) AS uptime_den_6h,
            quantileIf(0.5)(duration_ms, timestamp >= now() - INTERVAL 6 HOUR) AS p50_latency_6h,
            quantileIf(0.95)(duration_ms, timestamp >= now() - INTERVAL 6 HOUR) AS p95_latency_6h,
            quantileIf(0.5)(ttft_ms, is_streaming = 1 AND is_success = 1 AND ttft_ms > 0 AND timestamp >= now() - INTERVAL 6 HOUR) AS p50_ttft_6h,
            avgIf(if(tokens_per_second > 0, tokens_per_second, NULL), timestamp >= now() - INTERVAL 6 HOUR) AS avg_tps_6h,
            count() AS total_24h,
            countIf(is_success = 1) AS success_24h,
            countIf(NOT (status_code >= 400 AND status_code < 500
                         AND status_code NOT IN (408, 425))) AS uptime_den_24h,
            quantile(0.5)(duration_ms) AS p50_latency_24h,
            quantile(0.95)(duration_ms) AS p95_latency_24h,
            quantileIf(0.5)(ttft_ms, is_streaming = 1 AND is_success = 1 AND ttft_ms > 0) AS p50_ttft_24h,
            avg(if(tokens_per_second > 0, tokens_per_second, NULL)) AS avg_tps_24h
          FROM request_logs
          WHERE timestamp >= now() - INTERVAL 24 HOUR
            AND model != ''
          GROUP BY model, model_deployment_id, provider
        `,
        format: 'JSONEachRow',
      });

      const rows = await result.json<AggRow>();

      const byModel = new Map<string, Record<string, string>>();
      const now = Math.floor(Date.now() / 1000);
      for (const raw of rows) {
        const metrics = buildDeploymentMetrics(raw, now);
        const fields = byModel.get(raw.model) ?? {};
        fields[String(raw.deployment_id)] = JSON.stringify(metrics);
        byModel.set(raw.model, fields);
      }

      if (byModel.size > 0) {
        const pipe = client.multi();
        for (const [model, fields] of byModel) {
          const key = metricsKey(model);
          pipe.del(key);
          pipe.hSet(key, fields);
          pipe.expire(key, this.RESULT_TTL);
        }
        await pipe.exec();
      }

      // Profit-first per-key availability — AFTER the tier write so a slow
      // profit query can't delay the critical routing metrics. Isolated so a
      // failure here doesn't break tier refresh.
      await this.refreshProfitAvailability().catch((err) =>
        console.error('[PROFIT_AVAIL] refresh failed:', err)
      );
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

  // Compute per-(key, model) availability for keys on the 'profit' strategy and
  // cache it for the failover floor decision. Per request (deduped by
  // request_id, not per attempt) and per model, so the floor protects each
  // model's availability for the key rather than a cross-model blend. Our
  // profit 429s and upstream failures lower it; client 4xx also count as
  // not-served (conservative — errs toward serving). Only profit keys (a small
  // operator-set list) are queried.
  private async refreshProfitAvailability(): Promise<void> {
    const keys = await queryPostgres<{ id: number }>(
      `SELECT id FROM virtual_keys
       WHERE active = true AND metadata->>'routing_strategy' = 'profit'`
    );
    const ids = keys.map((k) => Number(k.id)).filter(Number.isFinite);
    if (!ids.length) return;

    const ch = await getClickHouseClient();
    // Dedup by request_id: failover writes one row per attempt, so counting
    // rows would over-count failures for failover-heavy keys. A request is
    // "served" if any of its rows succeeded (is_success=1); availability =
    // served requests / total requests, computed per (key, model).
    const result = await ch.query({
      query: `
        SELECT
          toUInt64(virtual_key_id) AS vk,
          model,
          uniqExact(request_id) AS total,
          uniqExactIf(request_id, is_success = 1) AS served
        FROM request_logs
        WHERE timestamp >= now() - INTERVAL ${PROFIT_AVAIL_WINDOW_HOURS} HOUR
          AND virtual_key_id IN (${ids.join(',')})
          AND model != ''
        GROUP BY virtual_key_id, model
      `,
      format: 'JSONEachRow',
    });
    const rows = await result.json<{
      vk: number | string;
      model: string;
      total: number | string;
      served: number | string;
    }>();

    const client = await getRedisClient();
    for (const r of rows) {
      const total = Number(r.total);
      if (total < PROFIT_AVAIL_MIN_SAMPLE) continue; // too little signal
      const avail = Number(r.served) / total;
      await client.set(
        keyAvailabilityKey(Number(r.vk), r.model),
        String(avail),
        { EX: PROFIT_AVAIL_TTL }
      );
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
