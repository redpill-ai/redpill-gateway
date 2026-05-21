import { getRedisClient, buildCacheKey } from '../db/redis';
import { insertRequestLogs, RequestLogRow } from '../db/clickhouse';
import msgpack from 'msgpack5';

export class RequestLogQueue {
  private static instance: RequestLogQueue;
  private readonly mp = msgpack();
  private readonly QUEUE_KEY = buildCacheKey('request_log', 'queue');
  private readonly LOCK_KEY = buildCacheKey('request_log', 'lock');
  private readonly LOCK_TTL = 60;
  private processingInterval: NodeJS.Timeout | null = null;

  private constructor() {}

  static getInstance(): RequestLogQueue {
    if (!RequestLogQueue.instance) {
      RequestLogQueue.instance = new RequestLogQueue();
    }
    return RequestLogQueue.instance;
  }

  private encode(row: RequestLogRow): string {
    return this.mp.encode(row).toString('base64');
  }

  private decode(encoded: string): RequestLogRow {
    return this.mp.decode(Buffer.from(encoded, 'base64'));
  }

  async enqueue(row: RequestLogRow): Promise<void> {
    try {
      const client = await getRedisClient();
      await client.lPush(this.QUEUE_KEY, this.encode(row));
    } catch (error) {
      console.error('[REQUEST_LOG_QUEUE] Failed to enqueue:', error);
      console.log(`[REQUEST_LOG] ${JSON.stringify(row)}`);
    }
  }

  private async processQueue(): Promise<void> {
    const client = await getRedisClient();

    const lockAcquired = await client.set(this.LOCK_KEY, 'locked', {
      PX: this.LOCK_TTL * 1000,
      NX: true,
    });
    if (!lockAcquired) {
      return;
    }

    try {
      const queueLength = await client.lLen(this.QUEUE_KEY);
      if (queueLength === 0) return;

      if (queueLength > 5000) {
        console.warn(
          `[REQUEST_LOG_QUEUE] High backlog detected: ${queueLength} items`
        );
      }

      const batchSize = Math.min(1000, queueLength);
      const pipeline = client.multi();
      for (let i = 0; i < batchSize; i++) {
        pipeline.rPop(this.QUEUE_KEY);
      }
      const results = await pipeline.exec();
      if (!results || results.length === 0) return;

      const rows: RequestLogRow[] = [];
      for (const result of results) {
        if (result !== null && typeof result === 'string') {
          try {
            rows.push(this.decode(result));
          } catch (error) {
            console.error('[REQUEST_LOG_QUEUE] Failed to decode:', error);
          }
        }
      }

      if (rows.length === 0) return;

      await insertRequestLogs(rows);
    } catch (error) {
      console.error('[REQUEST_LOG_QUEUE] Error processing queue:', error);
    } finally {
      await client.del(this.LOCK_KEY);
    }
  }

  startProcessor(intervalMs = 5000): void {
    if (this.processingInterval) {
      console.log('[REQUEST_LOG_QUEUE] Processor already running');
      return;
    }
    this.processingInterval = setInterval(async () => {
      await this.processQueue();
    }, intervalMs);
  }

  stopProcessor(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
  }
}
