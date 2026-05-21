/**
 * Metric-driven deployment ranking (read side of MetricsAggregator).
 *
 * Status: ON ICE during the data-collection phase. virtualKeyValidator
 * currently does uniform random pick instead of calling rankDeployments.
 * Exported symbols are kept so tests stay meaningful and the switch-on
 * path is short.
 */
import { type ModelDeployment } from '../db/postgres/model';
import { getRedisClient } from '../db/redis';
import {
  DeploymentMetrics,
  DeploymentTier,
  metricsKey,
} from './metricsAggregator';

const CACHE_TTL_MS = 30 * 1000;

type CacheEntry = {
  value: Map<number, DeploymentMetrics>;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry>();

export async function getMetricsForModel(
  model: string
): Promise<Map<number, DeploymentMetrics>> {
  const now = Date.now();
  const cached = cache.get(model);
  if (cached && cached.expiresAt > now) return cached.value;

  try {
    const client = await getRedisClient();
    const raw = await client.hGetAll(metricsKey(model));
    const map = new Map<number, DeploymentMetrics>();
    for (const [field, value] of Object.entries(raw)) {
      const id = Number(field);
      if (!Number.isFinite(id)) continue;
      try {
        map.set(id, JSON.parse(value) as DeploymentMetrics);
      } catch {
        // skip malformed entries
      }
    }
    cache.set(model, { value: map, expiresAt: now + CACHE_TTL_MS });
    return map;
  } catch (err) {
    console.error('[METRICS] read failed:', err);
    return new Map();
  }
}

const TIER_ORDER: DeploymentTier[] = [
  'GOOD',
  'INSUFFICIENT_DATA',
  'DEGRADED',
  'FALLBACK_ONLY',
];

function weightedRandomIndex(weights: number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  let r = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    if (r < weights[i]) return i;
    r -= weights[i];
  }
  return weights.length - 1;
}

export function rankDeployments(
  deployments: ModelDeployment[],
  metrics: Map<number, DeploymentMetrics>
): ModelDeployment[] {
  if (deployments.length <= 1) return deployments;

  type Decorated = {
    d: ModelDeployment;
    tier: DeploymentTier;
    score: number;
    weight: number;
  };

  const decorated: Decorated[] = deployments.map((d) => {
    const m = metrics.get(d.id);
    return {
      d,
      tier: m?.tier ?? 'INSUFFICIENT_DATA',
      score: m?.score ?? 0,
      weight: d.config?.weight ?? 1,
    };
  });

  const byTier = new Map<DeploymentTier, Decorated[]>();
  for (const item of decorated) {
    const list = byTier.get(item.tier) ?? [];
    list.push(item);
    byTier.set(item.tier, list);
  }

  const result: ModelDeployment[] = [];
  for (const tier of TIER_ORDER) {
    const list = byTier.get(tier);
    if (!list || list.length === 0) continue;

    if (list.length === 1) {
      result.push(list[0].d);
      continue;
    }

    if (tier === 'GOOD') {
      // Weighted random for the primary slot (use score, fall back to config.weight)
      const weights = list.map((x) => (x.score > 0 ? x.score : x.weight));
      const primaryIdx = weightedRandomIndex(weights);
      const primary = list[primaryIdx];
      const rest = list
        .filter((_, i) => i !== primaryIdx)
        .sort((a, b) => b.score - a.score);
      result.push(primary.d, ...rest.map((x) => x.d));
    } else if (tier === 'INSUFFICIENT_DATA') {
      // No metric signal yet; let traffic flow per config.weight so we learn
      const weights = list.map((x) => x.weight);
      const primaryIdx = weightedRandomIndex(weights);
      const primary = list[primaryIdx];
      const rest = list
        .filter((_, i) => i !== primaryIdx)
        .sort((a, b) => b.weight - a.weight);
      result.push(primary.d, ...rest.map((x) => x.d));
    } else {
      // DEGRADED / FALLBACK_ONLY — deterministic best-of-the-rest
      list.sort((a, b) => b.score - a.score);
      result.push(...list.map((x) => x.d));
    }
  }

  return result;
}
