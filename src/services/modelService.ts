import { z } from 'zod';
import {
  getModels,
  getModelsByProviders,
  getModelDeployment,
  getModelDeployments,
  getAllModelAliases,
  getModelProvidersByModelIds,
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
import { type VirtualKeyWithUser } from '../db/postgres/virtualKey';

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
      image: z.string().optional(),
      request: z.string().optional(),
      input_cache_read: z.string().optional(),
      input_cache_write: z.string().optional(),
    })
    .default({}),
  supported_parameters: z.array(z.string()).default([]),
  providers: z.array(z.string()).default([]),
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
  excludeAliases?: boolean;
  overrideProviders?: string[];
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
    const cacheKey = buildCacheKey('embedding_models', 'all');
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
    const cacheKey = buildCacheKey('embedding_models', provider);
    const cached = await getCache(cacheKey);
    if (cached) return cached;

    const models = await getModels(provider);
    const transformedModels = await this.transformModels(models, {
      onlyEmbeddings: true,
    });
    await setCache(cacheKey, transformedModels, 7200);
    return transformedModels;
  }

  async getPhalaModels(): Promise<z.infer<typeof ModelSchema>[]> {
    const cacheKey = buildCacheKey('models', 'phala-native');
    const cached = await getCache(cacheKey);
    if (cached) return cached;

    const models = await getModelsByProviders(['phala', 'near-ai']);
    const transformedModels = await this.transformModels(models, {
      includeEmbeddings: false,
      excludeAliases: true,
      overrideProviders: ['phala'],
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
    const {
      includeEmbeddings = false,
      onlyEmbeddings = false,
      excludeAliases = false,
      overrideProviders,
    } = options;
    const results = [];

    // Get all aliases in one query to avoid N+1
    const modelIds = models.map((model) => model.id);
    const allAliases = await getAllModelAliases(modelIds);
    const allProviders = await getModelProvidersByModelIds(modelIds);

    const providersByModelId = allProviders.reduce(
      (acc, provider) => {
        if (!acc[provider.model_id]) {
          acc[provider.model_id] = new Set<string>();
        }
        acc[provider.model_id].add(provider.provider_name);
        return acc;
      },
      {} as Record<number, Set<string>>
    );

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
        pricing: this.buildPricing(specs, config),
        supported_parameters: specs.supported_parameters,
        providers:
          overrideProviders ||
          Array.from(providersByModelId[model.id] || []).sort(),
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

      // Add each alias as a separate model entry (only phala/ prefixed aliases)
      if (!excludeAliases) {
        const modelAliases = (aliasesByModelId[model.id] || []).filter(
          (alias) => alias.alias.startsWith('phala/')
        );
        for (const alias of modelAliases) {
          const aliasModelData = ModelSchema.parse({
            id: alias.alias,
            ...baseModelData,
          });
          results.push(aliasModelData);
        }
      }
    }

    return results;
  }

  // Prefer specs (sell price) over deployment config (upstream cost). Cache
  // fields are omitted when unpriced so clients fall back to the prompt rate,
  // mirroring computeCost in pricing.ts — a returned "0" would mean free.
  private buildPricing(
    specs: Record<string, any>,
    config: Record<string, any>
  ) {
    const pick = (specKey: string, configKey: string = specKey) => {
      const specValue = specs[specKey];
      if (specValue != null && specValue !== '') return specValue;
      const configValue = config[configKey];
      if (configValue != null && configValue !== '') return configValue;
      return undefined;
    };

    const pricing: Record<string, string> = {
      prompt: pick('input_cost_per_token') ?? '0',
      completion: pick('output_cost_per_token') ?? '0',
    };
    const image = pick('image_cost_per_token');
    if (image !== undefined) pricing.image = image;
    const request = pick('request_cost');
    if (request !== undefined) pricing.request = request;
    const cacheRead = pick('cache_read_cost_per_token');
    if (cacheRead !== undefined) pricing.input_cache_read = cacheRead;
    const cacheWrite = pick('cache_creation_cost_per_token');
    if (cacheWrite !== undefined) pricing.input_cache_write = cacheWrite;
    return pricing;
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

  private async getCachedDeployments(
    modelNameOrAlias: string
  ): Promise<ModelDeployment[] | null> {
    const cacheKey = buildCacheKey('model_deployment', modelNameOrAlias);
    const cached = await getCache(cacheKey);

    if (Array.isArray(cached)) {
      return cached.length ? cached : null;
    }

    const deploymentsFromDb = await getModelDeployments(modelNameOrAlias);

    if (!deploymentsFromDb.length) {
      await setCache(cacheKey, [], 300); // 5 minutes TTL
      return null;
    }

    const deployments = deploymentsFromDb.map((deployment) => ({
      ...deployment,
      config: this.decryptConfigFields(deployment.config),
    }));

    await setCache(cacheKey, deployments, 86400); // 24 hours TTL
    return deployments;
  }

  async getModelDeploymentForModel(
    modelNameOrAlias: string,
    options?: { virtualKeyWithUser?: VirtualKeyWithUser | null }
  ): Promise<ModelDeployment | null> {
    const deployments = await this.getCachedDeployments(modelNameOrAlias);
    if (!deployments) {
      return null;
    }

    const isEnterpriseUser =
      options?.virtualKeyWithUser?.user.user_tier === 'ENTERPRISE';

    const deploymentIndex = isEnterpriseUser
      ? Math.floor(Math.random() * deployments.length)
      : 0;

    return deployments[deploymentIndex];
  }

  async getAllModelDeploymentsForModel(
    modelNameOrAlias: string
  ): Promise<ModelDeployment[]> {
    return (await this.getCachedDeployments(modelNameOrAlias)) ?? [];
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
      await clearCacheByPattern(buildCacheKey('model_deployment', '*'));
      await clearCacheByPattern(buildCacheKey('embedding_models', '*'));
    } catch (error) {
      console.error('Failed to clear model cache:', error);
    }
  }
}
