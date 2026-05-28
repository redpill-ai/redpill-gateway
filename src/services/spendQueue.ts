import { getRedisClient, buildCacheKey } from '../db/redis';
import { updateUserBudgetsBatch } from '../db/postgres/user';
import { updateVirtualKeyBudgetsBatch } from '../db/postgres/virtualKey';
import { insertSpendLogs, SpendLogRow } from '../db/clickhouse';
import { SpendMode } from '../middlewares/virtualKeyValidator';
import { computeCost, isPriced } from './pricing';
import Decimal from 'decimal.js';
import msgpack from 'msgpack5';

interface SpendData {
  time: string;
  method: string;
  endpoint: string;
  status: number;
  duration: number;
  usage: {
    /** Total prompt tokens (OpenAI semantics — includes the cached subset). */
    input_tokens: number;
    output_tokens: number;
    /** Cached read tokens. Always present (0 when no cache hit). */
    cache_read_input_tokens: number;
    /** Cache write tokens (Anthropic). Always present (0 when not applicable). */
    cache_creation_input_tokens: number;
  };
  rawUsage: string;
  userId: number;
  virtualKeyId: number;
  provider: string;
  /** Resolved canonical models.model_id — what was actually served. */
  model: string;
  /** Raw model string from the client's HTTP body — alias or canonical. */
  requestModel: string;
  modelDeploymentId: number;
  pricing: {
    inputCostPerToken: number | string;
    outputCostPerToken: number | string;
    /** Null = model doesn't sell cache-tier pricing; cache tokens fall back
     *  to inputCostPerToken (handled in shared computeCost). */
    cacheReadCostPerToken: number | string | null;
    cacheCreationCostPerToken: number | string | null;
  };
  /**
   * Determines how spending is tracked for a request:
   * - 'regular': Normal key - update user budget + credits, update key budget
   * - 'subscription': Subscription key within quota - only update key budget_used
   * - 'subscription_overflow': Subscription key over quota - same as regular (update user budget + credits, update key budget)
   */
  spendMode: SpendMode;
}

export class SpendQueue {
  private static instance: SpendQueue;
  private readonly mp = msgpack();
  private readonly SPEND_QUEUE_KEY = buildCacheKey('spend', 'queue');
  private readonly SPEND_LOCK_KEY = buildCacheKey('spend', 'lock');
  private readonly LOCK_TTL = 60; // 60 seconds
  private processingInterval: NodeJS.Timeout | null = null;

  private constructor() {}

  static getInstance(): SpendQueue {
    if (!SpendQueue.instance) {
      SpendQueue.instance = new SpendQueue();
    }
    return SpendQueue.instance;
  }

  private encodeSpendData(data: SpendData): string {
    return this.mp.encode(data).toString('base64');
  }

  private decodeSpendData(encodedData: string): SpendData {
    return this.mp.decode(Buffer.from(encodedData, 'base64'));
  }

  async enqueueSpendData(spendData: SpendData): Promise<void> {
    try {
      const client = await getRedisClient();
      const encodedData = this.encodeSpendData(spendData);
      await client.lPush(this.SPEND_QUEUE_KEY, encodedData);
    } catch (error) {
      console.error('[SPEND_QUEUE] Failed to enqueue spend data:', error);
      console.log(`[SPEND_LOG] ${JSON.stringify(spendData, null, 2)}`);
    }
  }

