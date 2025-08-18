import { getRedisClient, buildCacheKey } from '../db/redis';
import { updateUserBudgetsBatch } from '../db/postgres/user';
import { updateVirtualKeyBudgetsBatch } from '../db/postgres/virtualKey';
import { insertSpendLogs, SpendLogRow } from '../db/clickhouse';
import Decimal from 'decimal.js';
import msgpack from 'msgpack5';

interface SpendData {
  time: string;
  method: string;
  endpoint: string;
  status: number;
  duration: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
  userId: number;
  virtualKeyId: number;
  provider: string;
  model: string;
  modelDeploymentId: number;
  pricing: {
    inputCostPerToken: number;
    outputCostPerToken: number;
  };
}

export class SpendQueue {
  private static instance: SpendQueue;
  private readonly mp = msgpack();
  private readonly SPEND_QUEUE_KEY = buildCacheKey('spend', 'queue');
  private readonly SPEND_LOCK_KEY = buildCacheKey('spend', 'lock');
  private readonly LOCK_TTL = 30; // 30 seconds
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

      // Get batch of spend data from queue
      const batchSize = Math.min(500, queueLength);

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

      // Calculate costs and group by user/key
      const userSpends = new Map<number, Decimal>();
      const keySpends = new Map<number, Decimal>();
      const clickhouseLogs: SpendLogRow[] = [];

      for (const spendData of spendDataList) {
        try {
          const inputTokens = spendData.usage.input_tokens || 0;
          const outputTokens = spendData.usage.output_tokens || 0;

          // Use actual pricing from deployment config
          const inputCost = new Decimal(inputTokens).mul(
            new Decimal(spendData.pricing.inputCostPerToken)
          );
          const outputCost = new Decimal(outputTokens).mul(
            new Decimal(spendData.pricing.outputCostPerToken)
          );
          const cost = inputCost.add(outputCost);

          if (cost.isZero()) continue;

          // Aggregate costs
          const currentUserSpend =
            userSpends.get(spendData.userId) || new Decimal(0);
          userSpends.set(spendData.userId, currentUserSpend.add(cost));

          const currentKeySpend =
            keySpends.get(spendData.virtualKeyId) || new Decimal(0);
          keySpends.set(spendData.virtualKeyId, currentKeySpend.add(cost));

          // Prepare ClickHouse log entry
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
            model_deployment_id: spendData.modelDeploymentId,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            input_cost_per_token:
              spendData.pricing.inputCostPerToken.toString(),
            output_cost_per_token:
              spendData.pricing.outputCostPerToken.toString(),
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
