import { z } from 'zod';
import {
  getModels,
  getModelDeployment,
  getAllModelAliases,
  type Model,
  type ModelDeployment,
} from '../db/postgres/model';
import {
  getCache,
  setCache,
  clearCacheByPattern,
  buildCacheKey,
} from '../db/redis';
import { decryptConfig } from '../utils/encryption';

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
  metadata: z
    .object({
      appid: z.string().optional(),
    })
    .default({}),
});

type TransformOptions = {
  includeEmbeddings?: boolean;
  onlyEmbeddings?: boolean;
};

export class ModelService {
  async getAllModels(): Promise<z.infer<typeof ModelSchema>[]> {
    const cacheKey = buildCacheKey('models', 'all');
    const cached = await getCache(cacheKey);
    if (cached) return cached;

    const models = await getModels();
    const transformedModels = await this.transformModels(models, {
      includeEmbeddings: false,
    });
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
    const transformedModels = await this.transformModels(models, {
      includeEmbeddings: false,
    });
    await setCache(cacheKey, transformedModels, 7200);
    return transformedModels;
  }

  async getAllEmbeddingModels(): Promise<z.infer<typeof ModelSchema>[]> {
    const cacheKey = buildCacheKey('embedding-models', 'all');
    const cached = await getCache(cacheKey);
    if (cached) return cached;

    const models = await getModels();
    const transformedModels = await this.transformModels(models, {
      onlyEmbeddings: true,
    });
    await setCache(cacheKey, transformedModels, 7200);
    return transformedModels;
  }

  async getEmbeddingModelsByProvider(
    provider: string
  ): Promise<z.infer<typeof ModelSchema>[]> {
    const cacheKey = buildCacheKey('embedding-models', provider);
    const cached = await getCache(cacheKey);
    if (cached) return cached;

    const models = await getModels(provider);
    const transformedModels = await this.transformModels(models, {
      onlyEmbeddings: true,
    });
    await setCache(cacheKey, transformedModels, 7200);
    return transformedModels;
  }

  async isValidModel(modelId: string): Promise<boolean> {
    const allModels = await this.getAllModels();
    return allModels.some((model) => model.id === modelId);
  }

  private async transformModels(
    models: Model[],
    options: TransformOptions = {}
  ): Promise<z.infer<typeof ModelSchema>[]> {
    const { includeEmbeddings = false, onlyEmbeddings = false } = options;
    const results = [];

    // Get all aliases in one query to avoid N+1
    const modelIds = models.map((model) => model.id);
    const allAliases = await getAllModelAliases(modelIds);

    // Group aliases by model_id for quick lookup
    const aliasesByModelId = allAliases.reduce(
      (acc, alias) => {
        if (!acc[alias.model_id]) {
          acc[alias.model_id] = [];
        }
        acc[alias.model_id].push(alias);
        return acc;
      },
      {} as Record<number, typeof allAliases>
    );

    for (const model of models) {
      const deployment = await getModelDeployment(model.model_id);
      const specs = model.specs || {};
      const config = deployment?.config || {};

      const isEmbeddingsModel = this.isEmbeddingsOnlyModel(specs);

      if (!onlyEmbeddings && !includeEmbeddings && isEmbeddingsModel) {
        continue;
      }

      if (onlyEmbeddings && !isEmbeddingsModel) {
        continue;
      }

      const baseModelData = {
        name: model.name,
        created: Math.floor(new Date(model.created_at).getTime() / 1000),
        input_modalities: specs.input_modalities,
        output_modalities: specs.output_modalities,
        context_length: specs.context_length,
        max_output_length: specs.max_output_tokens || specs.context_length,
        pricing: {
          prompt: config.input_cost_per_token,
          completion: config.output_cost_per_token,
        },
        supported_sampling_parameters: specs.supported_sampling_parameters,
        supported_features: specs.supported_features,
        description: model.description,
        ...(config.appid
          ? {
              metadata: {
                appid: config.appid,
              },
            }
          : undefined),
      };

      // Add the original model
      const originalModelData = ModelSchema.parse({
        id: model.model_id,
        ...baseModelData,
      });
      results.push(originalModelData);

      // Add each alias as a separate model entry
      const modelAliases = aliasesByModelId[model.id] || [];
      for (const alias of modelAliases) {
        const aliasModelData = ModelSchema.parse({
          id: alias.alias,
          ...baseModelData,
        });
        results.push(aliasModelData);
      }
    }

    return results;
  }

  private isEmbeddingsOnlyModel(specs: Record<string, unknown>): boolean {
    const rawModalities = (specs as Record<string, unknown>)[
      'output_modalities'
    ];
    if (!Array.isArray(rawModalities)) {
      return false;
    }
    if (rawModalities.length !== 1) {
      return false;
    }
    const first = rawModalities[0];
    if (typeof first !== 'string') {
      return false;
    }
    return first.toLowerCase() === 'embeddings';
  }

  async getModelDeploymentForModel(
    modelNameOrAlias: string
  ): Promise<ModelDeployment | null> {
    // Check cache first
    const cacheKey = buildCacheKey('model-deployment', modelNameOrAlias);
    const cached = await getCache(cacheKey);
    if (cached) {
      return cached;
    }

    // Cache miss - query database
    const deployment = await getModelDeployment(modelNameOrAlias);

    if (!deployment) {
      // Cache null result to prevent cache penetration
      await setCache(cacheKey, null, 300); // 5 minutes TTL
      return null;
    }

    // Decrypt sensitive config fields before caching
    const deploymentWithDecryptedConfig = {
      ...deployment,
      config: this.decryptConfigFields(deployment.config),
    };

    // Cache the decrypted result
    await setCache(cacheKey, deploymentWithDecryptedConfig, 86400); // 24 hours TTL
    return deploymentWithDecryptedConfig;
  }

  private decryptConfigFields(config: any): any {
    if (typeof config !== 'object' || config === null) {
      return config;
    }

    const result = { ...config };

    for (const [key, value] of Object.entries(config)) {
      if (key.startsWith('encrypted_') && typeof value === 'string') {
        const originalKey = key.replace('encrypted_', '');
        result[originalKey] = decryptConfig(value);
        delete result[key];
      }
    }

    return result;
  }

  async clearCache(): Promise<void> {
    try {
      await clearCacheByPattern(buildCacheKey('models', '*'));
      await clearCacheByPattern(buildCacheKey('model-deployment', '*'));
      await clearCacheByPattern(buildCacheKey('embedding-models', '*'));
    } catch (error) {
      console.error('Failed to clear model cache:', error);
    }
  }
}
