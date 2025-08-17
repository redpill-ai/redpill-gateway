import { Context } from 'hono';
import {
  validateVirtualKey,
  getModelDeploymentForModel,
} from '../../db/postgres/virtualKey';

interface RequestWithModel {
  model: string;
  [key: string]: any;
}

export const virtualKeyValidator = async (c: Context, next: any) => {
  const requestHeaders = Object.fromEntries(c.req.raw.headers);
  const apiKey = requestHeaders['authorization']?.replace('Bearer ', '');

  if (!apiKey) {
    return next();
  }

  // Validate API key
  const validationResult = await validateVirtualKey(apiKey);

  if (!validationResult.isValid) {
    return new Response(
      JSON.stringify({
        status: 'failure',
        message: validationResult.error || 'Authentication failed',
      }),
      {
        status: 401,
        headers: {
          'content-type': 'application/json',
        },
      }
    );
  }

  try {
    let modelName: string;

    // Get model name from body for POST requests or query params for GET requests
    if (c.req.method === 'GET') {
      modelName = c.req.query('model') || '';
    } else {
      // Parse request body to get model name
      const requestBody: RequestWithModel = await c.req.json();
      modelName = requestBody.model;
    }

    if (!modelName) {
      return new Response(
        JSON.stringify({
          status: 'failure',
          message: 'Model parameter is required',
        }),
        {
          status: 400,
          headers: {
            'content-type': 'application/json',
          },
        }
      );
    }

    // Get model deployment for the requested model
    const deploymentResult = await getModelDeploymentForModel(modelName);

    if (deploymentResult.error || !deploymentResult.deployment) {
      return new Response(
        JSON.stringify({
          status: 'failure',
          message: `Model '${modelName}' is not available`,
        }),
        {
          status: 404,
          headers: {
            'content-type': 'application/json',
          },
        }
      );
    }

    const deployment = deploymentResult.deployment;

    // Store virtual key context for billing and provider config override
    c.set('virtualKeyContext', {
      virtualKeyWithUser: validationResult.virtualKeyWithUser,
      providerConfig: {
        provider: deployment.provider_name,
        apiKey: deployment.config.api_key,
        customHost: deployment.config.base_url,
      },
    });
  } catch (error) {
    console.error('Virtual key middleware error:', error);
    return new Response(
      JSON.stringify({
        status: 'failure',
        message: 'Internal server error',
      }),
      {
        status: 500,
        headers: {
          'content-type': 'application/json',
        },
      }
    );
  }

  return next();
};
