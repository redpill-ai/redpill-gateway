import { RouterError } from '../errors/RouterError';
import { tryWithDeploymentFailover } from './handlerUtils';
import { Context } from 'hono';

export async function completionsHandler(c: Context): Promise<Response> {
  try {
    const request = await c.req.json();
    const requestHeaders = Object.fromEntries(c.req.raw.headers);
    return await tryWithDeploymentFailover(
      c,
      request,
      requestHeaders,
      'complete',
      'POST'
    );
  } catch (err: any) {
    console.error('completionsHandler error: ', err);
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
}
