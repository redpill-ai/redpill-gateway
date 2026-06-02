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
import { E2EE_PROVIDER_NAMES } from '../globals';
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

export type RoutingStrategy = 'availability' | 'profit' | 'e2ee';

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
 * Absolute per-request margin — the money kept on a successful request, in
 * per-token price units: (sellIn - costIn) + (sellOut - costOut). Sell price is
 * the same across a model's backends, so this both gates profit eligibility
 * (m >= PROFIT_MIN_MARGIN) and ranks backends by how much profit each one keeps.
 * Returns null only when a price is missing/unparseable (unpriceable) — callers
 * treat null as not profit-eligible (don't route profit traffic to a backend we
 * can't price).
 *
 * Absolute, not a margin *ratio*: the ratio divides by cost, so a genuinely
 * zero-cost backend (self-hosted, marginal cost ~0 — the MOST profitable case)
 * would hit a div-by-zero and be misclassified as unpriceable → routed last.
 * The absolute margin has no such singularity: cost 0 simply yields margin =
 * sell, the model's highest, so a free backend correctly wins the primary slot.
 *
 * Assumes a balanced input/output token mix (T_in = T_out = 1). Token-weighting
 * is a deliberate non-goal here: it would only change the ranking for a backend
 * that is cheaper on input but pricier on output than a rival — real backends
 * are almost always cheaper (or pricier) on both, where the mix is irrelevant.
 */
export function absMargin(d: ModelDeployment): number | null {
  const specs = (d.model_specs ?? {}) as Record<string, unknown>;
  const config = (d.config ?? {}) as Record<string, unknown>;
  const sellIn = toNum(specs.input_cost_per_token);
  const sellOut = toNum(specs.output_cost_per_token);
  const costIn = toNum(config.input_cost_per_token);
  const costOut = toNum(config.output_cost_per_token);
  if (sellIn == null || sellOut == null || costIn == null || costOut == null) {
    return null;
  }
  return sellIn - costIn + (sellOut - costOut);
}

// Failure-penalty strength for expected-profit ranking. A failed primary
// attempt is priced at BETA × the model's best achievable margin M, so a
// graduated backend at the margin frontier (m = M) is primary-eligible (EV ≥ 0)
// only when uptime ≥ BETA/(1+BETA): BETA=3 ⇒ ≥0.75, aligned with the 0.7 loss
// floor. Lower BETA chases margin harder; higher BETA demands more reliability.
// Single global knob, scale-free across models (penalty normalized by M).
const BETA = 3;

// Expected realized profit of routing to a backend with success prob p and
// absolute margin m, given the model's best graduated margin M. Revenue is
// recovered by failover, so reliability enters only through the failed-attempt
// penalty (1 − p)·BETA·M (wasted latency/capacity), not as a separate score.
function expectedValue(m: number, p: number, M: number): number {
  return p * m - (1 - p) * BETA * M;
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
 * first, ranked by EXPECTED PROFIT (EV = p·margin − (1−p)·BETA·M) so the most
 * profitable backend that is reliable enough wins primary; loss-making /
 * unpriceable backends last, least-loss first. The failover loop tries the
 * profitable prefix normally and only crosses into the loss suffix under the
 * per-key availability floor (else 429) — see tryWithDeploymentFailover.
 */
function rankProfit(
  deployments: ModelDeployment[],
  metrics: Map<number, DeploymentMetrics>
): ModelDeployment[] {
  const profitable: ModelDeployment[] = [];
  const lossy: { d: ModelDeployment; margin: number }[] = [];
  for (const d of deployments) {
    const m = absMargin(d);
    if (m != null && m >= PROFIT_MIN_MARGIN) profitable.push(d);
    else lossy.push({ d, margin: m ?? -Infinity }); // unpriceable sorts last
  }
  const ux = (d: ModelDeployment) => metrics.get(d.id)?.score ?? 0;
  lossy.sort((a, b) =>
    b.margin !== a.margin ? b.margin - a.margin : ux(b.d) - ux(a.d)
  );

  // Within the profitable prefix, rank by EXPECTED PROFIT, not reliability: a
  // reliable high-margin backend now wins primary (the margin profit the old
  // UX-only ranking left on the table), while an unreliable-but-profitable
  // backend (EV ≤ 0) is kept out of primary whenever a higher-EV graduated or a
  // cold backend can take the slot — only when every graduated backend is
  // unreliable (all EV ≤ 0) and there is no cold explorer does the least-bad EV
  // become primary, since traffic must still go somewhere. Primary = argmax EV
  // (concentrate on the most profitable backend; its 429 overflow fails over to
  // the next). Cold profitable backends still get a small EXPLORE_WEIGHT shot at
  // primary so they accumulate samples. The lossy suffix and loss floor are
  // untouched.
  const graduated = profitable.filter((d) => !isCold(metrics.get(d.id)));
  const cold = profitable.filter((d) => isCold(metrics.get(d.id)));

  const M = graduated.reduce((mx, d) => Math.max(mx, absMargin(d) ?? 0), 0);
  const ev = (d: ModelDeployment) =>
    expectedValue(absMargin(d) ?? 0, metrics.get(d.id)!.uptime!, M);
  graduated.sort((a, b) => ev(b) - ev(a));

  let profitablePrefix: ModelDeployment[];
  if (cold.length === 0) {
    profitablePrefix = graduated; // primary = highest-EV, deterministic
  } else {
    const best = graduated[0]; // undefined when every profitable backend is cold
    const contenders = best ? [best, ...cold] : cold;
    // best normalized to weight 1: EV is in money units, so mixing raw EV with
    // the 0.05 explore weight would be unit-inconsistent. Each cold backend ~5%.
    const weights = contenders.map((d) => (d === best ? 1 : EXPLORE_WEIGHT));
    const primary = contenders[weightedRandomIndex(weights)];
    const rest = [...graduated, ...cold].filter((d) => d !== primary);
    profitablePrefix = [primary, ...rest];
  }

  return [...profitablePrefix, ...lossy.map((x) => x.d)];
}

// Health-first ranking (the default `availability` strategy). Operates on any
// list length, including 0/1 — callers (rankDeployments, rankE2ee) may pass a
// single-element or empty sub-list, so this must NOT early-return.
function rankAvailability(
  deployments: ModelDeployment[],
  metrics: Map<number, DeploymentMetrics>
): ModelDeployment[] {
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

const isE2eeProvider = (d: ModelDeployment): boolean =>
  (E2EE_PROVIDER_NAMES as readonly string[]).includes(d.provider_name);

/**
 * e2ee strategy — soft preference for our confidential / end-to-end-encrypted
 * upstreams (near-ai / phala). The e2ee backends rank first (each partition
 * ordered health-first via rankAvailability); when a model has no e2ee backend
 * the list degrades to plain availability over the rest, i.e. it FALLS BACK to
 * other providers rather than failing. Mirrors rankProfit's preferred-prefix /
 * fallback-suffix shape, so the handlerUtils failover loop naturally exhausts
 * every e2ee backend before touching a non-e2ee one.
 */
function rankE2ee(
  deployments: ModelDeployment[],
  metrics: Map<number, DeploymentMetrics>
): ModelDeployment[] {
  const e2ee = deployments.filter(isE2eeProvider);
  const rest = deployments.filter((d) => !isE2eeProvider(d));
  return [
    ...rankAvailability(e2ee, metrics),
    ...rankAvailability(rest, metrics),
  ];
}

export function rankDeployments(
  deployments: ModelDeployment[],
  metrics: Map<number, DeploymentMetrics>,
  strategy: RoutingStrategy = 'availability'
): ModelDeployment[] {
  if (deployments.length <= 1) return deployments;
  if (strategy === 'profit') return rankProfit(deployments, metrics);
  if (strategy === 'e2ee') return rankE2ee(deployments, metrics);
  return rankAvailability(deployments, metrics);
}
