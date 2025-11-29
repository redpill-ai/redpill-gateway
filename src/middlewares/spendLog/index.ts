import { Context } from 'hono';
import { SpendQueue } from '../../services/spendQueue';
import { VirtualKeyContext } from '../virtualKeyValidator/index';

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
}

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

function extractUsageFromStreamChunk(chunkText: string): Usage | null {
  try {
    // Skip non-data lines
    if (!chunkText.startsWith('data: ')) {
      return null;
    }

    const dataText = chunkText.slice(6).trim(); // Remove 'data: ' prefix

    // Skip [DONE] marker
    if (dataText === '[DONE]') {
      return null;
    }

    const chunkData = JSON.parse(dataText);
    return chunkData.usage || null;
  } catch (error) {
    return null;
  }
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
    originalModel,
    modelDeploymentId,
  } = virtualKeyContext;

  const queueData = {
    time: spendData.time,
    method: spendData.method,
    endpoint: spendData.endpoint,
    status: spendData.status,
    duration: spendData.duration,
    usage: {
      input_tokens: usage.input_tokens || usage.prompt_tokens || 0,
      output_tokens: usage.output_tokens || usage.completion_tokens || 0,
    },
    rawUsage: JSON.stringify(usage),
    userId: virtualKeyWithUser.user.id,
    virtualKeyId: virtualKeyWithUser.id,
    provider: providerConfig?.provider || 'unknown',
    model: originalModel,
    modelDeploymentId: modelDeploymentId,
    pricing: {
      inputCostPerToken: pricing?.inputCostPerToken || 0,
      outputCostPerToken: pricing?.outputCostPerToken || 0,
    },
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

        // Create a transform stream to intercept and parse chunks
        const transformStream = new TransformStream({
          transform(chunk, controller) {
            // Pass through the chunk unchanged
            controller.enqueue(chunk);

            // Try to extract usage from this chunk
            // Always update to the latest usage (not just the first one)
            // because providers may emit usage on every chunk, with only the final one being accurate
            const chunkText = textDecoder.decode(chunk);
            const lines = chunkText.split('\n');

            for (const line of lines) {
              const usage = extractUsageFromStreamChunk(line);
              if (usage) {
                streamUsage = usage;
              }
            }
          },

          flush() {
            // Log spend data when stream ends
            if (streamUsage) {
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
        const responseData = await responseClone.json();

        const usage = extractUsageFromResponse(responseData);
        if (usage) {
          processSpendData({
            time: new Date().toISOString(),
            method,
            endpoint,
            status,
            duration,
            usage,
            virtualKeyContext,
          });
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
