import { Pool, PoolClient } from 'pg';
import { env } from '../../constants';

let pool: Pool | null = null;

export function createPostgresPool() {
  if (pool?.ended) {
    // Pool has been ended elsewhere, discard reference so it can be recreated
    pool = null;
  }

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
  try {
    return await createPostgresPool().connect();
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('Cannot use a pool after calling end')
    ) {
      // Pool reference is stale, reset and retry once
      await closePostgresPool();
      return await createPostgresPool().connect();
    }

    throw error;
  }
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
    const currentPool = pool;
    pool = null;
    if (!currentPool.ended) {
      await currentPool.end();
    }
  }
}
