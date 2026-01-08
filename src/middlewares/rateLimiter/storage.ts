import { getRedisClient, buildCacheKey } from '../../db/redis';
import { RateLimitResult } from './types';

const WINDOW_SIZE_SECONDS = 60;

export async function checkAndIncrementRateLimit(
  userId: number,
  limit: number
): Promise<RateLimitResult> {
  const client = await getRedisClient();
  const now = Math.floor(Date.now() / 1000);
  const currentWindow = Math.floor(now / WINDOW_SIZE_SECONDS);
  const previousWindow = currentWindow - 1;

  const currentKey = buildCacheKey(
    'ratelimit',
    String(userId),
    String(currentWindow)
  );
  const previousKey = buildCacheKey(
    'ratelimit',
    String(userId),
    String(previousWindow)
  );

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
