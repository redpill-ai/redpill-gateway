import { Context } from 'hono';
import { VirtualKeyContext } from '../virtualKeyValidator';
import { checkAndIncrementRateLimit } from './storage';
import { env } from '../../constants';

const ENTERPRISE_TIER = 'ENTERPRISE';

function createRateLimitResponse(limit: number, resetAt: number): Response {
  const retryAfter = Math.max(1, resetAt - Math.floor(Date.now() / 1000));

  return new Response(
    JSON.stringify({
      error: {
        message: 'Rate limit exceeded. Please retry after the reset time.',
        type: 'rate_limit_error',
        code: 'rate_limit_exceeded',
      },
    }),
    {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'X-RateLimit-Limit': String(limit),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(resetAt),
        'Retry-After': String(retryAfter),
      },
    }
  );
}

export const rateLimiter = async (c: Context, next: () => Promise<void>) => {
  const virtualKeyContext: VirtualKeyContext | undefined =
    c.get('virtualKeyContext');

  // Skip unauthenticated requests (anonymous users handled elsewhere)
  if (!virtualKeyContext?.virtualKeyWithUser) {
    return next();
  }

  const { virtualKeyWithUser } = virtualKeyContext;
  const { user } = virtualKeyWithUser;

  // Skip rate limiting for enterprise users
  if (user.user_tier === ENTERPRISE_TIER) {
    return next();
  }

  // Determine rate limit (user level > default)
  const rpmLimit = user.rate_limit_rpm ?? env.DEFAULT_RATE_LIMIT_RPM;

  try {
    // Check rate limit by user ID
    const result = await checkAndIncrementRateLimit(user.id, rpmLimit);

    // Add rate limit headers
    c.header('X-RateLimit-Limit', String(result.limit));
    c.header('X-RateLimit-Remaining', String(result.remaining));
    c.header('X-RateLimit-Reset', String(result.resetAt));

    if (!result.allowed) {
      return createRateLimitResponse(result.limit, result.resetAt);
    }
  } catch (error) {
    // Graceful degradation: allow request if Redis fails
    console.warn('[RATE_LIMITER] Redis error, allowing request:', error);
  }

  return next();
};
