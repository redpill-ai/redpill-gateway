import { Context } from 'hono';

interface StreamUsageCollector {
  usage: any | null;
  hasUsage: boolean;
}

function extractUsageFromResponse(responseData: any): any | null {
  if (!responseData || typeof responseData !== 'object') {
    return null;
  }

  return responseData.usage || null;
}

function extractUsageFromStreamChunk(chunkText: string): any | null {
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

function logSpendData(spendData: any): void {
  console.log(`[SPEND_LOG] ${JSON.stringify(spendData, null, 2)}`);
}

export const spendLogger = () => {
  return async (c: Context, next: any) => {
    const start = Date.now();

    await next();

    if (!c.req.url.includes('/v1/')) return;

    const method = c.req.method;
    const endpoint = new URL(c.req.url).pathname;
    const status = c.res.status;
    const duration = Date.now() - start;
    const requestOptionsArray = c.get('requestOptions');

    try {
      const contentType = c.res.headers.get('content-type') || '';

      // Handle streaming responses
      if (contentType.includes('text/event-stream')) {
        const usageCollector: StreamUsageCollector = {
          usage: null,
          hasUsage: false,
        };

        // Create a transform stream to intercept and parse chunks
        const transformStream = new TransformStream({
          transform(chunk, controller) {
            // Pass through the chunk unchanged
            controller.enqueue(chunk);

            // Try to extract usage from this chunk
            const chunkText = new TextDecoder().decode(chunk);
            const lines = chunkText.split('\n');

            for (const line of lines) {
              const usage = extractUsageFromStreamChunk(line);
              if (usage) {
                usageCollector.usage = usage;
                usageCollector.hasUsage = true;
              }
            }
          },

          flush() {
            // Log spend data when stream ends
            if (usageCollector.hasUsage) {
              const spendData = {
                time: new Date().toISOString(),
                method,
                endpoint,
                status,
                duration,
                usage: usageCollector.usage,
                requestOptions: requestOptionsArray,
              };

              logSpendData(spendData);
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
          const spendData = {
            time: new Date().toISOString(),
            method,
            endpoint,
            status,
            duration,
            usage,
            requestOptions: requestOptionsArray,
          };

          logSpendData(spendData);
        }
      }
    } catch (error) {
      console.error('Error extracting spend log information:', error);
    }
  };
};
