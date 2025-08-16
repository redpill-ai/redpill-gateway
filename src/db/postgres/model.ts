import { queryPostgres } from './connection';

export interface Model {
  id: string;
  name: string;
  description?: string;
  specs: any;
  created_at: Date;
  updated_at: Date;
}

export interface ModelDeployment {
  id: number;
  model_id: string;
  provider_name: string;
  deployment_name: string;
  config: any;
  is_active: boolean;
  priority: number;
  created_at: Date;
  updated_at: Date;
}

export async function getModels(provider?: string): Promise<Model[]> {
  let query = 'SELECT * FROM models';
  let params: any[] = [];

  if (provider) {
    query = `
      SELECT DISTINCT m.* FROM models m 
      JOIN model_deployments md ON m.id = md.model_id 
      WHERE md.provider_name = $1 AND md.is_active = true
    `;
    params = [provider];
  }

  return queryPostgres<Model>(query, params);
}

export async function getModelDeployments(
  modelId?: string,
  provider?: string
): Promise<ModelDeployment[]> {
  let query = 'SELECT * FROM model_deployments WHERE is_active = true';
  let params: any[] = [];
  let paramIndex = 1;

  if (modelId) {
    query += ` AND model_id = $${paramIndex}`;
    params.push(modelId);
    paramIndex++;
  }

  if (provider) {
    query += ` AND provider_name = $${paramIndex}`;
    params.push(provider);
  }

  query += ' ORDER BY priority ASC';

  return queryPostgres<ModelDeployment>(query, params);
}
