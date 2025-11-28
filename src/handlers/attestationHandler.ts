import { Context } from 'hono';
import { proxyHandler } from './proxyHandler';

/**
 * Attestation handler for /v1/attestation/report and /v1/signature/*
 * Overrides the model parameter with deploymentName from virtualKeyContext
 */
export async function attestationHandler(c: Context): Promise<Response> {
  const virtualKeyContext = c.get('virtualKeyContext');

  if (virtualKeyContext?.deploymentName) {
    const url = new URL(c.req.url);
    url.searchParams.set('model', virtualKeyContext.deploymentName);

    Object.defineProperty(c.req, 'url', {
      value: url.toString(),
    });
  }

  return proxyHandler(c);
}
