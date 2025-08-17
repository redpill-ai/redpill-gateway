import { z } from 'zod';
import {
  getModels,
  getModelDeployments,
  type Model,
} from '../db/postgres/model';
import {
  getCache,
  setCache,
  clearCacheByPattern,
  buildCacheKey,
} from '../db/redis';

const ModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  created: z.number(),
  input_modalities: z.array(z.string()).default(['text']),
  output_modalities: z.array(z.string()).default(['text']),
  context_length: z.number().default(4096),
  max_output_length: z.number().default(4096),
  pricing: z
    .object({
      prompt: z.string().default('0'),
      completion: z.string().default('0'),
      image: z.string().default('0'),
      request: z.string().default('0'),
      input_cache_reads: z.string().default('0'),
      input_cache_writes: z.string().default('0'),
    })
    .default({}),
  supported_sampling_parameters: z.array(z.string()).default(['temperature']),
  supported_features: z.array(z.string()).default([]),
  description: z.string().optional(),
});

export class ModelService {
  async getAllModels(): Promise<z.infer<typeof ModelSchema>[]> {
    const cacheKey = buildCacheKey('models', 'all');
    const cached = await getCache(cacheKey);
    if (cached) return cached;

    const models = await getModels();
    const transformedModels = await this.transformModels(models);
    await setCache(cacheKey, transformedModels, 7200);
    return transformedModels;
  }

  async getModelsByProvider(
    provider: string
  ): Promise<z.infer<typeof ModelSchema>[]> {
    const cacheKey = buildCacheKey('models', provider);
    const cached = await getCache(cacheKey);
    if (cached) return cached;

    const models = await getModels(provider);
    const transformedModels = await this.transformModels(models);
    await setCache(cacheKey, transformedModels, 7200);
    return transformedModels;
  }

  async isValidModel(modelId: string): Promise<boolean> {
    const allModels = await this.getAllModels();
    return allModels.some((model) => model.id === modelId);
  }

  private async transformModels(
    models: Model[]
  ): Promise<z.infer<typeof ModelSchema>[]> {
    const results = [];

    for (const model of models) {
      const deployments = await getModelDeployments(model.id);
      const specs = model.specs || {};
      const bestDeployment = deployments[0];
      const config = bestDeployment?.config || {};

      const modelData = ModelSchema.parse({
        id: model.id,
        name: model.name,
        created: Math.floor(new Date(model.created_at).getTime() / 1000),
        input_modalities: specs.input_modalities,
        output_modalities: specs.output_modalities,
        context_length: specs.context_length,
        max_output_length: specs.max_output_tokens,
        pricing: {
          prompt: config.input_cost_per_token,
          completion: config.output_cost_per_token,
        },
        supported_sampling_parameters: specs.supported_sampling_parameters,
        supported_features: specs.supported_features,
        description: model.description,
      });

      results.push(modelData);
    }

    return results;
  }

  async clearCache(): Promise<void> {
    try {
      await clearCacheByPattern(buildCacheKey('models', '*'));
    } catch (error) {
      console.error('Failed to clear model cache:', error);
    }
  }
}
