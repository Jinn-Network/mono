/**
 * Job Claim Verification for Credential Bridge
 *
 * Verifies that credential requests come from the same service EOA that
 * currently owns the on-chain request claim.
 *
 * Control API is the source of truth for claim ownership/state.
 */

import {
  createPrivateKeyHttpSigner,
  resolveChainId,
  signRequestWithErc8128,
  type Erc8128Signer,
} from '../../../jinn-node/dist/http/erc8128.js';

const CONTROL_API_URL = process.env.CONTROL_API_URL || 'http://localhost:4001/graphql';
const CONTROL_API_TIMEOUT_MS = Number.parseInt(process.env.CONTROL_API_TIMEOUT_MS || '5000', 10);

export interface JobVerifyResult {
  state: 'valid' | 'invalid' | 'unavailable';
  error?: string;
  detail?: string;
}

interface RequestClaim {
  request_id: string;
  worker_address: string;
  status: string;
  claimed_at: string;
  completed_at?: string;
}

interface GraphQLResponse {
  data?: {
    getRequestClaim?: RequestClaim | null;
  };
  errors?: Array<{ message: string }>;
}

let cachedSigner: Erc8128Signer | null = null;

function getControlApiPrivateKey(): `0x${string}` | null {
  const bridgeKey = process.env.CREDENTIAL_BRIDGE_CONTROL_API_PRIVATE_KEY?.trim();
  if (bridgeKey && /^0x[a-fA-F0-9]{64}$/.test(bridgeKey)) return bridgeKey as `0x${string}`;

  const genericKey = process.env.PRIVATE_KEY?.trim();
  if (genericKey && /^0x[a-fA-F0-9]{64}$/.test(genericKey)) {
    console.warn('[job-verify] Using PRIVATE_KEY fallback — set CREDENTIAL_BRIDGE_CONTROL_API_PRIVATE_KEY for production');
    return genericKey as `0x${string}`;
  }
  return null;
}

function getControlApiSigner(): Erc8128Signer | null {
  if (cachedSigner) return cachedSigner;

  const privateKey = getControlApiPrivateKey();
  if (!privateKey) return null;

  const chainId = resolveChainId(
    process.env.CHAIN_ID ||
    process.env.CHAIN_CONFIG ||
    process.env.X402_NETWORK ||
    'base',
  );

  cachedSigner = createPrivateKeyHttpSigner(privateKey, chainId);
  return cachedSigner;
}

/**
 * Verify that the requester holds an active claim for the given requestId.
 *
 * @param requestId - The on-chain request ID (JINN_CTX_REQUEST_ID)
 * @param requesterAddress - The credential request signer EOA (from ERC-8128 auth)
 * @returns Explicit result state: valid, invalid, or unavailable
 */
export async function verifyJobClaim(
  requestId: string,
  requesterAddress: string
): Promise<JobVerifyResult> {
  const signer = getControlApiSigner();
  if (!signer) {
    return {
      state: 'unavailable',
      error: 'Bridge signer private key is not configured',
      detail: 'Set CREDENTIAL_BRIDGE_CONTROL_API_PRIVATE_KEY or PRIVATE_KEY',
    };
  }

  const query = `query GetClaim($requestId: String!) {
    getRequestClaim(requestId: $requestId) {
      request_id
      worker_address
      status
      claimed_at
    }
  }`;

  try {
    const request = await signRequestWithErc8128({
      signer,
      input: CONTROL_API_URL,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': `verify-claim:${requestId}`,
        },
        body: JSON.stringify({ query, variables: { requestId } }),
        signal: AbortSignal.timeout(CONTROL_API_TIMEOUT_MS),
      },
      signOptions: {
        label: 'eth',
        binding: 'request-bound',
        replay: 'non-replayable',
        ttlSeconds: 60,
      },
    });

    const response = await fetch(request);

    if (!response.ok) {
      return {
        state: 'unavailable',
        error: `Control API returned HTTP ${response.status}`,
      };
    }

    const data = await response.json() as GraphQLResponse;

    if (data.errors?.length) {
      return {
        state: 'unavailable',
        error: 'Control API GraphQL error',
        detail: data.errors[0].message,
      };
    }

    const claim = data?.data?.getRequestClaim;

    if (!claim) {
      return { state: 'invalid', error: `Request ${requestId} not claimed` };
    }

    // Verify claim is held by this requester EOA
    if (claim.worker_address?.toLowerCase() !== requesterAddress.toLowerCase()) {
      return { state: 'invalid', error: 'Request claimed by different address' };
    }

    // Verify still in progress
    if (claim.status === 'COMPLETED' || claim.status === 'FAILED') {
      return { state: 'invalid', error: `Request ${requestId} already ${claim.status.toLowerCase()}` };
    }

    return { state: 'valid' };
  } catch (err) {
    return {
      state: 'unavailable',
      error: 'Control API verification failed',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
