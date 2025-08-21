import { createClient, RedisClientType } from 'redis';
import { env } from '../constants';

let redisClient: RedisClientType | null = null;

export function buildCacheKey(...parts: string[]): string {
  return `redpill:${parts.join(':')}`;
}

export async function getRedisClient(): Promise<RedisClientType> {
  if (!redisClient) {
    const redisConfig: any = {
      socket: {
        host: env.REDIS_HOST,
        port: env.REDIS_PORT,
      },
      database: env.REDIS_DB,
    };

    if (env.REDIS_PASSWORD) {
      redisConfig.password = env.REDIS_PASSWORD;
    }

    redisClient = createClient(redisConfig);

    redisClient.on('error', (err) => {
      console.error('Redis error:', err);
    });
  }

  if (!redisClient.isOpen) {
    await redisClient.connect();
  }

  return redisClient;
}

export async function getCache(key: string): Promise<any> {
  try {
    const client = await getRedisClient();
    const data = await client.get(key);
    return data ? JSON.parse(data) : null;
  } catch (error) {
    console.error('Cache get error:', error);
    return null;
  }
}

export async function setCache(
  key: string,
  data: any,
  ttl = 300
): Promise<void> {
  try {
    const client = await getRedisClient();
    await client.setEx(key, ttl, JSON.stringify(data));
  } catch (error) {
    console.error('Cache set error:', error);
  }
}

export async function clearCacheByPattern(pattern: string): Promise<void> {
  try {
    const client = await getRedisClient();
    const keys = await client.keys(pattern);
    if (keys.length > 0) {
      await client.del(keys);
    }
  } catch (error) {
    console.error('Clear cache by pattern error:', error);
  }
}

export async function closeRedisClient(): Promise<void> {
  if (redisClient?.isOpen) {
    await redisClient.disconnect();
    redisClient = null;
  }
}
