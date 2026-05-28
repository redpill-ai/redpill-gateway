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
  /** Resolved `models.model_id` — what was actually served. Empty when the
   *  gateway rejected before selecting a deployment (fail-fast traffic). */
  model: string;
  /** Raw model string from the client's HTTP body (alias or canonical). */
  request_model: string;
  model_deployment_id: number;
  /** Total prompt tokens (OpenAI semantics, includes cached subset).
   *  Materialized input_cost subtracts cache_read + cache_creation here. */
  input_tokens: number;
  output_tokens: number;
  /** Tokens served from prompt cache. 0 when upstream didn't surface a hit. */
  cache_read_input_tokens: number;
  /** Tokens written to prompt cache (Anthropic). 0 elsewhere. */
  cache_creation_input_tokens: number;
  raw_usage: string;
  input_cost_per_token: string;
  output_cost_per_token: string;
  /** Per-token cache rates at request time, or null when the model has no
   *  cache-tier pricing configured. The materialized total_cost coalesces
   *  null → input_cost_per_token to bill cache tokens at full input rate. */
  cache_read_cost_per_token: string | null;
  cache_creation_cost_per_token: string | null;
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

export type RequestLogErrorType =
  | ''
  | 'timeout'
  | 'rate_limit'
  | 'upstream_5xx'
  | 'upstream_4xx'
  | 'gateway';

export interface RequestLogRow {
  request_id: string;
  timestamp: string;
  endpoint: string;
  /** Resolved `models.model_id` — what was actually served. Empty when the
   *  gateway rejected before selecting a deployment (fail-fast traffic). */
  model: string;
  /** Raw model string from the client's HTTP body (alias or canonical). */
  request_model: string;
  provider: string;
  model_deployment_id: number;
  deployment_name: string;
  attempt_index: number;
  status_code: number;
  error_type: RequestLogErrorType;
  error_message: string;
  duration_ms: number;
  ttft_ms: number;
  input_tokens: number;
  output_tokens: number;
  /** Tokens served from prompt cache. 0 on failed/non-billable attempts. */
  cache_read_input_tokens: number;
  /** Tokens written to prompt cache (Anthropic). 0 elsewhere. */
  cache_creation_input_tokens: number;
  user_id: number;
  virtual_key_id: number;
  is_streaming: number;
  cache_hit: number;
}

export async function insertRequestLogs(logs: RequestLogRow[]): Promise<void> {
  if (logs.length === 0) return;

  try {
    const client = await getClickHouseClient();

    await client.insert({
      table: 'request_logs',
      values: logs,
      format: 'JSONEachRow',
    });
  } catch (error) {
    console.error('[CLICKHOUSE] Failed to insert request logs:', error);
    throw error;
  }
}
