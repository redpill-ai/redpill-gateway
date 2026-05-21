import { rankDeployments } from '../../../../src/services/providerRanking';
import { DeploymentMetrics } from '../../../../src/services/metricsAggregator';
import { ModelDeployment } from '../../../../src/db/postgres/model';

function dep(id: number, weight = 1, provider = 'p' + id): ModelDeployment {
  return {
    id,
    model_id: 1,
    provider_name: provider,
    deployment_name: 'd' + id,
    config: { weight },
    active: true,
    created_at: new Date(0),
    updated_at: new Date(0),
  };
}

function metric(
  partial: Partial<DeploymentMetrics> &
    Pick<DeploymentMetrics, 'tier' | 'score'>
): DeploymentMetrics {
  return {
    uptime: 1,
    p50_latency_ms: 0,
    p95_latency_ms: 0,
    p50_ttft_ms: 0,
    avg_tps: 0,
    sample: 1000,
    provider: 'unknown',
    computed_at: 0,
    ...partial,
  };
}

describe('rankDeployments', () => {
  it('returns the list as-is for a single deployment', () => {
    const d = [dep(1)];
    expect(rankDeployments(d, new Map())).toEqual(d);
  });

  it('treats deployments with no metrics as INSUFFICIENT_DATA (fail-open)', () => {
    // Empty metrics map → everything is INSUFFICIENT_DATA → weighted random by
    // config.weight. We don't assert a specific primary (it's random), but the
    // ranked list must contain exactly the same deployments.
    const d = [dep(1, 1), dep(2, 1), dep(3, 1)];
    const ranked = rankDeployments(d, new Map());
    expect(new Set(ranked.map((x) => x.id))).toEqual(new Set([1, 2, 3]));
    expect(ranked).toHaveLength(3);
  });

  it('puts GOOD-tier deployments ahead of DEGRADED and FALLBACK_ONLY', () => {
    const d = [
      dep(1), // FALLBACK_ONLY
      dep(2), // GOOD
      dep(3), // DEGRADED
      dep(4), // GOOD
    ];
    const m = new Map<number, DeploymentMetrics>([
      [1, metric({ tier: 'FALLBACK_ONLY', score: 0.4 })],
      [2, metric({ tier: 'GOOD', score: 0.9 })],
      [3, metric({ tier: 'DEGRADED', score: 0.6 })],
      [4, metric({ tier: 'GOOD', score: 0.85 })],
    ]);

    const ranked = rankDeployments(d, m);
    const ids = ranked.map((x) => x.id);

    // First two slots are the two GOOD deployments (order between them may
    // vary due to weighted-random primary pick).
    expect(new Set(ids.slice(0, 2))).toEqual(new Set([2, 4]));
    // Then the DEGRADED one.
    expect(ids[2]).toBe(3);
    // FALLBACK_ONLY last.
    expect(ids[3]).toBe(1);
  });

  it('places INSUFFICIENT_DATA between GOOD and DEGRADED (new providers get traffic to learn)', () => {
    const d = [dep(1), dep(2), dep(3)];
    const m = new Map<number, DeploymentMetrics>([
      [1, metric({ tier: 'GOOD', score: 0.9 })],
      // id 2 has no metrics → INSUFFICIENT_DATA via default
      [3, metric({ tier: 'DEGRADED', score: 0.5 })],
    ]);

    const ranked = rankDeployments(d, m);
    const ids = ranked.map((x) => x.id);
    expect(ids).toEqual([1, 2, 3]);
  });

  it('orders DEGRADED/FALLBACK_ONLY deterministically by descending score', () => {
    const d = [dep(1), dep(2), dep(3)];
    const m = new Map<number, DeploymentMetrics>([
      [1, metric({ tier: 'DEGRADED', score: 0.3 })],
      [2, metric({ tier: 'DEGRADED', score: 0.7 })],
      [3, metric({ tier: 'DEGRADED', score: 0.5 })],
    ]);
    const ranked = rankDeployments(d, m);
    expect(ranked.map((x) => x.id)).toEqual([2, 3, 1]);
  });

  it('ranks all GOOD deployments before any non-GOOD even with low GOOD scores', () => {
    const d = [dep(1), dep(2)];
    const m = new Map<number, DeploymentMetrics>([
      // GOOD by uptime but very low composite score (e.g. very high latency)
      [1, metric({ tier: 'GOOD', score: 0.01 })],
      // DEGRADED but higher score number
      [2, metric({ tier: 'DEGRADED', score: 0.6 })],
    ]);
    const ranked = rankDeployments(d, m);
    expect(ranked.map((x) => x.id)).toEqual([1, 2]);
  });
});
