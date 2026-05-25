/**
 * Metric-driven deployment ranking (read side of MetricsAggregator).
 *
 * Combines UX score (4-dim, computed by metricsAggregator and stored in
 * Redis) with margin score (computed here from deployment.config and
 * deployment.model_specs which are already in memory) into a final score
 * for tier-internal weighted random / sort.
 */
import { type ModelDeployment } from '../db/postgres/model';
import { getRedisClient } from '../db/redis';
import {
  DeploymentMetrics,
  DeploymentTier,
  metricsKey,
} from './metricsAggregator';

const CACHE_TTL_MS = 30 * 1000;

// Routing-time blend of UX score (from Redis) and margin (from deployment
// data). UX dimensions sum to 80%, margin is 20%. Margin acts as a tiebreaker
// when UX is similar; when UX leader is clear, UX still dominates. No hard
// gate — keep the function continuous so admin price changes shift routing
// smoothly. If admin wants to definitively exclude a provider they should
// `deployments deactivate` it, not rely on the algorithm to do so implicitly.
const W_MARGIN = 0.2;
const W_UX = 1 - W_MARGIN;

export function marginScore(d: ModelDeployment): number {
  const specs = (d.model_specs ?? {}) as {
    input_cost_per_token?: string | number | null;
  };
  const config = (d.config ?? {}) as {
    input_cost_per_token?: string | number | null;
  };
  const sellRaw = specs.input_cost_per_token;
  const costRaw = config.input_cost_per_token;
  if (sellRaw == null || sellRaw === '' || costRaw == null || costRaw === '') {
    // Unknown margin → neutral. Don't penalize for missing data; admin can
    // fix the data without the algorithm punishing them in the meantime.
    return 0.5;
  }
  const sell = Number(sellRaw);
  const cost = Number(costRaw);
  if (!Number.isFinite(sell) || !Number.isFinite(cost) || cost === 0) {
    return 0.5;
  }
  const margin = (sell - cost) / cost;
  return Math.min(1, Math.max(0, (margin + 0.3) / 0.6));
}

export function finalScore(d: ModelDeployment, uxScore: number): number {
  return W_UX * uxScore + W_MARGIN * marginScore(d);
}

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
    const uxScore = m?.score ?? 0;
    return {
      d,
      tier: m?.tier ?? 'INSUFFICIENT_DATA',
      score: finalScore(d, uxScore),
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
