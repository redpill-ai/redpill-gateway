import {
  finalScore,
  marginScore,
  rankDeployments,
} from '../../../../src/services/providerRanking';
import { DeploymentMetrics } from '../../../../src/services/metricsAggregator';
import { ModelDeployment } from '../../../../src/db/postgres/model';

type DepOptions = {
  weight?: number;
  provider?: string;
  // Per-token costs (raw — same shape stored in PG). Pass strings (the
  // common case from JSONB / decimal columns) or numbers.
  sellInput?: string | number | null;
  costInput?: string | number | null;
};

function dep(id: number, opts: DepOptions = {}): ModelDeployment {
  const { weight = 1, provider = 'p' + id, sellInput, costInput } = opts;
  return {
    id,
    model_id: 1,
    provider_name: provider,
    deployment_name: 'd' + id,
    config: {
      weight,
      ...(costInput !== undefined ? { input_cost_per_token: costInput } : {}),
    },
    active: true,
    created_at: new Date(0),
    updated_at: new Date(0),
    model_specs:
      sellInput !== undefined ? { input_cost_per_token: sellInput } : undefined,
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
    const d = [dep(1), dep(2), dep(3)];
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

describe('marginScore', () => {
  it('returns 0.5 (neutral) when sell price is unset', () => {
    // costInput set but sellInput undefined → no margin data → don't penalize
    expect(marginScore(dep(1, { costInput: '0.00000028' }))).toBe(0.5);
  });

  it('returns 0.5 (neutral) when sell price is empty string', () => {
    expect(
      marginScore(dep(1, { sellInput: '', costInput: '0.00000028' }))
    ).toBe(0.5);
  });

  it('returns 0.5 (neutral) when cost is missing', () => {
    expect(marginScore(dep(1, { sellInput: '0.00000028' }))).toBe(0.5);
  });

  it('returns 0.5 (neutral) when cost is 0 (avoid div-by-zero)', () => {
    expect(
      marginScore(dep(1, { sellInput: '0.00000028', costInput: '0' }))
    ).toBe(0.5);
  });

  it('returns 0.5 (neutral) for unparseable values', () => {
    expect(
      marginScore(dep(1, { sellInput: 'abc', costInput: '0.00000028' }))
    ).toBe(0.5);
  });

  it('clamps to 0 when margin is at or below -30% (severe loss)', () => {
    // sell 0.0000007, cost 0.000001 → margin = -30%
    // margin_score = (-0.30 + 0.3) / 0.6 = 0 → clamped 0
    expect(
      marginScore(dep(1, { sellInput: '0.0000007', costInput: '0.000001' }))
    ).toBeCloseTo(0, 5);
  });

  it('returns 0.5 for break-even (margin = 0)', () => {
    expect(
      marginScore(dep(1, { sellInput: '0.000001', costInput: '0.000001' }))
    ).toBeCloseTo(0.5, 5);
  });

  it('clamps to 1 when margin is at or above +30% (high markup)', () => {
    // sell 0.0000013, cost 0.000001 → margin = +30% → clamps to 1
    expect(
      marginScore(dep(1, { sellInput: '0.0000013', costInput: '0.000001' }))
    ).toBeCloseTo(1, 5);
  });

  it('handles numeric (non-string) cost and sell', () => {
    // Same +30% case as above but with number inputs
    expect(
      marginScore(dep(1, { sellInput: 1.3e-6, costInput: 1e-6 }))
    ).toBeCloseTo(1, 5);
  });
});

describe('finalScore', () => {
  it('blends UX (80%) and margin (20%) into a final score', () => {
    // ux=0.5, margin=neutral 0.5 → final = 0.8·0.5 + 0.2·0.5 = 0.5
    expect(finalScore(dep(1), 0.5)).toBeCloseTo(0.5, 5);

    // ux=1.0, margin=neutral 0.5 → final = 0.8 + 0.10 = 0.9
    expect(finalScore(dep(1), 1)).toBeCloseTo(0.9, 5);

    // ux=0, margin=neutral 0.5 → final = 0.10
    expect(finalScore(dep(1), 0)).toBeCloseTo(0.1, 5);
  });

  it('lifts deployments with higher margin when UX is the same', () => {
    // Same UX, different margins. Higher-margin deployment should score higher.
    const profitable = dep(1, {
      sellInput: '0.0000013', // margin +30% → margin_score 1.0
      costInput: '0.000001',
    });
    const lossy = dep(2, {
      sellInput: '0.0000007', // margin -30% → margin_score 0
      costInput: '0.000001',
    });
    const ux = 0.85;

    expect(finalScore(profitable, ux)).toBeGreaterThan(finalScore(lossy, ux));
    // delta = W_MARGIN × (1.0 - 0.0) = 0.20
    expect(finalScore(profitable, ux) - finalScore(lossy, ux)).toBeCloseTo(
      0.2,
      5
    );
  });

  it('lets UX still dominate when UX leader is clear', () => {
    const worseUxBetterMargin = dep(1, {
      sellInput: '0.0000013', // +30% margin → 1.0 margin_score
      costInput: '0.000001',
    });
    const betterUxWorseMargin = dep(2, {
      sellInput: '0.0000007', // -30% margin → 0 margin_score
      costInput: '0.000001',
    });

    // UX gap of 0.4 should beat a max margin swing of 0.2
    // 0.8·0.4 + 0.2·1.0 = 0.32 + 0.20 = 0.52  ← worseUxBetterMargin
    // 0.8·0.8 + 0.2·0.0 = 0.64 + 0.00 = 0.64  ← betterUxWorseMargin
    expect(finalScore(betterUxWorseMargin, 0.8)).toBeGreaterThan(
      finalScore(worseUxBetterMargin, 0.4)
    );
  });
});

describe('rankDeployments with margin signal', () => {
  it('within GOOD tier, margin breaks ties when UX scores are similar', () => {
    // 3 deployments, all GOOD, all with the SAME ux score, but different
    // margins. After 1000 random draws, the highest-margin deployment should
    // win the primary slot more often than the lowest-margin one.
    const profitable = dep(1, {
      sellInput: '0.0000013',
      costInput: '0.000001',
    });
    const neutral = dep(2, {
      sellInput: '0.000001',
      costInput: '0.000001',
    });
    const lossy = dep(3, {
      sellInput: '0.0000007',
      costInput: '0.000001',
    });

    const ux = 0.85;
    const m = new Map<number, DeploymentMetrics>([
      [1, metric({ tier: 'GOOD', score: ux })],
      [2, metric({ tier: 'GOOD', score: ux })],
      [3, metric({ tier: 'GOOD', score: ux })],
    ]);

    const tally = new Map<number, number>([
      [1, 0],
      [2, 0],
      [3, 0],
    ]);
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const ranked = rankDeployments([profitable, neutral, lossy], m);
      tally.set(ranked[0].id, (tally.get(ranked[0].id) ?? 0) + 1);
    }

    // Proportional to final_score:
    //   profitable: 0.8·0.85 + 0.2·1.0 = 0.880
    //   neutral:    0.8·0.85 + 0.2·0.5 = 0.780
    //   lossy:      0.8·0.85 + 0.2·0.0 = 0.680
    // Total = 2.340. Expected shares ≈ 37.6% / 33.3% / 29.1%.
    // Assert ordering with comfortable margin so flakes don't bite.
    expect(tally.get(1)!).toBeGreaterThan(tally.get(2)!);
    expect(tally.get(2)!).toBeGreaterThan(tally.get(3)!);
  });

  it('still keeps lossy deployment in failover chain (no hard gate)', () => {
    // Even with a deeply-negative margin, a deployment that ranks well on UX
    // should still appear in the ranked output — there's no eligibility filter.
    const d = [
      dep(1, { sellInput: '0.0000013', costInput: '0.000001' }), // +30%
      dep(2, { sellInput: '0.0000003', costInput: '0.000001' }), // -70% (clamped 0)
    ];
    const m = new Map<number, DeploymentMetrics>([
      [1, metric({ tier: 'GOOD', score: 0.5 })],
      [2, metric({ tier: 'GOOD', score: 0.9 })],
    ]);

    const ranked = rankDeployments(d, m);
    // The output must contain both deployments (no hard exclusion).
    expect(new Set(ranked.map((x) => x.id))).toEqual(new Set([1, 2]));
    expect(ranked).toHaveLength(2);
  });
});
