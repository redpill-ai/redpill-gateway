import { Context } from 'hono';
import { ModelService } from '../services/modelService';

/**
 * Handles the phala native models request.
 * Returns models from phala and near-ai providers without aliases,
 * with providers unified as ["phala"].
 */
export async function phalaModelsHandler(c: Context): Promise<Response> {
  const modelService = new ModelService();

  try {
    const models = await modelService.getPhalaModels();
    return c.json({ data: models });
  } catch (error) {
    console.error('Error fetching phala models:', error);
    return c.json({ error: 'Failed to fetch models' }, 500);
  }
}

/**
 * Handles the models request. Returns a list of models supported by the Ai gateway.
 * Allows filters in query params for the provider
 * @param c - The Hono context
 * @returns - The response
 */
export async function modelsHandler(c: Context): Promise<Response> {
  // Support both query parameter and path parameter for provider filtering
  const provider = c.req.param('provider') || c.req.query('provider');
  const modelService = new ModelService();

  try {
    const models = provider
      ? await modelService.getModelsByProvider(provider)
      : await modelService.getAllModels();

    return c.json({
      data: models,
    });
  } catch (error) {
    console.error('Error fetching models:', error);
    return c.json({ error: 'Failed to fetch models' }, 500);
  }
}
