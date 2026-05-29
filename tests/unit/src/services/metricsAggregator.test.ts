import {
  buildDeploymentMetrics,
  computeScore,
  metricsKey,
  tierFromUptime,
} from '../../../../src/services/metricsAggregator';

// Full AggRow with neutral defaults (ideal latency/ttft/tps so tier is driven
// by uptime). Override sample/uptime fields per test.
function aggRow(over: Record<string, number | string>) {
  return {
    model: 'm',
    deployment_id: 1,
    provider: 'p',
    total_6h: 0,
    success_6h: 0,
    uptime_den_6h: 0,
    p50_latency_6h: 5000,
    p95_latency_6h: 5000,
    p50_ttft_6h: 500,
    avg_tps_6h: 50,
    total_24h: 0,
    success_24h: 0,
    uptime_den_24h: 0,
    p50_latency_24h: 5000,
    p95_latency_24h: 5000,
    p50_ttft_24h: 500,
    avg_tps_24h: 50,
    ...over,
  } as any;
}

describe('tierFromUptime', () => {
  it('returns INSUFFICIENT_DATA when sample below 100', () => {
    expect(tierFromUptime(1.0, 99)).toBe('INSUFFICIENT_DATA');
    expect(tierFromUptime(0.95, 50)).toBe('INSUFFICIENT_DATA');
  });

  it('returns INSUFFICIENT_DATA when uptime is null regardless of sample', () => {
    expect(tierFromUptime(null, 10_000)).toBe('INSUFFICIENT_DATA');
  });

  it('returns GOOD at the 0.95 boundary', () => {
    expect(tierFromUptime(0.95, 1000)).toBe('GOOD');
    expect(tierFromUptime(0.9499, 1000)).toBe('DEGRADED');
  });

  it('returns DEGRADED at the 0.80 boundary', () => {
    expect(tierFromUptime(0.8, 1000)).toBe('DEGRADED');
    expect(tierFromUptime(0.7999, 1000)).toBe('FALLBACK_ONLY');
  });

  it('returns GOOD for excellent uptime', () => {
    expect(tierFromUptime(0.999, 1000)).toBe('GOOD');
  });
});

describe('computeScore', () => {
  it('returns 0 when uptime is null', () => {
    expect(computeScore(null, 1000, 500, 50)).toBe(0);
  });

  it('returns max score for ideal metrics (within all BEST thresholds)', () => {
    // uptime=1, p50_latency=5000 (LATENCY_BEST), p50_ttft=500 (TTFT_BEST),
    // tps=50 (TPS_TARGET) → all 4 dims should be 1 → final = 1
    expect(computeScore(1, 5000, 500, 50)).toBeCloseTo(1, 5);
  });

  it('returns 0 for worst latency and ttft, 0 tps, with 0 uptime', () => {
    expect(computeScore(0, 30000, 5000, 0)).toBe(0);
  });

  it('saturates at 1 for metrics better than BEST thresholds', () => {
    // p50_latency=1000 (faster than 5000), p50_ttft=200 (faster than 500),
    // tps=200 (above 50) → all clamped to 1 → uptime is the only signal
    expect(computeScore(1, 1000, 200, 200)).toBeCloseTo(1, 5);
  });

  it('clamps at 0 for metrics worse than WORST thresholds', () => {
    // p50_latency=60000 (worse than 30000), p50_ttft=10000 (worse than 5000),
    // tps=-10 → all clamped to 0 → only uptime contributes
    // uptime=0.5 × W_UPTIME(0.30) = 0.15
    expect(computeScore(0.5, 60000, 10000, -10)).toBeCloseTo(0.15, 5);
  });

  it('mixes 4 dimensions with W_UPTIME=0.30 W_TTFT=0.25 W_LATENCY=0.25 W_TPS=0.20', () => {
    // GLM 5.1 chutes: uptime 0.993, p50_lat 8995, p50_ttft 2046, tps 46.17
    // ttft_score = 1 - (2046-500)/4500 = 0.6564
    // lat_score  = 1 - (8995-5000)/25000 = 0.8402
    // tps_score  = 46.17/50 = 0.9234
    // score = 0.30·0.993 + 0.25·0.6564 + 0.25·0.8402 + 0.20·0.9234
    //       = 0.2979 + 0.1641 + 0.2101 + 0.1847
    //       = 0.8568
    expect(computeScore(0.993, 8995, 2046, 46.17)).toBeCloseTo(0.8568, 3);
  });
});

describe('buildDeploymentMetrics (adaptive window)', () => {
  it('uses the 6h window when it has >= MIN_SAMPLE (ignores 24h)', () => {
    const m = buildDeploymentMetrics(
      aggRow({
        uptime_den_6h: 200,
        success_6h: 198,
        total_6h: 210,
        uptime_den_24h: 5000, // 24h would say 50% — must be ignored
        success_24h: 2500,
        total_24h: 5200,
      }),
      0
    );
    expect(m.window).toBe('6h');
    expect(m.uptime).toBeCloseTo(0.99, 5);
    expect(m.tier).toBe('GOOD');
    expect(m.sample).toBe(210);
  });

  it('falls back to 24h when 6h is under MIN_SAMPLE — escapes INSUFFICIENT_DATA', () => {
    const m = buildDeploymentMetrics(
      aggRow({
        uptime_den_6h: 20,
        success_6h: 19,
        total_6h: 22,
        uptime_den_24h: 150, // >= 100 → classify on 24h
        success_24h: 120, // 80% → DEGRADED
        total_24h: 160,
      }),
      0
    );
    expect(m.window).toBe('24h');
    expect(m.tier).toBe('DEGRADED');
    expect(m.uptime).toBeCloseTo(0.8, 5);
    expect(m.sample).toBe(160);
  });

  it('stays INSUFFICIENT_DATA when neither window reaches MIN_SAMPLE', () => {
    const m = buildDeploymentMetrics(
      aggRow({
        uptime_den_6h: 10,
        total_6h: 12,
        uptime_den_24h: 40,
        total_24h: 45,
      }),
      0
    );
    expect(m.window).toBe('24h');
    expect(m.tier).toBe('INSUFFICIENT_DATA');
    expect(m.uptime).toBeNull();
  });
});

describe('metricsKey', () => {
  it('uses the window-agnostic routing namespace', () => {
    // Bare assertion on contents — the exact buildCacheKey separator is an
    // implementation detail. The namespace must not bake in a window since
    // metrics may be 6h or 24h per deployment.
    const key = metricsKey('phala/glm-5.1');
    expect(key).toContain('routing');
    expect(key).toContain('phala/glm-5.1');
    expect(key).not.toContain('6h');
    expect(key).not.toContain('24h');
  });
});
