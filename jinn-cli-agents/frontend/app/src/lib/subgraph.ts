/**
 * Subgraph shim — re-exports from @jinn/shared-ui plus fetchIpfsContent
 * which is not in the shared package.
 */

// Re-export everything from shared-ui's subgraph module
export {
  queryJobDefinitions,
  queryRequests,
  queryDeliveries,
  queryArtifacts,
  queryMessages,
  getJobDefinition,
  getRequest,
  getDelivery,
  getArtifact,
  getMessage,
  getWorkstreams,
  getWorkstream,
  getWorkstreamRequests,
  getRequestsAndDeliveries,
  getJobName,
  JOB_DEFINITIONS_QUERY,
  JOB_DEFINITION_QUERY,
} from '@jinn/shared-ui';

export type {
  Request,
  Delivery,
  Artifact,
  Message,
  Workstream,
  DependencyInfo,
  PageInfo,
  PaginatedResponse,
  JobDefinitionsResponse,
  RequestsResponse,
  DeliveriesResponse,
  ArtifactsResponse,
  MessagesResponse,
  WorkstreamsResponse,
  QueryOptions,
} from '@jinn/shared-ui';

// Extend JobDefinition with fields present in Ponder but not yet in shared-ui
import type { JobDefinition as BaseJobDefinition } from '@jinn/shared-ui';
export interface JobDefinition extends BaseJobDefinition {
  latestStatusUpdate?: string;
  latestStatusUpdateAt?: string;
}

// --- fetchIpfsContent (not in shared-ui) ---

function buildCidV1HexCandidates(hexBytes: string): string[] {
  const hexClean = hexBytes.startsWith('0x') ? hexBytes.slice(2) : hexBytes;
  return [
    `f01701220${hexClean}`,
    `f01551220${hexClean}`,
  ];
}

function isFullCidString(value: string): boolean {
  return /^baf|^Qm|^f01/i.test(value);
}

function extractDigestHexFromHexCid(hexCid: string): string | null {
  const s = hexCid.toLowerCase();
  if (s.startsWith('f01701220')) return s.slice(10);
  if (s.startsWith('f01551220')) return s.slice(10);
  return null;
}

function hexCidToBase32DagPb(hexCid: string): string | null {
  try {
    const digestHex = hexCid.toLowerCase().replace(/^f01551220/i, '');
    if (digestHex === hexCid.toLowerCase()) return null;

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

    return 'b' + out;
  } catch (error) {
    console.error('[IPFS] Error converting hex CID to base32:', error);
    return null;
  }
}

export async function fetchIpfsContent(
  ipfsHash: string,
  requestId?: string,
  timeout: number = 10000
): Promise<{ content: string; contentType: string } | null> {
  const gatewayUrl = 'https://gateway.autonolas.tech/ipfs/';
  const fallbackGatewayUrl = 'https://ipfs.io/ipfs/';

  const isFullCid = isFullCidString(ipfsHash);
  let candidates: string[];

  if (requestId && isFullCid && /^f01551220/i.test(ipfsHash)) {
    const base32Cid = hexCidToBase32DagPb(ipfsHash);
    if (base32Cid) {
      candidates = [base32Cid];
    } else {
      const digest = extractDigestHexFromHexCid(ipfsHash);
      if (digest) {
        candidates = [`f01701220${digest}`, `f01551220${digest}`];
      } else {
        candidates = [ipfsHash];
      }
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

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    for (const cid of candidates) {
      const path = requestId ? `${cid}/${requestId}` : cid;
      const url = `${gatewayUrl}${path}`;

      let response: Response | undefined;
      try {
        response = await fetch(url, {
          signal: controller.signal,
          mode: 'cors',
          cache: 'no-cache'
        });
      } catch {
        const fbUrl = `${fallbackGatewayUrl}${path}`;
        try {
          response = await fetch(fbUrl, {
            signal: controller.signal,
            mode: 'cors',
            cache: 'no-cache'
          });
        } catch {
          continue;
        }
      }

      if (!response || !response.ok) {
        continue;
      }

      clearTimeout(timer);
      const contentType = response.headers.get('content-type') || 'text/plain';
      const text = await response.text();

      try {
        const json = JSON.parse(text);
        return {
          content: JSON.stringify(json, null, 2),
          contentType: 'application/json'
        };
      } catch {
        return { content: text, contentType };
      }
    }

    clearTimeout(timer);
    return {
      content: '[Content not found at IPFS gateways]',
      contentType: 'text/plain'
    };
  } catch (error) {
    console.error('[IPFS] Error fetching IPFS content:', error);
    return {
      content: `[Error fetching content: ${error instanceof Error ? error.message : String(error)}]`,
      contentType: 'text/plain'
    };
  }
}
