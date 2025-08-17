import { queryPostgres } from './connection';
import { ModelDeployment, ModelDeploymentSchema } from './model';
import { User, UserSchema } from './user';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { createHash } from 'crypto';

export const VirtualKeySchema = z.object({
  id: z.number(),
  key_name: z.string(),
  key_alias: z.string().nullable(),
  api_key_hash: z.string(),
  user_id: z.number(),
  active: z.boolean(),
  budget_limit: z
    .string()
    .nullable()
    .transform((val) => (val ? new Decimal(val) : undefined)),
  budget_used: z.string().transform((val) => new Decimal(val)),
  rate_limit_rpm: z.number().nullable(),
  rate_limit_tpm: z.number().nullable(),
  metadata: z.any().nullable(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});

export type VirtualKey = z.infer<typeof VirtualKeySchema>;

export interface VirtualKeyWithUser extends VirtualKey {
  user: User;
}

export interface VirtualKeyValidationResult {
  isValid: boolean;
  virtualKeyWithUser?: VirtualKeyWithUser;
  error?: string;
}

export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

export async function validateVirtualKey(
  apiKey: string
): Promise<VirtualKeyValidationResult> {
  const apiKeyHash = hashApiKey(apiKey);
  try {
    const result = await queryPostgres<unknown>(
      `SELECT vk.*,
              json_build_object(
                'id', u.id,
                'email', u.email,
                'budget_limit', u.budget_limit::text,
                'budget_used', u.budget_used::text,
                'rate_limit_rpm', u.rate_limit_rpm,
                'rate_limit_tpm', u.rate_limit_tpm,
                'created_at', u.created_at,
                'updated_at', u.updated_at
              ) as user
       FROM virtual_keys vk
       JOIN users u ON vk.user_id = u.id
       WHERE vk.api_key_hash = $1 AND vk.active = true`,
      [apiKeyHash]
    );

    if (result.length === 0) {
      return {
        isValid: false,
        error: 'Invalid API key',
      };
    }

    const row = result[0];

    // Parse and validate virtual key data
    const virtualKey = VirtualKeySchema.parse(row);

    // Parse and validate user data
    const user = UserSchema.parse((row as { user: unknown }).user);

    const virtualKeyWithUser: VirtualKeyWithUser = {
      ...virtualKey,
      user,
    };

    // Check user budget
    if (
      virtualKeyWithUser.user.budget_limit &&
      virtualKeyWithUser.user.budget_used.gte(
        virtualKeyWithUser.user.budget_limit
      )
    ) {
      return {
        isValid: false,
        error: 'Account quota exceeded',
      };
    }

    // Check virtual key budget
    if (
      virtualKeyWithUser.budget_limit &&
      virtualKeyWithUser.budget_used.gte(virtualKeyWithUser.budget_limit)
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
