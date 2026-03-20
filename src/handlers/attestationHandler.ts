import { Context } from 'hono';
import { proxyHandler } from './proxyHandler';
import { fetchIntelQuote, TinfoilError } from '../services/tinfoilService';
import {
  fetchChutesAttestation,
  getChuteIdByName,
  clearChuteIdCache,
  ChutesError,
} from '../services/chutesService';
import { updateVirtualKeyContextForDeployment } from './handlerUtils';

/**
 * Attestation handler for /v1/attestation/report and /v1/signature/*
 * For Tinfoil provider: fetches intel_quote directly from enclave
 * For other providers: overrides model parameter and proxies request
 */
export async function attestationHandler(c: Context): Promise<Response> {
  const virtualKeyContext = c.get('virtualKeyContext');

  const signingAddress = c.req.query('signing_address');
  if (signingAddress && virtualKeyContext?.allDeployments?.length) {
    const matched = virtualKeyContext.allDeployments.find(
      (d: any) => d.config?.signing_address === signingAddress
    );
    if (matched) {
      updateVirtualKeyContextForDeployment(c, matched);
    }
  }

  // Handle Tinfoil provider separately
  if (virtualKeyContext?.providerConfig?.provider === 'tinfoil') {
    const modelId = virtualKeyContext.deploymentName;

    try {
      const result = await fetchIntelQuote(modelId);
      const response = {
        attestation_type: 'tinfoil',
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

  // Handle Chutes provider
  if (virtualKeyContext?.providerConfig?.provider === 'chutes') {
    const modelName = virtualKeyContext.deploymentName;
    const apiKey = virtualKeyContext.providerConfig.apiKey;
    const baseUrl = virtualKeyContext.providerConfig.customHost;

    try {
      // Lookup chute_id by model name (cached for 60 minutes)
      const chuteId = await getChuteIdByName(modelName, apiKey, baseUrl);
      const result = await fetchChutesAttestation(chuteId, apiKey, baseUrl);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    } catch (error) {
      console.error(error);
      // Clear cache on error so next request will retry
      clearChuteIdCache(modelName);
      const message =
        error instanceof Error ? error.message : 'Unknown error occurred';
      const statusCode = error instanceof ChutesError ? error.statusCode : 500;
      return new Response(
        JSON.stringify({
          error: {
            message,
            type: 'chutes_attestation_error',
          },
        }),
        {
          status: statusCode,
          headers: { 'content-type': 'application/json' },
        }
      );
    }
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
