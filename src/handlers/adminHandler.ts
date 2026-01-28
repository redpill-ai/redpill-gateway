/**
 * Admin Handler
 *
 * Handles admin operations like cache refresh.
 * Requires virtual key with admin role in metadata.
 */

import { Context } from 'hono';
import { findVirtualKeyWithUser } from '../db/postgres/virtualKey';
import { ModelService } from '../services/modelService';

const createErrorResponse = (status: number, message: string) => {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type: 'error',
      },
    }),
    {
      status,
      headers: {
        'content-type': 'application/json',
      },
    }
  );
};

/**
 * Validates that the request has an admin API key.
 * Admin keys have metadata.role = "admin" in the virtual_keys table.
 */
async function validateAdminKey(
  c: Context
): Promise<
  { valid: true } | { valid: false; status: number; message: string }
> {
  const apiKey = c.req.header('X-API-Key');

  if (!apiKey) {
    return { valid: false, status: 401, message: 'API key required' };
  }

  const virtualKeyWithUser = await findVirtualKeyWithUser(apiKey);

  if (!virtualKeyWithUser) {
    return { valid: false, status: 401, message: 'Invalid API key' };
  }

  const metadata = virtualKeyWithUser.metadata as { role?: string } | null;
  if (metadata?.role !== 'admin') {
    return { valid: false, status: 403, message: 'Admin access required' };
  }

  return { valid: true };
}

/**
 * POST /admin/cache/refresh
 *
 * Refreshes all model caches in Redis.
 * Requires X-API-Key header with an admin virtual key.
 *
 * Response:
 * {
 *   "success": true,
 *   "cleared": ["models:*", "model-deployment:*", "embedding-models:*"]
 * }
 */
export const cacheRefreshHandler = async (c: Context) => {
  const auth = await validateAdminKey(c);
  if (!auth.valid) {
    return createErrorResponse(auth.status, auth.message);
  }

  try {
    const modelService = new ModelService();
    await modelService.clearCache();

    return c.json({
      success: true,
      cleared: ['models:*', 'model-deployment:*', 'embedding-models:*'],
    });
  } catch (error) {
    console.error('Cache refresh error:', error);
    return createErrorResponse(500, 'Failed to refresh cache');
  }
};
