import { queryPostgres } from './connection';
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

export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

export async function findVirtualKeyWithUser(
  apiKey: string
): Promise<VirtualKeyWithUser | null> {
  const apiKeyHash = hashApiKey(apiKey);
  try {
    const result = await queryPostgres<unknown>(
      `SELECT vk.*,
              json_build_object(
                'id', u.id,
                'email', u.email,
                'user_tier', u.user_tier,
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
      return null;
    }

    const row = result[0];
    const virtualKey = VirtualKeySchema.parse(row);
    const user = UserSchema.parse((row as { user: unknown }).user);

    return {
      ...virtualKey,
      user,
    };
  } catch (error) {
    console.error('Virtual key query error:', error);
    return null;
  }
}

export async function updateVirtualKeyBudgetsBatch(
  keySpends: Map<number, Decimal>
): Promise<void> {
  if (keySpends.size === 0) return;

  const values = Array.from(keySpends.entries())
    .map(
      (_, index) => `($${index * 2 + 1}::integer, $${index * 2 + 2}::decimal)`
    )
    .join(', ');

  const params = Array.from(keySpends.entries()).flatMap(([keyId, cost]) => [
    keyId,
    cost.toString(),
  ]);

  await queryPostgres(
    `
    UPDATE virtual_keys SET
      budget_used = budget_used + data.amount
    FROM (VALUES ${values}) AS data(key_id, amount)
    WHERE virtual_keys.id = data.key_id
  `,
    params
  );
}
