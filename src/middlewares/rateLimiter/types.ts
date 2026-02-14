export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number; // Unix timestamp (seconds)
  limit: number;
}

// Per-model rate limit config cached from DB
// Key is model DB integer ID (string), value is the RPM limit
export interface ModelRateLimitConfig {
  [modelDbId: string]: { rpm: number };
}
