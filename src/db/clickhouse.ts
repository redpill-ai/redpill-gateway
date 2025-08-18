import { createClient, ClickHouseClient } from '@clickhouse/client';
import { env } from '../constants';

let clickhouseClient: ClickHouseClient | null = null;

export async function getClickHouseClient(): Promise<ClickHouseClient> {
  if (!clickhouseClient) {
    clickhouseClient = createClient({
      url: env.CLICKHOUSE_URL,
      username: env.CLICKHOUSE_USERNAME,
      password: env.CLICKHOUSE_PASSWORD,
      database: env.CLICKHOUSE_DATABASE,
    });
  }

  return clickhouseClient;
}

export interface SpendLogRow {
  timestamp: string;
  endpoint: string;
  duration_ms: number;
  user_id: number;
  virtual_key_id: number;
  provider: string;
  model: string;
  model_deployment_id: number;
  input_tokens: number;
  output_tokens: number;
  input_cost_per_token: string;
  output_cost_per_token: string;
}

export async function insertSpendLogs(logs: SpendLogRow[]): Promise<void> {
  if (logs.length === 0) return;

  try {
    const client = await getClickHouseClient();

    await client.insert({
      table: 'spend_logs',
      values: logs,
      format: 'JSONEachRow',
    });
  } catch (error) {
    console.error('[CLICKHOUSE] Failed to insert spend logs:', error);
    throw error;
  }
}
