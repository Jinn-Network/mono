/**
 * ERC-8128 HTTP Message Signatures for Control API authentication.
 *
 * Workers sign every Control API request with their on-chain private key.
 * The Control API verifies signatures and extracts the worker address
 * from the cryptographic keyid — replacing the bare X-Worker-Address header.
 *
 * Uses @slicekit/erc8128 (RFC 9421 + Ethereum signatures).
 */

import {
  signRequest,
  verifyRequest as erc8128VerifyRequest,
  type EthHttpSigner,
  type NonceStore,
  type VerifyMessageFn,
  type VerifyResult,
  type VerifyPolicy,
  type SetHeadersFn,
  type SignOptions,
} from '@slicekit/erc8128';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { verifyMessage, type Account } from 'viem';
import { getServicePrivateKey } from '../env/operate-profile.js';

export type Erc8128Signer = EthHttpSigner;
type Hex = `0x${string}`;

// ============================================================================
// Client-side: Signer construction + request signing
// ============================================================================

let _signer: EthHttpSigner | null = null;

/**
 * Lazy singleton signer from the worker's private key.
 * The address and chainId are embedded in the ERC-8128 keyid.
 */
export function getControlApiSigner(): EthHttpSigner {
  if (_signer) return _signer;

  const key = getServicePrivateKey() as `0x${string}`;
  if (!key) throw new Error('Service private key not found in .operate config or environment');
  const account = privateKeyToAccount(key);

  _signer = {
    address: account.address as `0x${string}`,
    chainId: 8453, // Base
    signMessage: (msg: Uint8Array) =>
      account.signMessage({ message: { raw: msg } }),
  };

  return _signer;
}

/**
 * Sign a Control API request and return headers with ERC-8128 signature fields.
 *
 * Builds a Web API Request, signs it, then extracts the signature headers
 * so they can be merged into the existing postJson header flow.
 *
 * @param url - The Control API URL
 * @param body - The request body (will be JSON.stringified)
 * @param headers - Existing headers to preserve
 * @returns Headers with signature-input, signature, and content-digest added
 */
export async function signControlApiHeaders(
  url: string,
  body: any,
  headers: Record<string, string>,
): Promise<Record<string, string>> {
  const signer = getControlApiSigner();
  const jsonBody = JSON.stringify(body);

  const req = new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: jsonBody,
  });

  const signed = await signRequest(req, signer, {
    binding: 'request-bound',
    replay: 'non-replayable',
    ttlSeconds: 60,
  });

  // Extract signature headers from the signed request
  const result: Record<string, string> = { ...headers };
  for (const key of ['signature-input', 'signature', 'content-digest']) {
    const val = signed.headers.get(key);
    if (val) result[key] = val;
  }

  return result;
}

// ============================================================================
// Server-side: Nonce store + verification helpers
// ============================================================================

/**
 * In-memory nonce store with TTL-based expiration.
 * Tracks seen nonces and garbage-collects expired entries on access.
 */
export class InMemoryNonceStore implements NonceStore {
  private seen = new Map<string, number>();

  async consume(key: string, ttlSeconds: number): Promise<boolean> {
    this.gc();
    if (this.seen.has(key)) return false;
    this.seen.set(key, Date.now() + ttlSeconds * 1000);
    return true;
  }

  private gc(): void {
    const now = Date.now();
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= now) {
        this.seen.delete(key);
      }
    }
  }
}

/**
 * Verify an ERC-191 personal_sign message using viem.
 * Matches the VerifyMessageFn shape expected by @slicekit/erc8128.
 */
export const ethVerifyMessage: VerifyMessageFn = async (args) => {
  try {
    const valid = await verifyMessage({
      address: args.address as `0x${string}`,
      message: { raw: args.message.raw as `0x${string}` },
      signature: args.signature as `0x${string}`,
    });
    return valid;
  } catch {
    return false;
  }
};

/**
 * Verify an incoming HTTP request's ERC-8128 signature.
 * Thin wrapper that bundles our verifyMessage and nonceStore.
 */
export async function verifyControlApiRequest(
  request: Request,
  nonceStore: NonceStore,
  policy?: VerifyPolicy,
  setHeaders?: SetHeadersFn,
): Promise<VerifyResult> {
  return erc8128VerifyRequest(request, ethVerifyMessage, nonceStore, {
    maxValiditySec: 120,
    clockSkewSec: 10,
    ...policy,
  }, setHeaders);
}

// ============================================================================
// OAuth credential-store compat: signing & verification primitives
// ============================================================================

const CHAIN_CONFIG_TO_CHAIN_ID: Record<string, number> = {
  base: 8453,
  'base-mainnet': 8453,
  base_mainnet: 8453,
  'base-sepolia': 84532,
  base_sepolia: 84532,
  gnosis: 100,
  ethereum: 1,
  mainnet: 1,
  sepolia: 11155111,
  optimism: 10,
  mode: 34443,
};

export function resolveChainId(chainConfig?: string | null, fallback = 8453): number {
  if (!chainConfig) return fallback;
  const normalized = chainConfig.toLowerCase().trim();
  if (/^\d+$/.test(normalized)) {
    return Number.parseInt(normalized, 10);
  }
  return CHAIN_CONFIG_TO_CHAIN_ID[normalized] ?? fallback;
}

export function createPrivateKeyHttpSigner(privateKey: Hex, chainId: number): EthHttpSigner {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address as `0x${string}`,
    chainId,
    signMessage: (msg: Uint8Array) =>
      account.signMessage({ message: { raw: msg } }),
  };
}

export async function signRequestWithErc8128(args: {
  signer: EthHttpSigner;
  input: RequestInfo;
  init?: RequestInit;
  signOptions?: SignOptions;
}): Promise<Request> {
  const request = new Request(args.input, args.init);
  return signRequest(request, args.signer, {
    binding: 'request-bound',
    replay: 'non-replayable',
    ttlSeconds: 60,
    ...(args.signOptions ?? {}),
  });
}

export async function verifyRequestWithErc8128(args: {
  request: Request;
  nonceStore: NonceStore;
  policy?: Partial<VerifyPolicy>;
}): Promise<VerifyResult> {
  return erc8128VerifyRequest(args.request, ethVerifyMessage, args.nonceStore, {
    maxValiditySec: 300,
    clockSkewSec: 5,
    ...args.policy,
  });
}

export function buildErc8128IdempotencyKey(parts: Array<string | number | undefined | null>): string {
  return parts
    .filter((part): part is string | number => part !== undefined && part !== null && `${part}`.length > 0)
    .map((part) => String(part))
    .join(':');
}

export type {
  EthHttpSigner,
  NonceStore,
  VerifyMessageFn,
  VerifyResult,
  VerifyPolicy,
  SignOptions,
};
