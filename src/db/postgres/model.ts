import { queryPostgres } from './connection';
import { z } from 'zod';

export const ModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  specs: z.any(),
  active: z.boolean(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});

export const ModelDeploymentSchema = z.object({
  id: z.number(),
  model_id: z.string(),
  provider_name: z.string(),
  deployment_name: z.string(),
  config: z.any(),
  active: z.boolean(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});

export type Model = z.infer<typeof ModelSchema>;
export type ModelDeployment = z.infer<typeof ModelDeploymentSchema>;

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

export async function getModelDeployments(
  modelId: string,
  provider?: string
): Promise<ModelDeployment[]> {
  let query = `
    SELECT md.* FROM model_deployments md
    JOIN models m ON md.model_id = m.id
    WHERE md.active = true AND m.active = true AND md.model_id = $1
  `;
  let params: string[] = [modelId];

  if (provider) {
    query += ` AND md.provider_name = $2`;
    params.push(provider);
  }

  const results = await queryPostgres<unknown>(query, params);
  return results.map((row) => ModelDeploymentSchema.parse(row));
}
