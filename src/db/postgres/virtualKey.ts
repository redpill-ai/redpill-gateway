import { queryPostgres } from './connection';
import { ModelDeployment } from './model';
import { User } from './user';

export interface VirtualKey {
  id: string;
  key_name: string;
  api_key: string;
  user_id: string;
  is_active: boolean;
  budget_limit?: number;
  budget_used: number;
  rate_limit_rpm?: number;
  rate_limit_tpm?: number;
  metadata?: any;
  created_at: Date;
  updated_at: Date;
}

export interface VirtualKeyWithUser extends VirtualKey {
  user: User;
}

export interface VirtualKeyValidationResult {
  isValid: boolean;
  virtualKeyWithUser?: VirtualKeyWithUser;
  error?: string;
}

export interface ModelDeploymentLookupResult {
  deployment?: ModelDeployment;
  error?: string;
}

// Mock data for virtual keys with user info
const mockVirtualKeysWithUser: VirtualKeyWithUser[] = [
  {
    id: 'vk_1',
    key_name: 'test-key-1',
    api_key: 'sk-test-virtual-key-1234567890',
    user_id: 'user_1',
    is_active: true,
    budget_limit: 500,
    budget_used: 50,
    rate_limit_rpm: 60,
    rate_limit_tpm: 10000,
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
    user: {
      id: 'user_1',
      username: 'test_user_1',
      email: 'test1@example.com',
      is_active: true,
      budget_limit: 2000,
      budget_used: 150,
      rate_limit_rpm: 100,
      rate_limit_tpm: 20000,
      created_at: new Date(),
      updated_at: new Date(),
    },
  },
  {
    id: 'vk_2',
    key_name: 'test-key-2',
    api_key: 'sk-test-virtual-key-abcdefgh',
    user_id: 'user_2',
    is_active: true,
    budget_limit: 300,
    budget_used: 250,
    rate_limit_rpm: 30,
    rate_limit_tpm: 5000,
    metadata: {},
    created_at: new Date(),
    updated_at: new Date(),
    user: {
      id: 'user_2',
      username: 'test_user_2',
      email: 'test2@example.com',
      is_active: true,
      budget_limit: 1000,
      budget_used: 800,
      rate_limit_rpm: 50,
      rate_limit_tpm: 10000,
      created_at: new Date(),
      updated_at: new Date(),
    },
  },
];

export async function validateVirtualKey(
  apiKey: string
): Promise<VirtualKeyValidationResult> {
  try {
    // TODO: Replace with actual database query with JOIN
    // const result = await queryPostgres<any>(
    //   `SELECT vk.*,
    //           json_build_object(
    //             'id', u.id,
    //             'username', u.username,
    //             'email', u.email,
    //             'is_active', u.is_active,
    //             'budget_limit', u.budget_limit,
    //             'budget_used', u.budget_used,
    //             'rate_limit_rpm', u.rate_limit_rpm,
    //             'rate_limit_tpm', u.rate_limit_tpm,
    //             'created_at', u.created_at,
    //             'updated_at', u.updated_at
    //           ) as user
    //    FROM virtual_keys vk
    //    JOIN users u ON vk.user_id = u.id
    //    WHERE vk.api_key = $1 AND vk.is_active = true AND u.is_active = true`,
    //   [apiKey]
    // );

    // Mock implementation
    const virtualKeyWithUser = mockVirtualKeysWithUser.find(
      (vk) => vk.api_key === apiKey && vk.is_active && vk.user.is_active
    );

    if (!virtualKeyWithUser) {
      return {
        isValid: false,
        error: 'Invalid API key',
      };
    }

    // Check user budget
    if (
      virtualKeyWithUser.user.budget_limit &&
      virtualKeyWithUser.user.budget_used >=
        virtualKeyWithUser.user.budget_limit
    ) {
      return {
        isValid: false,
        error: 'Account quota exceeded',
      };
    }

    // Check virtual key budget
    if (
      virtualKeyWithUser.budget_limit &&
      virtualKeyWithUser.budget_used >= virtualKeyWithUser.budget_limit
    ) {
      return {
        isValid: false,
        error: 'API key quota exceeded',
      };
    }

    return {
      isValid: true,
      virtualKeyWithUser,
    };
  } catch (error) {
    console.error('Virtual key validation error:', error);
    return {
      isValid: false,
      error: 'Virtual key validation failed',
    };
  }
}

export async function getModelDeploymentForModel(
  modelName: string
): Promise<ModelDeploymentLookupResult> {
  try {
    // Query for active model deployments for the specified model
    const deployments = await queryPostgres<ModelDeployment>(
      `SELECT md.* FROM model_deployments md 
       JOIN models m ON md.model_id = m.id 
       WHERE m.id = $1 AND md.is_active = true 
       ORDER BY md.priority ASC 
       LIMIT 1`,
      [modelName]
    );

    if (deployments.length === 0) {
      return {
        error: `No active deployment found for model: ${modelName}`,
      };
    }

    return {
      deployment: deployments[0],
    };
  } catch (error) {
    console.error('Model deployment lookup error:', error);
    return {
      error: 'Failed to lookup model deployment',
    };
  }
}
