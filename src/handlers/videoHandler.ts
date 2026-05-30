import { Context } from 'hono';
import { RouterError } from '../errors/RouterError';
import { endpointStrings } from '../providers/types';
import { tryWithDeploymentFailover } from './handlerUtils';

export default function videoHandler(
  endpoint: endpointStrings,
  method: string
) {
  return async (c: Context): Promise<Response> => {
    try {
      const request = await c.req.json();
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
