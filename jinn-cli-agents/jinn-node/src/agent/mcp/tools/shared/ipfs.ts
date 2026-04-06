import fetch from 'cross-fetch';

const DEFAULT_IPFS_GATEWAY = 'https://gateway.autonolas.tech/ipfs/';
const FALLBACK_IPFS_GATEWAY = 'https://ipfs.io/ipfs/';

// Retry configuration
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY_MS = 1000; // 1 second
const MAX_RETRY_DELAY_MS = 10000; // 10 seconds

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate exponential backoff delay with jitter
 */
function calculateBackoffDelay(attemptNumber: number): number {
  const exponentialDelay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attemptNumber);
  const cappedDelay = Math.min(exponentialDelay, MAX_RETRY_DELAY_MS);
  const jitter = cappedDelay * 0.25 * (Math.random() - 0.5);
  return Math.floor(cappedDelay + jitter);
}

/**
 * Retry a function with exponential backoff
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  shouldRetry: (result: T) => boolean,
  context: string
): Promise<T> {
  let lastResult: T;
  
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    lastResult = await fn();
    
    if (!shouldRetry(lastResult)) {
      return lastResult;
    }

    if (attempt === MAX_RETRIES) {
      return lastResult;
    }

    const delay = calculateBackoffDelay(attempt);
    await sleep(delay);
  }
  
  return lastResult!;
}

function buildCidV1HexCandidates(hexBytes: string): string[] {
  const hexClean = hexBytes.startsWith('0x') ? hexBytes.slice(2) : hexBytes;
  return [
    `f01701220${hexClean}`,
    `f01551220${hexClean}`,
  ];
}

function isFullCidString(value: string): boolean {
  // Accept base32/base58 CIDs and hex-base16 CIDs (f01...)
  // CIDv1 base32 CIDs start with 'b' followed by codec identifier (e.g., bafy, bafkre, bafk, bafz)
  return /^baf|^Qm|^f01/i.test(value);
}

function extractDigestHexFromHexCid(hexCid: string): string | null {
  const s = hexCid.toLowerCase();
  if (s.startsWith('f01701220')) return s.slice(10);
  if (s.startsWith('f01551220')) return s.slice(10);
  return null;
}

function toDecimalRequestIdStrict(id: string): string {
  const s = String(id).trim();
  return s.startsWith('0x') ? BigInt(s).toString(10) : s;
}

function hexCidToBase32DagPb(hexCid: string): string | null {
  try {
    const digestHex = hexCid.toLowerCase().replace(/^f01551220/i, '');
    if (digestHex === hexCid.toLowerCase()) {
      return null;
    }

    const digestBytes: number[] = [];
    for (let i = 0; i < digestHex.length; i += 2) {
      digestBytes.push(parseInt(digestHex.slice(i, i + 2), 16));
    }

    const cidBytes = [0x01, 0x70, 0x12, 0x20, ...digestBytes];
    const base32Alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
    let bitBuffer = 0;
    let bitCount = 0;
    let out = '';

    for (const b of cidBytes) {
      bitBuffer = (bitBuffer << 8) | (b & 0xff);
      bitCount += 8;
      while (bitCount >= 5) {
        const idx = (bitBuffer >> (bitCount - 5)) & 0x1f;
        bitCount -= 5;
        out += base32Alphabet[idx];
      }
    }
    if (bitCount > 0) {
      const idx = (bitBuffer << (5 - bitCount)) & 0x1f;
      out += base32Alphabet[idx];
    }

    return `b${out}`;
  } catch (error) {
    return null;
  }
}

function buildCidCandidates(ipfsHash: string, options?: { requestId?: string }): { cidPath: string; context: string }[] {
  const isFullCid = isFullCidString(ipfsHash);
  const hasRequestId = Boolean(options?.requestId);
  let candidates: string[] = [];

  if (hasRequestId && isFullCid && /^f01551220/i.test(ipfsHash)) {
    const dagPb = hexCidToBase32DagPb(ipfsHash);
    if (dagPb) {
      candidates = [dagPb];
    } else {
      const digest = extractDigestHexFromHexCid(ipfsHash);
      candidates = digest ? [`f01701220${digest}`, `f01551220${digest}`] : [ipfsHash];
    }
  } else if (isFullCid && /^f01/i.test(ipfsHash)) {
    if (ipfsHash.toLowerCase().startsWith('f01551220')) {
      const digest = extractDigestHexFromHexCid(ipfsHash);
      const dagPb = digest ? `f01701220${digest}` : null;
      candidates = dagPb ? [ipfsHash, dagPb] : [ipfsHash];
    } else {
      const digest = extractDigestHexFromHexCid(ipfsHash);
      const raw = digest ? `f01551220${digest}` : null;
      candidates = raw ? [ipfsHash, raw] : [ipfsHash];
    }
  } else if (isFullCid) {
    candidates = [ipfsHash];
  } else {
    candidates = buildCidV1HexCandidates(ipfsHash);
  }

  const paths = candidates.map((cid) => {
    if (!hasRequestId) {
      return { cidPath: cid, context: cid };
    }
    const requestSegment = toDecimalRequestIdStrict(options!.requestId!);
    return { cidPath: `${cid}/${requestSegment}`, context: `${cid}/${requestSegment}` };
  });

  return paths;
}

async function fetchFromGateways(
  cidPath: string,
  timeout: number,
  contextLabel: string
): Promise<{ result: any; success: boolean }> {
  const gatewayUrl = process.env.IPFS_GATEWAY_URL || DEFAULT_IPFS_GATEWAY;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const attempt = async (baseUrl: string) => {
    try {
      const response = await fetch(`${baseUrl}${cidPath}`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        return null;
      }
      const contentType = response.headers.get('content-type') || '';
      let payload: any;
      if (contentType.includes('application/json')) {
        const parsed = await response.json();
        payload = JSON.parse(JSON.stringify(parsed));
      } else {
        const text = await response.text();
        payload = { contentType, text };
      }
      clearTimeout(timer);
      return { result: payload, success: true };
    } catch (error: any) {
      return { result: { error: `Failed to fetch IPFS content: ${error.message}`, status: 500 }, success: false };
    }
  };

  let attemptResult = await attempt(gatewayUrl);
  if (attemptResult && attemptResult.success) {
    return attemptResult;
  }

  attemptResult = await attempt(FALLBACK_IPFS_GATEWAY);
  if (attemptResult && attemptResult.success) {
    return attemptResult;
  }

  clearTimeout(timer);
  return {
    result:
      attemptResult?.result || { error: `IPFS content not found for ${contextLabel}`, status: 404 },
    success: false,
  };
}

async function resolveIpfsContentInternal(ipfsHash: string, requestId: string, timeout: number = 10000): Promise<any> {
  const candidates = buildCidCandidates(ipfsHash, { requestId });
  for (const candidate of candidates) {
    const { result, success } = await fetchFromGateways(candidate.cidPath, timeout, candidate.context);
    if (success) {
      return result;
    }
  }
  return { error: 'IPFS content not found.', status: 404 };
}

export async function resolveIpfsContent(ipfsHash: string, requestId: string, timeout: number = 10000): Promise<any> {
  return retryWithBackoff(
    () => resolveIpfsContentInternal(ipfsHash, requestId, timeout),
    (result) => result.error !== undefined,
    `resolveIpfsContent(${ipfsHash.substring(0, 16)}..., ${requestId.substring(0, 16)}...)`
  );
}

async function resolveRequestIpfsContentInternal(ipfsHash: string, timeout: number = 10000): Promise<any> {
  const candidates = buildCidCandidates(ipfsHash);
  for (const candidate of candidates) {
    const { result, success } = await fetchFromGateways(candidate.cidPath, timeout, candidate.context);
    if (success) {
      return result;
    }
  }
  return { error: 'IPFS content not found.', status: 404 };
}

export async function resolveRequestIpfsContent(ipfsHash: string, timeout: number = 10000): Promise<any> {
  return retryWithBackoff(
    () => resolveRequestIpfsContentInternal(ipfsHash, timeout),
    (result) => result.error !== undefined,
    `resolveRequestIpfsContent(${ipfsHash.substring(0, 16)}...)`
  );
}

export const __TEST__ = {
  buildCidCandidates,
  toDecimalRequestIdStrict,
};