  private async processSpendQueue(): Promise<void> {
    const client = await getRedisClient();

    // Try to acquire distributed lock
    const lockAcquired = await client.set(this.SPEND_LOCK_KEY, 'locked', {
      PX: this.LOCK_TTL * 1000,
      NX: true,
    });

    if (!lockAcquired) {
      console.log('[SPEND_QUEUE] Another instance is processing, skipping...');
      return;
    }

    try {
      // Check queue length before processing
      const queueLength = await client.lLen(this.SPEND_QUEUE_KEY);

      if (queueLength === 0) {
        return;
      }

      // Alert when queue is backing up
      if (queueLength > 5000) {
        console.warn(
          `[SPEND_QUEUE] High backlog detected: ${queueLength} items in queue`
        );
      }

      // Get batch of spend data from queue
      const batchSize = Math.min(1000, queueLength);

      const pipeline = client.multi();
      for (let i = 0; i < batchSize; i++) {
        pipeline.rPop(this.SPEND_QUEUE_KEY);
      }
      const results = await pipeline.exec();

      if (!results || results.length === 0) {
        return;
      }

      const spendDataList: SpendData[] = [];

      for (let i = 0; i < results.length; i++) {
        const result = results[i];

        if (result !== null && typeof result === 'string') {
          try {
            const parsed = this.decodeSpendData(result);
            spendDataList.push(parsed);
          } catch (error) {
            console.error('[SPEND_QUEUE] Failed to decode spend data:', error);
          }
        }
      }

      if (spendDataList.length === 0) {
        return;
      }

      // Aggregate spends by user and key
      const userSpends = new Map<number, Decimal>();
      const keySpends = new Map<number, Decimal>();

      const clickhouseLogs: SpendLogRow[] = [];

      for (const spendData of spendDataList) {
        try {
          // Shared cost formula — same one spendLog middleware uses to inject
          // `usage.cost` into the live response, so client-visible cost matches
          // what we record. Handles cache buckets, null-price fallback, etc.
          const cost = new Decimal(
            computeCost(spendData.usage, spendData.pricing)
          );

          if (cost.isZero()) continue;

          // Aggregate key spend (always track key usage)
          const currentKeySpend =
            keySpends.get(spendData.virtualKeyId) || new Decimal(0);
          keySpends.set(spendData.virtualKeyId, currentKeySpend.add(cost));

          // Aggregate user spend based on mode
          // - regular/subscription_overflow: update user budget_used + deduct credits
          // - subscription: no user spend (using subscription quota)
          if (spendData.spendMode !== 'subscription') {
            const currentUserSpend =
              userSpends.get(spendData.userId) || new Decimal(0);
            userSpends.set(spendData.userId, currentUserSpend.add(cost));
          }

          // Prepare ClickHouse log entry (always log regardless of key type).
          // Cache rates write as-is (or null when unset); the materialized
          // total_cost coalesces null → input_cost_per_token.
          const sp = spendData.pricing;
          clickhouseLogs.push({
            timestamp: new Date(spendData.time)
              .toISOString()
              .replace('T', ' ')
              .replace('Z', ''),
            endpoint: spendData.endpoint,
            duration_ms: spendData.duration,
            user_id: spendData.userId,
            virtual_key_id: spendData.virtualKeyId,
            provider: spendData.provider,
            model: spendData.model,
            request_model: spendData.requestModel,
            model_deployment_id: spendData.modelDeploymentId,
            input_tokens: spendData.usage.input_tokens,
            output_tokens: spendData.usage.output_tokens,
            cache_read_input_tokens: spendData.usage.cache_read_input_tokens,
            cache_creation_input_tokens:
              spendData.usage.cache_creation_input_tokens,
            raw_usage: spendData.rawUsage,
            input_cost_per_token:
              spendData.pricing.inputCostPerToken.toString(),
            output_cost_per_token:
              spendData.pricing.outputCostPerToken.toString(),
            cache_read_cost_per_token: isPriced(sp.cacheReadCostPerToken)
              ? sp.cacheReadCostPerToken.toString()
              : null,
            cache_creation_cost_per_token: isPriced(
              sp.cacheCreationCostPerToken
            )
              ? sp.cacheCreationCostPerToken.toString()
              : null,
          });
        } catch (error) {
          console.error(
            '[SPEND_QUEUE] Error processing individual spend record:',
            error
          );
          console.error(
            '[SPEND_QUEUE] Problematic data:',
            JSON.stringify(spendData)
          );
          // Continue processing other records
        }
      }

      // Update budgets and insert ClickHouse logs
      await Promise.all([
        updateUserBudgetsBatch(userSpends),
        updateVirtualKeyBudgetsBatch(keySpends),
        insertSpendLogs(clickhouseLogs),
      ]);
    } catch (error) {
      console.error('[SPEND_QUEUE] Error processing spend queue:', error);
    } finally {
      // Always release the lock
      await client.del(this.SPEND_LOCK_KEY);
    }
  }

  startSpendProcessor(intervalMs = 5000): void {
    if (this.processingInterval) {
      console.log('[SPEND_QUEUE] Processor already running');
      return;
    }

    this.processingInterval = setInterval(async () => {
      await this.processSpendQueue();
    }, intervalMs);
  }

  stopSpendProcessor(): void {
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = null;
    }
  }
}
