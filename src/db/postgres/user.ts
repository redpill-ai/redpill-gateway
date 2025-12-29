import Decimal from 'decimal.js';
import { z } from 'zod';
import { queryPostgres } from './connection';

export const UserSchema = z.object({
  id: z.number(),
  user_tier: z.string(),
  email: z.string(),
  budget_limit: z
    .string()
    .nullable()
    .transform((val) => (val ? new Decimal(val) : undefined)),
  budget_used: z.string().transform((val) => new Decimal(val)),
  credits: z
    .string()
    .nullable()
    .transform((val) => (val ? new Decimal(val) : new Decimal(0))),
  rate_limit_rpm: z.number().nullable(),
  rate_limit_tpm: z.number().nullable(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});

export type User = z.infer<typeof UserSchema>;

export async function updateUserBudgetsBatch(
  userSpends: Map<number, Decimal>
): Promise<void> {
  if (userSpends.size === 0) return;

  const values = Array.from(userSpends.entries())
    .map(
      (_, index) => `($${index * 2 + 1}::integer, $${index * 2 + 2}::decimal)`
    )
    .join(', ');

  const params = Array.from(userSpends.entries()).flatMap(([userId, cost]) => [
    userId,
    cost.toString(),
  ]);

  await queryPostgres(
    `
    UPDATE users SET
      budget_used = budget_used + data.amount,
      credits = credits - data.amount * 2000000
    FROM (VALUES ${values}) AS data(user_id, amount)
    WHERE users.id = data.user_id
  `,
    params
  );
}
