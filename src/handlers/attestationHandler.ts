import { Context } from 'hono';
import { proxyHandler } from './proxyHandler';
import { fetchIntelQuote, TinfoilError } from '../services/tinfoilService';

/**
 * Attestation handler for /v1/attestation/report and /v1/signature/*
 * For Tinfoil provider: fetches intel_quote directly from enclave
 * For other providers: overrides model parameter and proxies request
 */
export async function attestationHandler(c: Context): Promise<Response> {
  const virtualKeyContext = c.get('virtualKeyContext');

  // Handle Tinfoil provider separately
  if (virtualKeyContext?.providerConfig?.provider === 'tinfoil') {
    const modelId = virtualKeyContext.deploymentName;

    try {
      const result = await fetchIntelQuote(modelId);
      const response = {
        intel_quote: result.intel_quote,
        all_attestations: [{ intel_quote: result.intel_quote }],
      };
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    } catch (error) {
      console.error(error);
      const message =
        error instanceof Error ? error.message : 'Unknown error occurred';
      const statusCode = error instanceof TinfoilError ? error.statusCode : 500;
      return new Response(
        JSON.stringify({
          error: {
            message,
            type: 'tinfoil_attestation_error',
          },
        }),
        {
          status: statusCode,
          headers: { 'content-type': 'application/json' },
        }
      );
    }
  }

  // Handle Chutes provider - attestation not yet supported
  if (virtualKeyContext?.providerConfig?.provider === 'chutes') {
    return new Response(
      JSON.stringify({
        all_attestations: [],
      }),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }
    );
  }

  // For other providers, use proxy handler
  if (virtualKeyContext?.deploymentName) {
    const url = new URL(c.req.url);
    url.searchParams.set('model', virtualKeyContext.deploymentName);

    Object.defineProperty(c.req, 'url', {
      value: url.toString(),
    });
  }

  return proxyHandler(c);
}
