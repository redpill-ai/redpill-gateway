import { Context } from 'hono';
import {
  findVirtualKeyWithUser,
  VirtualKeyWithUser,
} from '../../db/postgres/virtualKey';
import { type ModelDeployment } from '../../db/postgres/model';
import { ModelService } from '../../services/modelService';
import {
  getMetricsForModel,
  rankDeployments,
  type RoutingStrategy,
} from '../../services/providerRanking';
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
  // Canonical `models.model_id` of the resolved model. Used as the analytic /
  // billing / routing key — request_logs.model, spend_logs.model, and
  // metricsAggregator Redis keys all use this, not the client's raw string.
  modelId: string;
  // Raw model string the client put in the HTTP request body (alias or
  // canonical, whatever they typed). Preserved for debug, customer support,
  // and deprecation tracking ("who is still calling this old alias?").
  // Written to request_logs.request_model / spend_logs.request_model.
  requestModel: string;
  pricing: {
    inputCostPerToken: number | string;
    outputCostPerToken: number | string;
    // Per-token sell price for prompt-cache reads / writes. `null` means
    // the model doesn't advertise cache-tier pricing — cache tokens fall
    // back to the regular input rate in computeCost (i.e. customer is
    // charged as if cache hadn't been hit).
    cacheReadCostPerToken: number | string | null;
    cacheCreationCostPerToken: number | string | null;
  };
  requestHash?: string;
  spendMode: SpendMode;
  allDeployments: ModelDeployment[];
  // Per-key routing strategy from virtual_keys.metadata.routing_strategy.
  // 'availability' (default) = health-first ranking; 'profit' = margin-first
  // with a loss-boundary availability floor (see tryWithDeploymentFailover);
  // 'e2ee' = serve only confidential upstreams (near-ai / phala) when the model
  // has any (non-e2ee backends dropped, no fallover even if all e2ee backends
  // fail); fall back to other providers only when it has no e2ee backend at all.
  routingStrategy: RoutingStrategy;
}

// Reads the per-key routing strategy from metadata. Only the literal 'profit'
// and 'e2ee' are recognized; anything else (absent / anonymous / typo) →
// 'availability', so existing keys keep current behavior.
const parseRoutingStrategy = (
  virtualKeyWithUser: VirtualKeyWithUser | null
): RoutingStrategy => {
  const metadata = virtualKeyWithUser?.metadata as {
    routing_strategy?: unknown;
  } | null;
  const strategy = metadata?.routing_strategy;
  if (strategy === 'profit') return 'profit';
  if (strategy === 'e2ee') return 'e2ee';
  return 'availability';
};

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

  // Metric-driven primary selection: rankDeployments uses MetricsAggregator's
  // 6h Redis state (UX score) blended with margin computed from each
  // deployment's config + model_specs. When metrics are absent (fresh deploy,
  // cleared Redis) deployments are treated as cold and fold into the GOOD
  // primary lottery with a small fixed EXPLORE_WEIGHT, so they get a bounded
  // share of traffic to accumulate samples and graduate instead of starving.
  //
  // Metrics are keyed by canonical `models.model_id`, not the raw client
  // string — same physical deployments must share one metric set regardless
  // of which alias the client typed. All deployments in this list belong to
  // the same model, so any one's `model_slug` works as the key.
  const routingStrategy = parseRoutingStrategy(virtualKeyWithUser);
  let deployment: ModelDeployment;
  let deploymentsForCtx = allDeployments;
  if (allDeployments.length > 1) {
    const metrics = await getMetricsForModel(allDeployments[0].model_slug);
    deploymentsForCtx = rankDeployments(
      allDeployments,
      metrics,
      routingStrategy
    );
    deployment = deploymentsForCtx[0];
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
    cache_read_cost_per_token?: string | number;
    cache_creation_cost_per_token?: string | number;
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

  // Cache-tier sell prices: same precedence as input/output (sell → cost →
  // default), but default is `null` so computeCost treats absence as "no
  // cache pricing → bill cache tokens at input rate".
  const sellCacheRead = sellSpec.cache_read_cost_per_token;
  const sellCacheCreate = sellSpec.cache_creation_cost_per_token;
  const cacheReadCostPerToken =
    sellCacheRead != null && sellCacheRead !== ''
      ? sellCacheRead
      : deployment.config.cache_read_cost_per_token || null;
  const cacheCreationCostPerToken =
    sellCacheCreate != null && sellCacheCreate !== ''
      ? sellCacheCreate
      : deployment.config.cache_creation_cost_per_token || null;

  return {
    virtualKeyWithUser,
    providerConfig: {
      provider: deployment.provider_name,
      apiKey: deployment.config.api_key,
      customHost: deployment.config.base_url,
    },
    deploymentName: deployment.deployment_name,
    modelDeploymentId: deployment.id,
    modelId: deployment.model_slug,
    requestModel: modelName,
    pricing: {
      inputCostPerToken,
      outputCostPerToken,
      cacheReadCostPerToken,
      cacheCreationCostPerToken,
    },
    requestHash,
    spendMode,
    allDeployments: deploymentsForCtx,
    routingStrategy,
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

    // Stash the requested model so requestLogger can populate
    // request_logs.request_model even when validation fails before
    // VirtualKeyContext is built (e.g. unknown model, invalid API key).
    c.set('requestModel', modelName);

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
