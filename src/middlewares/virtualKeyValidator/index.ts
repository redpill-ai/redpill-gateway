import { Context } from 'hono';
import {
  findVirtualKeyWithUser,
  VirtualKeyWithUser,
} from '../../db/postgres/virtualKey';
import { ModelService } from '../../services/modelService';
import { env } from '../../constants';
import { hash } from '../../utils/hash';

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
      status: 'failure',
      message,
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
  virtualKeyWithUser: VirtualKeyWithUser | null = null
): Promise<VirtualKeyContext> => {
  const modelService = new ModelService();
  const deployment = await modelService.getModelDeploymentForModel(modelName);

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

const handleAuthenticatedUser = async (
  c: Context,
  apiKey: string,
  modelName: string
): Promise<void> => {
  // Find virtual key with user data
  const virtualKeyWithUser = await findVirtualKeyWithUser(apiKey);
  if (!virtualKeyWithUser) {
    throw new VirtualKeyValidationError('Invalid API key', 401);
  }

  // Check user budget
  if (
    virtualKeyWithUser.user.budget_limit !== undefined &&
    virtualKeyWithUser.user.budget_used.gte(
      virtualKeyWithUser.user.budget_limit
    )
  ) {
    throw new VirtualKeyValidationError('Account quota exceeded', 401);
  }

  // Check virtual key budget
  if (
    virtualKeyWithUser.budget_limit !== undefined &&
    virtualKeyWithUser.budget_used.gte(virtualKeyWithUser.budget_limit)
  ) {
    throw new VirtualKeyValidationError('API key quota exceeded', 401);
  }

  const virtualKeyContext = await createVirtualKeyContext(
    c,
    modelName,
    virtualKeyWithUser
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
      'Add credits to access this model',
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
