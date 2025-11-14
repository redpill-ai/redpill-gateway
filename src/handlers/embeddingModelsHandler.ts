import { Context } from 'hono';
import { ModelService } from '../services/modelService';

/**
 * Handles requests for embeddings-only model metadata.
 */
export async function embeddingModelsHandler(c: Context): Promise<Response> {
  const provider = c.req.param('provider') || c.req.query('provider');
  const modelService = new ModelService();

  try {
    const models = provider
      ? await modelService.getEmbeddingModelsByProvider(provider)
      : await modelService.getAllEmbeddingModels();

    return c.json({ data: models });
  } catch (error) {
    console.error('Error fetching embeddings models:', error);
    return c.json({ error: 'Failed to fetch embeddings models' }, 500);
  }
}
