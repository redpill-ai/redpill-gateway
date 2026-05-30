import {
  finalScore,
  fullMargin,
  marginScore,
  rankDeployments,
  shouldRejectForProfit,
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
  sellOutput?: string | number | null;
  costOutput?: string | number | null;
};

function dep(id: number, opts: DepOptions = {}): ModelDeployment {
  const {
    weight = 1,
    provider = 'p' + id,
    sellInput,
    costInput,
    sellOutput,
    costOutput,
  } = opts;
  const specs: Record<string, unknown> = {};
  if (sellInput !== undefined) specs.input_cost_per_token = sellInput;
  if (sellOutput !== undefined) specs.output_cost_per_token = sellOutput;
  return {
    id,
    model_id: 1,
    provider_name: provider,
    deployment_name: 'd' + id,
    config: {
      weight,
      ...(costInput !== undefined ? { input_cost_per_token: costInput } : {}),
      ...(costOutput !== undefined
        ? { output_cost_per_token: costOutput }
        : {}),
    },
    active: true,
    created_at: new Date(0),
    updated_at: new Date(0),
    model_slug: 'model-' + id,
    model_specs: Object.keys(specs).length ? specs : undefined,
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
    window: '6h',
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

  it('treats deployments with no metrics as cold (fail-open, all kept)', () => {
    // Empty metrics map → everything is cold → folded into the GOOD primary
    // lottery with EXPLORE_WEIGHT. We don't assert a specific primary (it's
    // random), but the ranked list must contain exactly the same deployments.
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

  it('gives a cold backend a small non-zero primary share, never sinking it below DEGRADED', () => {
    // id 2 has no metrics → cold → joins the GOOD lottery with EXPLORE_WEIGHT.
    // GOOD incumbent (id 1) wins most of the time; cold gets a bounded slice;
    // DEGRADED (id 3) is never primary and is always last.
    const d = [dep(1), dep(2), dep(3)];
    const m = new Map<number, DeploymentMetrics>([
      [1, metric({ tier: 'GOOD', score: 0.9 })],
      [3, metric({ tier: 'DEGRADED', score: 0.5 })],
    ]);

    const tally = new Map<number, number>([
      [1, 0],
      [2, 0],
      [3, 0],
    ]);
    const N = 3000;
    for (let i = 0; i < N; i++) {
      const ranked = rankDeployments(d, m);
      tally.set(ranked[0].id, (tally.get(ranked[0].id) ?? 0) + 1);
      // DEGRADED is always last; the cold backend never sinks below it.
      expect(ranked[2].id).toBe(3);
    }
    // Cold backend gets a bounded, non-zero share of primary (~5-6%).
    expect(tally.get(2)!).toBeGreaterThan(0);
    expect(tally.get(2)! / N).toBeLessThan(0.15);
    // Healthy GOOD incumbent still wins the large majority.
    expect(tally.get(1)!).toBeGreaterThan(tally.get(2)!);
    // DEGRADED never becomes primary while the GOOD/cold pool is non-empty.
    expect(tally.get(3)!).toBe(0);
  });

  it('ignores a cold backend high (lucky) score — only EXPLORE_WEIGHT, no landslide', () => {
    // A cold backend whose few requests all happened to succeed could carry a
    // high score, but uptime=null (below MIN_SAMPLE) means that estimate is not
    // trusted: it gets only EXPLORE_WEIGHT share, never the ~50% a 0.95 score
    // would imply. Guards against routing weighting cold backends by score.
    const d = [dep(1), dep(2)];
    const m = new Map<number, DeploymentMetrics>([
      [1, metric({ tier: 'GOOD', score: 0.85 })],
      [2, metric({ tier: 'INSUFFICIENT_DATA', score: 0.95, uptime: null })],
    ]);
    const tally = new Map<number, number>([
      [1, 0],
      [2, 0],
    ]);
    const N = 3000;
    for (let i = 0; i < N; i++) {
      const ranked = rankDeployments(d, m);
      tally.set(ranked[0].id, (tally.get(ranked[0].id) ?? 0) + 1);
    }
    expect(tally.get(2)!).toBeGreaterThan(0);
    expect(tally.get(2)! / N).toBeLessThan(0.15);
  });

  it('keeps a cold backend primary above DEGRADED when no GOOD exists (preserves prior behavior)', () => {
    const d = [dep(1), dep(2)];
    const m = new Map<number, DeploymentMetrics>([
      [1, metric({ tier: 'DEGRADED', score: 0.6 })],
      // id 2 cold (no metrics) → sole member of the GOOD lottery pool
    ]);
    const ranked = rankDeployments(d, m);
    // Cold is the only GOOD-pool member → primary; DEGRADED follows.
    expect(ranked.map((x) => x.id)).toEqual([2, 1]);
  });

  it('never drops an INSUFFICIENT_DATA-tier deployment, even if its uptime looks set', () => {
    // Defensive: tier and uptime always agree in practice, but routing must not
    // silently drop a deployment if they ever diverge. INSUFFICIENT_DATA is
    // always treated as cold → present in the output, never bucketed into a
    // tier absent from TIER_ORDER.
    const d = [dep(1), dep(2)];
    const m = new Map<number, DeploymentMetrics>([
      [1, metric({ tier: 'GOOD', score: 0.9 })],
      // Inconsistent on purpose: INSUFFICIENT_DATA tier but a non-null uptime.
      [2, metric({ tier: 'INSUFFICIENT_DATA', score: 0.5, uptime: 0.99 })],
    ]);
    const ranked = rankDeployments(d, m);
    expect(new Set(ranked.map((x) => x.id))).toEqual(new Set([1, 2]));
    expect(ranked).toHaveLength(2);
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
    // Large N: the adjacent share gaps (~4pp between profitable/neutral/lossy)
    // need enough trials that the strict ordering assertions don't flake.
    const N = 10000;
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

describe('fullMargin', () => {
  it('combines input + output per-token margin', () => {
    // ((1.21-1.2)+(4.2-4.0)) / (1.2+4.0) = 0.21/5.2 = 0.0404
    expect(
      fullMargin(
        dep(1, {
          sellInput: '1.21e-6',
          sellOutput: '4.2e-6',
          costInput: '1.2e-6',
          costOutput: '4.0e-6',
        })
      )
    ).toBeCloseTo(0.0404, 3);
  });

  it('is negative when sell < cost', () => {
    expect(
      fullMargin(
        dep(1, {
          sellInput: '1.21e-6',
          sellOutput: '4.2e-6',
          costInput: '1.5e-6',
          costOutput: '5.25e-6',
        })
      )
    ).toBeCloseTo(-0.199, 3);
  });

  it('returns null when a price is missing or total cost is 0', () => {
    expect(
      fullMargin(dep(1, { sellInput: '1e-6', costInput: '1e-6' }))
    ).toBeNull();
    expect(
      fullMargin(
        dep(1, {
          sellInput: '1e-6',
          sellOutput: '1e-6',
          costInput: '0',
          costOutput: '0',
        })
      )
    ).toBeNull();
  });
});

describe('shouldRejectForProfit', () => {
  it('serves (no 429) when availability is unknown', () => {
    expect(shouldRejectForProfit(null, 0.7)).toBe(false);
  });
  it('429s when availability has headroom strictly above the floor', () => {
    expect(shouldRejectForProfit(0.9, 0.7)).toBe(true);
  });
  it('serves at/below the floor (rejecting could push below)', () => {
    expect(shouldRejectForProfit(0.7, 0.7)).toBe(false);
    expect(shouldRejectForProfit(0.6, 0.7)).toBe(false);
  });
});

describe('rankDeployments — profit strategy', () => {
  const profitable = {
    sellInput: '1.3e-6',
    sellOutput: '1.3e-6',
    costInput: '1e-6',
    costOutput: '1e-6',
  }; // +30%
  const lossy = {
    sellInput: '1e-6',
    sellOutput: '1e-6',
    costInput: '1.5e-6',
    costOutput: '1.5e-6',
  }; // −33%

  it('ranks profitable backends before loss-making ones (even if lossy has higher UX)', () => {
    const m = new Map<number, DeploymentMetrics>([
      [1, metric({ tier: 'DEGRADED', score: 0.3 })],
      [2, metric({ tier: 'GOOD', score: 0.95 })],
    ]);
    const ranked = rankDeployments(
      [dep(2, lossy), dep(1, profitable)],
      m,
      'profit'
    );
    expect(ranked.map((x) => x.id)).toEqual([1, 2]);
  });

  // Higher absolute margin (cheaper upstream cost) at the same sell price.
  const cheaper = {
    sellInput: '1.3e-6',
    sellOutput: '1.3e-6',
    costInput: '0.5e-6',
    costOutput: '0.5e-6',
  }; // bigger (sell-cost) than `profitable`

  it('ranks graduated profitable by expected profit — higher margin wins at equal uptime, beating higher UX', () => {
    // Both reliable (same uptime). id 2 has the higher absolute margin but the
    // LOWER UX score; id 1 has higher UX but lower margin. Under EV ranking the
    // higher-margin backend is primary — the profit the old UX-only ranking left
    // on the table. (This is the glm near-ai case in miniature.)
    const m = new Map<number, DeploymentMetrics>([
      [1, metric({ tier: 'GOOD', score: 0.9, uptime: 0.98 })],
      [2, metric({ tier: 'GOOD', score: 0.6, uptime: 0.98 })],
    ]);
    const ranked = rankDeployments(
      [dep(1, profitable), dep(2, cheaper)],
      m,
      'profit'
    );
    expect(ranked.map((x) => x.id)).toEqual([2, 1]);
  });

  it('never promotes an unreliable profitable backend to primary (negative EV)', () => {
    // A profitable-but-unreliable graduated backend (id 2, uptime 0.3) has EV ≤ 0
    // and must stay in failover — only the best-EV graduated (id 1) or a cold
    // backend (id 3) may win the primary slot. (This is the gemma near-ai 0.275
    // case: profitable, but too flaky to be primary.)
    const m = new Map<number, DeploymentMetrics>([
      [1, metric({ tier: 'GOOD', score: 0.7, uptime: 0.98 })],
      [2, metric({ tier: 'FALLBACK_ONLY', score: 0.2, uptime: 0.3 })],
      [3, metric({ tier: 'INSUFFICIENT_DATA', score: 0, uptime: null })],
    ]);
    const seenPrimary = new Set<number>();
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const ranked = rankDeployments(
        [dep(1, profitable), dep(2, profitable), dep(3, profitable)],
        m,
        'profit'
      );
      seenPrimary.add(ranked[0].id);
    }
    expect(seenPrimary.has(2)).toBe(false); // mediocre graduated never primary
    expect(seenPrimary.has(1)).toBe(true); // best graduated wins most
    expect(seenPrimary.has(3)).toBe(true); // cold still explores
  });

  it('explores only profitable cold backends, never lossy ones', () => {
    // graduated profitable incumbent + cold profitable + cold lossy.
    const m = new Map<number, DeploymentMetrics>([
      [1, metric({ tier: 'GOOD', score: 0.9 })],
      [2, metric({ tier: 'INSUFFICIENT_DATA', score: 0, uptime: null })],
      [3, metric({ tier: 'INSUFFICIENT_DATA', score: 0, uptime: null })],
    ]);
    const seenPrimary = new Set<number>();
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const ranked = rankDeployments(
        [dep(1, profitable), dep(2, profitable), dep(3, lossy)],
        m,
        'profit'
      );
      seenPrimary.add(ranked[0].id);
      // The lossy backend stays in the suffix (last), never primary.
      expect(ranked[ranked.length - 1].id).toBe(3);
    }
    expect(seenPrimary.has(3)).toBe(false); // lossy cold never explored
    expect(seenPrimary.has(2)).toBe(true); // profitable cold does get explored
    expect(seenPrimary.has(1)).toBe(true);
  });

  it('gives a cold profitable backend a small bounded primary share (~EXPLORE_WEIGHT)', () => {
    // One reliable graduated profitable backend + one cold profitable backend.
    // The cold one explores at ~5% (best normalized to weight 1, cold = 0.05).
    const m = new Map<number, DeploymentMetrics>([
      [1, metric({ tier: 'GOOD', score: 0.9, uptime: 0.98 })],
      [2, metric({ tier: 'INSUFFICIENT_DATA', score: 0, uptime: null })],
    ]);
    const tally = new Map<number, number>([
      [1, 0],
      [2, 0],
    ]);
    const N = 3000;
    for (let i = 0; i < N; i++) {
      const ranked = rankDeployments(
        [dep(1, profitable), dep(2, profitable)],
        m,
        'profit'
      );
      tally.set(ranked[0].id, (tally.get(ranked[0].id) ?? 0) + 1);
    }
    expect(tally.get(2)!).toBeGreaterThan(0);
    expect(tally.get(2)! / N).toBeLessThan(0.12);
    expect(tally.get(1)!).toBeGreaterThan(tally.get(2)!);
  });

  it('picks the least-bad-EV primary when all graduated profitable backends are unreliable (none dropped)', () => {
    // No cold; both profitable but flaky → both EV<0, but the less-flaky one
    // (higher EV) is primary, and both stay in the output.
    const m = new Map<number, DeploymentMetrics>([
      [1, metric({ tier: 'FALLBACK_ONLY', score: 0.2, uptime: 0.3 })],
      [2, metric({ tier: 'FALLBACK_ONLY', score: 0.2, uptime: 0.4 })],
    ]);
    const ranked = rankDeployments(
      [dep(1, profitable), dep(2, profitable)],
      m,
      'profit'
    );
    expect(ranked.map((x) => x.id)).toEqual([2, 1]); // higher uptime → higher EV
    expect(ranked).toHaveLength(2);
  });

  it('default availability strategy is unchanged (GOOD beats DEGRADED despite loss)', () => {
    const m = new Map<number, DeploymentMetrics>([
      [1, metric({ tier: 'GOOD', score: 0.9 })],
      [2, metric({ tier: 'DEGRADED', score: 0.6 })],
    ]);
    const ranked = rankDeployments([dep(1, lossy), dep(2, profitable)], m);
    expect(ranked[0].id).toBe(1);
  });
});
