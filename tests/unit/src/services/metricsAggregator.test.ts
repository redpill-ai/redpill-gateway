import {
  computeScore,
  metricsKey,
  tierFromUptime,
} from '../../../../src/services/metricsAggregator';

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

describe('metricsKey', () => {
  it('uses the 6h window namespace', () => {
    // Bare assertion on contents — the exact buildCacheKey separator is an
    // implementation detail.
    const key = metricsKey('phala/glm-5.1');
    expect(key).toContain('6h');
    expect(key).toContain('phala/glm-5.1');
    expect(key).not.toContain('24h');
  });
});
