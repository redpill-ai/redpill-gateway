import { Context } from 'hono';
import {
  findVirtualKeyWithUser,
  VirtualKeyWithUser,
} from '../../db/postgres/virtualKey';
import { type ModelDeployment } from '../../db/postgres/model';
import { ModelService } from '../../services/modelService';
// Metric-driven ordering imports — kept commented during data-collection
// phase. See createVirtualKeyContext below for the matching usage block.
// import {
//   getMetricsForModel,
//   rankDeployments,
// } from '../../services/providerRanking';
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
  allDeployments: ModelDeployment[];
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
  const allDeployments =
    await modelService.getAllModelDeploymentsForModel(modelName);

  if (!allDeployments.length) {
    throw new VirtualKeyValidationError(
      `Model '${modelName}' is not available`,
      404
    );
  }

  // Data-collection phase: uniform random pick so every deployment of a
  // multi-provider model gets a comparable per-request sample. Failover
  // (handlerUtils.tryWithDeploymentFailover) walks deploymentsForCtx in
  // order, so we put the chosen primary first and keep the rest in DB
  // insertion order.
  //
  // To enable metric-driven ordering after observing 24h of data:
  //   1. Uncomment the providerRanking imports above.
  //   2. Replace the block below with:
  //        let rankedDeployments = allDeployments;
  //        if (allDeployments.length > 1) {
  //          const metrics = await getMetricsForModel(modelName);
  //          rankedDeployments = rankDeployments(allDeployments, metrics);
  //        }
  //        const deployment = rankedDeployments[0];
  //        const deploymentsForCtx = rankedDeployments;
  //   3. Start MetricsAggregator in start-server.ts.
  let deployment: ModelDeployment;
  let deploymentsForCtx = allDeployments;
  if (allDeployments.length > 1) {
    const idx = Math.floor(Math.random() * allDeployments.length);
    deployment = allDeployments[idx];
    deploymentsForCtx = [
      deployment,
      ...allDeployments.filter((_, i) => i !== idx),
    ];
  } else {
    deployment = allDeployments[0];
  }

  // Calculate hash for Phala provider requests
  let requestHash: string | undefined;
  if (deployment.provider_name === 'phala' && c.req.method === 'POST') {
    const rawBody = await c.req.text();
    requestHash = hash(rawBody);
  }

  // Sell price for spend_logs: prefer `model.specs.input/output_cost_per_token`
  // (denormalized onto the deployment row via JOIN — single price per model,
  // independent of which provider serves the request). Fall back to the
  // deployment's upstream cost when sell price is absent/null/empty-string,
  // so behavior is unchanged before sell prices are populated.
  // Keep strings as strings — spendQueue wraps in `new Decimal(...)`.
  const sellSpec = (deployment.model_specs ?? {}) as {
    input_cost_per_token?: string | number;
    output_cost_per_token?: string | number;
  };
  const sellIn = sellSpec.input_cost_per_token;
  const sellOut = sellSpec.output_cost_per_token;
  const inputCostPerToken =
    sellIn != null && sellIn !== ''
      ? sellIn
      : deployment.config.input_cost_per_token || 0;
  const outputCostPerToken =
    sellOut != null && sellOut !== ''
      ? sellOut
      : deployment.config.output_cost_per_token || 0;

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
      inputCostPerToken,
      outputCostPerToken,
    },
    requestHash,
    spendMode,
    allDeployments: deploymentsForCtx,
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

    // Stash the requested model so requestLogger can populate request_logs.model
    // even when validation fails before VirtualKeyContext is built (e.g. unknown
    // model, invalid API key).
    c.set('requestedModel', modelName);

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
