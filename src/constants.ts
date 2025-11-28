import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_HOST: z.string().default('127.0.0.1'),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_DB: z.coerce.number().default(0),
  REDIS_PASSWORD: z.string().optional(),
  CLICKHOUSE_URL: z.string().min(1, 'CLICKHOUSE_URL is required'),
  CLICKHOUSE_USERNAME: z.string().min(1, 'CLICKHOUSE_USERNAME is required'),
  CLICKHOUSE_PASSWORD: z.string().min(1, 'CLICKHOUSE_PASSWORD is required'),
  CLICKHOUSE_DATABASE: z.string().min(1, 'CLICKHOUSE_DATABASE is required'),
  ENCRYPTION_KEY: z
    .string()
    .length(64, 'ENCRYPTION_KEY must be 64 hex characters (32 bytes)'),
  FREE_ALLOWED_MODELS: z.string().default('qwen/qwen-2.5-7b-instruct'),
  GATEWAY_REQUEST_TIMEOUT: z.coerce.number().positive().default(600_000),
});

export const env = envSchema.parse(process.env);
