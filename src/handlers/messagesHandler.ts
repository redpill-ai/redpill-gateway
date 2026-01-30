import { RouterError } from '../errors/RouterError';
import { tryWithDeploymentFailover } from './handlerUtils';
import { Context } from 'hono';

export async function messagesHandler(c: Context): Promise<Response> {
  try {
    const request = await c.req.json();
    const requestHeaders = Object.fromEntries(c.req.raw.headers);
    return await tryWithDeploymentFailover(
      c,
      request,
      requestHeaders,
      'messages',
      'POST'
    );
  } catch (err: any) {
    console.log('messages error', err.message);
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
