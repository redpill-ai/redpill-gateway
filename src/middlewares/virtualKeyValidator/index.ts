import { Context } from 'hono';
import {
  findVirtualKeyWithUser,
  VirtualKeyWithUser,
} from '../../db/postgres/virtualKey';
import { ModelService } from '../../services/modelService';
import { env } from '../../constants';
import { hash } from '../../utils/hash';

/**
 * Determines how spending is tracked for a request:
 * - 'regular': Normal key - update user budget + credits, update key budget
 * - 'subscription': Subscription key within quota - only update key budget_used
 * - 'subscription_overflow': Subscription key over quota - same as regular (update user budget + credits, update key budget)
 */
export type SpendMode = 'regular' | 'subscription' | 'subscription_overflow';

export interface VirtualKeyContext {
  virtualKeyWithUser: VirtualKeyWithUser | null;
  providerConfig: {
    provider: string;
    apiKey: string;
    customHost?: string;
  };
  deploymentName: string;
  modelDeploymentId: number;
  originalModel: string;
  pricing: {
    inputCostPerToken: number;
    outputCostPerToken: number;
  };
  requestHash?: string;
  spendMode: SpendMode;
}

class VirtualKeyValidationError extends Error {
  public readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'VirtualKeyValidationError';
    this.statusCode = statusCode;
  }
}

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

const createVirtualKeyContext = async (
  c: Context,
  modelName: string,
  virtualKeyWithUser: VirtualKeyWithUser | null = null,
  spendMode: SpendMode = 'regular'
): Promise<VirtualKeyContext> => {
  const modelService = new ModelService();
  const deployment = await modelService.getModelDeploymentForModel(modelName, {
    virtualKeyWithUser,
  });

  if (!deployment) {
    throw new VirtualKeyValidationError(
      `Model '${modelName}' is not available`,
      404
    );
  }

  // Calculate hash for Phala provider requests
  let requestHash: string | undefined;
  if (deployment.provider_name === 'phala' && c.req.method === 'POST') {
    const rawBody = await c.req.text();
    requestHash = hash(rawBody);
  }

  return {
    virtualKeyWithUser,
    providerConfig: {
      provider: deployment.provider_name,
      apiKey: deployment.config.api_key,
      customHost: deployment.config.base_url,
    },
    deploymentName: deployment.deployment_name,
    modelDeploymentId: deployment.id,
    originalModel: modelName,
    pricing: {
      inputCostPerToken: deployment.config.input_cost_per_token || 0,
      outputCostPerToken: deployment.config.output_cost_per_token || 0,
    },
    requestHash,
    spendMode,
  };
};

const isPublicEndpoint = (path: string): boolean => {
  return (
    path.startsWith('/v1/attestation/report') ||
    path.startsWith('/v1/signature/')
  );
};

const isModelAllowed = (model: string): boolean => {
  const allowedModels = env.FREE_ALLOWED_MODELS.split(',').map((m) => m.trim());
  return allowedModels.includes(model);
};

const handlePublicEndpoint = async (
  c: Context,
  modelName: string
): Promise<void> => {
  const virtualKeyContext = await createVirtualKeyContext(c, modelName);
  c.set('virtualKeyContext', virtualKeyContext);
};

/**
 * Check if a virtual key is a subscription key (for redpill-chatgpt)
 */
const isSubscriptionKey = (virtualKeyWithUser: VirtualKeyWithUser): boolean => {
  const metadata = virtualKeyWithUser.metadata as { type?: string } | null;
  return metadata?.type === 'subscription';
};

/**
 * Handle subscription key validation with overflow to credits
 */
