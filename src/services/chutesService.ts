import { webcrypto } from 'crypto';

const CHUTES_API_BASE = 'https://api.chutes.ai';
const CHUTE_ID_CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes

export class ChutesError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500
  ) {
    super(message);
    this.name = 'ChutesError';
  }
}

interface ChuteIdCache {
  chuteId: string;
  timestamp: number;
}

// Cache for model name -> chute_id mapping
const chuteIdCache = new Map<string, ChuteIdCache>();

interface ChutesListResponse {
  total: number;
  page: number;
  limit: number;
  items: Array<{
    chute_id: string;
    name: string;
    [key: string]: any;
  }>;
}

interface ChutesInstance {
  instance_id: string;
  e2e_pubkey: string;
}

interface ChutesInstanceEvidence {
  instance_id: string;
  quote: string;
  gpu_evidence: any[];
}

interface ChutesEvidenceResponse {
  evidence: ChutesInstanceEvidence[];
}

interface ChutesE2EResponse {
  instances: ChutesInstance[];
}

export interface ChutesAttestation {
  instance_id: string;
  nonce: string;
  e2e_pubkey: string;
  intel_quote: string;
  gpu_evidence: any[];
}

export interface ChutesAttestationResult {
  nonce: string;
  all_attestations: ChutesAttestation[];
}

/**
 * Fetches chute_id by model name from Chutes API
 * Results are cached for 60 minutes
 */
export async function getChuteIdByName(
  modelName: string,
  apiKey: string,
  baseUrl?: string
): Promise<string> {
  const cacheKey = modelName;
  const now = Date.now();

  // Check cache
  const cached = chuteIdCache.get(cacheKey);
  if (cached && now - cached.timestamp < CHUTE_ID_CACHE_TTL_MS) {
    return cached.chuteId;
  }

  const apiBase = baseUrl || CHUTES_API_BASE;
  const url = `${apiBase}/chutes/?include_public=true&name=${encodeURIComponent(modelName)}`;

  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new ChutesError(
      `Failed to lookup chute by name: ${response.status} ${response.statusText}`,
      response.status >= 500 ? 502 : response.status
    );
  }

  const data = (await response.json()) as ChutesListResponse;

  if (!data.items || data.items.length === 0) {
    throw new ChutesError(`Chute not found for model: ${modelName}`, 404);
  }

  const chuteId = data.items[0].chute_id;

  // Update cache
  chuteIdCache.set(cacheKey, { chuteId, timestamp: now });

  return chuteId;
}

/**
 * Generates a cryptographically secure random nonce (32 bytes as hex string)
 */
function generateNonce(): string {
  const bytes = new Uint8Array(32);
  webcrypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Fetches E2E public keys for all instances of a chute
 */
async function fetchE2EPublicKeys(
  chuteId: string,
  apiKey: string,
  baseUrl?: string
): Promise<Map<string, string>> {
  const apiBase = baseUrl || CHUTES_API_BASE;
  const url = `${apiBase}/e2e/instances/${encodeURIComponent(chuteId)}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new ChutesError(
      `Failed to fetch E2E public keys: ${response.status} ${response.statusText}`,
      response.status >= 500 ? 502 : response.status
    );
  }

  const data = (await response.json()) as ChutesE2EResponse;
  const pubkeys = new Map<string, string>();

  for (const inst of data.instances || []) {
    pubkeys.set(inst.instance_id, inst.e2e_pubkey);
  }

  return pubkeys;
}

/**
 * Fetches hardware evidence from Chutes API
 */
async function fetchEvidence(
  chuteId: string,
  nonce: string,
  apiKey: string,
  baseUrl?: string
): Promise<ChutesInstanceEvidence[]> {
  const apiBase = baseUrl || CHUTES_API_BASE;
  const url = `${apiBase}/chutes/${encodeURIComponent(chuteId)}/evidence?nonce=${encodeURIComponent(nonce)}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    throw new ChutesError(
      `Failed to fetch evidence: ${response.status} ${response.statusText}`,
      response.status >= 500 ? 502 : response.status
    );
  }

  const data = (await response.json()) as ChutesEvidenceResponse;
  return data.evidence || [];
}

/**
 * Fetches Chutes TEE attestation data for a given model/chute
 * Returns evidence data that can be verified client-side using:
 * - Intel TDX Quote verification (dcap_qvl)
 * - NVIDIA GPU attestation verification (nv_attestation_sdk)
 */
export async function fetchChutesAttestation(
  chuteId: string,
  apiKey: string,
  baseUrl?: string
): Promise<ChutesAttestationResult> {
  // Step 1: Generate a random nonce for replay protection
  const nonce = generateNonce();

  // Step 2: Fetch E2E public keys for all instances
  const pubkeys = await fetchE2EPublicKeys(chuteId, apiKey, baseUrl);

  if (pubkeys.size === 0) {
    throw new ChutesError('No E2E-enabled instances found for this chute', 404);
  }

  // Step 3: Fetch hardware evidence from all instances
  const evidenceList = await fetchEvidence(chuteId, nonce, apiKey, baseUrl);

  if (evidenceList.length === 0) {
    throw new ChutesError('No evidence available from instances', 404);
  }

  // Step 4: Combine evidence with public keys
  const attestations: ChutesAttestation[] = [];

  for (const evidence of evidenceList) {
    const e2ePubkey = pubkeys.get(evidence.instance_id);
    if (!e2ePubkey) {
      // Skip instances without E2E public key
      continue;
    }

    attestations.push({
      instance_id: evidence.instance_id,
      nonce,
      e2e_pubkey: e2ePubkey,
      intel_quote: evidence.quote,
      gpu_evidence: evidence.gpu_evidence,
    });
  }

  return {
    nonce,
    all_attestations: attestations,
  };
}
