import Decimal from 'decimal.js';
import { z } from 'zod';

export const UserSchema = z.object({
  id: z.number(),
  email: z.string(),
  budget_limit: z
    .string()
    .nullable()
    .transform((val) => (val ? new Decimal(val) : undefined)),
  budget_used: z.string().transform((val) => new Decimal(val)),
  rate_limit_rpm: z.number().nullable(),
  rate_limit_tpm: z.number().nullable(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});

export type User = z.infer<typeof UserSchema>;