const handleSubscriptionKey = async (
  c: Context,
  modelName: string,
  virtualKeyWithUser: VirtualKeyWithUser
): Promise<void> => {
  const budgetLimit = virtualKeyWithUser.budget_limit;
  const budgetUsed = virtualKeyWithUser.budget_used;
  const userCredits = virtualKeyWithUser.user.credits;

  // Check if subscription quota is exceeded
  const isQuotaExceeded =
    budgetLimit !== undefined && budgetUsed.gte(budgetLimit);

  if (isQuotaExceeded) {
    // Subscription quota exceeded, check if user has credits
    if (userCredits.lte(0)) {
      throw new VirtualKeyValidationError(
        'Subscription quota exceeded. Please add credits to continue.',
        402
      );
    }
    // Has credits, proceed in overflow mode (deduct credits only)
    const virtualKeyContext = await createVirtualKeyContext(
      c,
      modelName,
      virtualKeyWithUser,
      'subscription_overflow'
    );
    c.set('virtualKeyContext', virtualKeyContext);
  } else {
    // Within subscription quota (update key budget_used only)
    const virtualKeyContext = await createVirtualKeyContext(
      c,
      modelName,
      virtualKeyWithUser,
      'subscription'
    );
    c.set('virtualKeyContext', virtualKeyContext);
  }
};

const handleAuthenticatedUser = async (
  c: Context,
  apiKey: string,
  modelName: string
): Promise<void> => {
  // Find virtual key with user data
  const virtualKeyWithUser = await findVirtualKeyWithUser(apiKey);
  if (!virtualKeyWithUser) {
    throw new VirtualKeyValidationError('Invalid API key provided', 401);
  }

  // Special handling for subscription keys (redpill-chatgpt)
  if (isSubscriptionKey(virtualKeyWithUser)) {
    return handleSubscriptionKey(c, modelName, virtualKeyWithUser);
  }

  // Regular key handling below

  // Check user budget
  if (
    virtualKeyWithUser.user.budget_limit !== undefined &&
    virtualKeyWithUser.user.budget_used.gte(
      virtualKeyWithUser.user.budget_limit
    )
  ) {
    throw new VirtualKeyValidationError(
      'Account quota exceeded. Please add credits to continue.',
      402
    );
  }

  // Check virtual key budget
  if (
    virtualKeyWithUser.budget_limit !== undefined &&
    virtualKeyWithUser.budget_used.gte(virtualKeyWithUser.budget_limit)
  ) {
    throw new VirtualKeyValidationError(
      'API key quota exceeded. Please add credits or increase the key limit.',
      402
    );
  }

  const virtualKeyContext = await createVirtualKeyContext(
    c,
    modelName,
    virtualKeyWithUser,
    'regular'
  );
  c.set('virtualKeyContext', virtualKeyContext);
};

const handleAnonymousUser = async (
  c: Context,
  modelName: string
): Promise<void> => {
  // Check if model is allowed for free usage
  if (!isModelAllowed(modelName)) {
    throw new VirtualKeyValidationError(
      'This model requires an API key. Please add credits to access.',
      403
    );
  }

  // Set virtual key context for anonymous users
  const virtualKeyContext = await createVirtualKeyContext(c, modelName);
  c.set('virtualKeyContext', virtualKeyContext);
};

export const virtualKeyValidator = async (c: Context, next: any) => {
  const requestHeaders = Object.fromEntries(c.req.raw.headers);
  const apiKey = requestHeaders['authorization']?.replace('Bearer ', '');
  const requestPath = new URL(c.req.url).pathname;

  try {
    let modelName = '';
    if (c.req.method === 'POST') {
      const rawBody = await c.req.text();
      const parsedBody = JSON.parse(rawBody);
      modelName = parsedBody?.model ?? '';
    } else {
      modelName = c.req.query('model') || '';
    }

    if (!modelName) {
      throw new VirtualKeyValidationError('Model parameter is required', 400);
    }

    if (isPublicEndpoint(requestPath)) {
      await handlePublicEndpoint(c, modelName);
    } else if (apiKey) {
      await handleAuthenticatedUser(c, apiKey, modelName);
    } else {
      await handleAnonymousUser(c, modelName);
    }
  } catch (error) {
    if (error instanceof VirtualKeyValidationError) {
      return createErrorResponse(error.statusCode, error.message);
    }

    console.error('Virtual key validation error:', error);
    return createErrorResponse(500, 'Service temporarily unavailable');
  }

  return next();
};
