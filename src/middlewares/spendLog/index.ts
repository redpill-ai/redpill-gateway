import { Context } from 'hono';
import { SpendQueue } from '../../services/spendQueue';
import { VirtualKeyContext } from '../virtualKeyValidator/index';
import { computeCost, resolveUsage, Usage } from '../../services/pricing';

interface RequestSpendData {
  time: string;
  method: string;
  endpoint: string;
  status: number;
  duration: number;
  usage: Usage;
  virtualKeyContext: VirtualKeyContext;
}

function extractUsageFromResponse(responseData: any): Usage | null {
  if (!responseData || typeof responseData !== 'object') {
    return null;
  }

  return responseData.usage || null;
}

async function processSpendData(spendData: RequestSpendData): Promise<void> {
  const { virtualKeyContext, usage } = spendData;

  if (!virtualKeyContext?.virtualKeyWithUser) {
    console.warn(
      '[SPEND_LOG] No virtual key context found, skipping spend processing'
    );
    return;
  }

  const {
    virtualKeyWithUser,
    providerConfig,
    pricing,
    modelId,
    requestModel,
    modelDeploymentId,
    spendMode,
  } = virtualKeyContext;

  const resolved = resolveUsage(usage);

  const queueData = {
    time: spendData.time,
    method: spendData.method,
    endpoint: spendData.endpoint,
    status: spendData.status,
    duration: spendData.duration,
    usage: {
      // Store total input (OpenAI semantics) — matches spend_logs.input_tokens
      // which is the total prompt tokens including the cached subset; cache
      // counts go in their own columns and are subtracted by the materialized
      // input_cost expression.
      input_tokens: resolved.promptTokens,
      output_tokens: resolved.completionTokens,
      cache_read_input_tokens: resolved.cacheReadTokens,
      cache_creation_input_tokens: resolved.cacheCreationTokens,
    },
    rawUsage: JSON.stringify(usage),
    userId: virtualKeyWithUser.user.id,
    virtualKeyId: virtualKeyWithUser.id,
    provider: providerConfig?.provider || 'unknown',
    // `model` = resolved canonical id (analytics/billing key);
    // `requestModel` = raw client string (debug/deprecation tracking).
    model: modelId,
    requestModel,
    modelDeploymentId: modelDeploymentId,
    pricing: {
      inputCostPerToken: pricing?.inputCostPerToken ?? 0,
      outputCostPerToken: pricing?.outputCostPerToken ?? 0,
      cacheReadCostPerToken: pricing?.cacheReadCostPerToken ?? null,
      cacheCreationCostPerToken: pricing?.cacheCreationCostPerToken ?? null,
    },
    spendMode,
  };

  try {
    await SpendQueue.getInstance().enqueueSpendData(queueData);
  } catch (error: unknown) {
    const isAbort =
      error instanceof Error &&
      (error.name === 'AbortError' || error.message === 'aborted');
    // If the request was already aborted/shutdown, avoid crashing the process.
    if (isAbort) {
      console.warn('[SPEND_LOG] enqueue aborted, skipping.');
      return;
    }
    console.error('[SPEND_LOG] Failed to enqueue spend data:', error);
  }
}

export const spendLogger = () => {
  const textDecoder = new TextDecoder();
  const textEncoder = new TextEncoder();

  return async (c: Context, next: any) => {
    const start = Date.now();

    await next();

    if (!c.req.url.includes('/v1/')) return;

    const method = c.req.method;
    const endpoint = new URL(c.req.url).pathname;
    const status = c.res.status;
    const duration = Date.now() - start;
    const virtualKeyContext = c.get('virtualKeyContext');

    try {
      const contentType = c.res.headers.get('content-type') || '';

      // Handle streaming responses
      if (contentType.includes('text/event-stream')) {
        let streamUsage: Usage | null = null;

        // Intercept SSE chunks: splice usage.cost into the final usage
        // payload; pass everything else through byte-for-byte.
        const transformStream = new TransformStream({
          transform(chunk, controller) {
            const chunkText = textDecoder.decode(chunk);
            const lines = chunkText.split('\n');

            let rewritten = false;
            const outLines = lines.map((line) => {
              if (!line.startsWith('data: ')) return line;
              const dataText = line.slice(6).trim();
              if (dataText === '[DONE]') return line;

              let parsed: any;
              try {
                parsed = JSON.parse(dataText);
              } catch {
                // Likely a chunk-boundary-split JSON payload — emit unchanged.
                return line;
              }
              if (!parsed?.usage) return line;

              // Set streamUsage before any potential rewrite so the audit
              // trail in flush() sees the upstream value, not our derived cost.
              streamUsage = parsed.usage;

              if (!virtualKeyContext?.pricing) return line;

              const cost = computeCost(parsed.usage, virtualKeyContext.pricing);
              rewritten = true;
              return `data: ${JSON.stringify({
                ...parsed,
                usage: { ...parsed.usage, cost },
              })}`;
            });

            controller.enqueue(
              rewritten ? textEncoder.encode(outLines.join('\n')) : chunk
            );
          },

          flush() {
            // Log spend data when stream ends
            if (streamUsage) {
              // Share the extracted usage with requestLogger (outer middleware
              // wraps this stream, so its flush fires after this one).
              c.set('extractedUsage', streamUsage);
              processSpendData({
                time: new Date().toISOString(),
                method,
                endpoint,
                status,
                duration,
                usage: streamUsage,
                virtualKeyContext,
              });
            }
          },
        });

        // Replace the response body with our transformed stream
        const originalBody = c.res.body;
        if (originalBody) {
          const transformedStream = originalBody.pipeThrough(transformStream);
          c.res = new Response(transformedStream, {
            status: c.res.status,
            statusText: c.res.statusText,
            headers: c.res.headers,
          });
        }
      }
      // Handle regular JSON responses
      else if (contentType.includes('application/json')) {
        const responseClone = c.res.clone();
        const responseData: any = await responseClone.json();

        const usage = extractUsageFromResponse(responseData);
        if (usage) {
          // Share the extracted usage with requestLogger (outer middleware
          // runs its after-section right after this one).
          c.set('extractedUsage', usage);
          processSpendData({
            time: new Date().toISOString(),
            method,
            endpoint,
            status,
            duration,
            usage,
            virtualKeyContext,
          });

          if (virtualKeyContext?.pricing) {
            const cost = computeCost(usage, virtualKeyContext.pricing);
            // Replace, don't mutate — `usage` is the same object reference
            // held by `extractedUsage` on the Hono context.
            responseData.usage = { ...responseData.usage, cost };
            // Hono's c.res setter copies the *old* response's headers onto
            // the new one (except content-type). The rewritten body is a
            // different length, so the stale content-length must be
            // stripped from the old headers before assignment — otherwise
            // it overrides the value the runtime would compute and the
            // client sees a truncated response.
            c.res.headers.delete('content-length');
            c.res = new Response(JSON.stringify(responseData), {
              status: c.res.status,
              statusText: c.res.statusText,
              headers: c.res.headers,
            });
          }
        }
      }
    } catch (error: unknown) {
      const isAbort =
        error instanceof Error &&
        (error.name === 'AbortError' || error.message === 'aborted');
      // Swallow client/stream aborts to avoid unhandled rejections on shutdown.
      if (isAbort) {
        console.warn('Spend log extraction aborted, skipping.');
        return;
      }
      console.error('Error extracting spend log information:', error);
    }
  };
};
