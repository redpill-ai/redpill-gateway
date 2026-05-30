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
  keyAvailabilityKey,
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

export type RoutingStrategy = 'availability' | 'profit';

// Profit-first only serves backends whose full margin is at or above this floor
// (0 = break-even). Loss-making backends are last-resort fallback only.
export const PROFIT_MIN_MARGIN = 0;

// Fixed primary-lottery weight for a cold deployment (see isCold). Small and
// flat: it buys an unproven backend a bounded, single-digit-% share of primary
// traffic so it accumulates samples and graduates instead of starving at the
// bottom forever — while its own noisy point estimate is ignored, so a lucky
// all-success small sample can't catapult it to primary.
const EXPLORE_WEIGHT = 0.05;

// A deployment is "cold" when it has no trustworthy uptime yet: no metrics, a
// null uptime (below MIN_SAMPLE even after the 24h fallback), or the
// INSUFFICIENT_DATA tier. tier and uptime are produced together and always
// agree, but keying on BOTH is deliberate: it guarantees an INSUFFICIENT_DATA
// deployment is always treated as cold (→ GOOD lottery) and can never be bucketed
// into a tier absent from TIER_ORDER, which would silently drop it from routing.
function isCold(m: DeploymentMetrics | undefined): boolean {
  return m == null || m.uptime == null || m.tier === 'INSUFFICIENT_DATA';
}

// Shared cold-vs-graduated primary-lottery weight, used by both strategies.
// Graduated deployments use their real weight (UX for profit, finalScore-based
// for availability); cold ones get the fixed exploration allowance.
function lotteryWeight(
  m: DeploymentMetrics | undefined,
  graduatedWeight: number
): number {
  return isCold(m) ? EXPLORE_WEIGHT : graduatedWeight;
}

