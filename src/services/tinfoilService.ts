import yaml from 'js-yaml';

export class TinfoilError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500
  ) {
    super(message);
    this.name = 'TinfoilError';
  }
}

const CONFIG_URL =
  'https://raw.githubusercontent.com/tinfoilsh/confidential-model-router/refs/heads/main/config.yml';
const CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes
const EXPECTED_FORMAT_PREFIX = 'https://tinfoil.sh/predicate/tdx-guest/';

interface ConfigCache {
  modelMap: Record<string, string>;
  timestamp: number;
}

let configCache: ConfigCache | null = null;
let fetchPromise: Promise<Record<string, string>> | null = null;

/**
 * Fetches and caches the model -> enclave host mapping from GitHub
 */
async function getModelMap(): Promise<Record<string, string>> {
  const now = Date.now();

  if (configCache && now - configCache.timestamp < CACHE_TTL_MS) {
    return configCache.modelMap;
  }

  // Prevent concurrent fetches
  if (fetchPromise) {
    return fetchPromise;
  }

  fetchPromise = (async () => {
    try {
      const response = await fetch(CONFIG_URL);
      if (!response.ok) {
        throw new TinfoilError(
          `Failed to fetch Tinfoil config: ${response.status} ${response.statusText}`,
          502
        );
      }

      const configText = await response.text();
      const config = yaml.load(configText) as {
        models?: Record<string, { enclaves?: string[] }>;
      };

      const modelMap: Record<string, string> = {};

      if (config.models) {
        for (const [modelName, modelData] of Object.entries(config.models)) {
          if (
            modelData.enclaves &&
            Array.isArray(modelData.enclaves) &&
            modelData.enclaves.length > 0
          ) {
            modelMap[modelName] = modelData.enclaves[0];
          }
        }
      }

      configCache = { modelMap, timestamp: Date.now() };
      return modelMap;
    } finally {
      fetchPromise = null;
    }
  })();

  return fetchPromise;
}

/**
 * Converts a Uint8Array to a hex string
 */
function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Decompresses gzip data using DecompressionStream (Web API)
 */
async function gunzip(compressedData: Uint8Array): Promise<Uint8Array> {
  const stream = new DecompressionStream('gzip');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();

  writer.write(compressedData);
  writer.close();

  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

/**
 * Decodes a base64 string to Uint8Array
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Fetches the Intel TDX quote for a given model
 */
export async function fetchIntelQuote(
  modelId: string
): Promise<{ intel_quote: string }> {
  const modelMap = await getModelMap();
  const host = modelMap[modelId];

  if (!host) {
    throw new TinfoilError(`Unknown Tinfoil model: ${modelId}`, 404);
  }

  const url = `https://${host}/.well-known/tinfoil-attestation`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new TinfoilError(
      `Failed to fetch attestation from ${host}: ${response.status} ${response.statusText}`,
      502
    );
  }

  const data = (await response.json()) as {
    format?: string;
    body?: string;
  };

  if (!data.format || !data.format.startsWith(EXPECTED_FORMAT_PREFIX)) {
    throw new TinfoilError(
      `Unsupported Tinfoil attestation format: ${data.format || 'missing'}`,
      502
    );
  }

  if (!data.body) {
    throw new TinfoilError('Tinfoil response missing body', 502);
  }

  const compressedData = base64ToUint8Array(data.body);
  const decompressedData = await gunzip(compressedData);
  const intelQuote = toHex(decompressedData);

  return { intel_quote: intelQuote };
}
