import { queryPostgres } from './connection';
import { z } from 'zod';

export const ModelSchema = z.object({
  id: z.number(),
  model_id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  specs: z.any(),
  active: z.boolean(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});

export const ModelDeploymentSchema = z.object({
  id: z.number(),
  model_id: z.number(),
  provider_name: z.string(),
  deployment_name: z.string(),
  config: z.any(),
  active: z.boolean(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});

export const ModelAliasSchema = z.object({
  id: z.number(),
  model_id: z.number(),
  alias: z.string(),
  active: z.boolean(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});

export type Model = z.infer<typeof ModelSchema>;
export type ModelDeployment = z.infer<typeof ModelDeploymentSchema>;
export type ModelAlias = z.infer<typeof ModelAliasSchema>;

export async function getModels(provider?: string): Promise<Model[]> {
  let query = 'SELECT * FROM models WHERE active = true';
  let params: string[] = [];

  if (provider) {
    query = `
      SELECT DISTINCT m.* FROM models m
      JOIN model_deployments md ON m.id = md.model_id
      WHERE m.active = true AND md.provider_name = $1 AND md.active = true
    `;
    params = [provider];
  }

  const results = await queryPostgres<unknown>(query, params);
  return results.map((row) => ModelSchema.parse(row));
}

export async function getModelAliases(modelId: number): Promise<ModelAlias[]> {
  const results = await queryPostgres<unknown>(
    'SELECT * FROM model_aliases WHERE model_id = $1 AND active = true',
    [modelId.toString()]
  );
  return results.map((row) => ModelAliasSchema.parse(row));
}

export async function getAllModelAliases(
  modelIds?: number[]
): Promise<ModelAlias[]> {
  let query = 'SELECT * FROM model_aliases WHERE active = true';
  let params: string[] = [];

  if (modelIds && modelIds.length > 0) {
    const placeholders = modelIds.map((_, index) => `$${index + 1}`).join(',');
    query += ` AND model_id IN (${placeholders})`;
    params = modelIds.map((id) => id.toString());
  }

  const results = await queryPostgres<unknown>(query, params);
  return results.map((row) => ModelAliasSchema.parse(row));
}

export async function getModelDeployment(
  modelNameOrAlias: string
): Promise<ModelDeployment | null> {
  const deployments = await queryPostgres<unknown>(
    `SELECT md.* FROM model_deployments md
     JOIN models m ON md.model_id = m.id
     LEFT JOIN model_aliases ma ON m.id = ma.model_id
     WHERE (m.model_id = $1 OR ma.alias = $1) 
       AND md.active = true
       AND m.active = true
       AND (ma.active = true OR ma.active IS NULL)
     LIMIT 1`,
    [modelNameOrAlias]
  );

  if (deployments.length === 0) {
    return null;
  }

  return ModelDeploymentSchema.parse(deployments[0]);
}
