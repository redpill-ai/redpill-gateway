import { Context } from 'hono';

// Cache with size limit and automatic eviction
// LRU-style: when capacity is exceeded, oldest entries are removed first
const inMemoryCache: Map<
  string,
  { responseBody: string; maxAge: number | null; timestamp: number }
> = new Map();
const MAX_CACHE_SIZE = 1000; // Maximum number of cache entries
const EVICTION_BATCH_SIZE = 100; // Remove this many oldest entries when capacity is exceeded

const CACHE_STATUS = {
  HIT: 'HIT',
  SEMANTIC_HIT: 'SEMANTIC HIT',
  MISS: 'MISS',
  SEMANTIC_MISS: 'SEMANTIC MISS',
  REFRESH: 'REFRESH',
  DISABLED: 'DISABLED',
};

const getCacheKey = async (requestBody: any, url: string) => {
  const stringToHash = `${JSON.stringify(requestBody)}-${url}`;
  const myText = new TextEncoder().encode(stringToHash);
  let cacheDigest = await crypto.subtle.digest(
    {
      name: 'SHA-256',
    },
    myText
  );
  return Array.from(new Uint8Array(cacheDigest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};

// Cache Handling
export const getFromCache = async (
  env: any,
  requestHeaders: any,
  requestBody: any,
  url: string,
  organisationId: string,
  cacheMode: string,
  cacheMaxAge: number | null
) => {
  if ('x-redpill-cache-force-refresh' in requestHeaders) {
    return [null, CACHE_STATUS.REFRESH, null];
  }
  try {
    const cacheKey = await getCacheKey(requestBody, url);

    if (inMemoryCache.has(cacheKey)) {
      const cacheObject = inMemoryCache.get(cacheKey)!;
      if (cacheObject.maxAge && cacheObject.maxAge < Date.now()) {
        inMemoryCache.delete(cacheKey);
        return [null, CACHE_STATUS.MISS, null];
      }
      return [cacheObject.responseBody, CACHE_STATUS.HIT, cacheKey];
    } else {
      return [null, CACHE_STATUS.MISS, null];
    }
  } catch (error) {
    console.error('getFromCache error: ', error);
    return [null, CACHE_STATUS.MISS, null];
  }
};

export const putInCache = async (
  env: any,
  requestHeaders: any,
  requestBody: any,
  responseBody: any,
  url: string,
  organisationId: string,
  cacheMode: string | null,
  cacheMaxAge: number | null
) => {
  if (requestBody.stream) {
    // Does not support caching of streams
    return;
  }

  const cacheKey = await getCacheKey(requestBody, url);

  // Check if we need to evict old entries
  if (inMemoryCache.size >= MAX_CACHE_SIZE) {
    // Remove oldest entries (FIFO-style eviction using Map iteration order)
    let evicted = 0;
    for (const key of inMemoryCache.keys()) {
      if (evicted >= EVICTION_BATCH_SIZE) break;
      inMemoryCache.delete(key);
      evicted++;
    }
  }

  inMemoryCache.set(cacheKey, {
    responseBody: JSON.stringify(responseBody),
    maxAge: cacheMaxAge,
    timestamp: Date.now(),
  });
};

export const memoryCache = () => {
  return async (c: Context, next: any) => {
    c.set('getFromCache', getFromCache);

    await next();

    let requestOptions = c.get('requestOptions');

    if (
      requestOptions &&
      Array.isArray(requestOptions) &&
      requestOptions.length > 0 &&
      requestOptions[0].requestParams.stream === (false || undefined)
    ) {
      requestOptions = requestOptions[0];
      if (requestOptions.cacheMode === 'simple') {
        await putInCache(
          null,
          null,
          requestOptions.transformedRequest.body,
          await requestOptions.response.clone().json(),
          requestOptions.providerOptions.rubeusURL,
          '',
          null,
          new Date().getTime() +
            (requestOptions.cacheMaxAge || 24 * 60 * 60 * 1000)
        );
      }
    }
  };
};
