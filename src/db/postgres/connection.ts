import { Pool, PoolClient } from 'pg';
import { env } from '../../constants';

let pool: Pool | null = null;

export function createPostgresPool() {
  if (pool) return pool;

  pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });

  pool.on('error', (err) => {
    console.error('PostgreSQL pool error:', err);
  });

  return pool;
}

export async function getPostgresClient(): Promise<PoolClient> {
  const pgPool = createPostgresPool();
  return await pgPool.connect();
}

export async function queryPostgres<T = any>(
  text: string,
  params?: any[]
): Promise<T[]> {
  const client = await getPostgresClient();
  try {
    const result = await client.query(text, params);
    return result.rows;
  } finally {
    client.release();
  }
}

export async function closePostgresPool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
