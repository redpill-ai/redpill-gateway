import { Context } from 'hono';
import { VirtualKeyContext } from '../virtualKeyValidator';
import {
  checkAndIncrementRateLimit,
  getModelRateLimitConfig,
  checkAndIncrementModelRateLimit,
} from './storage';
import { env } from '../../constants';

const ENTERPRISE_TIER = 'ENTERPRISE';

function createRateLimitResponse(
  limit: number,
  resetAt: number,
  message = 'Rate limit exceeded. Please retry after the reset time.'
): Response {
  const retryAfter = Math.max(1, resetAt - Math.floor(Date.now() / 1000));

  return new Response(
    JSON.stringify({
      error: {
        message,
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
    // 1. Global user-level rate limit check
    const result = await checkAndIncrementRateLimit(user.id, rpmLimit);

    c.header('X-RateLimit-Limit', String(result.limit));
    c.header('X-RateLimit-Remaining', String(result.remaining));
    c.header('X-RateLimit-Reset', String(result.resetAt));

    if (!result.allowed) {
      return createRateLimitResponse(result.limit, result.resetAt);
    }

    // 2. Per-model rate limit check
    const modelDbId = virtualKeyContext.allDeployments[0]?.model_id;
    if (modelDbId) {
      const modelConfig = await getModelRateLimitConfig(user.id);
      const modelLimit = modelConfig?.[String(modelDbId)];

      if (modelLimit) {
        const modelResult = await checkAndIncrementModelRateLimit(
          user.id,
          modelDbId,
          modelLimit.rpm
        );

        c.header('X-RateLimit-Model-Limit', String(modelResult.limit));
        c.header('X-RateLimit-Model-Remaining', String(modelResult.remaining));
        c.header('X-RateLimit-Model-Reset', String(modelResult.resetAt));

        if (!modelResult.allowed) {
          return createRateLimitResponse(
            modelResult.limit,
            modelResult.resetAt,
            'Model-specific rate limit exceeded. Please retry after the reset time.'
          );
        }
      }
    }
  } catch (error) {
    // Graceful degradation: allow request if Redis fails
    console.warn('[RATE_LIMITER] Redis error, allowing request:', error);
  }

  return next();
};
