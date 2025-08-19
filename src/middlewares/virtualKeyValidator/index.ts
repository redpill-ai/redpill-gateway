import { Context } from 'hono';
import {
  findVirtualKeyWithUser,
  VirtualKeyWithUser,
} from '../../db/postgres/virtualKey';
import { ModelService } from '../../services/modelService';

export interface VirtualKeyContext {
  virtualKeyWithUser: VirtualKeyWithUser;
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

const validateBudgetLimits = (
  virtualKeyWithUser: VirtualKeyWithUser
): string | null => {
  // Check user budget
  if (
    virtualKeyWithUser.user.budget_limit &&
    virtualKeyWithUser.user.budget_used.gte(
      virtualKeyWithUser.user.budget_limit
    )
  ) {
    return 'Account quota exceeded';
  }

  // Check virtual key budget
  if (
    virtualKeyWithUser.budget_limit &&
    virtualKeyWithUser.budget_used.gte(virtualKeyWithUser.budget_limit)
  ) {
    return 'API key quota exceeded';
  }

  return null;
};

export const virtualKeyValidator = async (c: Context, next: any) => {
  const requestHeaders = Object.fromEntries(c.req.raw.headers);
  const apiKey = requestHeaders['authorization']?.replace('Bearer ', '');

  if (!apiKey) {
    return next();
  }

  // Find virtual key with user data
  const virtualKeyWithUser = await findVirtualKeyWithUser(apiKey);
  if (!virtualKeyWithUser) {
    return createErrorResponse(401, 'Invalid API key');
  }

  // Validate budget limits
  const budgetError = validateBudgetLimits(virtualKeyWithUser);
  if (budgetError) {
    return createErrorResponse(401, budgetError);
  }

  try {
    // Get model name from body for POST requests or query params for other requests
    const modelName =
      c.req.method === 'POST'
        ? (await c.req.json())?.model ?? ''
        : c.req.query('model') || '';

    if (!modelName) {
      return createErrorResponse(400, 'Model parameter is required');
    }

    // Get model deployment for the requested model
    const modelService = new ModelService();
    const deployment = await modelService.getModelDeploymentForModel(modelName);

    if (!deployment) {
      return createErrorResponse(404, `Model '${modelName}' is not available`);
    }

    // Store virtual key context for billing and provider config override
    c.set('virtualKeyContext', {
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
    });
  } catch (error) {
    console.error('Virtual key middleware error:', error);
    return createErrorResponse(500, 'Internal server error');
  }

  return next();
};
