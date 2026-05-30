import { Context } from 'hono';
import { RouterError } from '../errors/RouterError';
import { endpointStrings } from '../providers/types';
import { tryWithDeploymentFailover } from './handlerUtils';
import { VirtualKeyContext } from '../middlewares/virtualKeyValidator';
import { Params } from '../types/requestBody';

type BuildVideoRequest = (c: Context) => Promise<Params> | Params;

const parseDurationSeconds = (duration: unknown): number => {
  if (typeof duration === 'number' && Number.isFinite(duration)) {
    return duration;
  }
  if (typeof duration !== 'string') {
    return 5;
  }
  const parsed = Number(duration.replace(/s$/i, ''));
  return Number.isFinite(parsed) ? parsed : 5;
};

const resolutionMultiplier = (resolution: unknown): number => {
  if (typeof resolution !== 'string') {
    return 1;
  }
  const normalized = resolution.toLowerCase();
  if (normalized.includes('2160') || normalized.includes('4k')) return 8;
  if (normalized.includes('1080')) return 4;
  if (normalized.includes('720')) return 2;
  return 1;
};

const numberFromConfig = (...values: unknown[]): number => {
  for (const value of values) {
    if (value == null || value === '') continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
  }
  return 0;
};

const getCurrentDeployment = (context: VirtualKeyContext | undefined) => {
  return context?.allDeployments?.find(
    (deployment) => deployment.id === context.modelDeploymentId
  );
};

export const videoRequestFromPath: BuildVideoRequest = (c: Context) => {
  const id = c.req.param('id');
  return {
    model: c.req.query('model') || '',
    id,
    queue_id: id,
  };
};

export default function videoHandler(
  endpoint: endpointStrings,
  method: string,
  buildRequest?: BuildVideoRequest
) {
  return async (c: Context): Promise<Response> => {
    try {
      const request = buildRequest ? await buildRequest(c) : await c.req.json();
      const requestHeaders = Object.fromEntries(c.req.raw.headers);
      return await tryWithDeploymentFailover(
        c,
        request,
        requestHeaders,
        endpoint,
        method
      );
    } catch (err: any) {
      console.error(`${endpoint} error: `, err);
      let statusCode = 500;
      let errorMessage = 'Something went wrong';

      if (err instanceof RouterError) {
        statusCode = 400;
        errorMessage = err.message;
      }

      return new Response(
        JSON.stringify({
          status: 'failure',
          message: errorMessage,
        }),
        {
          status: statusCode,
          headers: {
            'content-type': 'application/json',
          },
        }
      );
    }
  };
}

export async function videoQuoteHandler(c: Context): Promise<Response> {
  try {
    const request = await c.req.json();
    const virtualKeyContext = c.get('virtualKeyContext') as VirtualKeyContext;
    const deployment = getCurrentDeployment(virtualKeyContext);
    const config = deployment?.config ?? {};
    const specs = (deployment?.model_specs ?? {}) as Record<string, unknown>;

    const duration = parseDurationSeconds(request.duration);
    const resolution = request.resolution ?? '768p';
    const upscaleFactor =
      typeof request.upscale_factor === 'number' ? request.upscale_factor : 1;

    const requestCost = numberFromConfig(
      specs.request_cost,
      config.request_cost
    );
    const outputCost = numberFromConfig(
      specs.output_cost_per_token,
      config.output_cost_per_token
    );
    const cost =
      requestCost +
      outputCost * duration * resolutionMultiplier(resolution) * upscaleFactor;

    return new Response(
      JSON.stringify({
        model: request.model,
        cost_usd: cost,
        currency: 'USD',
        breakdown: {
          duration,
          resolution,
          upscale_factor: upscaleFactor,
        },
      }),
      {
        headers: {
          'content-type': 'application/json',
        },
      }
    );
  } catch (err: any) {
    console.error('quoteVideo error: ', err);
    return new Response(
      JSON.stringify({
        status: 'failure',
        message: 'Something went wrong',
      }),
      {
        status: 500,
        headers: {
          'content-type': 'application/json',
        },
      }
    );
  }
}

export async function videoCompleteHandler(c: Context): Promise<Response> {
  try {
    const request = await c.req.json();
    return new Response(
      JSON.stringify({
        ok: true,
        queue_id: request.queue_id ?? request.id,
      }),
      {
        headers: {
          'content-type': 'application/json',
        },
      }
    );
  } catch (err: any) {
    console.error('completeVideo error: ', err);
    return new Response(
      JSON.stringify({
        status: 'failure',
        message: 'Something went wrong',
      }),
      {
        status: 500,
        headers: {
          'content-type': 'application/json',
        },
      }
    );
  }
}
