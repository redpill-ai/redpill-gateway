import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  CLICKHOUSE_URL: z.string().min(1, 'CLICKHOUSE_URL is required'),
  CLICKHOUSE_USERNAME: z.string().min(1, 'CLICKHOUSE_USERNAME is required'),
  CLICKHOUSE_PASSWORD: z.string().min(1, 'CLICKHOUSE_PASSWORD is required'),
  CLICKHOUSE_DATABASE: z.string().min(1, 'CLICKHOUSE_DATABASE is required'),
});

export const env = envSchema.parse(process.env);