function toNum(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Full per-(1 input + 1 output token) margin for profit eligibility:
 *   ((sellIn - costIn) + (sellOut - costOut)) / (costIn + costOut)
 * Returns null when any price is missing/unparseable or total cost <= 0 —
 * callers treat null as "not profit-eligible" (don't route profit traffic to a
 * backend we can't price).
 */
export function fullMargin(d: ModelDeployment): number | null {
  const specs = (d.model_specs ?? {}) as Record<string, unknown>;
  const config = (d.config ?? {}) as Record<string, unknown>;
  const sellIn = toNum(specs.input_cost_per_token);
  const sellOut = toNum(specs.output_cost_per_token);
  const costIn = toNum(config.input_cost_per_token);
  const costOut = toNum(config.output_cost_per_token);
  if (sellIn == null || sellOut == null || costIn == null || costOut == null) {
    return null;
  }
  const costSum = costIn + costOut;
  if (costSum <= 0) return null;
  return (sellIn - costIn + (sellOut - costOut)) / costSum;
}

/**
 * Cached recent availability for a virtual key (written by
 * MetricsAggregator.refresh), or null if unknown. Read side — mirrors
 * getMetricsForModel. Hot path reads this single number; no CH, no counters.
 */
export async function getKeyAvailability(
  vkId: number,
  model: string
): Promise<number | null> {
  try {
    const client = await getRedisClient();
    const v = await client.get(keyAvailabilityKey(vkId, model));
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  } catch (err) {
    console.error('[PROFIT_AVAIL] read failed:', err);
    return null;
  }
}

/**
 * At the loss boundary, 429 only when the key has headroom strictly above its
 * floor; serve at a loss when it's at/below the floor or availability is
 * unknown. Pure.
 */
export function shouldRejectForProfit(
  availability: number | null,
  floor: number
): boolean {
  return availability != null && availability > floor;
}

type CacheEntry = {
  value: Map<number, DeploymentMetrics>;
  expiresAt: number;
};

const cache = new Map<string, CacheEntry>();

/**
 * Reads per-deployment metrics keyed by canonical `models.model_id`.
 *
 * Callers must pass the resolved canonical id (e.g. `deployment.model_slug`),
 * not the raw client-supplied alias string. metricsAggregator writes one hash
 * per canonical model — passing an alias here would miss it because the
 * aggregator collapses all aliases of the same model into one hash, keyed by
 * the canonical value.
 */
export async function getMetricsForModel(
  modelId: string
): Promise<Map<number, DeploymentMetrics>> {
  const now = Date.now();
  const cached = cache.get(modelId);
  if (cached && cached.expiresAt > now) return cached.value;

  try {
    const client = await getRedisClient();
    const raw = await client.hGetAll(metricsKey(modelId));
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
    cache.set(modelId, { value: map, expiresAt: now + CACHE_TTL_MS });
    return map;
  } catch (err) {
    console.error('[METRICS] read failed:', err);
    return new Map();
  }
}

const TIER_ORDER: DeploymentTier[] = ['GOOD', 'DEGRADED', 'FALLBACK_ONLY'];

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

/**
 * Profit-first ordering: profitable (margin ≥ PROFIT_MIN_MARGIN) backends
 * first, most reliable (UX) first; loss-making / unpriceable backends last,
 * least-loss first. The failover loop tries the profitable prefix normally and
 * only crosses into the loss suffix under the per-key availability floor (else
 * 429) — see tryWithDeploymentFailover.
 */
function rankProfit(
  deployments: ModelDeployment[],
  metrics: Map<number, DeploymentMetrics>
): ModelDeployment[] {
  const ux = (d: ModelDeployment) => metrics.get(d.id)?.score ?? 0;
  const profitable: ModelDeployment[] = [];
  const lossy: { d: ModelDeployment; margin: number }[] = [];
  for (const d of deployments) {
    const m = fullMargin(d);
    if (m != null && m >= PROFIT_MIN_MARGIN) profitable.push(d);
    else lossy.push({ d, margin: m ?? -Infinity }); // unpriceable sorts last
  }
  lossy.sort((a, b) =>
    b.margin !== a.margin ? b.margin - a.margin : ux(b.d) - ux(a.d)
  );

  // Primary lottery over the profitable prefix: graduated backends weighted by
  // UX, cold backends by EXPLORE_WEIGHT so they aren't starved out of the
  // primary slot. The remaining profitable backends stay UX-ordered for
  // failover (cold ones, UX 0, fall to the end of the prefix). The lossy suffix
  // is untouched — its ordering and the per-key loss floor are unchanged.
  let profitablePrefix: ModelDeployment[];
  if (profitable.length <= 1) {
    profitablePrefix = profitable;
  } else {
    const weights = profitable.map((d) =>
      lotteryWeight(metrics.get(d.id), ux(d))
    );
    const primaryIdx = weightedRandomIndex(weights);
    const primary = profitable[primaryIdx];
    const rest = profitable
      .filter((_, i) => i !== primaryIdx)
      .sort((a, b) => ux(b) - ux(a));
    profitablePrefix = [primary, ...rest];
  }

  return [...profitablePrefix, ...lossy.map((x) => x.d)];
}

export function rankDeployments(
  deployments: ModelDeployment[],
  metrics: Map<number, DeploymentMetrics>,
  strategy: RoutingStrategy = 'availability'
): ModelDeployment[] {
  if (deployments.length <= 1) return deployments;

  if (strategy === 'profit') return rankProfit(deployments, metrics);

  type Decorated = {
    d: ModelDeployment;
    m: DeploymentMetrics | undefined;
    bucket: DeploymentTier;
    score: number;
    weight: number;
  };

  const decorated: Decorated[] = deployments.map((d) => {
    const m = metrics.get(d.id);
    const uxScore = m?.score ?? 0;
    // Cold deployments (no trustworthy uptime yet, or no metrics at all) join
    // the GOOD primary lottery with a small exploration weight instead of being
    // parked in a lower tier where a healthy incumbent would starve them.
    // Graduated deployments keep their real tier (always one of TIER_ORDER).
    const bucket: DeploymentTier = isCold(m) ? 'GOOD' : m!.tier;
    return {
      d,
      m,
      bucket,
      score: finalScore(d, uxScore),
      weight: d.config?.weight ?? 1,
    };
  });

  const byTier = new Map<DeploymentTier, Decorated[]>();
  for (const item of decorated) {
    const list = byTier.get(item.bucket) ?? [];
    list.push(item);
    byTier.set(item.bucket, list);
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
      // Weighted-random primary over graduated-GOOD (real weight: score, or
      // config.weight when score collapsed to 0) ∪ cold backends (EXPLORE_WEIGHT).
      // When no graduated-GOOD exists the pool is just the cold backends — they
      // become primary above DEGRADED, exactly as the old INSUFFICIENT_DATA tier
      // did. The rest stay weight-ordered for failover (cold, weight 0.05, sink
      // below graduated-GOOD).
      const w = (x: Decorated) =>
        lotteryWeight(x.m, x.score > 0 ? x.score : x.weight);
      const weights = list.map(w);
      const primaryIdx = weightedRandomIndex(weights);
      const primary = list[primaryIdx];
      const rest = list
        .filter((_, i) => i !== primaryIdx)
        .sort((a, b) => w(b) - w(a));
      result.push(primary.d, ...rest.map((x) => x.d));
    } else {
      // DEGRADED / FALLBACK_ONLY — deterministic best-of-the-rest
      list.sort((a, b) => b.score - a.score);
      result.push(...list.map((x) => x.d));
    }
  }

  return result;
}
