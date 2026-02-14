import {
  getRedisClient,
  buildCacheKey,
  getCache,
  setCache,
} from '../../db/redis';
import { queryPostgres } from '../../db/postgres/connection';
import { RateLimitResult, ModelRateLimitConfig } from './types';

const WINDOW_SIZE_SECONDS = 60;
const MODEL_RATELIMIT_CONFIG_TTL = 7200; // Cache config for 2 hours, invalidated via API

async function slidingWindowCheck(
  keyPrefix: string,
  id: string,
  limit: number
): Promise<RateLimitResult> {
  const client = await getRedisClient();
  const now = Math.floor(Date.now() / 1000);
  const currentWindow = Math.floor(now / WINDOW_SIZE_SECONDS);
  const previousWindow = currentWindow - 1;

  const currentKey = buildCacheKey(keyPrefix, id, String(currentWindow));
  const previousKey = buildCacheKey(keyPrefix, id, String(previousWindow));

  // Single Redis round-trip: get previous count, increment current, set TTL
  const results = await client
    .multi()
    .get(previousKey)
    .incr(currentKey)
    .expire(currentKey, WINDOW_SIZE_SECONDS * 2)
    .exec();

  const prevCount = Number(results?.[0]) || 0;
  const currCount = Number(results?.[1]) || 0; // Already incremented

  // Calculate weighted count (sliding window approximation)
  const windowProgress = (now % WINDOW_SIZE_SECONDS) / WINDOW_SIZE_SECONDS;
  const estimatedCount = Math.floor(
    prevCount * (1 - windowProgress) + currCount
  );

  // Use <= because currCount already includes this request
  const allowed = estimatedCount <= limit;
  const resetAt = (currentWindow + 1) * WINDOW_SIZE_SECONDS;

  if (!allowed) {
    // Rollback: decrement the counter we just incremented
    await client.decr(currentKey);
  }

  const remaining = allowed ? Math.max(0, limit - estimatedCount) : 0;

  return { allowed, remaining, resetAt, limit };
}

export async function checkAndIncrementRateLimit(
  userId: number,
  limit: number
): Promise<RateLimitResult> {
  return slidingWindowCheck('ratelimit', String(userId), limit);
}

export async function getModelRateLimitConfig(
  userId: number
): Promise<ModelRateLimitConfig | null> {
  const cacheKey = buildCacheKey('model_ratelimit_config', String(userId));

  // Try Redis cache first
  const cached = await getCache(cacheKey);
  if (cached !== null) {
    return cached as ModelRateLimitConfig;
  }

  // Query DB
  const rows = await queryPostgres<{
    model_id: number;
    rate_limit_rpm: number;
  }>(
    'SELECT model_id, rate_limit_rpm FROM user_model_rate_limits WHERE user_id = $1',
    [userId]
  );

  if (rows.length === 0) {
    // Cache empty result to avoid repeated DB queries
    await setCache(cacheKey, {}, MODEL_RATELIMIT_CONFIG_TTL);
    return null;
  }

  const config: ModelRateLimitConfig = {};
  for (const row of rows) {
    config[String(row.model_id)] = { rpm: row.rate_limit_rpm };
  }

  await setCache(cacheKey, config, MODEL_RATELIMIT_CONFIG_TTL);
  return config;
}

export async function checkAndIncrementModelRateLimit(
  userId: number,
  modelDbId: number,
  limit: number
): Promise<RateLimitResult> {
  return slidingWindowCheck('model_ratelimit', `${userId}:${modelDbId}`, limit);
}
