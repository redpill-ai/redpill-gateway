import { Context } from 'hono';
import { randomUUID } from 'crypto';
import { RequestLogQueue } from '../../services/requestLogQueue';
import { RequestLogErrorType, RequestLogRow } from '../../db/clickhouse';
import { VirtualKeyContext } from '../virtualKeyValidator';

export function statusToErrorType(status: number): RequestLogErrorType {
  if (status >= 200 && status < 300) return '';
  if (status === 429) return 'rate_limit';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 400 && status < 500) return 'upstream_4xx';
  if (status >= 500) return 'upstream_5xx';
  return 'gateway';
}

function formatTimestamp(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}

export const requestLogger = () => {
  return async (c: Context, next: any) => {
    const start = Date.now();
    const requestId = randomUUID();
    c.set('requestId', requestId);

    await next();

    if (!c.req.url.includes('/v1/')) return;

    const endpoint = new URL(c.req.url).pathname;
    const status = c.res.status;
    const ctx = c.get('virtualKeyContext') as VirtualKeyContext | undefined;
    const attemptIndex = (c.get('attemptIndex') as number | undefined) ?? 0;

    const contentType = c.res.headers.get('content-type') || '';
    const isStreaming = contentType.includes('text/event-stream');

    let ttftMs = 0;

    const emit = (durationMs: number) => {
      const row: RequestLogRow = {
        request_id: requestId,
        timestamp: formatTimestamp(new Date(start)),
        endpoint,
        model: ctx?.originalModel ?? '',
        provider: ctx?.providerConfig?.provider ?? '',
        model_deployment_id: ctx?.modelDeploymentId ?? 0,
        deployment_name: ctx?.deploymentName ?? '',
        attempt_index: attemptIndex,
        status_code: status,
        error_type: statusToErrorType(status),
        error_message: '',
        duration_ms: durationMs,
        ttft_ms: ttftMs,
        input_tokens: 0,
        output_tokens: 0,
        user_id: ctx?.virtualKeyWithUser?.user?.id ?? 0,
        virtual_key_id: ctx?.virtualKeyWithUser?.id ?? 0,
        is_streaming: isStreaming ? 1 : 0,
        cache_hit: 0,
      };

      RequestLogQueue.getInstance()
        .enqueue(row)
        .catch((err) => {
          const isAbort =
            err instanceof Error &&
            (err.name === 'AbortError' || err.message === 'aborted');
          if (isAbort) return;
          console.error('[REQUEST_LOG] enqueue failed:', err);
        });
    };

    if (isStreaming && c.res.body) {
      const transformStream = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk);
          // First non-empty chunk = TTFT. byteLength avoids cross-request
          // decoder state and is sufficient for "did data arrive."
          if (ttftMs === 0 && chunk.byteLength > 0) {
            ttftMs = Date.now() - start;
          }
        },
        flush() {
          emit(Date.now() - start);
        },
      });

      const transformed = c.res.body.pipeThrough(transformStream);
      c.res = new Response(transformed, {
        status: c.res.status,
        statusText: c.res.statusText,
        headers: c.res.headers,
      });
    } else {
      emit(Date.now() - start);
    }
  };
};
